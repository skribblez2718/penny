import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import { SCA_REQUIRED_MODEL_PROFILES } from "./agent-models.js";

const MAX_CANDIDATES = 100_000;
const MAX_FILES = 100_000;
const MAX_TARGETS = 20_000;
const MAX_TEXT = 8_192;
const MAX_PATH = 4_096;
const MAX_ITEMS = 1_024;

export const SCA_DEEP_ANALYSIS_PLAN_INPUT_SCHEMA = "penny.sca-deep-analysis-plan-input.v1";
export const SCA_DEEP_ANALYSIS_PLAN_SCHEMA = "penny.sca-deep-analysis-plan.v1";
export const SCA_CANDIDATE_ANALYSIS_RESULT_SCHEMA = "penny.sca-candidate-analysis-result.v1";

const ScaModelProfileIdV1Schema = Type.Union([
  Type.Literal("primary_a"),
  Type.Literal("primary_b"),
  Type.Literal("critic"),
]);

const CanonicalSourcePathSchema = Type.String({ minLength: 1, maxLength: MAX_PATH });

export const ScaDeepAnalysisPlanInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_DEEP_ANALYSIS_PLAN_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m1_manifest_sha256: Sha256Schema,
    model_registry_sha256: Sha256Schema,
    candidate_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_CANDIDATES }),
    required_files: Type.Array(CanonicalSourcePathSchema, { maxItems: MAX_FILES }),
    max_candidates_per_target: Type.Integer({ minimum: 1, maximum: 100 }),
    max_files_per_target: Type.Integer({ minimum: 1, maximum: 100 }),
  },
  { additionalProperties: false }
);

const ScaDeepAnalysisTargetV1Schema = Type.Object(
  {
    target_id: Type.String({ pattern: "^scatarget_[a-f0-9]{64}$" }),
    target_kind: Type.Union([Type.Literal("candidate_batch"), Type.Literal("source_file_batch")]),
    candidate_ids: Type.Array(OpaqueIdSchema, { maxItems: 100 }),
    required_files: Type.Array(CanonicalSourcePathSchema, { maxItems: 100 }),
    required_profiles: Type.Array(ScaModelProfileIdV1Schema, {
      minItems: 3,
      maxItems: 3,
    }),
  },
  { additionalProperties: false }
);

export const ScaDeepAnalysisPlanV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_DEEP_ANALYSIS_PLAN_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m1_manifest_sha256: Sha256Schema,
    model_registry_sha256: Sha256Schema,
    candidate_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_CANDIDATES }),
    required_files: Type.Array(CanonicalSourcePathSchema, { maxItems: MAX_FILES }),
    targets: Type.Array(ScaDeepAnalysisTargetV1Schema, { maxItems: MAX_TARGETS }),
    plan_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ScaEvidenceClaimV1Schema = Type.Object(
  {
    path: CanonicalSourcePathSchema,
    start_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    end_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    evidence_sha256: Sha256Schema,
    claim: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

const ScaRequestedActionV1Schema = Type.Object(
  {
    action_type: Type.Union([
      Type.Literal("build"),
      Type.Literal("test"),
      Type.Literal("harness"),
      Type.Literal("proof_of_concept"),
    ]),
    justification: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    expected_discriminator: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    required_capability: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false }
);

const ScaCandidateVerdictV1Schema = Type.Object(
  {
    candidate_id: OpaqueIdSchema,
    disposition: Type.Union([
      Type.Literal("confirmed"),
      Type.Literal("rejected"),
      Type.Literal("inconclusive"),
    ]),
    severity: Type.Union([
      Type.Literal("critical"),
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
      Type.Literal("informational"),
      Type.Literal("unknown"),
    ]),
    reachability: Type.Union([
      Type.Literal("reachable"),
      Type.Literal("unreachable"),
      Type.Literal("unknown"),
    ]),
    confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    rationale: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    remediation: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    evidence: Type.Array(ScaEvidenceClaimV1Schema, { maxItems: MAX_ITEMS }),
    gaps: Type.Array(Type.String({ minLength: 1, maxLength: MAX_TEXT }), {
      maxItems: MAX_ITEMS,
    }),
    requested_actions: Type.Array(ScaRequestedActionV1Schema, { maxItems: MAX_ITEMS }),
  },
  { additionalProperties: false }
);

const ScaDiscoveredCandidateV1Schema = Type.Object(
  {
    ...ScaCandidateVerdictV1Schema.properties,
    candidate_id: Type.String({ pattern: "^scadisc_[a-f0-9]{64}$" }),
    path: CanonicalSourcePathSchema,
    start_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    end_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    weakness_id: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  },
  { additionalProperties: false }
);

const ScaFileAssessmentV1Schema = Type.Object(
  {
    path: CanonicalSourcePathSchema,
    coverage: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("failed"),
    ]),
    discovered_candidates: Type.Array(ScaDiscoveredCandidateV1Schema, {
      maxItems: MAX_ITEMS,
    }),
    gaps: Type.Array(Type.String({ minLength: 1, maxLength: MAX_TEXT }), {
      maxItems: MAX_ITEMS,
    }),
  },
  { additionalProperties: false }
);

export const ScaCandidateAnalysisResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_CANDIDATE_ANALYSIS_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m1_manifest_sha256: Sha256Schema,
    plan_sha256: Sha256Schema,
    target_id: Type.String({ pattern: "^scatarget_[a-f0-9]{64}$" }),
    profile_id: ScaModelProfileIdV1Schema,
    model_admission_sha256: Sha256Schema,
    reviewed_result_sha256s: Type.Array(Sha256Schema, { maxItems: 2 }),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("partial"),
      Type.Literal("failed"),
    ]),
    candidate_verdicts: Type.Array(ScaCandidateVerdictV1Schema, { maxItems: 100 }),
    file_assessments: Type.Array(ScaFileAssessmentV1Schema, { maxItems: 100 }),
    failure_code: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    result_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaDeepAnalysisPlanInputV1 = Static<typeof ScaDeepAnalysisPlanInputV1Schema>;
export type ScaDeepAnalysisPlanV1 = Static<typeof ScaDeepAnalysisPlanV1Schema>;
export type ScaCandidateAnalysisResultV1 = Static<typeof ScaCandidateAnalysisResultV1Schema>;

type UnsignedPlan = Omit<ScaDeepAnalysisPlanV1, "plan_sha256">;
type UnsignedResult = Omit<ScaCandidateAnalysisResultV1, "result_sha256">;

