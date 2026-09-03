import { Type, type Static } from "typebox";

import {
  PLAN_CANDIDATE_REGISTRATION,
  PLAN_EVALUATION_ABLATION_REGISTRY,
  PLAN_LIFECYCLE_STATUS,
  PLAN_LIVENESS_POLICY,
  PLAN_PLAYBOOK_NAME,
  PLAN_UNSEALED_EVALUATION_NAME,
  StrategyDraftValidationError,
  StrategySemanticProjectionV1Schema,
  canonicalJson,
  canonicalizePlanRequest,
  parseStrategyDraft,
  planRequestItemIds,
  projectStrategyDraft,
  sha256,
  validateContract,
  validateStrategy,
  type PlanRequestV1,
  type PlaybookRegistryV1,
  type StrategyDraftV1,
  type StrategySemanticProjectionV1,
  type StrategyV1,
} from "@penny/orchestration/source";

import type {
  EvaluationPopulationV1,
  EvaluationPurposeV1,
  SemanticClauseResultV1,
} from "./evaluation-contracts.js";
import {
  Q4_ORACLE_REVIEW_CLAUSE_IDS,
  assertSemanticReviewEvidenceBinding,
  buildSemanticOracleReviewPacketV1,
  buildSemanticTrialReviewPacketV1,
  type SemanticOracleReviewPacketV1,
  type SemanticTrialReviewPacketV1,
  type VerifiedSemanticReviewEvidenceV1,
} from "./evaluation-semantic-review.js";
import {
  PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2,
  PlanSemanticRequestProjectionV1Schema,
  PlanStructuredExpectationsV2Schema,
  StrategyEvaluationV2Schema,
  createPlanSemanticOracleProjectionV2,
  createPlanSemanticTrialProjectionV2,
  type PlanSemanticRequestProjectionV1,
  type SemanticOracleContaminationAttestationV1,
  type SemanticOracleDerivationAttestationV1,
  type StrategyEvaluationV2,
} from "./evaluation-semantic-projections.js";
import {
  createDirectAgentBaselineRegistration,
  type DeterministicGraderDescriptorV1,
  type DeterministicGraderImplementationV1,
  type EvaluationCommonWireValidatorV1,
  type EvaluationGradingDefinitionV1,
  type EvaluationSemanticNormalizerDescriptorV1,
  type EvaluationSemanticNormalizerImplementationV1,
  type EvaluationSemanticNormalizationV1,
  type EvaluationSemanticWireV1,
} from "./evaluation-runner.js";

export const DIRECT_PIPER_PLAN_BASELINE_NAME = "evaluation-direct-piper-plan";
export const PLAN_CONTRACT_GRADER_ID = "penny.plan-contract-grader.v1";
export const PLAN_KNOWN_DELTA_GRADER_ID = "penny.plan-known-delta-grader.v1";
export const PLAN_EVALUATION_LIFECYCLE = PLAN_LIFECYCLE_STATUS;

/**
 * Complete Plan behavior surface. The generic binding supplies exact file-byte,
 * registration, function, construction-probe, grading, and runtime-schema
 * descriptors; Plan adds this closed material-file coverage assertion so a
 * generic minimum-role check cannot silently omit a Plan-specific surface.
 */
export const PLAN_REQUIRED_IMPLEMENTATION_FILE_PATHS = [
  ".pi/agents/carren.md",
  ".pi/agents/echo.md",
  ".pi/agents/piper.md",
  ".pi/agents/vera.md",
  ".pi/extensions/artifacts/artifact-runtime.ts",
  ".pi/extensions/skill/evaluation-contracts.ts",
  ".pi/extensions/skill/evaluation-local-live.ts",
  ".pi/extensions/skill/evaluation-runner.ts",
  ".pi/extensions/skill/evaluation-semantic-projections.ts",
  ".pi/extensions/skill/evaluation-semantic-review.ts",
  ".pi/extensions/skill/plan-evaluation.ts",
  ".pi/extensions/skill/tests/e2e/plan-known-delta.e2e.test.ts",
  ".pi/skills/plan/SKILL.md",
  ".pi/skills/plan/assets/prompts/carren-critiquing_strategy.md",
  ".pi/skills/plan/assets/prompts/echo-gathering_strategy_evidence.md",
  ".pi/skills/plan/assets/prompts/piper-orienting_strategy.md",
  ".pi/skills/plan/assets/prompts/piper-strategizing.md",
  ".pi/skills/plan/assets/prompts/vera-verifying_strategy.md",
  "apps/orchestration/src/artifact-store.ts",
  "apps/orchestration/src/checkpointer.ts",
  "apps/orchestration/src/composition.ts",
  "apps/orchestration/src/contracts.ts",
  "apps/orchestration/src/engine.ts",
  "apps/orchestration/src/model-client.ts",
  "apps/orchestration/src/playbooks/plan.ts",
  "apps/orchestration/src/playbooks/playbook.ts",
  "apps/orchestration/src/service.ts",
  "apps/orchestration/src/skill-contracts/common.ts",
  "apps/orchestration/src/skill-contracts/decide.ts",
  "apps/orchestration/src/skill-contracts/plan.ts",
  "apps/orchestration/src/skill-contracts/research.ts",
  "apps/orchestration/src/skill-contracts/review.ts",
  "apps/orchestration/src/worker.ts",
  "evals/guidance/plan/piper-strategizing.md",
] as const;

export function assertPlanImplementationFileCoverage(
  files: readonly { readonly path: string }[]
): void {
  const bound = new Set(files.map((file) => file.path));
  const missing = PLAN_REQUIRED_IMPLEMENTATION_FILE_PATHS.filter((file) => !bound.has(file));
  if (missing.length > 0) {
    throw new Error(`Plan implementation binding omits material file(s): ${missing.join(", ")}`);
  }
}

export const DIRECT_PIPER_PLAN_BASELINE_REGISTRATION = createDirectAgentBaselineRegistration({
  registrationName: DIRECT_PIPER_PLAN_BASELINE_NAME,
  agent: "piper",
  phase: "strategizing",
  guidance: {
    skill_root: "evals/guidance/plan",
    resolution: "per_agent_phase",
  },
  output: {
    portName: "direct_strategy_draft",
    artifactKind: "strategy-draft",
    schemaId: "penny.strategy-draft.v1",
    schemaVersion: 1,
    mediaType: "text/plain; charset=utf-8",
  },
  liveness: {
    resolverId: "planLivenessPolicy",
    policy: PLAN_LIVENESS_POLICY,
  },
  allowedTools: ["artifact_read"],
});

export const PLAN_EVALUATION_CANDIDATE_REGISTRY: PlaybookRegistryV1 = new Map([
  [PLAN_CANDIDATE_REGISTRATION.name, PLAN_CANDIDATE_REGISTRATION],
]);
export { PLAN_EVALUATION_ABLATION_REGISTRY };

export const STRATEGY_GRADING_WIRE: EvaluationSemanticWireV1 = {
  schema_id: "penny.strategy-evaluation.v1",
  schema_version: 1,
};

export const StrategyEvaluationV1Schema = StrategySemanticProjectionV1Schema;
export type StrategyEvaluationV1 = StrategySemanticProjectionV1;
export type StrategyGradingWireV1 = StrategyEvaluationV1;

/**
 * Additive correctness-first semantic wire. Historical Plan Part-B V1 bytes
 * and controls remain on the V1 surface above. This wire intentionally omits
 * execution, transport, provenance, arm, receipt, artifact, and performance
 * metadata; no omitted field may be reconstructed by a semantic grader.
 */
