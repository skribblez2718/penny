import type { SQLOutputValue } from "node:sqlite";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { currentArtifactRef } from "../artifact-store.js";
import type { ArtifactRef } from "../contracts.js";
import { OwnerSqliteDatabase } from "../state/owner-sqlite.js";
import {
  OpaqueIdSchema,
  assertOpaqueId,
  assertRfc3339Utc,
  validateSkillSchema,
} from "../skill-contracts/common.js";
import {
  validateScaActivationAuthorityV1,
  validateScaActivationIssuanceV1,
  type ScaActivationAuthorityV1,
  type ScaActivationIssuanceV1,
  type ScaActivationScopeV1,
} from "./qualification-activation-contracts.js";
import type { VerifiedScaActivationAdmissionViewV1 } from "./qualification-activation.js";

const SCHEMA_VERSION = 2;
const DATABASE_NAME = "sca-activation-owner.sqlite";
// Bound the host's replay window to at most five minutes; expiry is a separate limit.
const MAX_CONFIGURED_ADMISSION_AGE_MS = 300_000;
const DIGEST = /^[a-f0-9]{64}$/u;
const DDL = [
  `CREATE TABLE sca_activation_policy (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    issuer_policy_id TEXT NOT NULL, operator_principal_id TEXT NOT NULL,
    installation_authenticator_id TEXT NOT NULL,
    max_admission_age_ms INTEGER NOT NULL CHECK(max_admission_age_ms BETWEEN 1 AND 300000),
    generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 2147483647)
  ) STRICT`,
  `CREATE TABLE sca_activation_issuances (
    issuance_id TEXT PRIMARY KEY, authority_id TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL UNIQUE,
    record_json TEXT NOT NULL, ref_json TEXT NOT NULL, scope_json TEXT NOT NULL,
    authority_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('installed','consumed','revoked')),
    consumed_run_id TEXT, consumed_at TEXT, revoked_at TEXT,
    revocation_reason TEXT, revocation_evidence_sha256 TEXT,
    CHECK ((state='installed' AND consumed_run_id IS NULL AND consumed_at IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL AND revocation_evidence_sha256 IS NULL)
      OR (state='consumed' AND consumed_run_id IS NOT NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL AND revocation_reason IS NULL AND revocation_evidence_sha256 IS NULL)
      OR (state='revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL AND revocation_evidence_sha256 IS NOT NULL
        AND ((consumed_run_id IS NULL AND consumed_at IS NULL) OR (consumed_run_id IS NOT NULL AND consumed_at IS NOT NULL))))
  ) STRICT`,
] as const;

interface IssuanceRow {
  readonly issuance_id: string;
  readonly authority_id: string;
  readonly nonce: string;
  readonly record_json: string;
  readonly ref_json: string;
  readonly scope_json: string;
  readonly authority_sha256: string;
  readonly state: "installed" | "consumed" | "revoked";
  readonly consumed_run_id: string | null;
  readonly consumed_at: string | null;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
  readonly revocation_evidence_sha256: string | null;
}

export interface ScaActivationIssuanceInstallationV1 {
  readonly authority: ScaActivationAuthorityV1;
  readonly record: ScaActivationIssuanceV1;
  readonly ref: ArtifactRef;
}

/** Exact, structurally validated installation operands presented to the host's independent ledger. */
export interface ScaActivationInstallationAuthenticationV1 {
  readonly authority: ScaActivationAuthorityV1;
  readonly record: ScaActivationIssuanceV1;
  readonly ref: ArtifactRef;
  readonly scope: ScaActivationScopeV1;
}

/** A host-owned verifier and a lock shared with grant/key revocation. Test doubles are not production authenticators. */
export interface ScaActivationInstallationAuthenticator {
  readonly authenticator_id: string;
  withLock<T>(operation: () => T): T;
  authenticate(operands: ScaActivationInstallationAuthenticationV1): boolean;
}

export interface ScaActivationOwnerOptions {
  readonly directory: string;
  readonly issuer_policy_id: string;
  readonly operator_principal_id: string;
  readonly revocation_generation: number;
  readonly installation_authenticator_id: string;
  readonly installation_authenticator: ScaActivationInstallationAuthenticator;
  readonly max_admission_age_ms: number;
  readonly now?: () => number;
}

