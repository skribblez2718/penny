/**
 * W1 — Playbook core and capability interfaces (Foundation stage, workstream 1 of 3).
 *
 * The engine used to hold a concrete `ResearchPlaybook` and call research-specific
 * methods on it. That left no seam between "the orchestration engine" and "its only
 * tenant": a second playbook could only duplicate the loop or leak research semantics.
 *
 * This module defines what every playbook must provide (`PlaybookCoreV1`) and what some
 * playbooks may additionally provide (capability interfaces). The engine dispatches by
 * **capability, not by name** — it never tests `playbook === "research"`.
 *
 * These are TypeScript interfaces rather than TypeBox schemas, and they live here rather
 * than in `contracts.ts`, because they reference both `Directive` (contracts.ts) and
 * `RunContext` (context.ts, which imports contracts.ts). Declaring them in `contracts.ts`
 * would create an import cycle.
 */

import type {
  CompletionEvidenceRef,
  CompletionFailureCode,
  CompletionGate,
  CompletionProductEvidence,
  Confidence,
  Directive,
  EvaluationResultV2,
  JsonValue,
  LivenessSnapshotV1,
  LivenessTerminalReason,
  PhaseResult,
} from "../contracts.js";
import type { RunContext } from "../context.js";
import type { ArtifactReader } from "../artifact-store.js";
import type { Checkpointer, ReserveOperationEventGroupInput } from "../checkpointer.js";

/**
 * Mandatory surface. Every registered playbook implements all of it.
 *
 * Signatures are taken verbatim from the live research playbook so that W1 is a pure
 * interface extraction with no behavioural change.
 */
export interface PlaybookCoreV1 {
  /** First directive for a new run. */
  initialize(context: RunContext): Directive;
  /** Next directive for the current state. */
  dispatch(context: RunContext): Directive;
  /** Continue a run that was awaiting a user response. */
  resume(context: RunContext, response: JsonValue): Directive;
  /** Terminate a run at the caller's request. */
  cancel(context: RunContext, reason: string): Directive;
  /** Fold an accepted result into the run and return the next directive. */
  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    confidence: Confidence
  ): PlaybookStepOutcomeV1;
  /** Re-derive a pending directive after restart. `null` when nothing is pending. */
  rebindPendingDirective(context: RunContext): Directive | null;
}

/**
 * Optional. Playbooks that fan out to parallel branches and fold the results back.
 *
 * A playbook that never emits `invoke_agents_parallel` does not need this.
 */
export interface FanAggregateCapabilityV1 {
  aggregateBranches(branchDetails: readonly Record<string, JsonValue>[]): Record<string, JsonValue>;
}

/**
 * Optional. Playbooks that can reissue one malformed branch instead of failing the run.
 *
 * Without it the engine falls back to reissuing the current state, which is the same
 * path already used for non-branch results.
 */
export interface RoutingRepairCapabilityV1 {
  routingRepair(context: RunContext, malformed: PhaseResult): Directive;
}

export interface LivenessTerminalCapabilityV1 {
  terminalizeLiveness(
    context: RunContext,
    reason: LivenessTerminalReason,
    snapshot: LivenessSnapshotV1
  ): Directive;
}

/**
 * Optional (W5). Playbooks that classify *why* a result was inadequate, so repair is
 * routed by cause rather than by bespoke per-playbook branching.
 *
 * The classification must be the same value the playbook itself acts on. Research
 * satisfies this by having its `validating` branch call `classifyGap` directly, which
 * makes the typed seam and the transition a single source of truth -- and therefore
 * behaviour-preserving by construction rather than by inspection.
 */
export interface HostContinuationRequestV1 {
  readonly kind: "host_continuation";
}

export type PlaybookStepOutcomeV1 = Directive | HostContinuationRequestV1;

export interface HostContinuationStepV1 {
  readonly event_type: string;
  readonly payload: Record<string, JsonValue>;
  readonly directive?: Directive;
  readonly after_checkpoint_fault?: string;
}

/** Optional deterministic owner work that runs only after accepted worker bytes are durable. */
export interface HostContinuationCapabilityV1 {
  needsHostContinuation(context: RunContext): boolean;
  continueHost(context: RunContext): HostContinuationStepV1;
  hostCheckpointCommitted?(context: RunContext, faultPoint: string): void;
}

export function hostContinuation(): HostContinuationRequestV1 {
  return { kind: "host_continuation" };
}

export function isHostContinuation(
  outcome: PlaybookStepOutcomeV1
): outcome is HostContinuationRequestV1 {
  return !("action" in outcome) && outcome.kind === "host_continuation";
}

export interface StateAwareRepairCapabilityV1 {
  /** `null` when the structurally valid result needs no typed repair. */
  evaluateRepair(
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): EvaluationResultV2 | null;
  /** Optional domain-data bookkeeping; engine control fields remain immutable. */
  repairBudgetUsed?(context: RunContext, state: string, evaluation: EvaluationResultV2): number;
  applyRepairBookkeeping?(
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>,
    evaluation: EvaluationResultV2,
    disposition: "repair" | "exhausted"
  ): void;
}

/** Optional honest terminalization for a registered repair route's exhausted successor. */
export interface RepairExhaustionCapabilityV1 {
  terminalizeRepairExhaustion(
    context: RunContext,
    state: string,
    evaluation: EvaluationResultV2
  ): Directive;
}

export interface GenericResponsePolicyCapabilityV1 {
  assertGenericResponseAllowed(context: RunContext): void;
}