export const STRATEGY_SEMANTIC_GRADING_WIRE_V2: EvaluationSemanticWireV1 = {
  schema_id: "penny.strategy-semantic-evaluation.v2",
  schema_version: 2,
};

export const PLAN_SEMANTIC_V2_FIELD_NAMES = [
  "applicability_reason",
  "blockers",
  "confidence",
  "dependencies",
  "disposition",
  "outcomes",
  "request_coverage",
  "schema_version",
  "strategy_report",
] as const;

export { StrategyEvaluationV2Schema };
export type { StrategyEvaluationV2 };

function strategySemanticEvaluationV2(input: {
  readonly semantic: StrategySemanticProjectionV1;
  readonly strategyReport: string;
}): StrategyEvaluationV2 {
  return validateContract(
    StrategyEvaluationV2Schema,
    {
      schema_version: 2,
      disposition: input.semantic.disposition,
      applicability_reason: input.semantic.applicability_reason,
      outcomes: input.semantic.outcomes,
      dependencies: input.semantic.dependencies,
      request_coverage: input.semantic.request_coverage,
      blockers: input.semantic.blockers,
      confidence: input.semantic.confidence,
      strategy_report: input.strategyReport,
    },
    "projected StrategyEvaluationV2"
  );
}

export function projectStrategyEvaluationV2(
  draft: StrategyDraftV1,
  request: PlanRequestV1
): StrategyEvaluationV2 {
  return strategySemanticEvaluationV2({
    semantic: projectStrategyDraft(draft, { request }),
    strategyReport: draft.strategy_report,
  });
}

export function projectSealedStrategyEvaluationV2(strategy: StrategyV1): StrategyEvaluationV2 {
  return strategySemanticEvaluationV2({
    semantic: projectSealedStrategyEvaluation(strategy),
    strategyReport: strategy.strategy_report,
  });
}

export function projectStrategyEvaluation(
  draft: StrategyDraftV1,
  request: PlanRequestV1
): StrategyEvaluationV1 {
  return projectStrategyDraft(draft, { request });
}

export function projectSealedStrategyEvaluation(strategy: StrategyV1): StrategyEvaluationV1 {
  return validateContract(
    StrategyEvaluationV1Schema,
    {
      schema_version: 1,
      disposition: strategy.disposition,
      applicability_reason: strategy.applicability_reason,
      outcomes: strategy.outcomes,
      dependencies: strategy.dependencies,
      request_coverage: strategy.request_coverage,
      blockers: strategy.blockers,
      confidence: strategy.confidence,
      execution_started: strategy.execution_started,
    },
    "projected StrategyEvaluationV1"
  );
}

export function parseDirectStrategyDraft(
  text: string,
  input: { readonly request: PlanRequestV1 }
): StrategyEvaluationV1 {
  const parsed = parseStrategyDraft(Buffer.from(text, "utf8"), input);
  return projectStrategyEvaluation(parsed.draft, input.request);
}

function normalizerDescriptor(input: {
  readonly registrationName: string;
  readonly normalizerId: string;
  readonly normalizerVersion: number;
  readonly artifactKind: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
}): EvaluationSemanticNormalizerDescriptorV1 {
  return {
    schema_version: 1,
    registration_name: input.registrationName,
    normalizer_id: input.normalizerId,
    normalizer_version: input.normalizerVersion,
    source_output: {
      artifact_kind: input.artifactKind,
      schema_id: input.schemaId,
      schema_version: input.schemaVersion,
    },
    target_wire: STRATEGY_GRADING_WIRE,
  };
}

export const PLAN_EVALUATION_NORMALIZER_DESCRIPTORS: readonly EvaluationSemanticNormalizerDescriptorV1[] =
  [
    normalizerDescriptor({
      registrationName: PLAN_PLAYBOOK_NAME,
      normalizerId: "penny.sealed-strategy-evaluation-normalizer.v1",
      normalizerVersion: 1,
      artifactKind: "strategy",
      schemaId: "penny.strategy.v1",
      schemaVersion: 1,
    }),
    normalizerDescriptor({
      registrationName: PLAN_UNSEALED_EVALUATION_NAME,
      normalizerId: "penny.strategy-draft-evaluation-normalizer.v1",
      normalizerVersion: 1,
      artifactKind: "strategy-draft",
      schemaId: "penny.strategy-draft.v1",
      schemaVersion: 1,
    }),
    normalizerDescriptor({
      registrationName: DIRECT_PIPER_PLAN_BASELINE_NAME,
      normalizerId: "penny.direct-strategy-draft-normalizer.v1",
      normalizerVersion: 1,
      artifactKind: "strategy-draft",
      schemaId: "penny.strategy-draft.v1",
      schemaVersion: 1,
    }),
  ].sort((left, right) => left.registration_name.localeCompare(right.registration_name));

function semanticV2NormalizerDescriptor(input: {
  readonly registrationName: string;
  readonly normalizerId: string;
  readonly artifactKind: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
}): EvaluationSemanticNormalizerDescriptorV1 {
  return {
    schema_version: 1,
    registration_name: input.registrationName,
    normalizer_id: input.normalizerId,
    normalizer_version: 2,
    source_output: {
      artifact_kind: input.artifactKind,
      schema_id: input.schemaId,
      schema_version: input.schemaVersion,
    },
    target_wire: STRATEGY_SEMANTIC_GRADING_WIRE_V2,
  };
}

export const PLAN_SEMANTIC_V2_NORMALIZER_DESCRIPTORS: readonly EvaluationSemanticNormalizerDescriptorV1[] =
  [
    semanticV2NormalizerDescriptor({
      registrationName: PLAN_PLAYBOOK_NAME,
      normalizerId: "penny.sealed-strategy-semantic-normalizer.v2",
      artifactKind: "strategy",
      schemaId: "penny.strategy.v1",
      schemaVersion: 1,
    }),
    semanticV2NormalizerDescriptor({
      registrationName: PLAN_UNSEALED_EVALUATION_NAME,
      normalizerId: "penny.strategy-draft-semantic-normalizer.v2",
      artifactKind: "strategy-draft",
      schemaId: "penny.strategy-draft.v1",
      schemaVersion: 1,
    }),
    semanticV2NormalizerDescriptor({
      registrationName: DIRECT_PIPER_PLAN_BASELINE_NAME,
      normalizerId: "penny.direct-strategy-semantic-normalizer.v2",
      artifactKind: "strategy-draft",
      schemaId: "penny.strategy-draft.v1",
      schemaVersion: 1,
    }),
  ].sort((left, right) => left.registration_name.localeCompare(right.registration_name));

function taskRequest(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): PlanRequestV1 {
  return canonicalizePlanRequest({
    goal: input.task.goal,
    constraints: input.task.constraints,
    exactInputArtifactIds: input.task.exact_input_artifact_ids,
  });
}

function failureCode(error: StrategyDraftValidationError): string {
  switch (error.failureClass) {
    case "FRAMING_INVALID":
      return "MODEL_OUTPUT_FRAMING_INVALID";
    case "JSON_INVALID":
      return "MODEL_OUTPUT_JSON_INVALID";
    case "SCHEMA_INVALID":
      return "MODEL_OUTPUT_SCHEMA_INVALID";
    case "SEMANTIC_INVALID":
      return "MODEL_OUTPUT_SEMANTIC_INVALID";
  }
}

function invalidOutput(failureCodeValue: string): EvaluationSemanticNormalizationV1 {
  return { status: "invalid_output", failure_code: failureCodeValue };
}

