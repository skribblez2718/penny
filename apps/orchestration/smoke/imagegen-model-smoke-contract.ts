/**
 * Pure, hermetic contract for the opt-in imagegen multimodal critic live smoke.
 *
 * No model, image, filesystem, or network dependency lives here. The live runner
 * and the default provider-free contract test share this module so the gate, the fixture-set
 * sizes, and the evidence/coverage vocabulary cannot drift.
 */

export const IMAGEGEN_MODEL_SMOKE_GATE_ENV = "PENNY_IMAGEGEN_MODEL_SMOKE" as const;

/** The production default candidate count and the hard maximum the review shape must carry. */
export const IMAGEGEN_MODEL_SMOKE_DEFAULT_COUNT = 3 as const;
export const IMAGEGEN_MODEL_SMOKE_MAXIMUM_COUNT = 10 as const;

export function imagegenModelSmokeEnabled(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env[IMAGEGEN_MODEL_SMOKE_GATE_ENV] === "1";
}

export function assertImagegenModelSmokeGate(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (!imagegenModelSmokeEnabled(env)) {
    throw new Error(
      `Set ${IMAGEGEN_MODEL_SMOKE_GATE_ENV}=1 to authorize the live imagegen multimodal critic smoke.`
    );
  }
}

/** One captured Pi image content block delivered to one registered critic worker. */
export interface ImageDeliveryEvidenceV1 {
  readonly worker: string;
  readonly artifact_id: string;
  readonly mime_type: string;
  readonly image_block: boolean;
}

/**
 * Per-worker delivery observation. `delivered` is the set of exact artifact IDs for which a Pi
 * image content block reached that worker's provider request.
 */
export interface CriticDeliveryObservationV1 {
  readonly worker: string;
  readonly expected_artifact_ids: readonly string[];
  readonly delivered_artifact_ids: readonly string[];
  readonly delivered_mime_types: readonly string[];
}

export type CriticDeliveryIssueCode =
  | "worker_is_not_a_registered_critic"
  | "missing_image_delivery"
  | "unexpected_image_delivery"
  | "delivered_non_png_image"
  | "text_only_delivery";

export function criticDeliveryIssueCodes(
  observation: CriticDeliveryObservationV1
): readonly CriticDeliveryIssueCode[] {
  const issues: CriticDeliveryIssueCode[] = [];
  if (observation.worker !== "vera" && observation.worker !== "carren") {
    issues.push("worker_is_not_a_registered_critic");
  }
  const expected = new Set(observation.expected_artifact_ids);
  const delivered = new Set(observation.delivered_artifact_ids);
  if ([...expected].some((id) => !delivered.has(id))) issues.push("missing_image_delivery");
  if ([...delivered].some((id) => !expected.has(id))) issues.push("unexpected_image_delivery");
  if (observation.delivered_mime_types.some((mime) => mime !== "image/png")) {
    issues.push("delivered_non_png_image");
  }
  if (observation.delivered_artifact_ids.length === 0) issues.push("text_only_delivery");
  return issues;
}

/**
 * Report coverage observation for one critic's structured report over the active review epoch.
 * Revision keys are canonical `slot|revision|artifact_id|sha256` identities.
 */
export interface CriticReportCoverageObservationV1 {
  readonly worker: string;
  readonly expected_epoch: number;
  readonly report_epoch: number;
  readonly expected_revision_keys: readonly string[];
  readonly reported_revision_keys: readonly string[];
  readonly ranked_revision_keys?: readonly string[];
}

export type CriticReportIssueCode =
  | "worker_is_not_a_registered_critic"
  | "review_epoch_mismatch"
  | "candidate_coverage_mismatch"
  | "ranking_coverage_mismatch";

export function criticReportIssueCodes(
  observation: CriticReportCoverageObservationV1
): readonly CriticReportIssueCode[] {
  const issues: CriticReportIssueCode[] = [];
  if (observation.worker !== "vera" && observation.worker !== "carren") {
    issues.push("worker_is_not_a_registered_critic");
  }
  if (observation.report_epoch !== observation.expected_epoch) {
    issues.push("review_epoch_mismatch");
  }
  const expected = [...observation.expected_revision_keys].sort().join("\u0000");
  const reported = [...observation.reported_revision_keys].sort().join("\u0000");
  if (expected !== reported) issues.push("candidate_coverage_mismatch");
  if (observation.ranked_revision_keys !== undefined) {
    const ranked = [...observation.ranked_revision_keys].sort().join("\u0000");
    if (expected !== ranked) issues.push("ranking_coverage_mismatch");
  }
  return issues;
}
