/**
 * KB host capabilities and immutable source admissions — Plan §5.2.
 *
 * Capability authority is deliberately outside every KB publication tree. Complete
 * envelopes, leases, and source-admission metadata live in the owner-only
 * `$PROJECT_ROOT/.penny/kb-capabilities/capabilities.sqlite` store. Source bytes are
 * copied once into a preindexed same-run snapshot; later readers never reopen the
 * external source path.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SQLOutputValue } from "node:sqlite";

import {
  Rfc3339UtcSchema,
  canonicalJson,
  sha256Hex,
  validateHostCapabilityEnvelope,
  validateHostCapabilityLease,
  validateKbContract,
  validateSourceAdmissionRecord,
  type HostCapabilityEnvelopeV1,
  type HostCapabilityKindV1,
  type HostCapabilityLeaseV1,
  type HostCapabilityOperationV1,
  type HostCapabilityStateV1,
  type Sha256Hex,
  type SourceAdmissionRecordV1,
  type SourceAdmissionStateV1,
  type SourceCapabilityMetadataV1,
} from "./contracts.js";
import { OwnerSqliteDatabase } from "./owner-sqlite.js";

// Compatibility vocabulary is type-only and derives from the normative
// TypeBox schemas in kb/contracts.ts. This module defines no parallel shapes.
export type CapabilityKind = HostCapabilityKindV1;
export type CapabilityOperation = HostCapabilityOperationV1;
export type SourceCapabilityMetadata = SourceCapabilityMetadataV1;
export type CapabilityEnvelope = HostCapabilityEnvelopeV1;
export type CapabilityState = HostCapabilityStateV1;
export type CapabilityLease = HostCapabilityLeaseV1;
export type AdmissionState = SourceAdmissionStateV1;
export type SourceAdmissionRecord = SourceAdmissionRecordV1;

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

const CAPABILITY_DB_NAME = "capabilities.sqlite";
const OPAQUE_ID = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function capabilityStoreDirectory(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".penny", "kb-capabilities");
}

export function validateEnvelopeCrossField(value: unknown): CapabilityEnvelope {
  try {
    return validateHostCapabilityEnvelope(value);
  } catch (error) {
    const capabilityId =
      value !== null &&
      typeof value === "object" &&
      typeof (value as { capability_id?: unknown }).capability_id === "string"
        ? (value as { capability_id: string }).capability_id
        : "unknown";
    const detail =
      error !== null &&
      typeof error === "object" &&
      Array.isArray((error as { issues?: unknown }).issues)
        ? (error as { issues: string[] }).issues.join("; ")
        : "closed schema validation failed";
    throw new CapabilityError(
      `capability '${capabilityId}' has an invalid envelope or finite timestamps: ${detail}`
    );
  }
}

function finiteEnvelopeTimes(value: unknown): { issuedAt: number; expiresAt: number } {
  const envelope = validateEnvelopeCrossField(value);
  return { issuedAt: Date.parse(envelope.issued_at), expiresAt: Date.parse(envelope.expires_at) };
}

export interface CapabilityBinding {
  readonly runId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly kind: CapabilityKind;
  readonly operation: CapabilityOperation;
  readonly transactionId?: string;
  readonly now?: string;
}

function validateBinding(input: CapabilityBinding): number {
  if (
    !OPAQUE_ID.test(input.runId) ||
    !OPAQUE_ID.test(input.sessionId) ||
    !OPAQUE_ID.test(input.profileId) ||
    (input.transactionId !== undefined && !OPAQUE_ID.test(input.transactionId))
  ) {
    throw new CapabilityError(
      "capability admission requires exact opaque run, transaction, session, and profile ids"
    );
  }
  const nowValue = input.now ?? new Date().toISOString();
  try {
    validateKbContract(Rfc3339UtcSchema, nowValue, "capability admission time");
  } catch {
    throw new CapabilityError("capability admission time is not an exact RFC3339 UTC timestamp");
  }
  return Date.parse(nowValue);
}

export function validateEnvelopeBinding(value: unknown, input: CapabilityBinding): void {
  const env = validateEnvelopeCrossField(value);
  const now = validateBinding(input);
  const { issuedAt, expiresAt } = finiteEnvelopeTimes(env);
  if (env.kind !== input.kind || env.allowed_operation !== input.operation) {
    throw new CapabilityError(
      `capability '${env.capability_id}' does not authorize ${input.kind}/${input.operation}`
    );
  }
  if (env.session_id !== input.sessionId) {
    throw new CapabilityError(`capability '${env.capability_id}' belongs to another session`);
  }
  if (env.kb_profile_id !== input.profileId) {
    throw new CapabilityError(`capability '${env.capability_id}' belongs to another profile`);
  }
  if (issuedAt > now)
    throw new CapabilityError(`capability '${env.capability_id}' is not active yet`);
  if (expiresAt <= now) throw new CapabilityError(`capability '${env.capability_id}' is expired`);
}

export function validateClaimedCapability(
  env: CapabilityEnvelope,
  lease: CapabilityLease | undefined,
  input: CapabilityBinding
): void {
  validateEnvelopeBinding(env, input);
  if (lease === undefined) throw new CapabilityError(`capability '${env.capability_id}' not found`);
  if (lease.envelope_sha256 !== envelopeDigest(env)) {
    throw new CapabilityError(
      `capability '${env.capability_id}' envelope digest does not match lease`
    );
  }
  if (
    lease.state !== "claimed" ||
    lease.run_id !== input.runId ||
    (input.transactionId !== undefined && lease.transaction_id !== input.transactionId)
  ) {
    throw new CapabilityError(
      `capability '${env.capability_id}' is not claimed by the exact run transaction`
    );
  }
}

export function mintEnvelope(input: {
  kind: CapabilityKind;
  session_id: string;
  kb_profile_id: string;
  resolved_path: string;
  expected_sha256: Sha256Hex;
  allowed_operation: CapabilityOperation;
  issued_at: string;
  expires_at: string;
  authority_root?: string;
  media_type?: string;
  source_metadata?: SourceCapabilityMetadata;
}): CapabilityEnvelope {
  const envelope: unknown = {
    schema_version: 1,
    capability_id: `cap_${randomUUID().replace(/-/g, "")}`,
    kind: input.kind,
    session_id: input.session_id,
    kb_profile_id: input.kb_profile_id,
    resolved_path: input.resolved_path,
    expected_sha256: input.expected_sha256,
    allowed_operation: input.allowed_operation,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    ...(input.authority_root !== undefined ? { authority_root: input.authority_root } : {}),
    ...(input.media_type !== undefined ? { media_type: input.media_type } : {}),
    ...(input.source_metadata !== undefined ? { source_metadata: input.source_metadata } : {}),
  };
  return validateEnvelopeCrossField(envelope);
}

export function envelopeDigest(value: unknown): Sha256Hex {
  return sha256Hex(canonicalJson(validateEnvelopeCrossField(value)));
}

type SqlRow = Record<string, SQLOutputValue>;

const ENVELOPE_ROW_KEYS = [
  "capability_id",
  "envelope_jcs",
  "envelope_sha256",
  "kind",
  "session_id",
  "kb_profile_id",
  "allowed_operation",
  "expires_at",
  "created_at",
] as const;
const LEASE_ROW_KEYS = [
  "capability_id",
  "envelope_sha256",
  "state",
  "run_id",
  "transaction_id",
  "claimed_at",
  "reserved_at",
  "terminal_at",
  "updated_at",
] as const;
const ADMISSION_ROW_KEYS = [
  "source_id",
  "capability_id",
  "envelope_sha256",
  "run_id",
  "transaction_id",
  "sha256",
  "media_type",
  "byte_length",
  "storage_key",
  "temporary_storage_key",
  "state",
  "created_at",
  "updated_at",
] as const;

function assertExactSqlKeys(row: SqlRow, expected: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const required = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(required)) {
    throw new CapabilityError(`${label} has unexpected or missing SQLite columns`);
  }
}

function requiredSqlText(row: SqlRow, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new CapabilityError(`${label} field '${key}' must be exact text`);
  }
  return value;
}

function optionalSqlText(row: SqlRow, key: string, label: string): string | undefined {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new CapabilityError(`${label} field '${key}' must be text or null`);
  }
  return value;
}

function requiredSqlInteger(row: SqlRow, key: string, label: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CapabilityError(`${label} field '${key}' must be a safe SQLite integer`);
  }
  return value;
}

function validateSqlTimestamp(value: string, label: string): void {
  try {
    validateKbContract(Rfc3339UtcSchema, value, label);
  } catch {
    throw new CapabilityError(`${label} is not an exact RFC3339 UTC timestamp`);
  }
}

function leaseFromRow(row: SqlRow): CapabilityLease {
  const label = "capability lease row";
  assertExactSqlKeys(row, LEASE_ROW_KEYS, label);
  const updatedAt = requiredSqlText(row, "updated_at", label);
  validateSqlTimestamp(updatedAt, `${label} updated_at`);
  const candidate: unknown = {
    schema_version: 1,
    capability_id: requiredSqlText(row, "capability_id", label),
    envelope_sha256: requiredSqlText(row, "envelope_sha256", label),
    state: requiredSqlText(row, "state", label),
    ...(optionalSqlText(row, "run_id", label) === undefined
      ? {}
      : { run_id: optionalSqlText(row, "run_id", label) }),
    ...(optionalSqlText(row, "transaction_id", label) === undefined
      ? {}
      : { transaction_id: optionalSqlText(row, "transaction_id", label) }),
    ...(optionalSqlText(row, "claimed_at", label) === undefined
      ? {}
      : { claimed_at: optionalSqlText(row, "claimed_at", label) }),
    ...(optionalSqlText(row, "reserved_at", label) === undefined
      ? {}
      : { reserved_at: optionalSqlText(row, "reserved_at", label) }),
    ...(optionalSqlText(row, "terminal_at", label) === undefined
      ? {}
      : { terminal_at: optionalSqlText(row, "terminal_at", label) }),
  };
  try {
    const lease = validateHostCapabilityLease(candidate);
    for (const [field, timestamp] of [
      ["claimed_at", lease.claimed_at],
      ["reserved_at", lease.reserved_at],
      ["terminal_at", lease.terminal_at],
    ] as const) {
      if (timestamp !== undefined && Date.parse(updatedAt) < Date.parse(timestamp)) {
        throw new CapabilityError(`${label} updated_at precedes ${field}`);
      }
    }
    return lease;
  } catch (error) {
    throw new CapabilityError(
      `${label} failed closed lifecycle validation: ${error instanceof Error ? error.message : "unknown"}`
    );
  }
}

function admissionFromRow(row: SqlRow): SourceAdmissionRecord {
  const label = "source admission row";
  assertExactSqlKeys(row, ADMISSION_ROW_KEYS, label);
  const temporaryStorageKey = optionalSqlText(row, "temporary_storage_key", label);
  const candidate: unknown = {
    schema_version: 1,
    source_id: requiredSqlText(row, "source_id", label),
    capability_id: requiredSqlText(row, "capability_id", label),
    envelope_sha256: requiredSqlText(row, "envelope_sha256", label),
    run_id: requiredSqlText(row, "run_id", label),
    transaction_id: requiredSqlText(row, "transaction_id", label),
    sha256: requiredSqlText(row, "sha256", label),
    media_type: requiredSqlText(row, "media_type", label),
    byte_length: requiredSqlInteger(row, "byte_length", label),
    storage_key: requiredSqlText(row, "storage_key", label),
    ...(temporaryStorageKey === undefined ? {} : { temporary_storage_key: temporaryStorageKey }),
    state: requiredSqlText(row, "state", label),
    created_at: requiredSqlText(row, "created_at", label),
    updated_at: requiredSqlText(row, "updated_at", label),
  };
  try {
    return validateSourceAdmissionRecord(candidate);
  } catch (error) {
    throw new CapabilityError(
      `${label} failed closed lifecycle validation: ${error instanceof Error ? error.message : "unknown"}`
    );
  }
}

/** Owner-only complete capability/envelope/admission authority store. */
export class CapabilityStore implements Disposable {
  readonly root: string;
  private readonly owner: OwnerSqliteDatabase;

