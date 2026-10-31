import { Type, type Static } from "typebox";
import {
  ScaPointerSchema,
  ScaToolPathSchema,
} from "../../orchestration/dist/sca/ordinary-contracts.js";
import { ScaProcessRequestV1Schema, ScaProcessResultV1Schema } from "./process.js";

const closed = { additionalProperties: false } as const;
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const text = Type.String({ minLength: 1, maxLength: 16384 });
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" });
const filePath = Type.String({ minLength: 1, maxLength: 4096 });
const lines = Type.Array(Type.Integer({ minimum: 1, maximum: 1000000 }), {
  maxItems: 4096,
});
const status = Type.Union([
  Type.Literal("validated"),
  Type.Literal("quarantined"),
  Type.Literal("not_feasible"),
  Type.Literal("denied"),
  Type.Literal("failed"),
]);
export const ScaRuleLearningLimitsSchema = Type.Object(
  {
    inactivity_ms: Type.Integer({ minimum: 1, maximum: 5400000 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
    max_file_bytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
    max_input_bytes: Type.Integer({ minimum: 1, maximum: 67108864 }),
    max_memory_mb: Type.Integer({ minimum: 1, maximum: 65536 }),
    max_processes: Type.Integer({ minimum: 1, maximum: 513 }),
    performance_bound_ms: Type.Integer({ minimum: 1, maximum: 5400000 }),
  },
  closed
);
export const ScaRuleLearningFixtureSchema = Type.Object(
  {
    id,
    case_class: Type.Union([
      Type.Literal("vulnerable"),
      Type.Literal("fixed"),
      Type.Literal("negative_neighbor"),
      Type.Literal("benign"),
      Type.Literal("generalized"),
      Type.Literal("retained_vulnerable"),
      Type.Literal("held_out"),
      Type.Literal("broader_regression"),
      Type.Literal("performance"),
    ]),
    file_name: Type.String({
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*\\.(php|js|ts)$",
      maxLength: 256,
    }),
    content_base64: Type.String({ minLength: 1, maxLength: 1398104 }),
    content_sha256: digest,
    // Native --test omits negative-only checks. A separate declared positive control makes
    // a skipped test observable; independent scans must still prove every negative assertion.
    control_lines: lines,
    baseline_matches: Type.Array(
      Type.Object({ rule_id: id, line: Type.Integer({ minimum: 1, maximum: 1000000 }) }, closed),
      { maxItems: 4096 }
    ),
    assertions: Type.Array(
      Type.Object(
        {
          line: Type.Integer({ minimum: 1, maximum: 1000000 }),
          match: Type.Boolean(),
        },
        closed
      ),
      { minItems: 1, maxItems: 4096 }
    ),
  },
  closed
);
/** Required for any validated/promotable candidate; optional on the wire for legacy diagnostic
 * requests and no-rule assessments. Host approves the ENTIRE nonempty pinned bundle, not a subset.
 * No implicit acquisition or alternate toolchain. */
export const ScaRuleLearningOfflineValidationSchema = Type.Object(
  {
    python: ScaToolPathSchema,
    core: ScaToolPathSchema,
    core_library_directory: Type.Optional(filePath),
    metachecks: Type.Object(
      {
        rules_path: filePath,
        rules_sha256: digest,
        rule_ids: Type.Array(id, { minItems: 1, maxItems: 256, uniqueItems: true }),
      },
      closed
    ),
  },
  closed
);
export type ScaRuleLearningOfflineValidation = Static<
  typeof ScaRuleLearningOfflineValidationSchema
>;
export const ScaRuleLearningRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: id,
    source_snapshot_sha256: digest,
    source_corpus_sha256: digest,
    reconciliation_sha256: digest,
    hypothesis_sha256: digest,
    disposition_sha256: digest,
    evidence_sha256: digest,
    hypothesis_id: id,
    root_cause: text,
    evidence_pointers: Type.Array(ScaPointerSchema, {
      minItems: 1,
      maxItems: 64,
    }),
    baseline: Type.Object(
      {
        release_sha256: digest,
        rules_path: filePath,
        rules_sha256: digest,
        rule_ids: Type.Array(id, { maxItems: 256, uniqueItems: true }),
      },
      closed
    ),
    tool: ScaToolPathSchema,
    offline_validation: Type.Optional(ScaRuleLearningOfflineValidationSchema),
    candidate: Type.Union([
      Type.Object(
        {
          rule_id: id,
          language: Type.Union([
            Type.Literal("php"),
            Type.Literal("javascript"),
            Type.Literal("typescript"),
          ]),
          rules_path: filePath,
          rules_sha256: digest,
        },
        closed
      ),
      Type.Null(),
    ]),
    no_rule_reason: Type.Union([text, Type.Null()]),
    fixtures: Type.Array(ScaRuleLearningFixtureSchema, { maxItems: 256 }),
    fixture_truth_sha256: digest,
    limits: ScaRuleLearningLimitsSchema,
  },
  closed
);
export type ScaRuleLearningRequest = Static<typeof ScaRuleLearningRequestSchema>;
export const ScaRuleLearningHostAdmissionSchema = Type.Object(
  {
    request_sha256: digest,
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    // Issued only by the trusted host after checking exact reconciliation, confirmed eligible
    // hypothesis/evidence and independently reviewed fixture truth. A model cannot issue this.
    reconciliation_sha256: digest,
    hypothesis_sha256: digest,
    disposition_sha256: digest,
    evidence_sha256: digest,
    fixture_truth_sha256: digest,
    reason: text,
  },
  closed
);
export type ScaRuleLearningHostAdmission = Static<typeof ScaRuleLearningHostAdmissionSchema>;
export const ScaRuleLearningProcessReceiptSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("validate"),
      Type.Literal("validate_schema"),
      Type.Literal("test"),
      Type.Literal("scan"),
      Type.Literal("rescan"),
    ]),
    fixture_id: Type.Union([id, Type.Null()]),
    workspace_path: filePath,
    request_sha256: digest,
    started_at: Type.String({ minLength: 1, maxLength: 64 }),
    finished_at: Type.String({ minLength: 1, maxLength: 64 }),
    elapsed_ms: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    invocation: ScaProcessRequestV1Schema,
    result: ScaProcessResultV1Schema,
  },
  closed
);
export type ScaRuleLearningProcessReceipt = Static<typeof ScaRuleLearningProcessReceiptSchema>;
export const ScaRuleLearningResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    request_sha256: digest,
    status,
    reasons: Type.Array(text, { minItems: 1, maxItems: 512 }),
    baseline_unchanged: Type.Boolean(),
    validation_passed: Type.Boolean(),
    cases: Type.Array(
      Type.Object(
        {
          fixture_id: id,
          case_class: ScaRuleLearningFixtureSchema.properties.case_class,
          status: Type.Union([
            Type.Literal("passed"),
            Type.Literal("failed"),
            Type.Literal("unrun"),
          ]),
          test_passed: Type.Boolean(),
          scan_complete: Type.Boolean(),
          baseline_matches_passed: Type.Boolean(),
          assertions: Type.Array(
            Type.Object(
              {
                line: Type.Integer({ minimum: 1 }),
                expected: Type.Boolean(),
                observed: Type.Union([Type.Boolean(), Type.Null()]),
              },
              closed
            ),
            { maxItems: 4096 }
          ),
          unexpected_lines: lines,
          elapsed_ms: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
        },
        closed
      ),
      { maxItems: 256 }
    ),
    elapsed_ms: Type.Number({ minimum: 0 }),
    performance_passed: Type.Boolean(),
    private_receipts_sha256: digest,
    result_sha256: digest,
  },
  closed
);
export type ScaRuleLearningResult = Static<typeof ScaRuleLearningResultSchema>;
export const ScaRuleLearningRecordSchema = Type.Object(
  {
    request: ScaRuleLearningRequestSchema,
    result: ScaRuleLearningResultSchema,
    admission: ScaRuleLearningHostAdmissionSchema,
    receipts: Type.Array(ScaRuleLearningProcessReceiptSchema, {
      maxItems: 513,
    }),
  },
  closed
);
export type ScaRuleLearningRecord = Static<typeof ScaRuleLearningRecordSchema>;
export const ScaRulePromotionRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: id,
    validation_sha256: digest,
    namespace: filePath,
    predecessor_release_sha256: digest,
    successor_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    authority: Type.Object(
      {
        decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
        authority_sha256: digest,
        explicit_caller_authority: Type.Literal(true),
      },
      closed
    ),
  },
  closed
);
export type ScaRulePromotionRequest = Static<typeof ScaRulePromotionRequestSchema>;
export const ScaLearnedRuleReleaseSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("ordinary-sca-learned-rule-release"),
    request_sha256: digest,
    validation_sha256: digest,
    private_receipts_sha256: digest,
    source_snapshot_sha256: digest,
    source_corpus_sha256: digest,
    reconciliation_sha256: digest,
    hypothesis_sha256: digest,
    fixture_truth_sha256: digest,
    predecessor_release_sha256: digest,
    predecessor_rules_sha256: digest,
    retained_rule_content_base64: Type.String({ minLength: 1, maxLength: 1398104 }),
    retained_rule_sha256: digest,
    retained_rule_ids: Type.Array(id, { maxItems: 256, uniqueItems: true }),
    successor_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    tool: ScaToolPathSchema,
    offline_validation: Type.Optional(ScaRuleLearningOfflineValidationSchema),
    rule_id: id,
    language: Type.Union([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    rule_content_base64: Type.String({ minLength: 1, maxLength: 1398104 }),
    rule_sha256: digest,
    authority_sha256: digest,
    future_only: Type.Literal(true),
    immutable: Type.Literal(true),
    restored_from_release_sha256: Type.Optional(digest),
  },
  closed
);
export type ScaLearnedRuleRelease = Static<typeof ScaLearnedRuleReleaseSchema>;
export const ScaRulePromotionResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("promoted"),
      Type.Literal("adopted"),
      Type.Literal("conflict"),
      Type.Literal("denied"),
      Type.Literal("failed"),
    ]),
    request_sha256: digest,
    reason: text,
    release_path: Type.Union([filePath, Type.Null()]),
    release_sha256: Type.Union([digest, Type.Null()]),
    baseline_unchanged: Type.Boolean(),
  },
  closed
);
export type ScaRulePromotionResult = Static<typeof ScaRulePromotionResultSchema>;
export const ScaRuleRollbackRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: id,
    namespace: filePath,
    predecessor_release_path: filePath,
    predecessor_release_sha256: digest,
    restore_release_path: filePath,
    restore_release_sha256: digest,
    successor_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    authority: ScaRulePromotionRequestSchema.properties.authority,
    limits: ScaRuleLearningLimitsSchema,
  },
  closed
);
export type ScaRuleRollbackRequest = Static<typeof ScaRuleRollbackRequestSchema>;
export const ScaRuleRescanRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: id,
    release_path: filePath,
    release_sha256: digest,
    source_snapshot_sha256: digest,
    source_corpus_sha256: digest,
    retained_baseline_sha256: digest,
    predecessor_investigation_sha256: digest,
    rescan_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    authority: ScaRulePromotionRequestSchema.properties.authority,
    limits: ScaRuleLearningLimitsSchema,
  },
  closed
);
export type ScaRuleRescanRequest = Static<typeof ScaRuleRescanRequestSchema>;
export const ScaRuleRescanResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    request_sha256: digest,
    status: Type.Union([Type.Literal("completed"), Type.Literal("denied"), Type.Literal("failed")]),
    reason: text,
    release_sha256: digest,
    retained_baseline_sha256: digest,
    predecessor_investigation_sha256: digest,
    rescan_revision: Type.Integer({ minimum: 1 }),
    source_snapshot_sha256: digest,
    source_corpus_sha256: digest,
    findings: Type.Array(
      Type.Object(
        {
          rule_id: id,
          path: filePath,
          start_line: Type.Integer({ minimum: 1 }),
          end_line: Type.Integer({ minimum: 1 }),
        },
        closed
      ),
      { maxItems: 32768 }
    ),
    reenter_investigation: Type.Boolean(),
    private_receipts_sha256: digest,
  },
  closed
);
export type ScaRuleRescanResult = Static<typeof ScaRuleRescanResultSchema>;
