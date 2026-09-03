import { Type, type Static } from "typebox";

import {
  DECIDE_CANDIDATE_REGISTRATION,
  DECIDE_EVALUATION_ABLATION_REGISTRY,
  DECIDE_LIVENESS_POLICY,
  DECIDE_PLAYBOOK_NAME,
  DECIDE_UNSEALED_EVALUATION_NAME,
  DecisionCoreV2Schema,
  canonicalJson,
  canonicalizeDecisionRequest,
  parsePersistedDecisionDraft,
  projectDecisionDraft,
  sha256,
  validateContract,
  validateDecision,
  DecisionDraftValidationError,
  type DecisionCoreV2,
  type DecisionDraftV2,
  type DecisionRequestV1,
  type PlaybookRegistryV1,
} from "@penny/orchestration/source";

import type { SemanticClauseResultV1 } from "./evaluation-contracts.js";
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
  DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3,
  DecisionSemanticEvaluationV3Schema,
  DecideStructuredExpectationsV3Schema,
  createDecisionSemanticOracleProjectionV3,
  createDecisionSemanticTrialProjectionV3,
  type DecisionSemanticEvaluationV3,
  type SemanticOracleContaminationAttestationV1,
  type SemanticOracleDerivationAttestationV1,
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

export const DIRECT_DECIDE_DEMETRI_BASELINE_NAME = "evaluation-direct-demetri-decide";

export const DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION = createDirectAgentBaselineRegistration({
  registrationName: DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
  agent: "demetri",
  phase: "deciding",
  guidance: {
    skill_root: "evals/guidance/decide",
    resolution: "per_agent_phase",
  },
  output: {
    portName: "direct_decision_evaluation_report",
    artifactKind: "decision-report",
    schemaId: "penny.direct-decision-evaluation-report.v2",
    schemaVersion: 2,
    mediaType: "text/plain; charset=utf-8",
  },
  liveness: {
    resolverId: "decideEvaluationLivenessPolicy",
    policy: DECIDE_LIVENESS_POLICY,
  },
  allowedTools: ["artifact_read"],
});

export const DECIDE_EVALUATION_CANDIDATE_REGISTRY: PlaybookRegistryV1 = new Map([
  [DECIDE_CANDIDATE_REGISTRATION.name, DECIDE_CANDIDATE_REGISTRATION],
]);
export { DECIDE_EVALUATION_ABLATION_REGISTRY };

export const DECISION_GRADING_WIRE: EvaluationSemanticWireV1 = {
  schema_id: "penny.decision-evaluation.v2",
  schema_version: 2,
};

export const DecisionEvaluationV2Schema = Type.Object(
  {
    ...DecisionCoreV2Schema.properties,
    execution_started: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type DecisionEvaluationV2 = Readonly<Static<typeof DecisionEvaluationV2Schema>>;
export type DecisionGradingWireV2 = DecisionEvaluationV2;

const DirectDecisionFeasibilityEntryV2Schema = Type.Object(
  {
    alternative_id: DecisionCoreV2Schema.properties.feasibility.items.properties.alternative_id,
    status: Type.Union([
      Type.Literal("feasible"),
      Type.Literal("infeasible"),
      Type.Literal("undetermined"),
      Type.Literal("unknown"),
      Type.Literal("conditionally_feasible"),
    ]),
  },
  { additionalProperties: false }
);

/** Direct-baseline report core only; candidate, draft, and DecisionV2 schemas remain strict. */
export const DirectDecisionEvaluationCoreV2Schema = Type.Object(
  {
    ...DecisionCoreV2Schema.properties,
    feasibility: Type.Array(DirectDecisionFeasibilityEntryV2Schema, { maxItems: 24 }),
    blocking_questions: Type.Optional(
      Type.Array(DecisionCoreV2Schema.properties.blocking_questions.items, {
        maxItems: 16,
        uniqueItems: true,
      })
    ),
  },
  { additionalProperties: false }
);
function normalizeDirectDecisionEvaluationCore(
  value: unknown,
  request: DecisionRequestV1
): DecisionCoreV2 {
  const report = validateContract(
    DirectDecisionEvaluationCoreV2Schema,
    value,
    "direct Decision evaluation core"
  );
  const alternativeIds = new Set(
    request.alternatives.map((alternative) => alternative.alternative_id)
  );
  const { blocking_questions: blockingQuestions, ...core } = report;
  return validateContract(
    DecisionCoreV2Schema,
    {
      ...core,
      feasibility: report.feasibility.map((entry) => ({
        alternative_id: entry.alternative_id,
        status:
          entry.status === "unknown" || entry.status === "conditionally_feasible"
            ? "undetermined"
            : entry.status,
      })),
      basis_ids_used: report.basis_ids_used.filter((basisId) => !alternativeIds.has(basisId)),
      sensitivity: report.sensitivity.map((item) => ({
        ...item,
        basis_ids: item.basis_ids.filter((basisId) => !alternativeIds.has(basisId)),
      })),
      ...(blockingQuestions === undefined || blockingQuestions.length === 0
        ? {}
        : { blocking_questions: blockingQuestions }),
    },
    "normalized direct Decision evaluation core"
  );
}

export function projectDecisionEvaluation(
  draft: DecisionDraftV2,
  executionStarted: false
): DecisionEvaluationV2 {
  return validateContract(
    DecisionEvaluationV2Schema,
    {
      schema_version: draft.schema_version,
      outcome: draft.outcome,
      applicability_reason: draft.applicability_reason,
      feasibility: draft.feasibility,
      recommendation: draft.recommendation,
      comparison_dimension_ids: draft.comparison_dimension_ids,
      basis_ids_used: draft.basis_ids_used,
      sensitivity: draft.sensitivity,
      has_blocking_unresolved: draft.has_blocking_unresolved,
      ...(draft.blocking_questions === undefined
        ? {}
        : { blocking_questions: draft.blocking_questions }),
      confidence: draft.confidence,
      execution_started: executionStarted,
    },
    "projected DecisionEvaluationV2"
  );
}

/** Direct baseline applies its closed alias adapter before the shared strict Decision semantics. */
export function parseDirectDecisionEvaluationReport(
  text: string,
  input: {
    readonly request: DecisionRequestV1;
    readonly exactInputArtifactIds: readonly string[];
  }
): DecisionEvaluationV2 {
  const parsed = parsePersistedDecisionDraft(Buffer.from(text, "utf8"), input, (value) =>
    normalizeDirectDecisionEvaluationCore(value, input.request)
  );
  return projectDecisionEvaluation(parsed.draft, false);
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
    target_wire: DECISION_GRADING_WIRE,
  };
}

export const DECIDE_EVALUATION_NORMALIZER_DESCRIPTORS: readonly EvaluationSemanticNormalizerDescriptorV1[] =
  [
    normalizerDescriptor({
      registrationName: DECIDE_PLAYBOOK_NAME,
      normalizerId: "penny.sealed-decision-evaluation-normalizer.v7",
      normalizerVersion: 7,
      artifactKind: "semantic-core",
      schemaId: "penny.decision.v2",
      schemaVersion: 2,
    }),
    normalizerDescriptor({
      registrationName: DECIDE_UNSEALED_EVALUATION_NAME,
      normalizerId: "penny.decision-draft-evaluation-normalizer.v7",
      normalizerVersion: 7,
      artifactKind: "decision-draft",
      schemaId: "penny.decision-draft.v2",
      schemaVersion: 2,
    }),
    normalizerDescriptor({
      registrationName: DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
      normalizerId: "penny.direct-decision-report-normalizer.v8",
      normalizerVersion: 8,
      artifactKind: "decision-report",
      schemaId: "penny.direct-decision-evaluation-report.v2",
      schemaVersion: 2,
    }),
  ].sort((left, right) => left.registration_name.localeCompare(right.registration_name));

function failureCode(failureClass: DecisionDraftValidationError["failureClass"]): string {
  switch (failureClass) {
    case "FRAMING_INVALID":
      return "MODEL_OUTPUT_FRAMING_INVALID";
    case "JSON_INVALID":
      return "MODEL_OUTPUT_JSON_INVALID";
    case "SCHEMA_INVALID":
      return "MODEL_OUTPUT_SCHEMA_INVALID";
    case "SEMANTIC_INVALID":
      return "MODEL_OUTPUT_SEMANTIC_INVALID";
    case "LINEAGE_INVALID":
      return "ROUTING_METADATA_INVALID";
  }
}

function invalidDecisionOutput(failure: string): EvaluationSemanticNormalizationV1 {
  return { status: "invalid_output", failure_code: failure };
}

function taskRequest(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): DecisionRequestV1 {
  return canonicalizeDecisionRequest({
    goal: input.task.goal,
    constraints: input.task.constraints,
  });
}

class DecisionEvaluationMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionEvaluationMetadataError";
  }
}

