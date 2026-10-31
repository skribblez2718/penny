import type { SQLOutputValue } from "node:sqlite";

import { canonicalJson, sha256 } from "../canonical-json.js";
import type { JsonValue } from "../contracts.js";
import { OwnerSqliteDatabase } from "../state/owner-sqlite.js";
import { assertOpaqueId } from "../skill-contracts/common.js";
import { parseImagegenRequestIntent } from "../skill-contracts/imagegen.js";

const ACTIVATION_SCHEMA_VERSION = 1 as const;
const ACTIVATION_DATABASE_NAME = "imagegen-activation.sqlite";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type ImagegenActivationModeV1 = "disabled" | "canary" | "enabled";
export type ImagegenActivationOutcomeV1 = "completed" | "failed" | "cancelled" | "timed_out";
export type ImagegenActivationDecisionV1 =
  | "admitted_canary"
  | "admitted_canary_resumed"
  | "admitted_ordinary";

export interface ImagegenActivationCanaryDeclarationV1 {
  /** Opaque host capability identifier. It is never presented by a caller or a model. */
  readonly canary_id: string;
  /** Digest of the exact canonical request intent the capability authorizes. */
  readonly request_sha256: string;
  /** Digest of the approved profile the capability authorizes. */
  readonly profile_sha256: string;
}

export interface ImagegenActivationAdmissionInputV1 {
  /** The caller's preallocated run identity; consumption binds the capability to it. */
  readonly run_id: string;
  readonly request_sha256: string;
  readonly profile_sha256: string;
}

export interface ImagegenActivationAdmissionReceiptV1 {
  readonly schema_version: 1;
  readonly receipt_id: string;
  readonly decision: ImagegenActivationDecisionV1;
  readonly mode: ImagegenActivationModeV1;
  readonly run_id: string;
  readonly request_sha256: string;
  readonly profile_sha256: string;
  readonly canary_id: string | null;
  readonly admitted_at: string;
}

export interface ImagegenActivationCleanupReceiptV1 {
  readonly schema_version: 1;
  readonly cleanup_id: string;
  readonly canary_id: string;
  readonly run_id: string;
  readonly outcome: ImagegenActivationOutcomeV1;
  readonly revoked_at: string;
}

export interface ImagegenActivationStatusV1 {
  readonly schema_version: 1;
  readonly mode: ImagegenActivationModeV1;
  readonly canary: {
    readonly canary_id: string;
    readonly request_sha256: string;
    readonly profile_sha256: string;
    readonly state: "installed" | "consumed";
    readonly run_id: string | null;
    readonly consumed_at: string | null;
  } | null;
}

/**
 * A start-denial raised by the activation authority. Every code is a fail-closed denial, never a
 * silent downgrade: absence, drift, replay, and the closed disabled mode all refuse.
 */
export class ImagegenActivationDeniedError extends Error {
  readonly code:
    | "mode_disabled"
    | "canary_absent"
    | "canary_request_drift"
    | "canary_profile_drift"
    | "canary_replay";

  constructor(code: ImagegenActivationDeniedError["code"], message: string) {
    super(message);
    this.name = "ImagegenActivationDeniedError";
    this.code = code;
  }
}

export interface ImagegenActivationController {
  readonly mode: ImagegenActivationModeV1;
  status(): ImagegenActivationStatusV1;
  /** Admit or deny a new imagegen start. Denial throws; ordinary starts never consume anything. */
  admit(input: ImagegenActivationAdmissionInputV1): ImagegenActivationAdmissionReceiptV1;
  /**
   * Fail-closed cleanup after a terminal run. A run that consumed no capability is a no-op; a
   * conflicting or ambiguous durable record throws rather than re-arming or silently forgiving.
   */
  finalizeRun(input: {
    readonly run_id: string;
    readonly outcome: ImagegenActivationOutcomeV1;
  }): ImagegenActivationCleanupReceiptV1 | undefined;
}

interface CanaryRow extends Record<string, SQLOutputValue> {
  canary_id: string;
  request_sha256: string;
  profile_sha256: string;
  state: "installed" | "consumed" | "revoked";
  run_id: string | null;
  disposition: string | null;
  installed_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

function isSqliteRow(value: unknown): value is Record<string, SQLOutputValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) =>
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      item instanceof Uint8Array
  );
}

