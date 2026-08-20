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
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Value } from "typebox/value";

import {
  DerivedQueryAnswerSchema,
  ParentDeliveryGrantFileSchema,
  ParentDeliveryGrantSchema,
  QueryKbRequestSchema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
  type DerivedQueryAnswer,
  type KbPolicy,
  type ParentDeliveryGrant,
  type ParentDeliveryGrantFile,
  type ParentDeliveryGrantStoreRecord,
  type ParentDeliveryGrantState,
  type QueryKbRequest,
  type Rfc3339Utc,
  type Sha256Hex,
} from "./contracts.js";
import { checkDerivedAnswerDelivery, checkParentModelIdentity } from "./policy.js";

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
  max_utf8_bytes: number;
  issued_at: Rfc3339Utc;
  expires_at: Rfc3339Utc;
  grant_id?: string;
}): ParentDeliveryGrant {
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
    max_utf8_bytes: input.max_utf8_bytes,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
  };
  return validateKbContract(ParentDeliveryGrantSchema, grant, "parent delivery grant");
}

// ── owner-only grant store ───────────────────────────────────────────────────

function ownerUid(): number | undefined {
  try {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
  } catch {
    return undefined;
  }
}

function assertSafeDir(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`grant store directory is not a directory: ${dir}`);
  if (st.mode & 0o022) throw new Error("grant store directory is group/other writable");
  const uid = ownerUid();
  if (uid !== undefined && st.uid !== uid)
    throw new Error("grant store directory is not current-user-owned");
}

function assertSafeFile(file: string): void {
  const st = lstatSync(file);
  if (!st.isFile()) throw new Error(`grant entry is not a regular file: ${file}`);
  if (st.nlink !== 1) throw new Error(`grant entry has an unexpected link count: ${file}`);
  if (st.mode & 0o022) throw new Error("grant entry is group/other writable");
  const uid = ownerUid();
  if (uid !== undefined && st.uid !== uid) throw new Error("grant entry is not current-user-owned");
}

function grantFileName(grantId: string): string {
  // grant_id is schema-validated (opaque id — no /, \, whitespace, ..).
  return `${grantId}.json`;
}

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
 * Owner-only grant store under an ignored HOST root (NOT the KB root — the
 * grant is profile-scoped host state, present before and independent of any
 * KB). Files are mode `0600`, written via exclusive temp + atomic rename,
 * revalidated on every read, and never opened through a symlink or a
 * broadened mode.
 */
export class ParentDeliveryGrantStore {
  private readonly dirPath: string;

  constructor(dir: string) {
    this.dirPath = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertSafeDir(dir);
  }

  /** The owner-only store directory (host state; never a KB root). */
  get dir(): string {
    return this.dirPath;
  }