  constructor(projectRoot: string) {
    this.root = capabilityStoreDirectory(projectRoot);
    this.owner = new OwnerSqliteDatabase({
      directory: this.root,
      databaseName: CAPABILITY_DB_NAME,
      label: "KB capability store",
      isLegacyAuthorityFile: (name) => name.endsWith(".json"),
    });
    this.owner.db.exec(`
      CREATE TABLE IF NOT EXISTS capability_envelopes (
        capability_id TEXT PRIMARY KEY,
        envelope_jcs TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('source_read','canonical_target')),
        session_id TEXT NOT NULL,
        kb_profile_id TEXT NOT NULL,
        allowed_operation TEXT NOT NULL CHECK(allowed_operation IN ('ingest','promote')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capability_leases (
        capability_id TEXT PRIMARY KEY REFERENCES capability_envelopes(capability_id),
        envelope_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'available','claimed','commit_reserved','apply_reserved','consumed','invalidated','expired'
        )),
        run_id TEXT,
        transaction_id TEXT,
        claimed_at TEXT,
        reserved_at TEXT,
        terminal_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_admissions (
        source_id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL REFERENCES capability_envelopes(capability_id),
        envelope_sha256 TEXT NOT NULL,
        run_id TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        media_type TEXT NOT NULL CHECK(media_type IN ('text/plain','text/markdown','application/json')),
        byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
        storage_key TEXT NOT NULL UNIQUE,
        temporary_storage_key TEXT UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('preparing','admitted','published','discarding','discarded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(capability_id, run_id, transaction_id)
      );
      CREATE INDEX IF NOT EXISTS source_admissions_run_transaction
        ON source_admissions(run_id, transaction_id, source_id);
    `);
    this.owner.assertCustody();
  }

