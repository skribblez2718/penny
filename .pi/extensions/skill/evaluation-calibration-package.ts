import path from "node:path";
import { createHash } from "node:crypto";

import { Type, type Static, type TSchema } from "typebox";

import {
  DecisionRequestV1Schema,
  PlanRequestV1Schema,
  canonicalJson,
  canonicalizeDecisionRequest,
  canonicalizePlanRequest,
  strictParseJson,
  validateContract,
} from "@penny/orchestration/source";

import {
  DecisionSemanticEvaluationV3Schema,
  DecideStructuredExpectationsV3Schema,
  PlanSemanticRequestProjectionV1Schema,
  PlanSemanticReviewWireV2Schema,
  PlanStructuredExpectationsV2Schema,
  StrategyEvaluationV2Schema,
} from "./evaluation-semantic-projections.js";
import {
  SemanticTrialReviewOutputV1Schema,
  buildEvaluationLiveCalibrationAuthorizationManifestV1,
  type EvaluationLiveCalibrationAuthorizationManifestV1,
} from "./evaluation-semantic-review.js";
import {
  EvaluationReadinessCalibrationTaskV1Schema,
  type EvaluationReadinessCalibrationTaskV1,
} from "./evaluation-runner.js";

const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const ArtifactIdSchema = Type.String({ pattern: "^art_[a-f0-9]{64}$" });
const IdSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const ProjectRelativePathSchema = Type.String({ minLength: 1, maxLength: 512 });
const DerivedRequestIdSchema = Type.String({ pattern: "^calreq_[a-f0-9]{64}$" });
const SplitSchema = Type.Literal("calibration");
const ScoringSchema = Type.Literal("non_scoring");
const ForbiddenReuseSchema = Type.Array(
  Type.Union([
    Type.Literal("held_out"),
    Type.Literal("admission"),
    Type.Literal("promotion"),
    Type.Literal("production"),
    Type.Literal("scoring"),
    Type.Literal("reuse"),
  ]),
  { minItems: 6, maxItems: 6, uniqueItems: true }
);

export const CALIBRATION_FORBIDDEN_REUSE = [
  "admission",
  "held_out",
  "production",
  "promotion",
  "reuse",
  "scoring",
] as const;

const ComponentBindingV1Schema = Type.Object(
  {
    component_id: IdSchema,
    path: ProjectRelativePathSchema,
    byte_length: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    sha256: DigestSchema,
  },
  { additionalProperties: false }
);
export type CalibrationComponentBindingV1 = Readonly<Static<typeof ComponentBindingV1Schema>>;

const ExactInputBindingV1Schema = Type.Object(
  {
    artifact_id: ArtifactIdSchema,
    source_path: ProjectRelativePathSchema,
    byte_length: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    sha256: DigestSchema,
  },
  { additionalProperties: false }
);

const OracleItemBindingV1Schema = Type.Object(
  {
    item_id: IdSchema,
    component_id: IdSchema,
    sha256: DigestSchema,
  },
  { additionalProperties: false }
);

const TaskReusePolicyV1Schema = Type.Object(
  {
    scoring: ScoringSchema,
    forbidden_uses: ForbiddenReuseSchema,
  },
  { additionalProperties: false }
);

const AllArmRoutingV1Schema = Type.Object(
  {
    kind: Type.Literal("all_arm_common"),
    q2_symmetric: Type.Literal(true),
    arm_comparison_eligible: Type.Literal(true),
  },
  { additionalProperties: false }
);
const CandidateOnlyRoutingV1Schema = Type.Object(
  {
    kind: Type.Literal("candidate_only_product_integrity"),
    q2_symmetric: Type.Literal(false),
    arm_comparison_eligible: Type.Literal(false),
    direct_baseline_forbidden: Type.Literal(true),
    ablation_forbidden: Type.Literal(true),
  },
  { additionalProperties: false }
);

const RequestBindingV1Schema = Type.Object(
  {
    derived_request_id: DerivedRequestIdSchema,
    canonical_request_sha256: DigestSchema,
    canonical_task_body_sha256: DigestSchema,
  },
  { additionalProperties: false }
);

const SourceFreeSemanticProjectionPolicyV1Schema = Type.Object(
  {
    kind: Type.Literal("request_only"),
    source_metadata_permitted: Type.Literal(false),
  },
  { additionalProperties: false }
);
const AdmittedEvidenceSemanticProjectionPolicyV1Schema = Type.Object(
  {
    kind: Type.Literal("post_admission_authorized_semantic_evidence"),
    source_metadata_permitted: Type.Literal(false),
    source_identifiers_permitted: Type.Literal(false),
    transport_metadata_permitted: Type.Literal(false),
    performance_metadata_permitted: Type.Literal(false),
  },
  { additionalProperties: false }
);

export const EvaluationCalibrationTaskV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evaluation-calibration-task.v1"),
    schema_version: Type.Literal(1),
    split: SplitSchema,
    scoring: ScoringSchema,
    skill: Type.Union([Type.Literal("decide"), Type.Literal("plan")]),
    task_id: IdSchema,
    domain: IdSchema,
    runtime_task: EvaluationReadinessCalibrationTaskV1Schema,
    canonical_request: Type.Union([DecisionRequestV1Schema, PlanRequestV1Schema]),
    request_binding: RequestBindingV1Schema,
    exact_inputs: Type.Array(ExactInputBindingV1Schema, { maxItems: 2 }),
    source_material_sha256s: Type.Array(DigestSchema, {
      maxItems: 16,
      uniqueItems: true,
    }),
    material_sha256s: Type.Array(DigestSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    oracle: OracleItemBindingV1Schema,
    accepted_equivalences: OracleItemBindingV1Schema,
    routing: Type.Union([AllArmRoutingV1Schema, CandidateOnlyRoutingV1Schema]),
    semantic_projection_policy: Type.Union([
      SourceFreeSemanticProjectionPolicyV1Schema,
      AdmittedEvidenceSemanticProjectionPolicyV1Schema,
    ]),
    reuse_policy: TaskReusePolicyV1Schema,
  },
  { additionalProperties: false }
);
export type EvaluationCalibrationTaskV1 = Readonly<
  Static<typeof EvaluationCalibrationTaskV1Schema>
>;

export const EvaluationCalibrationCohortV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evaluation-calibration-cohort.v1"),
    schema_version: Type.Literal(1),
    split: SplitSchema,
    scoring: ScoringSchema,
    cohort_id: IdSchema,
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    tasks: Type.Array(EvaluationCalibrationTaskV1Schema, { minItems: 1, maxItems: 32 }),
    reuse_policy: TaskReusePolicyV1Schema,
  },
  { additionalProperties: false }
);
export type EvaluationCalibrationCohortV1 = Readonly<
  Static<typeof EvaluationCalibrationCohortV1Schema>
>;

const ControlCaseKindV1Schema = Type.Union([
  Type.Literal("ordinary"),
  Type.Literal("equivalent"),
  Type.Literal("known_bad"),
  Type.Literal("boundary"),
  Type.Literal("mutation"),
]);
const ControlDispositionV1Schema = Type.Union([
  Type.Literal("PASS"),
  Type.Literal("FAIL"),
  Type.Literal("BLOCKED"),
]);