export function normalizeStrategyDraftOutput(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): EvaluationSemanticNormalizationV1 {
  try {
    const request = taskRequest(input);
    const draft = parseStrategyDraft(Buffer.from(input.output_bytes, "utf8"), { request }).draft;
    return {
      status: "normalized",
      wire_bytes: canonicalJson(projectStrategyEvaluation(draft, request)),
    };
  } catch (error) {
    return invalidOutput(
      error instanceof StrategyDraftValidationError
        ? failureCode(error)
        : "MODEL_OUTPUT_SEMANTIC_INVALID"
    );
  }
}

export function normalizeSealedStrategyOutput(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): EvaluationSemanticNormalizationV1 {
  let value: unknown;
  try {
    value = JSON.parse(input.output_bytes);
  } catch {
    return invalidOutput("MODEL_OUTPUT_JSON_INVALID");
  }
  try {
    const strategy = validateStrategy(value);
    const request = taskRequest(input);
    if (
      canonicalJson(strategy) !== input.output_bytes ||
      canonicalJson(strategy.request) !== canonicalJson(request) ||
      canonicalJson(strategy.source_lineage.input_artifact_ids) !==
        canonicalJson([...input.task.exact_input_artifact_ids].sort())
    ) {
      return invalidOutput("MODEL_OUTPUT_SEMANTIC_INVALID");
    }
    return {
      status: "normalized",
      wire_bytes: canonicalJson(projectSealedStrategyEvaluation(strategy)),
    };
  } catch {
    return invalidOutput("MODEL_OUTPUT_SCHEMA_INVALID");
  }
}

const DRAFT_NORMALIZER: EvaluationSemanticNormalizerImplementationV1 = {
  normalizer_id: "penny.strategy-draft-evaluation-normalizer.v1",
  normalizer_version: 1,
  implementation_sha256: sha256(
    "penny.strategy-draft-evaluation-normalizer.v1:shared-strategy-draft-parser:1"
  ),
  normalize: normalizeStrategyDraftOutput,
};

const DIRECT_NORMALIZER: EvaluationSemanticNormalizerImplementationV1 = {
  normalizer_id: "penny.direct-strategy-draft-normalizer.v1",
  normalizer_version: 1,
  implementation_sha256: sha256(
    "penny.direct-strategy-draft-normalizer.v1:shared-strategy-draft-parser:1"
  ),
  normalize: normalizeStrategyDraftOutput,
};

const SEALED_NORMALIZER: EvaluationSemanticNormalizerImplementationV1 = {
  normalizer_id: "penny.sealed-strategy-evaluation-normalizer.v1",
  normalizer_version: 1,
  implementation_sha256: sha256(
    "penny.sealed-strategy-evaluation-normalizer.v1:strategy-v1-projection:1"
  ),
  normalize: normalizeSealedStrategyOutput,
};

const NORMALIZER_IMPLEMENTATIONS: ReadonlyMap<
  string,
  EvaluationSemanticNormalizerImplementationV1
> = new Map([
  [DIRECT_PIPER_PLAN_BASELINE_NAME, DIRECT_NORMALIZER],
  [PLAN_PLAYBOOK_NAME, SEALED_NORMALIZER],
  [PLAN_UNSEALED_EVALUATION_NAME, DRAFT_NORMALIZER],
]);

export function normalizeStrategyDraftSemanticV2(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): EvaluationSemanticNormalizationV1 {
  try {
    const request = taskRequest(input);
    const draft = parseStrategyDraft(Buffer.from(input.output_bytes, "utf8"), { request }).draft;
    return {
      status: "normalized",
      wire_bytes: canonicalJson(projectStrategyEvaluationV2(draft, request)),
    };
  } catch (error) {
    return invalidOutput(
      error instanceof StrategyDraftValidationError
        ? failureCode(error)
        : "MODEL_OUTPUT_SEMANTIC_INVALID"
    );
  }
}

export function normalizeSealedStrategySemanticV2(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): EvaluationSemanticNormalizationV1 {
  let value: unknown;
  try {
    value = JSON.parse(input.output_bytes);
  } catch {
    return invalidOutput("MODEL_OUTPUT_JSON_INVALID");
  }
  try {
    const strategy = validateStrategy(value);
    const request = taskRequest(input);
    if (
      canonicalJson(strategy) !== input.output_bytes ||
      canonicalJson(strategy.request) !== canonicalJson(request) ||
      canonicalJson(strategy.source_lineage.input_artifact_ids) !==
        canonicalJson([...input.task.exact_input_artifact_ids].sort())
    ) {
      return invalidOutput("MODEL_OUTPUT_SEMANTIC_INVALID");
    }
    return {
      status: "normalized",
      wire_bytes: canonicalJson(projectSealedStrategyEvaluationV2(strategy)),
    };
  } catch {
    return invalidOutput("MODEL_OUTPUT_SCHEMA_INVALID");
  }
}

const PLAN_SEMANTIC_V2_NORMALIZER_IMPLEMENTATIONS: ReadonlyMap<
  string,
  EvaluationSemanticNormalizerImplementationV1
> = new Map([
  [
    DIRECT_PIPER_PLAN_BASELINE_NAME,
    {
      normalizer_id: "penny.direct-strategy-semantic-normalizer.v2",
      normalizer_version: 2,
      implementation_sha256: sha256(
        "penny.direct-strategy-semantic-normalizer.v2:semantic-only-no-runtime-metadata:2"
      ),
      normalize: normalizeStrategyDraftSemanticV2,
    },
  ],
  [
    PLAN_PLAYBOOK_NAME,
    {
      normalizer_id: "penny.sealed-strategy-semantic-normalizer.v2",
      normalizer_version: 2,
      implementation_sha256: sha256(
        "penny.sealed-strategy-semantic-normalizer.v2:semantic-only-no-runtime-metadata:2"
      ),
      normalize: normalizeSealedStrategySemanticV2,
    },
  ],
  [
    PLAN_UNSEALED_EVALUATION_NAME,
    {
      normalizer_id: "penny.strategy-draft-semantic-normalizer.v2",
      normalizer_version: 2,
      implementation_sha256: sha256(
        "penny.strategy-draft-semantic-normalizer.v2:semantic-only-no-runtime-metadata:2"
      ),
      normalize: normalizeStrategyDraftSemanticV2,
    },
  ],
]);

export function parseStrategySemanticGradingWireV2(value: string): StrategyEvaluationV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Strategy semantic grading wire V2 is not JSON");
  }
  const wire = validateContract(
    StrategyEvaluationV2Schema,
    parsed,
    "Strategy semantic grading wire V2"
  );
  if (canonicalJson(wire) !== value) {
    throw new Error("Strategy semantic grading wire V2 is not canonical JSON");
  }
  return wire;
}

export function validatePlanSemanticV2CommonWire(
  input: Parameters<EvaluationCommonWireValidatorV1>[0]
): void {
  if (canonicalJson(input.descriptor) !== canonicalJson(STRATEGY_SEMANTIC_GRADING_WIRE_V2)) {
    throw new Error("Plan semantic V2 preflight received a foreign common-wire descriptor");
  }
  parseStrategySemanticGradingWireV2(input.wire_bytes);
}

export function parseStrategyGradingWire(value: string): StrategyGradingWireV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Strategy grading wire is not JSON");
  }
  const wire = validateContract(StrategyEvaluationV1Schema, parsed, "Strategy grading wire");
  if (canonicalJson(wire) !== value) throw new Error("Strategy grading wire is not canonical JSON");
  return wire;
}

export function validatePlanEvaluationCommonWire(
  input: Parameters<EvaluationCommonWireValidatorV1>[0]
): void {
  if (canonicalJson(input.descriptor) !== canonicalJson(STRATEGY_GRADING_WIRE)) {
    throw new Error("Plan readiness preflight received a foreign common-wire descriptor");
  }
  parseStrategyGradingWire(input.wire_bytes);
}

