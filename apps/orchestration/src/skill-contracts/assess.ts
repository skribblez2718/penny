import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { ArtifactRefSchema, ConfidenceSchema, type ArtifactRef } from "../contracts.js";
import {
  ArtifactIdSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  SkillSchemaValidationError,
  TextSchema,
  assertOpaqueId,
  assertRfc3339Utc,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "./common.js";

const MAX_REQUEST_ITEMS = 64;
const MAX_ASSESSMENT_ITEMS = 32;
export const MAX_PERSISTED_ASSESSMENT_DRAFT_BYTES = 131_072;

const StatementV1Schema = Type.Object(
  { statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }) },
  { additionalProperties: false }
);
const SuppliedEvidenceV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
    source_label: Type.Optional(TextSchema({ minBytes: 1, maxBytes: 512 })),
  },
  { additionalProperties: false }
);
const CriterionV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    importance: Type.Union([Type.Literal("required"), Type.Literal("advisory")]),
  },
  { additionalProperties: false }
);
const TargetV1Schema = Type.Union([
  TextSchema({ minBytes: 1, maxBytes: 32_768, multiline: true }),
  Type.Array(StatementV1Schema, { minItems: 1, maxItems: MAX_REQUEST_ITEMS }),
]);

const AssessmentRequestProperties = {
  schema_version: Type.Literal(1),
  assessment_purpose: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
  target: TargetV1Schema,
  criteria: Type.Array(CriterionV1Schema, { minItems: 1, maxItems: MAX_REQUEST_ITEMS }),
  supplied_evidence: Type.Array(SuppliedEvidenceV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  hard_constraints: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  non_goals: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  known_uncertainties: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
};

export const AssessmentRequestV1Schema = Type.Object(AssessmentRequestProperties, {
  additionalProperties: false,
});
export type AssessmentRequestV1 = Readonly<Static<typeof AssessmentRequestV1Schema>>;

export const AssessmentRequestConstraintsV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    target: AssessmentRequestV1Schema.properties.target,
    criteria: AssessmentRequestV1Schema.properties.criteria,
    supplied_evidence: AssessmentRequestV1Schema.properties.supplied_evidence,
    hard_constraints: AssessmentRequestV1Schema.properties.hard_constraints,
    non_goals: AssessmentRequestV1Schema.properties.non_goals,
    known_uncertainties: AssessmentRequestV1Schema.properties.known_uncertainties,
  },
  { additionalProperties: false }
);
export type AssessmentRequestConstraintsV1 = Readonly<
  Static<typeof AssessmentRequestConstraintsV1Schema>
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

const CriterionOutcomeV1Schema = Type.Object(
  {
    criterion_index: RequestIndexSchema,
    verdict: Type.Union([
      Type.Literal("met"),
      Type.Literal("partially_met"),
      Type.Literal("not_met"),
      Type.Literal("not_assessable"),
    ]),
    supporting_evidence_indexes: RequestIndexesSchema,
    contradicting_evidence_indexes: RequestIndexesSchema,
    rationale: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
  },
  { additionalProperties: false }
);

const StrengthV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    criterion_indexes: RequiredRequestIndexesSchema,
    evidence_indexes: RequestIndexesSchema,
  },
  { additionalProperties: false }
);
const GapV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    criterion_indexes: RequiredRequestIndexesSchema,
    evidence_indexes: RequestIndexesSchema,
    severity: Type.Union([Type.Literal("major"), Type.Literal("minor")]),
  },
  { additionalProperties: false }
);
const ImprovementSuggestionV1Schema = Type.Object(
  {
    suggestion: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    criterion_indexes: RequiredRequestIndexesSchema,
  },
  { additionalProperties: false }
);

const RequestCoverageV1Schema = Type.Object(
  {
    assessment_purpose_covered: Type.Literal(true),
    target_statement_indexes: RequiredRequestIndexesSchema,
    criterion_indexes: RequiredRequestIndexesSchema,
    supplied_evidence_indexes: RequestIndexesSchema,
    hard_constraint_indexes: RequestIndexesSchema,
    non_goal_indexes: RequestIndexesSchema,
    known_uncertainty_indexes: RequestIndexesSchema,
  },
  { additionalProperties: false }
);

const AssessmentCoreProperties = {
  schema_version: Type.Literal(1),
  disposition: Type.Union([
    Type.Literal("meets"),
    Type.Literal("partially_meets"),
    Type.Literal("does_not_meet"),
    Type.Literal("inconclusive"),
    Type.Literal("not_applicable"),
  ]),
  criterion_outcomes: Type.Array(CriterionOutcomeV1Schema, {
    minItems: 1,
    maxItems: MAX_REQUEST_ITEMS,
  }),
  summary: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
  strengths: Type.Array(StrengthV1Schema, { maxItems: MAX_ASSESSMENT_ITEMS }),
  gaps: Type.Array(GapV1Schema, { maxItems: MAX_ASSESSMENT_ITEMS }),
  improvement_suggestions: Type.Array(ImprovementSuggestionV1Schema, {
    maxItems: MAX_ASSESSMENT_ITEMS,
  }),
  assumptions: Type.Array(TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }), {
    maxItems: MAX_ASSESSMENT_ITEMS,
    uniqueItems: true,
  }),
  uncertainties: Type.Array(TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }), {
    maxItems: MAX_ASSESSMENT_ITEMS,
    uniqueItems: true,
  }),
  request_coverage: RequestCoverageV1Schema,
  confidence: ConfidenceSchema,
  external_actions_performed: Type.Literal(false),
  filesystem_writes_performed: Type.Literal(false),
  tests_executed: Type.Literal(false),
  changes_started: Type.Literal(false),
};