export interface ScaActivationConsumptionReceiptV1 {
  readonly schema_version: 1;
  readonly receipt_id: string;
  readonly decision: "consumed" | "resumed";
  readonly authority_id: string;
  readonly run_id: string;
  readonly admitted_at: string;
}

export interface ScaActivationRevocationReceiptV1 {
  readonly schema_version: 1;
  readonly authority_id: string;
  readonly reason: string;
  readonly evidence_sha256: string;
  readonly revoked_at: string;
}

function isSqlRow(value: unknown): value is Record<string, SQLOutputValue> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (v) => v === null || typeof v === "string" || typeof v === "number" || v instanceof Uint8Array
    )
  );
}
function sqlRow(value: unknown): Record<string, SQLOutputValue> {
  if (!isSqlRow(value)) throw new Error("SCA activation row missing or malformed");
  return value;
}

function text(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`SCA activation row ${key} malformed`);
  return value;
}
function optionalText(row: Record<string, SQLOutputValue>, key: string): string | null {
  if (row[key] === null) return null;
  return text(row, key);
}
function opaque(value: string, label: string): void {
  validateSkillSchema(OpaqueIdSchema, value, label);
  assertOpaqueId(value, label);
}
function digest(value: string): void {
  if (!DIGEST.test(value)) throw new Error("SCA activation digest malformed");
}
function generation(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647)
    throw new Error("SCA activation generation malformed");
}
function admissionAge(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONFIGURED_ADMISSION_AGE_MS)
    throw new Error("SCA activation max admission age malformed");
}
function canonical(value: unknown): string {
  return canonicalJson(value);
}
function parseJson(textValue: string): unknown {
  const value: unknown = JSON.parse(textValue);
  if (canonical(value) !== textValue)
    throw new Error("SCA activation stored JSON is not canonical");
  return value;
}
function rowFrom(value: unknown): IssuanceRow {
  const raw = sqlRow(value);
  const state = text(raw, "state");
  if (state !== "installed" && state !== "consumed" && state !== "revoked")
    throw new Error("SCA activation state malformed");
  const row: IssuanceRow = {
    issuance_id: text(raw, "issuance_id"),
    authority_id: text(raw, "authority_id"),
    nonce: text(raw, "nonce"),
    record_json: text(raw, "record_json"),
    ref_json: text(raw, "ref_json"),
    scope_json: text(raw, "scope_json"),
    authority_sha256: text(raw, "authority_sha256"),
    state,
    consumed_run_id: optionalText(raw, "consumed_run_id"),
    consumed_at: optionalText(raw, "consumed_at"),
    revoked_at: optionalText(raw, "revoked_at"),
    revocation_reason: optionalText(raw, "revocation_reason"),
    revocation_evidence_sha256: optionalText(raw, "revocation_evidence_sha256"),
  };
  const record = validateScaActivationIssuanceV1(parseJson(row.record_json));
  const scope = validateScaActivationAuthorityV1({
    schema_id: "penny.sca-activation-authority.v1",
    schema_version: 1,
    scope: parseJson(row.scope_json),
    issuance_record_ref: parseJson(row.ref_json),
    authority_sha256: row.authority_sha256,
  });
  const ref = currentArtifactRef(scope.issuance_record_ref);
  if (
    row.issuance_id !== record.issuance_id ||
    row.authority_id !== record.authority_id ||
    row.nonce !== scope.scope.nonce ||
    record.scope_sha256 !== sha256(row.scope_json) ||
    record.authority_id !== scope.scope.authority_id ||
    record.operator_principal_id !== scope.scope.operator_principal_id ||
    record.issuer_policy_id !== scope.scope.issuer_policy_id ||
    record.issued_at !== scope.scope.issued_at ||
    ref.run_id !== scope.scope.activation_run_id ||
    ref.content_digest !== sha256(row.record_json) ||
    ref.byte_length !== Buffer.byteLength(row.record_json, "utf8")
  )
    throw new Error("SCA activation issuance custody mismatch");
  digest(row.authority_sha256);
  opaque(row.issuance_id, "stored issuance ID");
  opaque(row.authority_id, "stored authority ID");
  opaque(row.nonce, "stored nonce");
  if (row.consumed_run_id !== null) {
    opaque(row.consumed_run_id, "consumed run");
    if (row.consumed_run_id !== scope.scope.activation_run_id)
      throw new Error("SCA activation consumed run custody mismatch");
  }
  if (row.revocation_reason !== null) opaque(row.revocation_reason, "revocation reason");
  if (row.consumed_at !== null) assertRfc3339Utc(row.consumed_at, "consumed time");
  if (row.revoked_at !== null) assertRfc3339Utc(row.revoked_at, "revoked time");
  if (row.revocation_evidence_sha256 !== null) digest(row.revocation_evidence_sha256);
  if (
    (row.state === "installed" && (row.consumed_run_id !== null || row.revoked_at !== null)) ||
    (row.state === "consumed" &&
      (row.consumed_run_id === null || row.consumed_at === null || row.revoked_at !== null)) ||
    (row.state === "revoked" &&
      (row.revoked_at === null ||
        row.revocation_reason === null ||
        row.revocation_evidence_sha256 === null))
  )
    throw new Error("SCA activation state custody mismatch");
  return row;
}