const ControlRequestVariantV1Schema = Type.Object(
  {
    goal: Type.String({ minLength: 1, maxLength: 32_768 }),
    constraints: Type.Record(Type.String(), Type.Unknown()),
    exact_input_artifact_ids: Type.Array(ArtifactIdSchema, { maxItems: 2, uniqueItems: true }),
    canonical_request: Type.Union([DecisionRequestV1Schema, PlanRequestV1Schema]),
    derived_request_id: DerivedRequestIdSchema,
    canonical_request_sha256: DigestSchema,
    canonical_task_body_sha256: DigestSchema,
  },
  { additionalProperties: false }
);

const ControlCommonProperties = {
  schema_id: Type.Literal("penny.evaluation-calibration-semantic-judge-control.v1"),
  schema_version: Type.Literal(1),
  split: SplitSchema,
  scoring: ScoringSchema,
  control_id: IdSchema,
  task_id: IdSchema,
  case_kind: ControlCaseKindV1Schema,
  request_variant: ControlRequestVariantV1Schema,
  oracle: OracleItemBindingV1Schema,
  accepted_equivalences: OracleItemBindingV1Schema,
  expected_structural_disposition: Type.Literal("PASS"),
  applicable_clause_ids: Type.Array(IdSchema, {
    minItems: 1,
    maxItems: 16,
    uniqueItems: true,
  }),
  expected_semantic_disposition: ControlDispositionV1Schema,
  expected_review: SemanticTrialReviewOutputV1Schema,
  reuse_policy: TaskReusePolicyV1Schema,
};

const DecideSemanticJudgeControlV1Schema = Type.Object(
  {
    ...ControlCommonProperties,
    skill: Type.Literal("decide"),
    output: DecisionSemanticEvaluationV3Schema,
  },
  { additionalProperties: false }
);
const PlanSemanticJudgeControlV1Schema = Type.Object(
  {
    ...ControlCommonProperties,
    skill: Type.Literal("plan"),
    output: StrategyEvaluationV2Schema,
    semantic_review_wire: PlanSemanticReviewWireV2Schema,
  },
  { additionalProperties: false }
);

export const EvaluationCalibrationSemanticJudgeControlV1Schema = Type.Union([
  DecideSemanticJudgeControlV1Schema,
  PlanSemanticJudgeControlV1Schema,
]);
export type EvaluationCalibrationSemanticJudgeControlV1 = Readonly<
  Static<typeof EvaluationCalibrationSemanticJudgeControlV1Schema>
>;

const ArmBindingV1Schema = Type.Object(
  {
    arm_id: IdSchema,
    arm_kind: Type.Union([
      Type.Literal("direct_baseline"),
      Type.Literal("candidate"),
      Type.Literal("ablation"),
    ]),
    binding_sha256: DigestSchema,
  },
  { additionalProperties: false }
);
export type EvaluationCalibrationArmBindingV1 = Readonly<Static<typeof ArmBindingV1Schema>>;

const ScheduledTaskArmV1Schema = Type.Object(
  {
    task_id: IdSchema,
    arm_id: IdSchema,
    route: Type.Union([
      Type.Literal("all_arm_common"),
      Type.Literal("candidate_only_product_integrity"),
    ]),
  },
  { additionalProperties: false }
);

export const EvaluationCalibrationScheduleV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evaluation-calibration-schedule.v1"),
    schema_version: Type.Literal(1),
    split: SplitSchema,
    scoring: ScoringSchema,
    schedule_id: IdSchema,
    package_id: IdSchema,
    repetitions: Type.Literal("owner_parameter"),
    arms: Type.Array(ArmBindingV1Schema, { minItems: 3, maxItems: 3 }),
    common_task_ids: Type.Array(IdSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
    candidate_only_task_ids: Type.Array(IdSchema, { maxItems: 32, uniqueItems: true }),
    task_arm_pairs: Type.Array(ScheduledTaskArmV1Schema, { minItems: 3, maxItems: 256 }),
    q2_scope: Type.Literal("common_tasks_only"),
    candidate_only_exclusion: Type.Literal(
      "excluded_from_arm_comparison_q2_symmetry_and_direct_baseline_or_ablation_execution"
    ),
    accounting: Type.Object(
      {
        scheduled_task_arm_pair_count: Type.Integer({ minimum: 1, maximum: 256 }),
        execution_trial_formula: Type.String({ minLength: 1, maxLength: 256 }),
        trial_judge_call_formula: Type.String({ minLength: 1, maxLength: 256 }),
        oracle_judge_call_formula: Type.String({ minLength: 1, maxLength: 256 }),
        maximum_provider_call_formula: Type.String({ minLength: 1, maxLength: 512 }),
        maximum_model_turn_formula: Type.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false }
    ),
    reuse_policy: TaskReusePolicyV1Schema,
  },
  { additionalProperties: false }
);
export type EvaluationCalibrationScheduleV1 = Readonly<
  Static<typeof EvaluationCalibrationScheduleV1Schema>
>;

const CorpusFingerprintMetadataV1Schema = Type.Object(
  {
    corpus_id: IdSchema,
    corpus_class: Type.Union([
      Type.Literal("development"),
      Type.Literal("calibration"),
      Type.Literal("held_out"),
      Type.Literal("test"),
      Type.Literal("historical"),
    ]),
    metadata_only: Type.Boolean(),
    oracle_bodies_consumed: Type.Literal(false),
    task_ids: Type.Array(IdSchema, { maxItems: 4_096, uniqueItems: true }),
    domains: Type.Array(IdSchema, { maxItems: 1_024, uniqueItems: true }),
    canonical_task_body_sha256s: Type.Array(DigestSchema, {
      maxItems: 4_096,
      uniqueItems: true,
    }),
    exact_input_byte_sha256s: Type.Array(DigestSchema, {
      maxItems: 4_096,
      uniqueItems: true,
    }),
    source_material_sha256s: Type.Array(DigestSchema, {
      maxItems: 4_096,
      uniqueItems: true,
    }),
    material_sha256s: Type.Array(DigestSchema, { maxItems: 4_096, uniqueItems: true }),
    oracle_sha256s: Type.Array(DigestSchema, { maxItems: 4_096, uniqueItems: true }),
    equivalence_sha256s: Type.Array(DigestSchema, { maxItems: 4_096, uniqueItems: true }),
  },
  { additionalProperties: false }
);

