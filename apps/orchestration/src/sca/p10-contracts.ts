import {
  ScaP10NativeCollectionV1Schema,
  validateScaP10ValidateEvidenceV1,
  validateScaP10NativeTestEvidenceV1,
} from "./p10-native-tests.js";
import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract } from "../contracts.js";
import type { RequiredModelIdentityV1 } from "../required-model.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";

/**
 * Inactive SCA P10 "post-disposition rule learning" candidate contracts.
 *
 * P10 consumes the recorded P09 reconciliation result (in either reconciled lane), derives
 * eligibility and false-negative classification from exact admitted evidence, performs one bounded
 * DeepSeek candidate proposal, validates candidates through a deterministic host-owned Semgrep
 * validate/test manifest, and records a separately-authorized, future-only, atomic, immutable
 * promotion decision plus a separate rescan revision.
 *
 * Every schema here is deliberately absent from every active registry. The phase emits a
 * non-positive terminal and never claims release, campaign completion, or P12 authorization.
 */
export const SCA_P10_PHASE_ID = "SCA-P10" as const;
export const SCA_P10_CANDIDATE_PLAYBOOK_NAME = "sca-p10-candidate" as const;
export const SCA_P10_ADMITTING_STATE = "sca_p10_admitting" as const;
export const SCA_P10_CLASSIFYING_STATE = "sca_p10_classifying" as const;
export const SCA_P10_PROPOSING_STATE = "sca_p10_proposing" as const;
export const SCA_P10_VALIDATING_STATE = "sca_p10_validating" as const;
export const SCA_P10_FINAL_STATE = "sca_p10_finalizing" as const;
export const SCA_P10_CANCELLED_STATE = "sca_p10_cancelled" as const;

export const SCA_P10_PROPOSER_ROLE = "rule_candidate_proposer" as const;
export const SCA_P10_PROPOSER_AGENT = "ida" as const;

/** Pinned DeepSeek identity for the single bounded cognitive step (no fallback, no default change). */
export const SCA_P10_REQUIRED_MODEL: RequiredModelIdentityV1 = Object.freeze({
  schema_version: 1,
  alias: "deepseek-flash",
  provider: "ollama",
  model: "deepseek-v4.1-flash:cloud",
  override: "ollama/deepseek-v4.1-flash:cloud",
});
/** The cognitive phase declares an empty tool subset. */
export const SCA_P10_REQUIRED_TOOL_SUBSET = Object.freeze([] as const);
export const SCA_P10_PROVIDER_OPENING_GUARD = "sca_p10_payload_disclosure_v1" as const;

export const SCA_P10_PROPOSAL_CALL_ID = "sca-p10-rule-candidate-proposal" as const;
export const SCA_P10_PROPOSAL_PURPOSE = "p10_rule_candidate_proposal" as const;
export const SCA_P10_CONTENT_MODE =
  "p09_eligible_established_issue_and_root_cause_projections" as const;

/** Closed deterministic host-operation kind for Semgrep `--validate` / `--test` execution. */
export const SCA_P10_RULE_VALIDATION_OPERATION_KIND = "sca-p10-rule-validation" as const;

export const SCA_P10_CANDIDATE_START_SCHEMA = "penny.sca-p10-candidate-start.v1" as const;
export const SCA_P10_ADMISSION_SCHEMA = "penny.sca-p10-admission.v1" as const;
export const SCA_P10_ELIGIBILITY_LEDGER_SCHEMA = "penny.sca-p10-eligibility-ledger.v1" as const;
export const SCA_P10_BASELINE_EVIDENCE_SCHEMA = "penny.sca-p10-baseline-evidence.v1" as const;
export const SCA_P10_DISCLOSURE_SCOPE_SCHEMA = "penny.sca-p10-disclosure-scope.v1" as const;
export const SCA_P10_DISCLOSURE_ADMISSION_SCHEMA = "penny.sca-p10-disclosure-admission.v1" as const;
export const SCA_P10_COGNITIVE_PAYLOAD_SCHEMA = "penny.sca-p10-cognitive-payload.v1" as const;
export const SCA_P10_RULE_CANDIDATE_REVISION_SCHEMA =
  "penny.sca-p10-rule-candidate-revision.v1" as const;
export const SCA_P10_RULE_CANDIDATE_REGISTRY_SCHEMA =
  "penny.sca-p10-rule-candidate-registry.v1" as const;
export const SCA_P10_RULE_TEST_FIXTURES_SCHEMA = "penny.sca-p10-rule-test-fixtures.v1" as const;
/** Raw fixture source bytes persisted exactly as authored (real files, not metadata shells). */
export const SCA_P10_RULE_TEST_FIXTURE_SOURCE_SCHEMA =
  "penny.sca-p10-rule-test-fixture-source.v1" as const;
export const SCA_P10_RULE_VALIDATION_RESULTS_SCHEMA =
  "penny.sca-p10-rule-validation-results.v1" as const;
export const SCA_P10_RULE_QUARANTINE_RECORDS_SCHEMA =
  "penny.sca-p10-rule-quarantine-records.v1" as const;
export const SCA_P10_RULE_PROMOTION_DECISIONS_SCHEMA =
  "penny.sca-p10-rule-promotion-decisions.v1" as const;
export const SCA_P10_PROMOTION_RECEIPT_SCHEMA = "penny.sca-p10-promotion-receipt.v1" as const;
export const SCA_P10_RULE_RELEASE_REVISION_SCHEMA =
  "penny.sca-p10-rule-release-revision.v1" as const;
export const SCA_P10_RESCAN_DIRECTIVE_SCHEMA = "penny.sca-p10-rescan-directive.v1" as const;
export const SCA_P10_CHECKPOINT_SCHEMA = "penny.sca-p10-checkpoint.v1" as const;
export const SCA_P10_REASSESSMENT_SCHEMA = "penny.sca-p10-reassessment.v1" as const;
export const SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA =
  "penny.sca-p10-rule-learning-outcome.v1" as const;
export const SCA_P10_GATE_SCHEMA = "penny.sca-p10-gate.v1" as const;
export const SCA_P10_TO_P11_TRANSITION_SCHEMA = "penny.sca-p10-to-p11-transition.v1" as const;
export const SCA_P10_TERMINAL_SCHEMA = "penny.sca-p10-terminal.v1" as const;

/** The exact schema id P09 named as a missing downstream artifact. */
export const SCA_P10_LEARNING_OUTCOME_SCHEMA_ID = SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA;

export const SCA_P10_LANES = ["accepted_progression", "incomplete_closeout"] as const;
export type ScaP10LaneV1 = (typeof SCA_P10_LANES)[number];

export const SCA_P10_P08_DISPOSITIONS = [
  "confirmed",
  "rejected-with-evidence",
  "inconclusive",
  "deferred",
  "duplicate-of",
  "out-of-scope",
] as const;

export const SCA_P10_ELIGIBILITY_KINDS = ["eligible", "ineligible", "non_finding"] as const;
export type ScaP10EligibilityKindV1 = (typeof SCA_P10_ELIGIBILITY_KINDS)[number];

export const SCA_P10_ELIGIBLE_CLASSIFICATIONS = ["established_issue", "refutation"] as const;
export type ScaP10EligibleClassificationV1 = (typeof SCA_P10_ELIGIBLE_CLASSIFICATIONS)[number];

/** False-negative predicate outcomes. */
export const SCA_P10_BASELINE_CLASSIFICATIONS = [
  "false_negative",
  "baseline_hit",
  "coverage_gap",
] as const;
export type ScaP10BaselineClassificationV1 = (typeof SCA_P10_BASELINE_CLASSIFICATIONS)[number];

export const SCA_P10_BASELINE_LANGUAGES = ["php", "javascript", "typescript"] as const;
export type ScaP10BaselineLanguageV1 = (typeof SCA_P10_BASELINE_LANGUAGES)[number];

/** Honest baseline statuses. Only the first two may establish a false negative. */
export const SCA_P10_BASELINE_STATUSES = [
  "succeeded",
  "findings",
  "failed",
  "timed_out",
  "cancelled",
  "unavailable",
  "output_limit",
  "unsupported",
] as const;
export type ScaP10BaselineStatusV1 = (typeof SCA_P10_BASELINE_STATUSES)[number];
export function scaP10BaselineCompleted(status: ScaP10BaselineStatusV1): boolean {
  return status === "succeeded" || status === "findings";
}

/** The eight required validation case classes. Every class must have a recorded result. */
export const SCA_P10_VALIDATION_CASE_CLASSES = Object.freeze([
  "broader_regression",
  "fixed",
  "generalized",
  "held_out",
  "negative_neighbor",
  "performance",
  "retained_vulnerable",
  "vulnerable",
] as const);
export type ScaP10ValidationCaseClassV1 = (typeof SCA_P10_VALIDATION_CASE_CLASSES)[number];

/** Expected observation per case class: `match` means the rule must alert. */
export const SCA_P10_EXPECTED_CASE_OUTCOME: Readonly<
  Record<ScaP10ValidationCaseClassV1, "match" | "no_match" | "within_bound">
> = Object.freeze({
  vulnerable: "match",
  fixed: "no_match",
  negative_neighbor: "no_match",
  generalized: "match",
  retained_vulnerable: "match",
  held_out: "match",
  broader_regression: "within_bound",
  performance: "within_bound",
});

export const SCA_P10_CASE_RESULT_STATUSES = ["passed", "failed", "unrun"] as const;
export type ScaP10CaseResultStatusV1 = (typeof SCA_P10_CASE_RESULT_STATUSES)[number];

/**
 * Observed outcomes a host-derived validation case may report. `match`/`no_match` are the actual
 * rule-match state of a fixture; `within_bound`/`regression`/`exceeded` are aggregate observations
 * for the retained-corpus regression and performance cases. Only the first three can ever equal a
 * case's closed expected outcome, so `regression`/`exceeded` are always a failing observation.
 */
export const SCA_P10_CASE_OBSERVED_OUTCOMES = [
  "match",
  "no_match",
  "within_bound",
  "regression",
  "exceeded",
] as const;
export type ScaP10CaseObservedOutcomeV1 = (typeof SCA_P10_CASE_OBSERVED_OUTCOMES)[number];

export const SCA_P10_LEARNING_DISPOSITIONS = [
  "validated_candidate",
  "quarantined_candidate",
  "no_rule",
  "blocked_learning",
] as const;
export type ScaP10LearningDispositionV1 = (typeof SCA_P10_LEARNING_DISPOSITIONS)[number];

export const SCA_P10_PROMOTION_DECISIONS = [
  "promoted",
  "denied",
  "not_attempted",
  "unavailable",
] as const;
export type ScaP10PromotionDecisionV1 = (typeof SCA_P10_PROMOTION_DECISIONS)[number];

