import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { ArtifactRefSchema, ConfidenceSchema, type ArtifactRef } from "../contracts.js";
import {
  ArtifactIdSchema,
  OpaqueIdSchema,
  Sha256Schema,
  TextSchema,
  assertDerivedId,
  assertOpaqueId,
  assertText,
  assertUnique,
  validateSkillSchema,
  SkillSchemaValidationError,
} from "./common.js";

const DecisionOutcomeV2Schema = Type.Union([
  Type.Literal("selected"),
  Type.Literal("ranked"),
  Type.Literal("no_feasible_option"),
  Type.Literal("unresolved"),
  Type.Literal("not_applicable"),
]);
const FeasibilityStatusV2Schema = Type.Union([
  Type.Literal("feasible"),
  Type.Literal("infeasible"),
  Type.Literal("undetermined"),
]);

const AlternativeV1Schema = Type.Object(
  {
    alternative_id: OpaqueIdSchema,
    label: TextSchema({ minBytes: 1, maxBytes: 512 }),
    description: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
  },
  { additionalProperties: false }
);
const ConstraintV1Schema = Type.Object(
  {
    constraint_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
  },
  { additionalProperties: false }
);
const ObjectiveV1Schema = Type.Object(
  {
    objective_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
  },
  { additionalProperties: false }
);
const PreferenceV1Schema = Type.Object(
  {
    preference_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
  },
  { additionalProperties: false }
);
const UncertaintyV1Schema = Type.Object(
  {
    uncertainty_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
  },
  { additionalProperties: false }
);
const EvidenceV1Schema = Type.Object(
  {
    evidence_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
  },
  { additionalProperties: false }
);

const DecisionRequestProperties = {
  schema_version: Type.Literal(1),
  decision_question: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
  alternatives: Type.Array(AlternativeV1Schema, { maxItems: 24 }),
  hard_constraints: Type.Array(ConstraintV1Schema, { maxItems: 32 }),
  objectives: Type.Array(ObjectiveV1Schema, { maxItems: 32 }),
  preferences: Type.Array(PreferenceV1Schema, { maxItems: 32 }),
  uncertainties: Type.Array(UncertaintyV1Schema, { maxItems: 32 }),
  evidence: Type.Array(EvidenceV1Schema, { maxItems: 64 }),
};

export const DecisionRequestV1Schema = Type.Object(DecisionRequestProperties, {
  additionalProperties: false,
});
export type DecisionRequestV1 = Readonly<Static<typeof DecisionRequestV1Schema>>;

export const DecisionRequestConstraintsV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    alternatives: DecisionRequestV1Schema.properties.alternatives,
    hard_constraints: DecisionRequestV1Schema.properties.hard_constraints,
    objectives: DecisionRequestV1Schema.properties.objectives,
    preferences: DecisionRequestV1Schema.properties.preferences,
    uncertainties: DecisionRequestV1Schema.properties.uncertainties,
    evidence: DecisionRequestV1Schema.properties.evidence,
  },
  { additionalProperties: false }
);
export type DecisionRequestConstraintsV1 = Readonly<
  Static<typeof DecisionRequestConstraintsV1Schema>
>;

