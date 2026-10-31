import type { SQLOutputValue } from "node:sqlite";

import { Type } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import type { PlaybookRegistration } from "../playbooks/registry.js";
import { OwnerSqliteDatabase } from "../state/owner-sqlite.js";
import {
  OpaqueIdSchema,
  assertOpaqueId,
  assertRfc3339Utc,
  validateSkillSchema,
} from "../skill-contracts/common.js";
import type {
  ScaActivationConsumptionReceiptV1,
  SqliteScaActivationOwner,
} from "./activation-owner.js";
import {
  requireScaActivationAdmissionV1,
  type ScaActivationHostV1,
  type ScaProposedActivationStartV1,
  type VerifiedScaActivationAdmissionViewV1,
} from "./qualification-activation.js";
import { resolveScaPhaseRegistration } from "./phase-registry.js";

const DATABASE_NAME = "sca-phase-activation.sqlite";
const SCHEMA_VERSION = 1;
const DDL = `CREATE TABLE activations (
  authority_id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL,
  playbook_name TEXT NOT NULL,
  activation_run_id TEXT NOT NULL UNIQUE,
  binding_sha256 TEXT NOT NULL,
  consumption_receipt_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  activated_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  revocation_evidence_sha256 TEXT,
  CHECK ((state='active' AND revoked_at IS NULL AND revocation_reason IS NULL AND revocation_evidence_sha256 IS NULL)
    OR (state='revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL AND revocation_evidence_sha256 IS NOT NULL))
) STRICT`;
const SHA256 = /^[a-f0-9]{64}$/u;
const ConsumptionReceiptSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_id: Type.String({ minLength: 69, maxLength: 69, pattern: "^scac_[a-f0-9]{64}$" }),
    decision: Type.Union([Type.Literal("consumed"), Type.Literal("resumed")]),
    authority_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    admitted_at: Type.String(),
  },
  { additionalProperties: false }
);

/** Consumption and phase activation commit in separate databases. A recovery-needed
 * failure must retry the exact authority/run, never install or consume a replacement. */
export class ScaPhaseActivationError extends Error {
  constructor(
    readonly code: "conflict" | "invalid_state" | "storage_failed" | "recovery_needed",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaPhaseActivationError";
  }
}

function consumptionReceipt(value: unknown): ScaActivationConsumptionReceiptV1 {
  const receipt = validateSkillSchema(ConsumptionReceiptSchema, value, "SCA consumption receipt");
  assertRfc3339Utc(receipt.admitted_at, "SCA phase activation consumption time");
  assertOpaqueId(receipt.authority_id, "SCA consumption authority");
  assertOpaqueId(receipt.run_id, "SCA consumption run");
  return receipt;
}

function consumptionIdentity(receipt: ScaActivationConsumptionReceiptV1): string {
  // Only the observation decision changes on a real owner resume. Do not rewrite history.
  const { decision: _decision, ...identity } = receipt;
  return canonicalJson(identity);
}

interface ActivationRowV1 {
  readonly authority_id: string;
  readonly phase_id: string;
  readonly playbook_name: string;
  readonly activation_run_id: string;
  readonly binding_sha256: string;
  readonly consumption_receipt_json: string;
  readonly state: "active" | "revoked";
  readonly activated_at: string;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
  readonly revocation_evidence_sha256: string | null;
}

export interface ScaPhaseActivationReceiptV1 {
  readonly schema_version: 1;
  readonly receipt_id: string;
  readonly decision: "activated" | "resumed";
  readonly authority_id: string;
  readonly phase_id: string;
  readonly playbook_name: string;
  readonly activation_run_id: string;
  readonly binding_sha256: string;
  readonly activated_at: string;
}

export interface ScaPhaseActivationRevocationReceiptV1 {
  readonly schema_version: 1;
  readonly authority_id: string;
  readonly phase_id: string;
  readonly playbook_name: string;
  readonly reason: string;
  readonly evidence_sha256: string;
  readonly revoked_at: string;
}