export const SCA_P10_TERMINAL_STATUSES = [
  "learning_complete",
  "learning_incomplete",
  "blocked_invalid",
  "cancelled",
] as const;
export type ScaP10TerminalStatusV1 = (typeof SCA_P10_TERMINAL_STATUSES)[number];

export const SCA_P10_REASSESSMENT_TRIGGER_CODES = Object.freeze([
  "new_evidence",
  "invalidated_evidence",
  "changed_snapshot",
  "changed_rule_release",
  "scope_change",
] as const);
export type ScaP10ReassessmentTriggerCodeV1 = (typeof SCA_P10_REASSESSMENT_TRIGGER_CODES)[number];

/**
 * Downstream products P10 does not produce and therefore must name as missing when reporting or
 * release are unavailable. The accounting is durable and non-positive.
 */
export const SCA_P10_MISSING_DOWNSTREAM_ARTIFACTS = Object.freeze([
  "penny.sca-p11-reconciliation.v1",
  "penny.sca-p11-report.v1",
  "penny.sca-p11-validation-records.v1",
  "penny.sca-p12-release-record.v1",
] as const);
/**
 * Exact P01-catalog downstream obligations. The earlier `SCA-OBL-OUTPUT-P11-REPORT` alias does not
 * exist in the P01 obligation catalog; P11 accounting binds the exact catalog ids instead: the P11
 * acceptance obligation plus its eight `report-output`-scoped required results, and the P12
 * acceptance obligation. The list is lexicographically sorted for the closed `assertSortedUnique`
 * record shape.
 */
export const SCA_P10_DOWNSTREAM_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-P11-ACCEPTANCE",
  "SCA-OBL-P12-ACCEPTANCE",
  "SCA-OBL-REPORT-CHECKSUM-MANIFEST",
  "SCA-OBL-REPORT-CVSS-V4",
  "SCA-OBL-REPORT-EPS-OBLIGATION-LEDGER",
  "SCA-OBL-REPORT-MARKDOWN",
  "SCA-OBL-REPORT-RECONCILIATION",
  "SCA-OBL-REPORT-SARIF",
  "SCA-OBL-REPORT-STRUCTURED-JSON",
  "SCA-OBL-REPORT-VALIDATION-RECORDS",
] as const);

/** The promotion-authority boundary obligation that must name the admitted promotion authority. */
export const SCA_P10_PROMOTION_AUTHORITY_OBLIGATION_ID =
  "SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY" as const;

/**
 * Promotion store policy defaults, mirroring the `consequence.rule_promotion: deny` default. A
 * validated candidate without a separately admitted authority artifact yields a denied decision.
 */
export const SCA_P10_PROMOTION_POLICY_DEFAULT = "deny" as const;

const NonEmptyTextSchema = Type.String({ minLength: 1, maxLength: 16_384 });
const BlockerCodeSchema = Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" });
const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);
const ItemIdSchema = Type.String({ pattern: "^p09item_[a-f0-9]{64}$" });

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function assertSortedUnique(values: readonly string[], label: string): void {
  const sorted = [...new Set(values)].sort();
  if (!same(values, sorted)) {
    throw new Error(`${label} must be unique and lexicographically sorted`);
  }
}
function selfDigest<T extends Readonly<Record<string, unknown>>>(
  value: T,
  field: keyof T,
  label: string
): void {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  if (value[field] !== sha256(canonicalJson(body))) {
    throw new Error(`${label} self digest mismatch`);
  }
}

export function withP10Digest<T extends Readonly<Record<string, unknown>>, K extends string>(
  value: T,
  field: K
): T & Readonly<Record<K, string>> {
  return { ...value, [field]: sha256(canonicalJson(value)) } as T & Readonly<Record<K, string>>;
}

/** Stable identity of one candidate, derived from the established issue and rule digest. */
export function scaP10CandidateId(input: {
  readonly established_issue_item_id: string;
  readonly rule_sha256: string;
}): string {
  return `p10cand_${sha256(
    canonicalJson({
      established_issue_item_id: input.established_issue_item_id,
      rule_sha256: input.rule_sha256,
    })
  )}`;
}

export function scaP10RuleSha256(ruleContentBase64: string): string {
  return sha256(Buffer.from(ruleContentBase64, "base64"));
}

const RequiredModelSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    alias: Type.Literal("deepseek-flash"),
    provider: Type.Literal("ollama"),
    model: Type.Literal("deepseek-v4.1-flash:cloud"),
    override: Type.Literal("ollama/deepseek-v4.1-flash:cloud"),
  },
  { additionalProperties: false }
);

const LaneSchema = Type.Union([
  Type.Literal("accepted_progression"),
  Type.Literal("incomplete_closeout"),
]);
const DispositionSchema = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("rejected-with-evidence"),
  Type.Literal("inconclusive"),
  Type.Literal("deferred"),
  Type.Literal("duplicate-of"),
  Type.Literal("out-of-scope"),
]);
const EligibilitySchema = Type.Union([
  Type.Literal("eligible"),
  Type.Literal("ineligible"),
  Type.Literal("non_finding"),
]);
const EligibleClassificationSchema = Type.Union([
  Type.Literal("established_issue"),
  Type.Literal("refutation"),
]);
const BaselineClassificationSchema = Type.Union([
  Type.Literal("false_negative"),
  Type.Literal("baseline_hit"),
  Type.Literal("coverage_gap"),
]);
const BaselineLanguageSchema = Type.Union([
  Type.Literal("php"),
  Type.Literal("javascript"),
  Type.Literal("typescript"),
]);
const BaselineStatusSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("findings"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
  Type.Literal("cancelled"),
  Type.Literal("unavailable"),
  Type.Literal("output_limit"),
  Type.Literal("unsupported"),
]);
const CaseClassSchema = Type.Union([
  Type.Literal("vulnerable"),
  Type.Literal("fixed"),
  Type.Literal("negative_neighbor"),
  Type.Literal("generalized"),
  Type.Literal("retained_vulnerable"),
  Type.Literal("held_out"),
  Type.Literal("broader_regression"),
  Type.Literal("performance"),
]);
const ExpectedCaseOutcomeSchema = Type.Union([
  Type.Literal("match"),
  Type.Literal("no_match"),
  Type.Literal("within_bound"),
]);
const ObservedCaseOutcomeSchema = Type.Union([
  Type.Literal("match"),
  Type.Literal("no_match"),
  Type.Literal("within_bound"),
  Type.Literal("regression"),
  Type.Literal("exceeded"),
]);
const CaseResultStatusSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("unrun"),
]);
const ReassessmentTriggerSchema = Type.Union([
  Type.Literal("new_evidence"),
  Type.Literal("invalidated_evidence"),
  Type.Literal("changed_snapshot"),
  Type.Literal("changed_rule_release"),
  Type.Literal("scope_change"),
]);

/** The closed P10 candidate start constraint contract (`penny.sca-p10-candidate-start.v1`). */
export const ScaP10CandidateStartV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_CANDIDATE_START_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    p09_terminal_ref: ArtifactRefSchema,
    p09_transition_ref: NullableArtifactRefSchema,
    p09_reconciliation_ledger_ref: NullableArtifactRefSchema,
    p09_gate_ref: NullableArtifactRefSchema,
    p09_admission_ref: NullableArtifactRefSchema,
    /** Exact P09 admission base refs, used to re-derive the P09 admission and reconciliation. */
    p08_terminal_ref: ArtifactRefSchema,
    p08_transition_ref: NullableArtifactRefSchema,
    p08_evidence_ledger_ref: NullableArtifactRefSchema,
    p08_gate_ref: NullableArtifactRefSchema,
    p08_admission_ref: NullableArtifactRefSchema,
    p08_item_universe_ref: NullableArtifactRefSchema,
    p01_obligation_ledger_ref: ArtifactRefSchema,
    p09_coverage_input_ref: NullableArtifactRefSchema,
    p09_phase_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    p09_obligation_resolution_ref: NullableArtifactRefSchema,
    p09_reassessment_ref: NullableArtifactRefSchema,
    /** Caller constraints not reachable from the P09 admission chain. */
    baseline_evidence_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    promotion_authority_ref: ArtifactRefSchema,
    /** Immutable P01-frozen rule releases of currently active runs (never altered by promotion). */
    active_run_rule_release_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    p10_reassessment_ref: NullableArtifactRefSchema,
    p10_prior_ledger_ref: NullableArtifactRefSchema,
  },
  { additionalProperties: false, $id: SCA_P10_CANDIDATE_START_SCHEMA }
);
export type ScaP10CandidateStartV1 = Readonly<Static<typeof ScaP10CandidateStartV1Schema>>;

export const ScaP10AdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_ADMISSION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    p09_terminal_ref: ArtifactRefSchema,
    p09_transition_ref: NullableArtifactRefSchema,
    p09_reconciliation_ledger_ref: NullableArtifactRefSchema,
    p09_gate_ref: NullableArtifactRefSchema,
    p09_admission_ref: NullableArtifactRefSchema,
    baseline_evidence_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    promotion_authority_ref: ArtifactRefSchema,
    active_run_rule_release_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    /** Absent when the input P09 terminal is a non-learnable checkpoint (`cancelled`/`blocked_invalid`). */
    lane: Type.Optional(LaneSchema),
    p09_rederivation_ok: Type.Boolean(),
    p09_reconciliation_rederivation_ok: Type.Boolean(),
    non_learnable: Type.Boolean(),
    non_learnable_reason: Type.Union([NonEmptyTextSchema, Type.Null()]),
    item_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    eligible_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_ADMISSION_SCHEMA }
);
export type ScaP10AdmissionV1 = Readonly<Static<typeof ScaP10AdmissionV1Schema>>;

/** One exact baseline scan bound to a language, the snapshot, and the frozen rule release. */
export const ScaP10BaselineEntryV1Schema = Type.Object(
  {
    language: BaselineLanguageSchema,
    p02_result_ref: ArtifactRefSchema,
    p02_result_sha256: Sha256Schema,
    baseline_status: BaselineStatusSchema,
    truncated: Type.Boolean(),
    /** Host-derived normalized alerts from the exact P02 result bytes. */
    alerts: Type.Array(
      Type.Object(
        {
          path: NonEmptyTextSchema,
          start_line: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_000_000 }
    ),
  },
  { additionalProperties: false }
);
export type ScaP10BaselineEntryV1 = Readonly<Static<typeof ScaP10BaselineEntryV1Schema>>;

export const ScaP10BaselineEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_BASELINE_EVIDENCE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    frozen_rule_release_ref: ArtifactRefSchema,
    frozen_rule_release_sha256: Sha256Schema,
    frozen_rule_config_sha256: Sha256Schema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    entries: Type.Array(ScaP10BaselineEntryV1Schema, { minItems: 1, maxItems: 3 }),
    baseline_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_BASELINE_EVIDENCE_SCHEMA }
);
export type ScaP10BaselineEvidenceV1 = Readonly<Static<typeof ScaP10BaselineEvidenceV1Schema>>;

