import { Type, type Static } from "typebox";
import { ArtifactRefSchema, validateContract } from "../contracts.js";

const text = Type.String({ minLength: 1, maxLength: 16_384 });
const id = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const list = Type.Array(text, { maxItems: 128 });
export const ScaToolPathSchema = Type.Object(
  {
    executable: Type.String({ minLength: 1, maxLength: 4096 }),
    sha256: digest,
    version: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false }
);
const rule = Type.Object(
  {
    tool: ScaToolPathSchema,
    rules_path: Type.String({ minLength: 1, maxLength: 4096 }),
    rules_sha256: digest,
  },
  { additionalProperties: false }
);
export const ScaAnalysisToolsSchema = Type.Object(
  {
    semgrep: Type.Optional(rule),
    gitleaks: Type.Optional(rule),
    advisory_results: Type.Optional(
      Type.Object(
        { path: Type.String({ minLength: 1, maxLength: 4096 }), sha256: digest },
        { additionalProperties: false }
      )
    ),
    graph: Type.Optional(
      Type.Object(
        {
          php_frontend: Type.Optional(ScaToolPathSchema),
          js_frontend: Type.Optional(ScaToolPathSchema),
          joern: ScaToolPathSchema,
          queries: Type.Array(
            Type.Object(
              {
                id,
                script_path: Type.String({ minLength: 1, maxLength: 4096 }),
                sha256: digest,
              },
              { additionalProperties: false }
            ),
            { minItems: 1, maxItems: 16 }
          ),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);
export type ScaAnalysisTools = Static<typeof ScaAnalysisToolsSchema>;
export const ScaPointerSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    start_line: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    end_line: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    exact_quote: text,
  },
  { additionalProperties: false }
);
export type ScaPointer = Static<typeof ScaPointerSchema>;
const range = Type.Object(
  {
    path: ScaPointerSchema.properties.path,
    start_line: ScaPointerSchema.properties.start_line,
    end_line: ScaPointerSchema.properties.end_line,
  },
  { additionalProperties: false }
);
export const ScaLeadSchema = Type.Object(
  {
    id,
    origin: Type.Union([
      Type.Literal("semgrep"),
      Type.Literal("gitleaks"),
      Type.Literal("dependency"),
      Type.Literal("advisory"),
      Type.Literal("graph"),
    ]),
    title: text,
    locations: Type.Array(range, { maxItems: 32 }),
    evidence_sha256: digest,
  },
  { additionalProperties: false }
);
export type ScaLead = Static<typeof ScaLeadSchema>;
export const ScaCapabilitySchema = Type.Object(
  {
    id,
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("unavailable"),
      Type.Literal("unsupported"),
      Type.Literal("failed"),
      Type.Literal("partial"),
    ]),
    detail: text,
    version: Type.Union([text, Type.Null()]),
    configuration_sha256: Type.Union([digest, Type.Null()]),
    evidence_sha256: Type.Union([digest, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ScaCapability = Static<typeof ScaCapabilitySchema>;
export const ScaPreparationSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    source_snapshot_sha256: digest,
    capabilities: Type.Array(ScaCapabilitySchema, { minItems: 1, maxItems: 64 }),
    files: Type.Array(
      Type.Object(
        { path: text, content_sha256: digest, lines: Type.Integer({ minimum: 0 }), language: text },
        { additionalProperties: false }
      ),
      { maxItems: 100_000 }
    ),
    leads: Type.Array(ScaLeadSchema, { maxItems: 512 }),
    gaps: list,
  },
  { additionalProperties: false }
);
export type ScaPreparation = Static<typeof ScaPreparationSchema>;
export const ScaSelectionSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    selections: Type.Array(
      Type.Object(
        {
          id,
          lead_ids: Type.Array(id, { maxItems: 32 }),
          rationale: text,
          ranges: Type.Array(range, { minItems: 1, maxItems: 16 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 32 }
    ),
    deferred: Type.Array(Type.Object({ id: text, reason: text }, { additionalProperties: false }), {
      maxItems: 512,
    }),
    gaps: list,
  },
  { additionalProperties: false }
);
export type ScaSelection = Static<typeof ScaSelectionSchema>;
/** Worker-only shorthand. Canonical selections retain exhaustive per-ID deferrals. */
export const ScaSelectionDraftSchema = Type.Object(
  {
    ...ScaSelectionSchema.properties,
    defer_remainder: Type.Optional(
      Type.Object(
        {
          preparation_artifact_id: ArtifactRefSchema.properties.artifact_id,
          preparation_sha256: digest,
          scope: Type.Union([Type.Literal("leads"), Type.Literal("files")]),
          reason: text,
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);
export type ScaSelectionDraft = Static<typeof ScaSelectionDraftSchema>;
export const ScaHypothesesSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    hypotheses: Type.Array(
      Type.Object(
        {
          id,
          selection_ids: Type.Array(id, { minItems: 1, maxItems: 64 }),
          claim: text,
          violated_invariant: text,
          threat_id: Type.String({ pattern: "^\\{[A-Z][A-Z0-9_-]*\\}$" }),
          support: Type.Array(ScaPointerSchema, { minItems: 1, maxItems: 32 }),
          refutation_test: text,
          expected_support: text,
          expected_refutation: text,
          unknowns: list,
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    unformed: Type.Array(
      Type.Object({ selection_id: id, reason: text }, { additionalProperties: false }),
      { maxItems: 64 }
    ),
    gaps: list,
  },
  { additionalProperties: false }
);
export type ScaHypotheses = Static<typeof ScaHypothesesSchema>;
export const ScaChallengeSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    challenges: Type.Array(
      Type.Object(
        {
          hypothesis_id: id,
          alternative: text,
          counterevidence: Type.Array(ScaPointerSchema, { maxItems: 32 }),
          missing: list,
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    gaps: list,
  },
  { additionalProperties: false }
);
export const ScaActionsSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    actions: Type.Array(
      Type.Object(
        {
          id,
          hypothesis_id: id,
          kind: Type.Union([
            Type.Literal("source"),
            Type.Literal("graph"),
            Type.Literal("application_test"),
            Type.Literal("defer"),
          ]),
          ranges: Type.Array(range, { maxItems: 16 }),
          query_id: Type.Union([id, Type.Null()]),
          application_plan_id: Type.Optional(id),
          rationale: text,
          discriminating_observation: text,
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    gaps: list,
  },
  { additionalProperties: false }
);
export type ScaActions = Static<typeof ScaActionsSchema>;
export const ScaEvidenceSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    results: Type.Array(
      Type.Object(
        {
          action_id: id,
          hypothesis_id: id,
          status: Type.Union([
            Type.Literal("completed"),
            Type.Literal("unavailable"),
            Type.Literal("failed"),
            Type.Literal("deferred"),
          ]),
          detail: text,
          pointers: Type.Array(ScaPointerSchema, { maxItems: 64 }),
          observation: Type.String({ maxLength: 1_048_576 }),
          evidence_sha256: digest,
          execution: Type.Union([
            Type.Literal("NOT RUN"),
            Type.Literal("RUN"),
            Type.Literal("UNKNOWN"),
          ]),
          receipt_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    gaps: list,
  },
  { additionalProperties: false }
);
export type ScaEvidence = Static<typeof ScaEvidenceSchema>;
export const ScaDispositionsSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    dispositions: Type.Array(
      Type.Object(
        {
          hypothesis_id: id,
          disposition: Type.Union([
            Type.Literal("confirmed_code"),
            Type.Literal("refuted"),
            Type.Literal("probable"),
            Type.Literal("theoretical"),
            Type.Literal("duplicate"),
            Type.Literal("out_of_scope"),
            Type.Literal("inconclusive"),
          ]),
          duplicate_of: Type.Union([id, Type.Null()]),
          reason: text,
          evidence: Type.Array(ScaPointerSchema, { maxItems: 64 }),
          counterevidence: Type.Array(ScaPointerSchema, { maxItems: 64 }),
          action_ids: Type.Array(id, { maxItems: 64 }),
          gaps: list,
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    gaps: list,
  },
  { additionalProperties: false }
);
export type ScaDispositions = Static<typeof ScaDispositionsSchema>;
export const ScaLearningSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    outcomes: Type.Array(
      Type.Object(
        {
          hypothesis_id: id,
          validation_id: Type.Optional(id),
          status: Type.Union([
            Type.Literal("not_feasible"),
            Type.Literal("deferred"),
            Type.Literal("quarantined"),
          ]),
          reason: text,
          proposed_rule: Type.Union([text, Type.Null()]),
          positive_test: Type.Union([text, Type.Null()]),
          negative_test: Type.Union([text, Type.Null()]),
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    no_eligible_findings_reason: Type.Union([text, Type.Null()]),
    baseline_unchanged: Type.Literal(true),
    promotion_performed: Type.Literal(false),
    rescan: Type.Literal("not_run"),
    gaps: list,
  },
  { additionalProperties: false }
);
export type ScaLearning = Static<typeof ScaLearningSchema>;
export const ScaReportDraftSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    executive_summary: text,
    findings: Type.Array(
      Type.Object(
        {
          hypothesis_id: id,
          title: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\r\\n]+$" }),
          cwe_id: Type.Union([Type.String({ pattern: "^CWE-[1-9][0-9]*$" }), Type.Null()]),
          cwe_name: Type.Union([text, Type.Null()]),
          description: text,
          prerequisites: list,
          reproduction: list,
          reproduction_gaps: list,
          code_analysis: Type.Array(
            Type.Object(
              { explanation: text, pointer: ScaPointerSchema },
              { additionalProperties: false }
            ),
            { maxItems: 64 }
          ),
          remediation: text,
          regression_tests: list,
          compatibility_risks: text,
          cvss_vector: Type.Union([text, Type.Null()]),
          scoring_rationale: text,
          metric_evidence: Type.Array(
            Type.Object(
              {
                metric: Type.String({ minLength: 1, maxLength: 8 }),
                rationale: text,
                evidence: Type.Array(ScaPointerSchema, { minItems: 1, maxItems: 8 }),
              },
              { additionalProperties: false }
            ),
            { maxItems: 64 }
          ),
          missing_metrics: list,
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    chains: Type.Array(
      Type.Object(
        {
          hypothesis_ids: Type.Array(id, { minItems: 2, maxItems: 64 }),
          established_composition: text,
          evidence: Type.Array(ScaPointerSchema, { minItems: 1, maxItems: 32 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 32 }
    ),
    gaps: list,
  },
  { additionalProperties: false }
);
export type ScaReportDraft = Static<typeof ScaReportDraftSchema>;
export const ScaReviewSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    report_artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
    report_sha256: digest,
    verdict: Type.Union([Type.Literal("PASS"), Type.Literal("GAP")]),
    checked_evidence_ids: Type.Array(Type.String({ pattern: "^art_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 128,
    }),
    claim_support: Type.Boolean(),
    counterevidence_addressed: Type.Boolean(),
    execution_truth: Type.Boolean(),
    scoring_semantics: Type.Boolean(),
    redaction: Type.Boolean(),
    report_quality: Type.Boolean(),
    issues: list,
  },
  { additionalProperties: false }
);
export type ScaReview = Static<typeof ScaReviewSchema>;
const reviewCheckSchema = Type.Union([
  Type.Literal("claim_support"),
  Type.Literal("counterevidence_addressed"),
  Type.Literal("execution_truth"),
  Type.Literal("scoring_semantics"),
  Type.Literal("redaction"),
  Type.Literal("report_quality"),
]);
const reviewChecks = reviewCheckSchema.anyOf.map((check) => check.const);
const reviewConsistencyRule =
  "PASS iff all six checks are true and issues is empty; otherwise GAP. Reassess the exact inputs without suppressing supported defects or forcing PASS.";
export const ScaReviewConsistencySchema = Type.Object(
  {
    rule: Type.Literal(reviewConsistencyRule),
    verdict: ScaReviewSchema.properties.verdict,
    failed_checks: Type.Array(reviewCheckSchema, {
      maxItems: reviewChecks.length,
      uniqueItems: true,
    }),
    issue_count: Type.Integer({ minimum: 0, maximum: 128 }),
  },
  { additionalProperties: false }
);
/** Cross-field rejection only; schema errors and exact artifact binding remain distinct. */
export class ScaReviewConsistencyError extends Error {
  readonly consistency: Static<typeof ScaReviewConsistencySchema>;
  constructor(review: ScaReview) {
    super("SCA review verdict contradicts its checks/issues");
    this.consistency = {
      rule: reviewConsistencyRule,
      verdict: review.verdict,
      failed_checks: reviewChecks.filter((field) => !review[field]),
      issue_count: review.issues.length,
    };
  }
}
export function parseScaReview(value: unknown): ScaReview {
  const review = validateContract(ScaReviewSchema, value, "SCA review");
  if (
    (review.verdict === "PASS") !==
    (reviewChecks.every((field) => review[field]) && review.issues.length === 0)
  )
    throw new ScaReviewConsistencyError(review);
  return review;
}

/** Closed inert candidate grammar, mirrored from the native learning boundary. */
export const ScaCandidateRuleSchema = Type.Object(
  {
    rules: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 256 }),
          languages: Type.Array(Type.String(), { minItems: 1, maxItems: 1 }),
          message: Type.String({ minLength: 1, maxLength: 16384 }),
          severity: Type.Union([
            Type.Literal("INFO"),
            Type.Literal("WARNING"),
            Type.Literal("ERROR"),
          ]),
          pattern: Type.String({ minLength: 1, maxLength: 65536 }),
          metadata: Type.Optional(
            Type.Object(
              {
                category: Type.String({ minLength: 1, maxLength: 64 }),
                technology: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
                  minItems: 1,
                  maxItems: 32,
                }),
              },
              { additionalProperties: false }
            )
          ),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 1 }
    ),
  },
  { additionalProperties: false }
);
