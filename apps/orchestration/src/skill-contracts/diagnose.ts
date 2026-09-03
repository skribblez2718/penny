import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { ArtifactRefSchema, ConfidenceSchema, type ArtifactRef } from "../contracts.js";
import {
  ArtifactIdSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  TextSchema,
  SkillSchemaValidationError,
  assertDerivedId,
  assertOpaqueId,
  assertRfc3339Utc,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "./common.js";

const MAX_REQUEST_ITEMS = 64;
const MAX_HYPOTHESES = 32;
const MAX_CHECKS = 16;
export const MAX_PERSISTED_DIAGNOSIS_DRAFT_BYTES = 131_072;

const StatementV1Schema = Type.Object(
  { statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }) },
  { additionalProperties: false }
);
const ObservationV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    source_label: Type.Optional(TextSchema({ minBytes: 1, maxBytes: 512 })),
  },
  { additionalProperties: false }
);
const PermittedTestBoundaryV1Schema = Type.Object(
  { mode: Type.Union([Type.Literal("proposal_only"), Type.Literal("none")]) },
  { additionalProperties: false }
);

const DiagnosisRequestProperties = {
  schema_version: Type.Literal(1),
  problem_statement: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
  symptoms: Type.Array(StatementV1Schema, { minItems: 1, maxItems: MAX_REQUEST_ITEMS }),
  supplied_observations: Type.Array(ObservationV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  environment_facts: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  hard_constraints: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  non_goals: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  known_uncertainties: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  permitted_test_boundary: PermittedTestBoundaryV1Schema,
};

export const DiagnosisRequestV1Schema = Type.Object(DiagnosisRequestProperties, {
  additionalProperties: false,
});
export type DiagnosisRequestV1 = Readonly<Static<typeof DiagnosisRequestV1Schema>>;

export const DiagnosisRequestConstraintsV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    symptoms: DiagnosisRequestV1Schema.properties.symptoms,
    supplied_observations: DiagnosisRequestV1Schema.properties.supplied_observations,
    environment_facts: DiagnosisRequestV1Schema.properties.environment_facts,
    hard_constraints: DiagnosisRequestV1Schema.properties.hard_constraints,
    non_goals: DiagnosisRequestV1Schema.properties.non_goals,
    known_uncertainties: DiagnosisRequestV1Schema.properties.known_uncertainties,
    permitted_test_boundary: DiagnosisRequestV1Schema.properties.permitted_test_boundary,
  },
  { additionalProperties: false }
);
export type DiagnosisRequestConstraintsV1 = Readonly<
  Static<typeof DiagnosisRequestConstraintsV1Schema>
>;

const RequestIndexSchema = Type.Integer({ minimum: 0, maximum: MAX_REQUEST_ITEMS - 1 });
const RequestIndexesSchema = Type.Array(RequestIndexSchema, {
  maxItems: MAX_REQUEST_ITEMS,
  uniqueItems: true,
});
const RequiredRequestIndexesSchema = Type.Array(RequestIndexSchema, {
  minItems: 1,
  maxItems: MAX_REQUEST_ITEMS,
  uniqueItems: true,
});

const HypothesisStatusV1Schema = Type.Union([
  Type.Literal("supported"),
  Type.Literal("plausible"),
  Type.Literal("ruled_out"),
]);

const DiagnosisHypothesisV1Schema = Type.Object(
  {
    hypothesis_id: OpaqueIdSchema,
    rank: Type.Integer({ minimum: 1, maximum: MAX_HYPOTHESES }),
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    status: HypothesisStatusV1Schema,
    symptom_indexes: RequiredRequestIndexesSchema,
    supporting_observation_indexes: RequestIndexesSchema,
    contradicting_observation_indexes: RequestIndexesSchema,
    supporting_environment_fact_indexes: RequestIndexesSchema,
    contradicting_environment_fact_indexes: RequestIndexesSchema,
    hard_constraint_indexes: RequestIndexesSchema,
    reasoning: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
  },
  { additionalProperties: false }
);

const DiscriminatingCheckV1Schema = Type.Object(
  {
    check_id: OpaqueIdSchema,
    proposal: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    discriminates_hypothesis_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: MAX_HYPOTHESES,
      uniqueItems: true,
    }),
    expected_observation: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    boundary_note: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    executed: Type.Literal(false),
  },
  { additionalProperties: false }
);

const RequestCoverageV1Schema = Type.Object(
  {
    problem_statement_covered: Type.Literal(true),
    symptom_indexes: RequiredRequestIndexesSchema,
    observation_indexes: RequestIndexesSchema,
    environment_fact_indexes: RequestIndexesSchema,
    hard_constraint_indexes: RequestIndexesSchema,
    non_goal_indexes: RequestIndexesSchema,
    known_uncertainty_indexes: RequestIndexesSchema,
    permitted_test_boundary_covered: Type.Literal(true),
  },
  { additionalProperties: false }
);

const DiagnosisCoreProperties = {
  schema_version: Type.Literal(1),
  disposition: Type.Union([
    Type.Literal("supported"),
    Type.Literal("inconclusive"),
    Type.Literal("not_applicable"),
  ]),
  applicability_reason: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
  hypothesis_set_complete: Type.Literal(true),
  hypotheses: Type.Array(DiagnosisHypothesisV1Schema, { maxItems: MAX_HYPOTHESES }),
  primary_supported_hypothesis_id: Type.Union([OpaqueIdSchema, Type.Null()]),
  reasoning: TextSchema({ minBytes: 1, maxBytes: 32_768, multiline: true }),
  uncertainty: Type.Array(TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }), {
    maxItems: 32,
    uniqueItems: true,
  }),
  proposed_discriminating_checks: Type.Array(DiscriminatingCheckV1Schema, {
    maxItems: MAX_CHECKS,
  }),
  request_coverage: RequestCoverageV1Schema,
  confidence: ConfidenceSchema,
  remediation_started: Type.Literal(false),
  tests_executed: Type.Literal(false),
};