export const ScaP10EligibilityItemV1Schema = Type.Object(
  {
    item_id: ItemIdSchema,
    identity: OpaqueIdSchema,
    primary_ref: ArtifactRefSchema,
    p08_disposition: DispositionSchema,
    p08_disposition_ref: ArtifactRefSchema,
    eligible_classification: EligibleClassificationSchema,
    baseline_language: Type.Union([BaselineLanguageSchema, Type.Null()]),
    baseline_classification: Type.Union([BaselineClassificationSchema, Type.Null()]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
  },
  { additionalProperties: false }
);
export type ScaP10EligibilityItemV1 = Readonly<Static<typeof ScaP10EligibilityItemV1Schema>>;

export const ScaP10IneligibleItemV1Schema = Type.Object(
  {
    item_id: ItemIdSchema,
    identity: OpaqueIdSchema,
    eligibility: EligibilitySchema,
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
  },
  { additionalProperties: false }
);
export type ScaP10IneligibleItemV1 = Readonly<Static<typeof ScaP10IneligibleItemV1Schema>>;

export const ScaP10EligibilityLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_ELIGIBILITY_LEDGER_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    p09_reconciliation_ledger_ref: ArtifactRefSchema,
    lane: LaneSchema,
    eligible_items: Type.Array(ScaP10EligibilityItemV1Schema, { maxItems: 10_000 }),
    ineligible_items: Type.Array(ScaP10IneligibleItemV1Schema, { maxItems: 10_000 }),
    eligibility_ledger_revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    prior_eligibility_ledger_ref: NullableArtifactRefSchema,
    prior_eligibility_ledger_sha256: Type.Union([Sha256Schema, Type.Null()]),
    append_only: Type.Literal(true),
    item_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    eligible_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    established_issue_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    refutation_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    false_negative_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    baseline_hit_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    coverage_gap_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    set_equality_valid: Type.Literal(true),
    eligibility_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_ELIGIBILITY_LEDGER_SCHEMA }
);
export type ScaP10EligibilityLedgerV1 = Readonly<Static<typeof ScaP10EligibilityLedgerV1Schema>>;

export const ScaP10DisclosureScopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_DISCLOSURE_SCOPE_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    required_model: RequiredModelSchema,
    destination_class: Type.Literal("cloud"),
    purpose: Type.Literal(SCA_P10_PROPOSAL_PURPOSE),
    allowed_data_classes: Type.Tuple([
      Type.Literal("p09_eligible_established_issue_projections"),
      Type.Literal("root_cause_evidence_excerpts"),
      Type.Literal("source_pointer_projections"),
    ]),
    provider_retention_status: Type.Literal("known"),
    provider_retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    provider_logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_training_use: Type.Literal("prohibited"),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 786_432 }),
    max_provider_calls: Type.Literal(1),
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
    issued_at: Rfc3339UtcSchema,
    scope_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_DISCLOSURE_SCOPE_SCHEMA }
);
export type ScaP10DisclosureScopeV1 = Readonly<Static<typeof ScaP10DisclosureScopeV1Schema>>;

const PayloadItemSchema = Type.Object(
  {
    item_id: ItemIdSchema,
    primary_ref: ArtifactRefSchema,
    p08_disposition_ref: ArtifactRefSchema,
    repository_path: NonEmptyTextSchema,
    line_start: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
    line_end: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
    root_cause_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
    distinguishing_oracle: Type.Union([NonEmptyTextSchema, Type.Null()]),
    excerpt: NonEmptyTextSchema,
  },
  { additionalProperties: false }
);

export const ScaP10CognitivePayloadV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_COGNITIVE_PAYLOAD_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    call_id: Type.Literal(SCA_P10_PROPOSAL_CALL_ID),
    role: Type.Literal(SCA_P10_PROPOSER_ROLE),
    purpose: Type.Literal(SCA_P10_PROPOSAL_PURPOSE),
    required_model: RequiredModelSchema,
    p09_reconciliation_ledger_ref: ArtifactRefSchema,
    eligibility_ledger_ref: ArtifactRefSchema,
    baseline_evidence_ref: ArtifactRefSchema,
    frozen_rule_release_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    assigned_item_ids: Type.Array(ItemIdSchema, { maxItems: 10_000 }),
    items: Type.Array(PayloadItemSchema, { maxItems: 10_000 }),
    content_mode: Type.Literal(SCA_P10_CONTENT_MODE),
    payload_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_COGNITIVE_PAYLOAD_SCHEMA }
);
export type ScaP10CognitivePayloadV1 = Readonly<Static<typeof ScaP10CognitivePayloadV1Schema>>;

export const ScaP10DisclosureAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_DISCLOSURE_ADMISSION_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    call_id: Type.Literal(SCA_P10_PROPOSAL_CALL_ID),
    role: Type.Literal(SCA_P10_PROPOSER_ROLE),
    purpose: Type.Literal(SCA_P10_PROPOSAL_PURPOSE),
    required_model: RequiredModelSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    disclosure_scope_sha256: Sha256Schema,
    payload_ref: ArtifactRefSchema,
    payload_sha256: Sha256Schema,
    payload_byte_length: Type.Integer({ minimum: 1, maximum: 786_432 }),
    serialized_opening_byte_limit: Type.Integer({ minimum: 1, maximum: 786_432 }),
    authorized_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 10_000 }),
    destination: Type.Literal("cloud"),
    retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    training: Type.Literal("prohibited"),
    secrets_embedded: Type.Literal(false),
    personal_data_embedded: Type.Literal(false),
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
    evaluated_before_dispatch: Type.Literal(true),
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_DISCLOSURE_ADMISSION_SCHEMA }
);
export type ScaP10DisclosureAdmissionV1 = Readonly<
  Static<typeof ScaP10DisclosureAdmissionV1Schema>
>;

export const ScaP10RuleCandidateRevisionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_CANDIDATE_REVISION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    candidate_id: Type.String({ pattern: "^p10cand_[a-f0-9]{64}$" }),
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    parent_revision_ref: NullableArtifactRefSchema,
    parent_revision_sha256: Type.Union([Sha256Schema, Type.Null()]),
    /** Root cause: the causal account and exact P07/P08 evidence refs. */
    established_issue_item_id: ItemIdSchema,
    root_cause_claim: NonEmptyTextSchema,
    root_cause_evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
    distinguishing_oracle: Type.Union([NonEmptyTextSchema, Type.Null()]),
    /** Source: repository path/line range plus the exact source-snapshot binding. */
    repository_path: NonEmptyTextSchema,
    line_start: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
    line_end: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    /** Finding: the exact P08 disposition revision that established the issue. */
    finding_disposition_revision_ref: ArtifactRefSchema,
    finding_disposition_revision_sha256: Sha256Schema,
    /** Fixture: exact artifact ref for the candidate's fixture manifest. */
    fixture_manifest_ref: ArtifactRefSchema,
    fixture_manifest_sha256: Sha256Schema,
    /** The single candidate rule. */
    rule_id: OpaqueIdSchema,
    rule_language: BaselineLanguageSchema,
    rule_category: NonEmptyTextSchema,
    rule_content_base64: Type.String({ minLength: 1, maxLength: 4_194_304 }),
    rule_sha256: Sha256Schema,
    created_at: Rfc3339UtcSchema,
    revision_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_CANDIDATE_REVISION_SCHEMA }
);
export type ScaP10RuleCandidateRevisionV1 = Readonly<
  Static<typeof ScaP10RuleCandidateRevisionV1Schema>
>;

export const ScaP10RuleCandidateRegistryV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_CANDIDATE_REGISTRY_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    candidates: Type.Array(
      Type.Object(
        {
          candidate_id: Type.String({ pattern: "^p10cand_[a-f0-9]{64}$" }),
          current_revision_ref: ArtifactRefSchema,
          prior_revision_refs: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_000 }
    ),
    candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    append_only: Type.Literal(true),
    registry_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_CANDIDATE_REGISTRY_SCHEMA }
);
export type ScaP10RuleCandidateRegistryV1 = Readonly<
  Static<typeof ScaP10RuleCandidateRegistryV1Schema>
>;

export const ScaP10RuleTestFixturesV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_TEST_FIXTURES_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    candidate_id: Type.String({ pattern: "^p10cand_[a-f0-9]{64}$" }),
    fixture_directory: NonEmptyTextSchema,
    cases: Type.Array(
      Type.Object(
        {
          case_class: CaseClassSchema,
          file_name: Type.String({ minLength: 1, maxLength: 1_024 }),
          fixture_ref: ArtifactRefSchema,
          expected_outcome: ExpectedCaseOutcomeSchema,
          content_sha256: Sha256Schema,
        },
        { additionalProperties: false }
      ),
      { minItems: 8, maxItems: 8 }
    ),
    fixture_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_TEST_FIXTURES_SCHEMA }
);
export type ScaP10RuleTestFixturesV1 = Readonly<Static<typeof ScaP10RuleTestFixturesV1Schema>>;

/** Host elapsed time for the complete serial collection of eight `--test --json` FILE invocations.
 * Includes process-runner setup/verification and completion; excludes `--validate` and fixture
 * materialization. Not a per-fixture measurement or an independent benchmark. The bound is an
 * acceptance criterion, never an execution deadline or inactivity/cancellation replacement.
 */
export const ScaP10InvocationPerformanceV1Schema = Type.Object(
  {
    clock: Type.Literal("host_monotonic"),
    scope: Type.Literal("complete_test_collection"),
    elapsed_ms: Type.Union([
      Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      Type.Null(),
    ]),
    bound_ms: Type.Integer({ minimum: 1, maximum: 5_400_000 }),
  },
  { additionalProperties: false }
);
export type ScaP10InvocationPerformanceV1 = Readonly<
  Static<typeof ScaP10InvocationPerformanceV1Schema>
>;