interface AdmittedDecisionBasisProvenanceV1 {
  readonly requestArtifactId?: string;
  readonly semanticInputArtifactIds: readonly string[];
}

function admittedDecisionBasisProvenance(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0],
  requestRequired: boolean
): AdmittedDecisionBasisProvenanceV1 {
  const metadata = input.output_metadata;
  if (
    metadata.run_id !== input.output_ref.run_id ||
    metadata.phase !== input.output_ref.phase ||
    metadata.branch_id !== input.output_ref.branch_id ||
    metadata.kind !== input.output_ref.kind ||
    metadata.operation_id !== input.output_ref.operation_id ||
    metadata.version !== input.output_ref.version ||
    metadata.producer !== input.output_ref.producer ||
    metadata.media_type !== input.output_ref.media_type ||
    canonicalJson(metadata.content_schema ?? null) !==
      canonicalJson(input.output_ref.content_schema ?? null)
  ) {
    throw new DecisionEvaluationMetadataError(
      "decision normalizer output metadata diverged from its verified artifact ref"
    );
  }
  const upstreamIds = metadata.upstream_refs.map((ref) => ref.artifact_id);
  if (new Set(upstreamIds).size !== upstreamIds.length) {
    throw new DecisionEvaluationMetadataError(
      "decision normalizer output metadata contains duplicate upstream refs"
    );
  }
  const requestLikeRefs = metadata.upstream_refs.filter(
    (ref) =>
      ref.kind === "decision-request" ||
      ref.content_schema?.schema_id === "penny.decision-request.v1"
  );
  const admittedRequestRefs = requestLikeRefs.filter(
    (ref) =>
      ref.run_id === input.output_ref.run_id &&
      ref.branch_id === input.output_ref.branch_id &&
      ref.phase === "intake" &&
      ref.kind === "decision-request" &&
      ref.media_type === "application/json" &&
      ref.producer === "host:request-admission" &&
      ref.content_schema?.schema_id === "penny.decision-request.v1" &&
      ref.content_schema.schema_version === 1
  );
  if (
    requestLikeRefs.length !== admittedRequestRefs.length ||
    admittedRequestRefs.length > 1 ||
    (requestRequired && admittedRequestRefs.length !== 1)
  ) {
    throw new DecisionEvaluationMetadataError(
      "decision normalizer requires one unique same-run admitted decision-request upstream"
    );
  }
  const suppliedInputIds = new Set(input.task.exact_input_artifact_ids);
  const semanticInputArtifactIds = metadata.upstream_refs
    .filter(
      (ref) =>
        suppliedInputIds.has(ref.artifact_id) &&
        ref.kind === "semantic-core" &&
        ref.content_schema?.schema_id === "penny.grounded-synthesis.v1" &&
        ref.content_schema.schema_version === 1
    )
    .map((ref) => ref.artifact_id)
    .sort((left, right) => left.localeCompare(right));
  return {
    ...(admittedRequestRefs[0] === undefined
      ? {}
      : { requestArtifactId: admittedRequestRefs[0].artifact_id }),
    semanticInputArtifactIds,
  };
}

function normalizeDraftOutputWithCoreAdapter(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0],
  requestRequired: boolean,
  coreAdapter?: (value: unknown, request: DecisionRequestV1) => unknown
): EvaluationSemanticNormalizationV1 {
  try {
    const provenance = admittedDecisionBasisProvenance(input, requestRequired);
    const request = taskRequest(input);
    const draft = parsePersistedDecisionDraft(
      Buffer.from(input.output_bytes, "utf8"),
      {
        request,
        exactInputArtifactIds: provenance.semanticInputArtifactIds,
        ...(provenance.requestArtifactId === undefined
          ? {}
          : { requestArtifactId: provenance.requestArtifactId }),
      },
      coreAdapter === undefined ? undefined : (value) => coreAdapter(value, request)
    ).draft;
    return {
      status: "normalized",
      wire_bytes: canonicalJson(projectDecisionEvaluation(draft, false)),
    };
  } catch (error) {
    return invalidDecisionOutput(
      error instanceof DecisionDraftValidationError
        ? failureCode(error.failureClass)
        : error instanceof DecisionEvaluationMetadataError
          ? "ROUTING_METADATA_INVALID"
          : "MODEL_OUTPUT_SEMANTIC_INVALID"
    );
  }
}

function normalizeDraftOutput(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): EvaluationSemanticNormalizationV1 {
  return normalizeDraftOutputWithCoreAdapter(input, true);
}

function normalizeDirectReportOutput(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): EvaluationSemanticNormalizationV1 {
  return normalizeDraftOutputWithCoreAdapter(input, false, normalizeDirectDecisionEvaluationCore);
}