export const DiagnosisCoreV1Schema = Type.Object(DiagnosisCoreProperties, {
  additionalProperties: false,
});
export type DiagnosisCoreV1 = Readonly<Static<typeof DiagnosisCoreV1Schema>>;

export const DiagnosisDraftV1Schema = Type.Object(DiagnosisCoreProperties, {
  additionalProperties: false,
});
export type DiagnosisDraftV1 = Readonly<Static<typeof DiagnosisDraftV1Schema>>;

export type DiagnosisDraftFailureClassV1 =
  | "FRAMING_INVALID"
  | "JSON_INVALID"
  | "SCHEMA_INVALID"
  | "SEMANTIC_INVALID"
  | "LINEAGE_INVALID";

export class DiagnosisDraftValidationError extends Error {
  constructor(
    readonly failureClass: DiagnosisDraftFailureClassV1,
    readonly issues: readonly string[]
  ) {
    super(`${failureClass}: ${issues.join("; ")}`);
    this.name = "DiagnosisDraftValidationError";
  }
}

export const DiagnosisSealFeedbackV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.diagnosis-seal-feedback.v1"),
    schema_version: Type.Literal(1),
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
export type DiagnosisSealFeedbackV1 = Readonly<Static<typeof DiagnosisSealFeedbackV1Schema>>;

const DiagnosisRoutingSummaryV1Schema = Type.Object(
  { confidence: ConfidenceSchema, complete: Type.Literal(true) },
  { additionalProperties: false }
);
export type DiagnosisRoutingSummaryV1 = Readonly<Static<typeof DiagnosisRoutingSummaryV1Schema>>;