export interface ScaP10PerformanceExecutionV1 {
  readonly status: "passed" | "failed";
  readonly invocation_sha256: string | null;
  readonly raw_result_sha256: string | null;
  readonly exit_status: number | null;
  readonly performance: ScaP10InvocationPerformanceV1 | null;
}
export interface ScaP10PerformanceCaseV1 {
  readonly observed_outcome: "within_bound" | "exceeded" | null;
  readonly status: "passed" | "failed" | "unrun";
}
/** Shared by adapter-result and manifest admission: stdout has no performance authority. */
export function deriveScaP10PerformanceCaseV1(
  test: ScaP10PerformanceExecutionV1
): ScaP10PerformanceCaseV1 {
  if (test.performance === null) return { observed_outcome: null, status: "unrun" };
  const elapsed = test.performance.elapsed_ms;
  if (
    elapsed !== null &&
    (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("SCA P10 performance elapsed measurement is invalid");
  }
  if (
    test.status !== "passed" ||
    test.exit_status !== 0 ||
    test.invocation_sha256 === null ||
    test.raw_result_sha256 === null ||
    elapsed === null
  ) {
    return { observed_outcome: null, status: "unrun" };
  }
  return elapsed <= test.performance.bound_ms
    ? { observed_outcome: "within_bound", status: "passed" }
    : { observed_outcome: "exceeded", status: "failed" };
}

export const ScaP10RuleValidationResultsV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_VALIDATION_RESULTS_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    host_operation_kind: Type.Literal(SCA_P10_RULE_VALIDATION_OPERATION_KIND),
    host_owned: Type.Literal(true),
    model_calls: Type.Literal(0),
    tool_calls: Type.Literal(0),
    candidates: Type.Array(
      Type.Object(
        {
          candidate_id: Type.String({ pattern: "^p10cand_[a-f0-9]{64}$" }),
          rule_revision_ref: ArtifactRefSchema,
          rule_revision_sha256: Sha256Schema,
          validate: Type.Object(
            {
              invocation_sha256: Type.Union([Sha256Schema, Type.Null()]),
              invocation_json: Type.Union([Type.String({ maxLength: 1_048_576 }), Type.Null()]),
              process_result_json: Type.Union([Type.String({ maxLength: 8_388_608 }), Type.Null()]),
              executable_sha256: Type.Union([Sha256Schema, Type.Null()]),
              exit_status: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
              raw_result_sha256: Type.Union([Sha256Schema, Type.Null()]),
              status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
            },
            { additionalProperties: false }
          ),
          test: Type.Object(
            {
              collection: Type.Union([ScaP10NativeCollectionV1Schema, Type.Null()]),
              performance: Type.Union([ScaP10InvocationPerformanceV1Schema, Type.Null()]),
              invocation_sha256: Type.Union([Sha256Schema, Type.Null()]),
              exit_status: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
              raw_result_sha256: Type.Union([Sha256Schema, Type.Null()]),
              status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
            },
            { additionalProperties: false }
          ),
          cases: Type.Array(
            Type.Object(
              {
                case_class: CaseClassSchema,
                expected_outcome: ExpectedCaseOutcomeSchema,
                observed_outcome: Type.Union([ObservedCaseOutcomeSchema, Type.Null()]),
                status: CaseResultStatusSchema,
              },
              { additionalProperties: false }
            ),
            { minItems: 8, maxItems: 8 }
          ),
          required_unrun_case_classes: Type.Array(CaseClassSchema, { maxItems: 8 }),
          manifest_complete: Type.Boolean(),
          blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_000 }
    ),
    candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    validation_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_VALIDATION_RESULTS_SCHEMA }
);
export type ScaP10RuleValidationResultsV1 = Readonly<
  Static<typeof ScaP10RuleValidationResultsV1Schema>
>;

export const ScaP10RuleQuarantineRecordsV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_QUARANTINE_RECORDS_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    records: Type.Array(
      Type.Object(
        {
          candidate_id: Type.String({ pattern: "^p10cand_[a-f0-9]{64}$" }),
          rule_revision_ref: ArtifactRefSchema,
          reason_code: BlockerCodeSchema,
          failed_case_classes: Type.Array(CaseClassSchema, { maxItems: 8 }),
          required_unrun_case_classes: Type.Array(CaseClassSchema, { maxItems: 8 }),
          lineage_complete: Type.Boolean(),
          blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_000 }
    ),
    record_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    quarantine_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_QUARANTINE_RECORDS_SCHEMA }
);
export type ScaP10RuleQuarantineRecordsV1 = Readonly<
  Static<typeof ScaP10RuleQuarantineRecordsV1Schema>
>;

export const ScaP10PromotionReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_PROMOTION_RECEIPT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    promotion_id: OpaqueIdSchema,
    /** The promoted candidate, or the rollback marker for a rollback revision. */
    candidate_id: OpaqueIdSchema,
    promotion_authority_ref: ArtifactRefSchema,
    predecessor_release_ref: NullableArtifactRefSchema,
    predecessor_release_sha256: Type.Union([Sha256Schema, Type.Null()]),
    successor_release_ref: ArtifactRefSchema,
    successor_release_sha256: Sha256Schema,
    successor_release_revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    head_claim_token_sha256: Sha256Schema,
    committed_at: Rfc3339UtcSchema,
    atomic: Type.Literal(true),
    immutable: Type.Literal(true),
    future_only: Type.Literal(true),
    receipt_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_PROMOTION_RECEIPT_SCHEMA }
);
export type ScaP10PromotionReceiptV1 = Readonly<Static<typeof ScaP10PromotionReceiptV1Schema>>;

export const ScaP10RuleReleaseRevisionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_RELEASE_REVISION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    release_revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    release_ref: ArtifactRefSchema,
    release_sha256: Sha256Schema,
    bundle_ref: ArtifactRefSchema,
    bundle_sha256: Sha256Schema,
    predecessor_release_ref: NullableArtifactRefSchema,
    predecessor_release_sha256: Type.Union([Sha256Schema, Type.Null()]),
    promotion_authority_ref: ArtifactRefSchema,
    immutable: Type.Literal(true),
    created_at: Rfc3339UtcSchema,
    revision_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_RELEASE_REVISION_SCHEMA }
);
export type ScaP10RuleReleaseRevisionV1 = Readonly<
  Static<typeof ScaP10RuleReleaseRevisionV1Schema>
>;

export const ScaP10RulePromotionDecisionsV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_PROMOTION_DECISIONS_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    promotion_authority_ref: ArtifactRefSchema,
    promotion_authority_admitted: Type.Boolean(),
    policy_default: Type.Literal("deny"),
    promotion_attempted: Type.Boolean(),
    decisions: Type.Array(
      Type.Object(
        {
          candidate_id: Type.String({ pattern: "^p10cand_[a-f0-9]{64}$" }),
          rule_revision_ref: ArtifactRefSchema,
          decision: Type.Union([
            Type.Literal("promoted"),
            Type.Literal("denied"),
            Type.Literal("not_attempted"),
            Type.Literal("unavailable"),
          ]),
          predecessor_release_ref: NullableArtifactRefSchema,
          predecessor_release_sha256: Type.Union([Sha256Schema, Type.Null()]),
          successor_release_ref: NullableArtifactRefSchema,
          successor_release_sha256: Type.Union([Sha256Schema, Type.Null()]),
          successor_release_revision: Type.Union([
            Type.Integer({ minimum: 1, maximum: 1_000_000 }),
            Type.Null(),
          ]),
          receipt_ref: NullableArtifactRefSchema,
          blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_000 }
    ),
    decision_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    decisions_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_PROMOTION_DECISIONS_SCHEMA }
);
export type ScaP10RulePromotionDecisionsV1 = Readonly<
  Static<typeof ScaP10RulePromotionDecisionsV1Schema>
>;

export const ScaP10RescanDirectiveV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RESCAN_DIRECTIVE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    promotion_receipt_ref: ArtifactRefSchema,
    successor_release_ref: ArtifactRefSchema,
    successor_release_sha256: Sha256Schema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    retained_baseline_ref: ArtifactRefSchema,
    rescan_revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    reenters_investigation_at: Type.Literal("SCA-P04"),
    executed: Type.Literal(false),
    directive_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RESCAN_DIRECTIVE_SCHEMA }
);
export type ScaP10RescanDirectiveV1 = Readonly<Static<typeof ScaP10RescanDirectiveV1Schema>>;

export const ScaP10CheckpointV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_CHECKPOINT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    item_id: ItemIdSchema,
    identity: OpaqueIdSchema,
    reason_code: BlockerCodeSchema,
    primary_ref: ArtifactRefSchema,
    missing_evidence_need: NonEmptyTextSchema,
    reopen_condition: NonEmptyTextSchema,
    checkpoint_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_CHECKPOINT_SCHEMA }
);
export type ScaP10CheckpointV1 = Readonly<Static<typeof ScaP10CheckpointV1Schema>>;

export const ScaP10ReassessmentV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_REASSESSMENT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    prior_p10_ledger_ref: ArtifactRefSchema,
    prior_p10_ledger_sha256: Sha256Schema,
    prior_p09_ledger_ref: ArtifactRefSchema,
    prior_p09_ledger_sha256: Sha256Schema,
    trigger_codes: Type.Array(ReassessmentTriggerSchema, { minItems: 1, maxItems: 5 }),
    stimulus_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
    invalidated_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
    reassessment_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_REASSESSMENT_SCHEMA }
);
export type ScaP10ReassessmentV1 = Readonly<Static<typeof ScaP10ReassessmentV1Schema>>;

export const ScaP10RuleLearningOutcomeV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    run_id: OpaqueIdSchema,
    disposition: Type.Union([
      Type.Literal("validated_candidate"),
      Type.Literal("quarantined_candidate"),
      Type.Literal("no_rule"),
      Type.Literal("blocked_learning"),
    ]),
    reason_code: BlockerCodeSchema,
    lane: LaneSchema,
    eligibility_ledger_ref: ArtifactRefSchema,
    candidate_registry_ref: NullableArtifactRefSchema,
    validation_manifest_ref: NullableArtifactRefSchema,
    quarantine_records_ref: NullableArtifactRefSchema,
    promotion_decisions_ref: NullableArtifactRefSchema,
    eligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    ineligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    unresolved_item_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    validated_candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    quarantined_candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    blocked_candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    false_negative_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    baseline_hit_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    coverage_gap_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    missing_downstream_artifacts: Type.Array(NonEmptyTextSchema, { maxItems: 32 }),
    required_downstream_obligation_ids: Type.Array(
      Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" }),
      { maxItems: 32 }
    ),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    non_positive: Type.Literal(true),
    outcome_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA }
);
export type ScaP10RuleLearningOutcomeV1 = Readonly<
  Static<typeof ScaP10RuleLearningOutcomeV1Schema>
>;

