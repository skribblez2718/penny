/**
 * Pure, hermetic contract for the opt-in imagegen live interruption/recovery experiment.
 *
 * This module never touches a backend, a model, the filesystem, or the environment. The live
 * recovery runner and the default (provider-free) contract test both import it, so the gate, the
 * frozen request, the required boundary vocabulary, and the recovery expectations cannot drift.
 *
 * Nothing here names an operator path or a private profile; the live runner receives the operator
 * manifest through `PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE` as a constraint at invocation time.
 */

export const IMAGEGEN_RECOVERY_LIVE_GATE_ENV = "PENNY_IMAGEGEN_RECOVERY_LIVE" as const;
export const IMAGEGEN_RECOVERY_LIVE_MANIFEST_ENV = "PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE" as const;

/** Fixed unsigned 32-bit base seed; slot 0's effective seed is this value exactly. */
export const IMAGEGEN_RECOVERY_LIVE_SEED = 20_260_918 as const;

/**
 * Frozen recovery-only request. The experiment qualifies durable host-operation recovery, so it is
 * deliberately the smallest shape: one candidate, no semantic repair, no export, a fixed seed.
 */
export const IMAGEGEN_RECOVERY_LIVE_CONSTRAINTS = Object.freeze({
  schema_version: 1 as const,
  count: 1 as const,
  seed: IMAGEGEN_RECOVERY_LIVE_SEED,
  max_revision_rounds: 0 as const,
  raw_prompt: null,
  dimensions: null,
  export: null,
});

/**
 * The six boundaries the PRD requires the recovery experiment to exercise, in order. They are the
 * durable host-operation milestones where an interruption must not silently duplicate remote work.
 */
export const IMAGEGEN_RECOVERY_BOUNDARIES = Object.freeze([
  "before_submit",
  "after_submit_before_prompt_id_checkpoint",
  "after_prompt_id_checkpoint",
  "after_fetch",
  "after_artifact_persist",
  "before_routing",
] as const);

export type ImagegenRecoveryBoundaryV1 = (typeof IMAGEGEN_RECOVERY_BOUNDARIES)[number];

/**
 * Maps each required boundary to the generic, host-owned crash-seam point it uses. The seam is a
 * construction-time capability of the host-operation owner; no caller, model, request, or
 * directive can name one of these points.
 */
export const IMAGEGEN_RECOVERY_BOUNDARY_FAULT_POINT = Object.freeze({
  before_submit: "before_submit",
  after_submit_before_prompt_id_checkpoint: "after_submit_before_remote_checkpoint",
  after_prompt_id_checkpoint: "after_remote_checkpoint",
  after_fetch: "after_fetch",
  after_artifact_persist: "after_persist",
  before_routing: "before_consume",
} as const);

export interface ImagegenRecoveryExpectationV1 {
  readonly durable_lifecycle_at_interrupt: string;
  readonly remote_correlation_recorded_at_interrupt: boolean;
  readonly resubmitted_after_recovery: boolean;
  readonly terminal_outcome_after_recovery: string;
  readonly lease_disposition_after_recovery: string;
}

/**
 * Documented recovery disposition per boundary:
 * - before submit: proven non-acceptance, so the lease releases and recovery may resubmit;
 * - after submit before the prompt-ID checkpoint: ambiguous acceptance, so the backend lease
 *   quarantines and the run terminates `remote_unknown` without resubmitting;
 * - after the prompt-ID checkpoint and every later milestone: the exact operation is adopted
 *   (re-fetched/persisted/consumed) with no new submission.
 */
export const IMAGEGEN_RECOVERY_EXPECTATIONS: Readonly<
  Record<ImagegenRecoveryBoundaryV1, ImagegenRecoveryExpectationV1>
