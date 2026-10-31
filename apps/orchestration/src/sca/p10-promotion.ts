import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../contracts.js";
import {
  SCA_P10_PROMOTION_RECEIPT_SCHEMA,
  SCA_P10_RULE_RELEASE_REVISION_SCHEMA,
  validateScaP10PromotionReceiptV1,
  validateScaP10RuleReleaseRevisionV1,
  withP10Digest,
  type ScaP10PromotionReceiptV1,
  type ScaP10RuleReleaseRevisionV1,
} from "./p10-contracts.js";

/**
 * SCA-owned, future-only, atomic, immutable rule-promotion store (`SCA-P10` R7). The pattern
 * mirrors the KB promotion journal/receipt/mutex reference, but this store owns SCA rule-release
 * semantics and is not a second campaign engine.
 *
 * Guarantees:
 * - **separate authorization** — a decision without an admitted promotion authority is `denied`;
 * - **atomic** — one successor release revision commits or no partial state remains;
 * - **immutable** — earlier releases and the append-only history are never mutated;
 * - **concurrency-safe** — compare-and-set on the current head admits exactly one of two peers;
 * - **crash/replay-safe** — a fault at any durable boundary leaves the prior or the new head, and
 *   duplicate delivery of one promotion converges to the same receipt or fails closed on conflict;
 * - **rollback-capable** — a separately authorized rollback revision restores the prior head;
 * - **future-only** — active runs keep their frozen release; the successor is available only to
 *   future admissions.
 */
export type ScaRulePromotionFaultHook = (boundary: string) => void;

export class ScaRulePromotionSimulatedCrash extends Error {
  constructor(readonly boundary: string) {
    super(`SCA rule promotion crashed at durable boundary '${boundary}'`);
    this.name = "ScaRulePromotionSimulatedCrash";
  }
}

export interface ScaRulePromotionHeadV1 {
  readonly release_ref: ArtifactRef;
  readonly release_sha256: string;
  readonly release_id: string;
  readonly release_revision: number;
}

export interface ScaRulePromotionJournalEntryV1 {
  readonly promotion_id: string;
  readonly candidate_id: string;
  readonly promotion_authority_ref: ArtifactRef;
  readonly predecessor: ScaRulePromotionHeadV1 | null;
  readonly successor: ScaRulePromotionHeadV1;
  readonly successor_revision_ref: ArtifactRef;
  readonly receipt_ref: ArtifactRef;
  readonly receipt_sha256: string;
  readonly kind: "promotion" | "rollback";
  readonly committed_at: string;
}

export interface ScaRulePromotionStateV1 {
  /** The current release head, or null before any promotion. */
  readonly head: ScaRulePromotionHeadV1 | null;
  /** Append-only full history of release heads (every promotion and rollback revision). */
  readonly history: readonly ScaRulePromotionHeadV1[];
  /** Append-only promotion/rollback journal. */
  readonly journal: readonly ScaRulePromotionJournalEntryV1[];
}

/** Atomic single-writer durable backend. `commit` must be all-or-nothing. */
export interface ScaRulePromotionBackendV1 {
  read(): ScaRulePromotionStateV1;
  commit(next: ScaRulePromotionStateV1, boundary: string): void;
}

export interface ScaPromotionOutcomeV1 {
  readonly outcome: "promoted" | "denied" | "not_attempted" | "unavailable" | "conflict";
  readonly receipt: ScaP10PromotionReceiptV1 | null;
  readonly receipt_ref: ArtifactRef | null;
  readonly successor_revision_ref: ArtifactRef | null;
  readonly history: readonly ScaRulePromotionHeadV1[];
  readonly blocker_codes: readonly string[];
}