const DRAFT_NORMALIZER: EvaluationSemanticNormalizerImplementationV1 = {
  normalizer_id: "penny.decision-draft-evaluation-normalizer.v7",
  normalizer_version: 7,
  implementation_sha256: sha256(
    "penny.decision-draft-evaluation-normalizer.v7:admitted-semantic-bases-no-request-transport:1"
  ),
  normalize: normalizeDraftOutput,
};

const DIRECT_REPORT_NORMALIZER: EvaluationSemanticNormalizerImplementationV1 = {
  normalizer_id: "penny.direct-decision-report-normalizer.v8",
  normalizer_version: 8,
  implementation_sha256: sha256(
    "penny.direct-decision-report-normalizer.v8:closed-adapter-admitted-semantic-bases:1"
  ),
  normalize: normalizeDirectReportOutput,
};

const SEALED_DECISION_NORMALIZER: EvaluationSemanticNormalizerImplementationV1 = {
  normalizer_id: "penny.sealed-decision-evaluation-normalizer.v7",
  normalizer_version: 7,
  implementation_sha256: sha256(
    "penny.sealed-decision-evaluation-normalizer.v7:verified-provenance-admitted-semantic-bases-no-request-transport:1"
  ),
  normalize: (input) => {
    let value: unknown;
    try {
      value = JSON.parse(input.output_bytes);
    } catch {
      return invalidDecisionOutput("MODEL_OUTPUT_JSON_INVALID");
    }
    try {
      const provenance = admittedDecisionBasisProvenance(input, true);
      const decision = validateDecision(value);
      const request = taskRequest(input);
      if (
        provenance.requestArtifactId === undefined ||
        canonicalJson(decision) !== input.output_bytes ||
        canonicalJson(decision.request) !== canonicalJson(request) ||
        decision.source_lineage.request_artifact_id !== provenance.requestArtifactId ||
        canonicalJson(decision.source_lineage.input_artifact_ids) !==
          canonicalJson(provenance.semanticInputArtifactIds)
      ) {
        return invalidDecisionOutput("MODEL_OUTPUT_SEMANTIC_INVALID");
      }
      const draft = projectDecisionDraft(decision);
      return {
        status: "normalized",
        wire_bytes: canonicalJson(projectDecisionEvaluation(draft, decision.execution_started)),
      };
    } catch (error) {
      return invalidDecisionOutput(
        error instanceof DecisionDraftValidationError
          ? failureCode(error.failureClass)
          : error instanceof DecisionEvaluationMetadataError
            ? "ROUTING_METADATA_INVALID"
            : "MODEL_OUTPUT_SCHEMA_INVALID"
      );
    }
  },
};

const NORMALIZER_IMPLEMENTATIONS: ReadonlyMap<
  string,
  EvaluationSemanticNormalizerImplementationV1
> = new Map([
  [DECIDE_PLAYBOOK_NAME, SEALED_DECISION_NORMALIZER],
  [DECIDE_UNSEALED_EVALUATION_NAME, DRAFT_NORMALIZER],
  [DIRECT_DECIDE_DEMETRI_BASELINE_NAME, DIRECT_REPORT_NORMALIZER],
]);

export interface DecisionSafeRecoveryReplayEntryV1 {
  readonly trial_id: string;
  readonly arm: "baseline" | "candidate" | "ablation";
  readonly registration_name: string;
  readonly recorded_normalized: boolean;
  readonly output_ref: Parameters<
    EvaluationSemanticNormalizerImplementationV1["normalize"]
  >[0]["output_ref"];
  readonly output_metadata: Parameters<
    EvaluationSemanticNormalizerImplementationV1["normalize"]
  >[0]["output_metadata"];
  readonly output_bytes: string;
  readonly task: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]["task"];
}

export interface DecisionSafeRecoveryReplayDiagnosticV1 {
  readonly replay_input_sha256: string;
  readonly per_arm: readonly {
    readonly arm: DecisionSafeRecoveryReplayEntryV1["arm"];
    readonly scheduled: number;
    readonly recorded_normalized: number;
    readonly projected_safe_normalized: number;
    readonly projected_safe_recovered: number;
  }[];
  readonly recorded_normalized: number;
  readonly projected_safe_normalized: number;
  readonly projected_safe_recovered: number;
}

/** Deterministic, read-only replay projection; it never persists or rewrites an evaluation result. */
export function replayDecisionSafeRecoveryDiagnostic(
  entries: readonly DecisionSafeRecoveryReplayEntryV1[]
): DecisionSafeRecoveryReplayDiagnosticV1 {
  const trialIds = entries.map((entry) => entry.trial_id);
  if (new Set(trialIds).size !== trialIds.length) {
    throw new Error("decision safe-recovery replay trial IDs must be unique");
  }
  const normalizedByTrial = new Map<string, boolean>();
  for (const entry of entries) {
    const descriptor = DECIDE_EVALUATION_NORMALIZER_DESCRIPTORS.find(
      (candidate) => candidate.registration_name === entry.registration_name
    );
    const implementation = NORMALIZER_IMPLEMENTATIONS.get(entry.registration_name);
    if (descriptor === undefined || implementation === undefined) {
      throw new Error(
        `decision safe-recovery replay normalizer '${entry.registration_name}' is absent`
      );
    }
    const normalized = implementation.normalize({
      descriptor,
      wire: DECISION_GRADING_WIRE,
      output_ref: entry.output_ref,
      output_metadata: entry.output_metadata,
      output_bytes: entry.output_bytes,
      task: entry.task,
    });
    normalizedByTrial.set(entry.trial_id, normalized.status === "normalized");
  }
  const arms = ["baseline", "candidate", "ablation"] as const;
  const perArm = arms.map((arm) => {
    const armEntries = entries.filter((entry) => entry.arm === arm);
    const recordedNormalized = armEntries.filter((entry) => entry.recorded_normalized).length;
    const projectedSafeNormalized = armEntries.filter(
      (entry) => normalizedByTrial.get(entry.trial_id) === true
    ).length;
    if (recordedNormalized > projectedSafeNormalized) {
      throw new Error("decision safe-recovery replay cannot reduce a recorded normalization");
    }
    return {
      arm,
      scheduled: armEntries.length,
      recorded_normalized: recordedNormalized,
      projected_safe_normalized: projectedSafeNormalized,
      projected_safe_recovered: projectedSafeNormalized - recordedNormalized,
    };
  });
  return {
    replay_input_sha256: sha256(canonicalJson(entries)),
    per_arm: perArm,
    recorded_normalized: perArm.reduce((sum, arm) => sum + arm.recorded_normalized, 0),
    projected_safe_normalized: perArm.reduce((sum, arm) => sum + arm.projected_safe_normalized, 0),
    projected_safe_recovered: perArm.reduce((sum, arm) => sum + arm.projected_safe_recovered, 0),
  };
}