const PlanContractGraderOracleV1Schema = Type.Object(
  {
    expected_disposition: Type.Union([
      Type.Literal("ready"),
      Type.Literal("blocked"),
      Type.Literal("not_applicable"),
    ]),
    expected_desired_outcome_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 24,
      uniqueItems: true,
    }),
    expected_dependency_kinds: Type.Array(
      Type.Union([
        Type.Literal("causal"),
        Type.Literal("temporal"),
        Type.Literal("resource"),
        Type.Literal("informational"),
      ]),
      { maxItems: 4, uniqueItems: true }
    ),
    expected_blockers: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        maxItems: 16,
        uniqueItems: true,
      })
    ),
    expected_blocker_presence: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("nonempty")])
    ),
    oracle_marker: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false }
);
export type PlanContractGraderOracleV1 = Readonly<Static<typeof PlanContractGraderOracleV1Schema>>;

const PlanKnownDeltaGraderOracleV1Schema = Type.Object(
  {
    expected_wire_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    oracle_marker: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false }
);
export type PlanKnownDeltaGraderOracleV1 = Readonly<
  Static<typeof PlanKnownDeltaGraderOracleV1Schema>
>;

export const PLAN_SEMANTIC_V2_GRADER_ID = "penny.plan-semantic-clause-grader.v2";

export const PLAN_SEMANTIC_CLAUSE_IDS = PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2;
export type PlanSemanticClauseIdV2 = (typeof PLAN_SEMANTIC_CLAUSE_IDS)[number];

const PlanSemanticClauseIdV2Schema = Type.Union([
  Type.Literal("current_state_to_outcomes"),
  Type.Literal("constraints_non_goals_prior_decisions"),
  Type.Literal("assumptions_and_risk"),
  Type.Literal("meaningful_dependencies"),
  Type.Literal("no_manufactured_taskification"),
  Type.Literal("uncertainty_and_contingencies"),
  Type.Literal("tradeoffs_and_decision_points"),
  Type.Literal("disposition_internal_consistency"),
]);

export const PLAN_SEMANTIC_DOD_MAPPING_V2 = [
  {
    clause_id: "current_state_to_outcomes",
    plan_clause: "§9.4.1",
    grader_owner: "plan_semantic_clause_grader_v2",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "constraints_non_goals_prior_decisions",
    plan_clause: "§9.4.2",
    grader_owner: "plan_semantic_clause_grader_v2",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "assumptions_and_risk",
    plan_clause: "§9.4.3",
    grader_owner: "plan_semantic_clause_grader_v2",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "meaningful_dependencies",
    plan_clause: "§9.4.4",
    grader_owner: "plan_semantic_clause_grader_v2",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "no_manufactured_taskification",
    plan_clause: "§9.4.5",
    grader_owner: "plan_semantic_clause_grader_v2",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "uncertainty_and_contingencies",
    plan_clause: "§9.4.6",
    grader_owner: "plan_semantic_clause_grader_v2",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "tradeoffs_and_decision_points",
    plan_clause: "§9.4.7",
    grader_owner: "plan_semantic_clause_grader_v2",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "disposition_internal_consistency",
    plan_clause: "§9.4.8",
    grader_owner: "plan_semantic_clause_grader_v2",
    substantive_review: "independent_semantic_judge_required",
  },
] as const;