export interface ScaRulePromotionStoreOptionsV1 {
  readonly backend: ScaRulePromotionBackendV1;
  readonly store: ArtifactHostStore;
  readonly runId: string;
  readonly phase: string;
  readonly now?: () => Date;
  readonly fault?: ScaRulePromotionFaultHook;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function emptyState(): ScaRulePromotionStateV1 {
  return { head: null, history: [], journal: [] };
}
function headKey(head: ScaRulePromotionHeadV1 | null): string {
  return head === null ? "null" : `${head.release_ref.artifact_id}:${head.release_sha256}`;
}

/**
 * Durable, candidate-scoped promotion idempotency key. It intentionally excludes the caller-supplied
 * predecessor: a promotion intent is "this candidate's successor revision", so re-deriving the same
 * finalize after some *later* promotion still converges to the original journal entry instead of
 * promoting the candidate a second time atop the new head. A differing successor for the same
 * candidate is a conflict, not a new promotion.
 */
export function scaP10PromotionId(candidateId: string): string {
  return `p10prom_${sha256(canonicalJson({ candidate_id: candidateId }))}`;
}

function headClaimTokenSha256(input: {
  readonly promotion_id: string;
  readonly expected_predecessor_sha256: string | null;
  readonly successor_sha256: string;
}): string {
  return sha256(canonicalJson(input));
}

/** In-memory backend for deterministic, provider-free tests with a fault seam. */
export function createMemoryScaRulePromotionBackendV1(
  initial: ScaRulePromotionStateV1 = emptyState()
): ScaRulePromotionBackendV1 {
  let state = initial;
  return {
    read: () => state,
    commit: (next) => {
      state = next;
    },
  };
}

function isPromotionHead(value: unknown): value is ScaRulePromotionHeadV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const head: Record<string, unknown> = { ...value };
  return (
    typeof head["release_sha256"] === "string" &&
    typeof head["release_id"] === "string" &&
    typeof head["release_revision"] === "number" &&
    head["release_ref"] !== null &&
    typeof head["release_ref"] === "object" &&
    !Array.isArray(head["release_ref"])
  );
}

function isScaRulePromotionStateV1(value: unknown): value is ScaRulePromotionStateV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state: Record<string, unknown> = { ...value };
  const head = state["head"];
  if (head !== null && !isPromotionHead(head)) return false;
  if (!Array.isArray(state["history"]) || !Array.isArray(state["journal"])) return false;
  return state["history"].every(isPromotionHead);
}

/**
 * Artifact-backed backend: the whole promotion state is one canonical document persisted through
 * the host store, so one commit is one durable write. The current state is the highest version of
 * the state artifact.
 */
export function createArtifactScaRulePromotionBackendV1(input: {
  readonly store: ArtifactHostStore;
  readonly runId: string;
  readonly phase: string;
  readonly operationId?: string;
}): ScaRulePromotionBackendV1 {
  const operationId = input.operationId ?? "sca-p10-promotion-state";
  const kind = "sca-p10-promotion-state";
  const read = (): ScaRulePromotionStateV1 => {
    const version = input.store.lastVersion(input.runId, input.phase, null, kind, operationId);
    if (version < 1) return emptyState();
    const ref = input.store.refFor(input.runId, input.phase, null, kind, operationId, version);
    if (ref === null) return emptyState();
    const bytes = input.store.readById(ref.artifact_id);
    if (sha256(bytes) !== ref.content_digest) {
      throw new Error("SCA P10 promotion state bytes drifted from their admitted digest");
    }
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isScaRulePromotionStateV1(parsed)) {
      throw new Error("SCA P10 promotion state document is malformed");
    }
    return parsed;
  };
  return {
    read,
    commit: (next) => {
      const previousVersion = input.store.lastVersion(
        input.runId,
        input.phase,
        null,
        kind,
        operationId
      );
      const parentRef =
        previousVersion < 1
          ? null
          : input.store.refFor(input.runId, input.phase, null, kind, operationId, previousVersion);
      const metadata: OutputArtifactMetadata = {
        schema_version: 2,
        run_id: input.runId,
        phase: input.phase,
        branch_id: null,
        kind,
        operation_id: operationId,
        version: previousVersion + 1,
        producer: "host:sca-p10-promotion-store",
        media_type: "application/json",
        content_schema: { schema_id: "penny.sca-p10-promotion-state.v1", schema_version: 1 },
        parent_ref: parentRef,
        upstream_refs: [
          ...(next.head === null ? [] : [next.head.release_ref]),
          ...next.journal.map((entry) => entry.receipt_ref),
        ],
      };
      input.store.persist({ metadata, content: canonicalJson(next) });
    },
  };
}

export class ScaRulePromotionStore {
  private readonly backend: ScaRulePromotionBackendV1;
  private readonly store: ArtifactHostStore;
  private readonly runId: string;
  private readonly phase: string;
  private readonly now: () => Date;
  private readonly fault: ScaRulePromotionFaultHook | undefined;
  /** Single-writer serializer: a synchronous critical section admits exactly one peer. */
  private locked = false;

  constructor(options: ScaRulePromotionStoreOptionsV1) {
    this.backend = options.backend;
    this.store = options.store;
    this.runId = options.runId;
    this.phase = options.phase;
    this.now = options.now ?? (() => new Date());
    this.fault = options.fault;
  }