function isSqlRow(value: unknown): value is Readonly<Record<string, SQLOutputValue>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (item) =>
        item === null ||
        typeof item === "string" ||
        typeof item === "number" ||
        item instanceof Uint8Array
    )
  );
}

function text(row: Readonly<Record<string, SQLOutputValue>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new Error(`SCA phase activation ${field} is malformed`);
  return value;
}

function optionalText(row: Readonly<Record<string, SQLOutputValue>>, field: string): string | null {
  return row[field] === null ? null : text(row, field);
}

function exactRow(value: unknown): ActivationRowV1 {
  if (!isSqlRow(value)) throw new Error("SCA phase activation row is absent or malformed");
  const state = text(value, "state");
  if (state !== "active" && state !== "revoked")
    throw new Error("SCA phase activation state is malformed");
  const row: ActivationRowV1 = {
    authority_id: text(value, "authority_id"),
    phase_id: text(value, "phase_id"),
    playbook_name: text(value, "playbook_name"),
    activation_run_id: text(value, "activation_run_id"),
    binding_sha256: text(value, "binding_sha256"),
    consumption_receipt_json: text(value, "consumption_receipt_json"),
    state,
    activated_at: text(value, "activated_at"),
    revoked_at: optionalText(value, "revoked_at"),
    revocation_reason: optionalText(value, "revocation_reason"),
    revocation_evidence_sha256: optionalText(value, "revocation_evidence_sha256"),
  };
  for (const id of [row.authority_id, row.phase_id, row.playbook_name, row.activation_run_id]) {
    validateSkillSchema(OpaqueIdSchema, id, "SCA phase activation ID");
    assertOpaqueId(id, "SCA phase activation ID");
  }
  if (row.binding_sha256.length !== 64 || !SHA256.test(row.binding_sha256))
    throw new Error("SCA phase activation binding is malformed");
  assertRfc3339Utc(row.activated_at, "SCA phase activated_at");
  if (row.revoked_at !== null) assertRfc3339Utc(row.revoked_at, "SCA phase revoked_at");
  if (
    (row.state === "active" &&
      (row.revoked_at !== null ||
        row.revocation_reason !== null ||
        row.revocation_evidence_sha256 !== null)) ||
    (row.state === "revoked" &&
      (row.revoked_at === null ||
        row.revocation_reason === null ||
        row.revocation_evidence_sha256 === null ||
        row.revocation_evidence_sha256.length !== 64 ||
        !SHA256.test(row.revocation_evidence_sha256)))
  )
    throw new Error("SCA phase activation row custody is ambiguous");
  const receipt = consumptionReceipt(JSON.parse(row.consumption_receipt_json));
  if (
    canonicalJson(receipt) !== row.consumption_receipt_json ||
    receipt.authority_id !== row.authority_id ||
    receipt.run_id !== row.activation_run_id ||
    Date.parse(receipt.admitted_at) > Date.parse(row.activated_at) ||
    (row.revoked_at !== null && Date.parse(row.revoked_at) < Date.parse(row.activated_at))
  )
    throw new Error("SCA phase activation consumption receipt custody is invalid");
  if (row.revocation_reason !== null) {
    validateSkillSchema(OpaqueIdSchema, row.revocation_reason, "SCA phase revocation reason");
    assertOpaqueId(row.revocation_reason, "SCA phase revocation reason");
  }
  return row;
}

function activationBinding(view: VerifiedScaActivationAdmissionViewV1): string {
  const { checked_at: _checkedAt, ...binding } = view;
  return sha256(canonicalJson(binding));
}

function phaseRegistration(proposed: ScaProposedActivationStartV1): PlaybookRegistration {
  const registration = resolveScaPhaseRegistration(proposed.production_playbook_name);
  if (registration === undefined) throw new Error("SCA phase activation registration is absent");
  return registration;
}

