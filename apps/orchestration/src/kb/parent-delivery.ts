/**
 * Parent-answer delivery grants (§5.1) — host-minted, single-use, owner-only.
 *
 * `answer_delivery: "parent_tool_result"` in a query request is a REQUEST, never
 * a grant boolean. Derived parent delivery is admit-eligible only when the host
 * invocation context carries exactly one unexpired `ParentDeliveryGrantV1`
 * whose session, invocation, action, profile, `request_sha256`
 * (= SHA-256(JCS(request))), and byte maximum all match the request exactly,
 * AND the profile policy permits `allow_explicit_derived_answer`. The byte
 * bound is the LESSER of the grant and policy maxima. Before emitting
 * `derived_answer`, the owner-only grant store atomically changes the grant
 * from `available` to `consumed` by the returned run; retries never redeliver.
 * Mismatch, reuse, or expiry returns `refused_parent_delivery` and retains only
 * the artifact result — it never silently returns content.
 *
 * This module owns the grant store and the pure eligibility decision. It does
 * not read or write any KB content plane, does not see private bodies, and
 * produces only bounded, content-free outcome codes. The adapter wiring
 * (host-context pairing) builds the `host` input from the authenticated Pi
 * session and this store — never from the request, a prompt, an environment
 * variable, or a tool result.
 */

import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";

import {
  DerivedQueryAnswerSchema,
  KbPolicySchema,
  QueryKbRequestSchema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
  validateKbHostInvocationContext,
  validateParentDeliveryGrant,
  validateParentDeliveryGrantFile,
  validateParentDeliveryGrantStoreRecord,
  type DerivedQueryAnswer,
  type KbHostInvocationContextV1,
  type KbPolicy,
  type KnowledgeBaseRequest,
  type ParentDeliveryGrant,
  type ParentDeliveryGrantFile,
  type ParentDeliveryGrantStoreRecord,
  type ParentDeliveryGrantState,
  type QueryKbRequest,
  type Rfc3339Utc,
  type Sha256Hex,
} from "./contracts.js";
import {
  HOST_GRANT_DATABASE_NAME,
  isUnsafeHostGrantFragment,
  OwnerSqliteDatabase,
} from "./owner-sqlite.js";
import {
  checkDerivedAnswerDelivery,
  checkParentModelIdentity,
  resolveParentModelRule,
} from "./policy.js";
import { assessQueryVerification } from "./query-verification.js";

// ── bounded, content-free outcome codes ──────────────────────────────────────

/**
 * The one public outcome the parent result carries on refusal. Deliberately a
 * single code: the parent never learns WHY — only that delivery was refused
 * and the artifact result is retained. The specific `reason_code` is host-side
 * metadata (grant store / logs), never a model-visible result field.
 */
export const REFUSED_PARENT_DELIVERY = "refused_parent_delivery";

/** Host-side reason codes (never emitted to the parent). Bounded set. */
export type ParentDeliveryReasonCode =
  | "grant_missing"
  | "grant_ambiguous"
  | "grant_malformed"
  | "grant_consumed"
  | "grant_invalidated"
  | "grant_expired"
  | "grant_mismatch_session"
  | "grant_mismatch_invocation"
  | "grant_mismatch_profile"
  | "grant_mismatch_action"
  | "grant_mismatch_request_digest"
  | "grant_mismatch_policy"
  | "grant_mismatch_parent_model"
  | "policy_denies"
  | "parent_identity_unknown"
  | "parent_model_not_allowed"
  | "grounding_unverified"
  | "answer_exceeds_byte_cap"
  | "answer_malformed";

export type ParentDeliveryEvaluation =
  | { status: "eligible"; byte_cap: number }
  | {
      status: "refused";
      public_code: typeof REFUSED_PARENT_DELIVERY;
      reason_code: ParentDeliveryReasonCode;
    };

// ── request canonicalization ─────────────────────────────────────────────────

/**
 * `request_sha256 = SHA-256(JCS(request))` over the CLOSED, validated request.
 * The grant binds the exact request the operator intended; a tampered request
 * yields a different digest and is refused.
 */
export function computeRequestSha256(request: QueryKbRequest): Sha256Hex {
  return sha256Hex(canonicalJson(request));
}

/**
 * Validate closed raw request bytes into `QueryKbRequest`. Throws
 * `KbContractError` on any open/malformed shape — a grant can never authorize
 * an invalid request.
 */
export function validateQueryRequest(raw: unknown): QueryKbRequest {
  return validateKbContract(QueryKbRequestSchema, raw, "query request");
}