  currentHead(): ScaRulePromotionHeadV1 | null {
    return this.backend.read().head;
  }

  history(): readonly ScaRulePromotionHeadV1[] {
    return this.backend.read().history;
  }

  private boundary(name: string): void {
    this.fault?.(name);
  }

  private withLock<T>(work: () => T): T {
    if (this.locked) throw new Error("SCA P10 promotion store is single-writer and re-entered");
    this.locked = true;
    try {
      return work();
    } finally {
      this.locked = false;
    }
  }

  private persistExact(input: {
    readonly kind: string;
    readonly operationId: string;
    readonly schemaId: string;
    readonly value: unknown;
    readonly upstreamRefs: readonly ArtifactRef[];
  }): ArtifactRef {
    const content = canonicalJson(input.value);
    const prior = this.store.refFor(this.runId, this.phase, null, input.kind, input.operationId, 1);
    if (prior !== null) {
      if (
        prior.content_digest !== sha256(content) ||
        this.store.readById(prior.artifact_id).toString("utf8") !== content
      ) {
        throw new Error(
          `SCA P10 promotion artifact '${input.operationId}' conflicts with immutable prior bytes`
        );
      }
      return prior;
    }
    const metadata: OutputArtifactMetadata = {
      schema_version: 2,
      run_id: this.runId,
      phase: this.phase,
      branch_id: null,
      kind: input.kind,
      operation_id: input.operationId,
      version: 1,
      producer: "host:sca-p10-promotion-store",
      media_type: "application/json",
      content_schema: { schema_id: input.schemaId, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [...input.upstreamRefs].sort((left, right) =>
        left.artifact_id.localeCompare(right.artifact_id)
      ),
    };
    return this.store.persist({ metadata, content });
  }

  /**
   * Promote one validated candidate's successor release. Requires an admitted promotion authority
   * and a compare-and-set on the current head; duplicate delivery converges or fails closed.
   */
  promote(input: {
    readonly candidate_id: string;
    readonly promotion_authority_ref: ArtifactRef;
    readonly promotion_authority_admitted: boolean;
    readonly successor_release_ref: ArtifactRef;
    readonly bundle_ref: ArtifactRef;
    readonly expected_predecessor: ScaRulePromotionHeadV1 | null;
    readonly active_run_rule_release_refs: readonly ArtifactRef[];
  }): ScaPromotionOutcomeV1 {
    return this.withLock(() => {
      if (!input.promotion_authority_admitted) {
        return {
          outcome: "denied",
          receipt: null,
          receipt_ref: null,
          successor_revision_ref: null,
          history: this.backend.read().history,
          blocker_codes: ["p10_promotion_authority_not_admitted"],
        };
      }
      for (const ref of input.active_run_rule_release_refs) {
        if (ref.artifact_id === input.successor_release_ref.artifact_id) {
          return {
            outcome: "unavailable",
            receipt: null,
            receipt_ref: null,
            successor_revision_ref: null,
            history: this.backend.read().history,
            blocker_codes: ["p10_promotion_would_alter_frozen_active_run_rule"],
          };
        }
      }

      const state = this.backend.read();
      const releaseRevision = (state.head?.release_revision ?? 0) + 1;
      const promotionId = scaP10PromotionId(input.candidate_id);

      // Replay/idempotency: the durable intent is the candidate itself, independent of the
      // caller-supplied current predecessor. An existing journal entry for this intent either
      // converges to the exact prior result or fails closed on a conflicting successor.
      const existing = state.journal.find((entry) => entry.promotion_id === promotionId);
      if (existing !== undefined) {
        const receipt = validateScaP10PromotionReceiptV1(
          JSON.parse(this.store.readById(existing.receipt_ref.artifact_id).toString("utf8"))
        );
        if (
          existing.successor.release_sha256 !== input.successor_release_ref.content_digest ||
          existing.kind !== "promotion"
        ) {
          return {
            outcome: "conflict",
            receipt: null,
            receipt_ref: null,
            successor_revision_ref: null,
            history: state.history,
            blocker_codes: ["p10_promotion_replay_conflict"],
          };
        }
        return {
          outcome: "promoted",
          receipt,
          receipt_ref: existing.receipt_ref,
          successor_revision_ref: existing.successor_revision_ref,
          history: state.history,
          blocker_codes: [],
        };
      }

      // Compare-and-set on the current head.
      if (headKey(input.expected_predecessor) !== headKey(state.head)) {
        return {
          outcome: "conflict",
          receipt: null,
          receipt_ref: null,
          successor_revision_ref: null,
          history: state.history,
          blocker_codes: ["p10_promotion_head_conflict"],
        };
      }

      this.boundary("before_head_claim");
      const successorRevision = validateScaP10RuleReleaseRevisionV1(
        withP10Digest(
          {
            schema_id: SCA_P10_RULE_RELEASE_REVISION_SCHEMA,
            schema_version: 1 as const,
            phase_id: "SCA-P10" as const,
            release_revision: releaseRevision,
            release_ref: input.successor_release_ref,
            release_sha256: input.successor_release_ref.content_digest,
            bundle_ref: input.bundle_ref,
            bundle_sha256: input.bundle_ref.content_digest,
            predecessor_release_ref: state.head?.release_ref ?? null,
            predecessor_release_sha256: state.head?.release_sha256 ?? null,
            promotion_authority_ref: input.promotion_authority_ref,
            immutable: true as const,
            created_at: this.now().toISOString(),
          },
          "revision_sha256"
        )
      );
      this.boundary("after_head_claim");
      this.boundary("before_release_persist");
      const revisionRef = this.persistExact({
        kind: "sca-p10-rule-release-revision",
        operationId: `sca-p10-rule-release-revision-${promotionId}`,
        schemaId: SCA_P10_RULE_RELEASE_REVISION_SCHEMA,
        value: successorRevision,
        upstreamRefs: [input.successor_release_ref, input.bundle_ref],
      });
      this.boundary("after_release_persist");

      const successorHead: ScaRulePromotionHeadV1 = {
        release_ref: input.successor_release_ref,
        release_sha256: input.successor_release_ref.content_digest,
        release_id: input.successor_release_ref.artifact_id,
        release_revision: releaseRevision,
      };
      const receipt = validateScaP10PromotionReceiptV1(
        withP10Digest(
          {
            schema_id: SCA_P10_PROMOTION_RECEIPT_SCHEMA,
            schema_version: 1 as const,
            phase_id: "SCA-P10" as const,
            promotion_id: promotionId,
            candidate_id: input.candidate_id,
            promotion_authority_ref: input.promotion_authority_ref,
            predecessor_release_ref: state.head?.release_ref ?? null,
            predecessor_release_sha256: state.head?.release_sha256 ?? null,
            successor_release_ref: input.successor_release_ref,
            successor_release_sha256: input.successor_release_ref.content_digest,
            successor_release_revision: releaseRevision,
            head_claim_token_sha256: headClaimTokenSha256({
              promotion_id: promotionId,
              expected_predecessor_sha256: state.head?.release_sha256 ?? null,
              successor_sha256: input.successor_release_ref.content_digest,
            }),
            committed_at: this.now().toISOString(),
            atomic: true as const,
            immutable: true as const,
            future_only: true as const,
          },
          "receipt_sha256"
        )
      );
      this.boundary("before_receipt_journal");
      const receiptRef = this.persistExact({
        kind: "sca-p10-promotion-receipt",
        operationId: `sca-p10-promotion-receipt-${promotionId}`,
        schemaId: SCA_P10_PROMOTION_RECEIPT_SCHEMA,
        value: receipt,
        upstreamRefs: [input.successor_release_ref, revisionRef],
      });
      this.boundary("after_receipt_journal");

      const next: ScaRulePromotionStateV1 = {
        head: successorHead,
        history: [...state.history, successorHead],
        journal: [
          ...state.journal,
          {
            promotion_id: promotionId,
            candidate_id: input.candidate_id,
            promotion_authority_ref: input.promotion_authority_ref,
            predecessor: state.head,
            successor: successorHead,
            successor_revision_ref: revisionRef,
            receipt_ref: receiptRef,
            receipt_sha256: receipt.receipt_sha256,
            kind: "promotion",
            committed_at: receipt.committed_at,
          },
        ],
      };
      this.boundary("before_commit");
      this.backend.commit(next, "before_commit");
      this.boundary("after_commit");
      return {
        outcome: "promoted",
        receipt,
        receipt_ref: receiptRef,
        successor_revision_ref: revisionRef,
        history: next.history,
        blocker_codes: [],
      };
    });
  }

  /**
   * Separately authorized rollback: restore a named predecessor release as the current head,
   * preserving all history. The successor release revision is appended, never rewritten.
   */
  rollback(input: {
    readonly promotion_authority_ref: ArtifactRef;
    readonly promotion_authority_admitted: boolean;
    readonly target: ScaRulePromotionHeadV1;
  }): ScaPromotionOutcomeV1 {
    return this.withLock(() => {
      if (!input.promotion_authority_admitted) {
        return {
          outcome: "denied",
          receipt: null,
          receipt_ref: null,
          successor_revision_ref: null,
          history: this.backend.read().history,
          blocker_codes: ["p10_rollback_authority_not_admitted"],
        };
      }
      const state = this.backend.read();
      if (!state.history.some((head) => same(head, input.target))) {
        return {
          outcome: "not_attempted",
          receipt: null,
          receipt_ref: null,
          successor_revision_ref: null,
          history: state.history,
          blocker_codes: ["p10_rollback_target_not_in_history"],
        };
      }
      const rollbackId = `p10roll_${sha256(
        canonicalJson({
          target_sha256: input.target.release_sha256,
          from_sha256: state.head?.release_sha256 ?? null,
        })
      )}`;
      const revisionRef = this.persistExact({
        kind: "sca-p10-rule-release-rollback",
        operationId: `sca-p10-rule-release-rollback-${rollbackId}`,
        schemaId: SCA_P10_RULE_RELEASE_REVISION_SCHEMA,
        value: withP10Digest(
          {
            schema_id: SCA_P10_RULE_RELEASE_REVISION_SCHEMA,
            schema_version: 1 as const,
            phase_id: "SCA-P10" as const,
            release_revision: (state.head?.release_revision ?? 0) + 1,
            release_ref: input.target.release_ref,
            release_sha256: input.target.release_sha256,
            bundle_ref: input.target.release_ref,
            bundle_sha256: input.target.release_sha256,
            predecessor_release_ref: state.head?.release_ref ?? null,
            predecessor_release_sha256: state.head?.release_sha256 ?? null,
            promotion_authority_ref: input.promotion_authority_ref,
            immutable: true as const,
            created_at: this.now().toISOString(),
          },
          "revision_sha256"
        ),
        upstreamRefs: [input.target.release_ref],
      });
      const receiptRef = this.persistExact({
        kind: "sca-p10-promotion-receipt",
        operationId: `sca-p10-rollback-receipt-${rollbackId}`,
        schemaId: SCA_P10_PROMOTION_RECEIPT_SCHEMA,
        value: validateScaP10PromotionReceiptV1(
          withP10Digest(
            {
              schema_id: SCA_P10_PROMOTION_RECEIPT_SCHEMA,
              schema_version: 1 as const,
              phase_id: "SCA-P10" as const,
              promotion_id: rollbackId,
              candidate_id: "rollback",
              promotion_authority_ref: input.promotion_authority_ref,
              predecessor_release_ref: state.head?.release_ref ?? null,
              predecessor_release_sha256: state.head?.release_sha256 ?? null,
              successor_release_ref: input.target.release_ref,
              successor_release_sha256: input.target.release_sha256,
              successor_release_revision: input.target.release_revision,
              head_claim_token_sha256: headClaimTokenSha256({
                promotion_id: rollbackId,
                expected_predecessor_sha256: state.head?.release_sha256 ?? null,
                successor_sha256: input.target.release_sha256,
              }),
              committed_at: this.now().toISOString(),
              atomic: true as const,
              immutable: true as const,
              future_only: true as const,
            },
            "receipt_sha256"
          )
        ),
        upstreamRefs: [input.target.release_ref, revisionRef],
      });
      const receipt = validateScaP10PromotionReceiptV1(
        JSON.parse(this.store.readById(receiptRef.artifact_id).toString("utf8"))
      );
      const next: ScaRulePromotionStateV1 = {
        head: input.target,
        history: [...state.history, input.target],
        journal: [
          ...state.journal,
          {
            promotion_id: rollbackId,
            candidate_id: "rollback",
            promotion_authority_ref: input.promotion_authority_ref,
            predecessor: state.head,
            successor: input.target,
            successor_revision_ref: revisionRef,
            receipt_ref: receiptRef,
            receipt_sha256: receipt.receipt_sha256,
            kind: "rollback",
            committed_at: receipt.committed_at,
          },
        ],
      };
      this.boundary("before_commit");
      this.backend.commit(next, "before_commit");
      this.boundary("after_commit");
      return {
        outcome: "promoted",
        receipt,
        receipt_ref: receiptRef,
        successor_revision_ref: revisionRef,
        history: next.history,
        blocker_codes: [],
      };
    });
  }
}

export type { ScaP10RuleReleaseRevisionV1 };