const ScreenedPackageFingerprintsV1Schema = Type.Object(
  {
    package_id: IdSchema,
    task_ids: Type.Array(IdSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
    domains: Type.Array(IdSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
    canonical_task_body_sha256s: Type.Array(DigestSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    exact_input_byte_sha256s: Type.Array(DigestSchema, { maxItems: 32, uniqueItems: true }),
    source_material_sha256s: Type.Array(DigestSchema, { maxItems: 64, uniqueItems: true }),
    material_sha256s: Type.Array(DigestSchema, { minItems: 1, maxItems: 128, uniqueItems: true }),
    oracle_sha256s: Type.Array(DigestSchema, { minItems: 1, maxItems: 64, uniqueItems: true }),
    equivalence_sha256s: Type.Array(DigestSchema, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export const EvaluationCalibrationContaminationFingerprintManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evaluation-calibration-contamination-fingerprint-manifest.v1"),
    schema_version: Type.Literal(1),
    inventory_binding: Type.Object(
      {
        artifact_id: ArtifactIdSchema,
        content_digest: DigestSchema,
        comparison_rule: Type.Literal("sha256_canonical_json_goal_constraints"),
      },
      { additionalProperties: false }
    ),
    prohibited_corpora: Type.Array(CorpusFingerprintMetadataV1Schema, {
      minItems: 1,
      maxItems: 128,
    }),
    screened_package: ScreenedPackageFingerprintsV1Schema,
    comparison_result: Type.Literal("PASS_EXACT_METADATA_SCREEN"),
    semantic_overlap_claim: Type.Literal("not_claimed_metadata_only"),
    held_out_oracle_body_access: Type.Literal("none"),
  },
  { additionalProperties: false }
);
export type EvaluationCalibrationContaminationFingerprintManifestV1 = Readonly<
  Static<typeof EvaluationCalibrationContaminationFingerprintManifestV1Schema>
>;

export const EvaluationCalibrationPackageV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evaluation-calibration-package.v1"),
    schema_version: Type.Literal(1),
    package_id: IdSchema,
    skill: Type.Union([Type.Literal("decide"), Type.Literal("plan")]),
    split: SplitSchema,
    scoring: ScoringSchema,
    status: Type.Literal("provider_free_prepared_awaiting_owner_parameters"),
    cohort_id: IdSchema,
    schedule_id: IdSchema,
    components: Type.Array(ComponentBindingV1Schema, { minItems: 8, maxItems: 64 }),
    package_sha256: DigestSchema,
    reuse_policy: TaskReusePolicyV1Schema,
  },
  { additionalProperties: false }
);
export type EvaluationCalibrationPackageV1 = Readonly<
  Static<typeof EvaluationCalibrationPackageV1Schema>
>;

const CurrentBindingV1Schema = Type.Object(
  {
    candidate_contract_sha256: DigestSchema,
    runtime_registration_sha256: DigestSchema,
    evaluator_implementation_binding_sha256: DigestSchema,
    security_closeout_sha256: DigestSchema,
    historical_preservation_manifest_sha256: DigestSchema,
    historical_preservation_verified_entries: Type.Literal(334),
    historical_preservation_mismatches: Type.Literal(0),
  },
  { additionalProperties: false }
);

const PreparationDigestsV1Schema = Type.Object(
  {
    package_sha256: DigestSchema,
    schedule_sha256: DigestSchema,
    contamination_manifest_sha256: DigestSchema,
    oracle_bundle_sha256: DigestSchema,
    accepted_equivalence_bundle_sha256: DigestSchema,
    semantic_judge_controls_sha256: DigestSchema,
    oracle_review_packets_sha256: DigestSchema,
    judge_prompt_sha256: DigestSchema,
    schema_bundle_sha256: DigestSchema,
    implementation_sha256: DigestSchema,
  },
  { additionalProperties: false }
);

export const EvaluationCalibrationPreparationEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evaluation-calibration-preparation-evidence.v1"),
    schema_version: Type.Literal(1),
    package_id: IdSchema,
    status: Type.Literal("awaiting_owner_parameters"),
    provider_calls: Type.Literal(0),
    credentials_accessed: Type.Literal(false),
    held_out_created: Type.Literal(false),
    approval_created: Type.Literal(false),
    enabled_or_promoted: Type.Literal(false),
    protected_history_modified: Type.Literal(false),
    digests: PreparationDigestsV1Schema,
    current_bindings: CurrentBindingV1Schema,
    arms: Type.Array(ArmBindingV1Schema, { minItems: 3, maxItems: 3 }),
    path_policy: Type.Object(
      {
        tracked_paths_contain_operator_filesystem: Type.Literal(false),
        state_root: Type.Literal("owner_required_fresh_ignored_absolute_path"),
        evidence_root: Type.Literal("owner_required_fresh_ignored_absolute_path"),
        documentation_uses_project_root_placeholder_only: Type.Literal(true),
      },
      { additionalProperties: false }
    ),
    accounting: EvaluationCalibrationScheduleV1Schema.properties.accounting,
    unresolved_owner_fields: Type.Array(IdSchema, { minItems: 1, maxItems: 64, uniqueItems: true }),
    reuse_policy: TaskReusePolicyV1Schema,
  },
  { additionalProperties: false }
);
export type EvaluationCalibrationPreparationEvidenceV1 = Readonly<
  Static<typeof EvaluationCalibrationPreparationEvidenceV1Schema>
>;

const UnresolvedOwnerParametersV1Schema = Type.Object(
  {
    authorization_id: Type.Null(),
    judge_provider: Type.Null(),
    judge_model: Type.Null(),
    judge_thinking_level: Type.Null(),
    repetitions: Type.Null(),
    max_concurrency: Type.Null(),
    max_calls: Type.Null(),
    max_retries: Type.Null(),
    max_input_tokens: Type.Null(),
    max_output_tokens: Type.Null(),
    max_total_tokens: Type.Null(),
    max_storage_bytes: Type.Null(),
    max_spend_microusd: Type.Null(),
    max_wall_clock_ms: Type.Null(),
    max_execution_calls_per_trial: Type.Null(),
    max_execution_turns_per_trial: Type.Null(),
    state_root: Type.Null(),
    evidence_root: Type.Null(),
    allowed_egress_origins: Type.Null(),
    credential_scope: Type.Null(),
    not_before: Type.Null(),
    expires_at: Type.Null(),
    nonce: Type.Null(),
    owner_id: Type.Null(),
    approval_verification_material: Type.Null(),
    compatibility_execution_binding_agent: Type.Null(),
    execution_fleet_model_ids: Type.Null(),
    execution_fleet_rate_cards: Type.Null(),
    judge_rate_card: Type.Null(),
    owner_verifier_module: Type.Null(),
  },
  { additionalProperties: false }
);

export const EvaluationCalibrationAuthorizationRequestTemplateV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evaluation-calibration-authorization-request-template.v1"),
    schema_version: Type.Literal(1),
    status: Type.Literal("awaiting_owner_parameters"),
    scope: Type.Literal("evaluation_live_calibration"),
    authorization_request_id: IdSchema,
    package_id: IdSchema,
    package_sha256: DigestSchema,
    schedule_sha256: DigestSchema,
    arms: Type.Array(ArmBindingV1Schema, { minItems: 3, maxItems: 3 }),
    active_execution_fleet_requirements: Type.Array(
      Type.Object(
        {
          agent: IdSchema,
          ssot_model: IdSchema,
          provider: IdSchema,
          model: Type.Null(),
          runtime: IdSchema,
          thinking_level: Type.Union([
            Type.Literal("off"),
            Type.Literal("minimal"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("xhigh"),
          ]),
          allowed_origin: Type.Null(),
          rates: Type.Null(),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 16 }
    ),
    judge_runtime_requirement: IdSchema,
    judge_contract: Type.Object(
      {
        judge_definition_sha256: DigestSchema,
        judge_prompt_sha256: DigestSchema,
        trial_packet_schema_sha256: DigestSchema,
        oracle_packet_schema_sha256: DigestSchema,
        trial_output_schema_sha256: DigestSchema,
        oracle_output_schema_sha256: DigestSchema,
        implementation_sha256: DigestSchema,
      },
      { additionalProperties: false }
    ),
    unresolved_owner_parameters: UnresolvedOwnerParametersV1Schema,
    accounting: EvaluationCalibrationScheduleV1Schema.properties.accounting,
    transition_rule: Type.Literal(
      "not_an_authorization_manifest_until_every_owner_parameter_and_separate_owner_approval_are_supplied"
    ),
    forbidden_actions: Type.Array(
      Type.Union([
        Type.Literal("candidate_enablement"),
        Type.Literal("held_out_creation"),
        Type.Literal("historical_edit"),
        Type.Literal("package_movement"),
        Type.Literal("production_registration"),
        Type.Literal("promotion"),
      ]),
      { minItems: 6, maxItems: 6, uniqueItems: true }
    ),
  },
  { additionalProperties: false }
);
export type EvaluationCalibrationAuthorizationRequestTemplateV1 = Readonly<
  Static<typeof EvaluationCalibrationAuthorizationRequestTemplateV1Schema>