/**
 * Mint an unconsumed grant from host-only inputs. `request` must be the exact
 * closed request the operator intends to run; the digest is bound to it.
 */
export function mintParentDeliveryGrant(input: {
  session_id: string;
  invocation_id: string;
  request: QueryKbRequest;
  policy_sha256: Sha256Hex;
  parent_provider: string;
  parent_model: string;
  max_utf8_bytes: number;
  issued_at: Rfc3339Utc;
  expires_at: Rfc3339Utc;
  grant_id?: string;
}): ParentDeliveryGrant {
  if (input.request.answer_delivery !== "parent_tool_result") {
    throw new Error("parent delivery grants require an explicit parent_tool_result request");
  }
  if (
    !Number.isInteger(input.max_utf8_bytes) ||
    input.max_utf8_bytes < 1 ||
    input.max_utf8_bytes > 32_768
  ) {
    throw new Error("max_utf8_bytes must be an integer 1–32,768");
  }
  const grant: ParentDeliveryGrant = {
    schema_version: 1,
    grant_id: input.grant_id ?? `pgt-${randomUUID()}`,
    session_id: input.session_id,
    invocation_id: input.invocation_id,
    action: "query",
    kb_profile_id: input.request.kb_profile_id,
    request_sha256: computeRequestSha256(input.request),
    policy_sha256: input.policy_sha256,
    parent_provider: input.parent_provider,
    parent_model: input.parent_model,
    max_utf8_bytes: input.max_utf8_bytes,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
  };
  return validateParentDeliveryGrant(grant);
}

// ── owner-only grant store ───────────────────────────────────────────────────

function parentGrantRecordDigest(record: ParentDeliveryGrantStoreRecord): Sha256Hex {
  return sha256Hex(canonicalJson(record));
}

function requiredText(row: Record<string, SQLOutputValue>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new Error(`grant database field '${field}' is malformed`);
  return value;
}

function optionalText(row: Record<string, SQLOutputValue>, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`grant database field '${field}' is malformed`);
  return value;
}

function parseJsonValue(source: string): unknown {
  const value: unknown = JSON.parse(source);
  return value;
}

const PARENT_GRANT_ROW_KEYS = [
  "grant_id",
  "grant_sha256",
  "grant_jcs",
  "session_id",
  "invocation_id",
  "kb_profile_id",
  "request_sha256",
  "policy_sha256",
  "parent_provider",
  "parent_model",
  "state",
  "run_id",
  "updated_at",
  "record_sha256",
] as const;

function assertExactGrantRow(row: Record<string, SQLOutputValue>): void {
  if (canonicalJson(Object.keys(row).sort()) !== canonicalJson([...PARENT_GRANT_ROW_KEYS].sort())) {
    throw new Error("parent-delivery grant row has unexpected or missing SQLite columns");
  }
}

const PARENT_GRANT_SELECT = PARENT_GRANT_ROW_KEYS.join(",");

/**
 * Safe listing projection: opaque IDs, state, timestamps, and digests only.
 * The request body and the grant's session/invocation pairing details that
 * would aid replay are not required here; `request_sha256` is a digest and is
 * safe to show the operator.
 */
export interface StoredGrantProjection {
  grant_id: string;
  state: ParentDeliveryGrantState;
  kb_profile_id: string;
  issued_at: Rfc3339Utc;
  expires_at: Rfc3339Utc;
  request_sha256: Sha256Hex;
  run_id?: string;
}

/**
 * Owner-only SQLite authority store under the existing ignored host root.
 * WAL + synchronous=FULL transactions provide the cross-process CAS boundary;
 * legacy JSON rows are never scanned or adopted and therefore fail closed.
 */
export class ParentDeliveryGrantStore implements Disposable {
  private readonly storage: OwnerSqliteDatabase;