> = Object.freeze({
  before_submit: Object.freeze({
    durable_lifecycle_at_interrupt: "lease_acquired",
    remote_correlation_recorded_at_interrupt: false,
    resubmitted_after_recovery: true,
    terminal_outcome_after_recovery: "completed",
    lease_disposition_after_recovery: "released",
  }),
  after_submit_before_prompt_id_checkpoint: Object.freeze({
    durable_lifecycle_at_interrupt: "submitting",
    remote_correlation_recorded_at_interrupt: false,
    resubmitted_after_recovery: false,
    terminal_outcome_after_recovery: "remote_unknown",
    lease_disposition_after_recovery: "quarantined",
  }),
  after_prompt_id_checkpoint: Object.freeze({
    durable_lifecycle_at_interrupt: "submitted",
    remote_correlation_recorded_at_interrupt: true,
    resubmitted_after_recovery: false,
    terminal_outcome_after_recovery: "completed",
    lease_disposition_after_recovery: "released",
  }),
  after_fetch: Object.freeze({
    durable_lifecycle_at_interrupt: "fetched",
    remote_correlation_recorded_at_interrupt: true,
    resubmitted_after_recovery: false,
    terminal_outcome_after_recovery: "completed",
    lease_disposition_after_recovery: "released",
  }),
  after_artifact_persist: Object.freeze({
    durable_lifecycle_at_interrupt: "verified",
    remote_correlation_recorded_at_interrupt: true,
    resubmitted_after_recovery: false,
    terminal_outcome_after_recovery: "completed",
    lease_disposition_after_recovery: "released",
  }),
  before_routing: Object.freeze({
    durable_lifecycle_at_interrupt: "settled",
    remote_correlation_recorded_at_interrupt: true,
    resubmitted_after_recovery: false,
    terminal_outcome_after_recovery: "completed",
    lease_disposition_after_recovery: "released",
  }),
});

export interface ImagegenRecoveryBoundaryObservationV1 {
  readonly boundary: ImagegenRecoveryBoundaryV1;
  readonly durable_lifecycle_at_interrupt: string;
  readonly remote_correlation_recorded_at_interrupt: boolean;
  readonly resubmitted_after_recovery: boolean;
  readonly terminal_outcome_after_recovery: string;
  readonly lease_disposition_after_recovery: string;
}

export type ImagegenRecoveryIssueCode =
  | "boundary_missing"
  | "boundary_duplicated"
  | "durable_lifecycle_mismatch"
  | "remote_correlation_mismatch"
  | "resubmission_mismatch"
  | "terminal_outcome_mismatch"
  | "lease_disposition_mismatch";

export function imagegenRecoveryLiveEnabled(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env[IMAGEGEN_RECOVERY_LIVE_GATE_ENV] === "1";
}

export function assertImagegenRecoveryLiveGate(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (!imagegenRecoveryLiveEnabled(env)) {
    throw new Error(
      `Set ${IMAGEGEN_RECOVERY_LIVE_GATE_ENV}=1 to authorize the live imagegen recovery experiment.`
    );
  }
}

/**
 * Deterministic, order-stable assertion vocabulary. It requires every boundary exactly once and
 * every observation to match the documented recovery disposition, so a partially exercised or
 * permissive run cannot pass.
 */
export function imagegenRecoveryIssueCodes(
  observations: readonly ImagegenRecoveryBoundaryObservationV1[]
): readonly string[] {
  const issues: string[] = [];
  const seen = new Map<ImagegenRecoveryBoundaryV1, number>();
  for (const observation of observations) {
    seen.set(observation.boundary, (seen.get(observation.boundary) ?? 0) + 1);
  }
  for (const boundary of IMAGEGEN_RECOVERY_BOUNDARIES) {
    const count = seen.get(boundary) ?? 0;
    if (count === 0) issues.push(`${boundary}:boundary_missing`);
    else if (count > 1) issues.push(`${boundary}:boundary_duplicated`);
  }
  for (const observation of observations) {
    const expected = IMAGEGEN_RECOVERY_EXPECTATIONS[observation.boundary];
    if (observation.durable_lifecycle_at_interrupt !== expected.durable_lifecycle_at_interrupt) {
      issues.push(`${observation.boundary}:durable_lifecycle_mismatch`);
    }
    if (
      observation.remote_correlation_recorded_at_interrupt !==
      expected.remote_correlation_recorded_at_interrupt
    ) {
      issues.push(`${observation.boundary}:remote_correlation_mismatch`);
    }
    if (observation.resubmitted_after_recovery !== expected.resubmitted_after_recovery) {
      issues.push(`${observation.boundary}:resubmission_mismatch`);
    }
    if (observation.terminal_outcome_after_recovery !== expected.terminal_outcome_after_recovery) {
      issues.push(`${observation.boundary}:terminal_outcome_mismatch`);
    }
    if (
      observation.lease_disposition_after_recovery !== expected.lease_disposition_after_recovery
    ) {
      issues.push(`${observation.boundary}:lease_disposition_mismatch`);
    }
  }
  return issues;
}