>;

export const PlanCalibrationSourceAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.plan-calibration-source-admission.v1"),
    schema_version: Type.Literal(1),
    task_id: IdSchema,
    artifact_id: ArtifactIdSchema,
    source_sha256: DigestSchema,
    source_byte_length: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    admission_status: Type.Literal("host_verified_admitted_for_echo"),
  },
  { additionalProperties: false }
);
export type PlanCalibrationSourceAdmissionV1 = Readonly<
  Static<typeof PlanCalibrationSourceAdmissionV1Schema>
>;

export const AuthorizedPlanSemanticEvidenceProjectionV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.authorized-plan-semantic-evidence-projection.v1"),
    schema_version: Type.Literal(1),
    task_id: IdSchema,
    request: PlanSemanticRequestProjectionV1Schema,
    projection_sha256: DigestSchema,
  },
  { additionalProperties: false }
);
export type AuthorizedPlanSemanticEvidenceProjectionV1 = Readonly<
  Static<typeof AuthorizedPlanSemanticEvidenceProjectionV1Schema>
>;

function validateCanonicalContract<TSchemaValue extends TSchema>(input: {
  readonly schema: TSchemaValue;
  readonly value: unknown;
  readonly label: string;
}): Static<TSchemaValue> {
  let value = input.value;
  let suppliedBytes: string | undefined;
  if (typeof value === "string") {
    suppliedBytes = value;
    value = strictParseJson(value);
  } else if (value instanceof Uint8Array) {
    suppliedBytes = new TextDecoder("utf-8", { fatal: true }).decode(value);
    value = strictParseJson(suppliedBytes);
  }
  const validated = validateContract(input.schema, value, input.label);
  const canonical = canonicalJson(validated);
  if (suppliedBytes !== undefined && suppliedBytes !== canonical) {
    throw new Error(`${input.label} must use exact canonical JSON bytes`);
  }
  return validated;
}

function requireUnique(values: readonly string[], label: string): void {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) throw new Error(`${label} contains duplicate '${duplicate}'`);
}

function requireCanonicalSorted(values: readonly string[], label: string): void {
  requireUnique(values, label);
  if (
    canonicalJson(values) !==
    canonicalJson([...values].sort((left, right) => left.localeCompare(right)))
  ) {
    throw new Error(`${label} must be canonically sorted`);
  }
}

function validateProjectRelativePath(value: string, label: string): void {
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error(`${label} must be a normalized project-relative path`);
  }
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function calibrationCanonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function calibrationDerivedRequestId(canonicalRequest: unknown): string {
  return `calreq_${calibrationCanonicalSha256(canonicalRequest)}`;
}

export function calibrationTaskBodySha256(input: {
  readonly goal: string;
  readonly constraints: unknown;
}): string {
  return calibrationCanonicalSha256({ goal: input.goal, constraints: input.constraints });
}

function expectedCanonicalRequest(task: EvaluationCalibrationTaskV1): unknown {
  return task.skill === "decide"
    ? canonicalizeDecisionRequest({
        goal: task.runtime_task.goal,
        constraints: task.runtime_task.constraints,
      })
    : canonicalizePlanRequest({
        goal: task.runtime_task.goal,
        constraints: task.runtime_task.constraints,
        exactInputArtifactIds: task.runtime_task.exact_input_artifact_ids,
      });
}

function validateReusePolicy(policy: EvaluationCalibrationTaskV1["reuse_policy"]): void {
  if (canonicalJson(policy.forbidden_uses) !== canonicalJson(CALIBRATION_FORBIDDEN_REUSE)) {
    throw new Error("calibration forbidden-use policy is incomplete or noncanonical");
  }
}

export function validateEvaluationCalibrationTask(
  value: unknown,
  exactInputBytes: ReadonlyMap<string, Uint8Array> = new Map()
): EvaluationCalibrationTaskV1 {
  const task = validateCanonicalContract({
    schema: EvaluationCalibrationTaskV1Schema,
    value,
    label: "evaluation calibration task V1",
  });
  validateReusePolicy(task.reuse_policy);
  if (
    task.runtime_task.task_id !== task.task_id ||
    task.runtime_task.split !== task.split ||
    canonicalJson(task.runtime_task.host_only_oracle_markers) !==
      canonicalJson(
        [...task.runtime_task.host_only_oracle_markers].sort((left, right) =>
          left.localeCompare(right)
        )
      )
  ) {
    throw new Error("calibration runtime task identity, split, or marker order drifted");
  }
  const canonicalRequest = expectedCanonicalRequest(task);
  const requestSha256 = calibrationCanonicalSha256(canonicalRequest);
  if (
    canonicalJson(canonicalRequest) !== canonicalJson(task.canonical_request) ||
    task.request_binding.canonical_request_sha256 !== requestSha256 ||
    task.request_binding.derived_request_id !== calibrationDerivedRequestId(canonicalRequest) ||
    task.request_binding.canonical_task_body_sha256 !==
      calibrationTaskBodySha256({
        goal: task.runtime_task.goal,
        constraints: task.runtime_task.constraints,
      })
  ) {
    throw new Error("calibration request binding drifted from its canonical request or task body");
  }
  requireCanonicalSorted(
    task.runtime_task.exact_input_artifact_ids,
    "calibration exact input artifact IDs"
  );
  const exactBindings = new Map(task.exact_inputs.map((binding) => [binding.artifact_id, binding]));
  if (
    exactBindings.size !== task.exact_inputs.length ||
    canonicalJson([...exactBindings.keys()].sort()) !==
      canonicalJson(task.runtime_task.exact_input_artifact_ids)
  ) {
    throw new Error("calibration exact input bindings do not match the runtime task");
  }
  for (const binding of task.exact_inputs) {
    validateProjectRelativePath(binding.source_path, "calibration exact-input source path");
    if (binding.artifact_id !== `art_${binding.sha256}`) {
      throw new Error("calibration exact-input artifact ID must bind its exact byte digest");
    }
    const bytes = exactInputBytes.get(binding.artifact_id);
    if (bytes === undefined) {
      if (exactInputBytes.size > 0) {
        throw new Error(`calibration exact input '${binding.artifact_id}' bytes are absent`);
      }
      continue;
    }
    if (bytes.byteLength !== binding.byte_length || sha256Bytes(bytes) !== binding.sha256) {
      throw new Error(`calibration exact input '${binding.artifact_id}' bytes drifted`);
    }
  }
  if (
    task.routing.kind === "candidate_only_product_integrity" &&
    (task.skill !== "plan" ||
      task.semantic_projection_policy.kind !== "post_admission_authorized_semantic_evidence" ||
      task.exact_inputs.length !== 1)
  ) {
    throw new Error(
      "candidate-only product-integrity calibration requires one Plan source and an admitted-evidence projection"
    );
  }
  if (
    task.routing.kind === "all_arm_common" &&
    task.semantic_projection_policy.kind !== "request_only"
  ) {
    throw new Error("all-arm common calibration tasks require request-only semantic projection");
  }
  return task;
}