/**
 * Additive correctness-first Decide semantic wire. Historical Decision V2
 * normalizers and graders remain unchanged above. This wire adds the bounded
 * rationale report and intentionally excludes execution, transport, provenance,
 * arm, receipt, artifact, and performance metadata.
 */
export const DECISION_SEMANTIC_GRADING_WIRE_V3: EvaluationSemanticWireV1 = {
  schema_id: "penny.decision-semantic-evaluation.v3",
  schema_version: 3,
};

export const DECISION_SEMANTIC_V3_FIELD_NAMES = [
  "applicability_reason",
  "basis_ids_used",
  "blocking_questions",
  "comparison_dimension_ids",
  "confidence",
  "feasibility",
  "has_blocking_unresolved",
  "outcome",
  "rationale_report",
  "recommendation",
  "schema_version",
  "sensitivity",
] as const;

export { DecisionSemanticEvaluationV3Schema };
export type { DecisionSemanticEvaluationV3 };

export function projectDecisionSemanticEvaluationV3(
  draft: DecisionDraftV2
): DecisionSemanticEvaluationV3 {
  return validateContract(
    DecisionSemanticEvaluationV3Schema,
    {
      schema_version: 3,
      rationale_report: draft.rationale_report,
      outcome: draft.outcome,
      applicability_reason: draft.applicability_reason,
      feasibility: draft.feasibility,
      recommendation: draft.recommendation,
      comparison_dimension_ids: draft.comparison_dimension_ids,
      basis_ids_used: draft.basis_ids_used,
      sensitivity: draft.sensitivity,
      has_blocking_unresolved: draft.has_blocking_unresolved,
      ...(draft.blocking_questions === undefined
        ? {}
        : { blocking_questions: draft.blocking_questions }),
      confidence: draft.confidence,
    },
    "projected DecisionSemanticEvaluationV3"
  );
}

function decisionSemanticV3NormalizerDescriptor(input: {
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
    normalizer_version: 9,
    source_output: {
      artifact_kind: input.artifactKind,
      schema_id: input.schemaId,
      schema_version: input.schemaVersion,
    },
    target_wire: DECISION_SEMANTIC_GRADING_WIRE_V3,
  };
}

export const DECIDE_SEMANTIC_V3_NORMALIZER_DESCRIPTORS: readonly EvaluationSemanticNormalizerDescriptorV1[] =
  [
    decisionSemanticV3NormalizerDescriptor({
      registrationName: DECIDE_PLAYBOOK_NAME,
      normalizerId: "penny.sealed-decision-semantic-normalizer.v9",
      artifactKind: "semantic-core",
      schemaId: "penny.decision.v2",
      schemaVersion: 2,
    }),
    decisionSemanticV3NormalizerDescriptor({
      registrationName: DECIDE_UNSEALED_EVALUATION_NAME,
      normalizerId: "penny.decision-draft-semantic-normalizer.v9",
      artifactKind: "decision-draft",
      schemaId: "penny.decision-draft.v2",
      schemaVersion: 2,
    }),
    decisionSemanticV3NormalizerDescriptor({
      registrationName: DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
      normalizerId: "penny.direct-decision-semantic-normalizer.v9",
      artifactKind: "decision-report",
      schemaId: "penny.direct-decision-evaluation-report.v2",
      schemaVersion: 2,
    }),
  ].sort((left, right) => left.registration_name.localeCompare(right.registration_name));

function normalizeDecisionDraftSemanticV3WithAdapter(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0],
  requestRequired: boolean,
  coreAdapter?: (value: unknown, request: DecisionRequestV1) => unknown
): EvaluationSemanticNormalizationV1 {
  try {
    const provenance = admittedDecisionBasisProvenance(input, requestRequired);
    const request = taskRequest(input);
    const draft = parsePersistedDecisionDraft(
      Buffer.from(input.output_bytes, "utf8"),
      {
        request,
        exactInputArtifactIds: provenance.semanticInputArtifactIds,
        ...(provenance.requestArtifactId === undefined
          ? {}
          : { requestArtifactId: provenance.requestArtifactId }),
      },
      coreAdapter === undefined ? undefined : (value) => coreAdapter(value, request)
    ).draft;
    return {
      status: "normalized",
      wire_bytes: canonicalJson(projectDecisionSemanticEvaluationV3(draft)),
    };
  } catch (error) {
    return invalidDecisionOutput(
      error instanceof DecisionDraftValidationError
        ? failureCode(error.failureClass)
        : error instanceof DecisionEvaluationMetadataError
          ? "ROUTING_METADATA_INVALID"
          : "MODEL_OUTPUT_SEMANTIC_INVALID"
    );
  }
}

export function normalizeDecisionDraftSemanticV3(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): EvaluationSemanticNormalizationV1 {
  return normalizeDecisionDraftSemanticV3WithAdapter(input, true);
}

export function normalizeDirectDecisionSemanticV3(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): EvaluationSemanticNormalizationV1 {
  return normalizeDecisionDraftSemanticV3WithAdapter(
    input,
    false,
    normalizeDirectDecisionEvaluationCore
  );
}

export function normalizeSealedDecisionSemanticV3(
  input: Parameters<EvaluationSemanticNormalizerImplementationV1["normalize"]>[0]
): EvaluationSemanticNormalizationV1 {
  let value: unknown;
  try {
    value = JSON.parse(input.output_bytes);
  } catch {
    return invalidDecisionOutput("MODEL_OUTPUT_JSON_INVALID");
  }
  try {
    const provenance = admittedDecisionBasisProvenance(input, true);
    const decision = validateDecision(value);
    const request = taskRequest(input);
    if (
      provenance.requestArtifactId === undefined ||
      canonicalJson(decision) !== input.output_bytes ||
      canonicalJson(decision.request) !== canonicalJson(request) ||
      decision.source_lineage.request_artifact_id !== provenance.requestArtifactId ||
      canonicalJson(decision.source_lineage.input_artifact_ids) !==
        canonicalJson(provenance.semanticInputArtifactIds)
    ) {
      return invalidDecisionOutput("MODEL_OUTPUT_SEMANTIC_INVALID");
    }
    return {
      status: "normalized",
      wire_bytes: canonicalJson(
        projectDecisionSemanticEvaluationV3(projectDecisionDraft(decision))
      ),
    };
  } catch (error) {
    return invalidDecisionOutput(
      error instanceof DecisionDraftValidationError
        ? failureCode(error.failureClass)
        : error instanceof DecisionEvaluationMetadataError
          ? "ROUTING_METADATA_INVALID"
          : "MODEL_OUTPUT_SCHEMA_INVALID"
    );
  }
}

const DECIDE_SEMANTIC_V3_NORMALIZER_IMPLEMENTATIONS: ReadonlyMap<
  string,
  EvaluationSemanticNormalizerImplementationV1