function activationReceipt(
  row: ActivationRowV1,
  decision: ScaPhaseActivationReceiptV1["decision"]
): ScaPhaseActivationReceiptV1 {
  return {
    schema_version: 1,
    receipt_id: `scap_${sha256(
      canonicalJson({
        authority_id: row.authority_id,
        phase_id: row.phase_id,
        playbook_name: row.playbook_name,
        activation_run_id: row.activation_run_id,
        binding_sha256: row.binding_sha256,
      })
    )}`,
    decision,
    authority_id: row.authority_id,
    phase_id: row.phase_id,
    playbook_name: row.playbook_name,
    activation_run_id: row.activation_run_id,
    binding_sha256: row.binding_sha256,
    activated_at: row.activated_at,
  };
}

/**
 * Durable phase availability owner. Qualification/issuance is replayed on every resolve, so a
 * stale gate, source tree, registration, revocation generation, expired authority, or changed host
 * fails closed even when an older activation row remains present.
 */
export class SqliteScaPhaseActivationRegistry implements Disposable {
  private readonly store: OwnerSqliteDatabase;
  private readonly now: () => number;
  private closed = false;

  constructor(input: { readonly directory: string; readonly now?: () => number }) {
    this.now = input.now ?? Date.now;
    this.store = new OwnerSqliteDatabase({
      directory: input.directory,
      databaseName: DATABASE_NAME,
      label: "Penny SCA phase activation registry",
    });
    try {
      this.store.transaction(() => {
        const version = this.schemaVersion();
        if (version === 0) {
          if (
            this.store.db
              .prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
              .all().length !== 0
          )
            throw new Error("SCA phase activation unversioned schema");
          this.store.db.exec(DDL);
          this.store.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
        }
        this.assertSchema();
      });
    } catch (error) {
      this.store.close();
      this.closed = true;
      throw error;
    }
  }

