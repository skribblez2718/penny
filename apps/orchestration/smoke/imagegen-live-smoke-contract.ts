/**
 * Pure, hermetic contract for the opt-in imagegen backend live smoke.
 *
 * This module never touches a backend, a model, the filesystem, or the environment: the live
 * runner and the default (provider-free) contract test both import it so the gate, the frozen
 * request constants, and the assertion vocabulary cannot drift apart.
 */

export const IMAGEGEN_LIVE_GATE_ENV = "PENNY_IMAGEGEN_LIVE" as const;
export const IMAGEGEN_LIVE_MANIFEST_ENV = "PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE" as const;

/** Fixed unsigned 32-bit base seed: slot 0's effective seed is this value exactly. */
export const IMAGEGEN_LIVE_SMOKE_SEED = 20_260_916 as const;

/**
 * Frozen smoke-only request. The backend smoke exists to prove one real submission travels the
 * registered host-operation path, so it is deliberately the smallest shape: one candidate, no
 * semantic repair, no export, a fixed seed, and no caller-selected dimensions.
 */
export const IMAGEGEN_LIVE_SMOKE_CONSTRAINTS = Object.freeze({
  schema_version: 1 as const,
  count: 1 as const,
  seed: IMAGEGEN_LIVE_SMOKE_SEED,
  max_revision_rounds: 0 as const,
  raw_prompt: null,
  dimensions: null,
  export: null,
});

export function imagegenLiveSmokeEnabled(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env[IMAGEGEN_LIVE_GATE_ENV] === "1";
}

export function assertImagegenLiveSmokeGate(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (!imagegenLiveSmokeEnabled(env)) {
    throw new Error(
      `Set ${IMAGEGEN_LIVE_GATE_ENV}=1 to authorize the live ComfyUI imagegen smoke.`
    );
  }
}

/**
 * Content-free observations collected by the live runner. No prompt, path, prompt ID, image byte,
 * or private profile value is representable here.
 */
export interface ImagegenBackendLiveSmokeObservationV1 {
  readonly terminal_action: string;
  readonly terminal_met: boolean;
  readonly readiness_operation_count: number;
  readonly generation_submission_count: number;
  readonly export_operation_count: number;
  readonly submitted_graph_count: number;
  readonly generated_image_count: number;
  readonly validation_receipt_count: number;
  readonly storage_reservation_receipt_count: number;
  readonly storage_release_receipt_count: number;
  readonly manifest_count: number;
  readonly slot_ledger_present: boolean;
  readonly slot_accepted: boolean;
  readonly quarantined_lease_count: number;
  readonly clean_shutdown: boolean;
}

export type ImagegenBackendLiveSmokeIssueCode =
  | "terminal_not_complete"
  | "terminal_not_met"
  | "readiness_count_not_one"
  | "submission_count_not_one"
  | "unexpected_export_operation"
  | "missing_submitted_graph"
  | "missing_sanitized_png"
  | "missing_validation_receipt"
  | "missing_storage_reservation_receipt"
  | "missing_storage_release_receipt"
  | "missing_manifest"
  | "missing_slot_ledger"
  | "slot_not_accepted"
  | "quarantined_lease"
  | "unclean_shutdown";

/** Deterministic, order-stable assertion vocabulary for the frozen live smoke. */
export function imagegenBackendLiveSmokeIssueCodes(
  observation: ImagegenBackendLiveSmokeObservationV1
): readonly ImagegenBackendLiveSmokeIssueCode[] {
  const issues: ImagegenBackendLiveSmokeIssueCode[] = [];
  if (observation.terminal_action !== "complete") issues.push("terminal_not_complete");
  if (!observation.terminal_met) issues.push("terminal_not_met");
  if (observation.readiness_operation_count !== 1) issues.push("readiness_count_not_one");
  if (observation.generation_submission_count !== 1) issues.push("submission_count_not_one");
  if (observation.export_operation_count !== 0) issues.push("unexpected_export_operation");
  if (observation.submitted_graph_count < 1) issues.push("missing_submitted_graph");
  if (observation.generated_image_count < 1) issues.push("missing_sanitized_png");
  if (observation.validation_receipt_count < 1) issues.push("missing_validation_receipt");
  if (observation.storage_reservation_receipt_count < 1) {
    issues.push("missing_storage_reservation_receipt");
  }
  if (observation.storage_release_receipt_count < 1) {
    issues.push("missing_storage_release_receipt");
  }
  if (observation.manifest_count < 1) issues.push("missing_manifest");
  if (!observation.slot_ledger_present) issues.push("missing_slot_ledger");
  else if (!observation.slot_accepted) issues.push("slot_not_accepted");
  if (observation.quarantined_lease_count !== 0) issues.push("quarantined_lease");
  if (!observation.clean_shutdown) issues.push("unclean_shutdown");
  return issues;
}
