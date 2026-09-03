import { Type, type Static } from "typebox";

import {
  ArtifactRefSchema,
  JsonValueSchema,
  canonicalJson,
  sha256,
  validateContract,
} from "@penny/orchestration/source";

const EvaluationIdSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const RatioSchema = Type.Number({ minimum: 0 });
const UnitIntervalSchema = Type.Number({ minimum: 0, maximum: 1 });
export const EvaluationReadinessPairFloorV1Schema = Type.Number({ minimum: 0.8, maximum: 1 });
const SignedUnitIntervalSchema = Type.Number({ minimum: -1, maximum: 1 });
const ArtifactIdSchema = Type.String({ pattern: "^art_[a-f0-9]{64}$" });
const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);
const EvaluationRateCardV1Schema = Type.Object(
  {
    input_usd_per_million_tokens: Type.Number({ minimum: 0 }),
    output_usd_per_million_tokens: Type.Number({ minimum: 0 }),
    cache_read_usd_per_million_tokens: Type.Number({ minimum: 0 }),
    cache_write_usd_per_million_tokens: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const EvaluationPurposeV1Schema = Type.Union([
  Type.Literal("harness_self_test"),
  Type.Literal("candidate_warrant"),
  Type.Literal("part_b"),
]);
export type EvaluationPurposeV1 = Static<typeof EvaluationPurposeV1Schema>;

export const EvaluationPopulationTaskV1Schema = Type.Object(
  {
    task_id: EvaluationIdSchema,
    domain: EvaluationIdSchema,
    trigger_expected: Type.Boolean(),
    goal: Type.String({ minLength: 1, maxLength: 32_768 }),
    constraints: Type.Record(Type.String(), JsonValueSchema),
    exact_input_artifact_ids: Type.Array(ArtifactIdSchema, {
      maxItems: 64,
      uniqueItems: true,
    }),
    grader_case_id: EvaluationIdSchema,
  },
  { additionalProperties: false }
);
export type EvaluationPopulationTaskV1 = Readonly<Static<typeof EvaluationPopulationTaskV1Schema>>;

export const EvaluationPopulationV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    purpose: EvaluationPurposeV1Schema,
    population_id: EvaluationIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    split: Type.Literal("held_out"),
    contamination_group: EvaluationIdSchema,
    tasks: Type.Array(EvaluationPopulationTaskV1Schema, {
      minItems: 1,
      maxItems: 1_024,
    }),
  },
  { additionalProperties: false }
);
export type EvaluationPopulationV1 = Readonly<Static<typeof EvaluationPopulationV1Schema>>;

const CandidateBindingV1Schema = Type.Object(
  {
    name: EvaluationIdSchema,
    contract_sha256: DigestSchema,
  },
  { additionalProperties: false }
);

export const EvaluationFunctionDescriptorV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    arity: Type.Integer({ minimum: 0, maximum: 64 }),
    function_kind: Type.Union([
      Type.Literal("sync"),
      Type.Literal("async"),
      Type.Literal("generator"),
      Type.Literal("async_generator"),
    ]),
    descriptor_byte_length: Type.Integer({ minimum: 1, maximum: 4_096 }),
    descriptor_sha256: DigestSchema,
  },
  { additionalProperties: false }
);
export type EvaluationFunctionDescriptorV1 = Readonly<
  Static<typeof EvaluationFunctionDescriptorV1Schema>
>;

export const EvaluationImplementationFileRoleV1Schema = Type.Union([
  Type.Literal("registration_guidance"),
  Type.Literal("agent_definition"),
  Type.Literal("registration_source"),
  Type.Literal("contract_source"),
  Type.Literal("playbook_source"),
  Type.Literal("validator_source"),
  Type.Literal("composition_source"),
  Type.Literal("normalizer_source"),
  Type.Literal("grader_source"),
  Type.Literal("evaluator_source"),
  Type.Literal("worker_source"),
  Type.Literal("artifact_preflight_source"),
]);
export type EvaluationImplementationFileRoleV1 = Static<
  typeof EvaluationImplementationFileRoleV1Schema
>;

export const EvaluationImplementationFileV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    role: EvaluationImplementationFileRoleV1Schema,
    owner: EvaluationIdSchema,
    path: Type.String({ minLength: 1, maxLength: 512 }),
    byte_length: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    sha256: DigestSchema,
  },
  { additionalProperties: false }
);
export type EvaluationImplementationFileV1 = Readonly<
  Static<typeof EvaluationImplementationFileV1Schema>
>;

const EvaluationRegistrationPhaseDescriptorV1Schema = Type.Union([
  Type.Object(
    {
      phase: EvaluationIdSchema,
      agent: EvaluationIdSchema,
      result_schema_id: EvaluationIdSchema,
      result_schema_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      schema_canonical_byte_length: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
      schema_sha256: DigestSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      phase: EvaluationIdSchema,
      agent: EvaluationIdSchema,
      validate: EvaluationFunctionDescriptorV1Schema,
    },
    { additionalProperties: false }
  ),
]);

const EvaluationRegistrationDescriptorV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    role: Type.Union([
      Type.Literal("baseline"),
      Type.Literal("candidate"),
      Type.Literal("ablation"),
    ]),
    registration_name: EvaluationIdSchema,
    contract_sha256: DigestSchema,
    ingress: Type.Union([Type.Literal("skill"), Type.Literal("dedicated_tool")]),
    start_admission: Type.Union([
      Type.Null(),
      Type.Object(
        {
          schema_id: EvaluationIdSchema,
          schema_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          prepare: EvaluationFunctionDescriptorV1Schema,
          materialize: EvaluationFunctionDescriptorV1Schema,
          prepare_probe_sha256: DigestSchema,
        },
        { additionalProperties: false }
      ),
    ]),
    liveness: Type.Object(
      {
        resolver_id: EvaluationIdSchema,
        resolve: EvaluationFunctionDescriptorV1Schema,
        policy_probe_sha256: DigestSchema,
        thinking_policy: Type.Union([Type.Literal("agent_ssot"), Type.Literal("research_preset")]),
      },
      { additionalProperties: false }
    ),
    worker: Type.Object(
      {
        kind: Type.Union([Type.Literal("catalog-agent"), Type.Literal("host-private")]),
        workflow_name: EvaluationIdSchema,
        guidance: Type.Object(
          {
            skill_root: Type.String({ minLength: 1, maxLength: 512 }),
            resolution: Type.Union([Type.Literal("per_agent"), Type.Literal("per_agent_phase")]),
          },
          { additionalProperties: false }
        ),
        guidance_required: Type.Literal(true),
        result_transport: Type.Union([
          Type.Literal("persisted_summary"),
          Type.Literal("host_typed"),
        ]),
        opening_policy: Type.Union([
          Type.Literal("registration_guidance_task_artifacts"),
          Type.Literal("host_private_opening"),
        ]),
        model_policy: Type.Union([
          Type.Literal("directive_override_or_runtime_default"),
          Type.Literal("host_private_ssot_model"),
        ]),
        phases: Type.Array(EvaluationRegistrationPhaseDescriptorV1Schema, {
          minItems: 1,
          maxItems: 256,
        }),
      },
      { additionalProperties: false }
    ),
    completion_predicates: Type.Array(
      Type.Object(
        {
          predicate_id: EvaluationIdSchema,
          implementation: EvaluationFunctionDescriptorV1Schema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 256 }
    ),
    construct: EvaluationFunctionDescriptorV1Schema,
    construct_probe_sha256: DigestSchema,
  },
  { additionalProperties: false }
);

const EvaluationGradingImplementationDescriptorV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    descriptor_sha256: DigestSchema,
    semantic_normalizers: Type.Array(
      Type.Object(
        {
          registration_name: EvaluationIdSchema,
          normalizer_id: EvaluationIdSchema,
          normalizer_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          declared_implementation_sha256: DigestSchema,
          normalize: EvaluationFunctionDescriptorV1Schema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 256 }
    ),
    graders: Type.Array(
      Type.Object(
        {
          grader_case_id: EvaluationIdSchema,
          grader_id: EvaluationIdSchema,
          grader_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          declared_implementation_sha256: DigestSchema,
          grade: EvaluationFunctionDescriptorV1Schema,
          qualify_semantic_review: Type.Optional(EvaluationFunctionDescriptorV1Schema),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 2_048 }
    ),
  },
  { additionalProperties: false }
);