export const AssessmentDraftV1Schema = Type.Object(AssessmentCoreProperties, {
  additionalProperties: false,
});
export type AssessmentDraftV1 = Readonly<Static<typeof AssessmentDraftV1Schema>>;

export type AssessmentDraftFailureClassV1 =
  | "FRAMING_INVALID"
  | "JSON_INVALID"
  | "SCHEMA_INVALID"
  | "SEMANTIC_INVALID"
  | "LINEAGE_INVALID";

export class AssessmentDraftValidationError extends Error {
  constructor(
    readonly failureClass: AssessmentDraftFailureClassV1,
    readonly issues: readonly string[]
  ) {
    super(`${failureClass}: ${issues.join("; ")}`);
    this.name = "AssessmentDraftValidationError";
  }
}

export const AssessmentSealFeedbackV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.assessment-seal-feedback.v1"),
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
export type AssessmentSealFeedbackV1 = Readonly<Static<typeof AssessmentSealFeedbackV1Schema>>;

const AssessmentRoutingSummaryV1Schema = Type.Object(
  { confidence: ConfidenceSchema, complete: Type.Literal(true) },
  { additionalProperties: false }
);
export type AssessmentRoutingSummaryV1 = Readonly<Static<typeof AssessmentRoutingSummaryV1Schema>>;

const TargetStatementLineageV1Schema = Type.Object(
  { target_statement_index: RequestIndexSchema, statement_sha256: Sha256Schema },
  { additionalProperties: false }
);
const CriterionLineageV1Schema = Type.Object(
  {
    criterion_index: RequestIndexSchema,
    statement_sha256: Sha256Schema,
    importance: Type.Union([Type.Literal("required"), Type.Literal("advisory")]),
  },
  { additionalProperties: false }
);
const SuppliedEvidenceLineageV1Schema = Type.Object(
  {
    evidence_index: RequestIndexSchema,
    statement_sha256: Sha256Schema,
    source_label: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  },
  { additionalProperties: false }
);

const AssessmentSourceLineagePreimageV1Schema = Type.Object(
  {
    request_artifact_id: ArtifactIdSchema,
    request_artifact_sha256: Sha256Schema,
    analysis_artifact_id: ArtifactIdSchema,
    analysis_artifact_sha256: Sha256Schema,
    draft_artifact_id: ArtifactIdSchema,
    draft_artifact_sha256: Sha256Schema,
    draft_sha256: Sha256Schema,
    target_statements: Type.Array(TargetStatementLineageV1Schema, {
      minItems: 1,
      maxItems: MAX_REQUEST_ITEMS,
    }),
    criteria: Type.Array(CriterionLineageV1Schema, {
      minItems: 1,
      maxItems: MAX_REQUEST_ITEMS,
    }),
    supplied_evidence: Type.Array(SuppliedEvidenceLineageV1Schema, {
      maxItems: MAX_REQUEST_ITEMS,
    }),
  },
  { additionalProperties: false }
);
export type AssessmentSourceLineagePreimageV1 = Readonly<
  Static<typeof AssessmentSourceLineagePreimageV1Schema>
>;

export const AssessmentSourceLineageV1Schema = Type.Object(
  { ...AssessmentSourceLineagePreimageV1Schema.properties, lineage_sha256: Sha256Schema },
  { additionalProperties: false }
);
export type AssessmentSourceLineageV1 = Readonly<Static<typeof AssessmentSourceLineageV1Schema>>;

export const AssessmentV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.assessment.v1"),
    ...AssessmentCoreProperties,
    request: AssessmentRequestV1Schema,
    request_sha256: Sha256Schema,
    source_lineage: AssessmentSourceLineageV1Schema,
  },
  { additionalProperties: false }
);
export type AssessmentV1 = Readonly<Static<typeof AssessmentV1Schema>>;

export const AssessmentValidityReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.assessment-validity-receipt.v1"),
    schema_version: Type.Literal(1),
    receipt_id: Type.String({ pattern: "^asvr_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    verdict: Type.Literal("PASS"),
    reviewer: Type.Literal("vera"),
    request_ref: ArtifactRefSchema,
    analysis_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    assessment_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    execution_receipt_id: OpaqueIdSchema,
    execution_result_sha256: Sha256Schema,
    created_at: Rfc3339UtcSchema,
    external_actions_performed: Type.Literal(false),
    filesystem_writes_performed: Type.Literal(false),
    tests_executed: Type.Literal(false),
    changes_started: Type.Literal(false),
    minted_by: Type.Literal("host:assessment-validity-authority"),
  },
  { additionalProperties: false }
);
export type AssessmentValidityReceiptV1 = Readonly<
  Static<typeof AssessmentValidityReceiptV1Schema>
>;

const ASSESSMENT_INTEGRITY_CHECKS = [
  "canonical_assessment",
  "exact_criterion_coverage",
  "exact_evidence_indexes",
  "disposition_invariants",
  "exact_source_lineage",
  "latest_vera_pass",
  "signed_worker_evidence",
  "current_product_receipt",
  "no_actions_writes_tests_or_changes",
] as const;