export function buildEvaluationCalibrationTaskV1(
  input: Omit<
    EvaluationCalibrationTaskV1,
    "schema_id" | "schema_version" | "split" | "scoring" | "request_binding" | "reuse_policy"
  >,
  exactInputBytes: ReadonlyMap<string, Uint8Array> = new Map()
): EvaluationCalibrationTaskV1 {
  const draft = {
    schema_id: "penny.evaluation-calibration-task.v1",
    schema_version: 1,
    split: "calibration",
    scoring: "non_scoring",
    ...input,
    request_binding: {
      derived_request_id: calibrationDerivedRequestId(input.canonical_request),
      canonical_request_sha256: calibrationCanonicalSha256(input.canonical_request),
      canonical_task_body_sha256: calibrationTaskBodySha256({
        goal: input.runtime_task.goal,
        constraints: input.runtime_task.constraints,
      }),
    },
    reuse_policy: {
      scoring: "non_scoring",
      forbidden_uses: CALIBRATION_FORBIDDEN_REUSE,
    },
  };
  return validateEvaluationCalibrationTask(draft, exactInputBytes);
}

export function validateEvaluationCalibrationCohort(
  value: unknown,
  exactInputBytes: ReadonlyMap<string, Uint8Array> = new Map()
): EvaluationCalibrationCohortV1 {
  const cohort = validateCanonicalContract({
    schema: EvaluationCalibrationCohortV1Schema,
    value,
    label: "evaluation calibration cohort V1",
  });
  validateReusePolicy(cohort.reuse_policy);
  requireUnique(
    cohort.tasks.map((task) => task.task_id),
    "calibration cohort task IDs"
  );
  requireUnique(
    cohort.tasks.flatMap((task) => task.runtime_task.host_only_oracle_markers),
    "calibration cohort oracle markers"
  );
  for (const task of cohort.tasks) validateEvaluationCalibrationTask(task, exactInputBytes);
  return cohort;
}

export function buildEvaluationCalibrationCohortV1(input: {
  readonly cohort_id: string;
  readonly revision: number;
  readonly tasks: readonly EvaluationCalibrationTaskV1[];
}): EvaluationCalibrationCohortV1 {
  return validateEvaluationCalibrationCohort({
    schema_id: "penny.evaluation-calibration-cohort.v1",
    schema_version: 1,
    split: "calibration",
    scoring: "non_scoring",
    cohort_id: input.cohort_id,
    revision: input.revision,
    tasks: input.tasks,
    reuse_policy: {
      scoring: "non_scoring",
      forbidden_uses: CALIBRATION_FORBIDDEN_REUSE,
    },
  });
}

function validateControlRequestVariant(
  skill: "decide" | "plan",
  variant: Static<typeof ControlRequestVariantV1Schema>
): void {
  const expected =
    skill === "decide"
      ? canonicalizeDecisionRequest({ goal: variant.goal, constraints: variant.constraints })
      : canonicalizePlanRequest({
          goal: variant.goal,
          constraints: variant.constraints,
          exactInputArtifactIds: variant.exact_input_artifact_ids,
        });
  if (
    canonicalJson(expected) !== canonicalJson(variant.canonical_request) ||
    variant.canonical_request_sha256 !== calibrationCanonicalSha256(expected) ||
    variant.derived_request_id !== calibrationDerivedRequestId(expected) ||
    variant.canonical_task_body_sha256 !==
      calibrationTaskBodySha256({ goal: variant.goal, constraints: variant.constraints })
  ) {
    throw new Error("semantic judge control request variant drifted");
  }
}

export function validateEvaluationCalibrationSemanticJudgeControl(
  value: unknown
): EvaluationCalibrationSemanticJudgeControlV1 {
  const control = validateCanonicalContract({
    schema: EvaluationCalibrationSemanticJudgeControlV1Schema,
    value,
    label: "evaluation calibration semantic judge control V1",
  });
  validateReusePolicy(control.reuse_policy);
  validateControlRequestVariant(control.skill, control.request_variant);
  if (control.expected_review.review_kind !== "trial") {
    throw new Error("calibration semantic judge control requires a trial review output");
  }
  const resultsByClause = new Map<string, (typeof control.expected_review.clause_results)[number]>(
    control.expected_review.clause_results.map((clause) => [clause.clause_id, clause])
  );
  const applicableClauseIds = new Set<string>(control.applicable_clause_ids);
  if (
    resultsByClause.size !== control.expected_review.clause_results.length ||
    control.applicable_clause_ids.some((clauseId) => !resultsByClause.has(clauseId))
  ) {
    throw new Error("calibration semantic control clause applicability is duplicate or foreign");
  }
  const applicableOutcomes = control.applicable_clause_ids.map((clauseId) => {
    const result = resultsByClause.get(clauseId);
    if (result === undefined) throw new Error("calibration semantic control clause is absent");
    return result.outcome;
  });
  if (
    control.expected_review.clause_results.some(
      (result) => !applicableClauseIds.has(result.clause_id) && result.outcome !== "UNVERIFIABLE"
    )
  ) {
    throw new Error("non-applicable calibration clauses must remain UNVERIFIABLE");
  }
  const expectedDisposition = applicableOutcomes.includes("FAIL")
    ? "FAIL"
    : applicableOutcomes.includes("UNVERIFIABLE")
      ? "BLOCKED"
      : "PASS";
  if (control.expected_semantic_disposition !== expectedDisposition) {
    throw new Error(
      "calibration semantic control disposition does not match applicable clause outcomes"
    );
  }
  return control;
}

export function buildEvaluationCalibrationSemanticJudgeControlV1(
  input: Omit<
    EvaluationCalibrationSemanticJudgeControlV1,
    "schema_id" | "schema_version" | "split" | "scoring" | "reuse_policy"
  >
): EvaluationCalibrationSemanticJudgeControlV1 {
  return validateEvaluationCalibrationSemanticJudgeControl({
    schema_id: "penny.evaluation-calibration-semantic-judge-control.v1",
    schema_version: 1,
    split: "calibration",
    scoring: "non_scoring",
    ...input,
    reuse_policy: {
      scoring: "non_scoring",
      forbidden_uses: CALIBRATION_FORBIDDEN_REUSE,
    },
  });
}

export function validateEvaluationCalibrationSchedule(
  value: unknown
): EvaluationCalibrationScheduleV1 {
  const schedule = validateCanonicalContract({
    schema: EvaluationCalibrationScheduleV1Schema,
    value,
    label: "evaluation calibration schedule V1",
  });
  validateReusePolicy(schedule.reuse_policy);
  const armIds = schedule.arms.map((arm) => arm.arm_id);
  requireCanonicalSorted(armIds, "calibration schedule arm IDs");
  if (new Set(schedule.arms.map((arm) => arm.arm_kind)).size !== 3) {
    throw new Error("calibration schedule requires one direct baseline, candidate, and ablation");
  }
  requireCanonicalSorted(schedule.common_task_ids, "calibration common task IDs");
  requireCanonicalSorted(schedule.candidate_only_task_ids, "calibration candidate-only task IDs");
  const candidateArm = schedule.arms.find((arm) => arm.arm_kind === "candidate");
  if (candidateArm === undefined) throw new Error("calibration candidate arm is absent");
  const expectedPairs = [
    ...schedule.common_task_ids.flatMap((taskId) =>
      armIds.map((armId) => ({ task_id: taskId, arm_id: armId, route: "all_arm_common" }))
    ),
    ...schedule.candidate_only_task_ids.map((taskId) => ({
      task_id: taskId,
      arm_id: candidateArm.arm_id,
      route: "candidate_only_product_integrity",
    })),
  ];
  if (canonicalJson(schedule.task_arm_pairs) !== canonicalJson(expectedPairs)) {
    throw new Error(
      "calibration schedule task-arm matrix is incomplete, asymmetric, or noncanonical"
    );
  }
  if (schedule.accounting.scheduled_task_arm_pair_count !== expectedPairs.length) {
    throw new Error("calibration schedule accounting drifted from its task-arm matrix");
  }
  return schedule;
}