  constructor(dir: string) {
    this.storage = new OwnerSqliteDatabase({
      directory: dir,
      databaseName: HOST_GRANT_DATABASE_NAME,
      label: "KB host-grant authority",
      isLegacyAuthorityFile: isUnsafeHostGrantFragment,
    });
    try {
      this.storage.db.exec(`
        CREATE TABLE IF NOT EXISTS parent_delivery_grants (
          grant_id TEXT PRIMARY KEY,
          grant_sha256 TEXT NOT NULL,
          grant_jcs TEXT NOT NULL,
          session_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL,
          kb_profile_id TEXT NOT NULL,
          request_sha256 TEXT NOT NULL,
          policy_sha256 TEXT NOT NULL,
          parent_provider TEXT NOT NULL,
          parent_model TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('available','consumed','invalidated','expired')),
          run_id TEXT,
          updated_at TEXT NOT NULL,
          record_sha256 TEXT NOT NULL,
          CHECK(
            (state = 'consumed' AND run_id IS NOT NULL) OR
            (state <> 'consumed' AND run_id IS NULL)
          )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_parent_grant_per_invocation
          ON parent_delivery_grants(session_id, invocation_id);
        CREATE INDEX IF NOT EXISTS parent_delivery_grant_match
          ON parent_delivery_grants(kb_profile_id, request_sha256);
      `);
    } catch (error) {
      // Older databases created before the denormalized match columns existed
      // are not silently rewritten. The CREATE above intentionally fails and
      // leaves authority closed rather than guessing a migration.
      this.storage.close();
      throw error;
    }
  }

  /** The owner-only store directory (host state; never a KB root). */
  get dir(): string {
    return this.storage.directory;
  }

  /** Store one newly minted grant; an exact retry is an idempotent observation. */
  mint(rawGrant: ParentDeliveryGrant): void {
    const grant = validateParentDeliveryGrant(rawGrant);
    const issuedAt = Date.parse(grant.issued_at);
    const expiresAt = Date.parse(grant.expires_at);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
      throw new Error("parent delivery grant has invalid timestamp semantics");
    }
    const grantJcs = canonicalJson(grant);
    const grantSha256 = sha256Hex(grantJcs);
    const record = validateParentDeliveryGrantStoreRecord({
      schema_version: 1,
      grant_id: grant.grant_id,
      grant_sha256: grantSha256,
      state: "available",
      updated_at: new Date().toISOString(),
    });
    const recordSha256 = parentGrantRecordDigest(record);