export const AssessmentProductIntegrityV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.assessment-product-integrity.v1"),
    schema_version: Type.Literal(1),
    integrity_id: Type.String({ pattern: "^asir_[a-f0-9]{64}$" }),
    status: Type.Literal("PASS"),
    request_ref: ArtifactRefSchema,
    analysis_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    assessment_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    execution_receipt_ids: Type.Array(OpaqueIdSchema, {
      minItems: 3,
      maxItems: 12,
      uniqueItems: true,
    }),
    checks: Type.Array(
      Type.Union([
        Type.Literal("canonical_assessment"),
        Type.Literal("exact_criterion_coverage"),
        Type.Literal("exact_evidence_indexes"),
        Type.Literal("disposition_invariants"),
        Type.Literal("exact_source_lineage"),
        Type.Literal("latest_vera_pass"),
        Type.Literal("signed_worker_evidence"),
        Type.Literal("current_product_receipt"),
        Type.Literal("no_actions_writes_tests_or_changes"),
      ]),
      { minItems: 9, maxItems: 9, uniqueItems: true }
    ),
    external_actions_performed: Type.Literal(false),
    filesystem_writes_performed: Type.Literal(false),
    tests_executed: Type.Literal(false),
    changes_started: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type AssessmentProductIntegrityV1 = Readonly<
  Static<typeof AssessmentProductIntegrityV1Schema>
>;