  activate(input: {
    readonly host: ScaActivationHostV1;
    readonly proposed: ScaProposedActivationStartV1;
    readonly owner: Pick<SqliteScaActivationOwner, "consume">;
  }): ScaPhaseActivationReceiptV1 {
    phaseRegistration(input.proposed);
    // Observe the exact issuance already authenticated by admission; no extra host sample.
    const issuance: { id?: string; sha256?: string } = {};
    const host: ScaActivationHostV1 = {
      sample: () => input.host.sample(),
      verifyIssuance: (claim) => {
        const verified = input.host.verifyIssuance(claim);
        if (verified === true) {
          issuance.id = claim.record.issuance_id;
          issuance.sha256 = claim.record.issuance_sha256;
        }
        return verified;
      },
    };
    const view = requireScaActivationAdmissionV1({ host, proposed: input.proposed });
    if (issuance.id === undefined || issuance.sha256 !== view.issuance_sha256)
      throw new ScaPhaseActivationError("invalid_state", "SCA authenticated issuance is absent");
    const receiptId = `scac_${sha256(
      canonicalJson({
        authority_id: view.authority_id,
        issuance_id: issuance.id,
        run_id: view.activation_run_id,
        proposed_start_sha256: view.proposed_start_sha256,
      })
    )}`;
    const binding = activationBinding(view);
    let consumptionAttempted = false;
    try {
      return this.store.transaction(() => {
        this.assertSchema();
        let rows: readonly ActivationRowV1[];
        try {
          // Validate retained active and revoked custody before the irreversible owner call.
          rows = this.store.db
            .prepare("SELECT * FROM activations ORDER BY authority_id")
            .all()
            .map((value) => exactRow(value));
        } catch (cause) {
          throw new ScaPhaseActivationError(
            "invalid_state",
            "SCA phase activation custody is invalid",
            {
              cause,
            }
          );
        }
        const candidates = rows.filter(
          (row) =>
            row.authority_id === view.authority_id ||
            row.activation_run_id === view.activation_run_id ||
            (row.state === "active" &&
              (row.phase_id === view.phase_id ||
                row.playbook_name === view.production_playbook_name))
        );
        const existing = candidates[0];
        if (
          candidates.length > 1 ||
          (existing !== undefined &&
            (existing.state !== "active" ||
              existing.authority_id !== view.authority_id ||
              existing.phase_id !== view.phase_id ||
              existing.playbook_name !== view.production_playbook_name ||
              existing.activation_run_id !== view.activation_run_id ||
              existing.binding_sha256 !== binding ||
              consumptionReceipt(JSON.parse(existing.consumption_receipt_json)).receipt_id !==
                receiptId))
        )
          throw new ScaPhaseActivationError(
            "conflict",
            "SCA phase activation refuses to overwrite an active or retired binding"
          );

        // Sampling/qualification stays outside this transaction. The existing owner checks
        // admission age, expiry, generation and key/grant revocation after lock acquisition.
        consumptionAttempted = true;
        const consumed = consumptionReceipt(input.owner.consume(view));
        this.assertConsumption(consumed, view, receiptId);
        if (existing !== undefined) {
          const original = consumptionReceipt(JSON.parse(existing.consumption_receipt_json));
          if (consumptionIdentity(original) !== consumptionIdentity(consumed))
            throw new Error("SCA phase activation consumption identity changed");
          return activationReceipt(existing, "resumed");
        }
        // Exact resumed-owner adoption repairs a failed phase commit. Preserve the owner
        // receipt verbatim (including 'resumed') and its original consumption timestamp.
        const activatedAt = consumed.admitted_at;
        this.store.db
          .prepare(
            `INSERT INTO activations
             (authority_id,phase_id,playbook_name,activation_run_id,binding_sha256,
              consumption_receipt_json,state,activated_at,revoked_at,revocation_reason,
              revocation_evidence_sha256)
             VALUES (?,?,?,?,?,?,'active',?,NULL,NULL,NULL)`
          )
          .run(
            view.authority_id,
            view.phase_id,
            view.production_playbook_name,
            view.activation_run_id,
            binding,
            canonicalJson(consumed),
            activatedAt
          );
        const inserted = this.byAuthority(view.authority_id);
        if (inserted === undefined) throw new Error("SCA phase activation was not persisted");
        return activationReceipt(inserted, "activated");
      });
    } catch (cause) {
      if (!consumptionAttempted && cause instanceof ScaPhaseActivationError) throw cause;
      throw new ScaPhaseActivationError(
        consumptionAttempted ? "recovery_needed" : "storage_failed",
        consumptionAttempted
          ? "SCA owner consumption may be committed; retry only the exact authority/run"
          : "SCA phase activation storage failed before consumption",
        { cause }
      );
    }
  }

  resolve(input: {
    readonly host: ScaActivationHostV1;
    readonly proposed: ScaProposedActivationStartV1;
  }): PlaybookRegistration {
    const registration = phaseRegistration(input.proposed);
    const view = requireScaActivationAdmissionV1({ host: input.host, proposed: input.proposed });
    this.store.assertCustody();
    this.assertSchema();
    const rows = this.activeRows(view.phase_id, view.production_playbook_name);
    if (rows.length !== 1) throw new Error("SCA phase is not durably active");
    const row = rows[0];
    if (
      row === undefined ||
      row.authority_id !== view.authority_id ||
      row.activation_run_id !== view.activation_run_id ||
      row.binding_sha256 !== activationBinding(view)
    )
      throw new Error("SCA phase activation binding changed");
    return registration;
  }