function operands(
  input: ScaActivationIssuanceInstallationV1
): ScaActivationInstallationAuthenticationV1 {
  const authority = validateScaActivationAuthorityV1(input.authority);
  const record = validateScaActivationIssuanceV1(input.record);
  const scope = authority.scope;
  const ref = currentArtifactRef(input.ref);
  if (
    canonical(ref) !== canonical(currentArtifactRef(authority.issuance_record_ref)) ||
    ref.content_digest !== sha256(canonical(record)) ||
    ref.byte_length !== Buffer.byteLength(canonical(record), "utf8") ||
    ref.run_id !== scope.activation_run_id ||
    record.scope_sha256 !== sha256(canonical(scope)) ||
    record.authority_id !== scope.authority_id ||
    record.issuer_policy_id !== scope.issuer_policy_id ||
    record.operator_principal_id !== scope.operator_principal_id ||
    record.issued_at !== scope.issued_at
  )
    throw new Error("SCA activation installation operands conflict");
  return { authority, record, scope, ref };
}

/** Host-only ledger. Supply the host-key installation verifier, not a permissive test double.
 * A stable authenticator ID binds the host policy across restarts; it is not itself a grant.
 * The host-key verifier proves custody by the host UID, not independent human approval.
 * Future effectful starts MUST re-run SCA-02 immediately before consuming here.
 * The returned receipt is not continuing authority and this owner never dispatches. */
export class SqliteScaActivationOwner implements Disposable {
  private readonly store: OwnerSqliteDatabase;
  private readonly policyId: string;
  private readonly principalId: string;
  private readonly generation: number;
  private readonly authenticatorId: string;
  private readonly authenticator: ScaActivationInstallationAuthenticator;
  private readonly maxAdmissionAgeMs: number;
  private readonly now: () => number;
  private closed = false;

  constructor(input: ScaActivationOwnerOptions) {
    opaque(input.issuer_policy_id, "issuer policy");
    opaque(input.operator_principal_id, "operator principal");
    opaque(input.installation_authenticator_id, "installation authenticator");
    if (
      input.installation_authenticator?.authenticator_id !== input.installation_authenticator_id ||
      typeof input.installation_authenticator.withLock !== "function" ||
      typeof input.installation_authenticator.authenticate !== "function"
    )
      throw new Error("SCA activation installation authenticator missing");
    admissionAge(input.max_admission_age_ms);
    generation(input.revocation_generation);
    this.policyId = input.issuer_policy_id;
    this.principalId = input.operator_principal_id;
    this.authenticatorId = input.installation_authenticator_id;
    this.authenticator = input.installation_authenticator;
    this.maxAdmissionAgeMs = input.max_admission_age_ms;
    this.generation = input.revocation_generation;
    this.now = input.now ?? Date.now;
    this.store = new OwnerSqliteDatabase({
      directory: input.directory,
      databaseName: DATABASE_NAME,
      label: "Penny SCA activation owner",
    });
    try {
      this.store.transaction(() => {
        const version = this.version();
        if (version === 0) {
          const existing = this.store.db
            .prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
            .all();
          if (existing.length !== 0) throw new Error("SCA activation unversioned schema");
          for (const statement of DDL) this.store.db.exec(statement);
          this.store.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
          this.store.db
            .prepare("INSERT INTO sca_activation_policy VALUES (1, ?, ?, ?, ?, ?)")
            .run(
              this.policyId,
              this.principalId,
              this.authenticatorId,
              this.maxAdmissionAgeMs,
              this.generation
            );
        }
        this.assertSchema();
        const policy = sqlRow(
          this.store.db.prepare("SELECT * FROM sca_activation_policy WHERE singleton=1").get()
        );
        if (
          text(policy, "issuer_policy_id") !== this.policyId ||
          text(policy, "operator_principal_id") !== this.principalId ||
          text(policy, "installation_authenticator_id") !== this.authenticatorId ||
          policy["max_admission_age_ms"] !== this.maxAdmissionAgeMs
        )
          throw new Error("SCA activation host policy conflict");
        const stored = policy["generation"];
        if (typeof stored !== "number" || !Number.isInteger(stored) || stored > this.generation)
          throw new Error("SCA activation stale generation");
        if (stored < this.generation)
          this.store.db
            .prepare("UPDATE sca_activation_policy SET generation=? WHERE singleton=1")
            .run(this.generation);
      });
    } catch (error) {
      this.store.close();
      this.closed = true;
      throw error;
    }
  }