export const AssessmentProductEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.assessment-product-envelope.v1"),
    schema_version: Type.Literal(1),
    envelope_id: Type.String({ pattern: "^asenv_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    status: Type.Literal("complete"),
    request_ref: ArtifactRefSchema,
    analysis_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    assessment_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    integrity_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type AssessmentProductEnvelopeV1 = Readonly<
  Static<typeof AssessmentProductEnvelopeV1Schema>
>;

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

function range(length: number): number[] {
  return Array.from({ length }, (_unused, index) => index);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertCanonicalIndexes(values: readonly number[], length: number, label: string): void {
  if (
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

function targetStatements(request: AssessmentRequestV1): readonly string[] {
  return typeof request.target === "string"
    ? [request.target]
    : request.target.map((item) => item.statement);
}

function validateRequestContent(request: AssessmentRequestV1): void {
  validateText(request.assessment_purpose, "AssessmentRequestV1.assessment_purpose", 16_384);
  for (const target of targetStatements(request)) {
    validateText(target, "AssessmentRequestV1 target statement", 32_768);
  }
  for (const criterion of request.criteria) {
    validateText(criterion.statement, "AssessmentRequestV1 criterion", 8_192);
  }
  for (const evidence of request.supplied_evidence) {
    validateText(evidence.statement, "AssessmentRequestV1 supplied evidence", 16_384);
    if (evidence.source_label !== undefined) {
      validateText(evidence.source_label, "AssessmentRequestV1 source label", 512, false);
    }
  }
  for (const group of [request.hard_constraints, request.non_goals, request.known_uncertainties]) {
    for (const item of group) {
      validateText(item.statement, "AssessmentRequestV1 statement", 8_192);
    }
  }
}

export function validateAssessmentRequest(value: unknown): AssessmentRequestV1 {
  const request = validateSkillSchema(AssessmentRequestV1Schema, value, "AssessmentRequestV1");
  validateRequestContent(request);
  return request;
}

export function canonicalizeAssessmentRequest(input: {
  readonly goal: string;
  readonly constraints: unknown;
}): AssessmentRequestV1 {
  validateText(input.goal, "AssessmentRequestV1 goal", 16_384);
  const constraints = validateSkillSchema(
    AssessmentRequestConstraintsV1Schema,
    input.constraints,
    "AssessmentRequestV1 start constraints"
  );
  return validateAssessmentRequest({
    schema_version: 1,
    assessment_purpose: input.goal,
    target: constraints.target,
    criteria: constraints.criteria,
    supplied_evidence: constraints.supplied_evidence,
    hard_constraints: constraints.hard_constraints,
    non_goals: constraints.non_goals,
    known_uncertainties: constraints.known_uncertainties,
  });
}

export function assessmentRequestConstraints(
  requestValue: unknown
): AssessmentRequestConstraintsV1 {
  const request = validateAssessmentRequest(requestValue);
  return {
    schema_version: 1,
    target: request.target,
    criteria: request.criteria,
    supplied_evidence: request.supplied_evidence,
    hard_constraints: request.hard_constraints,
    non_goals: request.non_goals,
    known_uncertainties: request.known_uncertainties,
  };
}

export function assessmentRequestSha256(value: unknown): string {
  return sha256(canonicalJson(validateAssessmentRequest(value)));
}

function validateDraftShape(value: unknown): AssessmentDraftV1 {
  const draft = validateSkillSchema(AssessmentDraftV1Schema, value, "AssessmentDraftV1");
  validateText(draft.summary, "AssessmentDraftV1.summary", 16_384);
  for (const outcome of draft.criterion_outcomes) {
    validateText(outcome.rationale, "AssessmentDraftV1 criterion rationale", 8_192);
  }
  for (const strength of draft.strengths) {
    validateText(strength.statement, "AssessmentDraftV1 strength", 8_192);
  }
  for (const gap of draft.gaps) {
    validateText(gap.statement, "AssessmentDraftV1 gap", 8_192);
  }
  for (const improvement of draft.improvement_suggestions) {
    validateText(improvement.suggestion, "AssessmentDraftV1 improvement", 8_192);
  }
  for (const statement of [...draft.assumptions, ...draft.uncertainties]) {
    validateText(statement, "AssessmentDraftV1 assumption or uncertainty", 8_192);
  }
  return draft;
}

function draftSemanticIssues(
  draft: AssessmentDraftV1,
  request: AssessmentRequestV1
): readonly string[] {
  const issues: string[] = [];
  const criterionCount = request.criteria.length;
  const evidenceCount = request.supplied_evidence.length;
  const outcomeIndexes = draft.criterion_outcomes.map((outcome) => outcome.criterion_index);
  if (!sameNumbers(outcomeIndexes, range(criterionCount))) {
    issues.push(
      "criterion_outcomes must contain every exact criterion index once in ascending order"
    );
  }
  for (const outcome of draft.criterion_outcomes) {
    try {
      assertCanonicalIndexes(
        outcome.supporting_evidence_indexes,
        evidenceCount,
        "supporting evidence indexes"
      );
      assertCanonicalIndexes(
        outcome.contradicting_evidence_indexes,
        evidenceCount,
        "contradicting evidence indexes"
      );
      const contradicting = new Set(outcome.contradicting_evidence_indexes);
      if (outcome.supporting_evidence_indexes.some((index) => contradicting.has(index))) {
        issues.push(`criterion ${outcome.criterion_index} evidence indexes overlap`);
      }
    } catch (error) {
      issues.push(
        error instanceof Error ? error.message : "criterion evidence indexes are invalid"
      );
    }
  }
  for (const [label, entries] of [
    ["strength", draft.strengths],
    ["gap", draft.gaps],
  ] as const) {
    for (const entry of entries) {
      try {
        assertCanonicalIndexes(
          entry.criterion_indexes,
          criterionCount,
          `${label} criterion indexes`
        );
        assertCanonicalIndexes(entry.evidence_indexes, evidenceCount, `${label} evidence indexes`);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : `${label} indexes are invalid`);
      }
    }
  }
  for (const improvement of draft.improvement_suggestions) {
    try {
      assertCanonicalIndexes(
        improvement.criterion_indexes,
        criterionCount,
        "improvement criterion indexes"
      );
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "improvement indexes are invalid");
    }
  }
  const coverage = draft.request_coverage;
  const coverageChecks = [
    [
      coverage.target_statement_indexes,
      targetStatements(request).length,
      "target_statement_indexes",
    ],
    [coverage.criterion_indexes, request.criteria.length, "criterion_indexes"],
    [
      coverage.supplied_evidence_indexes,
      request.supplied_evidence.length,
      "supplied_evidence_indexes",
    ],
    [coverage.hard_constraint_indexes, request.hard_constraints.length, "hard_constraint_indexes"],
    [coverage.non_goal_indexes, request.non_goals.length, "non_goal_indexes"],
    [
      coverage.known_uncertainty_indexes,
      request.known_uncertainties.length,
      "known_uncertainty_indexes",
    ],
  ] as const;
  for (const [actual, length, label] of coverageChecks) {
    if (!sameNumbers(actual, range(length))) {
      issues.push(`request_coverage.${label} must equal the complete exact request index set`);
    }
  }

  const requiredOutcomes = request.criteria.flatMap((criterion, index) => {
    const outcome = draft.criterion_outcomes[index];
    return criterion.importance === "required" && outcome !== undefined ? [outcome] : [];
  });
  const requiredNotMet = requiredOutcomes.some((outcome) => outcome.verdict === "not_met");
  const requiredNotAssessable = requiredOutcomes.some(
    (outcome) => outcome.verdict === "not_assessable"
  );
  const requiredPartiallyMet = requiredOutcomes.some(
    (outcome) => outcome.verdict === "partially_met"
  );
  const allRequiredMet = requiredOutcomes.every((outcome) => outcome.verdict === "met");
  const majorGap = draft.gaps.some((gap) => gap.severity === "major");

  switch (draft.disposition) {
    case "meets":
      if (!allRequiredMet || majorGap) {
        issues.push("meets requires every required criterion met and no major gap");
      }
      break;
    case "does_not_meet":
      if (!requiredNotMet) {
        issues.push("does_not_meet requires at least one required criterion not_met");
      }
      break;
    case "partially_meets":
      if (
        requiredOutcomes.length === 0 ||
        requiredNotMet ||
        requiredNotAssessable ||
        !requiredPartiallyMet
      ) {
        issues.push(
          "partially_meets requires assessable partial required outcomes without required not_met or not_assessable"
        );
      }
      break;
    case "inconclusive":
      if (requiredNotMet || !requiredNotAssessable || draft.uncertainties.length === 0) {
        issues.push(
          "inconclusive requires a required not_assessable outcome, no decisive required not_met, and explicit uncertainty"
        );
      }
      break;
    case "not_applicable":
      if (
        draft.criterion_outcomes.some((outcome) => outcome.verdict !== "not_assessable") ||
        draft.uncertainties.length === 0 ||
        draft.strengths.length > 0
      ) {
        issues.push(
          "not_applicable requires every criterion not_assessable, explicit inapplicability uncertainty, and no strengths"
        );
      }
      break;
  }
  return sanitizeIssues(issues);
}

export function validateAssessmentDraft(
  value: unknown,
  input: { readonly request: unknown }
): AssessmentDraftV1 {
  const request = validateAssessmentRequest(input.request);
  let draft: AssessmentDraftV1;
  try {
    draft = validateDraftShape(value);
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? sanitizeIssues(error.issues)
        : sanitizeIssues([
            error instanceof Error ? error.message : "closed schema validation failed",
          ]);
    throw new AssessmentDraftValidationError("SCHEMA_INVALID", issues);
  }
  const issues = draftSemanticIssues(draft, request);
  if (issues.length > 0) throw new AssessmentDraftValidationError("SEMANTIC_INVALID", issues);
  return draft;
}

const DRAFT_PREFIX = "ASSESSMENT_DRAFT:";
const SUMMARY_PREFIX = "SUMMARY:";

function parseExactSummary(value: string): AssessmentRoutingSummaryV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  try {
    const summary = validateSkillSchema(
      AssessmentRoutingSummaryV1Schema,
      parsed,
      "Assessment routing summary"
    );
    return `{"confidence":"${summary.confidence}","complete":true}` === value ? summary : undefined;
  } catch {
    return undefined;
  }
}

export function parsePersistedAssessmentDraft(
  bytes: Uint8Array,
  input: { readonly request: unknown }
): { readonly draft: AssessmentDraftV1; readonly summary: AssessmentRoutingSummaryV1 } {
  const body = Buffer.from(bytes);
  if (body.length === 0 || body.length > MAX_PERSISTED_ASSESSMENT_DRAFT_BYTES) {
    throw new AssessmentDraftValidationError("FRAMING_INVALID", [
      `AssessmentDraftV1 output must be 1..${MAX_PERSISTED_ASSESSMENT_DRAFT_BYTES} bytes`,
    ]);
  }
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    throw new AssessmentDraftValidationError("FRAMING_INVALID", ["AssessmentDraftV1 forbids BOM"]);
  }
  if (body.includes(0)) {
    throw new AssessmentDraftValidationError("FRAMING_INVALID", ["AssessmentDraftV1 forbids NUL"]);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new AssessmentDraftValidationError("FRAMING_INVALID", [
      "AssessmentDraftV1 is not strict UTF-8",
    ]);
  }
  if (text.includes("\ufeff") || text.includes("\r")) {
    throw new AssessmentDraftValidationError("FRAMING_INVALID", [
      "AssessmentDraftV1 forbids BOM and CR",
    ]);
  }
  const framed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = framed.split("\n");
  if (
    framed.endsWith("\n") ||
    lines.length !== 2 ||
    !lines[0]?.startsWith(DRAFT_PREFIX) ||
    !lines[1]?.startsWith(SUMMARY_PREFIX) ||
    lines.some((line) => line.trim() !== line || line.includes("`"))
  ) {
    throw new AssessmentDraftValidationError("FRAMING_INVALID", [
      "AssessmentDraftV1 requires exactly one unwrapped draft line and one compact SUMMARY line",
    ]);
  }
  const draftText = lines[0].slice(DRAFT_PREFIX.length);
  const summary = parseExactSummary(lines[1].slice(SUMMARY_PREFIX.length));
  if (draftText.length === 0 || summary === undefined) {
    throw new AssessmentDraftValidationError("FRAMING_INVALID", [
      "AssessmentDraftV1 draft or SUMMARY framing is invalid",
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(draftText);
  } catch {
    throw new AssessmentDraftValidationError("JSON_INVALID", ["AssessmentDraftV1 is not JSON"]);
  }
  const draft = validateAssessmentDraft(value, input);
  if (canonicalJson(draft) !== draftText) {
    throw new AssessmentDraftValidationError("FRAMING_INVALID", [
      "AssessmentDraftV1 must be canonical JSON",
    ]);
  }
  if (draft.confidence !== summary.confidence) {
    throw new AssessmentDraftValidationError("SEMANTIC_INVALID", [
      "AssessmentDraftV1 confidence must equal SUMMARY confidence",
    ]);
  }
  return { draft, summary };
}

export function assessmentDraftPromptContract(): string {
  return canonicalJson({
    schema: AssessmentDraftV1Schema,
    transport: {
      encoding: "strict UTF-8",
      maximum_output_bytes: MAX_PERSISTED_ASSESSMENT_DRAFT_BYTES,
      canonical_framing:
        "exactly ASSESSMENT_DRAFT:<canonical-single-line-JSON> then SUMMARY:<compact-JSON>",
      digest_and_id_authorship: "host only; the worker never calculates SHA-256 or IDs",
    },
    criterion_outcomes:
      "exactly one ascending outcome for every zero-based request criterion index; evidence indexes refer only to supplied_evidence",
    dispositions: {
      meets: "every required criterion met and no major gap",
      does_not_meet: "at least one required criterion not_met",
      partially_meets:
        "at least one required partially_met, all required assessable, and no required not_met",
      inconclusive:
        "at least one required not_assessable, no required not_met, and explicit uncertainty",
      not_applicable:
        "all criteria not_assessable because the target/criteria make assessment inapplicable, with explicit uncertainty and no strengths",
    },
    scoring: "numeric scores are forbidden",
    coverage: "every coverage array equals the complete ascending exact request index set",
    consequence_flags: {
      external_actions_performed: false,
      filesystem_writes_performed: false,
      tests_executed: false,
      changes_started: false,
    },
  });
}

function targetLineage(request: AssessmentRequestV1) {
  return targetStatements(request).map((statement, target_statement_index) => ({
    target_statement_index,
    statement_sha256: sha256(statement),
  }));
}

function criterionLineage(request: AssessmentRequestV1) {
  return request.criteria.map((criterion, criterion_index) => ({
    criterion_index,
    statement_sha256: sha256(criterion.statement),
    importance: criterion.importance,
  }));
}

function suppliedEvidenceLineage(request: AssessmentRequestV1) {
  return request.supplied_evidence.map((evidence, evidence_index) => ({
    evidence_index,
    statement_sha256: sha256(evidence.statement),
    source_label: evidence.source_label ?? null,
  }));
}

export function assessmentSourceLineageSha256(value: unknown): string {
  return sha256(
    canonicalJson(
      validateSkillSchema(
        AssessmentSourceLineagePreimageV1Schema,
        value,
        "AssessmentV1 source lineage preimage"
      )
    )
  );
}

function assertAssessmentSealRefs(input: {
  readonly requestRef: ArtifactRef;
  readonly analysisRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
}): void {
  const refs = [input.requestRef, input.analysisRef, input.draftRef];
  if (
    input.requestRef.kind !== "assessment-request" ||
    input.requestRef.phase !== "intake" ||
    input.requestRef.branch_id !== null ||
    input.requestRef.producer !== "host:request-admission" ||
    input.analysisRef.kind !== "agent-output" ||
    input.analysisRef.phase !== "analyzing_assessment" ||
    input.analysisRef.branch_id !== null ||
    input.analysisRef.producer !== "agent:annie" ||
    input.draftRef.kind !== "assessment-draft" ||
    input.draftRef.phase !== "authoring_assessment" ||
    input.draftRef.branch_id !== null ||
    input.draftRef.producer !== "agent:carren" ||
    input.draftRef.content_schema?.schema_id !== "penny.assessment-draft.v1" ||
    input.draftRef.content_schema.schema_version !== 1 ||
    new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length ||
    new Set(refs.map((ref) => ref.run_id)).size !== 1
  ) {
    throw new Error("AssessmentV1 sealing refs have invalid, stale, or cross-run roles");
  }
}

export function sealAssessmentDraft(input: {
  readonly request: unknown;
  readonly draft: unknown;
  readonly requestRef: ArtifactRef;
  readonly analysisRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
}): AssessmentV1 {
  const request = validateAssessmentRequest(input.request);
  const draft = validateAssessmentDraft(input.draft, { request });
  assertAssessmentSealRefs(input);
  const lineage: AssessmentSourceLineagePreimageV1 = {
    request_artifact_id: input.requestRef.artifact_id,
    request_artifact_sha256: input.requestRef.content_digest,
    analysis_artifact_id: input.analysisRef.artifact_id,
    analysis_artifact_sha256: input.analysisRef.content_digest,
    draft_artifact_id: input.draftRef.artifact_id,
    draft_artifact_sha256: input.draftRef.content_digest,
    draft_sha256: sha256(canonicalJson(draft)),
    target_statements: targetLineage(request),
    criteria: criterionLineage(request),
    supplied_evidence: suppliedEvidenceLineage(request),
  };
  return validateAssessment({
    schema_id: "penny.assessment.v1",
    ...draft,
    request,
    request_sha256: assessmentRequestSha256(request),
    source_lineage: { ...lineage, lineage_sha256: assessmentSourceLineageSha256(lineage) },
  });
}

function projectDraftUnchecked(assessment: AssessmentV1): AssessmentDraftV1 {
  return {
    schema_version: assessment.schema_version,
    disposition: assessment.disposition,
    criterion_outcomes: assessment.criterion_outcomes,
    summary: assessment.summary,
    strengths: assessment.strengths,
    gaps: assessment.gaps,
    improvement_suggestions: assessment.improvement_suggestions,
    assumptions: assessment.assumptions,
    uncertainties: assessment.uncertainties,
    request_coverage: assessment.request_coverage,
    confidence: assessment.confidence,
    external_actions_performed: assessment.external_actions_performed,
    filesystem_writes_performed: assessment.filesystem_writes_performed,
    tests_executed: assessment.tests_executed,
    changes_started: assessment.changes_started,
  };
}

export function validateAssessment(value: unknown): AssessmentV1 {
  const assessment = validateSkillSchema(AssessmentV1Schema, value, "AssessmentV1");
  const request = validateAssessmentRequest(assessment.request);
  if (assessment.request_sha256 !== assessmentRequestSha256(request)) {
    throw new Error("AssessmentV1 request digest drifted");
  }
  const draft = validateAssessmentDraft(projectDraftUnchecked(assessment), { request });
  const lineage: AssessmentSourceLineagePreimageV1 = {
    request_artifact_id: assessment.source_lineage.request_artifact_id,
    request_artifact_sha256: assessment.source_lineage.request_artifact_sha256,
    analysis_artifact_id: assessment.source_lineage.analysis_artifact_id,
    analysis_artifact_sha256: assessment.source_lineage.analysis_artifact_sha256,
    draft_artifact_id: assessment.source_lineage.draft_artifact_id,
    draft_artifact_sha256: assessment.source_lineage.draft_artifact_sha256,
    draft_sha256: assessment.source_lineage.draft_sha256,
    target_statements: assessment.source_lineage.target_statements,
    criteria: assessment.source_lineage.criteria,
    supplied_evidence: assessment.source_lineage.supplied_evidence,
  };
  if (assessment.source_lineage.lineage_sha256 !== assessmentSourceLineageSha256(lineage)) {
    throw new Error("AssessmentV1 source lineage digest drifted");
  }
  assertUnique(
    [lineage.request_artifact_id, lineage.analysis_artifact_id, lineage.draft_artifact_id],
    "AssessmentV1 source lineage artifact IDs"
  );
  if (
    lineage.draft_sha256 !== sha256(canonicalJson(draft)) ||
    canonicalJson(lineage.target_statements) !== canonicalJson(targetLineage(request)) ||
    canonicalJson(lineage.criteria) !== canonicalJson(criterionLineage(request)) ||
    canonicalJson(lineage.supplied_evidence) !== canonicalJson(suppliedEvidenceLineage(request))
  ) {
    throw new Error("AssessmentV1 draft, target, criterion, or supplied-evidence lineage drifted");
  }
  return assessment;
}

export function assertAssessmentLineage(input: {
  readonly assessment: unknown;
  readonly request: unknown;
  readonly draft: unknown;
  readonly requestRef: ArtifactRef;
  readonly analysisRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
}): AssessmentV1 {
  const expected = sealAssessmentDraft(input);
  const assessment = validateAssessment(input.assessment);
  if (canonicalJson(assessment) !== canonicalJson(expected)) {
    throw new Error("AssessmentV1 exact request, analysis, draft, or source lineage diverged");
  }
  return assessment;
}

export function validateCanonicalAssessmentBytes(
  bytes: Uint8Array,
  ref: ArtifactRef
): AssessmentV1 {
  const body = Buffer.from(bytes);
  if (
    ref.kind !== "semantic-core" ||
    ref.phase !== "sealing_assessment" ||
    ref.branch_id !== null ||
    ref.producer !== "host:assessment-sealer" ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== "penny.assessment.v1" ||
    ref.content_schema.schema_version !== 1 ||
    ref.byte_length !== body.length ||
    ref.content_digest !== sha256(body) ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  ) {
    throw new Error("AssessmentV1 ref is stale or has the wrong semantic identity");
  }
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("AssessmentV1 artifact is not JSON");
  }
  const assessment = validateAssessment(value);
  if (canonicalJson(assessment) !== body.toString("utf8")) {
    throw new Error("AssessmentV1 artifact bytes are not canonical JSON");
  }
  return assessment;
}

export function validateAssessmentSealFeedback(value: unknown): AssessmentSealFeedbackV1 {
  const feedback = validateSkillSchema(
    AssessmentSealFeedbackV1Schema,
    value,
    "AssessmentSealFeedbackV1"
  );
  for (const issue of feedback.issues) validateText(issue, "Assessment seal issue", 512, false);
  return feedback;
}

function assertDerived(value: string, prefix: string, body: unknown, label: string): void {
  if (value !== `${prefix}${sha256(canonicalJson(body))}`) {
    throw new SkillSchemaValidationError(label, ["derived ID does not match canonical body"]);
  }
}

function assertCurrentSubjectRefs(input: {
  readonly runId: string;
  readonly requestRef: ArtifactRef;
  readonly analysisRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
  readonly assessmentRef: ArtifactRef;
}): void {
  const refs = [input.requestRef, input.analysisRef, input.draftRef, input.assessmentRef];
  if (
    refs.some((ref) => ref.run_id !== input.runId || ref.branch_id !== null) ||
    input.requestRef.kind !== "assessment-request" ||
    input.requestRef.phase !== "intake" ||
    input.requestRef.producer !== "host:request-admission" ||
    input.analysisRef.kind !== "agent-output" ||
    input.analysisRef.phase !== "analyzing_assessment" ||
    input.analysisRef.producer !== "agent:annie" ||
    input.draftRef.kind !== "assessment-draft" ||
    input.draftRef.phase !== "authoring_assessment" ||
    input.draftRef.producer !== "agent:carren" ||
    input.assessmentRef.kind !== "semantic-core" ||
    input.assessmentRef.phase !== "sealing_assessment" ||
    input.assessmentRef.producer !== "host:assessment-sealer" ||
    input.assessmentRef.content_schema?.schema_id !== "penny.assessment.v1" ||
    input.assessmentRef.content_schema.schema_version !== 1 ||
    new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length
  ) {
    throw new Error("Assessment current-product subject refs disagree");
  }
}

export function assessmentValidityReceiptId(
  body: Omit<AssessmentValidityReceiptV1, "receipt_id">
): `asvr_${string}` {
  return `asvr_${sha256(canonicalJson(body))}`;
}

export function validateAssessmentValidityReceipt(value: unknown): AssessmentValidityReceiptV1 {
  const receipt = validateSkillSchema(
    AssessmentValidityReceiptV1Schema,
    value,
    "AssessmentValidityReceiptV1"
  );
  assertOpaqueId(receipt.run_id, "AssessmentValidityReceiptV1.run_id");
  assertRfc3339Utc(receipt.created_at, "AssessmentValidityReceiptV1.created_at");
  assertCurrentSubjectRefs({
    runId: receipt.run_id,
    requestRef: receipt.request_ref,
    analysisRef: receipt.analysis_ref,
    draftRef: receipt.draft_ref,
    assessmentRef: receipt.assessment_ref,
  });
  if (
    receipt.vera_report_ref.run_id !== receipt.run_id ||
    receipt.vera_report_ref.kind !== "agent-output" ||
    receipt.vera_report_ref.phase !== "verifying_assessment" ||
    receipt.vera_report_ref.producer !== "agent:vera" ||
    receipt.vera_report_ref.branch_id !== null
  ) {
    throw new Error("AssessmentValidityReceiptV1 Vera report role disagrees");
  }
  const { receipt_id: receiptId, ...body } = receipt;
  assertDerived(receiptId, "asvr_", body, "AssessmentValidityReceiptV1");
  return receipt;
}

export function assessmentProductIntegrityId(
  body: Omit<AssessmentProductIntegrityV1, "integrity_id">
): `asir_${string}` {
  return `asir_${sha256(canonicalJson(body))}`;
}

export function validateAssessmentProductIntegrity(value: unknown): AssessmentProductIntegrityV1 {
  const integrity = validateSkillSchema(
    AssessmentProductIntegrityV1Schema,
    value,
    "AssessmentProductIntegrityV1"
  );
  if (canonicalJson(integrity.checks) !== canonicalJson(ASSESSMENT_INTEGRITY_CHECKS)) {
    throw new Error("AssessmentProductIntegrityV1 checks are incomplete or reordered");
  }
  const runId = integrity.assessment_ref.run_id;
  assertCurrentSubjectRefs({
    runId,
    requestRef: integrity.request_ref,
    analysisRef: integrity.analysis_ref,
    draftRef: integrity.draft_ref,
    assessmentRef: integrity.assessment_ref,
  });
  const refs = [
    integrity.request_ref,
    integrity.analysis_ref,
    integrity.draft_ref,
    integrity.assessment_ref,
    integrity.vera_report_ref,
    integrity.validity_receipt_ref,
  ];
  if (
    refs.some((ref) => ref.run_id !== runId) ||
    new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length ||
    integrity.vera_report_ref.kind !== "agent-output" ||
    integrity.vera_report_ref.phase !== "verifying_assessment" ||
    integrity.vera_report_ref.producer !== "agent:vera" ||
    integrity.vera_report_ref.branch_id !== null ||
    integrity.validity_receipt_ref.kind !== "assessment-validity-receipt" ||
    integrity.validity_receipt_ref.phase !== "admitting_assessment" ||
    integrity.validity_receipt_ref.branch_id !== "validity" ||
    integrity.validity_receipt_ref.producer !== "host:assessment-validity-authority"
  ) {
    throw new Error("AssessmentProductIntegrityV1 exact artifact roles disagree");
  }
  const { integrity_id: integrityId, ...body } = integrity;
  assertDerived(integrityId, "asir_", body, "AssessmentProductIntegrityV1");
  return integrity;
}

export function assessmentProductEnvelopeId(
  body: Omit<AssessmentProductEnvelopeV1, "envelope_id">
): `asenv_${string}` {
  return `asenv_${sha256(canonicalJson(body))}`;
}

export function validateAssessmentProductEnvelope(value: unknown): AssessmentProductEnvelopeV1 {
  const envelope = validateSkillSchema(
    AssessmentProductEnvelopeV1Schema,
    value,
    "AssessmentProductEnvelopeV1"
  );
  assertOpaqueId(envelope.run_id, "AssessmentProductEnvelopeV1.run_id");
  assertCurrentSubjectRefs({
    runId: envelope.run_id,
    requestRef: envelope.request_ref,
    analysisRef: envelope.analysis_ref,
    draftRef: envelope.draft_ref,
    assessmentRef: envelope.assessment_ref,
  });
  const refs = [
    envelope.request_ref,
    envelope.analysis_ref,
    envelope.draft_ref,
    envelope.assessment_ref,
    envelope.vera_report_ref,
    envelope.validity_receipt_ref,
    envelope.integrity_ref,
  ];
  if (
    refs.some((ref) => ref.run_id !== envelope.run_id) ||
    new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length ||
    envelope.vera_report_ref.kind !== "agent-output" ||
    envelope.vera_report_ref.phase !== "verifying_assessment" ||
    envelope.vera_report_ref.producer !== "agent:vera" ||
    envelope.validity_receipt_ref.kind !== "assessment-validity-receipt" ||
    envelope.validity_receipt_ref.phase !== "admitting_assessment" ||
    envelope.validity_receipt_ref.branch_id !== "validity" ||
    envelope.integrity_ref.kind !== "assessment-product-integrity" ||
    envelope.integrity_ref.phase !== "admitting_assessment" ||
    envelope.integrity_ref.branch_id !== "integrity" ||
    envelope.integrity_ref.producer !== "host:assessment-product-validator"
  ) {
    throw new Error("AssessmentProductEnvelopeV1 exact artifact roles disagree");
  }
  const { envelope_id: envelopeId, ...body } = envelope;
  assertDerived(envelopeId, "asenv_", body, "AssessmentProductEnvelopeV1");
  return envelope;
}