export class ScaDeepAnalysisContractError extends Error {
  constructor(
    readonly code:
      | "invalid_plan_input"
      | "candidate_collision"
      | "file_collision"
      | "unsafe_path"
      | "plan_digest_mismatch"
      | "invalid_result"
      | "result_digest_mismatch"
      | "binding_mismatch"
      | "coverage_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaDeepAnalysisContractError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validatePath(candidate: string): void {
  const segments = candidate.split("/");
  if (
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/u.test(candidate) ||
    candidate !== candidate.normalize("NFC") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ScaDeepAnalysisContractError(
      "unsafe_path",
      "SCA deep-analysis path is not canonical"
    );
  }
}

function uniqueSorted(
  values: readonly string[],
  collisionCode: "candidate_collision" | "file_collision"
): string[] {
  if (new Set(values).size !== values.length) {
    throw new ScaDeepAnalysisContractError(
      collisionCode,
      "SCA deep-analysis inputs must be unique"
    );
  }
  return [...values].sort(compareUtf8);
}

function chunks<T>(values: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function target(
  runId: string,
  kind: ScaDeepAnalysisPlanV1["targets"][number]["target_kind"],
  candidateIds: readonly string[],
  requiredFiles: readonly string[]
): ScaDeepAnalysisPlanV1["targets"][number] {
  const identity = {
    run_id: runId,
    target_kind: kind,
    candidate_ids: candidateIds,
    required_files: requiredFiles,
  };
  return {
    target_id: `scatarget_${sha256(canonicalJson(identity))}`,
    target_kind: kind,
    candidate_ids: [...candidateIds],
    required_files: [...requiredFiles],
    required_profiles: [...SCA_REQUIRED_MODEL_PROFILES],
  };
}

function planDigest(value: UnsignedPlan): string {
  return sha256(canonicalJson(value));
}

function resultDigest(value: UnsignedResult): string {
  return sha256(canonicalJson(value));
}

export function scaDiscoveredCandidateId(value: {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly weakness_id: string | null;
}): string {
  return `scadisc_${sha256(
    canonicalJson({
      path: value.path,
      start_line: value.start_line,
      end_line: value.end_line,
      weakness_id: value.weakness_id,
    })
  )}`;
}

export function buildScaDeepAnalysisPlanV1(value: unknown): ScaDeepAnalysisPlanV1 {
  let input: ScaDeepAnalysisPlanInputV1;
  try {
    input = validateContract(
      ScaDeepAnalysisPlanInputV1Schema,
      value,
      "SCA deep-analysis plan input"
    );
  } catch (error) {
    throw new ScaDeepAnalysisContractError(
      "invalid_plan_input",
      error instanceof Error ? error.message : "SCA deep-analysis plan input is invalid"
    );
  }
  const candidateIds = uniqueSorted(input.candidate_ids, "candidate_collision");
  const requiredFiles = uniqueSorted(input.required_files, "file_collision");
  for (const file of requiredFiles) validatePath(file);
  const targets = [
    ...chunks(candidateIds, input.max_candidates_per_target).map((candidateChunk) =>
      target(input.run_id, "candidate_batch", candidateChunk, [])
    ),
    ...chunks(requiredFiles, input.max_files_per_target).map((fileChunk) =>
      target(input.run_id, "source_file_batch", [], fileChunk)
    ),
  ];
  if (targets.length > MAX_TARGETS) {
    throw new ScaDeepAnalysisContractError(
      "invalid_plan_input",
      "SCA deep-analysis target limit exceeded"
    );
  }
  const unsigned: UnsignedPlan = {
    schema_id: SCA_DEEP_ANALYSIS_PLAN_SCHEMA,
    schema_version: 1,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: input.run_id,
    source_snapshot_sha256: input.source_snapshot_sha256,
    m1_manifest_sha256: input.m1_manifest_sha256,
    model_registry_sha256: input.model_registry_sha256,
    candidate_ids: candidateIds,
    required_files: requiredFiles,
    targets,
  };
  return validateContract(
    ScaDeepAnalysisPlanV1Schema,
    { ...unsigned, plan_sha256: planDigest(unsigned) },
    "SCA deep-analysis plan"
  );
}

export function validateScaDeepAnalysisPlanV1(value: unknown): ScaDeepAnalysisPlanV1 {
  const plan = validateContract(ScaDeepAnalysisPlanV1Schema, value, "SCA deep-analysis plan");
  const { plan_sha256: observedDigest, ...unsigned } = plan;
  if (planDigest(unsigned) !== observedDigest) {
    throw new ScaDeepAnalysisContractError(
      "plan_digest_mismatch",
      "SCA deep-analysis plan digest mismatch"
    );
  }
  const assignedCandidates = plan.targets.flatMap((entry) => entry.candidate_ids).sort(compareUtf8);
  const assignedFiles = plan.targets.flatMap((entry) => entry.required_files).sort(compareUtf8);
  if (
    canonicalJson(assignedCandidates) !== canonicalJson(plan.candidate_ids) ||
    canonicalJson(assignedFiles) !== canonicalJson(plan.required_files)
  ) {
    throw new ScaDeepAnalysisContractError(
      "coverage_mismatch",
      "SCA deep-analysis plan does not cover its exact candidate and file sets"
    );
  }
  for (const entry of plan.targets) {
    if (
      entry.candidate_ids.length + entry.required_files.length === 0 ||
      canonicalJson([...entry.required_profiles].sort(compareUtf8)) !==
        canonicalJson([...SCA_REQUIRED_MODEL_PROFILES].sort(compareUtf8))
    ) {
      throw new ScaDeepAnalysisContractError(
        "coverage_mismatch",
        "SCA deep-analysis target is empty or lacks the required profile set"
      );
    }
  }
  return plan;
}

export function sealScaCandidateAnalysisResultV1(
  value: Omit<ScaCandidateAnalysisResultV1, "result_sha256">
): ScaCandidateAnalysisResultV1 {
  let input: Omit<ScaCandidateAnalysisResultV1, "result_sha256">;
  try {
    input = validateContract(
      Type.Omit(ScaCandidateAnalysisResultV1Schema, ["result_sha256"]),
      value,
      "SCA candidate analysis result input"
    );
  } catch (error) {
    throw new ScaDeepAnalysisContractError(
      "invalid_result",
      error instanceof Error ? error.message : "SCA candidate analysis result input is invalid"
    );
  }
  if (
    (input.status === "completed" && input.failure_code !== null) ||
    (input.status !== "completed" && input.failure_code === null)
  ) {
    throw new ScaDeepAnalysisContractError(
      "invalid_result",
      "SCA candidate analysis status and failure code are inconsistent"
    );
  }
  if (
    (input.profile_id === "critic" &&
      (input.reviewed_result_sha256s.length !== 2 ||
        new Set(input.reviewed_result_sha256s).size !== 2)) ||
    (input.profile_id !== "critic" && input.reviewed_result_sha256s.length !== 0)
  ) {
    throw new ScaDeepAnalysisContractError(
      "invalid_result",
      "SCA critic must bind exactly two distinct primary results and primaries must bind none"
    );
  }
  const candidateIds = input.candidate_verdicts.map((verdict) => verdict.candidate_id);
  const filePaths = input.file_assessments.map((assessment) => assessment.path);
  uniqueSorted(candidateIds, "candidate_collision");
  uniqueSorted(filePaths, "file_collision");
  for (const verdict of input.candidate_verdicts) {
    for (const evidence of verdict.evidence) {
      validatePath(evidence.path);
      if (evidence.end_line < evidence.start_line) {
        throw new ScaDeepAnalysisContractError(
          "invalid_result",
          "SCA evidence line range is inverted"
        );
      }
    }
  }
  for (const assessment of input.file_assessments) {
    validatePath(assessment.path);
    const discoveredIds = new Set<string>();
    for (const discovered of assessment.discovered_candidates) {
      validatePath(discovered.path);
      if (
        discovered.path !== assessment.path ||
        discovered.end_line < discovered.start_line ||
        discovered.candidate_id !== scaDiscoveredCandidateId(discovered) ||
        discoveredIds.has(discovered.candidate_id)
      ) {
        throw new ScaDeepAnalysisContractError(
          "invalid_result",
          "SCA discovered candidate identity, location, or uniqueness is invalid"
        );
      }
      discoveredIds.add(discovered.candidate_id);
    }
  }
  const unsigned: UnsignedResult = { ...input };
  return validateContract(
    ScaCandidateAnalysisResultV1Schema,
    { ...unsigned, result_sha256: resultDigest(unsigned) },
    "SCA candidate analysis result"
  );
}

export function validateScaCandidateAnalysisResultV1(value: unknown): ScaCandidateAnalysisResultV1 {
  let result: ScaCandidateAnalysisResultV1;
  try {
    result = validateContract(
      ScaCandidateAnalysisResultV1Schema,
      value,
      "SCA candidate analysis result"
    );
  } catch (error) {
    throw new ScaDeepAnalysisContractError(
      "invalid_result",
      error instanceof Error ? error.message : "SCA candidate analysis result is invalid"
    );
  }
  const { result_sha256: observedDigest, ...unsigned } = result;
  if (resultDigest(unsigned) !== observedDigest) {
    throw new ScaDeepAnalysisContractError(
      "result_digest_mismatch",
      "SCA candidate analysis result digest mismatch"
    );
  }
  return sealScaCandidateAnalysisResultV1(unsigned);
}