  revoke(input: {
    readonly authority_id: string;
    readonly reason: string;
    readonly evidence_sha256: string;
  }): ScaPhaseActivationRevocationReceiptV1 {
    validateSkillSchema(OpaqueIdSchema, input.authority_id, "SCA phase activation authority");
    validateSkillSchema(OpaqueIdSchema, input.reason, "SCA phase activation revocation reason");
    assertOpaqueId(input.authority_id, "SCA phase activation authority");
    assertOpaqueId(input.reason, "SCA phase activation revocation reason");
    if (input.evidence_sha256.length !== 64 || !SHA256.test(input.evidence_sha256))
      throw new Error("SCA phase activation revocation evidence is malformed");
    return this.store.transaction(() => {
      this.assertSchema();
      const row = this.byAuthority(input.authority_id);
      if (row === undefined) throw new Error("SCA phase activation authority is absent");
      if (
        row.state === "revoked" &&
        (row.revocation_reason !== input.reason ||
          row.revocation_evidence_sha256 !== input.evidence_sha256)
      )
        throw new Error("SCA phase activation revocation conflicts");
      const revokedAt = row.revoked_at ?? new Date(this.now()).toISOString();
      if (row.state === "active") {
        const changed = this.store.db
          .prepare(
            `UPDATE activations SET state='revoked',revoked_at=?,revocation_reason=?,
             revocation_evidence_sha256=? WHERE authority_id=? AND state='active'`
          )
          .run(revokedAt, input.reason, input.evidence_sha256, input.authority_id);
        if (Number(changed.changes) !== 1)
          throw new Error("SCA phase activation revocation compare-and-set failed");
      }
      return {
        schema_version: 1,
        authority_id: row.authority_id,
        phase_id: row.phase_id,
        playbook_name: row.playbook_name,
        reason: input.reason,
        evidence_sha256: input.evidence_sha256,
        revoked_at: revokedAt,
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.store.close();
    this.closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private assertConsumption(
    receipt: ScaActivationConsumptionReceiptV1,
    view: VerifiedScaActivationAdmissionViewV1,
    receiptId: string
  ): void {
    if (
      receipt.receipt_id !== receiptId ||
      receipt.authority_id !== view.authority_id ||
      receipt.run_id !== view.activation_run_id ||
      (receipt.decision !== "consumed" && receipt.decision !== "resumed")
    )
      throw new Error("SCA phase activation consumption receipt is misbound");
    const now = this.now();
    if (
      Date.parse(receipt.admitted_at) >= Date.parse(view.expires_at) ||
      !Number.isFinite(now) ||
      Date.parse(receipt.admitted_at) > now
    )
      throw new Error("SCA phase activation consumption receipt is expired");
  }

  private schemaVersion(): number {
    const value = this.store.db.prepare("PRAGMA user_version").get();
    if (!isSqlRow(value) || typeof value["user_version"] !== "number")
      throw new Error("SCA phase activation schema version is malformed");
    const version = value["user_version"];
    if (!Number.isInteger(version))
      throw new Error("SCA phase activation schema version is malformed");
    return version;
  }

  private assertSchema(): void {
    this.store.assertCustody();
    if (this.schemaVersion() !== SCHEMA_VERSION)
      throw new Error("SCA phase activation schema version is incompatible");
    const objects = this.store.db
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name"
      )
      .all();
    const object = objects[0];
    if (
      objects.length !== 1 ||
      !isSqlRow(object) ||
      text(object, "type") !== "table" ||
      text(object, "name") !== "activations" ||
      text(object, "sql") !== DDL
    )
      throw new Error("SCA phase activation schema layout changed");
  }

  private byAuthority(authorityId: string): ActivationRowV1 | undefined {
    const value = this.store.db
      .prepare("SELECT * FROM activations WHERE authority_id=?")
      .get(authorityId);
    return value === undefined ? undefined : exactRow(value);
  }

  private activeRows(phaseId: string, playbookName: string): readonly ActivationRowV1[] {
    return this.store.db
      .prepare(
        "SELECT * FROM activations WHERE (phase_id=? OR playbook_name=?) AND state='active' ORDER BY activated_at,authority_id"
      )
      .all(phaseId, playbookName)
      .map((value) => exactRow(value));
  }
}