function rowText(
  row: Record<string, SQLOutputValue>,
  key: string,
  nullable = false
): string | null {
  const value = row[key];
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error(`imagegen activation row '${key}' is not text`);
  return value;
}

function parseCanaryRow(value: unknown): CanaryRow {
  if (!isSqliteRow(value)) throw new Error("imagegen activation canary row is malformed");
  const state = rowText(value, "state");
  if (state !== "installed" && state !== "consumed" && state !== "revoked") {
    throw new Error("imagegen activation canary state is invalid");
  }
  const row: CanaryRow = {
    canary_id: rowText(value, "canary_id") ?? "",
    request_sha256: rowText(value, "request_sha256") ?? "",
    profile_sha256: rowText(value, "profile_sha256") ?? "",
    state,
    run_id: rowText(value, "run_id", true),
    disposition: rowText(value, "disposition", true),
    installed_at: rowText(value, "installed_at") ?? "",
    consumed_at: rowText(value, "consumed_at", true),
    revoked_at: rowText(value, "revoked_at", true),
  };
  for (const digest of [row.request_sha256, row.profile_sha256]) {
    if (!SHA256_PATTERN.test(digest)) {
      throw new Error("imagegen activation canary digest is invalid");
    }
  }
  if (row.state === "installed" && (row.run_id !== null || row.consumed_at !== null)) {
    throw new Error("imagegen activation canary custody is ambiguous");
  }
  if (row.state === "consumed" && (row.run_id === null || row.consumed_at === null)) {
    throw new Error("imagegen activation canary custody is ambiguous");
  }
  return row;
}