const DiagnosisSourceLineagePreimageV1Schema = Type.Object(
  {
    request_artifact_id: ArtifactIdSchema,
    request_artifact_sha256: Sha256Schema,
    causal_decomposition_artifact_id: ArtifactIdSchema,
    causal_decomposition_sha256: Sha256Schema,
    competing_hypotheses_artifact_id: ArtifactIdSchema,
    competing_hypotheses_sha256: Sha256Schema,
    draft_artifact_id: ArtifactIdSchema,
    draft_artifact_sha256: Sha256Schema,
    draft_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type DiagnosisSourceLineagePreimageV1 = Readonly<
  Static<typeof DiagnosisSourceLineagePreimageV1Schema>
>;

export const DiagnosisSourceLineageV1Schema = Type.Object(
  {
    ...DiagnosisSourceLineagePreimageV1Schema.properties,
    lineage_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type DiagnosisSourceLineageV1 = Readonly<Static<typeof DiagnosisSourceLineageV1Schema>>;

export const DiagnosisV1Schema = Type.Object(
  {
    ...DiagnosisCoreProperties,
    request: DiagnosisRequestV1Schema,
    request_sha256: Sha256Schema,
    source_lineage: DiagnosisSourceLineageV1Schema,
  },
  { additionalProperties: false }
);
export type DiagnosisV1 = Readonly<Static<typeof DiagnosisV1Schema>>;

export const DiagnosisValidityReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.diagnosis-validity-receipt.v1"),
    schema_version: Type.Literal(1),
    validity_receipt_id: Type.String({ pattern: "^dgvr_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    verdict: Type.Literal("PASS"),
    reviewer: Type.Literal("vera"),
    request_ref: ArtifactRefSchema,
    causal_decomposition_ref: ArtifactRefSchema,
    competing_hypotheses_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    diagnosis_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    execution_receipt_id: OpaqueIdSchema,
    execution_result_sha256: Sha256Schema,
    created_at: Rfc3339UtcSchema,
    remediation_started: Type.Literal(false),
    tests_executed: Type.Literal(false),
    minted_by: Type.Literal("host:diagnosis-validity-receipt-authority"),
  },
  { additionalProperties: false }
);
export type DiagnosisValidityReceiptV1 = Readonly<Static<typeof DiagnosisValidityReceiptV1Schema>>;

const DIAGNOSIS_INTEGRITY_CHECKS = [
  "canonical_diagnosis",
  "exact_source_lineage",
  "exact_request_coverage",
  "latest_vera_pass",
  "signed_worker_evidence",
  "tests_not_executed",
  "remediation_not_started",
] as const;

export const DiagnosisProductIntegrityV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.diagnosis-product-integrity.v1"),
    schema_version: Type.Literal(1),
    integrity_id: Type.String({ pattern: "^dgir_[a-f0-9]{64}$" }),
    status: Type.Literal("PASS"),
    request_ref: ArtifactRefSchema,
    causal_decomposition_ref: ArtifactRefSchema,
    competing_hypotheses_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    diagnosis_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    execution_receipt_ids: Type.Array(OpaqueIdSchema, {
      minItems: 4,
      maxItems: 16,
      uniqueItems: true,
    }),
    checks: Type.Array(
      Type.Union([
        Type.Literal("canonical_diagnosis"),
        Type.Literal("exact_source_lineage"),
        Type.Literal("exact_request_coverage"),
        Type.Literal("latest_vera_pass"),
        Type.Literal("signed_worker_evidence"),
        Type.Literal("tests_not_executed"),
        Type.Literal("remediation_not_started"),
      ]),
      { minItems: 7, maxItems: 7, uniqueItems: true }
    ),
    remediation_started: Type.Literal(false),
    tests_executed: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type DiagnosisProductIntegrityV1 = Readonly<
  Static<typeof DiagnosisProductIntegrityV1Schema>
>;

export const DiagnosisProductEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.diagnosis-product-envelope.v1"),
    schema_version: Type.Literal(1),
    envelope_id: Type.String({ pattern: "^dgenv_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    status: Type.Literal("complete"),
    request_ref: ArtifactRefSchema,
    causal_decomposition_ref: ArtifactRefSchema,
    competing_hypotheses_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    diagnosis_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    integrity_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type DiagnosisProductEnvelopeV1 = Readonly<Static<typeof DiagnosisProductEnvelopeV1Schema>>;

function validateText(value: string, label: string, maxBytes: number, multiline = true): void {
  assertText(value, label, {
    minBytes: 1,
    maxBytes,
    multiline,
    trimmedNonEmpty: true,
  });
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

function collectIssue(issues: string[], action: () => void): void {
  try {
    action();
  } catch (error) {
    if (error instanceof SkillSchemaValidationError) issues.push(...error.issues);
    else if (error instanceof Error) issues.push(error.message);
    else issues.push("validation failed");
  }
}

function range(length: number): number[] {
  return Array.from({ length }, (_unused, index) => index);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertCanonicalIndexes(
  values: readonly number[],
  length: number,
  label: string,
  required = false
): void {
  if (
    (required && values.length === 0) ||
    new Set(values).size !== values.length ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0 || value >= length) ||
    !sameNumbers(
      values,
      [...values].sort((left, right) => left - right)
    )
  ) {
    throw new SkillSchemaValidationError(label, [
      `indexes must be unique, ascending, and within 0..${Math.max(0, length - 1)}`,
    ]);
  }
}

function assertNoIntersection(
  left: readonly number[],
  right: readonly number[],
  label: string
): void {
  const rightSet = new Set(right);
  if (left.some((value) => rightSet.has(value))) {
    throw new SkillSchemaValidationError(label, ["supporting and contradicting indexes overlap"]);
  }
}

function validateRequestContent(request: DiagnosisRequestV1): void {
  validateText(request.problem_statement, "DiagnosisRequestV1.problem_statement", 16_384);
  const groups = [
    request.symptoms,
    request.environment_facts,
    request.hard_constraints,
    request.non_goals,
    request.known_uncertainties,
  ];
  for (const group of groups) {
    for (const item of group) validateText(item.statement, "DiagnosisRequestV1 statement", 8_192);
  }
  for (const observation of request.supplied_observations) {
    validateText(observation.statement, "DiagnosisRequestV1 observation", 8_192);
    if (observation.source_label !== undefined) {
      validateText(observation.source_label, "DiagnosisRequestV1 source label", 512, false);
    }
  }
}

export function validateDiagnosisRequest(value: unknown): DiagnosisRequestV1 {
  const request = validateSkillSchema(DiagnosisRequestV1Schema, value, "DiagnosisRequestV1");
  validateRequestContent(request);
  return request;
}

export function canonicalizeDiagnosisRequest(input: {
  readonly goal: string;
  readonly constraints: unknown;
}): DiagnosisRequestV1 {
  validateText(input.goal, "DiagnosisRequestV1 goal", 16_384);
  const constraints = validateSkillSchema(
    DiagnosisRequestConstraintsV1Schema,
    input.constraints,
    "DiagnosisRequestV1 start constraints"
  );
  return validateDiagnosisRequest({
    schema_version: 1,
    problem_statement: input.goal,
    symptoms: constraints.symptoms,
    supplied_observations: constraints.supplied_observations,
    environment_facts: constraints.environment_facts,
    hard_constraints: constraints.hard_constraints,
    non_goals: constraints.non_goals,
    known_uncertainties: constraints.known_uncertainties,
    permitted_test_boundary: constraints.permitted_test_boundary,
  });
}

export function diagnosisRequestConstraints(requestValue: unknown): DiagnosisRequestConstraintsV1 {
  const request = validateDiagnosisRequest(requestValue);
  return {
    schema_version: 1,
    symptoms: request.symptoms,
    supplied_observations: request.supplied_observations,
    environment_facts: request.environment_facts,
    hard_constraints: request.hard_constraints,
    non_goals: request.non_goals,
    known_uncertainties: request.known_uncertainties,
    permitted_test_boundary: request.permitted_test_boundary,
  };
}

export function diagnosisRequestSha256(value: unknown): string {
  return sha256(canonicalJson(validateDiagnosisRequest(value)));
}

function validateCoreShape(value: unknown): DiagnosisDraftV1 {
  const draft = validateSkillSchema(DiagnosisDraftV1Schema, value, "DiagnosisDraftV1");
  const issues: string[] = [];
  collectIssue(issues, () =>
    validateText(draft.applicability_reason, "DiagnosisDraftV1 applicability", 8_192)
  );
  collectIssue(issues, () => validateText(draft.reasoning, "DiagnosisDraftV1 reasoning", 32_768));
  for (const hypothesis of draft.hypotheses) {
    collectIssue(issues, () =>
      assertOpaqueId(hypothesis.hypothesis_id, "DiagnosisDraftV1 hypothesis ID")
    );
    collectIssue(issues, () =>
      validateText(hypothesis.statement, "DiagnosisDraftV1 hypothesis", 8_192)
    );
    collectIssue(issues, () =>
      validateText(hypothesis.reasoning, "DiagnosisDraftV1 hypothesis reasoning", 16_384)
    );
  }
  for (const uncertainty of draft.uncertainty) {
    collectIssue(issues, () => validateText(uncertainty, "DiagnosisDraftV1 uncertainty", 8_192));
  }
  for (const check of draft.proposed_discriminating_checks) {
    collectIssue(issues, () => assertOpaqueId(check.check_id, "DiagnosisDraftV1 check ID"));
    collectIssue(issues, () =>
      validateText(check.proposal, "DiagnosisDraftV1 check proposal", 8_192)
    );
    collectIssue(issues, () =>
      validateText(check.expected_observation, "DiagnosisDraftV1 expected observation", 8_192)
    );
    collectIssue(issues, () =>
      validateText(check.boundary_note, "DiagnosisDraftV1 boundary note", 2_048)
    );
  }
  const sanitized = sanitizeIssues(issues);
  if (sanitized.length > 0) throw new SkillSchemaValidationError("DiagnosisDraftV1", sanitized);
  return draft;
}

function diagnosisSemanticIssues(
  draft: DiagnosisDraftV1,
  request: DiagnosisRequestV1
): readonly string[] {
  const issues: string[] = [];
  const hypothesisIds = draft.hypotheses.map((hypothesis) => hypothesis.hypothesis_id);
  const hypothesisIdSet = new Set(hypothesisIds);
  if (hypothesisIdSet.size !== hypothesisIds.length) issues.push("hypothesis IDs must be unique");
  const ranks = draft.hypotheses.map((hypothesis) => hypothesis.rank);
  if (
    !sameNumbers(
      ranks,
      range(draft.hypotheses.length).map((index) => index + 1)
    )
  ) {
    issues.push("hypothesis ranks must be the exact ordered sequence 1..N");
  }

  for (const hypothesis of draft.hypotheses) {
    collectIssue(issues, () =>
      assertCanonicalIndexes(
        hypothesis.symptom_indexes,
        request.symptoms.length,
        `${hypothesis.hypothesis_id}.symptom_indexes`,
        true
      )
    );
    collectIssue(issues, () =>
      assertCanonicalIndexes(
        hypothesis.supporting_observation_indexes,
        request.supplied_observations.length,
        `${hypothesis.hypothesis_id}.supporting_observation_indexes`
      )
    );
    collectIssue(issues, () =>
      assertCanonicalIndexes(
        hypothesis.contradicting_observation_indexes,
        request.supplied_observations.length,
        `${hypothesis.hypothesis_id}.contradicting_observation_indexes`
      )
    );
    collectIssue(issues, () =>
      assertCanonicalIndexes(
        hypothesis.supporting_environment_fact_indexes,
        request.environment_facts.length,
        `${hypothesis.hypothesis_id}.supporting_environment_fact_indexes`
      )
    );
    collectIssue(issues, () =>
      assertCanonicalIndexes(
        hypothesis.contradicting_environment_fact_indexes,
        request.environment_facts.length,
        `${hypothesis.hypothesis_id}.contradicting_environment_fact_indexes`
      )
    );
    collectIssue(issues, () =>
      assertCanonicalIndexes(
        hypothesis.hard_constraint_indexes,
        request.hard_constraints.length,
        `${hypothesis.hypothesis_id}.hard_constraint_indexes`
      )
    );
    collectIssue(issues, () =>
      assertNoIntersection(
        hypothesis.supporting_observation_indexes,
        hypothesis.contradicting_observation_indexes,
        `${hypothesis.hypothesis_id}.observation_indexes`
      )
    );
    collectIssue(issues, () =>
      assertNoIntersection(
        hypothesis.supporting_environment_fact_indexes,
        hypothesis.contradicting_environment_fact_indexes,
        `${hypothesis.hypothesis_id}.environment_fact_indexes`
      )
    );
    const supportingCount =
      hypothesis.supporting_observation_indexes.length +
      hypothesis.supporting_environment_fact_indexes.length;
    const contradictingCount =
      hypothesis.contradicting_observation_indexes.length +
      hypothesis.contradicting_environment_fact_indexes.length;
    if (hypothesis.status === "supported" && supportingCount === 0) {
      issues.push(
        `${hypothesis.hypothesis_id}: supported status requires supplied supporting evidence indexes`
      );
    }
    if (hypothesis.status === "ruled_out" && contradictingCount === 0) {
      issues.push(
        `${hypothesis.hypothesis_id}: ruled_out status requires supplied contradicting evidence indexes`
      );
    }
  }

  const supportedIds = draft.hypotheses
    .filter((hypothesis) => hypothesis.status === "supported")
    .map((hypothesis) => hypothesis.hypothesis_id);
  if (draft.disposition === "supported") {
    if (
      supportedIds.length === 0 ||
      draft.primary_supported_hypothesis_id === null ||
      !supportedIds.includes(draft.primary_supported_hypothesis_id)
    ) {
      issues.push(
        "supported disposition requires exactly one named primary among supported hypotheses"
      );
    }
  } else if (draft.primary_supported_hypothesis_id !== null) {
    issues.push(
      "inconclusive and not_applicable dispositions cannot name a primary supported cause"
    );
  }
  if (draft.disposition === "inconclusive") {
    if (
      draft.hypotheses.length === 0 ||
      supportedIds.length > 0 ||
      draft.hypotheses.filter((hypothesis) => hypothesis.status === "plausible").length < 2 ||
      draft.uncertainty.length === 0
    ) {
      issues.push(
        "inconclusive diagnosis requires at least two plausible hypotheses, no supported cause, and explicit uncertainty"
      );
    }
  }
  if (
    draft.disposition === "not_applicable" &&
    (draft.hypotheses.length !== 0 ||
      draft.primary_supported_hypothesis_id !== null ||
      draft.proposed_discriminating_checks.length !== 0)
  ) {
    issues.push(
      "not_applicable diagnosis requires an empty hypothesis and check set with no primary cause"
    );
  }
  if (draft.disposition !== "not_applicable" && draft.hypotheses.length === 0) {
    issues.push("applicable diagnosis requires a nonempty complete hypothesis set");
  }

  const checkIds = draft.proposed_discriminating_checks.map((check) => check.check_id);
  if (new Set(checkIds).size !== checkIds.length)
    issues.push("discriminating check IDs must be unique");
  for (const check of draft.proposed_discriminating_checks) {
    for (const hypothesisId of check.discriminates_hypothesis_ids) {
      if (!hypothesisIdSet.has(hypothesisId)) {
        issues.push(
          `${check.check_id}: discriminates_hypothesis_ids contains an unknown hypothesis`
        );
      }
    }
  }
  if (
    request.permitted_test_boundary.mode === "none" &&
    draft.proposed_discriminating_checks.length > 0
  ) {
    issues.push("permitted_test_boundary=none forbids proposed discriminating checks");
  }
  if (
    request.permitted_test_boundary.mode === "proposal_only" &&
    draft.disposition === "inconclusive" &&
    draft.proposed_discriminating_checks.length === 0
  ) {
    issues.push(
      "inconclusive diagnosis requires a proposed discriminating check when proposal_only is permitted"
    );
  }

  const coverage = draft.request_coverage;
  const coverageExpectations = [
    [coverage.symptom_indexes, request.symptoms.length, "symptom_indexes"],
    [coverage.observation_indexes, request.supplied_observations.length, "observation_indexes"],
    [
      coverage.environment_fact_indexes,
      request.environment_facts.length,
      "environment_fact_indexes",
    ],
    [coverage.hard_constraint_indexes, request.hard_constraints.length, "hard_constraint_indexes"],
    [coverage.non_goal_indexes, request.non_goals.length, "non_goal_indexes"],
    [
      coverage.known_uncertainty_indexes,
      request.known_uncertainties.length,
      "known_uncertainty_indexes",
    ],
  ] as const;
  for (const [actual, length, label] of coverageExpectations) {
    if (!sameNumbers(actual, range(length))) {
      issues.push(`request_coverage.${label} must equal the complete exact request index set`);
    }
  }

  return sanitizeIssues(issues);
}

export function validateDiagnosisDraft(
  value: unknown,
  input: { readonly request: unknown }
): DiagnosisDraftV1 {
  const request = validateDiagnosisRequest(input.request);
  let draft: DiagnosisDraftV1;
  try {
    draft = validateCoreShape(value);
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? sanitizeIssues(error.issues)
        : sanitizeIssues([
            error instanceof Error ? error.message : "closed schema validation failed",
          ]);
    throw new DiagnosisDraftValidationError("SCHEMA_INVALID", issues);
  }
  const issues = diagnosisSemanticIssues(draft, request);
  if (issues.length > 0) throw new DiagnosisDraftValidationError("SEMANTIC_INVALID", issues);
  return draft;
}

const DIAGNOSIS_CORE_PREFIX = "DIAGNOSIS_CORE:";
const DIAGNOSIS_SUMMARY_PREFIX = "SUMMARY:";

function draftFailure(
  failureClass: DiagnosisDraftFailureClassV1,
  issue: string | readonly string[]
): DiagnosisDraftValidationError {
  return new DiagnosisDraftValidationError(
    failureClass,
    sanitizeIssues(typeof issue === "string" ? [issue] : issue)
  );
}

function parseExactSummary(value: string): DiagnosisRoutingSummaryV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  try {
    const summary = validateSkillSchema(
      DiagnosisRoutingSummaryV1Schema,
      parsed,
      "DiagnosisDraftV1 routing summary"
    );
    return `{"confidence":"${summary.confidence}","complete":true}` === value ? summary : undefined;
  } catch {
    return undefined;
  }
}

export function parsePersistedDiagnosisDraft(
  bytes: Uint8Array,
  input: { readonly request: unknown }
): { readonly draft: DiagnosisDraftV1; readonly summary: DiagnosisRoutingSummaryV1 } {
  const body = Buffer.from(bytes);
  if (body.length === 0 || body.length > MAX_PERSISTED_DIAGNOSIS_DRAFT_BYTES) {
    throw draftFailure(
      "FRAMING_INVALID",
      `DiagnosisDraftV1 output must be 1..${MAX_PERSISTED_DIAGNOSIS_DRAFT_BYTES} bytes`
    );
  }
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    throw draftFailure("FRAMING_INVALID", "DiagnosisDraftV1 output forbids BOM");
  }
  if (body.includes(0))
    throw draftFailure("FRAMING_INVALID", "DiagnosisDraftV1 output forbids NUL");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw draftFailure("FRAMING_INVALID", "DiagnosisDraftV1 output is not strict UTF-8");
  }
  if (text.includes("\ufeff") || text.includes("\r")) {
    throw draftFailure("FRAMING_INVALID", "DiagnosisDraftV1 output forbids BOM and CR");
  }
  const framed = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (framed.endsWith("\n")) {
    throw draftFailure(
      "FRAMING_INVALID",
      "DiagnosisDraftV1 output permits at most one trailing LF"
    );
  }
  const lines = framed.split("\n");
  if (
    lines.length !== 2 ||
    !lines[0]?.startsWith(DIAGNOSIS_CORE_PREFIX) ||
    !lines[1]?.startsWith(DIAGNOSIS_SUMMARY_PREFIX) ||
    lines.some((line) => line.trim() !== line || line.includes("`"))
  ) {
    throw draftFailure(
      "FRAMING_INVALID",
      "DiagnosisDraftV1 requires exactly one unwrapped DIAGNOSIS_CORE line then one compact final SUMMARY line"
    );
  }
  const coreText = lines[0].slice(DIAGNOSIS_CORE_PREFIX.length);
  const summaryText = lines[1].slice(DIAGNOSIS_SUMMARY_PREFIX.length);
  const summary = parseExactSummary(summaryText);
  if (coreText.length === 0 || summary === undefined) {
    throw draftFailure("FRAMING_INVALID", "DiagnosisDraftV1 core or SUMMARY framing is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(coreText);
  } catch {
    throw draftFailure("JSON_INVALID", "DiagnosisDraftV1 DIAGNOSIS_CORE is not JSON");
  }
  let draft: DiagnosisDraftV1;
  try {
    draft = validateDiagnosisDraft(parsed, input);
  } catch (error) {
    if (error instanceof DiagnosisDraftValidationError) throw error;
    throw draftFailure(
      "SCHEMA_INVALID",
      error instanceof Error ? error.message : "validation failed"
    );
  }
  if (draft.confidence !== summary.confidence) {
    throw draftFailure(
      "SEMANTIC_INVALID",
      "DiagnosisDraftV1 confidence must equal SUMMARY confidence"
    );
  }
  return { draft, summary };
}

export function diagnosisDraftPromptContract(): string {
  return canonicalJson({
    schema: DiagnosisCoreV1Schema,
    transport: {
      encoding: "strict UTF-8",
      maximum_output_bytes: MAX_PERSISTED_DIAGNOSIS_DRAFT_BYTES,
      canonical_framing:
        "exactly DIAGNOSIS_CORE:<single-line JSON> followed by SUMMARY:<compact JSON>, with one LF between and no prose",
      aliases_or_coercions: false,
    },
    evidence_indexing:
      "all indexes are zero-based exact indexes into the corresponding canonical DiagnosisRequestV1 arrays",
    dispositions: {
      supported: "one named primary_supported_hypothesis_id must identify a supported hypothesis",
      inconclusive:
        "no supported or primary cause; retain plausible hypotheses, explicit uncertainty, and proposal-only discriminating checks when permitted",
      not_applicable: "empty hypothesis/check set and no primary cause",
    },
    boundaries: {
      tests_executed: false,
      remediation_started: false,
      permitted_test_boundary:
        "none forbids checks; proposal_only permits non-executed check proposals only",
    },
    host_semantic_validator: "validateDiagnosisDraft",
  });
}

export function diagnosisSourceLineageSha256(value: unknown): string {
  return sha256(
    canonicalJson(
      validateSkillSchema(
        DiagnosisSourceLineagePreimageV1Schema,
        value,
        "DiagnosisV1 source lineage preimage"
      )
    )
  );
}

function projectDiagnosisDraftUnchecked(diagnosis: DiagnosisV1): DiagnosisDraftV1 {
  return {
    schema_version: diagnosis.schema_version,
    disposition: diagnosis.disposition,
    applicability_reason: diagnosis.applicability_reason,
    hypothesis_set_complete: diagnosis.hypothesis_set_complete,
    hypotheses: diagnosis.hypotheses,
    primary_supported_hypothesis_id: diagnosis.primary_supported_hypothesis_id,
    reasoning: diagnosis.reasoning,
    uncertainty: diagnosis.uncertainty,
    proposed_discriminating_checks: diagnosis.proposed_discriminating_checks,
    request_coverage: diagnosis.request_coverage,
    confidence: diagnosis.confidence,
    remediation_started: diagnosis.remediation_started,
    tests_executed: diagnosis.tests_executed,
  };
}

export function projectDiagnosisDraft(value: unknown): DiagnosisDraftV1 {
  return projectDiagnosisDraftUnchecked(validateDiagnosis(value));
}

export function validateDiagnosis(value: unknown): DiagnosisV1 {
  const diagnosis = validateSkillSchema(DiagnosisV1Schema, value, "DiagnosisV1");
  const request = validateDiagnosisRequest(diagnosis.request);
  if (diagnosis.request_sha256 !== diagnosisRequestSha256(request)) {
    throw new Error("DiagnosisV1 request digest drifted");
  }
  const lineagePreimage: DiagnosisSourceLineagePreimageV1 = {
    request_artifact_id: diagnosis.source_lineage.request_artifact_id,
    request_artifact_sha256: diagnosis.source_lineage.request_artifact_sha256,
    causal_decomposition_artifact_id: diagnosis.source_lineage.causal_decomposition_artifact_id,
    causal_decomposition_sha256: diagnosis.source_lineage.causal_decomposition_sha256,
    competing_hypotheses_artifact_id: diagnosis.source_lineage.competing_hypotheses_artifact_id,
    competing_hypotheses_sha256: diagnosis.source_lineage.competing_hypotheses_sha256,
    draft_artifact_id: diagnosis.source_lineage.draft_artifact_id,
    draft_artifact_sha256: diagnosis.source_lineage.draft_artifact_sha256,
    draft_sha256: diagnosis.source_lineage.draft_sha256,
  };
  if (diagnosis.source_lineage.lineage_sha256 !== diagnosisSourceLineageSha256(lineagePreimage)) {
    throw new Error("DiagnosisV1 source lineage digest drifted");
  }
  assertUnique(
    [
      lineagePreimage.request_artifact_id,
      lineagePreimage.causal_decomposition_artifact_id,
      lineagePreimage.competing_hypotheses_artifact_id,
      lineagePreimage.draft_artifact_id,
    ],
    "DiagnosisV1 source lineage artifact IDs"
  );
  const draft = validateDiagnosisDraft(projectDiagnosisDraftUnchecked(diagnosis), { request });
  if (lineagePreimage.draft_sha256 !== sha256(canonicalJson(draft))) {
    throw new Error("DiagnosisV1 draft lineage drifted");
  }
  return diagnosis;
}

export function sealDiagnosisDraft(input: {
  readonly request: unknown;
  readonly draft: unknown;
  readonly requestRef: ArtifactRef;
  readonly causalDecompositionRef: ArtifactRef;
  readonly competingHypothesesRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
}): DiagnosisV1 {
  const request = validateDiagnosisRequest(input.request);
  const draft = validateDiagnosisDraft(input.draft, { request });
  const refs = [
    input.requestRef,
    input.causalDecompositionRef,
    input.competingHypothesesRef,
    input.draftRef,
  ];
  if (
    input.requestRef.kind !== "diagnosis-request" ||
    input.requestRef.phase !== "intake" ||
    input.requestRef.branch_id !== null ||
    input.requestRef.producer !== "host:request-admission" ||
    input.causalDecompositionRef.kind !== "agent-output" ||
    input.causalDecompositionRef.phase !== "decomposing_causes" ||
    input.causalDecompositionRef.branch_id !== null ||
    input.causalDecompositionRef.producer !== "agent:annie" ||
    input.competingHypothesesRef.kind !== "agent-output" ||
    input.competingHypothesesRef.phase !== "generating_hypotheses" ||
    input.competingHypothesesRef.branch_id !== null ||
    input.competingHypothesesRef.producer !== "agent:ida" ||
    input.draftRef.kind !== "diagnosis-draft" ||
    input.draftRef.phase !== "adjudicating_diagnosis" ||
    input.draftRef.branch_id !== null ||
    input.draftRef.producer !== "agent:demetri" ||
    new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length
  ) {
    throw new Error("DiagnosisV1 sealing refs have invalid or ambiguous roles");
  }
  const runIds = new Set(refs.map((ref) => ref.run_id));
  if (runIds.size !== 1) throw new Error("DiagnosisV1 sealing refs cross run boundaries");
  const lineage: DiagnosisSourceLineagePreimageV1 = {
    request_artifact_id: input.requestRef.artifact_id,
    request_artifact_sha256: input.requestRef.content_digest,
    causal_decomposition_artifact_id: input.causalDecompositionRef.artifact_id,
    causal_decomposition_sha256: input.causalDecompositionRef.content_digest,
    competing_hypotheses_artifact_id: input.competingHypothesesRef.artifact_id,
    competing_hypotheses_sha256: input.competingHypothesesRef.content_digest,
    draft_artifact_id: input.draftRef.artifact_id,
    draft_artifact_sha256: input.draftRef.content_digest,
    draft_sha256: sha256(canonicalJson(draft)),
  };
  return validateDiagnosis({
    ...draft,
    request,
    request_sha256: diagnosisRequestSha256(request),
    source_lineage: { ...lineage, lineage_sha256: diagnosisSourceLineageSha256(lineage) },
  });
}

export function assertDiagnosisLineage(input: {
  readonly diagnosis: unknown;
  readonly request: unknown;
  readonly requestRef: ArtifactRef;
  readonly causalDecompositionRef: ArtifactRef;
  readonly competingHypothesesRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
  readonly draft: unknown;
}): DiagnosisV1 {
  const expected = sealDiagnosisDraft(input);
  const diagnosis = validateDiagnosis(input.diagnosis);
  if (canonicalJson(diagnosis) !== canonicalJson(expected)) {
    throw new Error("DiagnosisV1 request, draft, or exact source lineage diverged");
  }
  return diagnosis;
}

export function validateCanonicalDiagnosisBytes(bytes: Uint8Array, ref: ArtifactRef): DiagnosisV1 {
  const body = Buffer.from(bytes);
  if (
    ref.kind !== "semantic-core" ||
    ref.phase !== "sealing_diagnosis" ||
    ref.branch_id !== null ||
    ref.producer !== "host:diagnosis-sealer" ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== "penny.diagnosis.v1" ||
    ref.content_schema.schema_version !== 1 ||
    ref.byte_length !== body.length ||
    ref.content_digest !== sha256(body) ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  ) {
    throw new Error("DiagnosisV1 artifact ref is stale or has the wrong semantic identity");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("DiagnosisV1 artifact is not JSON");
  }
  const diagnosis = validateDiagnosis(parsed);
  if (canonicalJson(diagnosis) !== body.toString("utf8")) {
    throw new Error("DiagnosisV1 artifact bytes are not canonical JSON");
  }
  return diagnosis;
}

export function validateDiagnosisSealFeedback(value: unknown): DiagnosisSealFeedbackV1 {
  const feedback = validateSkillSchema(
    DiagnosisSealFeedbackV1Schema,
    value,
    "DiagnosisSealFeedbackV1"
  );
  for (const issue of feedback.issues) validateText(issue, "Diagnosis seal issue", 512, false);
  return feedback;
}

export function diagnosisValidityReceiptId(
  body: Omit<DiagnosisValidityReceiptV1, "validity_receipt_id">
): `dgvr_${string}` {
  return `dgvr_${sha256(canonicalJson(body))}`;
}

export function validateDiagnosisValidityReceipt(value: unknown): DiagnosisValidityReceiptV1 {
  const receipt = validateSkillSchema(
    DiagnosisValidityReceiptV1Schema,
    value,
    "DiagnosisValidityReceiptV1"
  );
  assertOpaqueId(receipt.run_id, "DiagnosisValidityReceiptV1.run_id");
  assertRfc3339Utc(receipt.created_at, "DiagnosisValidityReceiptV1.created_at");
  const refs = [
    receipt.request_ref,
    receipt.causal_decomposition_ref,
    receipt.competing_hypotheses_ref,
    receipt.draft_ref,
    receipt.diagnosis_ref,
    receipt.vera_report_ref,
  ];
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "DiagnosisValidityReceiptV1 refs"
  );
  if (
    refs.some((ref) => ref.run_id !== receipt.run_id) ||
    receipt.request_ref.kind !== "diagnosis-request" ||
    receipt.request_ref.phase !== "intake" ||
    receipt.request_ref.producer !== "host:request-admission" ||
    receipt.causal_decomposition_ref.kind !== "agent-output" ||
    receipt.causal_decomposition_ref.phase !== "decomposing_causes" ||
    receipt.causal_decomposition_ref.producer !== "agent:annie" ||
    receipt.competing_hypotheses_ref.kind !== "agent-output" ||
    receipt.competing_hypotheses_ref.phase !== "generating_hypotheses" ||
    receipt.competing_hypotheses_ref.producer !== "agent:ida" ||
    receipt.draft_ref.kind !== "diagnosis-draft" ||
    receipt.draft_ref.phase !== "adjudicating_diagnosis" ||
    receipt.draft_ref.producer !== "agent:demetri" ||
    receipt.diagnosis_ref.kind !== "semantic-core" ||
    receipt.diagnosis_ref.phase !== "sealing_diagnosis" ||
    receipt.diagnosis_ref.producer !== "host:diagnosis-sealer" ||
    receipt.diagnosis_ref.content_schema?.schema_id !== "penny.diagnosis.v1" ||
    receipt.diagnosis_ref.content_schema.schema_version !== 1 ||
    receipt.vera_report_ref.kind !== "agent-output" ||
    receipt.vera_report_ref.phase !== "verifying_diagnosis" ||
    receipt.vera_report_ref.producer !== "agent:vera" ||
    refs.some((ref) => ref.branch_id !== null)
  ) {
    throw new Error("DiagnosisValidityReceiptV1 exact artifact roles disagree");
  }
  const { validity_receipt_id: receiptId, ...body } = receipt;
  assertDerivedId(receiptId, "dgvr_", sha256(canonicalJson(body)), "DiagnosisValidityReceiptV1");
  return receipt;
}

export function diagnosisProductIntegrityId(
  body: Omit<DiagnosisProductIntegrityV1, "integrity_id">
): `dgir_${string}` {
  return `dgir_${sha256(canonicalJson(body))}`;
}

export function validateDiagnosisProductIntegrity(value: unknown): DiagnosisProductIntegrityV1 {
  const integrity = validateSkillSchema(
    DiagnosisProductIntegrityV1Schema,
    value,
    "DiagnosisProductIntegrityV1"
  );
  if (canonicalJson(integrity.checks) !== canonicalJson(DIAGNOSIS_INTEGRITY_CHECKS)) {
    throw new Error("DiagnosisProductIntegrityV1 checks are incomplete or reordered");
  }
  const refs = [
    integrity.request_ref,
    integrity.causal_decomposition_ref,
    integrity.competing_hypotheses_ref,
    integrity.draft_ref,
    integrity.diagnosis_ref,
    integrity.vera_report_ref,
    integrity.validity_receipt_ref,
  ];
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "DiagnosisProductIntegrityV1 refs"
  );
  const runIds = new Set(refs.map((ref) => ref.run_id));
  if (
    runIds.size !== 1 ||
    integrity.request_ref.kind !== "diagnosis-request" ||
    integrity.request_ref.phase !== "intake" ||
    integrity.request_ref.producer !== "host:request-admission" ||
    integrity.causal_decomposition_ref.kind !== "agent-output" ||
    integrity.causal_decomposition_ref.phase !== "decomposing_causes" ||
    integrity.causal_decomposition_ref.producer !== "agent:annie" ||
    integrity.competing_hypotheses_ref.kind !== "agent-output" ||
    integrity.competing_hypotheses_ref.phase !== "generating_hypotheses" ||
    integrity.competing_hypotheses_ref.producer !== "agent:ida" ||
    integrity.draft_ref.kind !== "diagnosis-draft" ||
    integrity.draft_ref.phase !== "adjudicating_diagnosis" ||
    integrity.draft_ref.producer !== "agent:demetri" ||
    integrity.diagnosis_ref.kind !== "semantic-core" ||
    integrity.diagnosis_ref.phase !== "sealing_diagnosis" ||
    integrity.diagnosis_ref.producer !== "host:diagnosis-sealer" ||
    integrity.diagnosis_ref.content_schema?.schema_id !== "penny.diagnosis.v1" ||
    integrity.diagnosis_ref.content_schema.schema_version !== 1 ||
    integrity.vera_report_ref.kind !== "agent-output" ||
    integrity.vera_report_ref.phase !== "verifying_diagnosis" ||
    integrity.vera_report_ref.producer !== "agent:vera" ||
    integrity.validity_receipt_ref.kind !== "diagnosis-validity-receipt" ||
    integrity.validity_receipt_ref.phase !== "verifying_diagnosis" ||
    integrity.validity_receipt_ref.branch_id !== "validity" ||
    integrity.validity_receipt_ref.producer !== "host:diagnosis-validity-receipt-authority" ||
    refs.slice(0, 6).some((ref) => ref.branch_id !== null)
  ) {
    throw new Error("DiagnosisProductIntegrityV1 exact artifact roles disagree");
  }
  const { integrity_id: integrityId, ...body } = integrity;
  assertDerivedId(integrityId, "dgir_", sha256(canonicalJson(body)), "DiagnosisProductIntegrityV1");
  return integrity;
}

export function diagnosisProductEnvelopeId(
  body: Omit<DiagnosisProductEnvelopeV1, "envelope_id">
): `dgenv_${string}` {
  return `dgenv_${sha256(canonicalJson(body))}`;
}

export function validateDiagnosisProductEnvelope(value: unknown): DiagnosisProductEnvelopeV1 {
  const envelope = validateSkillSchema(
    DiagnosisProductEnvelopeV1Schema,
    value,
    "DiagnosisProductEnvelopeV1"
  );
  assertOpaqueId(envelope.run_id, "DiagnosisProductEnvelopeV1.run_id");
  const refs = [
    envelope.request_ref,
    envelope.causal_decomposition_ref,
    envelope.competing_hypotheses_ref,
    envelope.draft_ref,
    envelope.diagnosis_ref,
    envelope.vera_report_ref,
    envelope.validity_receipt_ref,
    envelope.integrity_ref,
  ];
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "DiagnosisProductEnvelopeV1 refs"
  );
  if (
    refs.some((ref) => ref.run_id !== envelope.run_id) ||
    envelope.request_ref.kind !== "diagnosis-request" ||
    envelope.request_ref.phase !== "intake" ||
    envelope.request_ref.producer !== "host:request-admission" ||
    envelope.causal_decomposition_ref.kind !== "agent-output" ||
    envelope.causal_decomposition_ref.phase !== "decomposing_causes" ||
    envelope.causal_decomposition_ref.producer !== "agent:annie" ||
    envelope.competing_hypotheses_ref.kind !== "agent-output" ||
    envelope.competing_hypotheses_ref.phase !== "generating_hypotheses" ||
    envelope.competing_hypotheses_ref.producer !== "agent:ida" ||
    envelope.draft_ref.kind !== "diagnosis-draft" ||
    envelope.draft_ref.phase !== "adjudicating_diagnosis" ||
    envelope.draft_ref.producer !== "agent:demetri" ||
    envelope.diagnosis_ref.kind !== "semantic-core" ||
    envelope.diagnosis_ref.phase !== "sealing_diagnosis" ||
    envelope.diagnosis_ref.producer !== "host:diagnosis-sealer" ||
    envelope.diagnosis_ref.content_schema?.schema_id !== "penny.diagnosis.v1" ||
    envelope.diagnosis_ref.content_schema.schema_version !== 1 ||
    envelope.vera_report_ref.kind !== "agent-output" ||
    envelope.vera_report_ref.phase !== "verifying_diagnosis" ||
    envelope.vera_report_ref.producer !== "agent:vera" ||
    envelope.validity_receipt_ref.kind !== "diagnosis-validity-receipt" ||
    envelope.validity_receipt_ref.phase !== "verifying_diagnosis" ||
    envelope.validity_receipt_ref.branch_id !== "validity" ||
    envelope.validity_receipt_ref.producer !== "host:diagnosis-validity-receipt-authority" ||
    envelope.integrity_ref.kind !== "diagnosis-product-integrity" ||
    envelope.integrity_ref.phase !== "verifying_diagnosis" ||
    envelope.integrity_ref.branch_id !== "integrity" ||
    envelope.integrity_ref.producer !== "host:diagnosis-product-validator" ||
    refs.slice(0, 6).some((ref) => ref.branch_id !== null)
  ) {
    throw new Error("DiagnosisProductEnvelopeV1 exact artifact roles disagree");
  }
  const { envelope_id: envelopeId, ...body } = envelope;
  assertDerivedId(envelopeId, "dgenv_", sha256(canonicalJson(body)), "DiagnosisProductEnvelopeV1");
  return envelope;
}