  /** Store a newly minted (never-before-seen) grant as `available`. */
  mint(grant: ParentDeliveryGrant): void {
    const file = path.join(this.dir, grantFileName(grant.grant_id));
    try {
      lstatSync(file);
      throw new Error(`grant id already exists in the store: ${grant.grant_id}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const record: ParentDeliveryGrantStoreRecord = {
      schema_version: 1,
      grant_id: grant.grant_id,
      grant_sha256: sha256Hex(canonicalJson(grant)),
      state: "available",
      updated_at: new Date().toISOString(),
    };
    const doc: ParentDeliveryGrantFile = { schema_version: 1, record, grant };
    this.atomicWrite(file, doc);
  }

  /**
   * Load and fully validate one grant file: schema, record↔grant agreement,
   * and record.draft digest. A malformed file is EXPLICIT (the lesson from
   * the ingest-plane gate-reader bug: never silently skip an unparseable row
   * and present it as "no grant exists").
   */
  load(grantId: string): ParentDeliveryGrantFile {
    const file = path.join(this.dir, grantFileName(grantId));
    assertSafeFile(file);
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`grant file is unparseable: ${grantId}`);
    }
    if (!Value.Check(ParentDeliveryGrantFileSchema, doc)) {
      throw new Error(`grant file failed closed validation: ${grantId}`);
    }
    const parsed = doc as ParentDeliveryGrantFile;
    if (parsed.record.grant_id !== parsed.grant.grant_id) {
      throw new Error(`grant record id disagrees with grant body: ${grantId}`);
    }
    if (parsed.record.grant_sha256 !== sha256Hex(canonicalJson(parsed.grant))) {
      throw new Error(`grant digest mismatch: ${grantId}`);
    }
    return parsed;
  }

  /**
   * Atomically CAS one grant `available → consumed` by the given run. The
   * read-compare-rename sequence is the single-host CAS idiom (same as the
   * gate store): rename is atomic on the filesystem, and the state is
   * rechecked from the re-read bytes immediately before the swap. A second
   * consume (or any non-`available` state) fails closed.
   */
  consume(grantId: string, runId: string): ParentDeliveryGrantFile {
    const file = path.join(this.dir, grantFileName(grantId));
    assertSafeFile(file);
    const current = this.load(grantId);
    if (current.record.state !== "available") {
      throw new Error(`grant is not available (state: ${current.record.state}): ${grantId}`);
    }
    if (Date.parse(current.grant.expires_at) <= Date.now()) {
      this.transactState(current, "expired");
      throw new Error(`grant is expired: ${grantId}`);
    }
    const next: ParentDeliveryGrantFile = {
      schema_version: 1,
      record: {
        ...current.record,
        state: "consumed",
        run_id: runId,
        updated_at: new Date().toISOString(),
      },
      grant: current.grant,
    };
    // Re-read immediately before the swap to make the CAS check as tight as a
    // single-host rename-based store allows.
    const rechecked = this.loadFrom(file);
    if (rechecked.record.state !== "available" || rechecked.record.grant_id !== grantId) {
      throw new Error(`grant was not available at swap time: ${grantId}`);
    }
    this.atomicWrite(file, next);
    return next;
  }

  /** Host-side invalidation (operator revocation); available → invalidated. */
  invalidate(grantId: string): ParentDeliveryGrantFile {
    const current = this.load(grantId);
    if (current.record.state !== "available") {
      throw new Error(`grant is not available (state: ${current.record.state}): ${grantId}`);
    }
    return this.transactState(current, "invalidated");
  }

  private transactState(
    current: ParentDeliveryGrantFile,
    state: ParentDeliveryGrantState
  ): ParentDeliveryGrantFile {
    const next: ParentDeliveryGrantFile = {
      schema_version: 1,
      record: { ...current.record, state, updated_at: new Date().toISOString() },
      grant: current.grant,
    };
    const file = path.join(this.dir, grantFileName(current.grant.grant_id));
    this.atomicWrite(file, next);
    return next;
  }

  private loadFrom(file: string): ParentDeliveryGrantFile {
    assertSafeFile(file);
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`grant file is unparseable at: ${file}`);
    }
    if (!Value.Check(ParentDeliveryGrantFileSchema, doc)) {
      throw new Error(`grant file failed closed validation at: ${file}`);
    }
    return doc as ParentDeliveryGrantFile;
  }

  private atomicWrite(file: string, doc: ParentDeliveryGrantFile): void {
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  }

  /**
   * Safe projection of every grant for operator listing. Malformed entries
   * are NOT silently dropped: they are counted in `skipped_malformed` so the
   * operator sees the store is not exactly what the grants they minted say.
   */
  list(): { grants: StoredGrantProjection[]; skipped_malformed: number } {
    assertSafeDir(this.dir);
    const grants: StoredGrantProjection[] = [];
    let skipped = 0;
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
      try {
        const doc = this.load(name.slice(0, -5));
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
        skipped += 1;
      }
    }
    return { grants, skipped_malformed: skipped };
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

  // §5.6 `verify_grounding` defaults TRUE. The query flow is deterministic
  // retrieval today — there is no grounding phase — so a request that asks for
  // verification cannot be delivered as if it were verified. The operator can
  // still deliver by minting a grant over a request that explicitly carries
  // `verify_grounding: false`, which records in the digest that they accepted
  // an unverified answer. Flip this once the query grounding phase lands.
  if (input.request.verify_grounding !== false) return refused("grounding_unverified");

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
  host: HostInvocationIdentity;
  request: QueryKbRequest;
  policy: KbPolicy;
  /** Exact provider/model of the active parent context (§5.3); `undefined` refuses. */
  parentIdentity: { provider: string; model: string } | undefined;
  runId: string;
  /** The `answer` sub-object of the sealed `query_answer` artifact (raw unknown). */
  answer: unknown;
}): ParentDeliveryDecision {
  let answer: DerivedQueryAnswer;
  try {
    answer = validateKbContract(DerivedQueryAnswerSchema, input.answer, "derived answer");
  } catch {
    return { outcome: "refused", reason_code: "answer_malformed" };
  }

  const store = new ParentDeliveryGrantStore(input.storeDir);
  const { grants } = store.list();
  const digest = computeRequestSha256(input.request);
  const now = Date.now();
  const matching = grants.filter(
    (g) => g.kb_profile_id === input.request.kb_profile_id && g.request_sha256 === digest
  );
  // The EXACTLY-ONE rule applies to USABLE grants: an operator may mint one
  // grant per planned invocation; a grant already consumed by an earlier
  // invocation does not make the next one ambiguous. Two usable grants for
  // the same invitation are a coin flip the host refuses.
  const usable = matching.filter((g) => g.state === "available" && Date.parse(g.expires_at) > now);
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

  let file: ParentDeliveryGrantFile;
  try {
    file = store.load(single.grant_id);
  } catch {
    return { outcome: "refused", reason_code: "grant_malformed" };
  }

  const evaluation = evaluateParentDelivery({
    grant: file,
    request: input.request,
    host: input.host,
    policy: input.policy,
    parentIdentity: input.parentIdentity,
    answerUtf8Bytes: Buffer.byteLength(answer.text, "utf8"),
    now,
  });
  if (evaluation.status === "refused")
    return { outcome: "refused", reason_code: evaluation.reason_code };

  store.consume(single.grant_id, input.runId);
  return { outcome: "delivered", derived_answer: answer };
}