  /** Exact adoption only. A consumed or revoked identity can never be installed again. */
  install(input: ScaActivationIssuanceInstallationV1): void {
    const value = operands(input);
    if (
      value.scope.issuer_policy_id !== this.policyId ||
      value.scope.operator_principal_id !== this.principalId ||
      value.scope.revocation_generation !== this.generation
    )
      throw new Error("SCA activation issuer policy conflict");
    this.authenticator.withLock(() =>
      this.store.transaction(() => {
        this.assertCurrentGeneration();
        const authenticatedOperands = canonical(value);
        if (
          this.authenticator.authenticate(value) !== true ||
          canonical(value) !== authenticatedOperands
        )
          throw new Error("SCA activation installation authentication denied");
        const existing = this.rowBy("issuance_id", value.record.issuance_id);
        if (existing !== undefined) {
          if (
            existing.record_json !== canonical(value.record) ||
            existing.ref_json !== canonical(value.ref) ||
            existing.scope_json !== canonical(value.scope) ||
            existing.authority_sha256 !== value.authority.authority_sha256 ||
            existing.state !== "installed"
          )
            throw new Error("SCA activation issuance conflict or cannot be rearmed");
          return;
        }
        if (
          this.rowBy("authority_id", value.scope.authority_id) !== undefined ||
          this.rowBy("nonce", value.scope.nonce) !== undefined
        )
          throw new Error("SCA activation authority or nonce already used");
        this.store.db
          .prepare(
            `INSERT INTO sca_activation_issuances
        (issuance_id,authority_id,nonce,record_json,ref_json,scope_json,authority_sha256,state)
        VALUES (?,?,?,?,?,?,?,'installed')`
          )
          .run(
            value.record.issuance_id,
            value.scope.authority_id,
            value.scope.nonce,
            canonical(value.record),
            canonical(value.ref),
            canonical(value.scope),
            value.authority.authority_sha256
          );
      })
    );
  }

  /** ScaActivationHostV1.verifyIssuance boundary; every mismatch denies, including stale instances. */
  verifyIssuance(input: {
    readonly record: ScaActivationIssuanceV1;
    readonly ref: ArtifactRef;
    readonly scope: ScaActivationScopeV1;
    readonly policy_id: string;
  }): boolean {
    try {
      return this.authenticator.withLock(() => {
        this.store.assertCustody();
        this.assertCurrentGeneration();
        const row = this.rowBy("issuance_id", input.record.issuance_id);
        if (
          row === undefined ||
          row.state === "revoked" ||
          row.record_json !== canonical(validateScaActivationIssuanceV1(input.record)) ||
          row.ref_json !== canonical(currentArtifactRef(input.ref)) ||
          row.scope_json !== canonical(input.scope) ||
          input.policy_id !== this.policyId ||
          input.record.issuer_policy_id !== this.policyId ||
          input.record.operator_principal_id !== this.principalId ||
          input.scope.operator_principal_id !== this.principalId ||
          input.scope.revocation_generation !== this.generation ||
          (row.state === "consumed" && row.consumed_run_id !== input.scope.activation_run_id)
        )
          return false;
        const authority = validateScaActivationAuthorityV1({
          schema_id: "penny.sca-activation-authority.v1",
          schema_version: 1,
          scope: parseJson(row.scope_json),
          issuance_record_ref: parseJson(row.ref_json),
          authority_sha256: row.authority_sha256,
        });
        if (
          this.authenticator.authenticate({
            authority,
            record: input.record,
            ref: input.ref,
            scope: input.scope,
          }) !== true
        )
          return false;
        const now = this.now();
        return (
          Number.isFinite(now) &&
          Date.parse(input.record.issued_at) <= now &&
          Date.parse(input.scope.not_before) <= now &&
          now < Date.parse(input.scope.expires_at)
        );
      });
    } catch {
      return false;
    }
  }