export const ScaP10GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_GATE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    criterion_id: Type.Literal("AC-P10"),
    verdict: Type.Union([
      Type.Literal("pass_ready"),
      Type.Literal("pass_blocked"),
      Type.Literal("blocked_invalid"),
    ]),
    learning_outcome_ref: ArtifactRefSchema,
    lane: LaneSchema,
    outcome_disposition: Type.Union([
      Type.Literal("validated_candidate"),
      Type.Literal("quarantined_candidate"),
      Type.Literal("no_rule"),
      Type.Literal("blocked_learning"),
    ]),
    immutable_p09_lineage_valid: Type.Boolean(),
    exhaustive_eligibility: Type.Boolean(),
    false_negative_predicate_valid: Type.Boolean(),
    no_ineligible_learning: Type.Boolean(),
    baseline_binding_valid: Type.Boolean(),
    candidate_lineage_complete: Type.Boolean(),
    validation_manifest_complete: Type.Boolean(),
    no_unrun_required_validation_disguised: Type.Boolean(),
    no_overfitting_no_suppressed_retained: Type.Boolean(),
    promotion_separately_authorized: Type.Boolean(),
    promotion_future_only: Type.Boolean(),
    promotion_atomic_immutable: Type.Boolean(),
    no_promotion_without_receipt: Type.Boolean(),
    append_only_revisions: Type.Boolean(),
    frozen_active_run_rules_preserved: Type.Boolean(),
    rescan_separate_revision: Type.Boolean(),
    downstream_accounting_present: Type.Boolean(),
    model_identity_and_disclosure_valid: Type.Boolean(),
    deterministic_validation_host_owned: Type.Boolean(),
    p12_or_release_claims_absent: Type.Boolean(),
    eligible_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    validated_candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    quarantined_candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    blocked_candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    false_negative_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    coverage_gap_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_GATE_SCHEMA }
);
export type ScaP10GateV1 = Readonly<Static<typeof ScaP10GateV1Schema>>;

export const ScaP10ToP11TransitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_TO_P11_TRANSITION_SCHEMA),
    schema_version: Type.Literal(1),
    source_phase_id: Type.Literal(SCA_P10_PHASE_ID),
    target_phase_id: Type.Literal("SCA-P11"),
    handoff_kind: Type.Literal("eligible_only_learning_evidence_only"),
    qualification_scope: Type.Literal("learning_gate_only_not_p11_reporting"),
    phase_gate_passed: Type.Literal(false),
    p11_reporting_authorized_by_this_transition: Type.Literal(false),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    campaign_completion_claimed: Type.Literal(false),
    p09_terminal_ref: ArtifactRefSchema,
    p09_reconciliation_ledger_ref: ArtifactRefSchema,
    p09_gate_ref: ArtifactRefSchema,
    learning_outcome_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    candidate_registry_ref: NullableArtifactRefSchema,
    quarantine_records_ref: NullableArtifactRefSchema,
    promotion_decisions_ref: NullableArtifactRefSchema,
    frozen_rule_release_ref: ArtifactRefSchema,
    lane: LaneSchema,
    eligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    ineligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    unresolved_item_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    required_gaps_retained: Type.Literal(true),
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_TO_P11_TRANSITION_SCHEMA }
);
export type ScaP10ToP11TransitionV1 = Readonly<Static<typeof ScaP10ToP11TransitionV1Schema>>;

export const ScaP10TerminalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_TERMINAL_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P10_PHASE_ID),
    status: Type.Union([
      Type.Literal("learning_complete"),
      Type.Literal("learning_incomplete"),
      Type.Literal("blocked_invalid"),
      Type.Literal("cancelled"),
    ]),
    lane: Type.Optional(LaneSchema),
    learning_outcome_ref: NullableArtifactRefSchema,
    gate_ref: NullableArtifactRefSchema,
    p11_transition_ref: NullableArtifactRefSchema,
    p11_handoff_ready: Type.Boolean(),
    eligibility_ledger_ref: NullableArtifactRefSchema,
    promotion_performed: Type.Boolean(),
    promotion_receipt_ref: NullableArtifactRefSchema,
    outcome_disposition: Type.Union([
      Type.Literal("validated_candidate"),
      Type.Literal("quarantined_candidate"),
      Type.Literal("no_rule"),
      Type.Literal("blocked_learning"),
      Type.Null(),
    ]),
    eligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    ineligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    missing_downstream_artifacts: Type.Array(NonEmptyTextSchema, { maxItems: 32 }),
    required_downstream_obligation_ids: Type.Array(
      Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" }),
      { maxItems: 32 }
    ),
    selected_artifact_refs: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    phase_gate_passed: Type.Literal(false),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    nonterminal_campaign: Type.Literal(true),
    p12_release_authorized: Type.Literal(false),
    report_or_release_adjudication_performed: Type.Literal(false),
    terminal_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_TERMINAL_SCHEMA }
);
export type ScaP10TerminalV1 = Readonly<Static<typeof ScaP10TerminalV1Schema>>;

export const SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA =
  "penny.sca-p10-rule-candidate-proposal.v1" as const;

/**
 * Separately admitted promotion authority. It is distinct from execution and release authority
 * and names the P01 promotion-authority boundary obligation. Absence, `deny`, or a run mismatch
 * forces a denied promotion decision under the `consequence.rule_promotion: deny` default.
 */
export const SCA_P10_PROMOTION_AUTHORITY_SCHEMA = "penny.sca-p10-promotion-authority.v1" as const;

export const ScaP10PromotionAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_PROMOTION_AUTHORITY_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    promotion_authority_id: OpaqueIdSchema,
    obligation_id: Type.Literal(SCA_P10_PROMOTION_AUTHORITY_OBLIGATION_ID),
    separated_from_execution_authority: Type.Literal(true),
    separated_from_release_authority: Type.Literal(true),
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
    issued_at: Rfc3339UtcSchema,
    authority_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_PROMOTION_AUTHORITY_SCHEMA }
);
export type ScaP10PromotionAuthorityV1 = Readonly<Static<typeof ScaP10PromotionAuthorityV1Schema>>;

export function validateScaP10PromotionAuthorityV1(value: unknown): ScaP10PromotionAuthorityV1 {
  const parsed = validateContract(
    ScaP10PromotionAuthorityV1Schema,
    value,
    "SCA P10 promotion authority"
  );
  if (parsed.decision === "allow" && parsed.blocker_codes.length !== 0) {
    throw new Error("SCA P10 allowed promotion authority cannot retain blockers");
  }
  if (parsed.decision === "deny" && parsed.blocker_codes.length === 0) {
    throw new Error("SCA P10 denied promotion authority must name its blockers");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P10 promotion authority blocker codes");
  selfDigest(parsed, "authority_sha256", "SCA P10 promotion authority");
  return parsed;
}

export const ScaP10RuleCandidateProposalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA),
    schema_version: Type.Literal(1),
    role: Type.Literal(SCA_P10_PROPOSER_ROLE),
    payload_sha256: Sha256Schema,
    proposals: Type.Array(
      Type.Object(
        {
          established_issue_item_id: ItemIdSchema,
          root_cause_claim: NonEmptyTextSchema,
          root_cause_evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
          distinguishing_oracle: Type.Union([NonEmptyTextSchema, Type.Null()]),
          rule_id: OpaqueIdSchema,
          rule_language: BaselineLanguageSchema,
          rule_category: NonEmptyTextSchema,
          rule_content_base64: Type.String({ minLength: 1, maxLength: 4_194_304 }),
          /** Real fixture source bytes, one per required case class, persisted exactly as authored. */
          fixtures: Type.Array(
            Type.Object(
              {
                case_class: CaseClassSchema,
                file_name: Type.String({ minLength: 1, maxLength: 1_024 }),
                content_base64: Type.String({ minLength: 1, maxLength: 4_194_304 }),
              },
              { additionalProperties: false }
            ),
            { minItems: 8, maxItems: 8 }
          ),
          excerpt: NonEmptyTextSchema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_000 }
    ),
    no_feasible_rule: Type.Boolean(),
    rationale: NonEmptyTextSchema,
    complete: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA }
);
export type ScaP10RuleCandidateProposalV1 = Readonly<
  Static<typeof ScaP10RuleCandidateProposalV1Schema>
>;

export function validateScaP10RuleCandidateProposalV1(
  value: unknown
): ScaP10RuleCandidateProposalV1 {
  const parsed = validateContract(
    ScaP10RuleCandidateProposalV1Schema,
    value,
    "SCA P10 rule candidate proposal"
  );
  if (parsed.no_feasible_rule !== (parsed.proposals.length === 0)) {
    throw new Error("SCA P10 rule candidate proposal no-feasible-rule flag mismatch");
  }
  assertSortedUnique(
    parsed.proposals.map((proposal) => proposal.established_issue_item_id),
    "SCA P10 rule candidate proposal issue identities"
  );
  for (const proposal of parsed.proposals) {
    assertSortedUnique(
      proposal.root_cause_evidence_refs.map((ref) => ref.artifact_id),
      "SCA P10 rule candidate proposal root-cause evidence refs"
    );
    assertSortedUnique(
      proposal.fixtures.map((fixture) => fixture.case_class),
      "SCA P10 rule candidate proposal fixture case classes"
    );
    for (const caseClass of SCA_P10_VALIDATION_CASE_CLASSES) {
      if (!proposal.fixtures.some((fixture) => fixture.case_class === caseClass)) {
        throw new Error(
          `SCA P10 rule candidate proposal omits the required fixture case '${caseClass}'`
        );
      }
    }
    for (const fixture of proposal.fixtures) {
      const bytes = Buffer.from(fixture.content_base64, "base64");
      if (bytes.toString("base64") !== fixture.content_base64 || bytes.byteLength === 0) {
        throw new Error("SCA P10 rule candidate proposal fixture content is not canonical base64");
      }
    }
  }
  return parsed;
}

// --- Validators -----------------------------------------------------------------------------

export function validateScaP10CandidateStartV1(value: unknown): ScaP10CandidateStartV1 {
  const parsed = validateContract(ScaP10CandidateStartV1Schema, value, "SCA P10 candidate start");
  assertSortedUnique(
    parsed.p09_phase_evidence_refs.map((ref) => ref.artifact_id),
    "SCA P10 start phase-evidence refs"
  );
  assertSortedUnique(
    parsed.active_run_rule_release_refs.map((ref) => ref.artifact_id),
    "SCA P10 start active-run rule-release refs"
  );
  return parsed;
}

export function validateScaP10AdmissionV1(value: unknown): ScaP10AdmissionV1 {
  const parsed = validateContract(ScaP10AdmissionV1Schema, value, "SCA P10 admission");
  assertSortedUnique(
    parsed.active_run_rule_release_refs.map((ref) => ref.artifact_id),
    "SCA P10 admission active-run rule-release refs"
  );
  if (
    parsed.non_learnable !== (parsed.non_learnable_reason !== null) ||
    parsed.non_learnable !== (parsed.lane === undefined) ||
    parsed.non_learnable === parsed.p09_rederivation_ok
  ) {
    throw new Error("SCA P10 admission non-learnable assurance mismatch");
  }
  selfDigest(parsed, "admission_sha256", "SCA P10 admission");
  return parsed;
}

