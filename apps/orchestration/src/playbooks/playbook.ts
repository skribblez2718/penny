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
  CompletionGate,
  Confidence,
  Directive,
  EvaluationResult,
  JsonValue,
} from "../contracts.js";
import type { RunContext } from "../context.js";

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
  /** Validate a worker's result payload for one state. Throws on contract violation. */
  validateDetails(state: string, details: Record<string, JsonValue>): Record<string, JsonValue>;
  /** Fold an accepted result into the run and return the next directive. */
  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    confidence: Confidence
  ): Directive;
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
export interface MalformedReissueCapabilityV1 {
  reissueMalformedBranch(
    context: RunContext,
    pending: Extract<Directive, { action: "invoke_agents_parallel" }>,
    branchId: string
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
export interface GapClassificationCapabilityV1 {
  /** `null` when the result needs no repair. */
  classifyGap(
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): EvaluationResult | null;
}

/** A playbook plus whatever optional capabilities it happens to implement. */
export type PlaybookV1 = PlaybookCoreV1 &
  Partial<FanAggregateCapabilityV1> &
  Partial<MalformedReissueCapabilityV1> &
  Partial<GapClassificationCapabilityV1>;

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

export function hasMalformedReissue(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & MalformedReissueCapabilityV1 {
  return typeof playbook.reissueMalformedBranch === "function";
}

export function hasGapClassification(
  playbook: PlaybookV1
): playbook is PlaybookCoreV1 & GapClassificationCapabilityV1 {
  return typeof playbook.classifyGap === "function";
}

/**
 * W7 — evaluate a completion gate before the engine admits a `met: true` terminal.
 *
 * Returns `null` when the gate admits, or a reason string when it refuses.
 *
 * Only met terminals are gated. A cancelled or incomplete run is already an honest
 * negative outcome and must remain reachable from any state -- gating it would convert a
 * truthful failure into an error, which is the opposite of what this seam is for.
 */
export function evaluateCompletionGate(input: {
  gate: CompletionGate;
  terminalStatus: string;
  met: boolean;
  fromState: string | null;
  unresolvedCount: number;
}): string | null {
  if (!input.met) {
    return null;
  }
  const { gate } = input;
  if (gate.required_states.length > 0) {
    const from = input.fromState ?? "";
    if (!gate.required_states.includes(from)) {
      return `completion gate requires terminating from one of [${gate.required_states.join(", ")}], but the run terminated from '${from}'`;
    }
  }
  if (
    gate.unresolved_allowance !== undefined &&
    input.unresolvedCount > gate.unresolved_allowance
  ) {
    return `completion gate allows at most ${gate.unresolved_allowance} unresolved item(s); the run has ${input.unresolvedCount}`;
  }
  return null;
}