const BoundedSemanticRefSchema = Type.String({ minLength: 1, maxLength: 256 });
const SemanticClauseOutcomeSchema = Type.Union([
  Type.Literal("PASS"),
  Type.Literal("FAIL"),
  Type.Literal("UNVERIFIABLE"),
]);
const PlanSemanticClauseExpectationV2Schema = Type.Object(
  {
    clause_id: PlanSemanticClauseIdV2Schema,
    applicability: Type.Union([Type.Literal("applicable"), Type.Literal("not_applicable")]),
    semantic_review: Type.Union([
      Type.Literal("independent_semantic_judge_required"),
      Type.Literal("not_applicable"),
    ]),
    oracle_refs: Type.Array(BoundedSemanticRefSchema, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    evidence_refs: Type.Array(BoundedSemanticRefSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export const PlanSemanticGraderOracleV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    task_id: Type.String({ minLength: 1, maxLength: 256 }),
    structured_expectations: PlanStructuredExpectationsV2Schema,
    clauses: Type.Array(PlanSemanticClauseExpectationV2Schema, {
      minItems: PLAN_SEMANTIC_CLAUSE_IDS.length,
      maxItems: PLAN_SEMANTIC_CLAUSE_IDS.length,
    }),
    oracle_marker: Type.String({
      pattern: "^PLAN_SEMANTIC_ORACLE_V2:[A-Z0-9][A-Z0-9_-]{0,127}$",
    }),
  },
  { additionalProperties: false }
);
export type PlanSemanticGraderOracleV2 = Readonly<Static<typeof PlanSemanticGraderOracleV2Schema>>;

const PlanSemanticReviewClauseV1Schema = Type.Object(
  {
    clause_id: PlanSemanticClauseIdV2Schema,
    outcome: SemanticClauseOutcomeSchema,
    reason: Type.String({ minLength: 1, maxLength: 1024 }),
    oracle_refs: Type.Array(BoundedSemanticRefSchema, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    evidence_refs: Type.Array(BoundedSemanticRefSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

/** A declared authorization ref is not authorization; the caller verifies it independently. */
export const PlanSemanticReviewOutputV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    skill: Type.Literal("plan"),
    task_id: Type.String({ minLength: 1, maxLength: 256 }),
    semantic_wire_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    oracle_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    reviewer_role: Type.Literal("independently_authorized_semantic_judge"),
    judge_authorization_ref: BoundedSemanticRefSchema,
    clause_results: Type.Array(PlanSemanticReviewClauseV1Schema, {
      minItems: PLAN_SEMANTIC_CLAUSE_IDS.length,
      maxItems: PLAN_SEMANTIC_CLAUSE_IDS.length,
    }),
  },
  { additionalProperties: false }
);
export type PlanSemanticReviewOutputV1 = Readonly<Static<typeof PlanSemanticReviewOutputV1Schema>>;

function validatePlanSemanticGraderOracleV2(value: unknown): PlanSemanticGraderOracleV2 {
  const oracle = validateContract(
    PlanSemanticGraderOracleV2Schema,
    value,
    "Plan semantic grader oracle V2"
  );
  if (
    canonicalJson(oracle.clauses.map((clause) => clause.clause_id)) !==
    canonicalJson(PLAN_SEMANTIC_CLAUSE_IDS)
  ) {
    throw new Error("Plan semantic grader oracle V2 must contain every clause in canonical order");
  }
  if (
    oracle.clauses.some(
      (clause) =>
        (clause.applicability === "applicable") !==
        (clause.semantic_review === "independent_semantic_judge_required")
    )
  ) {
    throw new Error("Plan semantic clause applicability and review requirement must agree");
  }
  if (!oracle.clauses.some((clause) => clause.applicability === "applicable")) {
    throw new Error("Plan semantic grader oracle V2 requires at least one applicable clause");
  }
  return oracle;
}

export function validatePlanSemanticReviewOutputV1(value: unknown): PlanSemanticReviewOutputV1 {
  const output = validateContract(
    PlanSemanticReviewOutputV1Schema,
    value,
    "Plan semantic review output V1"
  );
  if (
    canonicalJson(output.clause_results.map((clause) => clause.clause_id)) !==
    canonicalJson(PLAN_SEMANTIC_CLAUSE_IDS)
  ) {
    throw new Error("Plan semantic review output must contain every clause in canonical order");
  }
  return output;
}

function sameRelations(
  left: readonly StrategyEvaluationV2["dependencies"][number][],
  right: readonly StrategyEvaluationV2["dependencies"][number][]
): boolean {
  const sorted = (values: readonly StrategyEvaluationV2["dependencies"][number][]) =>
    [...values].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return canonicalJson(sorted(left)) === canonicalJson(sorted(right));
}

function planTaskRequest(
  task: Parameters<DeterministicGraderImplementationV1["grade"]>[1]
): PlanRequestV1 {
  return canonicalizePlanRequest({
    goal: task.goal,
    constraints: task.constraints,
    exactInputArtifactIds: task.exact_input_artifact_ids,
  });
}

function planSemanticTaskRequest(
  task: Parameters<DeterministicGraderImplementationV1["grade"]>[1]
): Omit<PlanRequestV1, "request_id" | "input_artifact_ids"> {
  const {
    request_id: requestId,
    input_artifact_ids: inputArtifactIds,
    ...semantic
  } = planTaskRequest(task);
  void requestId;
  if (inputArtifactIds.length > 0) {
    throw new Error(
      "Plan semantic review requires resolved permitted evidence, never input artifact identifiers"
    );
  }
  return semantic;
}

function authorizedPlanSemanticRequest(
  task: Parameters<DeterministicGraderImplementationV1["grade"]>[1],
  semanticRequest: PlanSemanticRequestProjectionV1 | undefined
): PlanSemanticRequestProjectionV1 {
  return semanticRequest === undefined
    ? planSemanticTaskRequest(task)
    : validateContract(
        PlanSemanticRequestProjectionV1Schema,
        semanticRequest,
        "authorized Plan semantic request projection"
      );
}

function planSemanticReviewWire(wire: StrategyEvaluationV2, admittedSemanticEvidence: boolean) {
  const { input_artifact_ids: inputArtifactIds, ...semanticCoverage } = wire.request_coverage;
  if (inputArtifactIds.length > 0 && !admittedSemanticEvidence) {
    throw new Error(
      "Plan semantic review requires resolved permitted evidence, never input artifact identifiers"
    );
  }
  return { ...wire, request_coverage: semanticCoverage };
}

function assertPlanOracleTaskBinding(
  task: Parameters<DeterministicGraderImplementationV1["grade"]>[1],
  oracle: PlanSemanticGraderOracleV2
): void {
  if (oracle.task_id !== task.task_id) {
    throw new Error("Plan semantic oracle task identity does not match the graded task");
  }
  const itemIds = planRequestItemIds(planTaskRequest(task));
  const expected = oracle.structured_expectations;
  const requestFactsMatch =
    sameSorted(itemIds.desired_outcome_ids, expected.expected_desired_outcome_ids) &&
    sameSorted(itemIds.current_state_fact_ids, expected.expected_current_state_fact_ids) &&
    sameSorted(itemIds.hard_constraint_ids, expected.expected_hard_constraint_ids) &&
    sameSorted(itemIds.non_goal_ids, expected.expected_non_goal_ids) &&
    sameSorted(itemIds.uncertainty_ids, expected.expected_uncertainty_ids) &&
    sameSorted(itemIds.prior_decision_ids, expected.expected_prior_decision_ids) &&
    expected.expected_blocked_desired_outcome_ids.every((id) =>
      itemIds.desired_outcome_ids.includes(id)
    );
  if (!requestFactsMatch) {
    throw new Error("Plan semantic oracle structured expectations diverge from the task request");
  }
}

function planClauseStructuralIssues(
  wire: StrategyEvaluationV2,
  oracle: PlanSemanticGraderOracleV2,
  clauseId: PlanSemanticClauseIdV2
): string[] {
  const expected = oracle.structured_expectations;
  const coveredDesiredOutcomeIds = [
    ...wire.outcomes.flatMap((outcome) => outcome.desired_outcome_ids),
    ...wire.request_coverage.blocked_desired_outcome_ids,
  ];
  const issues: string[] = [];
  const requireFact = (condition: boolean, code: string): void => {
    if (!condition) issues.push(code);
  };
  switch (clauseId) {
    case "current_state_to_outcomes":
      requireFact(
        expected.allowed_dispositions.includes(wire.disposition),
        "DISPOSITION_OUTSIDE_ORACLE_ENUM"
      );
      requireFact(
        sameSorted(
          wire.request_coverage.current_state_fact_ids,
          expected.expected_current_state_fact_ids
        ),
        "CURRENT_STATE_COVERAGE_SET_MISMATCH"
      );
      requireFact(
        sameSorted(coveredDesiredOutcomeIds, expected.expected_desired_outcome_ids),
        "DESIRED_OUTCOME_COVERAGE_SET_MISMATCH"
      );
      requireFact(
        sameSorted(
          wire.request_coverage.blocked_desired_outcome_ids,
          expected.expected_blocked_desired_outcome_ids
        ),
        "BLOCKED_OUTCOME_SET_MISMATCH"
      );
      break;
    case "constraints_non_goals_prior_decisions":
      requireFact(
        sameSorted(
          wire.request_coverage.hard_constraint_ids,
          expected.expected_hard_constraint_ids
        ),
        "HARD_CONSTRAINT_COVERAGE_SET_MISMATCH"
      );
      requireFact(
        sameSorted(wire.request_coverage.non_goal_ids, expected.expected_non_goal_ids),
        "NON_GOAL_COVERAGE_SET_MISMATCH"
      );
      requireFact(
        sameSorted(wire.request_coverage.prior_decision_ids, expected.expected_prior_decision_ids),
        "PRIOR_DECISION_COVERAGE_SET_MISMATCH"
      );
      break;
    case "assumptions_and_risk":
    case "uncertainty_and_contingencies":
      requireFact(
        sameSorted(wire.request_coverage.uncertainty_ids, expected.expected_uncertainty_ids),
        "UNCERTAINTY_COVERAGE_SET_MISMATCH"
      );
      break;
    case "meaningful_dependencies":
      requireFact(
        sameRelations(wire.dependencies, expected.expected_dependency_relations),
        "DEPENDENCY_RELATION_SET_MISMATCH"
      );
      break;
    case "no_manufactured_taskification":
      // The closed wire has no task graph, owner, estimate, command, or authorization field.
      // Whether prose/outcomes manufacture executor work remains a semantic-review question.
      break;
    case "tradeoffs_and_decision_points":
      // Trade-off relevance and implementation freedom are substantive prose judgments.
      break;
    case "disposition_internal_consistency":
      requireFact(
        expected.allowed_dispositions.includes(wire.disposition),
        "DISPOSITION_OUTSIDE_ORACLE_ENUM"
      );
      requireFact(
        expected.allowed_confidence.includes(wire.confidence),
        "CONFIDENCE_OUTSIDE_ORACLE_ENUM"
      );
      requireFact(
        expected.expected_blocker_presence === "nonempty"
          ? wire.blockers.length > 0
          : wire.blockers.length === 0,
        "BLOCKER_PRESENCE_MISMATCH"
      );
      requireFact(
        sameSorted(coveredDesiredOutcomeIds, expected.expected_desired_outcome_ids),
        "DISPOSITION_COVERAGE_RELATION_MISMATCH"
      );
      break;
  }
  return issues;
}

function planStructuralClauseResult(input: {
  readonly expectation: PlanSemanticGraderOracleV2["clauses"][number];
  readonly issues: readonly string[];
}): SemanticClauseResultV1 {
  if (input.expectation.applicability === "not_applicable") {
    return {
      clause_id: input.expectation.clause_id,
      outcome: "UNVERIFIABLE",
      reason:
        "The task oracle marks this clause not applicable; it is excluded from aggregate success and is not converted to PASS.",
      oracle_refs: [...input.expectation.oracle_refs],
      evidence_refs: [...input.expectation.evidence_refs],
    };
  }
  if (input.issues.length > 0) {
    return {
      clause_id: input.expectation.clause_id,
      outcome: "FAIL",
      reason: `Closed structural check(s) failed: ${input.issues.join(",")}.`,
      oracle_refs: [...input.expectation.oracle_refs],
      evidence_refs: [...input.expectation.evidence_refs],
    };
  }
  return {
    clause_id: input.expectation.clause_id,
    outcome: "UNVERIFIABLE",
    reason:
      "Closed structural facts match the oracle, but this substantive §9.4 clause requires natural-language/evidence judgment by an independently authorized semantic judge.",
    oracle_refs: [...input.expectation.oracle_refs],
    evidence_refs: [...input.expectation.evidence_refs],
  };
}

export function gradePlanSemanticClausesV2(
  wireBytes: string,
  task: Parameters<DeterministicGraderImplementationV1["grade"]>[1],
  descriptor: DeterministicGraderDescriptorV1
) {
  const oracle = validatePlanSemanticGraderOracleV2(descriptor.oracle);
  assertPlanOracleTaskBinding(task, oracle);
  const wire = parseStrategySemanticGradingWireV2(wireBytes);
  const clause_results = oracle.clauses.map((expectation) =>
    planStructuralClauseResult({
      expectation,
      issues:
        expectation.applicability === "applicable"
          ? planClauseStructuralIssues(wire, oracle, expectation.clause_id)
          : [],
    })
  );
  const applicableIds = new Set<string>(
    oracle.clauses
      .filter((clause) => clause.applicability === "applicable")
      .map((clause) => clause.clause_id)
  );
  const score = clause_results
    .filter((clause) => applicableIds.has(clause.clause_id))
    .every((clause) => clause.outcome === "PASS")
    ? 1
    : 0;
  return {
    task_score: score,
    trigger_predicted: wire.disposition !== "not_applicable",
    protected_capability_score: descriptor.protected_capability ? score : null,
    clause_results,
  };
}

export function buildPlanSemanticTrialReviewPacketV2(input: {
  readonly wireBytes: string;
  readonly task: Parameters<DeterministicGraderImplementationV1["grade"]>[1];
  readonly descriptor: DeterministicGraderDescriptorV1;
  readonly semanticRequest?: PlanSemanticRequestProjectionV1;
}): SemanticTrialReviewPacketV1 {
  const oracle = validatePlanSemanticGraderOracleV2(input.descriptor.oracle);
  assertPlanOracleTaskBinding(input.task, oracle);
  return buildSemanticTrialReviewPacketV1(
    createPlanSemanticTrialProjectionV2({
      request: authorizedPlanSemanticRequest(input.task, input.semanticRequest),
      wire: planSemanticReviewWire(
        parseStrategySemanticGradingWireV2(input.wireBytes),
        input.semanticRequest !== undefined
      ),
      clauses: oracle.clauses.map((clause) => ({
        clause_id: clause.clause_id,
        applicability: clause.applicability,
      })),
      structuredExpectations: oracle.structured_expectations,
    })
  );
}

export function buildPlanSemanticOracleReviewPacketV2(input: {
  readonly task: Parameters<DeterministicGraderImplementationV1["grade"]>[1];
  readonly descriptor: DeterministicGraderDescriptorV1;
  readonly semanticRequest?: PlanSemanticRequestProjectionV1;
  readonly derivationAttestation: SemanticOracleDerivationAttestationV1;
  readonly contaminationAttestation: SemanticOracleContaminationAttestationV1;
}): SemanticOracleReviewPacketV1 {
  const oracle = validatePlanSemanticGraderOracleV2(input.descriptor.oracle);
  assertPlanOracleTaskBinding(input.task, oracle);
  return buildSemanticOracleReviewPacketV1(
    createPlanSemanticOracleProjectionV2({
      request: authorizedPlanSemanticRequest(input.task, input.semanticRequest),
      structuredExpectations: oracle.structured_expectations,
      derivationAttestation: input.derivationAttestation,
      contaminationAttestation: input.contaminationAttestation,
    })
  );
}

function planOracleReviewDisposition(input: {
  readonly evidence: VerifiedSemanticReviewEvidenceV1;
  readonly task: Parameters<DeterministicGraderImplementationV1["grade"]>[1];
  readonly semanticRequest?: PlanSemanticRequestProjectionV1;
  readonly oracle: PlanSemanticGraderOracleV2;
}): "PASS" | "FAIL" | "BLOCKED" {
  const packet = input.evidence.packet;
  if (packet.review_kind !== "oracle" || packet.skill !== "plan") {
    throw new Error("Plan oracle review evidence has a foreign packet kind or skill");
  }
  assertSemanticReviewEvidenceBinding({
    evidence: input.evidence,
    packet,
    reviewKind: "oracle",
  });
  if (
    canonicalJson(packet.clause_criteria.map((clause) => clause.clause_id)) !==
      canonicalJson(Q4_ORACLE_REVIEW_CLAUSE_IDS) ||
    packet.semantic_request.request !==
      canonicalJson(authorizedPlanSemanticRequest(input.task, input.semanticRequest)) ||
    !packet.oracle_projection.facts.some(
      (fact) => fact.content === canonicalJson(input.oracle.structured_expectations)
    )
  ) {
    throw new Error("Plan oracle review evidence is not bound to the exact task oracle");
  }
  const applicable = input.evidence.output.clause_results.filter((result) =>
    packet.clause_criteria.some(
      (criterion) =>
        criterion.clause_id === result.clause_id && criterion.applicability === "applicable"
    )
  );
  return applicable.every((result) => result.outcome === "PASS")
    ? "PASS"
    : applicable.some((result) => result.outcome === "FAIL")
      ? "FAIL"
      : "BLOCKED";
}

export interface PlanSemanticQualificationStatusV2 {
  readonly task_disposition: "PASS" | "FAIL" | "BLOCKED";
  readonly qualification_status: "QUALIFIED" | "NOT_QUALIFIED";
  readonly aggregate_success: boolean;
  readonly reason_code:
    | "ALL_APPLICABLE_CLAUSES_PASS"
    | "STRUCTURAL_CLAUSE_FAILED"
    | "SEMANTIC_CLAUSE_FAILED"
    | "SEMANTIC_CLAUSE_UNVERIFIABLE"
    | "INDEPENDENT_SEMANTIC_REVIEW_ABSENT"
    | "INDEPENDENT_ORACLE_REVIEW_ABSENT"
    | "INDEPENDENT_ORACLE_REVIEW_FAILED"
    | "INDEPENDENT_ORACLE_REVIEW_UNVERIFIABLE";
  readonly clause_results: readonly SemanticClauseResultV1[];
}

export function planSemanticQualificationStatusV2(input: {
  readonly wireBytes: string;
  readonly task: Parameters<DeterministicGraderImplementationV1["grade"]>[1];
  readonly descriptor: DeterministicGraderDescriptorV1;
  readonly semanticRequest?: PlanSemanticRequestProjectionV1;
  readonly semanticReview?: VerifiedSemanticReviewEvidenceV1;
  readonly oracleReview?: VerifiedSemanticReviewEvidenceV1;
}): PlanSemanticQualificationStatusV2 {
  const oracle = validatePlanSemanticGraderOracleV2(input.descriptor.oracle);
  const structural = gradePlanSemanticClausesV2(input.wireBytes, input.task, input.descriptor);
  if (input.semanticReview === undefined) {
    return {
      task_disposition: "BLOCKED",
      qualification_status: "NOT_QUALIFIED",
      aggregate_success: false,
      reason_code: "INDEPENDENT_SEMANTIC_REVIEW_ABSENT",
      clause_results: structural.clause_results,
    };
  }
  const packet = buildPlanSemanticTrialReviewPacketV2(input);
  assertSemanticReviewEvidenceBinding({
    evidence: input.semanticReview,
    packet,
    reviewKind: "trial",
  });
  if (input.oracleReview === undefined) {
    return {
      task_disposition: "BLOCKED",
      qualification_status: "NOT_QUALIFIED",
      aggregate_success: false,
      reason_code: "INDEPENDENT_ORACLE_REVIEW_ABSENT",
      clause_results: structural.clause_results,
    };
  }
  const oracleReviewDisposition = planOracleReviewDisposition({
    evidence: input.oracleReview,
    task: input.task,
    ...(input.semanticRequest === undefined ? {} : { semanticRequest: input.semanticRequest }),
    oracle,
  });
  if (oracleReviewDisposition !== "PASS") {
    return {
      task_disposition: oracleReviewDisposition === "FAIL" ? "FAIL" : "BLOCKED",
      qualification_status: "NOT_QUALIFIED",
      aggregate_success: false,
      reason_code:
        oracleReviewDisposition === "FAIL"
          ? "INDEPENDENT_ORACLE_REVIEW_FAILED"
          : "INDEPENDENT_ORACLE_REVIEW_UNVERIFIABLE",
      clause_results: structural.clause_results,
    };
  }
  const structuralByClause = new Map(
    structural.clause_results.map((clause) => [clause.clause_id, clause])
  );
  const clause_results = input.semanticReview.output.clause_results.map((reviewed) => {
    const structuralClause = structuralByClause.get(reviewed.clause_id);
    if (structuralClause === undefined) {
      throw new Error("Plan semantic review clause is absent from the structural grade");
    }
    return structuralClause.outcome === "FAIL" ? structuralClause : reviewed;
  });
  const applicableIds = new Set<string>(
    oracle.clauses
      .filter((clause) => clause.applicability === "applicable")
      .map((clause) => clause.clause_id)
  );
  const applicable = clause_results.filter((clause) => applicableIds.has(clause.clause_id));
  const aggregateSuccess = applicable.every((clause) => clause.outcome === "PASS");
  const hasStructuralFailure = structural.clause_results.some(
    (clause) => applicableIds.has(clause.clause_id) && clause.outcome === "FAIL"
  );
  const hasSemanticFailure = applicable.some((clause) => clause.outcome === "FAIL");
  const hasUnverifiable = applicable.some((clause) => clause.outcome === "UNVERIFIABLE");
  return {
    task_disposition: aggregateSuccess ? "PASS" : hasUnverifiable ? "BLOCKED" : "FAIL",
    qualification_status: aggregateSuccess ? "QUALIFIED" : "NOT_QUALIFIED",
    aggregate_success: aggregateSuccess,
    reason_code: aggregateSuccess
      ? "ALL_APPLICABLE_CLAUSES_PASS"
      : hasStructuralFailure
        ? "STRUCTURAL_CLAUSE_FAILED"
        : hasSemanticFailure
          ? "SEMANTIC_CLAUSE_FAILED"
          : "SEMANTIC_CLAUSE_UNVERIFIABLE",
    clause_results,
  };
}

export const PLAN_SEMANTIC_V2_GRADER_IMPLEMENTATION: DeterministicGraderImplementationV1 = {
  grader_id: PLAN_SEMANTIC_V2_GRADER_ID,
  grader_version: 2,
  implementation_sha256: sha256(
    "penny.plan-semantic-clause-grader.v2:closed-structural-facts-independent-review-qualification:4"
  ),
  grade: gradePlanSemanticClausesV2,
  qualifySemanticReview: ({ wireBytes, task, descriptor, semanticReview, oracleReview }) =>
    planSemanticQualificationStatusV2({
      wireBytes,
      task,
      descriptor,
      semanticReview,
      oracleReview,
    }),
};

export function planSemanticV2GraderDescriptor(input: {
  readonly graderCaseId: string;
  readonly protectedCapability: boolean;
  readonly oracle: PlanSemanticGraderOracleV2;
}): DeterministicGraderDescriptorV1 {
  return {
    schema_version: 1,
    grader_case_id: input.graderCaseId,
    grader_id: PLAN_SEMANTIC_V2_GRADER_ID,
    grader_version: 2,
    protected_capability: input.protectedCapability,
    wire: STRATEGY_SEMANTIC_GRADING_WIRE_V2,
    oracle: input.oracle,
  };
}

export function createPlanSemanticV2GradingDefinition(input: {
  readonly graders: readonly PlanEvaluationGraderBindingV1[];
}): EvaluationGradingDefinitionV1 {
  const graders = [...input.graders].sort((left, right) =>
    left.descriptor.grader_case_id.localeCompare(right.descriptor.grader_case_id)
  );
  for (const grader of graders) {
    if (
      grader.descriptor.grader_id !== PLAN_SEMANTIC_V2_GRADER_ID ||
      grader.implementation.grader_id !== PLAN_SEMANTIC_V2_GRADER_ID ||
      grader.descriptor.grader_version !== 2 ||
      grader.implementation.grader_version !== 2 ||
      canonicalJson(grader.descriptor.wire) !== canonicalJson(STRATEGY_SEMANTIC_GRADING_WIRE_V2)
    ) {
      throw new Error("Plan semantic V2 grading requires the exact V2 grader and wire");
    }
    validatePlanSemanticGraderOracleV2(grader.descriptor.oracle);
  }
  return {
    descriptor: {
      schema_version: 1,
      wire: STRATEGY_SEMANTIC_GRADING_WIRE_V2,
      semantic_normalizers: [...PLAN_SEMANTIC_V2_NORMALIZER_DESCRIPTORS],
      graders: graders.map((grader) => grader.descriptor),
    },
    implementations: {
      semantic_normalizers: PLAN_SEMANTIC_V2_NORMALIZER_IMPLEMENTATIONS,
      graders: new Map(
        graders.map((grader) => [grader.descriptor.grader_case_id, grader.implementation])
      ),
    },
  };
}

function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b));
  return canonicalJson(sorted(left)) === canonicalJson(sorted(right));
}

export function gradePlanContract(
  wireBytes: string,
  _task: Parameters<DeterministicGraderImplementationV1["grade"]>[1],
  descriptor: DeterministicGraderDescriptorV1
) {
  const oracle = validateContract(
    PlanContractGraderOracleV1Schema,
    descriptor.oracle,
    "Plan contract grader oracle"
  );
  const wire = parseStrategyGradingWire(wireBytes);
  const coveredDesiredOutcomes = [
    ...wire.outcomes.flatMap((outcome) => outcome.desired_outcome_ids),
    ...wire.request_coverage.blocked_desired_outcome_ids,
  ];
  const dependencyKinds = [...new Set(wire.dependencies.map((dependency) => dependency.kind))];
  const exactBlockers = oracle.expected_blockers;
  const blockerPresence = oracle.expected_blocker_presence;
  if ((exactBlockers === undefined) === (blockerPresence === undefined)) {
    throw new Error("Plan contract grader oracle requires exactly one frozen blocker expectation");
  }
  const blockersMatch =
    exactBlockers !== undefined
      ? sameSorted(wire.blockers, exactBlockers)
      : blockerPresence === "nonempty"
        ? wire.blockers.length > 0
        : wire.blockers.length === 0;
  const score =
    wire.disposition === oracle.expected_disposition &&
    sameSorted(coveredDesiredOutcomes, oracle.expected_desired_outcome_ids) &&
    sameSorted(dependencyKinds, oracle.expected_dependency_kinds) &&
    blockersMatch &&
    wire.execution_started === false
      ? 1
      : 0;
  return {
    task_score: score,
    trigger_predicted: wire.disposition !== "not_applicable",
    protected_capability_score: descriptor.protected_capability ? score : null,
  };
}

export function gradePlanKnownDelta(
  wireBytes: string,
  _task: Parameters<DeterministicGraderImplementationV1["grade"]>[1],
  descriptor: DeterministicGraderDescriptorV1
) {
  const oracle = validateContract(
    PlanKnownDeltaGraderOracleV1Schema,
    descriptor.oracle,
    "Plan known-delta grader oracle"
  );
  const wire = parseStrategyGradingWire(wireBytes);
  const score = sha256(wireBytes) === oracle.expected_wire_sha256 ? 1 : 0;
  return {
    task_score: score,
    trigger_predicted: wire.disposition !== "not_applicable",
    protected_capability_score: descriptor.protected_capability ? score : null,
  };
}

export const PLAN_CONTRACT_GRADER_IMPLEMENTATION: DeterministicGraderImplementationV1 = {
  grader_id: PLAN_CONTRACT_GRADER_ID,
  grader_version: 1,
  implementation_sha256: sha256("penny.plan-contract-grader.v1:implementation:2"),
  grade: gradePlanContract,
};

export const PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION: DeterministicGraderImplementationV1 = {
  grader_id: PLAN_KNOWN_DELTA_GRADER_ID,
  grader_version: 1,
  implementation_sha256: sha256("penny.plan-known-delta-grader.v1:implementation:2"),
  grade: gradePlanKnownDelta,
};

export function planGraderDescriptor(input: {
  readonly graderCaseId: string;
  readonly graderId: typeof PLAN_CONTRACT_GRADER_ID | typeof PLAN_KNOWN_DELTA_GRADER_ID;
  readonly protectedCapability: boolean;
  readonly oracle: DeterministicGraderDescriptorV1["oracle"];
}): DeterministicGraderDescriptorV1 {
  return {
    schema_version: 1,
    grader_case_id: input.graderCaseId,
    grader_id: input.graderId,
    grader_version: 1,
    protected_capability: input.protectedCapability,
    wire: STRATEGY_GRADING_WIRE,
    oracle: input.oracle,
  };
}

const PlanPartBOracleSetV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    oracles: Type.Array(
      Type.Object(
        {
          task_id: Type.String({ minLength: 1, maxLength: 256 }),
          expected_disposition: Type.Union([
            Type.Literal("ready"),
            Type.Literal("blocked"),
            Type.Literal("not_applicable"),
          ]),
          expected_blocker_presence: Type.Union([Type.Literal("none"), Type.Literal("nonempty")]),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 64 }
    ),
  },
  { additionalProperties: false }
);
export type PlanPartBOracleSetV1 = Readonly<Static<typeof PlanPartBOracleSetV1Schema>>;