export function validateScaP10BaselineEvidenceV1(value: unknown): ScaP10BaselineEvidenceV1 {
  const parsed = validateContract(
    ScaP10BaselineEvidenceV1Schema,
    value,
    "SCA P10 baseline evidence"
  );
  assertSortedUnique(
    parsed.entries.map((entry) => entry.language),
    "SCA P10 baseline entry languages"
  );
  if (parsed.frozen_rule_release_sha256 !== parsed.frozen_rule_release_ref.content_digest) {
    throw new Error("SCA P10 baseline frozen release ref/digest mismatch");
  }
  if (parsed.source_snapshot_sha256 !== parsed.source_snapshot_ref.content_digest) {
    throw new Error("SCA P10 baseline source-snapshot ref/digest mismatch");
  }
  for (const entry of parsed.entries) {
    if (entry.p02_result_sha256 !== entry.p02_result_ref.content_digest) {
      throw new Error("SCA P10 baseline P02 result ref/digest mismatch");
    }
    assertSortedUnique(
      entry.alerts.map((alert) => `${alert.path}\u0000${String(alert.start_line)}`),
      "SCA P10 baseline alert identities"
    );
  }
  selfDigest(parsed, "baseline_sha256", "SCA P10 baseline evidence");
  return parsed;
}

export function validateScaP10EligibilityLedgerV1(value: unknown): ScaP10EligibilityLedgerV1 {
  const parsed = validateContract(
    ScaP10EligibilityLedgerV1Schema,
    value,
    "SCA P10 eligibility ledger"
  );
  assertSortedUnique(
    parsed.eligible_items.map((item) => item.item_id),
    "SCA P10 eligible item ids"
  );
  assertSortedUnique(
    parsed.ineligible_items.map((item) => item.item_id),
    "SCA P10 ineligible item ids"
  );
  const eligibleIds = new Set(parsed.eligible_items.map((item) => item.item_id));
  for (const item of parsed.ineligible_items) {
    if (eligibleIds.has(item.item_id)) {
      throw new Error("SCA P10 eligibility ledger lets one item be both eligible and ineligible");
    }
    if (item.eligibility === "eligible") {
      throw new Error("SCA P10 eligibility ledger records an eligible item as non-eligible");
    }
  }
  if (parsed.eligible_items.length !== parsed.eligible_count) {
    throw new Error("SCA P10 eligibility ledger eligible count mismatch");
  }
  if (parsed.eligible_items.length + parsed.ineligible_items.length !== parsed.item_count) {
    throw new Error("SCA P10 eligibility ledger item accounting is not exhaustive");
  }
  const established = parsed.eligible_items.filter(
    (item) => item.eligible_classification === "established_issue"
  );
  const refutations = parsed.eligible_items.filter(
    (item) => item.eligible_classification === "refutation"
  );
  if (
    established.length !== parsed.established_issue_count ||
    refutations.length !== parsed.refutation_count
  ) {
    throw new Error("SCA P10 eligibility ledger eligible classification counts mismatch");
  }
  for (const item of established) {
    if (item.p08_disposition !== "confirmed") {
      throw new Error("SCA P10 established issue must be a confirmed disposition");
    }
    if (item.baseline_classification === null) {
      throw new Error("SCA P10 established issue lacks a baseline classification");
    }
    if (item.baseline_language === null && item.baseline_classification !== "coverage_gap") {
      throw new Error("SCA P10 established issue without a bound language must be a coverage gap");
    }
  }
  for (const item of refutations) {
    if (item.p08_disposition !== "rejected-with-evidence") {
      throw new Error("SCA P10 refutation must be a rejected-with-evidence disposition");
    }
    if (item.baseline_classification !== null) {
      throw new Error("SCA P10 refutation cannot carry a false-negative classification");
    }
  }
  const falseNegatives = established.filter(
    (item) => item.baseline_classification === "false_negative"
  ).length;
  const baselineHits = established.filter(
    (item) => item.baseline_classification === "baseline_hit"
  ).length;
  const coverageGaps = established.filter(
    (item) => item.baseline_classification === "coverage_gap"
  ).length;
  if (
    falseNegatives !== parsed.false_negative_count ||
    baselineHits !== parsed.baseline_hit_count ||
    coverageGaps !== parsed.coverage_gap_count
  ) {
    throw new Error("SCA P10 eligibility ledger baseline classification counts mismatch");
  }
  const revision = parsed.eligibility_ledger_revision;
  const priorRef = parsed.prior_eligibility_ledger_ref;
  const priorSha = parsed.prior_eligibility_ledger_sha256;
  if ((priorRef === null) !== (priorSha === null)) {
    throw new Error("SCA P10 eligibility ledger prior ref/digest mismatch");
  }
  if (priorRef !== null && priorSha !== priorRef.content_digest) {
    throw new Error("SCA P10 eligibility ledger prior digest binding mismatch");
  }
  if ((priorRef !== null) !== revision > 1) {
    throw new Error("SCA P10 eligibility ledger revision/prior mismatch");
  }
  if (parsed.append_only !== true) {
    throw new Error("SCA P10 eligibility ledger must be append-only");
  }
  selfDigest(parsed, "eligibility_sha256", "SCA P10 eligibility ledger");
  return parsed;
}