export const EvaluationRuntimeFunctionRoleV1Schema = Type.Union([
  Type.Literal("model_client_factory"),
  Type.Literal("model_preflight"),
  Type.Literal("artifact_preflight"),
  Type.Literal("readiness_preflight"),
  Type.Literal("readiness_common_wire_validator"),
  Type.Literal("trial_executor_preflight"),
  Type.Literal("trial_executor_execute"),
  Type.Literal("mutation_gate"),
]);
export type EvaluationRuntimeFunctionRoleV1 = Static<typeof EvaluationRuntimeFunctionRoleV1Schema>;

export const EvaluationImplementationBindingV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    files: Type.Array(EvaluationImplementationFileV1Schema, { minItems: 1, maxItems: 4_096 }),
    registrations: Type.Array(EvaluationRegistrationDescriptorV1Schema, {
      minItems: 2,
      maxItems: 18,
    }),
    grading: EvaluationGradingImplementationDescriptorV1Schema,
    runtime_functions: Type.Array(
      Type.Object(
        {
          role: EvaluationRuntimeFunctionRoleV1Schema,
          owner: EvaluationIdSchema,
          implementation: EvaluationFunctionDescriptorV1Schema,
        },
        { additionalProperties: false }
      ),
      { minItems: 5, maxItems: 64 }
    ),
    runtime_schemas: Type.Array(
      Type.Object(
        {
          role: EvaluationIdSchema,
          canonical_byte_length: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
          sha256: DigestSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 64 }
    ),
  },
  { additionalProperties: false }
);
export type EvaluationImplementationBindingV1 = Readonly<
  Static<typeof EvaluationImplementationBindingV1Schema>
>;