export function validatePlanPartBOracleSet(value: unknown): PlanPartBOracleSetV1 {
  const validated = validateContract(PlanPartBOracleSetV1Schema, value, "Plan Part B oracle set");
  if (
    new Set(validated.oracles.map((oracle) => oracle.task_id)).size !== validated.oracles.length
  ) {
    throw new Error("Plan Part B oracle task IDs must be unique");
  }
  return validated;
}

export interface PlanEvaluationGraderBindingV1 {
  readonly descriptor: DeterministicGraderDescriptorV1;
  readonly implementation: DeterministicGraderImplementationV1;
}

export function createPlanPartBGradingDefinition(input: {
  readonly population: EvaluationPopulationV1;
  readonly oracleSet: PlanPartBOracleSetV1;
}): EvaluationGradingDefinitionV1 {
  if (input.population.purpose !== "part_b") {
    throw new Error("Plan Part B grading requires purpose:part_b");
  }
  const tasks = new Map(input.population.tasks.map((task) => [task.task_id, task]));
  const oracles = new Map(input.oracleSet.oracles.map((oracle) => [oracle.task_id, oracle]));
  if (tasks.size !== oracles.size || [...tasks.keys()].some((taskId) => !oracles.has(taskId))) {
    throw new Error("Plan Part B oracle task IDs must exactly cover the frozen population");
  }
  const definition = createPlanEvaluationGradingDefinition({
    purpose: "part_b",
    graders: [...tasks.values()].map((task) => {
      const oracle = oracles.get(task.task_id);
      if (oracle === undefined) throw new Error(`Plan Part B oracle '${task.task_id}' is absent`);
      const request = canonicalizePlanRequest({
        goal: task.goal,
        constraints: task.constraints,
        exactInputArtifactIds: task.exact_input_artifact_ids,
      });
      return {
        descriptor: planGraderDescriptor({
          graderCaseId: task.grader_case_id,
          graderId: PLAN_CONTRACT_GRADER_ID,
          protectedCapability: true,
          oracle: {
            expected_disposition: oracle.expected_disposition,
            expected_desired_outcome_ids:
              oracle.expected_disposition === "not_applicable"
                ? []
                : [...planRequestItemIds(request).desired_outcome_ids],
            expected_dependency_kinds: [],
            expected_blocker_presence: oracle.expected_blocker_presence,
            oracle_marker: `PLAN_PART_B_ORACLE_${task.task_id}`,
          },
        }),
        implementation: PLAN_CONTRACT_GRADER_IMPLEMENTATION,
      };
    }),
  });
  return {
    descriptor: {
      ...definition.descriptor,
      semantic_normalizers: definition.descriptor.semantic_normalizers.filter(
        (descriptor) => descriptor.registration_name !== PLAN_UNSEALED_EVALUATION_NAME
      ),
    },
    implementations: {
      ...definition.implementations,
      semantic_normalizers: new Map(
        [...definition.implementations.semantic_normalizers].filter(
          ([registrationName]) => registrationName !== PLAN_UNSEALED_EVALUATION_NAME
        )
      ),
    },
  };
}