  register(value: unknown): CapabilityLease {
    this.owner.assertCustody();
    const envelope = validateEnvelopeCrossField(value);
    const jcs = canonicalJson(envelope);
    const digest = sha256Hex(jcs);
    const now = new Date().toISOString();
    const registeredLease = validateHostCapabilityLease({
      schema_version: 1,
      capability_id: envelope.capability_id,
      envelope_sha256: digest,
      state: "available",
    });
    validateSqlTimestamp(now, "capability registration timestamp");
    this.owner.transaction(() => {
      this.owner.db
        .prepare(
          `INSERT INTO capability_envelopes(
             capability_id,envelope_jcs,envelope_sha256,kind,session_id,kb_profile_id,
             allowed_operation,expires_at,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          envelope.capability_id,
          jcs,
          digest,
          envelope.kind,
          envelope.session_id,
          envelope.kb_profile_id,
          envelope.allowed_operation,
          envelope.expires_at,
          now
        );
      this.owner.db
        .prepare(
          `INSERT INTO capability_leases(
             capability_id,envelope_sha256,state,updated_at
           ) VALUES (?,?,'available',?)`
        )
        .run(envelope.capability_id, digest, now);
    });
    const authoritative = this.lease(envelope.capability_id);
    if (
      authoritative === undefined ||
      canonicalJson(authoritative) !== canonicalJson(registeredLease)
    ) {
      throw new CapabilityError(
        `capability '${envelope.capability_id}' registration did not persist exactly`
      );
    }
    return registeredLease;
  }

  envelope(capabilityId: string): CapabilityEnvelope | undefined {
    this.owner.assertCustody();
    const row = this.owner.db
      .prepare(
        `SELECT capability_id,envelope_jcs,envelope_sha256,kind,session_id,kb_profile_id,
                allowed_operation,expires_at,created_at
         FROM capability_envelopes WHERE capability_id = ?`
      )
      .get(capabilityId) as SqlRow | undefined;
    if (row === undefined) return undefined;
    const label = `capability '${capabilityId}' envelope row`;
    assertExactSqlKeys(row, ENVELOPE_ROW_KEYS, label);
    const envelopeJcs = requiredSqlText(row, "envelope_jcs", label);
    const createdAt = requiredSqlText(row, "created_at", label);
    validateSqlTimestamp(createdAt, `${label} created_at`);
    let value: unknown;
    try {
      value = JSON.parse(envelopeJcs) as unknown;
    } catch {
      throw new CapabilityError(`${label} is malformed`);
    }
    let envelope: CapabilityEnvelope;
    try {
      envelope = validateHostCapabilityEnvelope(value);
    } catch (error) {
      throw new CapabilityError(
        `${label} failed closed validation: ${error instanceof Error ? error.message : "unknown"}`
      );
    }
    const jcs = canonicalJson(envelope);
    if (
      envelope.capability_id !== capabilityId ||
      jcs !== envelopeJcs ||
      sha256Hex(jcs) !== requiredSqlText(row, "envelope_sha256", label) ||
      envelope.kind !== requiredSqlText(row, "kind", label) ||
      envelope.session_id !== requiredSqlText(row, "session_id", label) ||
      envelope.kb_profile_id !== requiredSqlText(row, "kb_profile_id", label) ||
      envelope.allowed_operation !== requiredSqlText(row, "allowed_operation", label) ||
      envelope.expires_at !== requiredSqlText(row, "expires_at", label)
    ) {
      throw new CapabilityError(`capability '${capabilityId}' envelope projections do not match`);
    }
    return envelope;
  }

  list(profileId?: string): Array<{ envelope: CapabilityEnvelope; lease: CapabilityLease }> {
    this.owner.assertCustody();
    const rows = (
      profileId === undefined
        ? this.owner.db
            .prepare("SELECT capability_id FROM capability_envelopes ORDER BY capability_id")
            .all()
        : this.owner.db
            .prepare(
              "SELECT capability_id FROM capability_envelopes WHERE kb_profile_id = ? ORDER BY capability_id"
            )
            .all(profileId)
    ) as SqlRow[];
    return rows.map((row) => {
      assertExactSqlKeys(row, ["capability_id"], "capability list row");
      const id = requiredSqlText(row, "capability_id", "capability list row");
      const envelope = this.envelope(id);
      const lease = this.lease(id);
      if (envelope === undefined || lease === undefined) {
        throw new CapabilityError(`capability '${id}' is missing envelope or lease authority`);
      }
      return { envelope, lease };
    });
  }

  claimAll(
    envelopes: readonly CapabilityEnvelope[],
    input: CapabilityBinding & { transactionId: string }
  ): void {
    this.owner.assertCustody();
    if (envelopes.length === 0) return;
    if (!OPAQUE_ID.test(input.transactionId)) {
      throw new CapabilityError("capability admission requires an exact transaction id");
    }
    const ids = envelopes.map((envelope) => envelope.capability_id);
    if (new Set(ids).size !== ids.length) {
      throw new CapabilityError("capability admission requires a unique capability set");
    }
    const now = input.now ?? new Date().toISOString();
    validateSqlTimestamp(now, "capability claim timestamp");
    for (const envelope of envelopes) {
      validateEnvelopeBinding(envelope, { ...input, transactionId: input.transactionId, now });
    }

    this.owner.transaction(() => {
      const states: string[] = [];
      for (const envelope of envelopes) {
        const authoritative = this.envelope(envelope.capability_id);
        if (
          authoritative === undefined ||
          canonicalJson(authoritative) !== canonicalJson(envelope)
        ) {
          throw new CapabilityError(
            `capability '${envelope.capability_id}' envelope does not match authoritative custody`
          );
        }
        const lease = this.lease(envelope.capability_id);
        if (lease === undefined || lease.envelope_sha256 !== envelopeDigest(envelope)) {
          throw new CapabilityError(
            `capability '${envelope.capability_id}' envelope digest does not match lease`
          );
        }
        const exactRecovery =
          lease.state === "claimed" &&
          lease.run_id === input.runId &&
          lease.transaction_id === input.transactionId;
        if (!exactRecovery && lease.state !== "available") {
          throw new CapabilityError(
            `capability '${envelope.capability_id}' is ${lease.state}, not available`
          );
        }
        if (
          lease.state === "available" &&
          (lease.run_id !== undefined || lease.transaction_id !== undefined)
        ) {
          throw new CapabilityError(
            `capability '${envelope.capability_id}' has unexpected prior run ownership`
          );
        }
        states.push(exactRecovery ? "recovery" : "available");
      }
      if (new Set(states).size !== 1) {
        throw new CapabilityError("capability set has a partial exact-transaction claim");
      }
      if (states[0] === "recovery") return;
      for (const envelope of envelopes) {
        validateHostCapabilityLease({
          schema_version: 1,
          capability_id: envelope.capability_id,
          envelope_sha256: envelopeDigest(envelope),
          state: "claimed",
          run_id: input.runId,
          transaction_id: input.transactionId,
          claimed_at: now,
        });
        const changed = this.owner.db
          .prepare(
            `UPDATE capability_leases
             SET state='claimed',run_id=?,transaction_id=?,claimed_at=?,updated_at=?
             WHERE capability_id=? AND state='available' AND run_id IS NULL
               AND transaction_id IS NULL AND envelope_sha256=?`
          )
          .run(
            input.runId,
            input.transactionId,
            now,
            now,
            envelope.capability_id,
            envelopeDigest(envelope)
          );
        if (Number(changed.changes) !== 1) {
          throw new CapabilityError(
            `capability '${envelope.capability_id}' lost its all-or-none claim race`
          );
        }
        this.lease(envelope.capability_id);
      }
    });
  }

  /** Preallocate independent source IDs and exact final/temp keys before claim or I/O. */
  prepareSourceAdmissions(input: {
    envelopes: readonly CapabilityEnvelope[];
    runId: string;
    transactionId: string;
    now?: string;
  }): SourceAdmissionRecord[] {
    this.owner.assertCustody();
    if (
      !OPAQUE_ID.test(input.runId) ||
      !OPAQUE_ID.test(input.transactionId) ||
      input.envelopes.length === 0
    ) {
      throw new CapabilityError("source admission requires an exact non-empty run transaction");
    }
    const envelopes = input.envelopes.map((envelope) => validateEnvelopeCrossField(envelope));
    const ids = envelopes.map((envelope) => envelope.capability_id);
    if (new Set(ids).size !== ids.length) {
      throw new CapabilityError("source admission capability ids must be unique");
    }
    for (const envelope of envelopes) {
      if (envelope.kind !== "source_read" || envelope.media_type === undefined) {
        throw new CapabilityError("source admission accepts source_read envelopes only");
      }
    }
    const existing = this.admissionsForTransaction(input.runId, input.transactionId);
    if (existing.length > 0) {
      const existingCapabilities = existing.map((record) => record.capability_id).sort();
      if (canonicalJson(existingCapabilities) !== canonicalJson([...ids].sort())) {
        throw new CapabilityError("source admission recovery capability set changed");
      }
      return existing;
    }

    const now = input.now ?? new Date().toISOString();
    validateSqlTimestamp(now, "source admission creation timestamp");
    const rows = envelopes.map((envelope) => {
      const mediaType = envelope.media_type;
      if (envelope.kind !== "source_read" || mediaType === undefined) {
        throw new CapabilityError("source admission accepts source_read envelopes only");
      }
      // Deliberately independent of capability ids and every digest.
      const sourceId = `src_${randomUUID().replace(/-/g, "")}`;
      const storageKey = path.posix.join("work", input.runId, "transaction", "sources", sourceId);
      const temporaryStorageKey = path.posix.join(
        "work",
        input.runId,
        "transaction",
        "sources",
        `.${sourceId}.${input.transactionId}.tmp`
      );
      return validateSourceAdmissionRecord({
        schema_version: 1,
        source_id: sourceId,
        capability_id: envelope.capability_id,
        envelope_sha256: envelopeDigest(envelope),
        run_id: input.runId,
        transaction_id: input.transactionId,
        sha256: envelope.expected_sha256,
        media_type: mediaType,
        byte_length: 0,
        storage_key: storageKey,
        temporary_storage_key: temporaryStorageKey,
        state: "preparing",
        created_at: now,
        updated_at: now,
      });
    });
    this.owner.transaction(() => {
      for (const row of rows) {
        const temporaryStorageKey = row.temporary_storage_key;
        if (temporaryStorageKey === undefined) {
          throw new CapabilityError("preparing source admission lost its temporary key");
        }
        this.owner.db
          .prepare(
            `INSERT INTO source_admissions(
               source_id,capability_id,envelope_sha256,run_id,transaction_id,sha256,
               media_type,byte_length,storage_key,temporary_storage_key,state,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,'preparing',?,?)`
          )
          .run(
            row.source_id,
            row.capability_id,
            row.envelope_sha256,
            row.run_id,
            row.transaction_id,
            row.sha256,
            row.media_type,
            row.byte_length,
            row.storage_key,
            temporaryStorageKey,
            row.created_at,
            row.updated_at
          );
      }
    });
    for (const row of rows) {
      const persisted = this.admission(row.source_id);
      if (persisted === undefined || canonicalJson(persisted) !== canonicalJson(row)) {
        throw new CapabilityError(`source admission '${row.source_id}' did not persist exactly`);
      }
    }
    return rows;
  }

  admission(sourceId: string): SourceAdmissionRecord | undefined {
    this.owner.assertCustody();
    const row = this.owner.db
      .prepare(
        `SELECT source_id,capability_id,envelope_sha256,run_id,transaction_id,sha256,
                media_type,byte_length,storage_key,temporary_storage_key,state,created_at,updated_at
         FROM source_admissions WHERE source_id = ?`
      )
      .get(sourceId) as SqlRow | undefined;
    if (row === undefined) return undefined;
    const admission = admissionFromRow(row);
    const envelope = this.envelope(admission.capability_id);
    if (
      envelope === undefined ||
      envelope.kind !== "source_read" ||
      admission.envelope_sha256 !== envelopeDigest(envelope) ||
      admission.sha256 !== envelope.expected_sha256 ||
      admission.media_type !== envelope.media_type
    ) {
      throw new CapabilityError(
        `source admission '${sourceId}' disagrees with its immutable capability envelope`
      );
    }
    return admission;
  }

  admissionsForTransaction(runId: string, transactionId: string): SourceAdmissionRecord[] {
    this.owner.assertCustody();
    const rows = this.owner.db
      .prepare(
        `SELECT source_id,capability_id,envelope_sha256,run_id,transaction_id,sha256,
                media_type,byte_length,storage_key,temporary_storage_key,state,created_at,updated_at
         FROM source_admissions
         WHERE run_id=? AND transaction_id=? ORDER BY source_id`
      )
      .all(runId, transactionId) as SqlRow[];
    return rows.map((row) => {
      const parsed = admissionFromRow(row);
      const authoritative = this.admission(parsed.source_id);
      if (authoritative === undefined || canonicalJson(authoritative) !== canonicalJson(parsed)) {
        throw new CapabilityError(`source admission '${parsed.source_id}' changed during read`);
      }
      return authoritative;
    });
  }

  admissionsForRun(runId: string): SourceAdmissionRecord[] {
    this.owner.assertCustody();
    const rows = this.owner.db
      .prepare(
        `SELECT source_id,capability_id,envelope_sha256,run_id,transaction_id,sha256,
                media_type,byte_length,storage_key,temporary_storage_key,state,created_at,updated_at
         FROM source_admissions WHERE run_id=? ORDER BY source_id`
      )
      .all(runId) as SqlRow[];
    return rows.map((row) => {
      const parsed = admissionFromRow(row);
      const authoritative = this.admission(parsed.source_id);
      if (authoritative === undefined || canonicalJson(authoritative) !== canonicalJson(parsed)) {
        throw new CapabilityError(`source admission '${parsed.source_id}' changed during read`);
      }
      return authoritative;
    });
  }

  admitSource(sourceId: string, byteLength: number, now = new Date().toISOString()): void {
    this.owner.assertCustody();
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new CapabilityError("source admission byte length is invalid");
    }
    validateSqlTimestamp(now, "source admission timestamp");
    const current = this.admission(sourceId);
    if (current === undefined || current.state !== "preparing") {
      throw new CapabilityError(`source admission '${sourceId}' is not preparing`);
    }
    const { temporary_storage_key: _temporaryStorageKey, ...withoutTemporaryKey } = current;
    const next = validateSourceAdmissionRecord({
      ...withoutTemporaryKey,
      state: "admitted",
      byte_length: byteLength,
      updated_at: now,
    });
    const changed = this.owner.db
      .prepare(
        `UPDATE source_admissions
         SET state='admitted',byte_length=?,temporary_storage_key=NULL,updated_at=?
         WHERE source_id=? AND state='preparing'`
      )
      .run(byteLength, now, sourceId);
    if (Number(changed.changes) !== 1) {
      throw new CapabilityError(`source admission '${sourceId}' lost its admitted CAS`);
    }
    const persisted = this.admission(sourceId);
    if (persisted === undefined || canonicalJson(persisted) !== canonicalJson(next)) {
      throw new CapabilityError(
        `source admission '${sourceId}' admitted row did not persist exactly`
      );
    }
  }

  beginDiscardAdmissions(
    runId: string,
    transactionId: string,
    now = new Date().toISOString()
  ): void {
    this.owner.assertCustody();
    validateSqlTimestamp(now, "source admission discard timestamp");
    const current = this.admissionsForTransaction(runId, transactionId).filter((record) =>
      ["preparing", "admitted"].includes(record.state)
    );
    for (const record of current) {
      validateSourceAdmissionRecord({ ...record, state: "discarding", updated_at: now });
    }
    this.owner.db
      .prepare(
        `UPDATE source_admissions SET state='discarding',updated_at=?
         WHERE run_id=? AND transaction_id=? AND state IN ('preparing','admitted')`
      )
      .run(now, runId, transactionId);
    for (const record of current) this.admission(record.source_id);
  }

  finishDiscardAdmission(sourceId: string, now = new Date().toISOString()): void {
    this.owner.assertCustody();
    validateSqlTimestamp(now, "source admission discard completion timestamp");
    const current = this.admission(sourceId);
    if (current === undefined || current.state !== "discarding") {
      throw new CapabilityError(`source admission '${sourceId}' is not discarding`);
    }
    const { temporary_storage_key: _temporaryStorageKey, ...withoutTemporaryKey } = current;
    const next = validateSourceAdmissionRecord({
      ...withoutTemporaryKey,
      state: "discarded",
      updated_at: now,
    });
    const changed = this.owner.db
      .prepare(
        `UPDATE source_admissions
         SET state='discarded',temporary_storage_key=NULL,updated_at=?
         WHERE source_id=? AND state='discarding'`
      )
      .run(now, sourceId);
    if (Number(changed.changes) !== 1) {
      throw new CapabilityError(`source admission '${sourceId}' lost its discard CAS`);
    }
    const persisted = this.admission(sourceId);
    if (persisted === undefined || canonicalJson(persisted) !== canonicalJson(next)) {
      throw new CapabilityError(
        `source admission '${sourceId}' discard row did not persist exactly`
      );
    }
  }

  /**
   * Atomically reserve the complete source-capability set for one publication
   * transaction immediately before selector commit. Exact retries are
   * idempotent; expiry is checked only before this non-expiring cliff.
   */
  reserveSourceCommitAll(
    capabilityIds: readonly string[],
    runId: string,
    publicationTransactionId: string,
    now = new Date().toISOString()
  ): void {
    this.owner.assertCustody();
    const ids = [...capabilityIds];
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new CapabilityError("source commit reservation requires a non-empty unique set");
    }
    validateSqlTimestamp(now, "source commit reservation timestamp");
    this.owner.transaction(() => {
      for (const id of ids) {
        const lease = this.lease(id);
        const exact =
          lease?.state === "commit_reserved" &&
          lease.run_id === runId &&
          lease.transaction_id === publicationTransactionId;
        if (exact) continue;
        const envelope = this.envelope(id);
        if (
          lease?.state !== "claimed" ||
          lease.run_id !== runId ||
          envelope === undefined ||
          Date.parse(envelope.expires_at) <= Date.parse(now)
        ) {
          throw new CapabilityError(
            `capability '${id}' cannot enter this publication commit reservation`
          );
        }
      }
      for (const id of ids) {
        this.owner.db
          .prepare(
            `UPDATE capability_leases
             SET state='commit_reserved',transaction_id=?,reserved_at=?,updated_at=?
             WHERE capability_id=? AND state='claimed' AND run_id=?`
          )
          .run(publicationTransactionId, now, now, id, runId);
        this.lease(id);
      }
    });
  }

  /** Proven pre-selector abort for this publication transaction. */
  invalidateSourceCommitAll(
    capabilityIds: readonly string[],
    runId: string,
    publicationTransactionId: string,
    now = new Date().toISOString()
  ): void {
    this.owner.assertCustody();
    const ids = [...capabilityIds];
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new CapabilityError("source commit invalidation requires a non-empty unique set");
    }
    validateSqlTimestamp(now, "source commit invalidation timestamp");
    this.owner.transaction(() => {
      for (const id of ids) {
        const lease = this.lease(id);
        const exactTerminal =
          lease?.state === "invalidated" &&
          lease.run_id === runId &&
          lease.transaction_id === publicationTransactionId;
        const abortable =
          lease?.run_id === runId &&
          ((lease.state === "commit_reserved" &&
            lease.transaction_id === publicationTransactionId) ||
            lease.state === "claimed");
        if (!exactTerminal && !abortable) {
          throw new CapabilityError(
            `capability '${id}' is not abortable by publication '${publicationTransactionId}'`
          );
        }
      }
      for (const id of ids) {
        this.owner.db
          .prepare(
            `UPDATE capability_leases
             SET state='invalidated',transaction_id=?,terminal_at=?,updated_at=?
             WHERE capability_id=? AND run_id=? AND state IN ('claimed','commit_reserved')`
          )
          .run(publicationTransactionId, now, now, id, runId);
        this.lease(id);
      }
    });
  }

  settlePublishedSources(input: {
    capabilityIds: readonly string[];
    sourceIds: readonly string[];
    runId: string;
    transactionId: string;
    now?: string;
  }): void {
    this.owner.assertCustody();
    const capabilityIds = [...input.capabilityIds];
    const sourceIds = [...input.sourceIds];
    if (
      capabilityIds.length === 0 ||
      capabilityIds.length !== sourceIds.length ||
      new Set(capabilityIds).size !== capabilityIds.length ||
      new Set(sourceIds).size !== sourceIds.length
    ) {
      throw new CapabilityError(
        "published source settlement requires exact unique source/capability sets"
      );
    }
    const now = input.now ?? new Date().toISOString();
    validateSqlTimestamp(now, "published source settlement timestamp");
    this.owner.transaction(() => {
      const admissions = sourceIds.map((sourceId) => {
        const admission = this.admission(sourceId);
        if (
          admission === undefined ||
          !["admitted", "published"].includes(admission.state) ||
          admission.run_id !== input.runId
        ) {
          throw new CapabilityError(`source admission '${sourceId}' is not publishable`);
        }
        return admission;
      });
      const admissionCapabilityIds = admissions.map((admission) => admission.capability_id);
      if (
        new Set(admissionCapabilityIds).size !== admissionCapabilityIds.length ||
        canonicalJson([...admissionCapabilityIds].sort()) !==
          canonicalJson([...capabilityIds].sort())
      ) {
        throw new CapabilityError(
          "published source settlement does not match the exact admission capability set"
        );
      }
      for (const id of capabilityIds) {
        const lease = this.lease(id);
        const exact =
          lease?.run_id === input.runId &&
          lease.transaction_id === input.transactionId &&
          (lease.state === "commit_reserved" || lease.state === "consumed");
        if (!exact) {
          throw new CapabilityError(
            `capability '${id}' is not reserved by the exact publication transaction`
          );
        }
      }
      for (const id of capabilityIds) {
        const lease = this.lease(id);
        if (lease === undefined) {
          throw new CapabilityError(`capability '${id}' disappeared during publication settlement`);
        }
        if (lease.state === "commit_reserved") {
          const changed = this.owner.db
            .prepare(
              `UPDATE capability_leases SET state='consumed',terminal_at=?,updated_at=?
               WHERE capability_id=? AND state='commit_reserved' AND run_id=? AND transaction_id=?`
            )
            .run(now, now, id, input.runId, input.transactionId);
          if (Number(changed.changes) !== 1) {
            throw new CapabilityError(`capability '${id}' lost its publication consume CAS`);
          }
        }
        const persisted = this.lease(id);
        if (
          persisted?.state !== "consumed" ||
          persisted.run_id !== input.runId ||
          persisted.transaction_id !== input.transactionId
        ) {
          throw new CapabilityError(`capability '${id}' did not settle to exact consumed state`);
        }
      }
      for (const admission of admissions) {
        if (admission.state === "admitted") {
          const changed = this.owner.db
            .prepare(
              `UPDATE source_admissions SET state='published',updated_at=?
               WHERE source_id=? AND capability_id=? AND state='admitted'
                 AND run_id=? AND transaction_id=?`
            )
            .run(
              now,
              admission.source_id,
              admission.capability_id,
              input.runId,
              admission.transaction_id
            );
          if (Number(changed.changes) !== 1) {
            throw new CapabilityError(
              `source admission '${admission.source_id}' lost its published CAS`
            );
          }
        }
        const persisted = this.admission(admission.source_id);
        if (
          persisted?.state !== "published" ||
          persisted.run_id !== input.runId ||
          persisted.transaction_id !== admission.transaction_id ||
          persisted.capability_id !== admission.capability_id
        ) {
          throw new CapabilityError(
            `source admission '${admission.source_id}' did not settle to exact published state`
          );
        }
      }
    });
  }

  reserveApplyAll(
    capabilityIds: readonly string[],
    runId: string,
    transactionId: string,
    now = new Date().toISOString()
  ): void {
    this.owner.assertCustody();
    const ids = [...capabilityIds];
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new CapabilityError("apply reservation requires a non-empty unique capability set");
    }
    validateSqlTimestamp(now, "apply reservation timestamp");
    this.owner.transaction(() => {
      for (const id of ids) {
        const lease = this.lease(id);
        const exact =
          lease?.state === "apply_reserved" &&
          lease.run_id === runId &&
          lease.transaction_id === transactionId;
        if (!exact && (lease?.state !== "claimed" || lease.run_id !== runId)) {
          throw new CapabilityError(
            `capability '${id}' is not claimed by promotion run '${runId}'`
          );
        }
      }
      for (const id of ids) {
        this.owner.db
          .prepare(
            `UPDATE capability_leases
             SET state='apply_reserved',transaction_id=?,reserved_at=?,updated_at=?
             WHERE capability_id=? AND state='claimed' AND run_id=?`
          )
          .run(transactionId, now, now, id, runId);
        this.lease(id);
      }
    });
  }

  consumeApplyReservedAll(
    capabilityIds: readonly string[],
    runId: string,
    transactionId: string,
    now = new Date().toISOString()
  ): void {
    this.settleApplySet(capabilityIds, runId, transactionId, "consumed", now);
  }

  invalidateApplySet(
    capabilityIds: readonly string[],
    runId: string,
    transactionId: string,
    now = new Date().toISOString()
  ): void {
    this.settleApplySet(capabilityIds, runId, transactionId, "invalidated", now);
  }

  private settleApplySet(
    capabilityIds: readonly string[],
    runId: string,
    transactionId: string,
    terminalState: "consumed" | "invalidated",
    now: string
  ): void {
    this.owner.assertCustody();
    const ids = [...capabilityIds];
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new CapabilityError("apply settlement requires a non-empty unique capability set");
    }
    validateSqlTimestamp(now, "apply settlement timestamp");
    this.owner.transaction(() => {
      for (const id of ids) {
        const lease = this.lease(id);
        if (
          lease?.state === terminalState &&
          lease.run_id === runId &&
          lease.transaction_id === transactionId
        ) {
          continue;
        }
        const allowed =
          lease?.run_id === runId &&
          ((lease.state === "apply_reserved" && lease.transaction_id === transactionId) ||
            (terminalState === "invalidated" && lease.state === "claimed"));
        if (!allowed) {
          throw new CapabilityError(
            `capability '${id}' is not owned by apply transaction '${transactionId}'`
          );
        }
      }
      for (const id of ids) {
        this.owner.db
          .prepare(
            `UPDATE capability_leases
             SET state=?,transaction_id=?,terminal_at=?,updated_at=?
             WHERE capability_id=? AND run_id=? AND state IN ('claimed','apply_reserved')`
          )
          .run(terminalState, transactionId, now, now, id, runId);
        this.lease(id);
      }
    });
  }

  consume(capabilityId: string, now = new Date().toISOString()): void {
    this.owner.assertCustody();
    validateSqlTimestamp(now, "capability consumption timestamp");
    this.lease(capabilityId);
    const changed = this.owner.db
      .prepare(
        `UPDATE capability_leases SET state='consumed',terminal_at=?,updated_at=?
         WHERE capability_id=? AND state IN ('claimed','commit_reserved','apply_reserved')`
      )
      .run(now, now, capabilityId);
    if (Number(changed.changes) !== 1) {
      throw new CapabilityError(
        `capability '${capabilityId}' cannot be consumed from its current state`
      );
    }
    this.lease(capabilityId);
  }

  invalidate(capabilityId: string, now = new Date().toISOString()): void {
    this.owner.assertCustody();
    validateSqlTimestamp(now, "capability invalidation timestamp");
    this.lease(capabilityId);
    const changed = this.owner.db
      .prepare(
        `UPDATE capability_leases SET state='invalidated',terminal_at=?,updated_at=?
         WHERE capability_id=? AND state NOT IN ('consumed','invalidated','expired')`
      )
      .run(now, now, capabilityId);
    if (Number(changed.changes) !== 1) {
      throw new CapabilityError(
        `capability '${capabilityId}' cannot be invalidated from its current state`
      );
    }
    this.lease(capabilityId);
  }

  invalidateClaimedAll(input: {
    capabilityIds: readonly string[];
    runId: string;
    transactionId: string;
    now?: string;
  }): void {
    this.owner.assertCustody();
    const ids = [...input.capabilityIds];
    if (ids.length === 0) return;
    if (new Set(ids).size !== ids.length) {
      throw new CapabilityError("capability invalidation set must be unique");
    }
    const now = input.now ?? new Date().toISOString();
    validateSqlTimestamp(now, "claimed capability invalidation timestamp");
    this.owner.transaction(() => {
      for (const id of ids) {
        const lease = this.lease(id);
        const terminalExact =
          lease?.state === "invalidated" &&
          lease.run_id === input.runId &&
          lease.transaction_id === input.transactionId;
        if (
          !terminalExact &&
          !(
            lease?.state === "claimed" &&
            lease.run_id === input.runId &&
            lease.transaction_id === input.transactionId
          )
        ) {
          throw new CapabilityError(`capability '${id}' is not the exact claimed authority`);
        }
      }
      for (const id of ids) {
        this.owner.db
          .prepare(
            `UPDATE capability_leases SET state='invalidated',terminal_at=?,updated_at=?
             WHERE capability_id=? AND state='claimed' AND run_id=? AND transaction_id=?`
          )
          .run(now, now, id, input.runId, input.transactionId);
        this.lease(id);
      }
    });
  }

  lease(capabilityId: string): CapabilityLease | undefined {
    this.owner.assertCustody();
    const row = this.owner.db
      .prepare(
        `SELECT capability_id,envelope_sha256,state,run_id,transaction_id,claimed_at,
                reserved_at,terminal_at,updated_at
         FROM capability_leases WHERE capability_id = ?`
      )
      .get(capabilityId) as SqlRow | undefined;
    if (row === undefined) return undefined;
    const lease = leaseFromRow(row);
    const envelope = this.envelope(lease.capability_id);
    if (envelope === undefined || lease.envelope_sha256 !== envelopeDigest(envelope)) {
      throw new CapabilityError(
        `capability '${capabilityId}' lease digest disagrees with its immutable envelope`
      );
    }
    return lease;
  }

  close(): void {
    this.owner.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