export function buildEvaluationCalibrationScheduleV1(input: {
  readonly schedule_id: string;
  readonly package_id: string;
  readonly arms: readonly EvaluationCalibrationArmBindingV1[];
  readonly common_task_ids: readonly string[];
  readonly candidate_only_task_ids: readonly string[];
  readonly oracle_variant_count: number;
}): EvaluationCalibrationScheduleV1 {
  const arms = [...input.arms].sort((left, right) => left.arm_id.localeCompare(right.arm_id));
  const commonTaskIds = [...input.common_task_ids].sort((left, right) => left.localeCompare(right));
  const candidateOnlyTaskIds = [...input.candidate_only_task_ids].sort((left, right) =>
    left.localeCompare(right)
  );
  const candidateArm = arms.find((arm) => arm.arm_kind === "candidate");
  if (candidateArm === undefined) throw new Error("calibration candidate arm is absent");
  const taskArmPairs = [
    ...commonTaskIds.flatMap((taskId) =>
      arms.map((arm) => ({
        task_id: taskId,
        arm_id: arm.arm_id,
        route: "all_arm_common" as const,
      }))
    ),
    ...candidateOnlyTaskIds.map((taskId) => ({
      task_id: taskId,
      arm_id: candidateArm.arm_id,
      route: "candidate_only_product_integrity" as const,
    })),
  ];
  const pairCount = taskArmPairs.length;
  return validateEvaluationCalibrationSchedule({
    schema_id: "penny.evaluation-calibration-schedule.v1",
    schema_version: 1,
    split: "calibration",
    scoring: "non_scoring",
    schedule_id: input.schedule_id,
    package_id: input.package_id,
    repetitions: "owner_parameter",
    arms,
    common_task_ids: commonTaskIds,
    candidate_only_task_ids: candidateOnlyTaskIds,
    task_arm_pairs: taskArmPairs,
    q2_scope: "common_tasks_only",
    candidate_only_exclusion:
      "excluded_from_arm_comparison_q2_symmetry_and_direct_baseline_or_ablation_execution",
    accounting: {
      scheduled_task_arm_pair_count: pairCount,
      execution_trial_formula: `${pairCount} * owner.repetitions`,
      trial_judge_call_formula: `${pairCount} * owner.repetitions`,
      oracle_judge_call_formula: `${input.oracle_variant_count}`,
      maximum_provider_call_formula: `(${pairCount} * owner.repetitions * owner.max_execution_calls_per_trial) + (${pairCount} * owner.repetitions) + ${input.oracle_variant_count}`,
      maximum_model_turn_formula: `(${pairCount} * owner.repetitions * owner.max_execution_turns_per_trial) + (${pairCount} * owner.repetitions) + ${input.oracle_variant_count}`,
    },
    reuse_policy: {
      scoring: "non_scoring",
      forbidden_uses: CALIBRATION_FORBIDDEN_REUSE,
    },
  });
}

function flattenProhibited(
  manifest: EvaluationCalibrationContaminationFingerprintManifestV1,
  field:
    | "task_ids"
    | "domains"
    | "canonical_task_body_sha256s"
    | "exact_input_byte_sha256s"
    | "source_material_sha256s"
    | "material_sha256s"
    | "oracle_sha256s"
    | "equivalence_sha256s"
): Set<string> {
  return new Set(manifest.prohibited_corpora.flatMap((corpus) => corpus[field]));
}

export function validateEvaluationCalibrationContaminationFingerprintManifest(
  value: unknown
): EvaluationCalibrationContaminationFingerprintManifestV1 {
  const manifest = validateCanonicalContract({
    schema: EvaluationCalibrationContaminationFingerprintManifestV1Schema,
    value,
    label: "evaluation calibration contamination fingerprint manifest V1",
  });
  requireUnique(
    manifest.prohibited_corpora.map((corpus) => corpus.corpus_id),
    "prohibited corpus IDs"
  );
  const comparisons = [
    ["task_ids", manifest.screened_package.task_ids],
    ["domains", manifest.screened_package.domains],
    ["canonical_task_body_sha256s", manifest.screened_package.canonical_task_body_sha256s],
    ["exact_input_byte_sha256s", manifest.screened_package.exact_input_byte_sha256s],
    ["source_material_sha256s", manifest.screened_package.source_material_sha256s],
    ["material_sha256s", manifest.screened_package.material_sha256s],
    ["oracle_sha256s", manifest.screened_package.oracle_sha256s],
    ["equivalence_sha256s", manifest.screened_package.equivalence_sha256s],
  ] as const;
  for (const [field, candidates] of comparisons) {
    const prohibited = flattenProhibited(manifest, field);
    const collision = candidates.find((candidate) => prohibited.has(candidate));
    if (collision !== undefined) {
      throw new Error(`calibration contamination collision in ${field}: '${collision}'`);
    }
  }
  if (
    manifest.prohibited_corpora
      .filter((corpus) => corpus.corpus_class === "held_out")
      .some((corpus) => !corpus.metadata_only || corpus.oracle_bodies_consumed)
  ) {
    throw new Error("held-out contamination checks must consume metadata and fingerprints only");
  }
  return manifest;
}

export function buildEvaluationCalibrationContaminationFingerprintManifestV1(input: {
  readonly inventory_binding: EvaluationCalibrationContaminationFingerprintManifestV1["inventory_binding"];
  readonly prohibited_corpora: readonly EvaluationCalibrationContaminationFingerprintManifestV1["prohibited_corpora"][number][];
  readonly screened_package: EvaluationCalibrationContaminationFingerprintManifestV1["screened_package"];
}): EvaluationCalibrationContaminationFingerprintManifestV1 {
  return validateEvaluationCalibrationContaminationFingerprintManifest({
    schema_id: "penny.evaluation-calibration-contamination-fingerprint-manifest.v1",
    schema_version: 1,
    inventory_binding: input.inventory_binding,
    prohibited_corpora: input.prohibited_corpora,
    screened_package: input.screened_package,
    comparison_result: "PASS_EXACT_METADATA_SCREEN",
    semantic_overlap_claim: "not_claimed_metadata_only",
    held_out_oracle_body_access: "none",
  });
}

export function calibrationPackageBodySha256(
  value: Omit<EvaluationCalibrationPackageV1, "package_sha256">
): string {
  return calibrationCanonicalSha256(value);
}

export function validateEvaluationCalibrationPackage(
  value: unknown
): EvaluationCalibrationPackageV1 {
  const packageRecord = validateCanonicalContract({
    schema: EvaluationCalibrationPackageV1Schema,
    value,
    label: "evaluation calibration package V1",
  });
  validateReusePolicy(packageRecord.reuse_policy);
  requireCanonicalSorted(
    packageRecord.components.map((component) => component.component_id),
    "calibration package component IDs"
  );
  requireUnique(
    packageRecord.components.map((component) => component.path),
    "calibration package component paths"
  );
  for (const component of packageRecord.components) {
    validateProjectRelativePath(component.path, "calibration package component path");
  }
  const { package_sha256: ignoredPackageSha256, ...body } = packageRecord;
  void ignoredPackageSha256;
  if (packageRecord.package_sha256 !== calibrationPackageBodySha256(body)) {
    throw new Error("calibration package digest drifted from its canonical body");
  }
  return packageRecord;
}