    this.storage.transaction(() => {
      const existing = this.row(grant.grant_id);
      if (existing !== undefined) {
        const file = this.fileFromRow(existing);
        if (file.record.grant_sha256 === grantSha256 && canonicalJson(file.grant) === grantJcs) {
          return;
        }
        throw new Error(`grant id already exists with different bytes: ${grant.grant_id}`);
      }
      this.storage.db
        .prepare(
          `INSERT INTO parent_delivery_grants (
             grant_id, grant_sha256, grant_jcs, state, run_id, updated_at, record_sha256,
             session_id, invocation_id, kb_profile_id, request_sha256, policy_sha256,
             parent_provider, parent_model
           ) VALUES (?, ?, ?, 'available', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          grant.grant_id,
          grantSha256,
          grantJcs,
          record.updated_at,
          recordSha256,
          grant.session_id,
          grant.invocation_id,
          grant.kb_profile_id,
          grant.request_sha256,
          grant.policy_sha256,
          grant.parent_provider,
          grant.parent_model
        );
    });
    const persisted = this.load(grant.grant_id);
    if (
      persisted.record.grant_sha256 !== grantSha256 ||
      canonicalJson(persisted.grant) !== grantJcs
    ) {
      throw new Error(`grant registration did not persist exact bytes: ${grant.grant_id}`);
    }
  }

  /** Load and fully validate one exact indexed grant row. */
  load(grantId: string): ParentDeliveryGrantFile {
    this.storage.assertCustody();
    const row = this.row(grantId);
    if (row === undefined) throw new Error(`grant is absent: ${grantId}`);
    return this.fileFromRow(row);
  }

  /**
   * Transactional CAS `available → consumed(run_id)`. An exact same-run retry
   * returns the committed row; another run or process loses.
   */
  consume(
    grantId: string,
    runId: string,
    expectedGrantSha256?: Sha256Hex
  ): ParentDeliveryGrantFile {
    if (runId.length === 0) throw new Error("grant consumption requires a run id");
    const outcome = this.storage.transaction(() => {
      const current = this.requireRow(grantId);
      if (
        expectedGrantSha256 !== undefined &&
        current.record.grant_sha256 !== expectedGrantSha256
      ) {
        throw new Error(`grant digest changed before consumption: ${grantId}`);
      }
      if (current.record.state === "consumed") {
        if (current.record.run_id === runId) return { file: current, expired: false };
        throw new Error(`grant was consumed by another run: ${grantId}`);
      }
      if (current.record.state === "expired") {
        return { file: current, expired: true };
      }
      if (current.record.state !== "available") {
        throw new Error(`grant is not available (state: ${current.record.state}): ${grantId}`);
      }
      if (Date.parse(current.grant.expires_at) <= Date.now()) {
        const expired = this.transition(current, "expired");
        return { file: expired, expired: true };
      }
      const consumed = this.transition(current, "consumed", runId);
      return { file: consumed, expired: false };
    });
    if (outcome.expired) throw new Error(`grant is expired: ${grantId}`);
    return outcome.file;
  }

  /** Host-side invalidation; exact retries are idempotent. */
  invalidate(grantId: string): ParentDeliveryGrantFile {
    return this.storage.transaction(() => {
      const current = this.requireRow(grantId);
      if (current.record.state === "invalidated") return current;
      if (current.record.state !== "available") {
        throw new Error(`grant is not available (state: ${current.record.state}): ${grantId}`);
      }
      return this.transition(current, "invalidated");
    });
  }

  /** Expire one exact available row once its immutable grant window closes. */
  expire(grantId: string, now = new Date()): ParentDeliveryGrantFile {
    if (!Number.isFinite(now.getTime())) throw new Error("grant expiry time is invalid");
    return this.storage.transaction(() => {
      const current = this.requireRow(grantId);
      if (current.record.state === "expired") return current;
      if (current.record.state !== "available") {
        throw new Error(`grant is not available (state: ${current.record.state}): ${grantId}`);
      }
      if (Date.parse(current.grant.expires_at) > now.getTime()) {
        throw new Error(`grant has not expired: ${grantId}`);
      }
      return this.transition(current, "expired");
    });
  }

  /** Safe operator projection; malformed SQL rows are counted, never authoritative. */
  list(): { grants: StoredGrantProjection[]; skipped_malformed: number } {
    this.storage.assertCustody();
    const rows = this.storage.db
      .prepare(`SELECT ${PARENT_GRANT_SELECT} FROM parent_delivery_grants ORDER BY grant_id`)
      .all() as Record<string, SQLOutputValue>[];
    return this.projectRows(rows);
  }

  /**
   * Exact indexed authority lookup used by delivery. It never discovers files
   * or chooses authority from an unbounded directory/list scan.
   */
  matching(
    profileId: string,
    requestSha256: Sha256Hex,
    sessionId: string,
    invocationId: string
  ): { grants: StoredGrantProjection[]; skipped_malformed: number } {
    this.storage.assertCustody();
    const rows = this.storage.db
      .prepare(
        `SELECT ${PARENT_GRANT_SELECT} FROM parent_delivery_grants
         WHERE kb_profile_id = ? AND request_sha256 = ?
           AND session_id = ? AND invocation_id = ?
         ORDER BY grant_id`
      )
      .all(profileId, requestSha256, sessionId, invocationId) as Record<string, SQLOutputValue>[];
    return this.projectRows(rows);
  }

  close(): void {
    this.storage.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private projectRows(rows: readonly Record<string, SQLOutputValue>[]): {
    grants: StoredGrantProjection[];
    skipped_malformed: number;
  } {
    const grants: StoredGrantProjection[] = [];
    let skippedMalformed = 0;
    for (const row of rows) {
      try {
        const doc = this.fileFromRow(row);
        grants.push({
          grant_id: doc.grant.grant_id,
          state: doc.record.state,
          kb_profile_id: doc.grant.kb_profile_id,
          issued_at: doc.grant.issued_at,
          expires_at: doc.grant.expires_at,
          request_sha256: doc.grant.request_sha256,
          ...(doc.record.run_id !== undefined ? { run_id: doc.record.run_id } : {}),
        });
      } catch {
        skippedMalformed += 1;
      }
    }
    return { grants, skipped_malformed: skippedMalformed };
  }

  private row(grantId: string): Record<string, SQLOutputValue> | undefined {
    return this.storage.db
      .prepare(`SELECT ${PARENT_GRANT_SELECT} FROM parent_delivery_grants WHERE grant_id = ?`)
      .get(grantId) as Record<string, SQLOutputValue> | undefined;
  }

  private requireRow(grantId: string): ParentDeliveryGrantFile {
    const row = this.row(grantId);
    if (row === undefined) throw new Error(`grant is absent: ${grantId}`);
    return this.fileFromRow(row);
  }

  private fileFromRow(row: Record<string, SQLOutputValue>): ParentDeliveryGrantFile {
    assertExactGrantRow(row);
    const grantId = requiredText(row, "grant_id");
    const grantSha256 = requiredText(row, "grant_sha256");
    const grantJcs = requiredText(row, "grant_jcs");
    const state = requiredText(row, "state");
    const runId = optionalText(row, "run_id");
    const updatedAt = requiredText(row, "updated_at");
    const recordSha256 = requiredText(row, "record_sha256");

    let rawGrant: unknown;
    try {
      rawGrant = parseJsonValue(grantJcs);
    } catch {
      throw new Error(`grant row is unparseable: ${grantId}`);
    }
    let grant: ParentDeliveryGrant;
    try {
      grant = validateParentDeliveryGrant(rawGrant);
    } catch {
      throw new Error(`grant row failed closed validation: ${grantId}`);
    }
    if (canonicalJson(grant) !== grantJcs) {
      throw new Error(`grant row is not exact JCS: ${grantId}`);
    }
    if (grant.grant_id !== grantId || sha256Hex(grantJcs) !== grantSha256) {
      throw new Error(`grant identity or digest mismatch: ${grantId}`);
    }
    if ((state === "consumed") !== (runId !== undefined)) {
      throw new Error(`grant state/run binding is malformed: ${grantId}`);
    }
    let record: ParentDeliveryGrantStoreRecord;
    let file: ParentDeliveryGrantFile;
    try {
      record = validateParentDeliveryGrantStoreRecord({
        schema_version: 1,
        grant_id: grantId,
        grant_sha256: grantSha256,
        state,
        ...(runId !== undefined ? { run_id: runId } : {}),
        updated_at: updatedAt,
      });
      file = validateParentDeliveryGrantFile({ schema_version: 1, record, grant });
    } catch {
      throw new Error(`grant row failed closed record validation: ${grantId}`);
    }
    if (parentGrantRecordDigest(record) !== recordSha256) {
      throw new Error(`grant state digest mismatch: ${grantId}`);
    }
    if (
      requiredText(row, "session_id") !== grant.session_id ||
      requiredText(row, "invocation_id") !== grant.invocation_id ||
      requiredText(row, "kb_profile_id") !== grant.kb_profile_id ||
      requiredText(row, "request_sha256") !== grant.request_sha256 ||
      requiredText(row, "policy_sha256") !== grant.policy_sha256 ||
      requiredText(row, "parent_provider") !== grant.parent_provider ||
      requiredText(row, "parent_model") !== grant.parent_model
    ) {
      throw new Error(`grant match index disagrees with immutable body: ${grantId}`);
    }
    return file;
  }

  private transition(
    current: ParentDeliveryGrantFile,
    state: ParentDeliveryGrantState,
    runId?: string
  ): ParentDeliveryGrantFile {
    const recordValue: Record<string, unknown> = {
      ...current.record,
      state,
      ...(runId !== undefined ? { run_id: runId } : {}),
      updated_at: new Date().toISOString(),
    };
    if (runId === undefined) delete recordValue["run_id"];
    const record = validateParentDeliveryGrantStoreRecord(recordValue);
    const result = this.storage.db
      .prepare(
        `UPDATE parent_delivery_grants
         SET state = ?, run_id = ?, updated_at = ?, record_sha256 = ?
         WHERE grant_id = ? AND grant_sha256 = ? AND state = ?
           AND run_id IS ? AND updated_at = ? AND record_sha256 = ?`
      )
      .run(
        record.state,
        record.run_id ?? null,
        record.updated_at,
        parentGrantRecordDigest(record),
        current.grant.grant_id,
        current.record.grant_sha256,
        current.record.state,
        current.record.run_id ?? null,
        current.record.updated_at,
        parentGrantRecordDigest(current.record)
      );
    if (Number(result.changes) !== 1) {
      throw new Error(`grant lost its exact state transition race: ${current.grant.grant_id}`);
    }
    const expected = validateParentDeliveryGrantFile({
      schema_version: 1,
      record,
      grant: current.grant,
    });
    const persisted = this.requireRow(current.grant.grant_id);
    if (canonicalJson(persisted) !== canonicalJson(expected)) {
      throw new Error(`grant state transition did not persist exactly: ${current.grant.grant_id}`);
    }
    return persisted;
  }
}

// ── validated host invocation context ───────────────────────────────────────

/**
 * Construct the one private extension-to-app authority object. The caller must
 * supply only authenticated Pi identity plus values read from the shared
 * owner-only host authority. Locality comes from the exact matching rule in the
 * validated current policy; provider names are never classified or guessed.
 */
export function buildKbHostInvocationContext(input: {
  sessionId: string;
  invocationId: string;
  parentIdentity: { provider: string; model: string };
  currentPolicy: KbPolicy;
  allowedProfileIds: readonly string[];
  request: KnowledgeBaseRequest;
  parentDeliveryGrant?: ParentDeliveryGrant;
  now?: number;
}): KbHostInvocationContextV1 {
  const policy = validateKbContract(KbPolicySchema, input.currentPolicy, "current KB policy");
  const matchedRule = resolveParentModelRule(policy, input.parentIdentity);
  const allowedProfileIds = [...input.allowedProfileIds].sort();
  if (!allowedProfileIds.includes(input.request.kb_profile_id)) {
    throw new Error("KB host context does not grant the requested profile");
  }
  const grant = input.parentDeliveryGrant;
  if (grant !== undefined) {
    const validatedGrant = validateParentDeliveryGrant(grant);
    if (
      input.request.action !== "query" ||
      input.request.answer_delivery !== "parent_tool_result" ||
      validatedGrant.kb_profile_id !== input.request.kb_profile_id ||
      validatedGrant.request_sha256 !== sha256Hex(canonicalJson(input.request)) ||
      validatedGrant.policy_sha256 !== sha256Hex(canonicalJson(policy)) ||
      Date.parse(validatedGrant.issued_at) > (input.now ?? Date.now()) ||
      Date.parse(validatedGrant.expires_at) <= (input.now ?? Date.now())
    ) {
      throw new Error("parent-delivery grant does not bind the exact host invocation request");
    }
  }
  return validateKbHostInvocationContext({
    schema_version: 1,
    session_id: input.sessionId,
    invocation_id: input.invocationId,
    parent_provider: matchedRule.provider,
    parent_model: matchedRule.model,
    parent_locality: matchedRule.locality,
    allowed_kb_profile_ids: allowedProfileIds,
    ...(grant === undefined ? {} : { parent_delivery_grant: grant }),
  });
}

/** Exact indexed lookup for the optional context grant; never directory scan/adoption. */
export function loadParentDeliveryGrantForHostContext(input: {
  storeDir: string;
  sessionId: string;
  invocationId: string;
  request: QueryKbRequest;
  now?: number;
}): ParentDeliveryGrant | undefined {
  const store = new ParentDeliveryGrantStore(input.storeDir);
  try {
    const match = store.matching(
      input.request.kb_profile_id,
      computeRequestSha256(input.request),
      input.sessionId,
      input.invocationId
    );
    if (match.skipped_malformed > 0) {
      throw new Error("matching parent-delivery authority contains a malformed row");
    }
    const now = input.now ?? Date.now();
    const usable = match.grants.filter(
      (grant) => grant.state === "available" && Date.parse(grant.expires_at) > now
    );
    if (usable.length > 1) throw new Error("matching parent-delivery authority is ambiguous");
    const selected = usable[0];
    return selected === undefined ? undefined : store.load(selected.grant_id).grant;
  } finally {
    store.close();
  }
}

// ── pure eligibility decision ────────────────────────────────────────────────

export interface HostInvocationIdentity {
  session_id: string;
  invocation_id: string;
}
/**
 * Evaluate whether this host invocation may receive the derived parent answer.
 * Pure: reads nothing, writes nothing. Returns the bounded outcome; on
 * eligibility the `byte_cap` is the LESSER of the grant and policy maxima.
 *
 * Ordering follows the contract: grant identity first (session, invocation,
 * profile, action, request digest), then availability/expiry, then the policy
 * allowance, then the byte bound.
 */
export function evaluateParentDelivery(input: {
  grant: ParentDeliveryGrantFile | null; // null = no grant presented for this invocation
  request: QueryKbRequest;
  host: HostInvocationIdentity;
  policy: KbPolicy;
  /**
   * The exact provider/model the runtime reports for the ACTIVE parent context
   * (§5.3 "exact parent allowlist match"). `undefined` means the host could not
   * establish who the parent is, which is a refusal — never a pass.
   */
  parentIdentity: { provider: string; model: string } | undefined;
  answerUtf8Bytes: number;
  /** Host-evaluated closed Vera report over this exact sealed answer. */
  groundingVerified?: boolean;
  now?: number;
}): ParentDeliveryEvaluation {
  const refused = (reason_code: ParentDeliveryReasonCode): ParentDeliveryEvaluation => ({
    status: "refused",
    public_code: REFUSED_PARENT_DELIVERY,
    reason_code,
  });

  const grant = input.grant;
  if (grant === null || grant === undefined) return refused("grant_missing");

  const { grant: g, record } = grant;
  if (g.action !== "query") return refused("grant_mismatch_action");
  if (g.session_id !== input.host.session_id) return refused("grant_mismatch_session");
  if (g.invocation_id !== input.host.invocation_id) return refused("grant_mismatch_invocation");
  if (g.kb_profile_id !== input.request.kb_profile_id) return refused("grant_mismatch_profile");
  if (g.request_sha256 !== computeRequestSha256(input.request)) {
    return refused("grant_mismatch_request_digest");
  }
  if (g.policy_sha256 !== sha256Hex(canonicalJson(input.policy))) {
    return refused("grant_mismatch_policy");
  }
  if (input.parentIdentity === undefined) return refused("parent_identity_unknown");
  if (
    g.parent_provider !== input.parentIdentity.provider ||
    g.parent_model !== input.parentIdentity.model
  ) {
    return refused("grant_mismatch_parent_model");
  }
  if (record.state === "consumed") return refused("grant_consumed");
  if (record.state === "invalidated") return refused("grant_invalidated");
  const now = input.now ?? Date.now();
  if (record.state === "expired" || Date.parse(g.expires_at) <= now)
    return refused("grant_expired");

  try {
    checkDerivedAnswerDelivery(input.policy);
  } catch {
    return refused("policy_denies");
  }

  // §5.3: parent delivery additionally requires an EXACT parent allowlist match.
  // The grant says the operator approved this request; the allowlist says the
  // operator approved this *parent* to receive private derived content.
  if (input.parentIdentity === undefined) return refused("parent_identity_unknown");
  try {
    checkParentModelIdentity(input.policy, input.parentIdentity);
  } catch {
    return refused("parent_model_not_allowed");
  }

  // A request flag is not evidence. Parent delivery requires the host's closed
  // assessment of Vera's same-run report over this exact sealed answer. The
  // deterministic `verify_grounding:false` path is intentionally ineligible.
  if (input.groundingVerified !== true) return refused("grounding_unverified");

  const policyCap = input.policy.parent_result.max_utf8_bytes;
  const byte_cap = Math.min(g.max_utf8_bytes, policyCap);
  if (!Number.isInteger(input.answerUtf8Bytes) || input.answerUtf8Bytes < 0) {
    return refused("answer_exceeds_byte_cap");
  }
  if (input.answerUtf8Bytes > byte_cap) return refused("answer_exceeds_byte_cap");

  return { status: "eligible", byte_cap };
}

// ── end-to-end decision (store selection + eligibility + single-use) ─────────

/** The one decision the KB surface makes before a parent sees derived content. */
export type ParentDeliveryDecision =
  | { outcome: "delivered"; derived_answer: DerivedQueryAnswer }
  | { outcome: "refused"; reason_code: ParentDeliveryReasonCode };

/**
 * Decide parent delivery for one completed query result.
 *
 * Admission requires EXACTLY ONE unconsumed grant matching (profile, request
 * digest, unexpired) for this host invocation — zero is `grant_missing`, more
 * than one is `grant_ambiguous` (never a coin flip). Session and invocation are
 * checked inside `evaluateParentDelivery`; the policy allowance and the lesser
 * of the grant/policy byte bounds still apply. On delivery the grant is
 * atomically consumed by the run and the VALIDATED derived answer is returned
 * for attachment to the result; on any refusal the caller retains only the
 * artifact result and emits the single public code
 * `refused_parent_delivery`.
 *
 * The derived answer is validated against the closed §5.6 shape BEFORE any
 * grant is selected or consumed: open/malformed content is never delivered and
 * never consumes a grant.
 */
export function decideParentDelivery(input: {
  storeDir: string;
  /** The production adapter supplies this one validated private authority object. */
  hostContext?: KbHostInvocationContextV1;
  /** Compatibility-only pure-call inputs; never accepted from a model request. */
  host?: HostInvocationIdentity;
  request: QueryKbRequest;
  policy: KbPolicy;
  /** Compatibility-only pure-call identity; production derives it from hostContext. */
  parentIdentity?: { provider: string; model: string };
  runId: string;
  /** The `answer` sub-object of the sealed `query_answer` artifact (raw unknown). */
  answer: unknown;
  /** The complete exact sealed answer handle used by Vera's report binding. */
  answerHandle?: unknown;
  /** The sealed same-run Vera report (raw unknown; closed validation happens here). */
  verificationReport?: unknown;
  /** Host terminal projection; only complete/met:true runs are delivery-eligible. */
  queryCompleteAndMet?: boolean;
}): ParentDeliveryDecision {
  let answer: DerivedQueryAnswer;
  try {
    answer = validateKbContract(DerivedQueryAnswerSchema, input.answer, "derived answer");
  } catch {
    return { outcome: "refused", reason_code: "answer_malformed" };
  }

  let hostContext: KbHostInvocationContextV1 | undefined;
  try {
    hostContext =
      input.hostContext === undefined
        ? undefined
        : validateKbHostInvocationContext(input.hostContext);
  } catch {
    return { outcome: "refused", reason_code: "grant_malformed" };
  }
  const host =
    hostContext === undefined
      ? input.host
      : { session_id: hostContext.session_id, invocation_id: hostContext.invocation_id };
  const parentIdentity =
    hostContext === undefined
      ? input.parentIdentity
      : { provider: hostContext.parent_provider, model: hostContext.parent_model };
  if (host === undefined) return { outcome: "refused", reason_code: "grant_malformed" };
  if (
    hostContext !== undefined &&
    !hostContext.allowed_kb_profile_ids.includes(input.request.kb_profile_id)
  ) {
    return { outcome: "refused", reason_code: "grant_mismatch_profile" };
  }

  const groundingVerified =
    input.request.verify_grounding !== false &&
    input.queryCompleteAndMet === true &&
    assessQueryVerification(
      { schema_version: 1, artifact_kind: "query_answer", answer },
      input.verificationReport,
      input.answerHandle
    ).passed;

  let store: ParentDeliveryGrantStore;
  try {
    store = new ParentDeliveryGrantStore(input.storeDir);
  } catch {
    return { outcome: "refused", reason_code: "grant_malformed" };
  }
  try {
    const digest = computeRequestSha256(input.request);
    const { grants: matching, skipped_malformed: skippedMalformed } = store.matching(
      input.request.kb_profile_id,
      digest,
      host.session_id,
      host.invocation_id
    );
    if (skippedMalformed > 0) {
      return { outcome: "refused", reason_code: "grant_malformed" };
    }
    const now = Date.now();
    // The EXACTLY-ONE rule applies to USABLE grants: an operator may mint one
    // grant per planned invocation; a grant already consumed by an earlier
    // invocation does not make the next one ambiguous. Two usable grants for
    // the same invitation are a coin flip the host refuses.
    const usable = matching.filter(
      (g) => g.state === "available" && Date.parse(g.expires_at) > now
    );
    if (usable.length > 1) return { outcome: "refused", reason_code: "grant_ambiguous" };
    const single = usable[0];
    if (single === undefined) {
      if (matching.some((g) => g.state === "available" && Date.parse(g.expires_at) <= now)) {
        return { outcome: "refused", reason_code: "grant_expired" };
      }
      if (matching.some((g) => g.state === "consumed")) {
        return { outcome: "refused", reason_code: "grant_consumed" };
      }
      if (matching.some((g) => g.state === "invalidated")) {
        return { outcome: "refused", reason_code: "grant_invalidated" };
      }
      return { outcome: "refused", reason_code: "grant_missing" };
    }
    if (
      hostContext !== undefined &&
      hostContext.parent_delivery_grant?.grant_id !== single.grant_id
    ) {
      return { outcome: "refused", reason_code: "grant_missing" };
    }

    let file: ParentDeliveryGrantFile;
    try {
      file = store.load(single.grant_id);
    } catch {
      return { outcome: "refused", reason_code: "grant_malformed" };
    }
    if (
      hostContext?.parent_delivery_grant !== undefined &&
      canonicalJson(hostContext.parent_delivery_grant) !== canonicalJson(file.grant)
    ) {
      return { outcome: "refused", reason_code: "grant_malformed" };
    }

    const evaluation = evaluateParentDelivery({
      grant: file,
      request: input.request,
      host,
      policy: input.policy,
      parentIdentity,
      answerUtf8Bytes: Buffer.byteLength(canonicalJson(answer), "utf8"),
      groundingVerified,
      now,
    });
    if (evaluation.status === "refused") {
      return { outcome: "refused", reason_code: evaluation.reason_code };
    }

    try {
      store.consume(single.grant_id, input.runId, file.record.grant_sha256);
    } catch {
      try {
        const raced = store.load(single.grant_id);
        if (raced.record.state === "consumed") {
          return { outcome: "refused", reason_code: "grant_consumed" };
        }
        if (raced.record.state === "invalidated") {
          return { outcome: "refused", reason_code: "grant_invalidated" };
        }
        if (raced.record.state === "expired") {
          return { outcome: "refused", reason_code: "grant_expired" };
        }
      } catch {
        // A malformed raced row is handled by the closed refusal below.
      }
      return { outcome: "refused", reason_code: "grant_malformed" };
    }
    return { outcome: "delivered", derived_answer: answer };
  } finally {
    store.close();
  }
}