export function createPlanEvaluationGradingDefinition(input: {
  readonly purpose: EvaluationPurposeV1;
  readonly graders: readonly PlanEvaluationGraderBindingV1[];
}): EvaluationGradingDefinitionV1 {
  const graders = [...input.graders].sort((left, right) =>
    left.descriptor.grader_case_id.localeCompare(right.descriptor.grader_case_id)
  );
  for (const grader of graders) {
    if (canonicalJson(grader.descriptor.wire) !== canonicalJson(STRATEGY_GRADING_WIRE)) {
      throw new Error(`Plan grader '${grader.descriptor.grader_case_id}' targets the wrong wire`);
    }
    if (
      grader.descriptor.grader_id === PLAN_KNOWN_DELTA_GRADER_ID &&
      input.purpose !== "harness_self_test"
    ) {
      throw new Error("Plan known-delta grader is restricted to purpose:harness_self_test");
    }
  }
  return {
    descriptor: {
      schema_version: 1,
      wire: STRATEGY_GRADING_WIRE,
      semantic_normalizers: [...PLAN_EVALUATION_NORMALIZER_DESCRIPTORS],
      graders: graders.map((grader) => grader.descriptor),
    },
    implementations: {
      semantic_normalizers: NORMALIZER_IMPLEMENTATIONS,
      graders: new Map(
        graders.map((grader) => [grader.descriptor.grader_case_id, grader.implementation])
      ),
    },
  };
}