  /** A view is evidence, not a grant. Caller must have freshly run SCA-02 on the same host. */
  consume(view: VerifiedScaActivationAdmissionViewV1): ScaActivationConsumptionReceiptV1 {
    return this.authenticator.withLock(() =>
      this.store.transaction(() => {
        this.assertCurrentGeneration();
        const row = this.rowBy("authority_id", view.authority_id);
        if (row === undefined || row.state === "revoked")
          throw new Error("SCA activation authority denied");
        const scope = validateScaActivationAuthorityV1({
          schema_id: "penny.sca-activation-authority.v1",
          schema_version: 1,
          scope: parseJson(row.scope_json),
          issuance_record_ref: parseJson(row.ref_json),
          authority_sha256: row.authority_sha256,
        }).scope;
        const record = validateScaActivationIssuanceV1(parseJson(row.record_json));
        if (
          this.authenticator.authenticate({
            authority: validateScaActivationAuthorityV1({
              schema_id: "penny.sca-activation-authority.v1",
              schema_version: 1,
              scope,
              issuance_record_ref: parseJson(row.ref_json),
              authority_sha256: row.authority_sha256,
            }),
            record,
            ref: currentArtifactRef(parseJson(row.ref_json)),
            scope,
          }) !== true
        )
          throw new Error("SCA activation installation authentication denied");
        const now = this.now();
        assertRfc3339Utc(view.checked_at, "activation checked_at");
        if (
          !Number.isFinite(now) ||
          Date.parse(view.checked_at) > now ||
          now - Date.parse(view.checked_at) > this.maxAdmissionAgeMs ||
          Date.parse(record.issued_at) > now ||
          Date.parse(scope.not_before) > now ||
          now >= Date.parse(scope.expires_at) ||
          scope.revocation_generation !== this.generation ||
          scope.issuer_policy_id !== this.policyId ||
          scope.operator_principal_id !== this.principalId
        )
          throw new Error("SCA activation stale admission");
        const expected: VerifiedScaActivationAdmissionViewV1 = {
          authority_id: scope.authority_id,
          authority_sha256: row.authority_sha256,
          issuance_sha256: record.issuance_sha256,
          tenant_id: scope.tenant_id,
          project_id: scope.project_id,
          phase_id: scope.phase_id,
          production_playbook_name: scope.production_playbook_name,
          qualification_run_id: scope.qualification_run_id,
          activation_run_id: scope.activation_run_id,
          qualification_artifact_content_sha256: scope.qualification_ref.content_digest,
          gate_artifact_content_sha256: scope.gate_ref.content_digest,
          implementation_identity_artifact_content_sha256:
            scope.implementation_identity_ref.content_digest,
          qualification_policy_data_sha256: scope.qualification_policy_data_sha256,
          registration_contract_sha256: scope.registration_contract_sha256,
          runtime_registration_sha256: scope.runtime_registration_sha256,
          host_implementation_binding_sha256: scope.host_implementation_binding_sha256,
          proposed_start_sha256: scope.proposed_start_sha256,
          revocation_generation: scope.revocation_generation,
          checked_at: view.checked_at,
          expires_at: scope.expires_at,
        };
        if (
          canonical(view) !== canonical(expected) ||
          (row.state === "consumed" && row.consumed_run_id !== view.activation_run_id)
        )
          throw new Error("SCA activation immutable operands conflict");
        const admittedAt = row.consumed_at ?? new Date(now).toISOString();
        if (row.state === "installed") {
          const change = this.store.db
            .prepare(
              `UPDATE sca_activation_issuances SET state='consumed',
          consumed_run_id=?,consumed_at=? WHERE issuance_id=? AND state='installed'`
            )
            .run(view.activation_run_id, admittedAt, row.issuance_id);
          if (Number(change.changes) !== 1) throw new Error("SCA activation consumption CAS lost");
        }
        return {
          schema_version: 1,
          receipt_id: `scac_${sha256(
            canonical({
              authority_id: row.authority_id,
              issuance_id: row.issuance_id,
              run_id: view.activation_run_id,
              proposed_start_sha256: scope.proposed_start_sha256,
            })
          )}`,
          decision: row.state === "installed" ? "consumed" : "resumed",
          authority_id: row.authority_id,
          run_id: view.activation_run_id,
          admitted_at: admittedAt,
        };
      })
    );
  }