export const DirectBaselineDefinitionV1Schema = Type.Object(
  {
    kind: Type.Literal("direct_agent"),
    registration_name: EvaluationIdSchema,
    agent: EvaluationIdSchema,
    phase: EvaluationIdSchema,
    guidance: Type.Object(
      {
        skill_root: Type.String({ minLength: 1, maxLength: 256 }),
        resolution: Type.Union([Type.Literal("per_agent"), Type.Literal("per_agent_phase")]),
        path: Type.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false }
    ),
    output: Type.Object(
      {
        artifact_kind: EvaluationIdSchema,
        schema_id: EvaluationIdSchema,
        schema_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        producer: Type.String({ pattern: "^agent:[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
        media_type: Type.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false }
    ),
    liveness_policy_sha256: DigestSchema,
    definition_sha256: DigestSchema,
    agent_definition_sha256: DigestSchema,
    guidance_sha256: DigestSchema,
  },
  { additionalProperties: false }
);
export type DirectBaselineDefinitionV1 = Readonly<Static<typeof DirectBaselineDefinitionV1Schema>>;

export const PairedEvaluationPlanV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    plan_id: EvaluationIdSchema,
    purpose: EvaluationPurposeV1Schema,
    candidate: CandidateBindingV1Schema,
    population: Type.Object(
      {
        population_id: EvaluationIdSchema,
        revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        sha256: DigestSchema,
      },
      { additionalProperties: false }
    ),
    baseline: DirectBaselineDefinitionV1Schema,
    ablations: Type.Array(CandidateBindingV1Schema, {
      maxItems: 16,
    }),
    repetitions: Type.Integer({ minimum: 1, maximum: 32 }),
    runtime_binding: Type.Object(
      {
        provider: EvaluationIdSchema,
        model: EvaluationIdSchema,
        runtime: EvaluationIdSchema,
        thinking_level: ThinkingLevelSchema,
        rates: EvaluationRateCardV1Schema,
      },
      { additionalProperties: false }
    ),
    budget_policy_sha256: DigestSchema,
    grader_registry_sha256: DigestSchema,
    implementation_binding_sha256: DigestSchema,
    pair_order_seed: Type.String({ minLength: 1, maxLength: 256 }),
    primary_metric: Type.Literal("task_score"),
    material_effect_threshold: SignedUnitIntervalSchema,
    candidate_scheduled_mean_floor: Type.Optional(UnitIntervalSchema),
    protected_capability_floor: UnitIntervalSchema,
    trigger_precision_floor: UnitIntervalSchema,
    trigger_recall_floor: Type.Optional(UnitIntervalSchema),
    negative_transfer_ceiling: Type.Union([UnitIntervalSchema, Type.Null()]),
    domain_quality_policy: Type.Optional(
      Type.Object(
        {
          candidate_scheduled_mean_floor: UnitIntervalSchema,
          candidate_minus_baseline_paired_mean_floor: SignedUnitIntervalSchema,
        },
        { additionalProperties: false }
      )
    ),
    comparison_validity_policy: Type.Object(
      {
        baseline_normalized_completion_floor: UnitIntervalSchema,
        candidate_normalized_completion_floor: Type.Optional(UnitIntervalSchema),
        nonzero_candidate_complete_pair_coverage_floor: UnitIntervalSchema,
        require_all_scheduled_trials_complete: Type.Optional(Type.Boolean()),
        required_comparator_normalized_completion_floors: Type.Array(
          Type.Object(
            {
              comparator_name: EvaluationIdSchema,
              normalized_completion_floor: UnitIntervalSchema,
            },
            { additionalProperties: false }
          ),
          { maxItems: 16 }
        ),
        readiness_preflight: Type.Union([
          Type.Object(
            {
              required: Type.Literal(false),
              calibration_split: Type.Literal("calibration"),
              scoring: Type.Literal("non_scoring"),
              arm_coverage: Type.Literal("every_arm"),
              validate_state_root: Type.Literal(true),
              validate_output_normalization: Type.Literal(true),
              validate_oracle_isolation: Type.Literal(true),
              validate_common_wire: Type.Literal(true),
            },
            { additionalProperties: false }
          ),
          Type.Object(
            {
              required: Type.Literal(true),
              calibration_split: Type.Literal("calibration"),
              scoring: Type.Literal("non_scoring"),
              arm_coverage: Type.Literal("every_arm"),
              validate_state_root: Type.Literal(true),
              validate_output_normalization: Type.Literal(true),
              validate_oracle_isolation: Type.Literal(true),
              validate_common_wire: Type.Literal(true),
              calibration_cohort_sha256: DigestSchema,
              repetitions: Type.Integer({ minimum: 1, maximum: 4 }),
              baseline_normalized_completion_floor: Type.Number({ minimum: 0.9, maximum: 1 }),
              candidate_normalized_completion_floor: Type.Number({ minimum: 0.9, maximum: 1 }),
              complete_all_arm_pair_floor: Type.Optional(EvaluationReadinessPairFloorV1Schema),
              required_comparator_normalized_completion_floors: Type.Array(
                Type.Object(
                  {
                    comparator_name: EvaluationIdSchema,
                    normalized_completion_floor: Type.Number({ minimum: 0.9, maximum: 1 }),
                  },
                  { additionalProperties: false }
                ),
                { maxItems: 16 }
              ),
            },
            { additionalProperties: false }
          ),
        ]),
      },
      { additionalProperties: false }
    ),
    cost_latency_policy: Type.Object(
      {
        max_candidate_to_baseline_cost_ratio: RatioSchema,
        max_candidate_to_baseline_latency_ratio: RatioSchema,
        require_exact_zero_cost_when_unpriced: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false }
    ),
    ablation_policies: Type.Array(
      Type.Object(
        {
          ablation_name: EvaluationIdSchema,
          candidate_minus_ablation_primary_floor: SignedUnitIntervalSchema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 16 }
    ),
    mutation_gate: Type.Union([
      Type.Null(),
      Type.Object(
        {
          cohort_sha256: DigestSchema,
          mutation_count: Type.Integer({ minimum: 1, maximum: 1_024 }),
          full_sealer_escaped_invalid_rate_ceiling: UnitIntervalSchema,
          ablation_name: Type.Optional(EvaluationIdSchema),
          evaluation_only_control: Type.Optional(CandidateBindingV1Schema),
          ablation_minimum_escaped_invalid_count: Type.Integer({
            minimum: 1,
            maximum: 1_024,
          }),
        },
        { additionalProperties: false }
      ),
    ]),
    failure_rule: Type.Object(
      {
        task_score: UnitIntervalSchema,
        trigger_predicted: Type.Boolean(),
        protected_capability_score: UnitIntervalSchema,
        cost_microusd: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        latency_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false }
    ),
    deterministic_disposition_rule: Type.Object(
      {
        on_pass: Type.Literal("CANDIDATE"),
        on_fail: Type.Union([Type.Literal("NO_BUILD"), Type.Literal("RETIRED")]),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type PairedEvaluationPlanV1 = Readonly<Static<typeof PairedEvaluationPlanV1Schema>>;

export const EvaluationMutationMeasurementV1Schema = Type.Object(
  {
    cohort_sha256: DigestSchema,
    mutation_count: Type.Integer({ minimum: 1, maximum: 1_024 }),
    full_sealer_escaped_invalid_count: Type.Integer({ minimum: 0, maximum: 1_024 }),
    ablation_escaped_invalid_count: Type.Integer({ minimum: 0, maximum: 1_024 }),
  },
  { additionalProperties: false }
);
export type EvaluationMutationMeasurementV1 = Readonly<
  Static<typeof EvaluationMutationMeasurementV1Schema>
>;

export const EvaluationTrialVariantV1Schema = Type.Union([
  Type.Literal("baseline"),
  Type.Literal("candidate"),
  Type.Literal("ablation"),
]);
export type EvaluationTrialVariantV1 = Static<typeof EvaluationTrialVariantV1Schema>;

export const EvaluationTrialTerminalStatusV1Schema = Type.Union([
  Type.Literal("complete"),
  Type.Literal("missing"),
  Type.Literal("nonterminal"),
  Type.Literal("cancelled"),
  Type.Literal("malformed"),
  Type.Literal("error"),
]);
export type EvaluationTrialTerminalStatusV1 = Static<typeof EvaluationTrialTerminalStatusV1Schema>;

export const PairedEvaluationScheduleEntryV1Schema = Type.Object(
  {
    trial_id: Type.String({ pattern: "^evaltrial_[a-f0-9]{64}$" }),
    pair_id: Type.String({ pattern: "^evalpair_[a-f0-9]{64}$" }),
    ordinal: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    task_id: EvaluationIdSchema,
    repetition: Type.Integer({ minimum: 1, maximum: 32 }),
    variant: EvaluationTrialVariantV1Schema,
    variant_name: EvaluationIdSchema,
    binding_sha256: DigestSchema,
  },
  { additionalProperties: false }
);
export type PairedEvaluationScheduleEntryV1 = Readonly<
  Static<typeof PairedEvaluationScheduleEntryV1Schema>
>;

export const FrozenPairedEvaluationV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    plan_id: EvaluationIdSchema,
    plan_sha256: DigestSchema,
    population_id: EvaluationIdSchema,
    population_revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    population_sha256: DigestSchema,
    candidate_name: EvaluationIdSchema,
    candidate_contract_sha256: DigestSchema,
    baseline_definition_sha256: DigestSchema,
    budget_policy_sha256: DigestSchema,
    grader_registry_sha256: DigestSchema,
    implementation_binding_sha256: DigestSchema,
    schedule_sha256: DigestSchema,
    schedule: Type.Array(PairedEvaluationScheduleEntryV1Schema, {
      minItems: 2,
      maxItems: 65_536,
    }),
  },
  { additionalProperties: false }
);
export type FrozenPairedEvaluationV1 = Readonly<Static<typeof FrozenPairedEvaluationV1Schema>>;

export const SemanticClauseResultV1Schema = Type.Object(
  {
    clause_id: EvaluationIdSchema,
    outcome: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL"), Type.Literal("UNVERIFIABLE")]),
    reason: Type.String({ minLength: 1, maxLength: 1024 }),
    oracle_refs: Type.Array(EvaluationIdSchema, { minItems: 1, maxItems: 16, uniqueItems: true }),
    evidence_refs: Type.Array(EvaluationIdSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type SemanticClauseResultV1 = Readonly<Static<typeof SemanticClauseResultV1Schema>>;

const EvaluationTrialMeasurementV1Schema = Type.Object(
  {
    task_score: UnitIntervalSchema,
    trigger_predicted: Type.Boolean(),
    protected_capability_score: Type.Union([UnitIntervalSchema, Type.Null()]),
    clause_results: Type.Optional(
      Type.Array(SemanticClauseResultV1Schema, { minItems: 1, maxItems: 64 })
    ),
    cost_microusd: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    latency_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false }
);
export type EvaluationTrialMeasurementV1 = Readonly<
  Static<typeof EvaluationTrialMeasurementV1Schema>
>;

export const PairedEvaluationTrialV1Schema = Type.Object(
  {
    trial_id: Type.String({ pattern: "^evaltrial_[a-f0-9]{64}$" }),
    pair_id: Type.String({ pattern: "^evalpair_[a-f0-9]{64}$" }),
    ordinal: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    task_id: EvaluationIdSchema,
    repetition: Type.Integer({ minimum: 1, maximum: 32 }),
    variant: EvaluationTrialVariantV1Schema,
    variant_name: EvaluationIdSchema,
    binding_sha256: DigestSchema,
    terminal_status: EvaluationTrialTerminalStatusV1Schema,
    output_refs: Type.Array(ArtifactRefSchema, { maxItems: 8 }),
    measurement: EvaluationTrialMeasurementV1Schema,
    failure_rule_applied: Type.Boolean(),
    failure_code: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  },
  { additionalProperties: false }
);
export type PairedEvaluationTrialV1 = Readonly<Static<typeof PairedEvaluationTrialV1Schema>>;

export const EvaluationDispositionV1Schema = Type.Union([
  Type.Literal("NO_BUILD"),
  Type.Literal("RETIRED"),
  Type.Literal("CANDIDATE"),
  Type.Literal("INVALID_EVALUATION"),
]);
export type EvaluationDispositionV1 = Static<typeof EvaluationDispositionV1Schema>;

export const InvalidEvaluationStageV1Schema = Type.Union([
  Type.Literal("registration_preflight"),
  Type.Literal("artifact_read_preflight"),
  Type.Literal("readiness_preflight"),
  Type.Literal("semantic_normalization"),
  Type.Literal("semantic_review"),
  Type.Literal("grader_parser"),
  Type.Literal("comparison_validity"),
]);
export type InvalidEvaluationStageV1 = Static<typeof InvalidEvaluationStageV1Schema>;

export const ComparisonInvalidReasonV1Schema = Type.Union([
  Type.Literal("EVALUATION_INCOMPATIBILITY"),
  Type.Literal("BASELINE_NORMALIZED_COMPLETION_BELOW_FLOOR"),
  Type.Literal("CANDIDATE_NORMALIZED_COMPLETION_BELOW_FLOOR"),
  Type.Literal("CANDIDATE_ZERO_NORMALIZED_COMPLETIONS"),
  Type.Literal("COMPLETE_PAIR_COVERAGE_BELOW_FLOOR"),
  Type.Literal("REQUIRED_COMPARATOR_NORMALIZED_COMPLETION_BELOW_FLOOR"),
]);
export type ComparisonInvalidReasonV1 = Static<typeof ComparisonInvalidReasonV1Schema>;

export const EvaluationDispositionReasonV1Schema = Type.Union([
  Type.Literal("FROZEN_POLICY_PASS"),
  Type.Literal("FROZEN_POLICY_FAIL"),
  Type.Literal("CANDIDATE_ZERO_NORMALIZED_COMPLETIONS"),
  Type.Literal("COMPARATIVE_UNVERIFIABLE"),
  Type.Literal("EVALUATION_INCOMPATIBILITY"),
]);
export type EvaluationDispositionReasonV1 = Static<typeof EvaluationDispositionReasonV1Schema>;

const NormalizedCompletionCoverageV1Schema = Type.Object(
  {
    scheduled_trials: Type.Integer({ minimum: 1 }),
    normalized_completions: Type.Integer({ minimum: 0 }),
    incomplete_or_failed_trials: Type.Integer({ minimum: 0 }),
    coverage: UnitIntervalSchema,
  },
  { additionalProperties: false }
);

export const PairedEvaluationResultV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    result_id: Type.String({ pattern: "^evalres_[a-f0-9]{64}$" }),
    purpose: EvaluationPurposeV1Schema,
    plan_id: EvaluationIdSchema,
    plan_sha256: DigestSchema,
    population_id: EvaluationIdSchema,
    population_revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    population_sha256: DigestSchema,
    schedule_sha256: DigestSchema,
    candidate_name: EvaluationIdSchema,
    candidate_contract_sha256: DigestSchema,
    baseline_definition_sha256: DigestSchema,
    budget_policy_sha256: DigestSchema,
    grader_registry_sha256: DigestSchema,
    implementation_binding_sha256: Type.Optional(DigestSchema),
    trials: Type.Array(PairedEvaluationTrialV1Schema, {
      minItems: 2,
      maxItems: 65_536,
    }),
    trial_accounting: Type.Object(
      {
        scheduled: Type.Integer({ minimum: 2 }),
        complete: Type.Integer({ minimum: 0 }),
        missing: Type.Integer({ minimum: 0 }),
        nonterminal: Type.Integer({ minimum: 0 }),
        cancelled: Type.Integer({ minimum: 0 }),
        malformed: Type.Integer({ minimum: 0 }),
        error: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false }
    ),
    complete_pair_coverage: Type.Object(
      {
        scheduled_pairs: Type.Integer({ minimum: 1 }),
        complete_pairs: Type.Integer({ minimum: 0 }),
        incomplete_pairs: Type.Integer({ minimum: 0 }),
        coverage: UnitIntervalSchema,
      },
      { additionalProperties: false }
    ),
    candidate_completion_reliability: NormalizedCompletionCoverageV1Schema,
    candidate_failure_taxonomy: Type.Array(
      Type.Object(
        {
          failure_code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }),
          count: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 256 }
    ),
    comparison_validity: Type.Object(
      {
        status: Type.Union([Type.Literal("VALID"), Type.Literal("COMPARATIVE_UNVERIFIABLE")]),
        baseline: Type.Object(
          {
            scheduled_trials: Type.Integer({ minimum: 1 }),
            normalized_completions: Type.Integer({ minimum: 0 }),
            incomplete_or_failed_trials: Type.Integer({ minimum: 0 }),
            coverage: UnitIntervalSchema,
            frozen_floor: UnitIntervalSchema,
            passed: Type.Boolean(),
          },
          { additionalProperties: false }
        ),
        candidate: Type.Optional(
          Type.Object(
            {
              scheduled_trials: Type.Integer({ minimum: 1 }),
              normalized_completions: Type.Integer({ minimum: 0 }),
              incomplete_or_failed_trials: Type.Integer({ minimum: 0 }),
              coverage: UnitIntervalSchema,
              frozen_floor: UnitIntervalSchema,
              passed: Type.Boolean(),
            },
            { additionalProperties: false }
          )
        ),
        complete_pairs: Type.Object(
          {
            scheduled_pairs: Type.Integer({ minimum: 1 }),
            complete_pairs: Type.Integer({ minimum: 0 }),
            incomplete_pairs: Type.Integer({ minimum: 0 }),
            coverage: UnitIntervalSchema,
            frozen_floor: UnitIntervalSchema,
            passed: Type.Boolean(),
          },
          { additionalProperties: false }
        ),
        required_comparators: Type.Array(
          Type.Object(
            {
              comparator_name: EvaluationIdSchema,
              scheduled_trials: Type.Integer({ minimum: 1 }),
              normalized_completions: Type.Integer({ minimum: 0 }),
              incomplete_or_failed_trials: Type.Integer({ minimum: 0 }),
              coverage: UnitIntervalSchema,
              frozen_floor: UnitIntervalSchema,
              passed: Type.Boolean(),
            },
            { additionalProperties: false }
          ),
          { maxItems: 16 }
        ),
        invalid_reasons: Type.Array(ComparisonInvalidReasonV1Schema, {
          maxItems: 6,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false }
    ),
    aggregate_deltas: Type.Object(
      {
        baseline_primary_mean: UnitIntervalSchema,
        candidate_primary_mean: UnitIntervalSchema,
        primary_delta: Type.Number({ minimum: -1, maximum: 1 }),
        candidate_protected_mean: UnitIntervalSchema,
        candidate_trigger_precision: UnitIntervalSchema,
        candidate_trigger_recall: Type.Optional(UnitIntervalSchema),
        negative_transfer_rate: UnitIntervalSchema,
        candidate_to_baseline_cost_ratio: Type.Union([RatioSchema, Type.Null()]),
        candidate_to_baseline_latency_ratio: Type.Union([RatioSchema, Type.Null()]),
      },
      { additionalProperties: false }
    ),
    domain_metrics: Type.Optional(
      Type.Array(
        Type.Object(
          {
            domain: EvaluationIdSchema,
            candidate_scheduled_mean: UnitIntervalSchema,
            candidate_scheduled_mean_floor: UnitIntervalSchema,
            candidate_scheduled_mean_passed: Type.Boolean(),
            complete_pair_count: Type.Integer({ minimum: 0 }),
            candidate_minus_baseline_paired_mean_delta: Type.Union([
              SignedUnitIntervalSchema,
              Type.Null(),
            ]),
            candidate_minus_baseline_paired_mean_floor: SignedUnitIntervalSchema,
            candidate_minus_baseline_paired_mean_passed: Type.Boolean(),
          },
          { additionalProperties: false }
        ),
        { minItems: 1, maxItems: 1_024 }
      )
    ),
    ablation_metrics: Type.Array(
      Type.Object(
        {
          ablation_name: EvaluationIdSchema,
          ablation_primary_mean: UnitIntervalSchema,
          candidate_minus_ablation_primary_delta: SignedUnitIntervalSchema,
          frozen_floor: SignedUnitIntervalSchema,
          passed: Type.Boolean(),
        },
        { additionalProperties: false }
      ),
      { maxItems: 16 }
    ),
    mutation_gate: Type.Union([
      Type.Null(),
      Type.Object(
        {
          cohort_sha256: DigestSchema,
          mutation_count: Type.Integer({ minimum: 1, maximum: 1_024 }),
          full_sealer_escaped_invalid_count: Type.Integer({ minimum: 0, maximum: 1_024 }),
          full_sealer_escaped_invalid_rate: UnitIntervalSchema,
          frozen_full_sealer_rate_ceiling: UnitIntervalSchema,
          ablation_name: Type.Optional(EvaluationIdSchema),
          evaluation_only_control_name: Type.Optional(EvaluationIdSchema),
          ablation_escaped_invalid_count: Type.Integer({ minimum: 0, maximum: 1_024 }),
          frozen_ablation_minimum_escaped_invalid_count: Type.Integer({
            minimum: 1,
            maximum: 1_024,
          }),
          passed: Type.Boolean(),
        },
        { additionalProperties: false }
      ),
    ]),
    policy_outcomes: Type.Object(
      {
        comparison_validity: Type.Boolean(),
        complete_pairing: Type.Boolean(),
        material_effect: Type.Boolean(),
        candidate_absolute_quality: Type.Optional(Type.Boolean()),
        protected_capability: Type.Boolean(),
        trigger_precision: Type.Boolean(),
        trigger_recall: Type.Optional(Type.Boolean()),
        domain_candidate_quality: Type.Optional(Type.Boolean()),
        domain_paired_delta: Type.Optional(Type.Boolean()),
        negative_transfer: Type.Boolean(),
        cost: Type.Boolean(),
        zero_cost_exact: Type.Optional(Type.Boolean()),
        latency: Type.Boolean(),
        ablation_non_inferiority: Type.Boolean(),
        deterministic_mutation: Type.Boolean(),
        all_passed: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
    semantic_qualification: Type.Optional(
      Type.Object(
        {
          status: Type.Union([
            Type.Literal("QUALIFIED"),
            Type.Literal("NOT_QUALIFIED"),
            Type.Literal("INVALID_EVALUATION"),
          ]),
          reason_code: Type.Union([
            Type.Literal("ALL_SCHEDULED_ARMS_QUALIFIED"),
            Type.Literal("SEMANTIC_REVIEW_NOT_CONFIGURED"),
            Type.Literal("SCHEDULED_ARM_NOT_QUALIFIED"),
            Type.Literal("EVALUATION_INVALID"),
          ]),
          provider_calls: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
          trial_qualifications: Type.Array(
            Type.Object(
              {
                trial_id: Type.String({ pattern: "^evaltrial_[a-f0-9]{64}$" }),
                task_id: EvaluationIdSchema,
                repetition: Type.Integer({ minimum: 1, maximum: 64 }),
                variant: EvaluationTrialVariantV1Schema,
                variant_name: EvaluationIdSchema,
                task_disposition: Type.Union([
                  Type.Literal("PASS"),
                  Type.Literal("FAIL"),
                  Type.Literal("BLOCKED"),
                ]),
                qualification_status: Type.Union([
                  Type.Literal("QUALIFIED"),
                  Type.Literal("NOT_QUALIFIED"),
                ]),
                aggregate_success: Type.Boolean(),
                reason_code: Type.String({ minLength: 1, maxLength: 128 }),
                clause_results: Type.Array(SemanticClauseResultV1Schema, {
                  minItems: 1,
                  maxItems: 64,
                }),
                trial_invocation_receipt_id: Type.String({
                  pattern: "^semreview_[a-f0-9]{64}$",
                }),
                oracle_invocation_receipt_id: Type.String({
                  pattern: "^semreview_[a-f0-9]{64}$",
                }),
                trial_packet_sha256: DigestSchema,
                oracle_packet_sha256: DigestSchema,
                trial_review_journal_ref: ArtifactRefSchema,
                oracle_review_journal_ref: ArtifactRefSchema,
              },
              { additionalProperties: false }
            ),
            { maxItems: 4_096 }
          ),
        },
        { additionalProperties: false }
      )
    ),
    invalid_evaluation: Type.Optional(
      Type.Object(
        {
          stage: InvalidEvaluationStageV1Schema,
          code: Type.String({ minLength: 1, maxLength: 128 }),
          trial_id: Type.Union([Type.String({ pattern: "^evaltrial_[a-f0-9]{64}$" }), Type.Null()]),
        },
        { additionalProperties: false }
      )
    ),
    disposition: EvaluationDispositionV1Schema,
    disposition_reason: EvaluationDispositionReasonV1Schema,
  },
  { additionalProperties: false }
);
export type PairedEvaluationResultV1 = Readonly<Static<typeof PairedEvaluationResultV1Schema>>;

function requireUnique(values: readonly string[], label: string): void {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) throw new Error(`${label} contains duplicate '${duplicate}'`);
}

export function validateEvaluationPopulation(
  value: unknown,
  options: { readonly forbiddenContaminationGroups?: readonly string[] } = {}
): EvaluationPopulationV1 {
  const population = validateContract(
    EvaluationPopulationV1Schema,
    value,
    "EvaluationPopulationV1"
  );
  requireUnique(
    population.tasks.map((task) => task.task_id),
    "evaluation population task IDs"
  );
  if (options.forbiddenContaminationGroups?.includes(population.contamination_group) === true) {
    throw new Error(
      `evaluation population contamination group '${population.contamination_group}' overlaps declared development/tuning data`
    );
  }
  if (population.purpose !== "harness_self_test") {
    const domains = new Set(population.tasks.map((task) => task.domain));
    if (domains.size < 5) {
      throw new Error("real evaluation populations require at least five unrelated domains");
    }
    if (!population.tasks.some((task) => task.trigger_expected)) {
      throw new Error("real evaluation populations require a positive trigger task");
    }
    if (!population.tasks.some((task) => !task.trigger_expected)) {
      throw new Error("real evaluation populations require a negative trigger task");
    }
  }
  return population;
}

export function validatePairedEvaluationPlan(value: unknown): PairedEvaluationPlanV1 {
  const plan = validateContract(PairedEvaluationPlanV1Schema, value, "PairedEvaluationPlanV1");
  requireUnique(
    plan.ablations.map((ablation) => ablation.name),
    "paired evaluation ablation names"
  );
  requireUnique(
    plan.ablation_policies.map((policy) => policy.ablation_name),
    "paired evaluation ablation policy names"
  );
  requireUnique(
    plan.comparison_validity_policy.required_comparator_normalized_completion_floors.map(
      (policy) => policy.comparator_name
    ),
    "paired evaluation comparator coverage policy names"
  );
  if (
    plan.baseline.registration_name === plan.candidate.name ||
    plan.ablations.some(
      (ablation) =>
        ablation.name === plan.baseline.registration_name || ablation.name === plan.candidate.name
    )
  ) {
    throw new Error("baseline, candidate, and ablation names must be distinct");
  }
  const ablationNames = new Set(plan.ablations.map((ablation) => ablation.name));
  const comparatorCoverageNames = new Set(
    plan.comparison_validity_policy.required_comparator_normalized_completion_floors.map(
      (policy) => policy.comparator_name
    )
  );
  if (
    comparatorCoverageNames.size !== ablationNames.size ||
    [...ablationNames].some((name) => !comparatorCoverageNames.has(name))
  ) {
    throw new Error("paired evaluation comparator coverage floors require exact ablation parity");
  }
  const readiness = plan.comparison_validity_policy.readiness_preflight;
  if (plan.purpose !== "harness_self_test" && !readiness.required) {
    throw new Error("real evaluations require the frozen all-arm readiness preflight");
  }
  if (readiness.required) {
    requireUnique(
      readiness.required_comparator_normalized_completion_floors.map(
        (policy) => policy.comparator_name
      ),
      "readiness comparator coverage policy names"
    );
    const readinessComparatorNames = new Set(
      readiness.required_comparator_normalized_completion_floors.map(
        (policy) => policy.comparator_name
      )
    );
    if (
      readinessComparatorNames.size !== ablationNames.size ||
      [...ablationNames].some((name) => !readinessComparatorNames.has(name))
    ) {
      throw new Error("readiness comparator coverage floors require exact ablation parity");
    }
    const readinessPairFloor =
      readiness.complete_all_arm_pair_floor ??
      plan.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor;
    if (
      readinessPairFloor >
      readiness.baseline_normalized_completion_floor +
        readiness.candidate_normalized_completion_floor -
        1 +
        Number.EPSILON
    ) {
      throw new Error(
        "readiness pair floor must not exceed the baseline/candidate union-bound floor"
      );
    }
  }
  const baselineFloor = plan.comparison_validity_policy.baseline_normalized_completion_floor;
  const candidateFloor = plan.comparison_validity_policy.candidate_normalized_completion_floor;
  const pairFloor = plan.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor;
  if (
    candidateFloor !== undefined &&
    pairFloor > baselineFloor + candidateFloor - 1 + Number.EPSILON
  ) {
    throw new Error(
      "comparison-validity pair floor must not exceed the baseline/candidate union-bound floor"
    );
  }
  if (
    plan.purpose === "part_b" &&
    (baselineFloor < 0.9 ||
      (candidateFloor !== undefined && candidateFloor < 0.9) ||
      plan.comparison_validity_policy.required_comparator_normalized_completion_floors.some(
        (policy) => policy.normalized_completion_floor < 0.9
      ))
  ) {
    throw new Error("Part B comparison-validity floors require 0.90 arm coverage");
  }
  const unresolvedPolicy = plan.ablation_policies.find(
    (policy) => !ablationNames.has(policy.ablation_name)
  );
  if (unresolvedPolicy !== undefined) {
    throw new Error(
      `ablation policy '${unresolvedPolicy.ablation_name}' has no frozen ablation binding`
    );
  }
  if (plan.mutation_gate !== null) {
    const scheduledAblationName = plan.mutation_gate.ablation_name;
    const evaluationOnlyControl = plan.mutation_gate.evaluation_only_control;
    if ((scheduledAblationName === undefined) === (evaluationOnlyControl === undefined)) {
      throw new Error(
        "mutation gate requires exactly one scheduled ablation or evaluation-only control binding"
      );
    }
    if (scheduledAblationName !== undefined && !ablationNames.has(scheduledAblationName)) {
      throw new Error(`mutation gate ablation '${scheduledAblationName}' has no frozen binding`);
    }
    if (
      evaluationOnlyControl !== undefined &&
      (evaluationOnlyControl.name === plan.baseline.registration_name ||
        evaluationOnlyControl.name === plan.candidate.name ||
        ablationNames.has(evaluationOnlyControl.name))
    ) {
      throw new Error(
        "mutation gate evaluation-only control must be absent from the live schedule"
      );
    }
    if (
      plan.mutation_gate.ablation_minimum_escaped_invalid_count > plan.mutation_gate.mutation_count
    ) {
      throw new Error("mutation gate minimum escape count exceeds its mutation cohort");
    }
  }
  const requiredFailureDisposition = plan.purpose === "part_b" ? "RETIRED" : "NO_BUILD";
  if (plan.deterministic_disposition_rule.on_fail !== requiredFailureDisposition) {
    throw new Error(`${plan.purpose} evaluations require on_fail=${requiredFailureDisposition}`);
  }
  return plan;
}

export function evaluationPopulationSha256(value: unknown): string {
  return sha256(canonicalJson(validateEvaluationPopulation(value)));
}

export function pairedEvaluationPlanSha256(value: unknown): string {
  return sha256(canonicalJson(validatePairedEvaluationPlan(value)));
}

function scheduleVariants(plan: PairedEvaluationPlanV1): ReadonlyArray<{
  readonly variant: EvaluationTrialVariantV1;
  readonly variant_name: string;
  readonly binding_sha256: string;
}> {
  return [
    {
      variant: "baseline",
      variant_name: plan.baseline.registration_name,
      binding_sha256: plan.baseline.definition_sha256,
    },
    {
      variant: "candidate",
      variant_name: plan.candidate.name,
      binding_sha256: plan.candidate.contract_sha256,
    },
    ...[...plan.ablations]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((ablation) => ({
        variant: "ablation" as const,
        variant_name: ablation.name,
        binding_sha256: ablation.contract_sha256,
      })),
  ];
}

export function materializePairedEvaluationSchedule(input: {
  readonly population: EvaluationPopulationV1;
  readonly plan: PairedEvaluationPlanV1;
}): readonly PairedEvaluationScheduleEntryV1[] {
  const pairs = input.population.tasks.flatMap((task) =>
    Array.from({ length: input.plan.repetitions }, (_unused, index) => {
      const repetition = index + 1;
      const pairIdentity = {
        plan_id: input.plan.plan_id,
        population_id: input.population.population_id,
        population_revision: input.population.revision,
        task_id: task.task_id,
        repetition,
      };
      return {
        task,
        repetition,
        pair_id: `evalpair_${sha256(canonicalJson(pairIdentity))}`,
        order_sha256: sha256(
          canonicalJson({ pair_order_seed: input.plan.pair_order_seed, ...pairIdentity })
        ),
      };
    })
  );
  pairs.sort(
    (left, right) =>
      left.order_sha256.localeCompare(right.order_sha256) ||
      left.task.task_id.localeCompare(right.task.task_id) ||
      left.repetition - right.repetition
  );
  const unordered = pairs.flatMap((pair) => {
    const variants = [...scheduleVariants(input.plan)];
    const reversePair =
      Number.parseInt(
        sha256(
          canonicalJson({ pair_order_seed: input.plan.pair_order_seed, pair_id: pair.pair_id })
        ).slice(0, 2),
        16
      ) %
        2 ===
      1;
    if (reversePair) [variants[0], variants[1]] = [variants[1], variants[0]];
    return variants.map((variant) => {
      const identity = {
        pair_id: pair.pair_id,
        task_id: pair.task.task_id,
        repetition: pair.repetition,
        variant: variant.variant,
        variant_name: variant.variant_name,
        binding_sha256: variant.binding_sha256,
      };
      return {
        trial_id: `evaltrial_${sha256(canonicalJson(identity))}`,
        pair_id: pair.pair_id,
        ordinal: 0,
        task_id: pair.task.task_id,
        repetition: pair.repetition,
        ...variant,
      };
    });
  });
  return unordered.map((entry, ordinal) =>
    validateContract(
      PairedEvaluationScheduleEntryV1Schema,
      { ...entry, ordinal },
      "paired evaluation schedule entry"
    )
  );
}

export function freezePairedEvaluationContracts(input: {
  readonly population: unknown;
  readonly plan: unknown;
  readonly forbiddenContaminationGroups?: readonly string[];
}): FrozenPairedEvaluationV1 {
  const population = validateEvaluationPopulation(input.population, {
    ...(input.forbiddenContaminationGroups === undefined
      ? {}
      : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
  });
  const plan = validatePairedEvaluationPlan(input.plan);
  const populationSha256 = sha256(canonicalJson(population));
  if (
    plan.purpose !== population.purpose ||
    plan.population.population_id !== population.population_id ||
    plan.population.revision !== population.revision ||
    plan.population.sha256 !== populationSha256
  ) {
    throw new Error("paired evaluation plan population binding is stale");
  }
  const schedule = materializePairedEvaluationSchedule({ population, plan });
  return validateContract(
    FrozenPairedEvaluationV1Schema,
    {
      schema_version: 1,
      plan_id: plan.plan_id,
      plan_sha256: sha256(canonicalJson(plan)),
      population_id: population.population_id,
      population_revision: population.revision,
      population_sha256: populationSha256,
      candidate_name: plan.candidate.name,
      candidate_contract_sha256: plan.candidate.contract_sha256,
      baseline_definition_sha256: plan.baseline.definition_sha256,
      budget_policy_sha256: plan.budget_policy_sha256,
      grader_registry_sha256: plan.grader_registry_sha256,
      implementation_binding_sha256: plan.implementation_binding_sha256,
      schedule_sha256: sha256(canonicalJson(schedule)),
      schedule,
    },
    "FrozenPairedEvaluationV1"
  );
}

export function assertFrozenEvaluationInputs(input: {
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: unknown;
  readonly plan: unknown;
  readonly forbiddenContaminationGroups?: readonly string[];
}): void {
  const actual = freezePairedEvaluationContracts({
    population: input.population,
    plan: input.plan,
    ...(input.forbiddenContaminationGroups === undefined
      ? {}
      : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
  });
  if (canonicalJson(actual) !== canonicalJson(input.frozen)) {
    throw new Error("paired evaluation inputs drifted after freeze");
  }
}

export function pairedEvaluationResultId(
  value: Omit<PairedEvaluationResultV1, "result_id">
): string {
  return `evalres_${sha256(canonicalJson(value))}`;
}

function roundedCoverage(completed: number, scheduled: number): number {
  return scheduled === 0
    ? 0
    : Math.round((completed / scheduled + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function isNormalizedCompletion(trial: PairedEvaluationTrialV1): boolean {
  return (
    trial.terminal_status === "complete" &&
    !trial.failure_rule_applied &&
    trial.failure_code === null
  );
}

function normalizedCompletionProjection(trials: readonly PairedEvaluationTrialV1[]) {
  const normalizedCompletions = trials.filter(isNormalizedCompletion).length;
  return {
    scheduled_trials: trials.length,
    normalized_completions: normalizedCompletions,
    incomplete_or_failed_trials: trials.length - normalizedCompletions,
    coverage: roundedCoverage(normalizedCompletions, trials.length),
  };
}

function candidateFailureTaxonomy(trials: readonly PairedEvaluationTrialV1[]) {
  const counts = new Map<string, number>();
  for (const trial of trials) {
    if (isNormalizedCompletion(trial)) continue;
    if (trial.failure_code === null) {
      throw new Error("non-normalized candidate trial requires a failure code");
    }
    counts.set(trial.failure_code, (counts.get(trial.failure_code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([failure_code, count]) => ({ failure_code, count }));
}

export function validatePairedEvaluationResult(value: unknown): PairedEvaluationResultV1 {
  const result = validateContract(
    PairedEvaluationResultV1Schema,
    value,
    "PairedEvaluationResultV1"
  );
  const { result_id: _resultId, ...body } = result;
  if (pairedEvaluationResultId(body) !== result.result_id) {
    throw new Error("paired evaluation result ID does not match its body");
  }
  requireUnique(
    result.trials.map((trial) => trial.trial_id),
    "paired evaluation result trial IDs"
  );
  for (const trial of result.trials) {
    if (trial.measurement.clause_results !== undefined) {
      requireUnique(
        trial.measurement.clause_results.map((clause) => clause.clause_id),
        `paired evaluation trial '${trial.trial_id}' clause IDs`
      );
    }
  }
  const semanticQualification = result.semantic_qualification;
  if (semanticQualification !== undefined) {
    requireUnique(
      semanticQualification.trial_qualifications.map((qualification) => qualification.trial_id),
      "semantic qualification trial IDs"
    );
    const trialById = new Map(result.trials.map((trial) => [trial.trial_id, trial]));
    for (const qualification of semanticQualification.trial_qualifications) {
      const trial = trialById.get(qualification.trial_id);
      if (
        trial === undefined ||
        trial.task_id !== qualification.task_id ||
        trial.repetition !== qualification.repetition ||
        trial.variant !== qualification.variant ||
        trial.variant_name !== qualification.variant_name ||
        trial.terminal_status !== "complete"
      ) {
        throw new Error("semantic qualification mapping is stale or foreign");
      }
      requireUnique(
        qualification.clause_results.map((clause) => clause.clause_id),
        `semantic qualification '${qualification.trial_id}' clause IDs`
      );
      if (
        (qualification.qualification_status === "QUALIFIED") !== qualification.aggregate_success ||
        (qualification.task_disposition === "PASS") !== qualification.aggregate_success
      ) {
        throw new Error("semantic task qualification disposition is inconsistent");
      }
      for (const ref of [
        qualification.trial_review_journal_ref,
        qualification.oracle_review_journal_ref,
      ]) {
        if (
          ref.kind !== "semantic-review-journal" ||
          ref.content_schema?.schema_id !== "penny.semantic-review-journal.v1" ||
          ref.content_schema.schema_version !== 1
        ) {
          throw new Error("semantic qualification journal ref is foreign");
        }
      }
    }
    if (
      (semanticQualification.reason_code === "SEMANTIC_REVIEW_NOT_CONFIGURED" &&
        (semanticQualification.status !== "NOT_QUALIFIED" ||
          semanticQualification.provider_calls !== 0 ||
          semanticQualification.trial_qualifications.length !== 0)) ||
      (semanticQualification.status === "QUALIFIED" &&
        (semanticQualification.reason_code !== "ALL_SCHEDULED_ARMS_QUALIFIED" ||
          semanticQualification.trial_qualifications.length !== result.trials.length ||
          !semanticQualification.trial_qualifications.every(
            (qualification) => qualification.qualification_status === "QUALIFIED"
          ))) ||
      (semanticQualification.status === "INVALID_EVALUATION" &&
        (semanticQualification.reason_code !== "EVALUATION_INVALID" ||
          result.disposition !== "INVALID_EVALUATION")) ||
      (semanticQualification.reason_code === "SCHEDULED_ARM_NOT_QUALIFIED" &&
        (semanticQualification.status !== "NOT_QUALIFIED" ||
          (semanticQualification.trial_qualifications.length === result.trials.length &&
            semanticQualification.trial_qualifications.every(
              (qualification) => qualification.qualification_status === "QUALIFIED"
            ))))
    ) {
      throw new Error("paired evaluation semantic qualification is inconsistent");
    }
  }
  const statuses = result.trials.map((trial) => trial.terminal_status);
  const accounted = {
    scheduled: result.trials.length,
    complete: statuses.filter((status) => status === "complete").length,
    missing: statuses.filter((status) => status === "missing").length,
    nonterminal: statuses.filter((status) => status === "nonterminal").length,
    cancelled: statuses.filter((status) => status === "cancelled").length,
    malformed: statuses.filter((status) => status === "malformed").length,
    error: statuses.filter((status) => status === "error").length,
  };
  if (canonicalJson(accounted) !== canonicalJson(result.trial_accounting)) {
    throw new Error("paired evaluation trial accounting is inconsistent");
  }
  const candidateTrials = result.trials.filter((trial) => trial.variant === "candidate");
  const baselineTrials = result.trials.filter((trial) => trial.variant === "baseline");
  const candidateReliability = normalizedCompletionProjection(candidateTrials);
  if (
    canonicalJson(candidateReliability) !== canonicalJson(result.candidate_completion_reliability)
  ) {
    throw new Error("paired evaluation candidate completion reliability is inconsistent");
  }
  if (
    canonicalJson(candidateFailureTaxonomy(candidateTrials)) !==
    canonicalJson(result.candidate_failure_taxonomy)
  ) {
    throw new Error("paired evaluation candidate failure taxonomy is inconsistent");
  }
  const baselineCoverage = normalizedCompletionProjection(baselineTrials);
  if (
    result.comparison_validity.baseline.scheduled_trials !== baselineCoverage.scheduled_trials ||
    result.comparison_validity.baseline.normalized_completions !==
      baselineCoverage.normalized_completions ||
    result.comparison_validity.baseline.incomplete_or_failed_trials !==
      baselineCoverage.incomplete_or_failed_trials ||
    result.comparison_validity.baseline.coverage !== baselineCoverage.coverage ||
    result.comparison_validity.baseline.passed !==
      baselineCoverage.coverage >= result.comparison_validity.baseline.frozen_floor
  ) {
    throw new Error("paired evaluation baseline validity coverage is inconsistent");
  }
  const candidateValidity = result.comparison_validity.candidate;
  if (
    candidateValidity !== undefined &&
    (candidateValidity.scheduled_trials !== candidateReliability.scheduled_trials ||
      candidateValidity.normalized_completions !== candidateReliability.normalized_completions ||
      candidateValidity.incomplete_or_failed_trials !==
        candidateReliability.incomplete_or_failed_trials ||
      candidateValidity.coverage !== candidateReliability.coverage ||
      candidateValidity.passed !== candidateValidity.coverage >= candidateValidity.frozen_floor)
  ) {
    throw new Error("paired evaluation candidate validity coverage is inconsistent");
  }
  const byPair = new Map<
    string,
    { baseline?: PairedEvaluationTrialV1; candidate?: PairedEvaluationTrialV1 }
  >();
  for (const trial of [...baselineTrials, ...candidateTrials]) {
    const pair = byPair.get(trial.pair_id) ?? {};
    if (trial.variant === "baseline") pair.baseline = trial;
    if (trial.variant === "candidate") pair.candidate = trial;
    byPair.set(trial.pair_id, pair);
  }
  const scheduledPairs = byPair.size;
  const completePairs = [...byPair.values()].filter(
    (pair) =>
      pair.baseline !== undefined &&
      pair.candidate !== undefined &&
      isNormalizedCompletion(pair.baseline) &&
      isNormalizedCompletion(pair.candidate)
  ).length;
  const completePairProjection = {
    scheduled_pairs: scheduledPairs,
    complete_pairs: completePairs,
    incomplete_pairs: scheduledPairs - completePairs,
    coverage: roundedCoverage(completePairs, scheduledPairs),
  };
  if (
    canonicalJson(completePairProjection) !== canonicalJson(result.complete_pair_coverage) ||
    result.comparison_validity.complete_pairs.scheduled_pairs !== scheduledPairs ||
    result.comparison_validity.complete_pairs.complete_pairs !== completePairs ||
    result.comparison_validity.complete_pairs.incomplete_pairs !== scheduledPairs - completePairs ||
    result.comparison_validity.complete_pairs.coverage !== completePairProjection.coverage ||
    result.comparison_validity.complete_pairs.passed !==
      completePairProjection.coverage >= result.comparison_validity.complete_pairs.frozen_floor
  ) {
    throw new Error("paired evaluation complete-pair validity coverage is inconsistent");
  }
  requireUnique(
    result.comparison_validity.required_comparators.map((entry) => entry.comparator_name),
    "paired evaluation result comparator coverage names"
  );
  for (const comparator of result.comparison_validity.required_comparators) {
    const projection = normalizedCompletionProjection(
      result.trials.filter(
        (trial) => trial.variant === "ablation" && trial.variant_name === comparator.comparator_name
      )
    );
    if (
      comparator.scheduled_trials !== projection.scheduled_trials ||
      comparator.normalized_completions !== projection.normalized_completions ||
      comparator.incomplete_or_failed_trials !== projection.incomplete_or_failed_trials ||
      comparator.coverage !== projection.coverage ||
      comparator.passed !== comparator.coverage >= comparator.frozen_floor
    ) {
      throw new Error("paired evaluation required comparator coverage is inconsistent");
    }
  }
  const expectedInvalidReasons: ComparisonInvalidReasonV1[] =
    result.disposition_reason === "EVALUATION_INCOMPATIBILITY"
      ? ["EVALUATION_INCOMPATIBILITY"]
      : !result.comparison_validity.baseline.passed
        ? ["BASELINE_NORMALIZED_COMPLETION_BELOW_FLOOR"]
        : candidateReliability.normalized_completions === 0
          ? ["CANDIDATE_ZERO_NORMALIZED_COMPLETIONS"]
          : [
              ...((candidateValidity?.passed ?? true)
                ? []
                : (["CANDIDATE_NORMALIZED_COMPLETION_BELOW_FLOOR"] as const)),
              ...(result.comparison_validity.complete_pairs.passed
                ? []
                : (["COMPLETE_PAIR_COVERAGE_BELOW_FLOOR"] as const)),
              ...(result.comparison_validity.required_comparators.every(
                (comparator) => comparator.passed
              )
                ? []
                : (["REQUIRED_COMPARATOR_NORMALIZED_COMPLETION_BELOW_FLOOR"] as const)),
            ];
  if (
    canonicalJson(result.comparison_validity.invalid_reasons) !==
      canonicalJson(expectedInvalidReasons) ||
    result.comparison_validity.status !==
      (expectedInvalidReasons.length === 0 ? "VALID" : "COMPARATIVE_UNVERIFIABLE") ||
    result.policy_outcomes.comparison_validity !== (expectedInvalidReasons.length === 0)
  ) {
    throw new Error("paired evaluation comparison-validity projection is inconsistent");
  }
  const policyValues = Object.entries(result.policy_outcomes)
    .filter(([name]) => name !== "all_passed")
    .map(([, passed]) => passed);
  if (result.policy_outcomes.all_passed !== policyValues.every((passed) => passed === true)) {
    throw new Error("paired evaluation all_passed projection is inconsistent");
  }
  if (
    result.ablation_metrics.some(
      (metric) =>
        metric.passed !== metric.candidate_minus_ablation_primary_delta >= metric.frozen_floor
    )
  ) {
    throw new Error("paired evaluation ablation metric projection is inconsistent");
  }
  if (
    result.disposition !== "INVALID_EVALUATION" &&
    result.policy_outcomes.ablation_non_inferiority !==
      result.ablation_metrics.every((metric) => metric.passed)
  ) {
    throw new Error("paired evaluation ablation policy projection is inconsistent");
  }
  const domainMetrics = result.domain_metrics;
  if (domainMetrics !== undefined) {
    requireUnique(
      domainMetrics.map((metric) => metric.domain),
      "paired evaluation domain metric names"
    );
    if (
      domainMetrics.some(
        (metric) =>
          metric.candidate_scheduled_mean_passed !==
            metric.candidate_scheduled_mean >= metric.candidate_scheduled_mean_floor ||
          metric.candidate_minus_baseline_paired_mean_passed !==
            (metric.candidate_minus_baseline_paired_mean_delta !== null &&
              metric.candidate_minus_baseline_paired_mean_delta >=
                metric.candidate_minus_baseline_paired_mean_floor)
      )
    ) {
      throw new Error("paired evaluation domain metric projection is inconsistent");
    }
  }
  const mutation = result.mutation_gate;
  if (mutation !== null) {
    if (
      (mutation.ablation_name === undefined) ===
      (mutation.evaluation_only_control_name === undefined)
    ) {
      throw new Error("paired evaluation mutation result requires exactly one control name");
    }
    if (
      mutation.full_sealer_escaped_invalid_count > mutation.mutation_count ||
      mutation.ablation_escaped_invalid_count > mutation.mutation_count
    ) {
      throw new Error("paired evaluation mutation counts exceed the frozen cohort");
    }
    const expectedRate =
      Math.round(
        (mutation.full_sealer_escaped_invalid_count / mutation.mutation_count + Number.EPSILON) *
          1_000_000
      ) / 1_000_000;
    const expectedPassed =
      expectedRate <= mutation.frozen_full_sealer_rate_ceiling &&
      mutation.ablation_escaped_invalid_count >=
        mutation.frozen_ablation_minimum_escaped_invalid_count;
    if (
      mutation.full_sealer_escaped_invalid_rate !== expectedRate ||
      mutation.passed !== expectedPassed
    ) {
      throw new Error("paired evaluation mutation gate projection is inconsistent");
    }
  }
  if (
    result.disposition !== "INVALID_EVALUATION" &&
    result.policy_outcomes.deterministic_mutation !== (mutation?.passed ?? true)
  ) {
    throw new Error("paired evaluation mutation policy projection is inconsistent");
  }
  if (result.disposition === "INVALID_EVALUATION") {
    if (result.invalid_evaluation === undefined) {
      throw new Error("INVALID_EVALUATION disposition requires its incompatibility marker");
    }
    if (result.policy_outcomes.all_passed) {
      throw new Error("INVALID_EVALUATION cannot claim every frozen policy passed");
    }
  } else if (result.invalid_evaluation !== undefined) {
    throw new Error("non-invalid evaluation dispositions prohibit an incompatibility marker");
  }
  if (result.disposition === "CANDIDATE" && !result.policy_outcomes.all_passed) {
    throw new Error("CANDIDATE disposition requires every frozen policy to pass");
  }
  if (
    (result.disposition_reason === "FROZEN_POLICY_PASS" &&
      (result.disposition !== "CANDIDATE" || !result.policy_outcomes.all_passed)) ||
    (result.disposition_reason === "FROZEN_POLICY_FAIL" &&
      (result.disposition === "CANDIDATE" ||
        result.disposition === "INVALID_EVALUATION" ||
        result.policy_outcomes.all_passed ||
        result.comparison_validity.status !== "VALID")) ||
    (result.disposition_reason === "CANDIDATE_ZERO_NORMALIZED_COMPLETIONS" &&
      (result.disposition !== "RETIRED" ||
        candidateReliability.normalized_completions !== 0 ||
        !result.comparison_validity.baseline.passed ||
        result.invalid_evaluation !== undefined)) ||
    (result.disposition_reason === "COMPARATIVE_UNVERIFIABLE" &&
      (result.disposition !== "INVALID_EVALUATION" ||
        result.invalid_evaluation?.stage !== "comparison_validity" ||
        result.invalid_evaluation.code !== "COMPARATIVE_UNVERIFIABLE")) ||
    (result.disposition_reason === "EVALUATION_INCOMPATIBILITY" &&
      (result.disposition !== "INVALID_EVALUATION" ||
        result.invalid_evaluation === undefined ||
        result.invalid_evaluation.stage === "comparison_validity"))
  ) {
    throw new Error("paired evaluation disposition reason is inconsistent");
  }
  return result;
}