> = new Map([
  [
    DECIDE_PLAYBOOK_NAME,
    {
      normalizer_id: "penny.sealed-decision-semantic-normalizer.v9",
      normalizer_version: 9,
      implementation_sha256: sha256(
        "penny.sealed-decision-semantic-normalizer.v9:bounded-rationale-semantic-only:1"
      ),
      normalize: normalizeSealedDecisionSemanticV3,
    },
  ],
  [
    DECIDE_UNSEALED_EVALUATION_NAME,
    {
      normalizer_id: "penny.decision-draft-semantic-normalizer.v9",
      normalizer_version: 9,
      implementation_sha256: sha256(
        "penny.decision-draft-semantic-normalizer.v9:bounded-rationale-semantic-only:1"
      ),
      normalize: normalizeDecisionDraftSemanticV3,
    },
  ],
  [
    DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
    {
      normalizer_id: "penny.direct-decision-semantic-normalizer.v9",
      normalizer_version: 9,
      implementation_sha256: sha256(
        "penny.direct-decision-semantic-normalizer.v9:bounded-rationale-semantic-only:1"
      ),
      normalize: normalizeDirectDecisionSemanticV3,
    },
  ],
]);

export function parseDecisionSemanticGradingWireV3(value: string): DecisionSemanticEvaluationV3 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Decision semantic grading wire V3 is not JSON");
  }
  const wire = validateContract(
    DecisionSemanticEvaluationV3Schema,
    parsed,
    "Decision semantic grading wire V3"
  );
  if (canonicalJson(wire) !== value) {
    throw new Error("Decision semantic grading wire V3 is not canonical JSON");
  }
  return wire;
}

export function validateDecideSemanticV3CommonWire(
  input: Parameters<EvaluationCommonWireValidatorV1>[0]
): void {
  if (canonicalJson(input.descriptor) !== canonicalJson(DECISION_SEMANTIC_GRADING_WIRE_V3)) {
    throw new Error("Decide semantic V3 preflight received a foreign common-wire descriptor");
  }
  parseDecisionSemanticGradingWireV3(input.wire_bytes);
}

export const DECIDE_SEMANTIC_V3_GRADER_ID = "penny.decide-semantic-clause-grader.v3";
export const DECIDE_SEMANTIC_CLAUSE_IDS = DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3;
export type DecideSemanticClauseIdV3 = (typeof DECIDE_SEMANTIC_CLAUSE_IDS)[number];

const DecideSemanticClauseIdV3Schema = Type.Union([
  Type.Literal("alternatives_against_hard_constraints"),
  Type.Literal("feasible_survivor_disposition_justification"),
  Type.Literal("common_dimension_comparison_no_invented_preferences"),
  Type.Literal("evidence_and_uncertainty_fidelity"),
  Type.Literal("decision_sensitivity_and_flip_conditions"),
  Type.Literal("disposition_internal_consistency"),
]);

export const DECIDE_SEMANTIC_DOD_MAPPING_V3 = [
  {
    clause_id: "alternatives_against_hard_constraints",
    plan_clause: "§9.3.1",
    grader_owner: "decide_semantic_clause_grader_v3",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "feasible_survivor_disposition_justification",
    plan_clause: "§9.3.2",
    grader_owner: "decide_semantic_clause_grader_v3",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "common_dimension_comparison_no_invented_preferences",
    plan_clause: "§9.3.3",
    grader_owner: "decide_semantic_clause_grader_v3",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "evidence_and_uncertainty_fidelity",
    plan_clause: "§9.3.4",
    grader_owner: "decide_semantic_clause_grader_v3",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "decision_sensitivity_and_flip_conditions",
    plan_clause: "§9.3.5",
    grader_owner: "decide_semantic_clause_grader_v3",
    substantive_review: "independent_semantic_judge_required",
  },
  {
    clause_id: "disposition_internal_consistency",
    plan_clause: "§9.3.6",
    grader_owner: "decide_semantic_clause_grader_v3",
    substantive_review: "independent_semantic_judge_required",
  },
] as const;