export function validateScaP10DisclosureScopeV1(value: unknown): ScaP10DisclosureScopeV1 {
  const parsed = validateContract(ScaP10DisclosureScopeV1Schema, value, "SCA P10 disclosure scope");
  if (parsed.decision === "allow" && parsed.blocker_codes.length !== 0) {
    throw new Error("SCA P10 allowed disclosure scope cannot retain blockers");
  }
  if (parsed.decision === "deny" && parsed.blocker_codes.length === 0) {
    throw new Error("SCA P10 denied disclosure scope must name its blockers");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P10 disclosure scope blocker codes");
  selfDigest(parsed, "scope_sha256", "SCA P10 disclosure scope");
  return parsed;
}

export function validateScaP10DisclosureAdmissionV1(value: unknown): ScaP10DisclosureAdmissionV1 {
  const parsed = validateContract(
    ScaP10DisclosureAdmissionV1Schema,
    value,
    "SCA P10 disclosure admission"
  );
  if (
    parsed.payload_sha256 !== parsed.payload_ref.content_digest ||
    parsed.payload_byte_length !== parsed.payload_ref.byte_length
  ) {
    throw new Error("SCA P10 disclosure admission payload ref/digest mismatch");
  }
  if (
    parsed.decision === "deny" &&
    parsed.authorized_refs.length > 0 &&
    parsed.blocker_codes.length === 0
  ) {
    throw new Error("SCA P10 denied disclosure admission must name its blockers");
  }
  if (parsed.training !== "prohibited") {
    throw new Error("SCA P10 disclosure admission forbids training use");
  }
  assertSortedUnique(
    parsed.authorized_refs.map((ref) => ref.artifact_id),
    "SCA P10 disclosure admission authorized refs"
  );
  assertSortedUnique(parsed.blocker_codes, "SCA P10 disclosure admission blocker codes");
  selfDigest(parsed, "admission_sha256", "SCA P10 disclosure admission");
  return parsed;
}

export function validateScaP10CognitivePayloadV1(value: unknown): ScaP10CognitivePayloadV1 {
  const parsed = validateContract(
    ScaP10CognitivePayloadV1Schema,
    value,
    "SCA P10 cognitive payload"
  );
  assertSortedUnique(parsed.assigned_item_ids, "SCA P10 cognitive payload assigned item ids");
  if (parsed.assigned_item_ids.length !== parsed.items.length) {
    throw new Error("SCA P10 cognitive payload assigned items are not exhaustive");
  }
  for (const item of parsed.items) {
    if (item.line_end < item.line_start) {
      throw new Error("SCA P10 cognitive payload item line range is invalid");
    }
    assertSortedUnique(
      item.root_cause_evidence_refs.map((ref) => ref.artifact_id),
      "SCA P10 cognitive payload root-cause evidence refs"
    );
  }
  selfDigest(parsed, "payload_sha256", "SCA P10 cognitive payload");
  return parsed;
}

export function validateScaP10RuleCandidateRevisionV1(
  value: unknown
): ScaP10RuleCandidateRevisionV1 {
  const parsed = validateContract(
    ScaP10RuleCandidateRevisionV1Schema,
    value,
    "SCA P10 rule candidate revision"
  );
  if (parsed.rule_sha256 !== scaP10RuleSha256(parsed.rule_content_base64)) {
    throw new Error("SCA P10 rule candidate rule digest mismatch");
  }
  if (
    parsed.candidate_id !==
    scaP10CandidateId({
      established_issue_item_id: parsed.established_issue_item_id,
      rule_sha256: parsed.rule_sha256,
    })
  ) {
    throw new Error("SCA P10 rule candidate id is not derived from its issue and rule digest");
  }
  if (parsed.line_end < parsed.line_start) {
    throw new Error("SCA P10 rule candidate line range is invalid");
  }
  if (parsed.source_snapshot_sha256 !== parsed.source_snapshot_ref.content_digest) {
    throw new Error("SCA P10 rule candidate source-snapshot ref/digest mismatch");
  }
  if (
    parsed.finding_disposition_revision_sha256 !==
    parsed.finding_disposition_revision_ref.content_digest
  ) {
    throw new Error("SCA P10 rule candidate finding ref/digest mismatch");
  }
  if (parsed.fixture_manifest_sha256 !== parsed.fixture_manifest_ref.content_digest) {
    throw new Error("SCA P10 rule candidate fixture ref/digest mismatch");
  }
  if ((parsed.parent_revision_ref === null) !== (parsed.parent_revision_sha256 === null)) {
    throw new Error("SCA P10 rule candidate parent ref/digest mismatch");
  }
  if (
    parsed.parent_revision_ref !== null &&
    parsed.parent_revision_sha256 !== parsed.parent_revision_ref.content_digest
  ) {
    throw new Error("SCA P10 rule candidate parent digest binding mismatch");
  }
  if ((parsed.parent_revision_ref !== null) !== parsed.revision > 1) {
    throw new Error("SCA P10 rule candidate revision/parent mismatch");
  }
  assertSortedUnique(
    parsed.root_cause_evidence_refs.map((ref) => ref.artifact_id),
    "SCA P10 rule candidate root-cause evidence refs"
  );
  selfDigest(parsed, "revision_sha256", "SCA P10 rule candidate revision");
  return parsed;
}

export function validateScaP10RuleCandidateRegistryV1(
  value: unknown
): ScaP10RuleCandidateRegistryV1 {
  const parsed = validateContract(
    ScaP10RuleCandidateRegistryV1Schema,
    value,
    "SCA P10 rule candidate registry"
  );
  if (parsed.candidates.length !== parsed.candidate_count) {
    throw new Error("SCA P10 rule candidate registry count mismatch");
  }
  assertSortedUnique(
    parsed.candidates.map((candidate) => candidate.candidate_id),
    "SCA P10 rule candidate registry candidate ids"
  );
  if (parsed.append_only !== true) {
    throw new Error("SCA P10 rule candidate registry must be append-only");
  }
  selfDigest(parsed, "registry_sha256", "SCA P10 rule candidate registry");
  return parsed;
}

export function validateScaP10RuleTestFixturesV1(value: unknown): ScaP10RuleTestFixturesV1 {
  const parsed = validateContract(
    ScaP10RuleTestFixturesV1Schema,
    value,
    "SCA P10 rule test fixtures"
  );
  assertSortedUnique(
    parsed.cases.map((entry) => entry.case_class),
    "SCA P10 rule test fixture case classes"
  );
  for (const caseClass of SCA_P10_VALIDATION_CASE_CLASSES) {
    const entry = parsed.cases.find((candidate) => candidate.case_class === caseClass);
    if (entry === undefined) {
      throw new Error(`SCA P10 rule test fixtures omit the required case class '${caseClass}'`);
    }
    if (entry.expected_outcome !== SCA_P10_EXPECTED_CASE_OUTCOME[caseClass]) {
      throw new Error("SCA P10 rule test fixture expected outcome is not the closed default");
    }
    if (entry.content_sha256 !== entry.fixture_ref.content_digest) {
      throw new Error("SCA P10 rule test fixture ref/digest mismatch");
    }
    if (
      entry.file_name === "." ||
      entry.file_name === ".." ||
      entry.file_name.includes("/") ||
      entry.file_name.includes("\\") ||
      entry.file_name.includes("\0")
    ) {
      throw new Error("SCA P10 rule test fixture file name is not a single safe segment");
    }
  }
  selfDigest(parsed, "fixture_sha256", "SCA P10 rule test fixtures");
  return parsed;
}

export function validateScaP10RuleValidationResultsV1(
  value: unknown
): ScaP10RuleValidationResultsV1 {
  const parsed = validateContract(
    ScaP10RuleValidationResultsV1Schema,
    value,
    "SCA P10 rule validation results"
  );
  if (parsed.candidates.length !== parsed.candidate_count) {
    throw new Error("SCA P10 rule validation manifest count mismatch");
  }
  assertSortedUnique(
    parsed.candidates.map((entry) => entry.candidate_id),
    "SCA P10 rule validation manifest candidate ids"
  );
  for (const entry of parsed.candidates) {
    if (entry.rule_revision_sha256 !== entry.rule_revision_ref.content_digest) {
      throw new Error("SCA P10 rule validation revision ref/digest mismatch");
    }
    assertSortedUnique(
      entry.cases.map((item) => item.case_class),
      "SCA P10 rule validation case classes"
    );
    for (const caseClass of SCA_P10_VALIDATION_CASE_CLASSES) {
      const result = entry.cases.find((item) => item.case_class === caseClass);
      if (result === undefined) {
        throw new Error(`SCA P10 rule validation manifest omits case '${caseClass}'`);
      }
      if (result.expected_outcome !== SCA_P10_EXPECTED_CASE_OUTCOME[caseClass]) {
        throw new Error("SCA P10 rule validation expected outcome is not the closed default");
      }
      if (result.status === "passed" && result.observed_outcome !== result.expected_outcome) {
        throw new Error("SCA P10 rule validation passed case observed the wrong outcome");
      }
    }
    validateScaP10ValidateEvidenceV1(entry.validate);
    validateScaP10NativeTestEvidenceV1(entry.test, entry.cases);
    const performance = entry.cases.find((item) => item.case_class === "performance");
    const measured = deriveScaP10PerformanceCaseV1(entry.test);
    if (
      performance === undefined ||
      performance.status !== measured.status ||
      performance.observed_outcome !== measured.observed_outcome
    ) {
      throw new Error("SCA P10 validation manifest performance disagrees with host measurement");
    }
    const unrun = entry.cases
      .filter((item) => item.status === "unrun")
      .map((item) => item.case_class)
      .sort();
    if (!same([...entry.required_unrun_case_classes].sort(), unrun)) {
      throw new Error("SCA P10 rule validation required-unrun classes disagree with its cases");
    }
    const complete =
      entry.cases.every((item) => item.status === "passed") &&
      entry.validate.status === "passed" &&
      entry.test.status === "passed";
    if (entry.manifest_complete !== complete) {
      throw new Error("SCA P10 rule validation completeness is not derived from its cases");
    }
    assertSortedUnique(
      entry.required_unrun_case_classes,
      "SCA P10 rule validation required-unrun classes"
    );
    assertSortedUnique(entry.blocker_codes, "SCA P10 rule validation blocker codes");
  }
  selfDigest(parsed, "validation_sha256", "SCA P10 rule validation results");
  return parsed;
}

export function validateScaP10RuleQuarantineRecordsV1(
  value: unknown
): ScaP10RuleQuarantineRecordsV1 {
  const parsed = validateContract(
    ScaP10RuleQuarantineRecordsV1Schema,
    value,
    "SCA P10 rule quarantine records"
  );
  if (parsed.records.length !== parsed.record_count) {
    throw new Error("SCA P10 rule quarantine record count mismatch");
  }
  assertSortedUnique(
    parsed.records.map((record) => record.candidate_id),
    "SCA P10 rule quarantine candidate ids"
  );
  for (const record of parsed.records) {
    assertSortedUnique(record.failed_case_classes, "SCA P10 quarantine failed case classes");
    assertSortedUnique(
      record.required_unrun_case_classes,
      "SCA P10 quarantine required-unrun case classes"
    );
    assertSortedUnique(record.blocker_codes, "SCA P10 quarantine blocker codes");
  }
  selfDigest(parsed, "quarantine_sha256", "SCA P10 rule quarantine records");
  return parsed;
}

export function validateScaP10RulePromotionDecisionsV1(
  value: unknown
): ScaP10RulePromotionDecisionsV1 {
  const parsed = validateContract(
    ScaP10RulePromotionDecisionsV1Schema,
    value,
    "SCA P10 rule promotion decisions"
  );
  if (parsed.decisions.length !== parsed.decision_count) {
    throw new Error("SCA P10 rule promotion decision count mismatch");
  }
  if (parsed.policy_default !== "deny") {
    throw new Error("SCA P10 promotion policy default must remain deny");
  }
  const promoted = parsed.decisions.filter((entry) => entry.decision === "promoted");
  if (!parsed.promotion_authority_admitted && promoted.length > 0) {
    throw new Error("SCA P10 promotion decision claims promotion without admitted authority");
  }
  for (const entry of parsed.decisions) {
    const hasReceipt = entry.receipt_ref !== null;
    if ((entry.decision === "promoted") !== hasReceipt) {
      throw new Error("SCA P10 promotion decision claims promotion without an exact receipt");
    }
    if (
      entry.decision === "promoted" &&
      (entry.successor_release_ref === null ||
        entry.successor_release_sha256 === null ||
        entry.successor_release_revision === null ||
        entry.successor_release_sha256 !== entry.successor_release_ref.content_digest)
    ) {
      throw new Error("SCA P10 promoted decision must bind its exact successor release");
    }
    if (
      entry.decision !== "promoted" &&
      (entry.successor_release_ref !== null || entry.receipt_ref !== null)
    ) {
      throw new Error("SCA P10 non-promoted decision cannot bind a successor release or receipt");
    }
    if ((entry.predecessor_release_ref === null) !== (entry.predecessor_release_sha256 === null)) {
      throw new Error("SCA P10 promotion predecessor ref/digest mismatch");
    }
    assertSortedUnique(entry.blocker_codes, "SCA P10 promotion decision blocker codes");
  }
  if (parsed.promotion_attempted && parsed.decisions.length === 0) {
    throw new Error("SCA P10 promotion attempted flag disagrees with its decisions");
  }
  if (promoted.length > 0 && parsed.promotion_attempted !== true) {
    throw new Error("SCA P10 promoted decision requires an attempted promotion");
  }
  assertSortedUnique(
    promoted.map((entry) => entry.candidate_id),
    "SCA P10 promoted candidate ids"
  );
  selfDigest(parsed, "decisions_sha256", "SCA P10 rule promotion decisions");
  return parsed;
}

export function validateScaP10PromotionReceiptV1(value: unknown): ScaP10PromotionReceiptV1 {
  const parsed = validateContract(
    ScaP10PromotionReceiptV1Schema,
    value,
    "SCA P10 promotion receipt"
  );
  if (parsed.successor_release_sha256 !== parsed.successor_release_ref.content_digest) {
    throw new Error("SCA P10 promotion receipt successor ref/digest mismatch");
  }
  if (
    parsed.predecessor_release_ref !== null &&
    parsed.predecessor_release_sha256 !== parsed.predecessor_release_ref.content_digest
  ) {
    throw new Error("SCA P10 promotion receipt predecessor ref/digest mismatch");
  }
  selfDigest(parsed, "receipt_sha256", "SCA P10 promotion receipt");
  return parsed;
}

export function validateScaP10RuleReleaseRevisionV1(value: unknown): ScaP10RuleReleaseRevisionV1 {
  const parsed = validateContract(
    ScaP10RuleReleaseRevisionV1Schema,
    value,
    "SCA P10 rule release revision"
  );
  if (
    parsed.release_sha256 !== parsed.release_ref.content_digest ||
    parsed.bundle_sha256 !== parsed.bundle_ref.content_digest
  ) {
    throw new Error("SCA P10 rule release revision ref/digest mismatch");
  }
  if (parsed.immutable !== true) {
    throw new Error("SCA P10 rule release revision must be immutable");
  }
  if ((parsed.predecessor_release_ref !== null) !== parsed.release_revision > 1) {
    throw new Error("SCA P10 rule release revision/predecessor mismatch");
  }
  if (
    parsed.predecessor_release_ref !== null &&
    parsed.predecessor_release_sha256 !== parsed.predecessor_release_ref.content_digest
  ) {
    throw new Error("SCA P10 rule release revision predecessor digest mismatch");
  }
  selfDigest(parsed, "revision_sha256", "SCA P10 rule release revision");
  return parsed;
}

export function validateScaP10RescanDirectiveV1(value: unknown): ScaP10RescanDirectiveV1 {
  const parsed = validateContract(ScaP10RescanDirectiveV1Schema, value, "SCA P10 rescan directive");
  if (
    parsed.successor_release_sha256 !== parsed.successor_release_ref.content_digest ||
    parsed.source_snapshot_sha256 !== parsed.source_snapshot_ref.content_digest
  ) {
    throw new Error("SCA P10 rescan directive ref/digest mismatch");
  }
  if (parsed.executed !== false) {
    throw new Error("SCA P10 rescan directive must remain unexecuted");
  }
  selfDigest(parsed, "directive_sha256", "SCA P10 rescan directive");
  return parsed;
}

export function validateScaP10CheckpointV1(value: unknown): ScaP10CheckpointV1 {
  const parsed = validateContract(ScaP10CheckpointV1Schema, value, "SCA P10 checkpoint");
  selfDigest(parsed, "checkpoint_sha256", "SCA P10 checkpoint");
  return parsed;
}

export function validateScaP10ReassessmentV1(value: unknown): ScaP10ReassessmentV1 {
  const parsed = validateContract(ScaP10ReassessmentV1Schema, value, "SCA P10 reassessment");
  if (
    parsed.prior_p10_ledger_sha256 !== parsed.prior_p10_ledger_ref.content_digest ||
    parsed.prior_p09_ledger_sha256 !== parsed.prior_p09_ledger_ref.content_digest
  ) {
    throw new Error("SCA P10 reassessment prior ref/digest mismatch");
  }
  assertSortedUnique(parsed.trigger_codes, "SCA P10 reassessment trigger codes");
  assertSortedUnique(
    parsed.stimulus_refs.map((ref) => ref.artifact_id),
    "SCA P10 reassessment stimulus refs"
  );
  assertSortedUnique(
    parsed.invalidated_evidence_refs.map((ref) => ref.artifact_id),
    "SCA P10 reassessment invalidated evidence refs"
  );
  const invalidated = parsed.trigger_codes.includes("invalidated_evidence");
  if (invalidated !== parsed.invalidated_evidence_refs.length > 0) {
    throw new Error("SCA P10 reassessment invalidated evidence/trigger mismatch");
  }
  selfDigest(parsed, "reassessment_sha256", "SCA P10 reassessment");
  return parsed;
}

export function validateScaP10RuleLearningOutcomeV1(value: unknown): ScaP10RuleLearningOutcomeV1 {
  const parsed = validateContract(
    ScaP10RuleLearningOutcomeV1Schema,
    value,
    "SCA P10 rule learning outcome"
  );
  const validated = parsed.validated_candidate_count;
  const quarantined = parsed.quarantined_candidate_count;
  const blocked = parsed.blocked_candidate_count;
  // Every registered candidate must land in exactly one terminal state, so a mixed
  // validated/quarantined/unrun manifest always produces honest, exhaustive accounting.
  if (validated + quarantined + blocked !== parsed.candidate_count) {
    throw new Error("SCA P10 learning outcome candidate accounting is not exhaustive");
  }
  if (parsed.disposition === "validated_candidate" && validated < 1) {
    throw new Error("SCA P10 validated-candidate outcome requires a validated candidate");
  }
  if (parsed.disposition === "quarantined_candidate" && quarantined < 1) {
    throw new Error("SCA P10 quarantined outcome requires a quarantined candidate");
  }
  if (parsed.disposition === "quarantined_candidate" && (validated > 0 || blocked > 0)) {
    throw new Error("SCA P10 quarantined outcome cannot mix validated or blocked candidates");
  }
  if (parsed.disposition === "no_rule" && (validated > 0 || quarantined > 0 || blocked > 0)) {
    throw new Error("SCA P10 no-rule outcome cannot carry validated or quarantined candidates");
  }
  if (parsed.disposition === "blocked_learning" && parsed.candidate_count > 0 && blocked < 1) {
    throw new Error("SCA P10 blocked outcome with candidates must name a blocked candidate");
  }
  if (
    parsed.disposition === "validated_candidate" &&
    (parsed.candidate_registry_ref === null ||
      parsed.validation_manifest_ref === null ||
      parsed.promotion_decisions_ref === null)
  ) {
    throw new Error("SCA P10 validated outcome requires registry, manifest, and decisions");
  }
  if (parsed.disposition === "no_rule" && parsed.candidate_count > 0) {
    throw new Error("SCA P10 no-rule outcome cannot retain candidates");
  }
  if (parsed.disposition !== "no_rule" && parsed.disposition !== "blocked_learning") {
    if (parsed.candidate_registry_ref === null) {
      throw new Error("SCA P10 non-no-rule outcome requires a candidate registry");
    }
  }
  assertSortedUnique(
    parsed.eligible_refs.map((ref) => ref.artifact_id),
    "SCA P10 learning outcome eligible refs"
  );
  assertSortedUnique(
    parsed.ineligible_refs.map((ref) => ref.artifact_id),
    "SCA P10 learning outcome ineligible refs"
  );
  assertSortedUnique(
    parsed.unresolved_item_refs.map((ref) => ref.artifact_id),
    "SCA P10 learning outcome unresolved refs"
  );
  assertSortedUnique(
    parsed.missing_downstream_artifacts,
    "SCA P10 learning outcome missing downstream artifacts"
  );
  assertSortedUnique(
    parsed.required_downstream_obligation_ids,
    "SCA P10 learning outcome required downstream obligations"
  );
  if (parsed.missing_downstream_artifacts.length === 0) {
    throw new Error("SCA P10 learning outcome must name its missing downstream artifacts");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P10 learning outcome blocker codes");
  selfDigest(parsed, "outcome_sha256", "SCA P10 rule learning outcome");
  return parsed;
}

export function validateScaP10GateV1(value: unknown): ScaP10GateV1 {
  const parsed = validateContract(ScaP10GateV1Schema, value, "SCA P10 gate");
  if (parsed.verdict === "pass_ready") {
    const predicates: readonly boolean[] = [
      parsed.immutable_p09_lineage_valid,
      parsed.exhaustive_eligibility,
      parsed.false_negative_predicate_valid,
      parsed.no_ineligible_learning,
      parsed.baseline_binding_valid,
      parsed.candidate_lineage_complete,
      parsed.validation_manifest_complete,
      parsed.no_unrun_required_validation_disguised,
      parsed.no_overfitting_no_suppressed_retained,
      parsed.promotion_separately_authorized,
      parsed.promotion_future_only,
      parsed.promotion_atomic_immutable,
      parsed.no_promotion_without_receipt,
      parsed.append_only_revisions,
      parsed.frozen_active_run_rules_preserved,
      parsed.rescan_separate_revision,
      parsed.downstream_accounting_present,
      parsed.model_identity_and_disclosure_valid,
      parsed.deterministic_validation_host_owned,
      parsed.p12_or_release_claims_absent,
    ];
    if (
      parsed.blocker_codes.length !== 0 ||
      predicates.some((predicate) => predicate !== true) ||
      parsed.outcome_disposition === "blocked_learning"
    ) {
      throw new Error("SCA P10 pass_ready gate claims an unmet condition");
    }
  }
  if (parsed.verdict === "blocked_invalid" && parsed.blocker_codes.length === 0) {
    throw new Error("SCA P10 blocked_invalid gate must name its blockers");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P10 gate blocker codes");
  selfDigest(parsed, "gate_sha256", "SCA P10 gate");
  return parsed;
}

export function validateScaP10ToP11TransitionV1(value: unknown): ScaP10ToP11TransitionV1 {
  const parsed = validateContract(
    ScaP10ToP11TransitionV1Schema,
    value,
    "SCA P10 successor handoff"
  );
  assertSortedUnique(
    parsed.eligible_refs.map((ref) => ref.artifact_id),
    "SCA P10 handoff eligible refs"
  );
  assertSortedUnique(
    parsed.ineligible_refs.map((ref) => ref.artifact_id),
    "SCA P10 handoff ineligible refs"
  );
  assertSortedUnique(
    parsed.unresolved_item_refs.map((ref) => ref.artifact_id),
    "SCA P10 handoff unresolved refs"
  );
  const eligibleIds = new Set(parsed.eligible_refs.map((ref) => ref.artifact_id));
  for (const ref of parsed.ineligible_refs) {
    if (eligibleIds.has(ref.artifact_id)) {
      throw new Error("SCA P10 handoff makes ineligible evidence eligible");
    }
  }
  selfDigest(parsed, "transition_sha256", "SCA P10 successor handoff");
  return parsed;
}

export function validateScaP10TerminalV1(value: unknown): ScaP10TerminalV1 {
  const parsed = validateContract(ScaP10TerminalV1Schema, value, "SCA P10 terminal");
  assertSortedUnique(parsed.blocker_codes, "SCA P10 terminal blocker codes");
  assertSortedUnique(
    parsed.eligible_refs.map((ref) => ref.artifact_id),
    "SCA P10 terminal eligible refs"
  );
  assertSortedUnique(
    parsed.ineligible_refs.map((ref) => ref.artifact_id),
    "SCA P10 terminal ineligible refs"
  );
  assertSortedUnique(
    parsed.missing_downstream_artifacts,
    "SCA P10 terminal missing downstream artifacts"
  );
  assertSortedUnique(
    parsed.required_downstream_obligation_ids,
    "SCA P10 terminal required downstream obligations"
  );
  if ((parsed.p11_transition_ref !== null) !== parsed.p11_handoff_ready) {
    throw new Error("SCA P10 terminal handoff readiness disagrees with its transition ref");
  }
  if (parsed.promotion_performed !== (parsed.promotion_receipt_ref !== null)) {
    throw new Error("SCA P10 terminal promotion claim disagrees with its receipt ref");
  }
  if (
    parsed.phase_gate_passed !== false ||
    parsed.release_eligible !== false ||
    parsed.campaign_complete !== false ||
    parsed.nonterminal_campaign !== true ||
    parsed.p12_release_authorized !== false ||
    parsed.report_or_release_adjudication_performed !== false
  ) {
    throw new Error("SCA P10 terminal must remain non-positive");
  }
  if (parsed.status === "learning_complete") {
    if (
      parsed.learning_outcome_ref === null ||
      parsed.gate_ref === null ||
      parsed.p11_transition_ref === null ||
      parsed.outcome_disposition === null ||
      parsed.lane === undefined
    ) {
      throw new Error("SCA P10 learning_complete terminal requires outcome, gate, and handoff");
    }
    if (
      parsed.outcome_disposition === "blocked_learning" ||
      parsed.outcome_disposition === "quarantined_candidate"
    ) {
      throw new Error("SCA P10 learning_complete terminal requires a completed assessment");
    }
  }
  if (parsed.status === "blocked_invalid") {
    if (
      parsed.p11_transition_ref !== null ||
      parsed.p11_handoff_ready ||
      parsed.promotion_performed ||
      parsed.missing_downstream_artifacts.length === 0
    ) {
      throw new Error("SCA P10 blocked_invalid terminal cannot hand off or promote");
    }
  }
  if (parsed.status === "cancelled") {
    if (
      parsed.learning_outcome_ref !== null ||
      parsed.gate_ref !== null ||
      parsed.p11_transition_ref !== null ||
      parsed.eligibility_ledger_ref !== null ||
      parsed.promotion_performed ||
      parsed.outcome_disposition !== null
    ) {
      throw new Error("SCA P10 cancelled terminal cannot carry learning or promotion state");
    }
  }
  selfDigest(parsed, "terminal_sha256", "SCA P10 terminal");
  return parsed;
}