export function buildEvaluationCalibrationPackageV1(
  input: Omit<
    EvaluationCalibrationPackageV1,
    | "schema_id"
    | "schema_version"
    | "split"
    | "scoring"
    | "status"
    | "package_sha256"
    | "reuse_policy"
  >
): EvaluationCalibrationPackageV1 {
  const body = {
    schema_id: "penny.evaluation-calibration-package.v1" as const,
    schema_version: 1 as const,
    package_id: input.package_id,
    skill: input.skill,
    split: "calibration" as const,
    scoring: "non_scoring" as const,
    status: "provider_free_prepared_awaiting_owner_parameters" as const,
    cohort_id: input.cohort_id,
    schedule_id: input.schedule_id,
    components: [...input.components].sort((left, right) =>
      left.component_id.localeCompare(right.component_id)
    ),
    reuse_policy: {
      scoring: "non_scoring" as const,
      forbidden_uses: [...CALIBRATION_FORBIDDEN_REUSE],
    },
  };
  return validateEvaluationCalibrationPackage({
    ...body,
    package_sha256: calibrationPackageBodySha256(body),
  });
}

export function validateEvaluationCalibrationPreparationEvidence(
  value: unknown
): EvaluationCalibrationPreparationEvidenceV1 {
  const evidence = validateCanonicalContract({
    schema: EvaluationCalibrationPreparationEvidenceV1Schema,
    value,
    label: "evaluation calibration preparation evidence V1",
  });
  validateReusePolicy(evidence.reuse_policy);
  requireCanonicalSorted(
    evidence.arms.map((arm) => arm.arm_id),
    "preparation evidence arm IDs"
  );
  requireCanonicalSorted(evidence.unresolved_owner_fields, "unresolved owner fields");
  return evidence;
}

export function buildEvaluationCalibrationPreparationEvidenceV1(
  input: Omit<
    EvaluationCalibrationPreparationEvidenceV1,
    | "schema_id"
    | "schema_version"
    | "status"
    | "provider_calls"
    | "credentials_accessed"
    | "held_out_created"
    | "approval_created"
    | "enabled_or_promoted"
    | "protected_history_modified"
    | "reuse_policy"
  >
): EvaluationCalibrationPreparationEvidenceV1 {
  return validateEvaluationCalibrationPreparationEvidence({
    schema_id: "penny.evaluation-calibration-preparation-evidence.v1",
    schema_version: 1,
    package_id: input.package_id,
    status: "awaiting_owner_parameters",
    provider_calls: 0,
    credentials_accessed: false,
    held_out_created: false,
    approval_created: false,
    enabled_or_promoted: false,
    protected_history_modified: false,
    digests: input.digests,
    current_bindings: input.current_bindings,
    arms: [...input.arms].sort((left, right) => left.arm_id.localeCompare(right.arm_id)),
    path_policy: input.path_policy,
    accounting: input.accounting,
    unresolved_owner_fields: [...input.unresolved_owner_fields].sort((left, right) =>
      left.localeCompare(right)
    ),
    reuse_policy: {
      scoring: "non_scoring",
      forbidden_uses: CALIBRATION_FORBIDDEN_REUSE,
    },
  });
}

const AUTHORIZATION_FORBIDDEN_ACTIONS = [
  "candidate_enablement",
  "held_out_creation",
  "historical_edit",
  "package_movement",
  "production_registration",
  "promotion",
] as const;

export function validateEvaluationCalibrationAuthorizationRequestTemplate(
  value: unknown
): EvaluationCalibrationAuthorizationRequestTemplateV1 {
  const template = validateCanonicalContract({
    schema: EvaluationCalibrationAuthorizationRequestTemplateV1Schema,
    value,
    label: "evaluation calibration authorization request template V1",
  });
  requireCanonicalSorted(
    template.arms.map((arm) => arm.arm_id),
    "authorization request arm IDs"
  );
  requireCanonicalSorted(
    template.active_execution_fleet_requirements.map((entry) => entry.agent),
    "authorization request execution fleet agents"
  );
  if (
    canonicalJson(template.forbidden_actions) !== canonicalJson(AUTHORIZATION_FORBIDDEN_ACTIONS)
  ) {
    throw new Error("authorization request forbidden actions are incomplete or noncanonical");
  }
  return template;
}

export function buildEvaluationCalibrationAuthorizationRequestTemplateV1(
  input: Omit<
    EvaluationCalibrationAuthorizationRequestTemplateV1,
    | "schema_id"
    | "schema_version"
    | "status"
    | "scope"
    | "unresolved_owner_parameters"
    | "transition_rule"
    | "forbidden_actions"
  >
): EvaluationCalibrationAuthorizationRequestTemplateV1 {
  return validateEvaluationCalibrationAuthorizationRequestTemplate({
    schema_id: "penny.evaluation-calibration-authorization-request-template.v1",
    schema_version: 1,
    status: "awaiting_owner_parameters",
    scope: "evaluation_live_calibration",
    authorization_request_id: input.authorization_request_id,
    package_id: input.package_id,
    package_sha256: input.package_sha256,
    schedule_sha256: input.schedule_sha256,
    arms: [...input.arms].sort((left, right) => left.arm_id.localeCompare(right.arm_id)),
    active_execution_fleet_requirements: [...input.active_execution_fleet_requirements].sort(
      (left, right) => left.agent.localeCompare(right.agent)
    ),
    judge_runtime_requirement: input.judge_runtime_requirement,
    judge_contract: input.judge_contract,
    unresolved_owner_parameters: {
      authorization_id: null,
      judge_provider: null,
      judge_model: null,
      judge_thinking_level: null,
      repetitions: null,
      max_concurrency: null,
      max_calls: null,
      max_retries: null,
      max_input_tokens: null,
      max_output_tokens: null,
      max_total_tokens: null,
      max_storage_bytes: null,
      max_spend_microusd: null,
      max_wall_clock_ms: null,
      max_execution_calls_per_trial: null,
      max_execution_turns_per_trial: null,
      state_root: null,
      evidence_root: null,
      allowed_egress_origins: null,
      credential_scope: null,
      not_before: null,
      expires_at: null,
      nonce: null,
      owner_id: null,
      approval_verification_material: null,
      compatibility_execution_binding_agent: null,
      execution_fleet_model_ids: null,
      execution_fleet_rate_cards: null,
      judge_rate_card: null,
      owner_verifier_module: null,
    },
    accounting: input.accounting,
    transition_rule:
      "not_an_authorization_manifest_until_every_owner_parameter_and_separate_owner_approval_are_supplied",
    forbidden_actions: AUTHORIZATION_FORBIDDEN_ACTIONS,
  });
}