const DecideBoundedSemanticRefSchema = Type.String({ minLength: 1, maxLength: 256 });
const DecideSemanticClauseOutcomeSchema = Type.Union([
  Type.Literal("PASS"),
  Type.Literal("FAIL"),
  Type.Literal("UNVERIFIABLE"),
]);
const DecideSemanticClauseExpectationV3Schema = Type.Object(
  {
    clause_id: DecideSemanticClauseIdV3Schema,
    applicability: Type.Union([Type.Literal("applicable"), Type.Literal("not_applicable")]),
    semantic_review: Type.Union([
      Type.Literal("independent_semantic_judge_required"),
      Type.Literal("not_applicable"),
    ]),
    oracle_refs: Type.Array(DecideBoundedSemanticRefSchema, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    evidence_refs: Type.Array(DecideBoundedSemanticRefSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export const DecideSemanticGraderOracleV3Schema = Type.Object(
  {
    schema_version: Type.Literal(3),
    task_id: Type.String({ minLength: 1, maxLength: 256 }),
    structured_expectations: DecideStructuredExpectationsV3Schema,
    clauses: Type.Array(DecideSemanticClauseExpectationV3Schema, {
      minItems: DECIDE_SEMANTIC_CLAUSE_IDS.length,
      maxItems: DECIDE_SEMANTIC_CLAUSE_IDS.length,
    }),
    oracle_marker: Type.String({
      pattern: "^DECIDE_SEMANTIC_ORACLE_V3:[A-Z0-9][A-Z0-9_-]{0,127}$",
    }),
  },
  { additionalProperties: false }
);
export type DecideSemanticGraderOracleV3 = Readonly<
  Static<typeof DecideSemanticGraderOracleV3Schema>
>;

const DecideSemanticReviewClauseV1Schema = Type.Object(
  {
    clause_id: DecideSemanticClauseIdV3Schema,
    outcome: DecideSemanticClauseOutcomeSchema,
    reason: Type.String({ minLength: 1, maxLength: 1024 }),
    oracle_refs: Type.Array(DecideBoundedSemanticRefSchema, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    evidence_refs: Type.Array(DecideBoundedSemanticRefSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

/** A declared authorization ref is not authorization; the caller verifies it independently. */
export const DecideSemanticReviewOutputV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    skill: Type.Literal("decide"),
    task_id: Type.String({ minLength: 1, maxLength: 256 }),
    semantic_wire_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    oracle_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    reviewer_role: Type.Literal("independently_authorized_semantic_judge"),
    judge_authorization_ref: DecideBoundedSemanticRefSchema,
    clause_results: Type.Array(DecideSemanticReviewClauseV1Schema, {
      minItems: DECIDE_SEMANTIC_CLAUSE_IDS.length,
      maxItems: DECIDE_SEMANTIC_CLAUSE_IDS.length,
    }),
  },
  { additionalProperties: false }
);
export type DecideSemanticReviewOutputV1 = Readonly<
  Static<typeof DecideSemanticReviewOutputV1Schema>
>;

function validateDecideSemanticGraderOracleV3(value: unknown): DecideSemanticGraderOracleV3 {
  const oracle = validateContract(
    DecideSemanticGraderOracleV3Schema,
    value,
    "Decide semantic grader oracle V3"
  );
  if (
    canonicalJson(oracle.clauses.map((clause) => clause.clause_id)) !==
    canonicalJson(DECIDE_SEMANTIC_CLAUSE_IDS)
  ) {
    throw new Error(
      "Decide semantic grader oracle V3 must contain every clause in canonical order"
    );
  }
  if (
    oracle.clauses.some(
      (clause) =>
        (clause.applicability === "applicable") !==
        (clause.semantic_review === "independent_semantic_judge_required")
    )
  ) {
    throw new Error("Decide semantic clause applicability and review requirement must agree");
  }
  if (!oracle.clauses.some((clause) => clause.applicability === "applicable")) {
    throw new Error("Decide semantic grader oracle V3 requires at least one applicable clause");
  }
  return oracle;
}

export function validateDecideSemanticReviewOutputV1(value: unknown): DecideSemanticReviewOutputV1 {
  const output = validateContract(
    DecideSemanticReviewOutputV1Schema,
    value,
    "Decide semantic review output V1"
  );
  if (
    canonicalJson(output.clause_results.map((clause) => clause.clause_id)) !==
    canonicalJson(DECIDE_SEMANTIC_CLAUSE_IDS)
  ) {
    throw new Error("Decide semantic review output must contain every clause in canonical order");
  }
  return output;
}

function decideSameSorted(left: readonly string[], right: readonly string[]): boolean {
  const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b));
  return canonicalJson(sorted(left)) === canonicalJson(sorted(right));
}

function assertDecideOracleTaskBinding(
  task: Parameters<DeterministicGraderImplementationV1["grade"]>[1],
  oracle: DecideSemanticGraderOracleV3
): void {
  if (oracle.task_id !== task.task_id) {
    throw new Error("Decide semantic oracle task identity does not match the graded task");
  }
  const request = canonicalizeDecisionRequest({ goal: task.goal, constraints: task.constraints });
  const expected = oracle.structured_expectations;
  const expectedAlternatives = request.alternatives.map((item) => item.alternative_id);
  const expectedConstraints = request.hard_constraints.map((item) => item.constraint_id);
  const requestBasisIds = new Set<string>([
    ...request.hard_constraints.map((item) => item.constraint_id),
    ...request.objectives.map((item) => item.objective_id),
    ...request.preferences.map((item) => item.preference_id),
    ...request.uncertainties.map((item) => item.uncertainty_id),
    ...request.evidence.map((item) => item.evidence_id),
    ...task.exact_input_artifact_ids,
  ]);
  const comparisonIds = new Set<string>([
    ...request.objectives.map((item) => item.objective_id),
    ...request.preferences.map((item) => item.preference_id),
  ]);
  const requestFactsMatch =
    decideSameSorted(expected.expected_alternative_ids, expectedAlternatives) &&
    decideSameSorted(expected.expected_hard_constraint_ids, expectedConstraints) &&
    expected.allowed_basis_ids.every((id) => requestBasisIds.has(id)) &&
    expected.required_basis_ids.every((id) => expected.allowed_basis_ids.includes(id)) &&
    expected.required_sensitivity_basis_ids.every((id) =>
      expected.allowed_basis_ids.includes(id)
    ) &&
    expected.accepted_recommendations.every((recommendation) =>
      recommendation.alternative_ids.every((id) => expectedAlternatives.includes(id))
    ) &&
    expected.accepted_comparison_dimension_id_sets.every((ids) =>
      ids.every((id) => comparisonIds.has(id))
    );
  if (!requestFactsMatch) {
    throw new Error("Decide semantic oracle structured expectations diverge from the task request");
  }
}

function recommendationAccepted(
  actual: DecisionSemanticEvaluationV3["recommendation"],
  accepted: readonly DecisionSemanticEvaluationV3["recommendation"][]
): boolean {
  return accepted.some(
    (candidate) =>
      candidate.kind === actual.kind &&
      decideSameSorted(candidate.alternative_ids, actual.alternative_ids)
  );
}

function comparisonSetAccepted(
  actual: readonly string[],
  accepted: readonly (readonly string[])[]
): boolean {
  return accepted.some((candidate) => decideSameSorted(candidate, actual));
}

function decideClauseStructuralIssues(
  wire: DecisionSemanticEvaluationV3,
  oracle: DecideSemanticGraderOracleV3,
  clauseId: DecideSemanticClauseIdV3
): string[] {
  const expected = oracle.structured_expectations;
  const issues: string[] = [];
  const requireFact = (condition: boolean, code: string): void => {
    if (!condition) issues.push(code);
  };
  const feasibility = new Map(
    wire.feasibility.map((entry) => [entry.alternative_id, entry.status])
  );
  const expectedFeasibilityIds = expected.expected_feasibility.map((entry) => entry.alternative_id);
  const recommendationMatches = recommendationAccepted(
    wire.recommendation,
    expected.accepted_recommendations
  );
  switch (clauseId) {
    case "alternatives_against_hard_constraints":
      requireFact(
        decideSameSorted([...feasibility.keys()], expectedFeasibilityIds),
        "ALTERNATIVE_FEASIBILITY_SET_MISMATCH"
      );
      requireFact(
        expected.expected_feasibility.every((entry) => {
          const actual = feasibility.get(entry.alternative_id);
          return actual !== undefined && entry.allowed_statuses.includes(actual);
        }),
        "FEASIBILITY_STATUS_OUTSIDE_ORACLE_ENUM"
      );
      break;
    case "feasible_survivor_disposition_justification":
      requireFact(
        expected.allowed_outcomes.includes(wire.outcome),
        "DISPOSITION_OUTSIDE_ORACLE_ENUM"
      );
      requireFact(recommendationMatches, "RECOMMENDATION_RELATION_NOT_ACCEPTED");
      requireFact(
        wire.recommendation.alternative_ids.every(
          (alternativeId) => feasibility.get(alternativeId) === "feasible"
        ),
        "RECOMMENDATION_CONTAINS_NON_FEASIBLE_ALTERNATIVE"
      );
      break;
    case "common_dimension_comparison_no_invented_preferences":
      requireFact(
        comparisonSetAccepted(
          wire.comparison_dimension_ids,
          expected.accepted_comparison_dimension_id_sets
        ),
        "COMPARISON_DIMENSION_SET_NOT_ACCEPTED"
      );
      break;
    case "evidence_and_uncertainty_fidelity":
      requireFact(
        expected.required_basis_ids.every((id) => wire.basis_ids_used.includes(id)),
        "REQUIRED_BASIS_SET_INCOMPLETE"
      );
      requireFact(
        wire.basis_ids_used.every((id) => expected.allowed_basis_ids.includes(id)),
        "BASIS_ID_OUTSIDE_ORACLE_SET"
      );
      break;
    case "decision_sensitivity_and_flip_conditions": {
      const sensitivityBasisIds = new Set(wire.sensitivity.flatMap((entry) => entry.basis_ids));
      requireFact(
        expected.required_sensitivity_basis_ids.every((id) => sensitivityBasisIds.has(id)),
        "SENSITIVITY_BASIS_SET_INCOMPLETE"
      );
      break;
    }
    case "disposition_internal_consistency":
      requireFact(
        expected.allowed_outcomes.includes(wire.outcome),
        "DISPOSITION_OUTSIDE_ORACLE_ENUM"
      );
      requireFact(recommendationMatches, "DISPOSITION_RECOMMENDATION_RELATION_MISMATCH");
      requireFact(
        wire.has_blocking_unresolved === expected.expected_blocking_unresolved,
        "BLOCKING_UNRESOLVED_FLAG_MISMATCH"
      );
      requireFact(
        expected.expected_blocking_question_presence === "nonempty"
          ? (wire.blocking_questions?.length ?? 0) > 0
          : wire.blocking_questions === undefined,
        "BLOCKING_QUESTION_PRESENCE_MISMATCH"
      );
      requireFact(
        expected.allowed_confidence.includes(wire.confidence),
        "CONFIDENCE_OUTSIDE_ORACLE_ENUM"
      );
      break;
  }
  return issues;
}

function decideStructuralClauseResult(input: {
  readonly expectation: DecideSemanticGraderOracleV3["clauses"][number];
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
      "Closed structural facts match the oracle, but this substantive §9.3 clause requires natural-language/evidence judgment by an independently authorized semantic judge.",
    oracle_refs: [...input.expectation.oracle_refs],
    evidence_refs: [...input.expectation.evidence_refs],
  };
}

export function gradeDecisionSemanticClausesV3(
  wireBytes: string,
  task: Parameters<DeterministicGraderImplementationV1["grade"]>[1],
  descriptor: DeterministicGraderDescriptorV1
) {
  const oracle = validateDecideSemanticGraderOracleV3(descriptor.oracle);
  assertDecideOracleTaskBinding(task, oracle);
  const wire = parseDecisionSemanticGradingWireV3(wireBytes);
  const clause_results = oracle.clauses.map((expectation) =>
    decideStructuralClauseResult({
      expectation,
      issues:
        expectation.applicability === "applicable"
          ? decideClauseStructuralIssues(wire, oracle, expectation.clause_id)
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
    trigger_predicted: wire.outcome !== "not_applicable",
    protected_capability_score: descriptor.protected_capability ? score : null,
    clause_results,
  };
}

export function buildDecisionSemanticTrialReviewPacketV3(input: {
  readonly wireBytes: string;
  readonly task: Parameters<DeterministicGraderImplementationV1["grade"]>[1];
  readonly descriptor: DeterministicGraderDescriptorV1;
}): SemanticTrialReviewPacketV1 {
  const oracle = validateDecideSemanticGraderOracleV3(input.descriptor.oracle);
  assertDecideOracleTaskBinding(input.task, oracle);
  const request = canonicalizeDecisionRequest({
    goal: input.task.goal,
    constraints: input.task.constraints,
  });
  return buildSemanticTrialReviewPacketV1(
    createDecisionSemanticTrialProjectionV3({
      request,
      wire: parseDecisionSemanticGradingWireV3(input.wireBytes),
      clauses: oracle.clauses.map((clause) => ({
        clause_id: clause.clause_id,
        applicability: clause.applicability,
      })),
      structuredExpectations: oracle.structured_expectations,
    })
  );
}

export function buildDecisionSemanticOracleReviewPacketV3(input: {
  readonly task: Parameters<DeterministicGraderImplementationV1["grade"]>[1];
  readonly descriptor: DeterministicGraderDescriptorV1;
  readonly derivationAttestation: SemanticOracleDerivationAttestationV1;
  readonly contaminationAttestation: SemanticOracleContaminationAttestationV1;
}): SemanticOracleReviewPacketV1 {
  const oracle = validateDecideSemanticGraderOracleV3(input.descriptor.oracle);
  assertDecideOracleTaskBinding(input.task, oracle);
  const request = canonicalizeDecisionRequest({
    goal: input.task.goal,
    constraints: input.task.constraints,
  });
  return buildSemanticOracleReviewPacketV1(
    createDecisionSemanticOracleProjectionV3({
      request,
      structuredExpectations: oracle.structured_expectations,
      derivationAttestation: input.derivationAttestation,
      contaminationAttestation: input.contaminationAttestation,
    })
  );
}

function decideOracleReviewDisposition(input: {
  readonly evidence: VerifiedSemanticReviewEvidenceV1;
  readonly task: Parameters<DeterministicGraderImplementationV1["grade"]>[1];
  readonly oracle: DecideSemanticGraderOracleV3;
}): "PASS" | "FAIL" | "BLOCKED" {
  const packet = input.evidence.packet;
  if (packet.review_kind !== "oracle" || packet.skill !== "decide") {
    throw new Error("Decide oracle review evidence has a foreign packet kind or skill");
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
      canonicalJson(
        canonicalizeDecisionRequest({
          goal: input.task.goal,
          constraints: input.task.constraints,
        })
      ) ||
    !packet.oracle_projection.facts.some(
      (fact) => fact.content === canonicalJson(input.oracle.structured_expectations)
    )
  ) {
    throw new Error("Decide oracle review evidence is not bound to the exact task oracle");
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

export interface DecideSemanticQualificationStatusV3 {
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

export function decisionSemanticQualificationStatusV3(input: {
  readonly wireBytes: string;
  readonly task: Parameters<DeterministicGraderImplementationV1["grade"]>[1];
  readonly descriptor: DeterministicGraderDescriptorV1;
  readonly semanticReview?: VerifiedSemanticReviewEvidenceV1;
  readonly oracleReview?: VerifiedSemanticReviewEvidenceV1;
}): DecideSemanticQualificationStatusV3 {
  const oracle = validateDecideSemanticGraderOracleV3(input.descriptor.oracle);
  const structural = gradeDecisionSemanticClausesV3(input.wireBytes, input.task, input.descriptor);
  if (input.semanticReview === undefined) {
    return {
      task_disposition: "BLOCKED",
      qualification_status: "NOT_QUALIFIED",
      aggregate_success: false,
      reason_code: "INDEPENDENT_SEMANTIC_REVIEW_ABSENT",
      clause_results: structural.clause_results,
    };
  }
  const packet = buildDecisionSemanticTrialReviewPacketV3(input);
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
  const oracleReviewDisposition = decideOracleReviewDisposition({
    evidence: input.oracleReview,
    task: input.task,
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
      throw new Error("Decide semantic review clause is absent from the structural grade");
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

export const DECIDE_SEMANTIC_V3_GRADER_IMPLEMENTATION: DeterministicGraderImplementationV1 = {
  grader_id: DECIDE_SEMANTIC_V3_GRADER_ID,
  grader_version: 3,
  implementation_sha256: sha256(
    "penny.decide-semantic-clause-grader.v3:closed-structural-facts-independent-review-qualification:2"
  ),
  grade: gradeDecisionSemanticClausesV3,
  qualifySemanticReview: ({ wireBytes, task, descriptor, semanticReview, oracleReview }) =>
    decisionSemanticQualificationStatusV3({
      wireBytes,
      task,
      descriptor,
      semanticReview,
      oracleReview,
    }),
};

export function decisionSemanticV3GraderDescriptor(input: {
  readonly graderCaseId: string;
  readonly protectedCapability: boolean;
  readonly oracle: DecideSemanticGraderOracleV3;
}): DeterministicGraderDescriptorV1 {
  return {
    schema_version: 1,
    grader_case_id: input.graderCaseId,
    grader_id: DECIDE_SEMANTIC_V3_GRADER_ID,
    grader_version: 3,
    protected_capability: input.protectedCapability,
    wire: DECISION_SEMANTIC_GRADING_WIRE_V3,
    oracle: input.oracle,
  };
}

export function createDecisionSemanticV3GradingDefinition(input: {
  readonly graders: readonly DecisionEvaluationGraderBindingV2[];
}): EvaluationGradingDefinitionV1 {
  const graders = [...input.graders].sort((left, right) =>
    left.descriptor.grader_case_id.localeCompare(right.descriptor.grader_case_id)
  );
  for (const grader of graders) {
    if (
      grader.descriptor.grader_id !== DECIDE_SEMANTIC_V3_GRADER_ID ||
      grader.implementation.grader_id !== DECIDE_SEMANTIC_V3_GRADER_ID ||
      grader.descriptor.grader_version !== 3 ||
      grader.implementation.grader_version !== 3 ||
      canonicalJson(grader.descriptor.wire) !== canonicalJson(DECISION_SEMANTIC_GRADING_WIRE_V3)
    ) {
      throw new Error("Decide semantic V3 grading requires the exact V3 grader and wire");
    }
    validateDecideSemanticGraderOracleV3(grader.descriptor.oracle);
  }
  return {
    descriptor: {
      schema_version: 1,
      wire: DECISION_SEMANTIC_GRADING_WIRE_V3,
      semantic_normalizers: [...DECIDE_SEMANTIC_V3_NORMALIZER_DESCRIPTORS],
      graders: graders.map((grader) => grader.descriptor),
    },
    implementations: {
      semantic_normalizers: DECIDE_SEMANTIC_V3_NORMALIZER_IMPLEMENTATIONS,
      graders: new Map(
        graders.map((grader) => [grader.descriptor.grader_case_id, grader.implementation])
      ),
    },
  };
}

export function parseDecisionGradingWire(value: string): DecisionGradingWireV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Decision grading wire is not JSON");
  }
  const wire = validateContract(DecisionEvaluationV2Schema, parsed, "Decision grading wire");
  if (canonicalJson(wire) !== value) {
    throw new Error("Decision grading wire is not canonical JSON");
  }
  return wire;
}

export function validateDecisionEvaluationCommonWire(
  input: Parameters<EvaluationCommonWireValidatorV1>[0]
): void {
  if (canonicalJson(input.descriptor) !== canonicalJson(DECISION_GRADING_WIRE)) {
    throw new Error("Decide readiness preflight received a foreign common-wire descriptor");
  }
  parseDecisionGradingWire(input.wire_bytes);
}

export interface DecisionEvaluationGraderBindingV2 {
  readonly descriptor: DeterministicGraderDescriptorV1;
  readonly implementation: DeterministicGraderImplementationV1;
}

export function decisionGraderDescriptor(input: {
  readonly graderCaseId: string;
  readonly graderId: string;
  readonly graderVersion?: number;
  readonly protectedCapability: boolean;
  readonly oracle: DeterministicGraderDescriptorV1["oracle"];
}): DeterministicGraderDescriptorV1 {
  return {
    schema_version: 1,
    grader_case_id: input.graderCaseId,
    grader_id: input.graderId,
    grader_version: input.graderVersion ?? 1,
    protected_capability: input.protectedCapability,
    wire: DECISION_GRADING_WIRE,
    oracle: input.oracle,
  };
}

/** All descriptor and executable implementation identities are bound by the grading digest. */
export function createDecisionEvaluationGradingDefinition(
  graders: readonly DecisionEvaluationGraderBindingV2[],
  registrationNames: readonly string[] = DECIDE_EVALUATION_NORMALIZER_DESCRIPTORS.map(
    (descriptor) => descriptor.registration_name
  )
): EvaluationGradingDefinitionV1 {
  const requestedNames = [...registrationNames].sort((left, right) => left.localeCompare(right));
  if (new Set(requestedNames).size !== requestedNames.length || requestedNames.length < 1) {
    throw new Error("Decision grading registration names must be nonempty and unique");
  }
  const semanticNormalizers = DECIDE_EVALUATION_NORMALIZER_DESCRIPTORS.filter((descriptor) =>
    requestedNames.includes(descriptor.registration_name)
  );
  if (semanticNormalizers.length !== requestedNames.length) {
    throw new Error("Decision grading requested an unknown semantic normalizer registration");
  }
  const normalizerImplementations = new Map(
    requestedNames.map((registrationName) => {
      const implementation = NORMALIZER_IMPLEMENTATIONS.get(registrationName);
      if (implementation === undefined) {
        throw new Error(`Decision normalizer '${registrationName}' implementation is absent`);
      }
      return [registrationName, implementation] as const;
    })
  );
  const sortedGraders = [...graders].sort((left, right) =>
    left.descriptor.grader_case_id.localeCompare(right.descriptor.grader_case_id)
  );
  for (const grader of sortedGraders) {
    if (canonicalJson(grader.descriptor.wire) !== canonicalJson(DECISION_GRADING_WIRE)) {
      throw new Error(
        `Decision grader '${grader.descriptor.grader_case_id}' targets an incompatible wire`
      );
    }
  }
  return {
    descriptor: {
      schema_version: 1,
      wire: DECISION_GRADING_WIRE,
      semantic_normalizers: semanticNormalizers,
      graders: sortedGraders.map((grader) => grader.descriptor),
    },
    implementations: {
      semantic_normalizers: normalizerImplementations,
      graders: new Map(
        sortedGraders.map((grader) => [grader.descriptor.grader_case_id, grader.implementation])
      ),
    },
  };
}