function assertDigest(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} digest is invalid`);
  return value;
}

function assertMode(value: string): ImagegenActivationModeV1 {
  if (value !== "disabled" && value !== "canary" && value !== "enabled") {
    throw new Error("imagegen activation mode is invalid");
  }
  return value;
}

function assertOutcome(value: string): ImagegenActivationOutcomeV1 {
  if (
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled" &&
    value !== "timed_out"
  ) {
    throw new Error("imagegen activation cleanup outcome is invalid");
  }
  return value;
}

function admissionReceiptId(input: {
  readonly mode: ImagegenActivationModeV1;
  readonly run_id: string;
  readonly request_sha256: string;
  readonly profile_sha256: string;
  readonly canary_id: string | null;
}): string {
  return `imga_${sha256(
    canonicalJson({
      schema_version: 1,
      mode: input.mode,
      run_id: input.run_id,
      request_sha256: input.request_sha256,
      profile_sha256: input.profile_sha256,
      canary_id: input.canary_id,
    })
  )}`;
}

/**
 * Digest an imagegen start's canonical request intent for canary binding.
 *
 * The digest deliberately covers the canonicalized goal and constraints only — never the
 * host-selected seed or the created run identity. That keeps it exactly reproducible by an
 * operator before a run exists, which is what makes a one-shot capability pre-bindable.
 */
export function imagegenActivationRequestSha256(input: {
  readonly goal: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
}): string {
  const intent = parseImagegenRequestIntent(input);
  return sha256(canonicalJson({ schema_version: 1, intent }));
}

/**
 * Durable, host-owned activation authority for imagegen starts.
 *
 * The closed mode set is `disabled`, `canary`, and `enabled`. Disabled denies every new start
 * while the registration stays available for status, cancel, and recovery of existing runs.
 * Canary admits exactly one request/profile-bound start, consumes the capability atomically, and
 * binds it to the caller's preallocated run id; every ordinary start remains denied. Enabled
 * admits ordinary starts. Absence, digest drift, replay, custody failure, and cleanup ambiguity
 * all fail closed. The controller never holds a caller-visible secret, path, or profile.
 */
export class SqliteImagegenActivationController
  implements ImagegenActivationController, Disposable
{
  readonly mode: ImagegenActivationModeV1;
  private readonly store: OwnerSqliteDatabase;
  private readonly now: () => number;
  private closed = false;

  constructor(input: {
    readonly directory: string;
    readonly mode: ImagegenActivationModeV1;
    readonly canary?: ImagegenActivationCanaryDeclarationV1;
    readonly now?: () => number;
  }) {
    this.mode = assertMode(input.mode);
    this.now = input.now ?? Date.now;
    this.store = new OwnerSqliteDatabase({
      directory: input.directory,
      databaseName: ACTIVATION_DATABASE_NAME,
      label: "Penny imagegen activation authority",
    });
    try {
      this.provisionSchema();
      this.reconcile(input.canary);
      this.assertSchema();
    } catch (error) {
      this.store.close();
      this.closed = true;
      throw error;
    }
  }

  status(): ImagegenActivationStatusV1 {
    this.store.assertCustody();
    const active = this.activeCanaryRow();
    return {
      schema_version: 1,
      mode: this.durableMode(),
      canary:
        active === undefined
          ? null
          : {
              canary_id: active.canary_id,
              request_sha256: active.request_sha256,
              profile_sha256: active.profile_sha256,
              state: active.state === "installed" ? "installed" : "consumed",
              run_id: active.run_id,
              consumed_at: active.consumed_at,
            },
    };
  }

  admit(input: ImagegenActivationAdmissionInputV1): ImagegenActivationAdmissionReceiptV1 {
    assertOpaqueId(input.run_id, "imagegen activation run_id");
    assertDigest(input.request_sha256, "imagegen activation request");
    assertDigest(input.profile_sha256, "imagegen activation profile");
    return this.store.transaction(() => {
      const mode = this.durableMode();
      if (mode === "disabled") {
        throw new ImagegenActivationDeniedError(
          "mode_disabled",
          "imagegen activation mode 'disabled' denies every new start"
        );
      }
      if (mode === "enabled") return this.ordinaryReceipt(input);
      const active = this.activeCanaryRow();
      if (active === undefined) {
        throw new ImagegenActivationDeniedError(
          "canary_absent",
          "imagegen canary mode has no installed canary capability"
        );
      }
      if (active.request_sha256 !== input.request_sha256) {
        throw new ImagegenActivationDeniedError(
          "canary_request_drift",
          "imagegen canary capability is bound to a different request digest"
        );
      }
      if (active.profile_sha256 !== input.profile_sha256) {
        throw new ImagegenActivationDeniedError(
          "canary_profile_drift",
          "imagegen canary capability is bound to a different profile digest"
        );
      }
      if (active.state === "installed") {
        const admittedAt = new Date(this.now()).toISOString();
        const changed = this.store.db
          .prepare(
            `UPDATE imagegen_activation_canaries
             SET state = 'consumed', run_id = ?, consumed_at = ?
             WHERE canary_id = ? AND state = 'installed' AND run_id IS NULL`
          )
          .run(input.run_id, admittedAt, active.canary_id);
        if (Number(changed.changes) !== 1) {
          throw new Error("imagegen canary consumption lost its compare-and-set");
        }
        return this.canaryReceipt("admitted_canary", input, active.canary_id, admittedAt);
      }
      if (active.run_id !== input.run_id) {
        throw new ImagegenActivationDeniedError(
          "canary_replay",
          "imagegen canary capability was already consumed by a different run"
        );
      }
      if (active.consumed_at === null) {
        throw new Error("imagegen canary custody is ambiguous");
      }
      return this.canaryReceipt(
        "admitted_canary_resumed",
        input,
        active.canary_id,
        active.consumed_at
      );
    });
  }

  finalizeRun(input: {
    readonly run_id: string;
    readonly outcome: ImagegenActivationOutcomeV1;
  }): ImagegenActivationCleanupReceiptV1 | undefined {
    assertOpaqueId(input.run_id, "imagegen activation cleanup run_id");
    const outcome = assertOutcome(input.outcome);
    return this.store.transaction(() => {
      const row = this.canaryRowByRun(input.run_id);
      if (row === undefined) return undefined;
      if (row.state === "revoked") {
        if (row.disposition !== outcome) {
          throw new Error(
            "imagegen activation cleanup conflicts with the durable canary disposition"
          );
        }
        if (row.revoked_at === null) {
          throw new Error("imagegen activation cleanup custody is ambiguous");
        }
        return this.cleanupReceipt(row, outcome, row.revoked_at);
      }
      if (row.state !== "consumed" || row.consumed_at === null) {
        throw new Error("imagegen activation cleanup custody is ambiguous");
      }
      const revokedAt = new Date(this.now()).toISOString();
      const changed = this.store.db
        .prepare(
          `UPDATE imagegen_activation_canaries
           SET state = 'revoked', disposition = ?, revoked_at = ?
           WHERE canary_id = ? AND state = 'consumed'`
        )
        .run(outcome, revokedAt, row.canary_id);
      if (Number(changed.changes) !== 1) {
        throw new Error("imagegen activation cleanup lost its compare-and-set");
      }
      return this.cleanupReceipt(row, outcome, revokedAt);
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

  private ordinaryReceipt(
    input: ImagegenActivationAdmissionInputV1
  ): ImagegenActivationAdmissionReceiptV1 {
    return {
      schema_version: 1,
      receipt_id: admissionReceiptId({
        mode: "enabled",
        run_id: input.run_id,
        request_sha256: input.request_sha256,
        profile_sha256: input.profile_sha256,
        canary_id: null,
      }),
      decision: "admitted_ordinary",
      mode: "enabled",
      run_id: input.run_id,
      request_sha256: input.request_sha256,
      profile_sha256: input.profile_sha256,
      canary_id: null,
      admitted_at: new Date(this.now()).toISOString(),
    };
  }

  private canaryReceipt(
    decision: "admitted_canary" | "admitted_canary_resumed",
    input: ImagegenActivationAdmissionInputV1,
    canaryId: string,
    admittedAt: string
  ): ImagegenActivationAdmissionReceiptV1 {
    return {
      schema_version: 1,
      receipt_id: admissionReceiptId({
        mode: "canary",
        run_id: input.run_id,
        request_sha256: input.request_sha256,
        profile_sha256: input.profile_sha256,
        canary_id: canaryId,
      }),
      decision,
      mode: "canary",
      run_id: input.run_id,
      request_sha256: input.request_sha256,
      profile_sha256: input.profile_sha256,
      canary_id: canaryId,
      admitted_at: admittedAt,
    };
  }

  private cleanupReceipt(
    row: CanaryRow,
    outcome: ImagegenActivationOutcomeV1,
    revokedAt: string
  ): ImagegenActivationCleanupReceiptV1 {
    if (row.run_id === null) throw new Error("imagegen activation cleanup custody is ambiguous");
    return {
      schema_version: 1,
      cleanup_id: `imgc_${sha256(
        canonicalJson({
          schema_version: 1,
          canary_id: row.canary_id,
          run_id: row.run_id,
          outcome,
        })
      )}`,
      canary_id: row.canary_id,
      run_id: row.run_id,
      outcome,
      revoked_at: revokedAt,
    };
  }

  private reconcile(canary: ImagegenActivationCanaryDeclarationV1 | undefined): void {
    this.store.transaction(() => {
      if (canary !== undefined) this.installCanaryRow(canary);
      const active = this.activeCanaryRow();
      if (this.mode === "enabled" && active !== undefined) {
        throw new Error(
          "imagegen activation cannot enable ordinary starts while a canary capability remains active"
        );
      }
      this.writeDurableMode(this.mode);
    });
  }

  private installCanaryRow(canary: ImagegenActivationCanaryDeclarationV1): void {
    assertOpaqueId(canary.canary_id, "imagegen canary_id");
    assertDigest(canary.request_sha256, "imagegen canary request");
    assertDigest(canary.profile_sha256, "imagegen canary profile");
    const existing = this.canaryRow(canary.canary_id);
    if (existing !== undefined) {
      if (
        existing.request_sha256 !== canary.request_sha256 ||
        existing.profile_sha256 !== canary.profile_sha256
      ) {
        throw new Error("imagegen canary capability declaration drifted from durable custody");
      }
      if (existing.state === "revoked") {
        throw new Error("imagegen canary capability was already consumed and cannot be re-armed");
      }
      return;
    }
    const active = this.activeCanaryRow();
    if (active !== undefined) {
      throw new Error(
        "imagegen activation already holds a different active canary capability; refusing to overwrite it"
      );
    }
    this.store.db
      .prepare(
        `INSERT INTO imagegen_activation_canaries(
           canary_id, request_sha256, profile_sha256, state, run_id, disposition,
           installed_at, consumed_at, revoked_at
         ) VALUES (?, ?, ?, 'installed', NULL, NULL, ?, NULL, NULL)`
      )
      .run(
        canary.canary_id,
        canary.request_sha256,
        canary.profile_sha256,
        new Date(this.now()).toISOString()
      );
  }

  private durableMode(): ImagegenActivationModeV1 {
    this.store.assertCustody();
    const row = this.store.db
      .prepare("SELECT mode FROM imagegen_activation_mode WHERE singleton = 1")
      .get();
    if (!isSqliteRow(row)) throw new Error("imagegen activation mode row is absent");
    const mode = rowText(row, "mode");
    if (mode === null) throw new Error("imagegen activation mode row is absent");
    return assertMode(mode);
  }

  private writeDurableMode(mode: ImagegenActivationModeV1): void {
    const existing = this.store.db
      .prepare("SELECT singleton FROM imagegen_activation_mode WHERE singleton = 1")
      .get();
    if (existing === undefined) {
      this.store.db
        .prepare(
          `INSERT INTO imagegen_activation_mode(singleton, mode, updated_at) VALUES (1, ?, ?)`
        )
        .run(mode, new Date(this.now()).toISOString());
      return;
    }
    this.store.db
      .prepare("UPDATE imagegen_activation_mode SET mode = ?, updated_at = ? WHERE singleton = 1")
      .run(mode, new Date(this.now()).toISOString());
  }

  private canaryRow(canaryId: string): CanaryRow | undefined {
    this.store.assertCustody();
    const value = this.store.db
      .prepare("SELECT * FROM imagegen_activation_canaries WHERE canary_id = ?")
      .get(canaryId);
    return value === undefined ? undefined : parseCanaryRow(value);
  }

  private activeCanaryRow(): CanaryRow | undefined {
    this.store.assertCustody();
    const value = this.store.db
      .prepare(
        "SELECT * FROM imagegen_activation_canaries WHERE state <> 'revoked' ORDER BY installed_at DESC, canary_id DESC LIMIT 1"
      )
      .get();
    return value === undefined ? undefined : parseCanaryRow(value);
  }

  private canaryRowByRun(runId: string): CanaryRow | undefined {
    this.store.assertCustody();
    const rows = this.store.db
      .prepare(
        "SELECT * FROM imagegen_activation_canaries WHERE run_id = ? ORDER BY installed_at DESC, canary_id DESC"
      )
      .all(runId);
    if (rows.length === 0) return undefined;
    if (rows.length > 1) throw new Error("imagegen activation canary custody is ambiguous");
    const value = rows[0];
    if (value === undefined) return undefined;
    return parseCanaryRow(value);
  }

  private provisionSchema(): void {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS imagegen_activation_mode (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        mode TEXT NOT NULL CHECK(mode IN ('disabled', 'canary', 'enabled')),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS imagegen_activation_canaries (
        canary_id TEXT PRIMARY KEY,
        request_sha256 TEXT NOT NULL,
        profile_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('installed', 'consumed', 'revoked')),
        run_id TEXT,
        disposition TEXT,
        installed_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT,
        CHECK (
          (state = 'installed' AND run_id IS NULL AND consumed_at IS NULL AND revoked_at IS NULL)
          OR (state = 'consumed' AND run_id IS NOT NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL)
          OR (state = 'revoked' AND run_id IS NOT NULL AND consumed_at IS NOT NULL AND revoked_at IS NOT NULL AND disposition IS NOT NULL)
        )
      ) STRICT;
      PRAGMA user_version=${ACTIVATION_SCHEMA_VERSION};
    `);
  }

  private assertSchema(): void {
    this.store.assertCustody();
    const version = this.store.db.prepare("PRAGMA user_version").get();
    if (
      !isSqliteRow(version) ||
      Number(version["user_version"] ?? 0) !== ACTIVATION_SCHEMA_VERSION
    ) {
      throw new Error(`imagegen activation authority requires schema ${ACTIVATION_SCHEMA_VERSION}`);
    }
  }
}