export interface ExternalStartOperationGroupCapabilityV1 {
  externalStartOperationGroup(context: RunContext): ReserveOperationEventGroupInput | undefined;
}

export interface HostReviewedGateValidationCapabilityV1 {
  validateHostReviewedGate(context: RunContext, kind: "content_review" | "promotion"): void;
}

export interface ApprovedPromotionCompletionCapabilityV1 {
  completeApprovedPromotion(
    run: RunContext,
    outcome: {
      status: "complete" | "failed" | "blocked_external_drift";
      receiptId: string;
      receiptSha256: string;
      transactionId: string;
      targetCount: number;
      postApplyVerified: boolean;
    }
  ): Directive;
}

export interface ReviewInvalidationCapabilityV1 {
  invalidateReview(run: RunContext, reason: string): Directive;
}

/** A playbook plus whatever optional capabilities it happens to implement. */
export type PlaybookV1 = PlaybookCoreV1 &
  Partial<FanAggregateCapabilityV1> &
  Partial<RoutingRepairCapabilityV1> &
  Partial<LivenessTerminalCapabilityV1> &
  Partial<StateAwareRepairCapabilityV1> &
  Partial<RepairExhaustionCapabilityV1> &
  Partial<HostContinuationCapabilityV1> &
  Partial<GenericResponsePolicyCapabilityV1> &
  Partial<ExternalStartOperationGroupCapabilityV1> &
  Partial<HostReviewedGateValidationCapabilityV1> &
  Partial<ApprovedPromotionCompletionCapabilityV1> &
  Partial<ReviewInvalidationCapabilityV1>;

/**
 * Structural capability probes.
 *
 * Deliberately structural rather than nominal: the engine asks "can you aggregate?", never
 * "are you research?". Adding a playbook must never require an engine change.
 */
export function hasFanAggregate(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & FanAggregateCapabilityV1 {
  return typeof playbook.aggregateBranches === "function";
}

export function hasRoutingRepair(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & RoutingRepairCapabilityV1 {
  return typeof playbook.routingRepair === "function";
}

export function hasLivenessTerminal(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & LivenessTerminalCapabilityV1 {
  return typeof playbook.terminalizeLiveness === "function";
}

export function hasStateAwareRepair(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & StateAwareRepairCapabilityV1 {
  return typeof playbook.evaluateRepair === "function";
}

export function hasRepairExhaustion(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & RepairExhaustionCapabilityV1 {
  return typeof playbook.terminalizeRepairExhaustion === "function";
}

export function hasHostContinuation(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & HostContinuationCapabilityV1 {
  return (
    typeof playbook.needsHostContinuation === "function" &&
    typeof playbook.continueHost === "function"
  );
}

export function hasGenericResponsePolicy(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & GenericResponsePolicyCapabilityV1 {
  return typeof playbook.assertGenericResponseAllowed === "function";
}

export function hasExternalStartOperationGroup(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & ExternalStartOperationGroupCapabilityV1 {
  return typeof playbook.externalStartOperationGroup === "function";
}

export function hasHostReviewedGateValidation(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & HostReviewedGateValidationCapabilityV1 {
  return typeof playbook.validateHostReviewedGate === "function";
}

export function hasApprovedPromotionCompletion(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & ApprovedPromotionCompletionCapabilityV1 {
  return typeof playbook.completeApprovedPromotion === "function";
}

export function hasReviewInvalidation(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & ReviewInvalidationCapabilityV1 {
  return typeof playbook.invalidateReview === "function";
}

/** Host-owned receipt predicate. Predicate IDs are fixed by registrations, never model input. */
export interface CompletionReceiptPredicateInputV1 {
  readonly checkpointer: Checkpointer;
  readonly context: RunContext;
  readonly terminal: Extract<Directive, { result: Record<string, JsonValue> }>;
  readonly originState: string;
  readonly latestProduct: CompletionProductEvidence;
  readonly artifactReader?: ArtifactReader;
  readonly projectRoot: string;
  readonly pendingPhaseResult?: PhaseResult;
}

export interface CompletionReceiptPredicateResultV1 {
  readonly passed: boolean;
  readonly evidence_refs: readonly CompletionEvidenceRef[];
}

export type CompletionReceiptPredicateV1 = (
  input: CompletionReceiptPredicateInputV1
) => CompletionReceiptPredicateResultV1;

/**
 * Pure field-consumption seam for v2 origin/history/unresolved checks. Product and
 * receipt checks are engine-owned because they require exact durable indexes.
 */
export function evaluateCompletionGate(input: {
  gate: CompletionGate;
  terminalStatus: string;
  met: boolean;
  originState: string | null;
  visitedStates: readonly string[];
  unresolvedCount: number;
}): CompletionFailureCode[] {
  if (input.terminalStatus !== "complete" || !input.met) return [];
  const failures: CompletionFailureCode[] = [];
  if (
    input.originState === null ||
    !input.gate.allowed_terminal_origins.includes(input.originState)
  ) {
    failures.push("TERMINAL_ORIGIN_NOT_ALLOWED");
  }
  if (
    input.gate.required_visited_states.some((required) => !input.visitedStates.includes(required))
  ) {
    failures.push("REQUIRED_STATE_NOT_VISITED");
  }
  if (
    input.gate.unresolved_policy.mode === "max_count" &&
    input.unresolvedCount > input.gate.unresolved_policy.max_count
  ) {
    failures.push("UNRESOLVED_LIMIT_EXCEEDED");
  }
  return failures;
}