const FeasibilityEntryV2Schema = Type.Object(
  {
    alternative_id: OpaqueIdSchema,
    status: FeasibilityStatusV2Schema,
  },
  { additionalProperties: false }
);
const RecommendationV2Schema = Type.Object(
  {
    kind: Type.Union([Type.Literal("selection"), Type.Literal("ranking"), Type.Literal("none")]),
    alternative_ids: Type.Array(OpaqueIdSchema, {
      maxItems: 24,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
const SensitivityV2Schema = Type.Object(
  {
    basis_ids: Type.Array(Type.Union([OpaqueIdSchema, ArtifactIdSchema]), {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
    resulting_decision_change: TextSchema({
      minBytes: 1,
      maxBytes: 8_192,
      multiline: true,
    }),
  },
  { additionalProperties: false }
);

const DecisionCoreProperties = {
  schema_version: Type.Literal(2),
  outcome: DecisionOutcomeV2Schema,
  applicability_reason: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
  feasibility: Type.Array(FeasibilityEntryV2Schema, { maxItems: 24 }),
  recommendation: RecommendationV2Schema,
  comparison_dimension_ids: Type.Array(OpaqueIdSchema, {
    maxItems: 32,
    uniqueItems: true,
  }),
  basis_ids_used: Type.Array(Type.Union([OpaqueIdSchema, ArtifactIdSchema]), {
    maxItems: 256,
    uniqueItems: true,
  }),
  sensitivity: Type.Array(SensitivityV2Schema, { maxItems: 32 }),
  has_blocking_unresolved: Type.Boolean(),
  blocking_questions: Type.Optional(
    Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    })
  ),
  confidence: ConfidenceSchema,
};

export const DecisionCoreV2Schema = Type.Object(DecisionCoreProperties, {
  additionalProperties: false,
});
export type DecisionCoreV2 = Readonly<Static<typeof DecisionCoreV2Schema>>;

export const MAX_DECISION_RATIONALE_REPORT_BYTES = 65_536;
export const MAX_PERSISTED_DECISION_DRAFT_BYTES = 131_072;

export const DecisionDraftV2Schema = Type.Object(
  {
    rationale_report: TextSchema({
      minBytes: 1,
      maxBytes: MAX_DECISION_RATIONALE_REPORT_BYTES,
      multiline: true,
    }),
    ...DecisionCoreProperties,
  },
  { additionalProperties: false }
);
export type DecisionDraftV2 = Readonly<Static<typeof DecisionDraftV2Schema>>;

export type DecisionDraftFailureClassV2 =
  | "FRAMING_INVALID"
  | "JSON_INVALID"
  | "SCHEMA_INVALID"
  | "SEMANTIC_INVALID"
  | "LINEAGE_INVALID";

export class DecisionDraftValidationError extends Error {
  constructor(
    readonly failureClass: DecisionDraftFailureClassV2,
    readonly issues: readonly string[]
  ) {
    super(`${failureClass}: ${issues.join("; ")}`);
    this.name = "DecisionDraftValidationError";
  }
}

export const DecisionSealFeedbackV2Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.decision-seal-feedback.v2"),
    schema_version: Type.Literal(2),
    attempt: Type.Literal(1),
    rejected_draft_artifact_id: ArtifactIdSchema,
    failure_class: Type.Union([
      Type.Literal("FRAMING_INVALID"),
      Type.Literal("JSON_INVALID"),
      Type.Literal("SCHEMA_INVALID"),
      Type.Literal("SEMANTIC_INVALID"),
    ]),
    issues: Type.Array(TextSchema({ minBytes: 1, maxBytes: 512 }), {
      minItems: 1,
      maxItems: 1_024,
    }),
  },
  { additionalProperties: false }
);
export type DecisionSealFeedbackV2 = Readonly<Static<typeof DecisionSealFeedbackV2Schema>>;

export function validateDecisionSealFeedback(value: unknown): DecisionSealFeedbackV2 {
  const feedback = validateSkillSchema(
    DecisionSealFeedbackV2Schema,
    value,
    "DecisionSealFeedbackV2"
  );
  for (const issue of feedback.issues) {
    validateText(issue, "DecisionSealFeedbackV2 issue", 512, false);
  }
  return feedback;
}

const DecisionRoutingSummaryV2Schema = Type.Object(
  {
    confidence: ConfidenceSchema,
    complete: Type.Literal(true),
  },
  { additionalProperties: false }
);
export type DecisionRoutingSummaryV2 = Readonly<Static<typeof DecisionRoutingSummaryV2Schema>>;

export function decisionDraftPromptContract(): string {
  return canonicalJson({
    schema: DecisionCoreV2Schema,
    transport: {
      encoding: "strict UTF-8",
      maximum_output_bytes: MAX_PERSISTED_DECISION_DRAFT_BYTES,
      rationale_report_bytes: { minimum: 1, maximum: MAX_DECISION_RATIONALE_REPORT_BYTES },
      canonical_framing:
        "bounded nonempty decision prose, immediately followed by DECISION_CORE:<single-line JSON>, immediately followed by final compact SUMMARY, with one LF between each line",
      generation_rule:
        "keep all Markdown inside rationale prose; use only canonical unwrapped adjacent machine marker lines",
      accepted_rationale_prose:
        "Markdown, including inline code and closed CommonMark backtick or tilde fences, is transport-neutral only inside the bounded rationale report",
      forbidden: [
        "BOM",
        "NUL",
        "CR",
        "backticks or code fences outside rationale prose",
        "backtick-wrapped or fenced DECISION_CORE or SUMMARY markers",
        "unclosed, mismatched, or short-closed rationale code fences",
        "whitespace-only lines",
        "alternate framing",
        "duplicate or marker-looking DECISION_CORE lines",
        "duplicate or marker-looking SUMMARY lines",
        "trailing text",
      ],
    },
    id_namespaces: {
      "feasibility[].alternative_id": "supplied alternatives[].alternative_id only",
      "recommendation.alternative_ids": "supplied alternatives[].alternative_id only",
      comparison_dimension_ids:
        "supplied hard_constraints[].constraint_id, objectives[].objective_id, or preferences[].preference_id only",
      basis_ids_used:
        "supplied constraint, objective, preference, uncertainty, evidence, or admitted prior grounded-synthesis artifact IDs only; request transport IDs are forbidden",
      "sensitivity[].basis_ids":
        "supplied constraint, objective, preference, uncertainty, evidence, or admitted prior grounded-synthesis artifact IDs only; request transport IDs are forbidden",
    },
    allowed_basis_artifact_roles: [
      "exact admitted prior grounded-synthesis semantic-core artifacts",
    ],
    forbidden_basis_artifact_roles: [
      "the host-admitted decision-request transport artifact",
      "prior decision drafts",
      "decision seal feedback",
      "analysis, evidence-packet, review-report, or review-receipt transport artifacts",
      "random, stale, wrong-run, or otherwise unadmitted artifacts",
    ],
    outcome_rules: {
      not_applicable:
        "empty feasibility, recommendation IDs, dimensions, blockers, and blocking questions; recommendation kind none; basis_ids_used and sensitivity may use only supplied basis IDs",
      selected: "exactly one recommended ID and it is feasible",
      ranked: "recommended IDs are the complete feasible set",
      no_feasible_option: "every supplied alternative is infeasible",
      unresolved:
        "has_blocking_unresolved true, recommendation kind none with no IDs, nonempty blocking_questions, and terminal assessment completion without claiming a selection",
      dispositive: "selected, ranked, and no_feasible_option have no blocker or blocking questions",
      selected_or_ranked:
        "nonempty sensitivity; nonempty comparison_dimension_ids when the feasible survivor set has more than one member",
    },
    summary: {
      framing:
        "immediately after DECISION_CORE with one LF, exactly one compact final SUMMARY object",
      schema: DecisionRoutingSummaryV2Schema,
      confidence_must_equal_core: true,
    },
    aliases_or_coercions: false,
    terminal_semantics:
      "every semantically valid outcome, including unresolved, is sealed as a complete DecisionV2 assessment; callers may rerun with updated facts",
    execution: "forbidden; host product always sets execution_started:false",
    host_semantic_validator: "validateDecisionDraft",
  });
}

const DecisionSourceLineagePreimageV2Schema = Type.Object(
  {
    request_artifact_id: ArtifactIdSchema,
    draft_artifact_id: ArtifactIdSchema,
    draft_sha256: Sha256Schema,
    input_artifact_ids: Type.Array(ArtifactIdSchema, {
      maxItems: 64,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type DecisionSourceLineagePreimageV2 = Readonly<
  Static<typeof DecisionSourceLineagePreimageV2Schema>
>;

export const DecisionSourceLineageV2Schema = Type.Object(
  {
    ...DecisionSourceLineagePreimageV2Schema.properties,
    lineage_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type DecisionSourceLineageV2 = Readonly<Static<typeof DecisionSourceLineageV2Schema>>;

export const DecisionV2Schema = Type.Object(
  {
    ...DecisionDraftV2Schema.properties,
    request: DecisionRequestV1Schema,
    request_sha256: Sha256Schema,
    source_lineage: DecisionSourceLineageV2Schema,
    execution_started: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type DecisionV2 = Readonly<Static<typeof DecisionV2Schema>>;

export function decisionSourceLineageSha256(value: unknown): string {
  return sha256(
    canonicalJson(
      validateSkillSchema(
        DecisionSourceLineagePreimageV2Schema,
        value,
        "DecisionV2 source lineage preimage"
      )
    )
  );
}

function validateText(value: string, label: string, maxBytes: number, multiline = true): void {
  assertText(value, label, {
    minBytes: 1,
    maxBytes,
    multiline,
    trimmedNonEmpty: true,
  });
}

function requestIdGroups(request: DecisionRequestV1): readonly (readonly string[])[] {
  return [
    request.alternatives.map((item) => item.alternative_id),
    request.hard_constraints.map((item) => item.constraint_id),
    request.objectives.map((item) => item.objective_id),
    request.preferences.map((item) => item.preference_id),
    request.uncertainties.map((item) => item.uncertainty_id),
    request.evidence.map((item) => item.evidence_id),
  ];
}

function validateRequestContent(request: DecisionRequestV1): void {
  validateText(request.decision_question, "DecisionRequestV1.decision_question", 16_384);
  for (const alternative of request.alternatives) {
    assertOpaqueId(alternative.alternative_id, "DecisionRequestV1.alternative_id");
    validateText(alternative.label, "DecisionRequestV1.alternative.label", 512, false);
    validateText(alternative.description, "DecisionRequestV1.alternative.description", 8_192);
  }
  const statementGroups = [
    request.hard_constraints.map((item) => [item.constraint_id, item.statement] as const),
    request.objectives.map((item) => [item.objective_id, item.statement] as const),
    request.preferences.map((item) => [item.preference_id, item.statement] as const),
    request.uncertainties.map((item) => [item.uncertainty_id, item.statement] as const),
    request.evidence.map((item) => [item.evidence_id, item.statement] as const),
  ];
  for (const group of statementGroups) {
    for (const [id, statement] of group) {
      assertOpaqueId(id, "DecisionRequestV1 item ID");
      validateText(statement, "DecisionRequestV1 item statement", 8_192);
    }
  }
  const allIds = requestIdGroups(request).flat();
  assertUnique(allIds, "DecisionRequestV1 IDs");
}

export function validateDecisionRequest(value: unknown): DecisionRequestV1 {
  const request = validateSkillSchema(DecisionRequestV1Schema, value, "DecisionRequestV1");
  validateRequestContent(request);
  return request;
}

export function canonicalizeDecisionRequest(input: {
  readonly goal: string;
  readonly constraints: unknown;
}): DecisionRequestV1 {
  validateText(input.goal, "DecisionRequestV1 goal", 16_384);
  const constraints = validateSkillSchema(
    DecisionRequestConstraintsV1Schema,
    input.constraints,
    "DecisionRequestV1 start constraints"
  );
  return validateDecisionRequest({
    schema_version: 1,
    decision_question: input.goal,
    alternatives: constraints.alternatives,
    hard_constraints: constraints.hard_constraints,
    objectives: constraints.objectives,
    preferences: constraints.preferences,
    uncertainties: constraints.uncertainties,
    evidence: constraints.evidence,
  });
}

export function decisionRequestConstraints(requestValue: unknown): DecisionRequestConstraintsV1 {
  const request = validateDecisionRequest(requestValue);
  return {
    schema_version: 1,
    alternatives: request.alternatives,
    hard_constraints: request.hard_constraints,
    objectives: request.objectives,
    preferences: request.preferences,
    uncertainties: request.uncertainties,
    evidence: request.evidence,
  };
}

export function decisionRequestSha256(value: unknown): string {
  return sha256(canonicalJson(validateDecisionRequest(value)));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson(sorted(left)) === canonicalJson(sorted(right));
}

function sanitizeIssues(issues: readonly string[]): readonly string[] {
  return [
    ...new Set(
      issues.map((issue) =>
        issue.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\0", " ").trim().slice(0, 512)
      )
    ),
  ].filter((issue) => issue.length > 0);
}

function collectValidationIssue(issues: string[], action: () => void): void {
  try {
    action();
  } catch (error) {
    if (error instanceof SkillSchemaValidationError) issues.push(...error.issues);
    else if (error instanceof Error) issues.push(error.message);
    else issues.push("validation failed");
  }
}

function validateCoreShape(value: unknown): DecisionCoreV2 {
  const core = validateSkillSchema(DecisionCoreV2Schema, value, "DecisionCoreV2");
  const issues: string[] = [];
  collectValidationIssue(issues, () =>
    validateText(core.applicability_reason, "DecisionCoreV2.applicability_reason", 8_192)
  );
  for (const entry of core.feasibility) {
    collectValidationIssue(issues, () =>
      assertOpaqueId(entry.alternative_id, "DecisionCoreV2 feasibility alternative_id")
    );
  }
  for (const alternativeId of core.recommendation.alternative_ids) {
    collectValidationIssue(issues, () =>
      assertOpaqueId(alternativeId, "DecisionCoreV2 recommendation alternative_id")
    );
  }
  for (const dimensionId of core.comparison_dimension_ids) {
    collectValidationIssue(issues, () =>
      assertOpaqueId(dimensionId, "DecisionCoreV2 comparison_dimension_id")
    );
  }
  for (const basisId of [
    ...core.basis_ids_used,
    ...core.sensitivity.flatMap((item) => item.basis_ids),
  ]) {
    if (!basisId.startsWith("art_")) {
      collectValidationIssue(issues, () => assertOpaqueId(basisId, "DecisionCoreV2 basis ID"));
    }
  }
  for (const sensitivity of core.sensitivity) {
    collectValidationIssue(issues, () =>
      validateText(
        sensitivity.resulting_decision_change,
        "DecisionCoreV2 resulting_decision_change",
        8_192
      )
    );
  }
  for (const question of core.blocking_questions ?? []) {
    collectValidationIssue(issues, () =>
      validateText(question, "DecisionCoreV2 blocking question", 4_096)
    );
  }
  const sanitized = sanitizeIssues(issues);
  if (sanitized.length > 0) {
    throw new SkillSchemaValidationError("DecisionCoreV2", sanitized);
  }
  return core;
}

function coreFromDraft(draft: DecisionDraftV2): DecisionCoreV2 {
  return {
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
  };
}

function validateDraftShape(value: unknown): DecisionDraftV2 {
  const draft = validateSkillSchema(DecisionDraftV2Schema, value, "DecisionDraftV2");
  const issues: string[] = [];
  collectValidationIssue(issues, () =>
    validateText(
      draft.rationale_report,
      "DecisionDraftV2.rationale_report",
      MAX_DECISION_RATIONALE_REPORT_BYTES
    )
  );
  collectValidationIssue(issues, () => validateCoreShape(coreFromDraft(draft)));
  const sanitized = sanitizeIssues(issues);
  if (sanitized.length > 0) {
    throw new SkillSchemaValidationError("DecisionDraftV2", sanitized);
  }
  return draft;
}

function unknownIds(values: readonly string[], allowed: ReadonlySet<string>): readonly string[] {
  return sorted([...new Set(values.filter((value) => !allowed.has(value)))]);
}

function issueWithIds(prefix: string, ids: readonly string[]): string {
  const suffix = ids.length === 0 ? "" : `; unknown: ${ids.join(", ")}`;
  return `${prefix}${suffix}`.slice(0, 512);
}

function decisionSemanticIssues(
  draft: DecisionDraftV2,
  request: DecisionRequestV1,
  exactInputArtifactIds: readonly string[],
  requestArtifactId?: string
): readonly string[] {
  const issues: string[] = [];
  const admittedArtifactIds = [...exactInputArtifactIds];
  if (requestArtifactId !== undefined && exactInputArtifactIds.includes(requestArtifactId)) {
    issues.push("decision-request transport IDs cannot be admitted as semantic basis inputs");
  }
  const malformedArtifacts = admittedArtifactIds.filter(
    (artifactId) => !/^art_[a-f0-9]{64}$/u.test(artifactId)
  );
  if (malformedArtifacts.length > 0) {
    issues.push("admitted basis artifact IDs must use the art_<sha256> namespace");
  }
  if (new Set(admittedArtifactIds).size !== admittedArtifactIds.length) {
    issues.push("admitted basis artifact IDs must be unique");
  }

  const alternativeIds = request.alternatives.map((item) => item.alternative_id);
  const alternativeNamespace = new Set(alternativeIds);
  const feasibleIds = draft.feasibility
    .filter((entry) => entry.status === "feasible")
    .map((entry) => entry.alternative_id);
  const dimensionNamespace = new Set([
    ...request.hard_constraints.map((item) => item.constraint_id),
    ...request.objectives.map((item) => item.objective_id),
    ...request.preferences.map((item) => item.preference_id),
  ]);
  const basisNamespace = new Set([
    ...dimensionNamespace,
    ...request.uncertainties.map((item) => item.uncertainty_id),
    ...request.evidence.map((item) => item.evidence_id),
    ...admittedArtifactIds,
  ]);
  const questions = draft.blocking_questions ?? [];
  const selectedOrRanked = draft.outcome === "selected" || draft.outcome === "ranked";

  if (draft.outcome !== "not_applicable" && alternativeIds.length < 2) {
    issues.push("applicable DecisionDraftV2 outcomes require at least two supplied alternatives");
  }
  if (draft.outcome === "not_applicable") {
    if (
      draft.feasibility.length !== 0 ||
      draft.recommendation.kind !== "none" ||
      draft.recommendation.alternative_ids.length !== 0 ||
      draft.comparison_dimension_ids.length !== 0 ||
      draft.has_blocking_unresolved ||
      questions.length !== 0
    ) {
      issues.push(
        "not_applicable DecisionDraftV2 must have empty feasibility, recommendation IDs, dimensions, blockers, and blocking questions with recommendation kind none"
      );
    }
  } else if (
    !sameSet(
      draft.feasibility.map((entry) => entry.alternative_id),
      alternativeIds
    )
  ) {
    issues.push("applicable DecisionDraftV2 feasibility must cover every alternative exactly once");
  }

  const unknownFeasibility = unknownIds(
    draft.feasibility.map((entry) => entry.alternative_id),
    alternativeNamespace
  );
  if (unknownFeasibility.length > 0) {
    issues.push(
      issueWithIds(
        "feasibility[].alternative_id may use only supplied alternatives[].alternative_id",
        unknownFeasibility
      )
    );
  }
  const unknownRecommendations = unknownIds(
    draft.recommendation.alternative_ids,
    alternativeNamespace
  );
  if (unknownRecommendations.length > 0) {
    issues.push(
      issueWithIds(
        "recommendation.alternative_ids may use only supplied alternatives[].alternative_id",
        unknownRecommendations
      )
    );
  }

  if (draft.outcome === "selected") {
    if (
      draft.recommendation.kind !== "selection" ||
      draft.recommendation.alternative_ids.length !== 1 ||
      !feasibleIds.includes(draft.recommendation.alternative_ids[0] ?? "")
    ) {
      issues.push("selected DecisionDraftV2 must recommend exactly one feasible alternative");
    }
  } else if (draft.outcome === "ranked") {
    if (
      draft.recommendation.kind !== "ranking" ||
      feasibleIds.length === 0 ||
      !sameSet(draft.recommendation.alternative_ids, feasibleIds)
    ) {
      issues.push("ranked DecisionDraftV2 must order the complete feasible set");
    }
  } else if (
    draft.recommendation.kind !== "none" ||
    draft.recommendation.alternative_ids.length !== 0
  ) {
    issues.push(
      "non-selection DecisionDraftV2 outcomes require recommendation kind none and no IDs"
    );
  }

  if (
    draft.outcome === "no_feasible_option" &&
    (draft.feasibility.length === 0 ||
      draft.feasibility.some((entry) => entry.status !== "infeasible"))
  ) {
    issues.push("no_feasible_option DecisionDraftV2 requires every alternative infeasible");
  }
  if (draft.outcome === "unresolved") {
    if (!draft.has_blocking_unresolved) {
      issues.push("unresolved DecisionDraftV2 requires has_blocking_unresolved true");
    }
    if (questions.length === 0) {
      issues.push("unresolved DecisionDraftV2 requires nonempty blocking_questions");
    }
  }
  if (
    ["selected", "ranked", "no_feasible_option"].includes(draft.outcome) &&
    draft.has_blocking_unresolved
  ) {
    issues.push("dispositive DecisionDraftV2 outcomes cannot hide a blocking unresolved issue");
  }
  if (
    ["selected", "ranked", "no_feasible_option"].includes(draft.outcome) &&
    questions.length > 0
  ) {
    issues.push("dispositive DecisionDraftV2 outcomes cannot carry blocking_questions");
  }
  if (selectedOrRanked && feasibleIds.length > 1 && draft.comparison_dimension_ids.length === 0) {
    issues.push(
      "selected and ranked DecisionDraftV2 outcomes with multiple feasible alternatives require comparison dimensions"
    );
  }
  if (selectedOrRanked && draft.sensitivity.length === 0) {
    issues.push("selected and ranked DecisionDraftV2 outcomes require sensitivity");
  }

  const unknownDimensions = unknownIds(draft.comparison_dimension_ids, dimensionNamespace);
  if (unknownDimensions.length > 0) {
    issues.push(
      issueWithIds(
        "comparison_dimension_ids may use only supplied constraint_id, objective_id, or preference_id values",
        unknownDimensions
      )
    );
  }
  const unknownUsedBasis = unknownIds(draft.basis_ids_used, basisNamespace);
  if (unknownUsedBasis.length > 0) {
    issues.push(
      issueWithIds(
        "basis_ids_used may use only supplied criterion, uncertainty, evidence, or exact input artifact IDs",
        unknownUsedBasis
      )
    );
  }
  const unknownSensitivityBasis = unknownIds(
    draft.sensitivity.flatMap((item) => item.basis_ids),
    basisNamespace
  );
  if (unknownSensitivityBasis.length > 0) {
    issues.push(
      issueWithIds(
        "sensitivity[].basis_ids may use only supplied criterion, uncertainty, evidence, or exact input artifact IDs",
        unknownSensitivityBasis
      )
    );
  }
  return sanitizeIssues(issues);
}

export function validateDecisionDraft(
  value: unknown,
  input: {
    readonly request: unknown;
    readonly exactInputArtifactIds: readonly string[];
    readonly requestArtifactId?: string;
  }
): DecisionDraftV2 {
  const request = validateDecisionRequest(input.request);
  let draft: DecisionDraftV2;
  try {
    draft = validateDraftShape(value);
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? sanitizeIssues(error.issues)
        : sanitizeIssues([
            error instanceof Error ? error.message : "closed schema validation failed",
          ]);
    throw new DecisionDraftValidationError("SCHEMA_INVALID", issues);
  }
  const issues = decisionSemanticIssues(
    draft,
    request,
    input.exactInputArtifactIds,
    input.requestArtifactId
  );
  if (issues.length > 0) throw new DecisionDraftValidationError("SEMANTIC_INVALID", issues);
  return draft;
}

const DECISION_CORE_PREFIX = "DECISION_CORE:";
const DECISION_SUMMARY_PREFIX = "SUMMARY:";

function decisionDraftFailure(
  failureClass: DecisionDraftFailureClassV2,
  issue: string | readonly string[]
): DecisionDraftValidationError {
  return new DecisionDraftValidationError(
    failureClass,
    sanitizeIssues(typeof issue === "string" ? [issue] : issue)
  );
}

function stripOneOptionalTrailingLf(value: string): string | undefined {
  const stripped = value.endsWith("\n") ? value.slice(0, -1) : value;
  return stripped.endsWith("\n") || stripped.endsWith("\r") ? undefined : stripped;
}

function markerLineIndexes(lines: readonly string[], prefix: string): readonly number[] {
  return lines.flatMap((line, index) => (line.startsWith(prefix) ? [index] : []));
}

function markerLookingLineIndexes(lines: readonly string[], prefix: string): readonly number[] {
  return lines.flatMap((line, index) => {
    const markerIndex = line.indexOf(prefix);
    if (markerIndex < 0) return [];
    const prefixText = line.slice(0, markerIndex);
    return prefixText.length === 0 || /^[\s`~>*+-]+$/u.test(prefixText) ? [index] : [];
  });
}

function hasWhitespaceOnlyLine(lines: readonly string[]): boolean {
  return lines.some((line) => line.length > 0 && line.trim().length === 0);
}

type MarkdownFenceCharacter = "`" | "~";

interface MarkdownFenceState {
  readonly character: MarkdownFenceCharacter;
  readonly openingLength: number;
}

function openingMarkdownFence(line: string): MarkdownFenceState | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  const run = match?.[1];
  if (run === undefined) return undefined;
  const character = run[0];
  if (character !== "`" && character !== "~") return undefined;
  if (character === "`" && (match?.[2] ?? "").includes("`")) return undefined;
  return { character, openingLength: run.length };
}

function closesMarkdownFence(line: string, state: MarkdownFenceState): boolean {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})( *)$/u);
  const run = match?.[1];
  return run !== undefined && run[0] === state.character && run.length >= state.openingLength;
}

function endsInsideMarkdownFence(lines: readonly string[]): boolean {
  let state: MarkdownFenceState | undefined;
  for (const line of lines) {
    if (state === undefined) {
      state = openingMarkdownFence(line);
    } else if (closesMarkdownFence(line, state)) {
      state = undefined;
    }
  }
  return state !== undefined;
}

function rationaleBeforeMarker(lines: readonly string[], markerIndex: number): string {
  let rationaleEnd = markerIndex;
  while (rationaleEnd > 0 && lines[rationaleEnd - 1] === "") rationaleEnd -= 1;
  return lines.slice(0, rationaleEnd).join("\n");
}

function parseExactDecisionSummary(value: string): DecisionRoutingSummaryV2 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  try {
    const summary = validateSkillSchema(
      DecisionRoutingSummaryV2Schema,
      parsed,
      "DecisionDraftV2 routing summary"
    );
    return `{"confidence":"${summary.confidence}","complete":true}` === value ? summary : undefined;
  } catch {
    return undefined;
  }
}

export function parsePersistedDecisionRoutingSummary(
  value: string
): DecisionRoutingSummaryV2 | undefined {
  const withoutTrailingLf = stripOneOptionalTrailingLf(value);
  if (
    withoutTrailingLf === undefined ||
    withoutTrailingLf.includes("\r") ||
    withoutTrailingLf.includes("\u0000") ||
    withoutTrailingLf.includes("\ufeff")
  ) {
    return undefined;
  }
  const lines = withoutTrailingLf.split("\n");
  const summaryIndexes = markerLineIndexes(lines, DECISION_SUMMARY_PREFIX);
  const summaryLookingIndexes = markerLookingLineIndexes(lines, DECISION_SUMMARY_PREFIX);
  const summaryIndex = summaryIndexes[0];
  if (
    summaryIndexes.length !== 1 ||
    summaryLookingIndexes.length !== 1 ||
    summaryIndex === undefined ||
    summaryIndex <= 0 ||
    summaryIndex !== lines.length - 1 ||
    hasWhitespaceOnlyLine(lines) ||
    endsInsideMarkdownFence(lines.slice(0, summaryIndex))
  ) {
    return undefined;
  }
  return parseExactDecisionSummary(
    (lines[summaryIndex] ?? "").slice(DECISION_SUMMARY_PREFIX.length)
  );
}

export type DecisionCoreAdapterV2 = (value: unknown) => unknown;

export function parsePersistedDecisionDraft(
  bytes: Uint8Array,
  input: {
    readonly request: unknown;
    readonly exactInputArtifactIds: readonly string[];
    readonly requestArtifactId?: string;
  },
  coreAdapter: DecisionCoreAdapterV2 = validateCoreShape
): {
  readonly draft: DecisionDraftV2;
  readonly summary: DecisionRoutingSummaryV2;
} {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PERSISTED_DECISION_DRAFT_BYTES) {
    throw decisionDraftFailure(
      "FRAMING_INVALID",
      `DecisionDraftV2 output must be 1..${MAX_PERSISTED_DECISION_DRAFT_BYTES} bytes`
    );
  }
  const bodyBytes = Buffer.from(bytes);
  const framingIssues: string[] = [];
  if (bodyBytes[0] === 0xef && bodyBytes[1] === 0xbb && bodyBytes[2] === 0xbf) {
    framingIssues.push("DecisionDraftV2 output forbids BOM");
  }
  if (bodyBytes.includes(0)) framingIssues.push("DecisionDraftV2 output forbids NUL");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bodyBytes);
  } catch {
    throw decisionDraftFailure("FRAMING_INVALID", "DecisionDraftV2 output is not strict UTF-8");
  }
  if (text.includes("\ufeff")) framingIssues.push("DecisionDraftV2 output forbids BOM");
  if (text.includes("\r")) framingIssues.push("DecisionDraftV2 output forbids CR");
  const withoutTrailingLf = stripOneOptionalTrailingLf(text);
  if (withoutTrailingLf === undefined) {
    framingIssues.push("DecisionDraftV2 output permits at most one trailing LF");
  }
  const framed = withoutTrailingLf ?? text;
  const lines = framed.split("\n");
  if (hasWhitespaceOnlyLine(lines)) {
    framingIssues.push("DecisionDraftV2 output forbids whitespace-only lines");
  }
  const summaryIndexes = markerLineIndexes(lines, DECISION_SUMMARY_PREFIX);
  const coreIndexes = markerLineIndexes(lines, DECISION_CORE_PREFIX);
  const summaryLookingIndexes = markerLookingLineIndexes(lines, DECISION_SUMMARY_PREFIX);
  const coreLookingIndexes = markerLookingLineIndexes(lines, DECISION_CORE_PREFIX);
  if (summaryIndexes.length !== 1 || summaryLookingIndexes.length !== 1) {
    framingIssues.push(
      "DecisionDraftV2 output requires exactly one literal final SUMMARY line and forbids marker-looking duplicates"
    );
  }
  if (coreIndexes.length !== 1 || coreLookingIndexes.length !== 1) {
    framingIssues.push(
      "DecisionDraftV2 output requires exactly one literal DECISION_CORE footer and forbids marker-looking duplicates"
    );
  }
  const summaryIndex = summaryIndexes[0] ?? -1;
  const coreIndex = coreIndexes[0] ?? -1;
  let summary: DecisionRoutingSummaryV2 | undefined;
  if (summaryIndex >= 0) {
    const summaryLine = lines[summaryIndex] ?? "";
    summary = parseExactDecisionSummary(summaryLine.slice(DECISION_SUMMARY_PREFIX.length));
    if (summary === undefined || summaryIndex !== lines.length - 1 || summaryLine.includes("`")) {
      framingIssues.push(
        "DecisionDraftV2 output must end with the exact unwrapped compact closed SUMMARY"
      );
    }
  }
  if (coreIndex <= 0 || summaryIndex <= coreIndex) {
    framingIssues.push("DecisionDraftV2 requires prose, DECISION_CORE, then SUMMARY in that order");
  }
  if (coreIndex > 0 && endsInsideMarkdownFence(lines.slice(0, coreIndex))) {
    framingIssues.push(
      "DecisionDraftV2 rationale fences must be closed before DECISION_CORE and SUMMARY"
    );
  }
  if (
    coreIndex >= 0 &&
    summaryIndex > coreIndex &&
    lines.slice(coreIndex + 1, summaryIndex).some((line) => line !== "")
  ) {
    framingIssues.push(
      "DecisionDraftV2 permits only truly empty separator lines between DECISION_CORE and SUMMARY"
    );
  }
  const rationaleReport = coreIndex > 0 ? rationaleBeforeMarker(lines, coreIndex) : "";
  if (
    rationaleReport.trim().length === 0 ||
    rationaleReport.trim() !== rationaleReport ||
    Buffer.byteLength(rationaleReport, "utf8") > MAX_DECISION_RATIONALE_REPORT_BYTES
  ) {
    framingIssues.push(
      `DecisionDraftV2 rationale report must be exact bounded nonempty prose of at most ${MAX_DECISION_RATIONALE_REPORT_BYTES} bytes`
    );
  }
  const coreLine = coreIndex >= 0 ? (lines[coreIndex] ?? "") : "";
  const coreText = coreLine.slice(DECISION_CORE_PREFIX.length);
  if (
    coreText.length === 0 ||
    coreText.trim() !== coreText ||
    coreLine.includes("`") ||
    /~{3,} *$/u.test(coreLine)
  ) {
    framingIssues.push("DECISION_CORE must be one unwrapped nonempty single-line JSON footer");
  }
  if (framingIssues.length > 0 || summary === undefined) {
    throw decisionDraftFailure("FRAMING_INVALID", framingIssues);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(coreText);
  } catch {
    throw decisionDraftFailure("JSON_INVALID", "DecisionDraftV2 DECISION_CORE footer is not JSON");
  }
  let draft: DecisionDraftV2;
  try {
    const adaptedCore = coreAdapter(parsed);
    if (adaptedCore === null || typeof adaptedCore !== "object" || Array.isArray(adaptedCore)) {
      throw new Error("DecisionDraftV2 core adapter must return one closed object");
    }
    draft = validateDraftShape({ rationale_report: rationaleReport, ...adaptedCore });
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? error.issues
        : [
            error instanceof Error
              ? error.message
              : "DecisionDraftV2 closed schema validation failed",
          ];
    throw decisionDraftFailure("SCHEMA_INVALID", issues);
  }
  const semanticIssues = [
    ...decisionSemanticIssues(
      draft,
      validateDecisionRequest(input.request),
      input.exactInputArtifactIds,
      input.requestArtifactId
    ),
    ...(draft.confidence === summary.confidence
      ? []
      : ["DecisionDraftV2 confidence must equal routing SUMMARY confidence"]),
  ];
  if (semanticIssues.length > 0) {
    throw decisionDraftFailure("SEMANTIC_INVALID", semanticIssues);
  }
  return { draft, summary };
}

export function projectDecisionCore(value: unknown): DecisionCoreV2 {
  return coreFromDraft(projectDecisionDraft(value));
}

export function projectDecisionDraft(value: unknown): DecisionDraftV2 {
  return projectDecisionDraftUnchecked(validateDecision(value));
}

export function validateDecision(value: unknown): DecisionV2 {
  const decision = validateSkillSchema(DecisionV2Schema, value, "DecisionV2");
  const request = validateDecisionRequest(decision.request);
  const expectedRequestSha256 = decisionRequestSha256(request);
  if (decision.request_sha256 !== expectedRequestSha256) {
    throw new Error("DecisionV2 request digest drifted from its canonical embedded request");
  }
  const lineagePreimage: DecisionSourceLineagePreimageV2 = {
    request_artifact_id: decision.source_lineage.request_artifact_id,
    draft_artifact_id: decision.source_lineage.draft_artifact_id,
    draft_sha256: decision.source_lineage.draft_sha256,
    input_artifact_ids: decision.source_lineage.input_artifact_ids,
  };
  if (decision.source_lineage.lineage_sha256 !== decisionSourceLineageSha256(lineagePreimage)) {
    throw new Error("DecisionV2 source lineage digest drifted");
  }
  assertUnique(
    [
      lineagePreimage.request_artifact_id,
      lineagePreimage.draft_artifact_id,
      ...lineagePreimage.input_artifact_ids,
    ],
    "DecisionV2 source lineage artifact IDs"
  );
  if (
    canonicalJson(lineagePreimage.input_artifact_ids) !==
    canonicalJson(sorted(lineagePreimage.input_artifact_ids))
  ) {
    throw new Error("DecisionV2 source lineage input artifact IDs are not canonical");
  }
  const draft = validateDecisionDraft(projectDecisionDraftUnchecked(decision), {
    request,
    exactInputArtifactIds: lineagePreimage.input_artifact_ids,
  });
  if (decision.source_lineage.draft_sha256 !== sha256(canonicalJson(draft))) {
    throw new Error("DecisionV2 source draft lineage drifted from its canonical draft projection");
  }
  return decision;
}

function projectDecisionDraftUnchecked(decision: DecisionV2): DecisionDraftV2 {
  return {
    rationale_report: decision.rationale_report,
    schema_version: decision.schema_version,
    outcome: decision.outcome,
    applicability_reason: decision.applicability_reason,
    feasibility: decision.feasibility,
    recommendation: decision.recommendation,
    comparison_dimension_ids: decision.comparison_dimension_ids,
    basis_ids_used: decision.basis_ids_used,
    sensitivity: decision.sensitivity,
    has_blocking_unresolved: decision.has_blocking_unresolved,
    ...(decision.blocking_questions === undefined
      ? {}
      : { blocking_questions: decision.blocking_questions }),
    confidence: decision.confidence,
  };
}

export function sealDecisionDraft(input: {
  readonly request: unknown;
  readonly draft: unknown;
  readonly requestSha256: string;
  readonly sourceRequestArtifactId: string;
  readonly sourceDraftArtifactId: string;
  readonly exactInputArtifactIds: readonly string[];
}): DecisionV2 {
  const request = validateDecisionRequest(input.request);
  const expectedRequestSha256 = decisionRequestSha256(request);
  if (input.requestSha256 !== expectedRequestSha256) {
    throw new Error("DecisionV2 request binding is stale");
  }
  for (const [label, artifactId] of [
    ["request", input.sourceRequestArtifactId],
    ["draft", input.sourceDraftArtifactId],
  ] as const) {
    if (!/^art_[a-f0-9]{64}$/u.test(artifactId)) {
      throw new Error(`DecisionV2 source ${label} artifact ID is malformed`);
    }
  }
  const inputArtifactIds = sorted(input.exactInputArtifactIds);
  const draft = validateDecisionDraft(input.draft, {
    request,
    exactInputArtifactIds: inputArtifactIds,
  });
  const sourceLineage: DecisionSourceLineagePreimageV2 = {
    request_artifact_id: input.sourceRequestArtifactId,
    draft_artifact_id: input.sourceDraftArtifactId,
    draft_sha256: sha256(canonicalJson(draft)),
    input_artifact_ids: inputArtifactIds,
  };
  return validateDecision({
    ...draft,
    request,
    request_sha256: expectedRequestSha256,
    source_lineage: {
      ...sourceLineage,
      lineage_sha256: decisionSourceLineageSha256(sourceLineage),
    },
    execution_started: false,
  });
}

export function assertDecisionLineage(input: {
  readonly decision: unknown;
  readonly request: unknown;
  readonly requestArtifactId: string;
  readonly draftArtifactId: string;
  readonly draft: unknown;
  readonly exactInputArtifactIds: readonly string[];
}): DecisionV2 {
  const request = validateDecisionRequest(input.request);
  const expected = sealDecisionDraft({
    request,
    draft: input.draft,
    requestSha256: decisionRequestSha256(request),
    sourceRequestArtifactId: input.requestArtifactId,
    sourceDraftArtifactId: input.draftArtifactId,
    exactInputArtifactIds: input.exactInputArtifactIds,
  });
  const decision = validateDecision(input.decision);
  if (canonicalJson(decision) !== canonicalJson(expected)) {
    throw new Error("DecisionV2 request, draft, or host-sealed lineage diverged");
  }
  return decision;
}

export function validateCanonicalDecisionBytes(bytes: Uint8Array, ref: ArtifactRef): DecisionV2 {
  const body = Buffer.from(bytes);
  if (
    ref.kind !== "semantic-core" ||
    ref.content_schema?.schema_id !== "penny.decision.v2" ||
    ref.content_schema.schema_version !== 2 ||
    ref.byte_length !== body.length ||
    ref.content_digest !== sha256(body) ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  ) {
    throw new Error("DecisionV2 artifact ref is stale or has the wrong semantic identity");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("DecisionV2 artifact is not JSON");
  }
  const decision = validateDecision(parsed);
  if (canonicalJson(decision) !== body.toString("utf8")) {
    throw new Error("DecisionV2 artifact bytes are not canonical JSON");
  }
  return decision;
}

export const DecisionProductIntegrityV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.decision-product-integrity.v1"),
    schema_version: Type.Literal(1),
    integrity_id: Type.String({ pattern: "^dpir_[a-f0-9]{64}$" }),
    status: Type.Literal("PASS"),
    request_ref: ArtifactRefSchema,
    analysis_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
    imported_input_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
    draft_ref: ArtifactRefSchema,
    decision_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    quality_receipt_ref: ArtifactRefSchema,
    execution_receipt_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      minItems: 4,
      maxItems: 64,
      uniqueItems: true,
    }),
    checks: Type.Array(
      Type.Union([
        Type.Literal("canonical_decision"),
        Type.Literal("exact_lineage"),
        Type.Literal("signed_worker_evidence"),
        Type.Literal("latest_validity_receipt"),
        Type.Literal("latest_quality_receipt"),
        Type.Literal("no_execution"),
      ]),
      { minItems: 6, maxItems: 6, uniqueItems: true }
    ),
    execution_started: Type.Literal(false),
    execution_authorized: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type DecisionProductIntegrityV1 = Readonly<Static<typeof DecisionProductIntegrityV1Schema>>;

export function decisionProductIntegrityId(
  body: Omit<DecisionProductIntegrityV1, "integrity_id">
): `dpir_${string}` {
  return `dpir_${sha256(canonicalJson(body))}`;
}

export function validateDecisionProductIntegrity(value: unknown): DecisionProductIntegrityV1 {
  const integrity = validateSkillSchema(
    DecisionProductIntegrityV1Schema,
    value,
    "DecisionProductIntegrityV1"
  );
  const expectedChecks = [
    "canonical_decision",
    "exact_lineage",
    "signed_worker_evidence",
    "latest_validity_receipt",
    "latest_quality_receipt",
    "no_execution",
  ];
  if (canonicalJson(integrity.checks) !== canonicalJson(expectedChecks)) {
    throw new Error("DecisionProductIntegrityV1 checks are incomplete or reordered");
  }
  const refs = [
    integrity.request_ref,
    integrity.analysis_ref,
    integrity.admission_ref,
    ...integrity.evidence_refs,
    ...integrity.imported_input_refs,
    integrity.draft_ref,
    integrity.decision_ref,
    integrity.vera_report_ref,
    integrity.carren_report_ref,
    integrity.validity_receipt_ref,
    integrity.quality_receipt_ref,
  ];
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "DecisionProductIntegrityV1 artifact refs"
  );
  if (
    integrity.request_ref.kind !== "decision-request" ||
    integrity.analysis_ref.phase !== "analyzing_decision" ||
    integrity.admission_ref.kind !== "evidence-admission" ||
    integrity.admission_ref.phase !== "decision_evidence_gate" ||
    integrity.draft_ref.kind !== "decision-draft" ||
    integrity.decision_ref.kind !== "semantic-core" ||
    integrity.vera_report_ref.phase !== "verifying_decision" ||
    integrity.carren_report_ref.phase !== "critiquing_decision" ||
    integrity.validity_receipt_ref.kind !== "review-receipt" ||
    integrity.quality_receipt_ref.kind !== "review-receipt"
  ) {
    throw new Error("DecisionProductIntegrityV1 artifact roles disagree");
  }
  const { integrity_id: integrityId, ...body } = integrity;
  assertDerivedId(integrityId, "dpir_", sha256(canonicalJson(body)), "DecisionProductIntegrityV1");
  return integrity;
}

export const DecisionProductEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.decision-product-envelope.v1"),
    schema_version: Type.Literal(1),
    envelope_id: Type.String({ pattern: "^dpenv_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    status: Type.Literal("complete"),
    decision_ref: ArtifactRefSchema,
    request_ref: ArtifactRefSchema,
    analysis_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
    imported_input_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
    draft_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    quality_receipt_ref: ArtifactRefSchema,
    integrity_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type DecisionProductEnvelopeV1 = Readonly<Static<typeof DecisionProductEnvelopeV1Schema>>;

export function decisionProductEnvelopeId(
  body: Omit<DecisionProductEnvelopeV1, "envelope_id">
): `dpenv_${string}` {
  return `dpenv_${sha256(canonicalJson(body))}`;
}

export function validateDecisionProductEnvelope(value: unknown): DecisionProductEnvelopeV1 {
  const envelope = validateSkillSchema(
    DecisionProductEnvelopeV1Schema,
    value,
    "DecisionProductEnvelopeV1"
  );
  assertOpaqueId(envelope.run_id, "DecisionProductEnvelopeV1.run_id");
  const refs = [
    envelope.request_ref,
    envelope.analysis_ref,
    envelope.admission_ref,
    ...envelope.evidence_refs,
    ...envelope.imported_input_refs,
    envelope.draft_ref,
    envelope.decision_ref,
    envelope.vera_report_ref,
    envelope.carren_report_ref,
    envelope.validity_receipt_ref,
    envelope.quality_receipt_ref,
    envelope.integrity_ref,
  ];
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "DecisionProductEnvelopeV1 artifact refs"
  );
  const { envelope_id: envelopeId, ...body } = envelope;
  assertDerivedId(envelopeId, "dpenv_", sha256(canonicalJson(body)), "DecisionProductEnvelopeV1");
  return envelope;
}