export interface EvaluationCalibrationOwnerAuthorizationParametersV1 {
  readonly authorization_id: string;
  readonly owner_id: string;
  readonly approval_verification_material: string;
  readonly owner_verifier_module: string;
  readonly execution_binding: EvaluationLiveCalibrationAuthorizationManifestV1["execution_binding"];
  readonly execution_fleet: NonNullable<
    EvaluationLiveCalibrationAuthorizationManifestV1["execution_fleet"]
  >;
  readonly judge_binding: EvaluationLiveCalibrationAuthorizationManifestV1["judge_binding"];
  readonly judge_rates: NonNullable<
    EvaluationLiveCalibrationAuthorizationManifestV1["judge_rates"]
  >;
  readonly roots: EvaluationLiveCalibrationAuthorizationManifestV1["roots"];
  readonly limits: EvaluationLiveCalibrationAuthorizationManifestV1["limits"];
  readonly egress: EvaluationLiveCalibrationAuthorizationManifestV1["egress"];
  readonly validity: EvaluationLiveCalibrationAuthorizationManifestV1["validity"];
  readonly nonce: string;
}

export function materializeEvaluationLiveCalibrationAuthorizationManifestV1(input: {
  readonly template: unknown;
  readonly owner: EvaluationCalibrationOwnerAuthorizationParametersV1;
}): EvaluationLiveCalibrationAuthorizationManifestV1 {
  const template = validateEvaluationCalibrationAuthorizationRequestTemplate(input.template);
  if (
    input.owner.owner_id.trim().length === 0 ||
    input.owner.approval_verification_material.trim().length === 0 ||
    input.owner.owner_verifier_module.trim().length === 0
  ) {
    throw new Error(
      "owner identity, caller verifier, and separate approval verification material are required before manifest materialization"
    );
  }
  const requirements = template.active_execution_fleet_requirements;
  const executionFleet = [...input.owner.execution_fleet].sort((left, right) =>
    left.agent.localeCompare(right.agent)
  );
  if (
    executionFleet.length !== requirements.length ||
    requirements.some((required, index) => {
      const supplied = executionFleet[index];
      return (
        supplied === undefined ||
        supplied.agent !== required.agent ||
        supplied.ssot_model !== required.ssot_model ||
        supplied.provider !== required.provider ||
        supplied.runtime !== required.runtime ||
        supplied.thinking_level !== required.thinking_level
      );
    })
  ) {
    throw new Error("owner execution fleet does not match the active package requirements");
  }
  if (input.owner.judge_binding.runtime !== template.judge_runtime_requirement) {
    throw new Error("owner judge runtime does not match the active package requirement");
  }
  if (
    !executionFleet.some(
      (entry) =>
        entry.provider === input.owner.execution_binding.provider &&
        entry.model === input.owner.execution_binding.model &&
        entry.runtime === input.owner.execution_binding.runtime &&
        entry.thinking_level === input.owner.execution_binding.thinking_level
    )
  ) {
    throw new Error("owner compatibility execution binding is not one active fleet entry");
  }
  return buildEvaluationLiveCalibrationAuthorizationManifestV1({
    authorization_id: input.owner.authorization_id,
    calibration: {
      package_id: template.package_id,
      package_sha256: template.package_sha256,
      schedule_sha256: template.schedule_sha256,
      arms: template.arms.map((arm) => ({
        arm_id: arm.arm_id,
        binding_sha256: arm.binding_sha256,
      })),
    },
    execution_binding: input.owner.execution_binding,
    execution_fleet: executionFleet,
    judge_binding: input.owner.judge_binding,
    judge_rates: input.owner.judge_rates,
    judge_contract: template.judge_contract,
    roots: input.owner.roots,
    limits: input.owner.limits,
    egress: input.owner.egress,
    validity: input.owner.validity,
    nonce: input.owner.nonce,
  });
}

export function projectAuthorizedPlanCalibrationSemanticEvidenceV1(input: {
  readonly task: unknown;
  readonly admission: unknown;
  readonly source_bytes: Uint8Array;
  readonly semantic_request: unknown;
}): AuthorizedPlanSemanticEvidenceProjectionV1 {
  const task = validateEvaluationCalibrationTask(input.task);
  if (
    task.skill !== "plan" ||
    task.routing.kind !== "candidate_only_product_integrity" ||
    task.semantic_projection_policy.kind !== "post_admission_authorized_semantic_evidence"
  ) {
    throw new Error(
      "authorized source projection is limited to candidate-only Plan integrity tasks"
    );
  }
  const admission = validateCanonicalContract({
    schema: PlanCalibrationSourceAdmissionV1Schema,
    value: input.admission,
    label: "Plan calibration source admission V1",
  });
  const binding = task.exact_inputs[0];
  if (
    binding === undefined ||
    admission.task_id !== task.task_id ||
    admission.artifact_id !== binding.artifact_id ||
    admission.source_sha256 !== binding.sha256 ||
    admission.source_byte_length !== binding.byte_length ||
    sha256Bytes(input.source_bytes) !== binding.sha256 ||
    input.source_bytes.byteLength !== binding.byte_length
  ) {
    throw new Error("Plan calibration source admission drifted from the exact admitted bytes");
  }
  const request = validateContract(
    PlanSemanticRequestProjectionV1Schema,
    input.semantic_request,
    "authorized Plan calibration semantic request projection"
  );
  const canonicalRequest = canonicalJson(request);
  for (const forbiddenValue of [binding.artifact_id, binding.sha256, binding.source_path]) {
    if (canonicalRequest.includes(forbiddenValue)) {
      throw new Error("Plan calibration semantic projection leaks source or transport metadata");
    }
  }
  const body = {
    schema_id: "penny.authorized-plan-semantic-evidence-projection.v1" as const,
    schema_version: 1 as const,
    task_id: task.task_id,
    request,
  };
  return validateCanonicalContract({
    schema: AuthorizedPlanSemanticEvidenceProjectionV1Schema,
    value: { ...body, projection_sha256: calibrationCanonicalSha256(body) },
    label: "authorized Plan semantic evidence projection V1",
  });
}

export function readinessTaskFromCalibrationTask(
  task: EvaluationCalibrationTaskV1
): EvaluationReadinessCalibrationTaskV1 {
  return validateContract(
    EvaluationReadinessCalibrationTaskV1Schema,
    validateEvaluationCalibrationTask(task).runtime_task,
    "readiness task projected from calibration task"
  );
}

export function calibrationSchemaBundle(
  skill: "decide" | "plan"
): Readonly<Record<string, unknown>> {
  return {
    authorized_plan_semantic_evidence_projection_v1:
      AuthorizedPlanSemanticEvidenceProjectionV1Schema,
    authorization_request_template_v1: EvaluationCalibrationAuthorizationRequestTemplateV1Schema,
    calibration_cohort_v1: EvaluationCalibrationCohortV1Schema,
    calibration_package_v1: EvaluationCalibrationPackageV1Schema,
    calibration_schedule_v1: EvaluationCalibrationScheduleV1Schema,
    calibration_task_v1: EvaluationCalibrationTaskV1Schema,
    contamination_fingerprint_manifest_v1:
      EvaluationCalibrationContaminationFingerprintManifestV1Schema,
    output: skill === "decide" ? DecisionSemanticEvaluationV3Schema : StrategyEvaluationV2Schema,
    plan_calibration_source_admission_v1: PlanCalibrationSourceAdmissionV1Schema,
    preparation_evidence_v1: EvaluationCalibrationPreparationEvidenceV1Schema,
    semantic_judge_control_v1: EvaluationCalibrationSemanticJudgeControlV1Schema,
    semantic_review_output_v1: SemanticTrialReviewOutputV1Schema,
    structured_expectations:
      skill === "decide"
        ? DecideStructuredExpectationsV3Schema
        : PlanStructuredExpectationsV2Schema,
  };
}