  revoke(input: {
    readonly authority_id: string;
    readonly reason: string;
    readonly evidence_sha256: string;
  }): ScaActivationRevocationReceiptV1 {
    opaque(input.authority_id, "revocation authority");
    opaque(input.reason, "revocation reason code");
    digest(input.evidence_sha256);
    return this.store.transaction(() => {
      this.assertCurrentGeneration();
      const row = this.rowBy("authority_id", input.authority_id);
      if (row === undefined) throw new Error("SCA activation authority absent");
      if (
        row.state === "revoked" &&
        (row.revocation_reason !== input.reason ||
          row.revocation_evidence_sha256 !== input.evidence_sha256)
      )
        throw new Error("SCA activation revocation conflict");
      const revokedAt = row.revoked_at ?? new Date(this.now()).toISOString();
      if (row.state !== "revoked") {
        const change = this.store.db
          .prepare(
            `UPDATE sca_activation_issuances SET state='revoked',
          revoked_at=?,revocation_reason=?,revocation_evidence_sha256=? WHERE authority_id=? AND state=?`
          )
          .run(revokedAt, input.reason, input.evidence_sha256, input.authority_id, row.state);
        if (Number(change.changes) !== 1) throw new Error("SCA activation revocation CAS lost");
      }
      return {
        schema_version: 1,
        authority_id: input.authority_id,
        reason: input.reason,
        evidence_sha256: input.evidence_sha256,
        revoked_at: revokedAt,
      };
    });
  }

  close(): void {
    if (!this.closed) {
      this.store.close();
      this.closed = true;
    }
  }
  [Symbol.dispose](): void {
    this.close();
  }

  private version(): number {
    const value = sqlRow(this.store.db.prepare("PRAGMA user_version").get())["user_version"];
    if (typeof value !== "number" || !Number.isInteger(value))
      throw new Error("SCA activation schema malformed");
    return value;
  }
  private assertSchema(): void {
    this.store.assertCustody();
    if (this.version() !== SCHEMA_VERSION) throw new Error("SCA activation incompatible schema");
    const objects = this.store.db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name"
      )
      .all();
    const expected = ["sca_activation_issuances", "sca_activation_policy"];
    if (
      objects.length !== expected.length ||
      objects.some((object, index) => {
        const row = sqlRow(object);
        const ddl = DDL.find((item) => item.startsWith(`CREATE TABLE ${expected[index] ?? ""} (`));
        return (
          text(row, "type") !== "table" ||
          text(row, "name") !== expected[index] ||
          text(row, "sql") !== ddl
        );
      })
    )
      throw new Error("SCA activation schema layout mismatch");
  }
  private assertCurrentGeneration(): void {
    this.assertSchema();
    const row = sqlRow(
      this.store.db.prepare("SELECT * FROM sca_activation_policy WHERE singleton=1").get()
    );
    if (
      text(row, "issuer_policy_id") !== this.policyId ||
      text(row, "operator_principal_id") !== this.principalId ||
      text(row, "installation_authenticator_id") !== this.authenticatorId ||
      row["max_admission_age_ms"] !== this.maxAdmissionAgeMs ||
      row["generation"] !== this.generation ||
      this.store.db.prepare("SELECT count(*) AS n FROM sca_activation_policy").get()?.["n"] !== 1
    )
      throw new Error("SCA activation host generation or policy changed");
  }
  private rowBy(
    field: "issuance_id" | "authority_id" | "nonce",
    value: string
  ): IssuanceRow | undefined {
    const found = this.store.db
      .prepare(`SELECT * FROM sca_activation_issuances WHERE ${field}=?`)
      .get(value);
    return found === undefined ? undefined : rowFrom(found);
  }
}
