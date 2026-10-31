import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, type ArtifactRef, validateContract } from "../contracts.js";
import { validateRequiredModelIdentity, type RequiredModelIdentityV1 } from "../required-model.js";
import {
  SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
  ScaP05HypothesisBodyV1Schema,
  validateScaP05HypothesisBodyV1,
  validateScaP05HypothesisRevisionV1,
  type ScaP05HypothesisBodyV1,
  type ScaP05HypothesisRevisionV1,
} from "./p05-contracts.js";

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const OpaqueIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" });
const NonEmptyTextSchema = Type.String({ minLength: 1, maxLength: 16_384 });
const BlockerCodeSchema = Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" });
const Rfc3339UtcSchema = Type.String({
  pattern:
    "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?Z$",
});

export const SCA_P06_PHASE_ID = "SCA-P06" as const;
export const SCA_P06_DECIDING_STATE = "selecting_evidence_actions" as const;
export const SCA_P06_FINAL_STATE = "finalizing_evidence_decisions" as const;
export const SCA_P06_DECIDER_ROLE = "evidence_action_decider" as const;
export const SCA_P06_REQUIRED_MODEL: RequiredModelIdentityV1 = Object.freeze({
  schema_version: 1,
  alias: "deepseek-flash",
  provider: "ollama",
  model: "deepseek-v4.1-flash:cloud",
  override: "ollama/deepseek-v4.1-flash:cloud",
});
export const SCA_P06_REQUIRED_TOOL_SUBSET = Object.freeze([] as const);
export const SCA_P06_PROVIDER_OPENING_GUARD = "sca_p06_payload_disclosure_v1" as const;

export const SCA_P06_REQUEST_V1_SCHEMA = "penny.sca-p06-request.v1" as const;
export const SCA_P06_IMPLEMENTATION_IDENTITY_V1_SCHEMA =
  "penny.sca-p06-implementation-identity.v1" as const;
export const SCA_P06_RUNTIME_POLICY_V1_SCHEMA = "penny.sca-p06-runtime-policy.v1" as const;
export const SCA_P06_ACTION_AUTHORITY_V1_SCHEMA = "penny.sca-p06-action-authority.v1" as const;
export const SCA_P06_RESOURCE_POLICY_V1_SCHEMA = "penny.sca-p06-resource-policy.v1" as const;
export const SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA =
  "penny.sca-p06-disclosure-authority.v1" as const;
export const SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA = "penny.sca-p06-disclosure-scope.v1" as const;
export const SCA_P06_ACCEPTED_COHORT_V1_SCHEMA = "penny.sca-p06-accepted-cohort.v1" as const;
export const SCA_P06_OBLIGATION_REVISION_V1_SCHEMA =
  "penny.sca-p06-obligation-revision.v1" as const;
export const SCA_P06_DISCOVERY_REASSESSMENT_V1_SCHEMA =
  "penny.sca-p06-discovery-reassessment.v1" as const;
export const SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA = "penny.sca-p06-cognitive-payload.v1" as const;
export const SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA =
  "penny.sca-p06-disclosure-admission.v1" as const;
export const SCA_P06_DECISION_RESULT_V1_SCHEMA = "penny.sca-p06-decision-result.v1" as const;
export const SCA_P06_ACTION_RECORD_V1_SCHEMA = "penny.sca-p06-action-record.v1" as const;
export const SCA_P06_CHECKPOINT_V1_SCHEMA = "penny.sca-p06-checkpoint.v1" as const;
export const SCA_P06_TRACEABILITY_V1_SCHEMA = "penny.sca-p06-traceability.v1" as const;
export const SCA_P06_EVIDENCE_MANIFEST_V1_SCHEMA = "penny.sca-p06-evidence-manifest.v1" as const;
export const SCA_P06_SUCCESSOR_LEDGER_V1_SCHEMA = "penny.sca-p06-successor-ledger.v1" as const;
export const SCA_P06_GATE_V1_SCHEMA = "penny.sca-p06-gate.v1" as const;
export const SCA_P06_TO_P07_TRANSITION_V1_SCHEMA = "penny.sca-p06-to-p07-transition.v1" as const;
export const SCA_P06_TERMINAL_V1_SCHEMA = "penny.sca-p06-terminal.v1" as const;

export const SCA_P06_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-P06-ACCEPTANCE",
  "SCA-OBL-OUTPUT-P06-ACTION-RECORDS",
  "SCA-OBL-OUTPUT-P06-TRACEABILITY",
] as const);

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
const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);
const HypothesisIdSchema = Type.String({ pattern: "^p05h_[a-f0-9]{64}$" });
const P06ObligationIdSchema = Type.String({
  pattern: "^p06obl_[a-f0-9]{64}_(?:evidence_decision|material)_0001$",
});
const ActionKindSchema = Type.Union([
  Type.Literal("source_query"),
  Type.Literal("graph_query"),
  Type.Literal("application_test"),
]);
const AuthorityDecisionSchema = Type.Union([
  Type.Literal("approved"),
  Type.Literal("denied"),
  Type.Literal("unavailable"),
]);
const DecisionClassificationSchema = Type.Union([
  Type.Literal("source_sufficient"),
  Type.Literal("graph_needed"),
  Type.Literal("runtime_needed"),
  Type.Literal("no_authorized_action"),
]);

export const ScaP06RequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_REQUEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    p05_transition_ref: ArtifactRefSchema,
    implementation_identity_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    action_authority_ref: ArtifactRefSchema,
    resource_policy_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    requested_at: Rfc3339UtcSchema,
    request_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_REQUEST_V1_SCHEMA }
);
export type ScaP06RequestV1 = Readonly<Static<typeof ScaP06RequestV1Schema>>;

export const ScaP06ImplementationIdentityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_IMPLEMENTATION_IDENTITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    implementation_revision: OpaqueIdSchema,
    contracts_sha256: Sha256Schema,
    prompts_sha256: Sha256Schema,
    identity_scope: Type.Literal("caller_declaration_not_runtime_attestation"),
    host_issued: Type.Literal(true),
    required_model: RequiredModelSchema,
  },
  { additionalProperties: false, $id: SCA_P06_IMPLEMENTATION_IDENTITY_V1_SCHEMA }
);
export type ScaP06ImplementationIdentityV1 = Readonly<
  Static<typeof ScaP06ImplementationIdentityV1Schema>
>;

const ChildIntegrationPolicySchema = Type.Object(
  {
    status: Type.Literal("unavailable"),
    compatible_capability_ids: Type.Tuple([]),
    mandatory_invocation: Type.Literal(false),
    reason_code: Type.Literal("no_admitted_compatible_child_integration"),
  },
  { additionalProperties: false }
);

export const ScaP06RuntimePolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_RUNTIME_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    policy_id: OpaqueIdSchema,
    required_model: RequiredModelSchema,
    required_tools: Type.Tuple([]),
    max_active_hypotheses: Type.Integer({ minimum: 1, maximum: 10_000 }),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 786_432 }),
    max_provider_calls: Type.Literal(1),
    allow_payload_truncation: Type.Literal(false),
    allow_model_fallback: Type.Literal(false),
    malformed_semantic_output: Type.Literal("checkpoint_without_retry"),
    remote_unknown_recovery: Type.Literal("quarantine_without_replay"),
    child_integration: ChildIntegrationPolicySchema,
    status: Type.Literal("approved"),
  },
  { additionalProperties: false, $id: SCA_P06_RUNTIME_POLICY_V1_SCHEMA }
);
export type ScaP06RuntimePolicyV1 = Readonly<Static<typeof ScaP06RuntimePolicyV1Schema>>;

const ActionAuthorityModeSchema = Type.Object(
  {
    action_kind: ActionKindSchema,
    authority_id: OpaqueIdSchema,
    decision: AuthorityDecisionSchema,
    reason_code: BlockerCodeSchema,
    scope: Type.Literal("p06_decision_only_not_p07_execution_authority"),
  },
  { additionalProperties: false }
);
const HypothesisAuthoritySchema = Type.Object(
  {
    hypothesis_id: HypothesisIdSchema,
    final_revision_ref: ArtifactRefSchema,
    modes: Type.Tuple([
      Type.Intersect([
        ActionAuthorityModeSchema,
        Type.Object({ action_kind: Type.Literal("source_query") }),
      ]),
      Type.Intersect([
        ActionAuthorityModeSchema,
        Type.Object({ action_kind: Type.Literal("graph_query") }),
      ]),
      Type.Intersect([
        ActionAuthorityModeSchema,
        Type.Object({ action_kind: Type.Literal("application_test") }),
      ]),
    ]),
  },
  { additionalProperties: false }
);

export const ScaP06ActionAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_ACTION_AUTHORITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    source_snapshot_sha256: Sha256Schema,
    p05_transition_ref: ArtifactRefSchema,
    hypothesis_authorities: Type.Array(HypothesisAuthoritySchema, {
      minItems: 1,
      maxItems: 10_000,
    }),
    issued_at: Rfc3339UtcSchema,
    authority_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_ACTION_AUTHORITY_V1_SCHEMA }
);
export type ScaP06ActionAuthorityV1 = Readonly<Static<typeof ScaP06ActionAuthorityV1Schema>>;
export type ScaP06HypothesisAuthorityV1 = Readonly<Static<typeof HypothesisAuthoritySchema>>;

const ResourceProfileSchema = Type.Object(
  {
    action_kind: ActionKindSchema,
    profile_id: OpaqueIdSchema,
    timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    max_result_items: Type.Integer({ minimum: 1, maximum: 10_000 }),
    max_selectors: Type.Integer({ minimum: 1, maximum: 32 }),
    scope: Type.Literal("p06_decision_only_not_p07_execution_budget"),
  },
  { additionalProperties: false }
);

export const ScaP06ResourcePolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_RESOURCE_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    policy_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    p05_transition_ref: ArtifactRefSchema,
    profiles: Type.Tuple([
      Type.Intersect([
        ResourceProfileSchema,
        Type.Object({ action_kind: Type.Literal("source_query") }),
      ]),
      Type.Intersect([
        ResourceProfileSchema,
        Type.Object({ action_kind: Type.Literal("graph_query") }),
      ]),
      Type.Intersect([
        ResourceProfileSchema,
        Type.Object({ action_kind: Type.Literal("application_test") }),
      ]),
    ]),
    status: Type.Literal("approved"),
    policy_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_RESOURCE_POLICY_V1_SCHEMA }
);
export type ScaP06ResourcePolicyV1 = Readonly<Static<typeof ScaP06ResourcePolicyV1Schema>>;
export type ScaP06ResourceProfileV1 = Readonly<Static<typeof ResourceProfileSchema>>;

export const ScaP06DisclosureAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    source_snapshot_sha256: Sha256Schema,
    required_model: RequiredModelSchema,
    destination_class: Type.Literal("cloud"),
    purpose: Type.Literal("p06_least_consequential_evidence_decision"),
    allowed_data_classes: Type.Tuple([
      Type.Literal("p05_hypothesis_revisions"),
      Type.Literal("p06_authority_resource_projections"),
    ]),
    provider_retention_status: Type.Literal("known"),
    provider_retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    provider_logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_training_use: Type.Literal("prohibited"),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 786_432 }),
    max_provider_calls: Type.Literal(1),
    decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
    issued_at: Rfc3339UtcSchema,
    authority_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA }
);
export type ScaP06DisclosureAuthorityV1 = Readonly<
  Static<typeof ScaP06DisclosureAuthorityV1Schema>
>;

const RevisionPermissionSchema = Type.Object(
  {
    hypothesis_id: HypothesisIdSchema,
    revision_ref: ArtifactRefSchema,
    revision_sha256: Sha256Schema,
    body_sha256: Sha256Schema,
    allowed: Type.Literal(true),
  },
  { additionalProperties: false }
);

export const ScaP06DisclosureScopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    p05_transition_ref: ArtifactRefSchema,
    required_model: RequiredModelSchema,
    destination_class: Type.Literal("cloud"),
    purpose: Type.Literal("p06_least_consequential_evidence_decision"),
    allowed_data_classes: Type.Tuple([
      Type.Literal("p05_hypothesis_revisions"),
      Type.Literal("p06_authority_resource_projections"),
    ]),
    revision_permissions: Type.Array(RevisionPermissionSchema, { minItems: 1, maxItems: 10_000 }),
    action_authority_ref: ArtifactRefSchema,
    resource_policy_ref: ArtifactRefSchema,
    provider_retention_status: Type.Literal("known"),
    provider_retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    provider_logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_training_use: Type.Literal("prohibited"),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 786_432 }),
    max_provider_calls: Type.Literal(1),
    authority_ref: ArtifactRefSchema,
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
    scope_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA }
);
export type ScaP06DisclosureScopeV1 = Readonly<Static<typeof ScaP06DisclosureScopeV1Schema>>;

const FinalHypothesisBindingSchema = Type.Object(
  {
    hypothesis_id: HypothesisIdSchema,
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    final_revision_ref: ArtifactRefSchema,
    revision: Type.Union([Type.Literal(1), Type.Literal(2)]),
    revision_sha256: Sha256Schema,
    body_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaP06AcceptedCohortV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_ACCEPTED_COHORT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    run_id: OpaqueIdSchema,
    p06_request_ref: ArtifactRefSchema,
    p05_transition_ref: ArtifactRefSchema,
    p05_gate_ref: ArtifactRefSchema,
    p05_successor_ledger_ref: ArtifactRefSchema,
    p05_traceability_ref: ArtifactRefSchema,
    p05_evidence_manifest_ref: ArtifactRefSchema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    active_hypothesis_ids: Type.Array(HypothesisIdSchema, { minItems: 1, maxItems: 10_000 }),
    refuted_hypothesis_ids: Type.Array(HypothesisIdSchema, { maxItems: 10_000 }),
    final_hypotheses: Type.Array(FinalHypothesisBindingSchema, { minItems: 1, maxItems: 10_000 }),
    runtime_policy_ref: ArtifactRefSchema,
    action_authority_ref: ArtifactRefSchema,
    resource_policy_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    admitted_at: Rfc3339UtcSchema,
    cohort_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_ACCEPTED_COHORT_V1_SCHEMA }
);
export type ScaP06AcceptedCohortV1 = Readonly<Static<typeof ScaP06AcceptedCohortV1Schema>>;
export type ScaP06FinalHypothesisBindingV1 = Readonly<Static<typeof FinalHypothesisBindingSchema>>;

export const ScaP06ObligationRevisionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_OBLIGATION_REVISION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    obligation_id: P06ObligationIdSchema,
    revision: Type.Union([Type.Literal(1), Type.Literal(2)]),
    parent_revision_ref: NullableArtifactRefSchema,
    parent_revision_sha256: Type.Union([Sha256Schema, Type.Null()]),
    discovery_reassessment_ref: NullableArtifactRefSchema,
    discovery_reassessment_sha256: Type.Union([Sha256Schema, Type.Null()]),
    hypothesis_id: HypothesisIdSchema,
    final_hypothesis_revision_ref: ArtifactRefSchema,
    class: Type.Literal("required-result"),
    purpose: NonEmptyTextSchema,
    source_mandate: NonEmptyTextSchema,
    assigning_authority: Type.Union([
      Type.Literal("host_from_accepted_p05_hypothesis"),
      Type.Literal("host_validated_later_material_discovery"),
    ]),
    rationale: NonEmptyTextSchema,
    supporting_observable_ids: Type.Array(
      Type.String({ pattern: "^p05o_[a-f0-9]{64}_(?:supporting|refuting)_[0-9]{4}$" }),
      { minItems: 1, maxItems: 256 }
    ),
    registered_before_action: Type.Literal(true),
    status: Type.Union([Type.Literal("pending"), Type.Literal("selected")]),
    created_at: Rfc3339UtcSchema,
    revision_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_OBLIGATION_REVISION_V1_SCHEMA }
);
export type ScaP06ObligationRevisionV1 = Readonly<Static<typeof ScaP06ObligationRevisionV1Schema>>;

const ChildUseSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("not_invoked"),
      capability_id: Type.Null(),
      invocation_ref: Type.Null(),
      reason_code: Type.Literal("not_required_for_decision"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      status: Type.Literal("unavailable"),
      capability_id: Type.Union([
        Type.Literal("research"),
        Type.Literal("decide"),
        Type.Literal("plan"),
      ]),
      invocation_ref: Type.Null(),
      reason_code: Type.Literal("integration_not_admitted"),
    },
    { additionalProperties: false }
  ),
]);

const PayloadItemSchema = Type.Object(
  {
    hypothesis_id: HypothesisIdSchema,
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    final_revision_ref: ArtifactRefSchema,
    revision: Type.Union([Type.Literal(1), Type.Literal(2)]),
    revision_sha256: Sha256Schema,
    body_sha256: Sha256Schema,
    hypothesis: ScaP05HypothesisBodyV1Schema,
    base_obligation_ref: ArtifactRefSchema,
    base_obligation_id: P06ObligationIdSchema,
    authority: HypothesisAuthoritySchema,
    resource_profiles: Type.Tuple([
      Type.Intersect([
        ResourceProfileSchema,
        Type.Object({ action_kind: Type.Literal("source_query") }),
      ]),
      Type.Intersect([
        ResourceProfileSchema,
        Type.Object({ action_kind: Type.Literal("graph_query") }),
      ]),
      Type.Intersect([
        ResourceProfileSchema,
        Type.Object({ action_kind: Type.Literal("application_test") }),
      ]),
    ]),
    child_integration: ChildIntegrationPolicySchema,
  },
  { additionalProperties: false }
);

export const ScaP06CognitivePayloadV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    call_id: Type.Literal("sca-p06-evidence-action-decision"),
    role: Type.Literal(SCA_P06_DECIDER_ROLE),
    purpose: Type.Literal("p06_least_consequential_evidence_decision"),
    required_model: RequiredModelSchema,
    accepted_cohort_ref: ArtifactRefSchema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    p05_transition_ref: ArtifactRefSchema,
    assigned_hypothesis_ids: Type.Array(HypothesisIdSchema, { minItems: 1, maxItems: 10_000 }),
    items: Type.Array(PayloadItemSchema, { minItems: 1, maxItems: 10_000 }),
    action_authority_ref: ArtifactRefSchema,
    resource_policy_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    content_mode: Type.Literal("final_p05_hypotheses_and_minimized_policy_projections"),
    payload_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA }
);
export type ScaP06CognitivePayloadV1 = Readonly<Static<typeof ScaP06CognitivePayloadV1Schema>>;
export type ScaP06PayloadItemV1 = Readonly<Static<typeof PayloadItemSchema>>;

export const ScaP06DisclosureAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    call_id: Type.Literal("sca-p06-evidence-action-decision"),
    role: Type.Literal(SCA_P06_DECIDER_ROLE),
    purpose: Type.Literal("p06_least_consequential_evidence_decision"),
    required_model: RequiredModelSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    disclosure_scope_sha256: Sha256Schema,
    payload_ref: ArtifactRefSchema,
    payload_sha256: Sha256Schema,
    payload_byte_length: Type.Integer({ minimum: 1, maximum: 786_432 }),
    serialized_opening_byte_limit: Type.Integer({ minimum: 1, maximum: 786_432 }),
    authorized_revision_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 10_000 }),
    action_authority_ref: ArtifactRefSchema,
    resource_policy_ref: ArtifactRefSchema,
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
  { additionalProperties: false, $id: SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA }
);
export type ScaP06DisclosureAdmissionV1 = Readonly<
  Static<typeof ScaP06DisclosureAdmissionV1Schema>
>;

const AlternativeSchema = Type.Object(
  {
    action_kind: ActionKindSchema,
    evidence_mode: Type.Union([
      Type.Literal("source"),
      Type.Literal("graph"),
      Type.Literal("application"),
    ]),
    consequence_rank: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    capability: Type.Union([Type.Literal("capable"), Type.Literal("incapable")]),
    authority_decision: AuthorityDecisionSchema,
    authority_id: OpaqueIdSchema,
    resource_profile_id: OpaqueIdSchema,
    expected_information_gain: NonEmptyTextSchema,
    rationale: NonEmptyTextSchema,
  },
  { additionalProperties: false }
);
const MaterialObligationDiscoverySchema = Type.Object(
  {
    obligation_id: P06ObligationIdSchema,
    purpose: NonEmptyTextSchema,
    source_mandate: NonEmptyTextSchema,
    rationale: NonEmptyTextSchema,
    supporting_observable_ids: Type.Array(
      Type.String({ pattern: "^p05o_[a-f0-9]{64}_(?:supporting|refuting)_[0-9]{4}$" }),
      { minItems: 1, maxItems: 256 }
    ),
    scope_effect: Type.Union([
      Type.Literal("within_exact_p05_hypothesis"),
      Type.Literal("expands_beyond_exact_p05_hypothesis"),
    ]),
    effective_class: Type.Literal("required-result"),
  },
  { additionalProperties: false }
);
const CanonicalObservableSchema = Type.Object(
  {
    observable_id: Type.String({
      pattern: "^p05o_[a-f0-9]{64}_(?:supporting|refuting)_[0-9]{4}$",
    }),
    observation: NonEmptyTextSchema,
    expected_if_claim: Type.Boolean(),
    evidence_mode: Type.Union([
      Type.Literal("source"),
      Type.Literal("graph"),
      Type.Literal("application"),
    ]),
    basis_atom_ids: Type.Array(Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 128,
    }),
  },
  { additionalProperties: false }
);
const SelectedEvidenceActionSchema = Type.Object(
  {
    action_kind: ActionKindSchema,
    evidence_mode: Type.Union([
      Type.Literal("source"),
      Type.Literal("graph"),
      Type.Literal("application"),
    ]),
    target: NonEmptyTextSchema,
    rationale: NonEmptyTextSchema,
    authority_id: OpaqueIdSchema,
    resource_profile_id: OpaqueIdSchema,
    execution_status: Type.Literal("not_invoked"),
    p07_execution_claimed: Type.Literal(false),
  },
  { additionalProperties: false }
);
const NoAuthorizedActionSchema = Type.Object(
  {
    action_kind: Type.Literal("none"),
    evidence_mode: Type.Literal("none"),
    target: Type.Null(),
    rationale: NonEmptyTextSchema,
    authority_id: Type.Null(),
    resource_profile_id: Type.Null(),
    execution_status: Type.Literal("not_invoked"),
    p07_execution_claimed: Type.Literal(false),
  },
  { additionalProperties: false }
);
const DecisionItemSchema = Type.Object(
  {
    hypothesis_id: HypothesisIdSchema,
    final_revision_sha256: Sha256Schema,
    exact_question: NonEmptyTextSchema,
    considered_alternatives: Type.Tuple([
      Type.Intersect([
        AlternativeSchema,
        Type.Object({ action_kind: Type.Literal("source_query") }),
      ]),
      Type.Intersect([
        AlternativeSchema,
        Type.Object({ action_kind: Type.Literal("graph_query") }),
      ]),
      Type.Intersect([
        AlternativeSchema,
        Type.Object({ action_kind: Type.Literal("application_test") }),
      ]),
    ]),
    discriminating_observable: Type.Object(
      {
        observable_ids: Type.Array(
          Type.String({ pattern: "^p05o_[a-f0-9]{64}_(?:supporting|refuting)_[0-9]{4}$" }),
          { minItems: 1, maxItems: 256 }
        ),
        observable_records: Type.Array(CanonicalObservableSchema, {
          minItems: 1,
          maxItems: 256,
        }),
        target: NonEmptyTextSchema,
        expected_change_to_judgment: NonEmptyTextSchema,
      },
      { additionalProperties: false }
    ),
    material_obligation_discovery: Type.Union([MaterialObligationDiscoverySchema, Type.Null()]),
    effective_obligation_id: P06ObligationIdSchema,
    effective_obligation_class: Type.Literal("required-result"),
    decision_classification: DecisionClassificationSchema,
    selected_action: Type.Union([SelectedEvidenceActionSchema, NoAuthorizedActionSchema]),
    stopping_rule: Type.Object(
      {
        supported: NonEmptyTextSchema,
        refuted: NonEmptyTextSchema,
        inconclusive: NonEmptyTextSchema,
      },
      { additionalProperties: false }
    ),
    child_use: ChildUseSchema,
    p07_execution_status: Type.Literal("not_started"),
    vulnerability_adjudication: Type.Literal("not_performed"),
    report_or_release_claimed: Type.Literal(false),
  },
  { additionalProperties: false }
);

export const ScaP06DecisionResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_DECISION_RESULT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    role: Type.Literal(SCA_P06_DECIDER_ROLE),
    payload_sha256: Sha256Schema,
    assigned_hypothesis_ids: Type.Array(HypothesisIdSchema, { minItems: 1, maxItems: 10_000 }),
    items: Type.Array(DecisionItemSchema, { minItems: 1, maxItems: 10_000 }),
    complete: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P06_DECISION_RESULT_V1_SCHEMA }
);
export type ScaP06DecisionResultV1 = Readonly<Static<typeof ScaP06DecisionResultV1Schema>>;
export type ScaP06DecisionItemV1 = Readonly<Static<typeof DecisionItemSchema>>;

export const ScaP06DiscoveryReassessmentV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_DISCOVERY_REASSESSMENT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    reassessment_id: Type.String({ pattern: "^p06reassess_[a-f0-9]{64}$" }),
    hypothesis_id: HypothesisIdSchema,
    model_output_ref: ArtifactRefSchema,
    cognitive_payload_ref: ArtifactRefSchema,
    model_discovery: MaterialObligationDiscoverySchema,
    model_discovery_sha256: Sha256Schema,
    base_obligation_ref: ArtifactRefSchema,
    base_obligation_id: P06ObligationIdSchema,
    base_obligation_revision_sha256: Sha256Schema,
    promotion_chain_refs: Type.Tuple([ArtifactRefSchema]),
    promoted_obligation_id: P06ObligationIdSchema,
    final_hypothesis_revision_ref: ArtifactRefSchema,
    final_hypothesis_revision_sha256: Sha256Schema,
    final_hypothesis_body_sha256: Sha256Schema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    disclosure_scope_ref: ArtifactRefSchema,
    disclosure_scope_sha256: Sha256Schema,
    action_authority_ref: ArtifactRefSchema,
    action_authority_sha256: Sha256Schema,
    resource_policy_ref: ArtifactRefSchema,
    resource_policy_sha256: Sha256Schema,
    scope_result: Type.Union([
      Type.Literal("within_admitted_p05_scope"),
      Type.Literal("scope_expansion_denied"),
    ]),
    disclosure_scope_result: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
    action_authority_result: AuthorityDecisionSchema,
    resource_policy_result: Type.Union([Type.Literal("approved"), Type.Literal("unavailable")]),
    host_decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    host_decision_basis: Type.Literal("exact_bindings_and_closed_policy_v1"),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 16 }),
    evaluated_at: Rfc3339UtcSchema,
    reassessment_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_DISCOVERY_REASSESSMENT_V1_SCHEMA }
);
export type ScaP06DiscoveryReassessmentV1 = Readonly<
  Static<typeof ScaP06DiscoveryReassessmentV1Schema>
>;

export const ScaP06ActionRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_ACTION_RECORD_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    action_id: Type.String({ pattern: "^p06act_[a-f0-9]{64}$" }),
    hypothesis_id: HypothesisIdSchema,
    final_hypothesis_revision_ref: ArtifactRefSchema,
    final_hypothesis_revision_sha256: Sha256Schema,
    exact_question: NonEmptyTextSchema,
    considered_alternatives: DecisionItemSchema.properties.considered_alternatives,
    discriminating_observable: DecisionItemSchema.properties.discriminating_observable,
    authority_ref: ArtifactRefSchema,
    authority_sha256: Sha256Schema,
    resource_policy_ref: ArtifactRefSchema,
    resource_policy_sha256: Sha256Schema,
    obligation_revision_ref: ArtifactRefSchema,
    obligation_revision_sha256: Sha256Schema,
    discovery_reassessment_ref: NullableArtifactRefSchema,
    discovery_reassessment_sha256: Type.Union([Sha256Schema, Type.Null()]),
    effective_obligation_id: P06ObligationIdSchema,
    effective_obligation_class: Type.Literal("required-result"),
    decision_classification: DecisionClassificationSchema,
    selected_action: DecisionItemSchema.properties.selected_action,
    stopping_rule: DecisionItemSchema.properties.stopping_rule,
    child_use: ChildUseSchema,
    cognitive_payload_ref: ArtifactRefSchema,
    model_output_ref: ArtifactRefSchema,
    dispatch_guard_ref: ArtifactRefSchema,
    model_execution_receipt_ref: ArtifactRefSchema,
    p07_execution_status: Type.Literal("not_started"),
    vulnerability_adjudication: Type.Literal("not_performed"),
    report_or_release_claimed: Type.Literal(false),
    created_at: Rfc3339UtcSchema,
    record_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_ACTION_RECORD_V1_SCHEMA }
);
export type ScaP06ActionRecordV1 = Readonly<Static<typeof ScaP06ActionRecordV1Schema>>;

export const ScaP06CheckpointV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_CHECKPOINT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    hypothesis_id: HypothesisIdSchema,
    stage: Type.Union([Type.Literal("host_context"), Type.Literal("decision")]),
    reason_code: BlockerCodeSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 1024 }),
    missing_evidence_need: NonEmptyTextSchema,
    stop_condition: NonEmptyTextSchema,
    reopen_condition: NonEmptyTextSchema,
    selected_action_invoked: Type.Literal(false),
    p07_execution_claimed: Type.Literal(false),
    vulnerability_adjudication: Type.Literal("not_performed"),
    checkpoint_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_CHECKPOINT_V1_SCHEMA }
);
export type ScaP06CheckpointV1 = Readonly<Static<typeof ScaP06CheckpointV1Schema>>;

const TraceabilityRowSchema = Type.Object(
  {
    hypothesis_id: HypothesisIdSchema,
    final_hypothesis_revision_ref: ArtifactRefSchema,
    base_obligation_ref: ArtifactRefSchema,
    effective_obligation_ref: ArtifactRefSchema,
    discovery_reassessment_ref: NullableArtifactRefSchema,
    disposition: Type.Union([
      Type.Literal("action_selected"),
      Type.Literal("blocked_no_authorized_action"),
      Type.Literal("checkpointed_invalid"),
    ]),
    decision_classification: Type.Union([DecisionClassificationSchema, Type.Null()]),
    action_record_ref: NullableArtifactRefSchema,
    checkpoint_ref: NullableArtifactRefSchema,
    p07_execution_status: Type.Literal("not_started"),
  },
  { additionalProperties: false }
);
export const ScaP06TraceabilityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_TRACEABILITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    active_hypothesis_ids: Type.Array(HypothesisIdSchema, { minItems: 1, maxItems: 10_000 }),
    rows: Type.Array(TraceabilityRowSchema, { minItems: 1, maxItems: 10_000 }),
    action_record_ids: Type.Array(Type.String({ pattern: "^p06act_[a-f0-9]{64}$" }), {
      maxItems: 10_000,
    }),
    blocked_hypothesis_ids: Type.Array(HypothesisIdSchema, { maxItems: 10_000 }),
    checkpointed_hypothesis_ids: Type.Array(HypothesisIdSchema, { maxItems: 10_000 }),
    exhaustive: Type.Literal(true),
    traceability_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_TRACEABILITY_V1_SCHEMA }
);
export type ScaP06TraceabilityV1 = Readonly<Static<typeof ScaP06TraceabilityV1Schema>>;
export type ScaP06TraceabilityRowV1 = Readonly<Static<typeof TraceabilityRowSchema>>;

export const ScaP06EvidenceManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_EVIDENCE_MANIFEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 100_000 }),
    artifact_ids: Type.Array(Type.String({ pattern: "^art_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 100_000,
    }),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_EVIDENCE_MANIFEST_V1_SCHEMA }
);
export type ScaP06EvidenceManifestV1 = Readonly<Static<typeof ScaP06EvidenceManifestV1Schema>>;

const PhaseObligationStatusSchema = Type.Object(
  {
    obligation_id: Type.Union(SCA_P06_OBLIGATION_IDS.map((id) => Type.Literal(id))),
    class: Type.Literal("required-result"),
    status: Type.Union([Type.Literal("satisfied"), Type.Literal("pending")]),
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1024 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
  },
  { additionalProperties: false }
);
const EvidenceObligationStatusSchema = Type.Object(
  {
    obligation_id: P06ObligationIdSchema,
    hypothesis_id: HypothesisIdSchema,
    class: Type.Literal("required-result"),
    status: Type.Union([
      Type.Literal("selected"),
      Type.Literal("blocked_authority"),
      Type.Literal("pending_invalid"),
    ]),
    obligation_revision_ref: ArtifactRefSchema,
    discovery_reassessment_ref: NullableArtifactRefSchema,
    action_record_ref: NullableArtifactRefSchema,
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
  },
  { additionalProperties: false }
);
export const ScaP06SuccessorLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_SUCCESSOR_LEDGER_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    run_id: OpaqueIdSchema,
    predecessor_ledger_ref: ArtifactRefSchema,
    predecessor_ledger_sha256: Sha256Schema,
    phase_obligations: Type.Array(PhaseObligationStatusSchema, { minItems: 3, maxItems: 3 }),
    evidence_obligations: Type.Array(EvidenceObligationStatusSchema, {
      minItems: 1,
      maxItems: 10_000,
    }),
    all_p06_decisions_valid: Type.Boolean(),
    p07_ready: Type.Boolean(),
    pending_phase_ids: Type.Tuple([
      Type.Literal("SCA-P07"),
      Type.Literal("SCA-P08"),
      Type.Literal("SCA-P09"),
      Type.Literal("SCA-P10"),
      Type.Literal("SCA-P11"),
      Type.Literal("SCA-P12"),
    ]),
    append_only: Type.Literal(true),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    campaign_completion_claimed: Type.Literal(false),
    ledger_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_SUCCESSOR_LEDGER_V1_SCHEMA }
);
export type ScaP06SuccessorLedgerV1 = Readonly<Static<typeof ScaP06SuccessorLedgerV1Schema>>;

export const ScaP06GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_GATE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    criterion_id: Type.Literal("AC-P06"),
    verdict: Type.Union([
      Type.Literal("pass_ready"),
      Type.Literal("pass_blocked"),
      Type.Literal("blocked_invalid"),
    ]),
    p05_gate_ref: ArtifactRefSchema,
    traceability_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    exhaustive_accounting: Type.Boolean(),
    immutable_p05_lineage_valid: Type.Boolean(),
    least_consequence_valid: Type.Boolean(),
    authority_and_resource_bindings_valid: Type.Boolean(),
    discovery_reassessment_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    discovery_reassessments_valid: Type.Boolean(),
    denied_discovery_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    obligations_registered_before_action: Type.Boolean(),
    child_policy_valid: Type.Boolean(),
    p07_execution_claims_absent: Type.Boolean(),
    action_record_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    blocked_action_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    checkpoint_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 64 }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_GATE_V1_SCHEMA }
);
export type ScaP06GateV1 = Readonly<Static<typeof ScaP06GateV1Schema>>;

export const ScaP06ToP07TransitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_TO_P07_TRANSITION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    source_phase_id: Type.Literal(SCA_P06_PHASE_ID),
    target_phase_id: Type.Literal("SCA-P07"),
    authorized: Type.Literal(true),
    qualification_scope: Type.Literal("decision_gate_only_not_p07_execution"),
    p06_request_ref: ArtifactRefSchema,
    accepted_cohort_ref: ArtifactRefSchema,
    traceability_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    p06_gate_ref: ArtifactRefSchema,
    action_record_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 10_000 }),
    discovery_reassessment_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    p07_execution_status: Type.Literal("not_started"),
    p07_execution_authorized_by_this_transition: Type.Literal(false),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P06_TO_P07_TRANSITION_V1_SCHEMA }
);
export type ScaP06ToP07TransitionV1 = Readonly<Static<typeof ScaP06ToP07TransitionV1Schema>>;

export const ScaP06TerminalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P06_TERMINAL_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P06_PHASE_ID),
    status: Type.Union([
      Type.Literal("candidate_complete"),
      Type.Literal("blocked"),
      Type.Literal("cancelled"),
    ]),
    gate_ref: NullableArtifactRefSchema,
    p07_transition_ref: NullableArtifactRefSchema,
    p07_decision_handoff_ready: Type.Boolean(),
    p07_execution_occurred: Type.Literal(false),
    selected_artifact_refs: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 64 }),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    nonterminal_campaign: Type.Literal(true),
    report_or_finding_adjudication_performed: Type.Literal(false),
  },
  { additionalProperties: false, $id: SCA_P06_TERMINAL_V1_SCHEMA }
);
export type ScaP06TerminalV1 = Readonly<Static<typeof ScaP06TerminalV1Schema>>;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function assertSelfDigest<T extends Readonly<Record<string, unknown>>>(
  value: T,
  field: keyof T,
  label: string
): void {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  if (value[field] !== sha256(canonicalJson(body)))
    throw new Error(`${label} self digest mismatch`);
}
function assertSortedUnique(values: readonly string[], label: string): void {
  if (!same(values, [...new Set(values)].sort())) {
    throw new Error(`${label} must be unique and lexicographically sorted`);
  }
}
function assertNoBlankStrings(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (value.trim().length === 0) throw new Error(`${label} contains blank text`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoBlankStrings(entry, label);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) assertNoBlankStrings(entry, label);
  }
}
function assertExactRequiredModel(value: RequiredModelIdentityV1, label: string): void {
  validateRequiredModelIdentity(value, label);
  if (!same(value, SCA_P06_REQUIRED_MODEL))
    throw new Error(`${label} is not exact DeepSeek identity`);
}
function modeForAction(
  actionKind: Static<typeof ActionKindSchema>
): "source" | "graph" | "application" {
  return actionKind === "source_query"
    ? "source"
    : actionKind === "graph_query"
      ? "graph"
      : "application";
}

export function withP06SelfDigest<T extends Readonly<Record<string, unknown>>, K extends string>(
  value: T,
  field: K
): T & Readonly<Record<K, string>> {
  return { ...value, [field]: sha256(canonicalJson(value)) } as T & Readonly<Record<K, string>>;
}
export function scaP06BaseObligationId(hypothesisId: string): string {
  const suffix = hypothesisId.replace(/^p05h_/u, "");
  if (!/^[a-f0-9]{64}$/u.test(suffix)) throw new Error("SCA P06 hypothesis identity is invalid");
  return `p06obl_${suffix}_evidence_decision_0001`;
}
export function scaP06MaterialObligationId(hypothesisId: string): string {
  const suffix = hypothesisId.replace(/^p05h_/u, "");
  if (!/^[a-f0-9]{64}$/u.test(suffix)) throw new Error("SCA P06 hypothesis identity is invalid");
  return `p06obl_${suffix}_material_0001`;
}
export function scaP06ActionId(input: {
  readonly source_snapshot_sha256: string;
  readonly hypothesis_id: string;
  readonly final_revision_sha256: string;
}): string {
  return `p06act_${sha256(canonicalJson(input))}`;
}
export function scaP06DiscoveryReassessmentId(input: {
  readonly hypothesis_id: string;
  readonly model_output_sha256: string;
  readonly model_discovery_sha256: string;
}): string {
  return `p06reassess_${sha256(canonicalJson(input))}`;
}

export interface ScaP06DiscoveryReassessmentOutcomeV1 {
  readonly scope_result: "within_admitted_p05_scope" | "scope_expansion_denied";
  readonly disclosure_scope_result: "approved" | "denied";
  readonly action_authority_result: "approved" | "denied" | "unavailable";
  readonly resource_policy_result: "approved" | "unavailable";
  readonly host_decision: "allow" | "deny";
  readonly blocker_codes: readonly string[];
}

export function deriveScaP06DiscoveryReassessmentOutcome(input: {
  readonly decision: ScaP06DecisionItemV1;
  readonly base_obligation: ScaP06ObligationRevisionV1;
  readonly disclosure_scope: ScaP06DisclosureScopeV1;
  readonly resource_policy: ScaP06ResourcePolicyV1;
}): ScaP06DiscoveryReassessmentOutcomeV1 {
  const discovery = input.decision.material_obligation_discovery;
  if (discovery === null) throw new Error("SCA P06 discovery reassessment requires a discovery");
  const firstCapable = input.decision.considered_alternatives.find(
    (entry) => entry.capability === "capable"
  );
  if (firstCapable === undefined) {
    throw new Error("SCA P06 discovery reassessment lacks a capable alternative");
  }
  const baseObservableIds = new Set(input.base_obligation.supporting_observable_ids);
  const scopeResult =
    discovery.scope_effect === "within_exact_p05_hypothesis" &&
    discovery.purpose === input.base_obligation.purpose &&
    discovery.source_mandate === input.base_obligation.source_mandate &&
    discovery.supporting_observable_ids.every((id) => baseObservableIds.has(id))
      ? ("within_admitted_p05_scope" as const)
      : ("scope_expansion_denied" as const);
  const disclosureResult =
    input.disclosure_scope.decision === "allow" ? ("approved" as const) : ("denied" as const);
  const selected = input.decision.selected_action;
  const resourceApproved =
    selected.action_kind !== "none" &&
    input.resource_policy.status === "approved" &&
    input.resource_policy.profiles.some(
      (profile) =>
        profile.action_kind === selected.action_kind &&
        profile.profile_id === selected.resource_profile_id
    );
  const blockerCodes = [
    ...(scopeResult === "scope_expansion_denied" ? ["p06_material_discovery_scope_expansion"] : []),
    ...(disclosureResult === "denied" ? ["p06_material_discovery_disclosure_denied"] : []),
    ...(firstCapable.authority_decision === "approved"
      ? []
      : [
          firstCapable.authority_decision === "denied"
            ? "p06_material_discovery_authority_denied"
            : "p06_material_discovery_authority_unavailable",
        ]),
    ...(resourceApproved ? [] : ["p06_material_discovery_resource_unavailable"]),
  ].sort();
  return {
    scope_result: scopeResult,
    disclosure_scope_result: disclosureResult,
    action_authority_result: firstCapable.authority_decision,
    resource_policy_result: resourceApproved ? "approved" : "unavailable",
    host_decision: blockerCodes.length === 0 ? "allow" : "deny",
    blocker_codes: blockerCodes,
  };
}

export function validateScaP06RequestV1(value: unknown): ScaP06RequestV1 {
  const parsed = validateContract(ScaP06RequestV1Schema, value, "SCA P06 request");
  assertSelfDigest(parsed, "request_sha256", "SCA P06 request");
  if (parsed.p05_transition_ref.content_schema?.schema_id !== SCA_P05_TO_P06_TRANSITION_V1_SCHEMA) {
    throw new Error("SCA P06 request does not reference a P05 transition");
  }
  return parsed;
}
export function validateScaP06ImplementationIdentityV1(
  value: unknown
): ScaP06ImplementationIdentityV1 {
  const parsed = validateContract(
    ScaP06ImplementationIdentityV1Schema,
    value,
    "SCA P06 implementation identity"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P06 implementation identity model");
  return parsed;
}
export function validateScaP06RuntimePolicyV1(value: unknown): ScaP06RuntimePolicyV1 {
  const parsed = validateContract(ScaP06RuntimePolicyV1Schema, value, "SCA P06 runtime policy");
  assertExactRequiredModel(parsed.required_model, "SCA P06 runtime policy model");
  return parsed;
}
export function validateScaP06ActionAuthorityV1(value: unknown): ScaP06ActionAuthorityV1 {
  const parsed = validateContract(ScaP06ActionAuthorityV1Schema, value, "SCA P06 action authority");
  assertSortedUnique(
    parsed.hypothesis_authorities.map((entry) => entry.hypothesis_id),
    "P06 action-authority hypotheses"
  );
  for (const entry of parsed.hypothesis_authorities) {
    const expectedKinds = ["source_query", "graph_query", "application_test"];
    if (
      !same(
        entry.modes.map((mode) => mode.action_kind),
        expectedKinds
      )
    ) {
      throw new Error("SCA P06 action authority mode order mismatch");
    }
  }
  assertSelfDigest(parsed, "authority_sha256", "SCA P06 action authority");
  return parsed;
}
export function validateScaP06ResourcePolicyV1(value: unknown): ScaP06ResourcePolicyV1 {
  const parsed = validateContract(ScaP06ResourcePolicyV1Schema, value, "SCA P06 resource policy");
  if (
    !same(
      parsed.profiles.map((profile) => profile.action_kind),
      ["source_query", "graph_query", "application_test"]
    )
  ) {
    throw new Error("SCA P06 resource policy profile order mismatch");
  }
  const profileIds = parsed.profiles.map((profile) => profile.profile_id);
  if (new Set(profileIds).size !== profileIds.length) {
    throw new Error("SCA P06 resource profile ids must be unique");
  }
  assertSelfDigest(parsed, "policy_sha256", "SCA P06 resource policy");
  return parsed;
}
export function validateScaP06DisclosureAuthorityV1(value: unknown): ScaP06DisclosureAuthorityV1 {
  const parsed = validateContract(
    ScaP06DisclosureAuthorityV1Schema,
    value,
    "SCA P06 disclosure authority"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P06 disclosure authority model");
  if ((parsed.decision === "approved") !== (parsed.blocker_codes.length === 0)) {
    throw new Error("SCA P06 disclosure authority decision/blocker mismatch");
  }
  assertSelfDigest(parsed, "authority_sha256", "SCA P06 disclosure authority");
  return parsed;
}
export function validateScaP06DisclosureScopeV1(value: unknown): ScaP06DisclosureScopeV1 {
  const parsed = validateContract(ScaP06DisclosureScopeV1Schema, value, "SCA P06 disclosure scope");
  assertExactRequiredModel(parsed.required_model, "SCA P06 disclosure scope model");
  assertSortedUnique(
    parsed.revision_permissions.map((entry) => entry.hypothesis_id),
    "P06 disclosure revision hypotheses"
  );
  for (const permission of parsed.revision_permissions) {
    if (
      permission.revision_ref.content_schema?.schema_id !== "penny.sca-p05-hypothesis-revision.v1"
    ) {
      throw new Error("SCA P06 disclosure revision permission binding mismatch");
    }
  }
  if ((parsed.decision === "allow") !== (parsed.blocker_codes.length === 0)) {
    throw new Error("SCA P06 disclosure scope decision/blocker mismatch");
  }
  assertSelfDigest(parsed, "scope_sha256", "SCA P06 disclosure scope");
  return parsed;
}
export function validateScaP06AcceptedCohortV1(value: unknown): ScaP06AcceptedCohortV1 {
  const parsed = validateContract(ScaP06AcceptedCohortV1Schema, value, "SCA P06 accepted cohort");
  assertSortedUnique(parsed.active_hypothesis_ids, "P06 active hypotheses");
  assertSortedUnique(parsed.refuted_hypothesis_ids, "P06 refuted hypotheses");
  assertSortedUnique(
    parsed.final_hypotheses.map((entry) => entry.hypothesis_id),
    "P06 final hypothesis bindings"
  );
  if (
    !same(
      parsed.active_hypothesis_ids,
      parsed.final_hypotheses.map((entry) => entry.hypothesis_id)
    ) ||
    parsed.active_hypothesis_ids.some((id) => parsed.refuted_hypothesis_ids.includes(id))
  ) {
    throw new Error("SCA P06 accepted cohort hypothesis partitions mismatch");
  }
  assertSelfDigest(parsed, "cohort_sha256", "SCA P06 accepted cohort");
  return parsed;
}
export function validateScaP06ObligationRevisionV1(value: unknown): ScaP06ObligationRevisionV1 {
  const parsed = validateContract(
    ScaP06ObligationRevisionV1Schema,
    value,
    "SCA P06 obligation revision"
  );
  const base = parsed.assigning_authority === "host_from_accepted_p05_hypothesis";
  const expected = base
    ? scaP06BaseObligationId(parsed.hypothesis_id)
    : scaP06MaterialObligationId(parsed.hypothesis_id);
  if (parsed.obligation_id !== expected) {
    throw new Error("SCA P06 obligation stable identity mismatch");
  }
  if (
    (base &&
      (parsed.revision !== 1 ||
        parsed.parent_revision_ref !== null ||
        parsed.parent_revision_sha256 !== null ||
        parsed.discovery_reassessment_ref !== null ||
        parsed.discovery_reassessment_sha256 !== null ||
        parsed.status !== "pending")) ||
    (!base &&
      (parsed.revision !== 2 ||
        parsed.parent_revision_ref === null ||
        parsed.parent_revision_sha256 !== parsed.parent_revision_ref.content_digest ||
        parsed.discovery_reassessment_ref === null ||
        parsed.discovery_reassessment_sha256 !== parsed.discovery_reassessment_ref.content_digest ||
        parsed.status !== "selected"))
  ) {
    throw new Error("SCA P06 obligation promotion chain shape mismatch");
  }
  assertSortedUnique(parsed.supporting_observable_ids, "P06 obligation observable ids");
  assertSelfDigest(parsed, "revision_sha256", "SCA P06 obligation revision");
  return parsed;
}
export function validateScaP06CognitivePayloadV1(value: unknown): ScaP06CognitivePayloadV1 {
  const parsed = validateContract(
    ScaP06CognitivePayloadV1Schema,
    value,
    "SCA P06 cognitive payload"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P06 cognitive payload model");
  assertSortedUnique(parsed.assigned_hypothesis_ids, "P06 payload assigned hypotheses");
  assertSortedUnique(
    parsed.items.map((entry) => entry.hypothesis_id),
    "P06 payload item hypotheses"
  );
  if (
    !same(
      parsed.assigned_hypothesis_ids,
      parsed.items.map((entry) => entry.hypothesis_id)
    )
  ) {
    throw new Error("SCA P06 cognitive payload is not exhaustive");
  }
  for (const item of parsed.items) {
    const body = validateScaP05HypothesisBodyV1(item.hypothesis);
    if (
      body.hypothesis_id !== item.hypothesis_id ||
      body.selected_item_id !== item.selected_item_id ||
      item.body_sha256 !== sha256(canonicalJson(body)) ||
      item.base_obligation_id !== scaP06BaseObligationId(item.hypothesis_id) ||
      item.authority.hypothesis_id !== item.hypothesis_id ||
      !same(item.authority.final_revision_ref, item.final_revision_ref)
    ) {
      throw new Error("SCA P06 payload final-hypothesis lineage mismatch");
    }
    if (
      !same(
        item.resource_profiles.map((profile) => profile.action_kind),
        ["source_query", "graph_query", "application_test"]
      )
    ) {
      throw new Error("SCA P06 payload resource profile order mismatch");
    }
  }
  assertSelfDigest(parsed, "payload_sha256", "SCA P06 cognitive payload");
  return parsed;
}
export function validateScaP06DisclosureAdmissionV1(value: unknown): ScaP06DisclosureAdmissionV1 {
  const parsed = validateContract(
    ScaP06DisclosureAdmissionV1Schema,
    value,
    "SCA P06 disclosure admission"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P06 disclosure admission model");
  assertSortedUnique(
    parsed.authorized_revision_refs.map((ref) => ref.artifact_id),
    "P06 disclosure revision refs"
  );
  if ((parsed.decision === "allow") !== (parsed.blocker_codes.length === 0)) {
    throw new Error("SCA P06 disclosure admission decision/blocker mismatch");
  }
  assertSelfDigest(parsed, "admission_sha256", "SCA P06 disclosure admission");
  return parsed;
}

function observableIds(body: ScaP05HypothesisBodyV1): string[] {
  return [
    ...body.expected_supporting_observations.map((entry) => entry.observable_id),
    ...body.expected_refuting_observations.map((entry) => entry.observable_id),
  ].sort();
}
function observableRecords(body: ScaP05HypothesisBodyV1) {
  return [...body.expected_supporting_observations, ...body.expected_refuting_observations].sort(
    (left, right) => left.observable_id.localeCompare(right.observable_id)
  );
}

export function validateScaP06DecisionResultV1(value: unknown): ScaP06DecisionResultV1 {
  const parsed = validateContract(ScaP06DecisionResultV1Schema, value, "SCA P06 decision result");
  assertSortedUnique(parsed.assigned_hypothesis_ids, "P06 decision assigned hypotheses");
  assertSortedUnique(
    parsed.items.map((entry) => entry.hypothesis_id),
    "P06 decision item hypotheses"
  );
  if (
    !same(
      parsed.assigned_hypothesis_ids,
      parsed.items.map((entry) => entry.hypothesis_id)
    )
  ) {
    throw new Error("SCA P06 decision result is not exhaustive");
  }
  assertNoBlankStrings(parsed, "SCA P06 decision result");
  return parsed;
}

export function validateScaP06DecisionResultAgainstPayload(
  resultValue: unknown,
  payloadValue: unknown
): ScaP06DecisionResultV1 {
  const result = validateScaP06DecisionResultV1(resultValue);
  const payload = validateScaP06CognitivePayloadV1(payloadValue);
  if (
    result.payload_sha256 !== payload.payload_sha256 ||
    !same(result.assigned_hypothesis_ids, payload.assigned_hypothesis_ids)
  ) {
    throw new Error("SCA P06 decision payload/assignment binding mismatch");
  }
  const payloadById = new Map(payload.items.map((entry) => [entry.hypothesis_id, entry]));
  for (const decision of result.items) {
    const item = payloadById.get(decision.hypothesis_id);
    if (item === undefined) throw new Error("SCA P06 decision is outside the assigned payload");
    if (
      decision.final_revision_sha256 !== item.revision_sha256 ||
      decision.exact_question !== item.hypothesis.next_evidence_need.question ||
      !same(decision.stopping_rule, item.hypothesis.stopping_conditions)
    ) {
      throw new Error("SCA P06 decision question, stopping rule, or revision binding mismatch");
    }
    assertSortedUnique(
      decision.discriminating_observable.observable_ids,
      `P06 '${decision.hypothesis_id}' discriminating observable ids`
    );
    assertSortedUnique(
      decision.discriminating_observable.observable_records.map((entry) => entry.observable_id),
      `P06 '${decision.hypothesis_id}' discriminating observable records`
    );
    const canonicalObservables = new Map(
      observableRecords(item.hypothesis).map((entry) => [entry.observable_id, entry])
    );
    const allowedObservables = new Set(observableIds(item.hypothesis));
    if (
      decision.discriminating_observable.observable_ids.some((id) => !allowedObservables.has(id))
    ) {
      throw new Error("SCA P06 decision cites an observable outside its P05 hypothesis");
    }
    if (
      !same(decision.discriminating_observable.observable_ids, observableIds(item.hypothesis)) ||
      !same(
        decision.discriminating_observable.observable_ids,
        decision.discriminating_observable.observable_records.map((entry) => entry.observable_id)
      ) ||
      decision.discriminating_observable.observable_records.some(
        (entry) => !same(entry, canonicalObservables.get(entry.observable_id))
      )
    ) {
      throw new Error(
        "SCA P06 discriminating observable projection is incomplete or drifted from exact P05 records"
      );
    }
    if (
      decision.discriminating_observable.target !== item.hypothesis.next_evidence_need.target ||
      decision.discriminating_observable.expected_change_to_judgment !==
        item.hypothesis.next_evidence_need.discriminating_result
    ) {
      throw new Error("SCA P06 discriminating target or expected judgment drifted from exact P05");
    }
    const expectedKinds = ["source_query", "graph_query", "application_test"];
    if (
      !same(
        decision.considered_alternatives.map((entry) => entry.action_kind),
        expectedKinds
      ) ||
      !same(
        decision.considered_alternatives.map((entry) => entry.consequence_rank),
        [1, 2, 3]
      )
    ) {
      throw new Error("SCA P06 alternatives are not in exact consequence order");
    }
    for (const [index, alternative] of decision.considered_alternatives.entries()) {
      const authority = item.authority.modes[index];
      const resource = item.resource_profiles[index];
      if (
        authority === undefined ||
        resource === undefined ||
        alternative.action_kind !== authority.action_kind ||
        alternative.action_kind !== resource.action_kind ||
        alternative.evidence_mode !== modeForAction(alternative.action_kind) ||
        alternative.authority_decision !== authority.decision ||
        alternative.authority_id !== authority.authority_id ||
        alternative.resource_profile_id !== resource.profile_id
      ) {
        throw new Error("SCA P06 alternative authority/resource projection mismatch");
      }
    }
    const firstCapable = decision.considered_alternatives.find(
      (entry) => entry.capability === "capable"
    );
    if (firstCapable === undefined) {
      throw new Error("SCA P06 decision lacks a discriminating capable alternative");
    }
    const selected = decision.selected_action;
    if (firstCapable.authority_decision !== "approved") {
      if (
        selected.action_kind !== "none" ||
        decision.decision_classification !== "no_authorized_action"
      ) {
        throw new Error(
          "SCA P06 unavailable authority must block instead of escalating consequence"
        );
      }
    } else {
      const classification =
        firstCapable.action_kind === "source_query"
          ? "source_sufficient"
          : firstCapable.action_kind === "graph_query"
            ? "graph_needed"
            : "runtime_needed";
      if (
        selected.action_kind === "none" ||
        selected.action_kind !== firstCapable.action_kind ||
        selected.evidence_mode !== firstCapable.evidence_mode ||
        selected.authority_id !== firstCapable.authority_id ||
        selected.resource_profile_id !== firstCapable.resource_profile_id ||
        selected.target !== item.hypothesis.next_evidence_need.target ||
        decision.decision_classification !== classification
      ) {
        throw new Error(
          "SCA P06 selected action is not the least-consequential capable authorized action"
        );
      }
    }
    const discovery = decision.material_obligation_discovery;
    if (discovery === null) {
      if (decision.effective_obligation_id !== item.base_obligation_id) {
        throw new Error("SCA P06 decision substituted its base obligation");
      }
    } else {
      if (
        discovery.obligation_id !== scaP06MaterialObligationId(item.hypothesis_id) ||
        decision.effective_obligation_id !== discovery.obligation_id
      ) {
        throw new Error("SCA P06 material obligation was not promoted before reliance");
      }
      assertSortedUnique(
        discovery.supporting_observable_ids,
        "P06 material-obligation observables"
      );
      if (discovery.supporting_observable_ids.some((id) => !allowedObservables.has(id))) {
        throw new Error("SCA P06 material obligation cites an unknown observable");
      }
    }
    if (
      decision.child_use.status === "unavailable" &&
      decision.child_use.reason_code !== "integration_not_admitted"
    ) {
      throw new Error("SCA P06 child unavailability is not explicit");
    }
  }
  return result;
}

export function validateScaP06DiscoveryReassessmentV1(
  value: unknown
): ScaP06DiscoveryReassessmentV1 {
  const parsed = validateContract(
    ScaP06DiscoveryReassessmentV1Schema,
    value,
    "SCA P06 discovery reassessment"
  );
  const expectedDiscoverySha = sha256(canonicalJson(parsed.model_discovery));
  if (
    parsed.model_discovery_sha256 !== expectedDiscoverySha ||
    parsed.reassessment_id !==
      scaP06DiscoveryReassessmentId({
        hypothesis_id: parsed.hypothesis_id,
        model_output_sha256: parsed.model_output_ref.content_digest,
        model_discovery_sha256: expectedDiscoverySha,
      }) ||
    parsed.base_obligation_id !== scaP06BaseObligationId(parsed.hypothesis_id) ||
    parsed.promoted_obligation_id !== scaP06MaterialObligationId(parsed.hypothesis_id) ||
    parsed.model_discovery.obligation_id !== parsed.promoted_obligation_id ||
    !same(parsed.promotion_chain_refs, [parsed.base_obligation_ref])
  ) {
    throw new Error("SCA P06 discovery reassessment identity or promotion chain mismatch");
  }
  assertSortedUnique(parsed.model_discovery.supporting_observable_ids, "P06 discovery observables");
  assertSortedUnique(parsed.blocker_codes, "P06 discovery reassessment blockers");
  const allows =
    parsed.scope_result === "within_admitted_p05_scope" &&
    parsed.disclosure_scope_result === "approved" &&
    parsed.action_authority_result === "approved" &&
    parsed.resource_policy_result === "approved";
  if (
    (parsed.host_decision === "allow") !== allows ||
    allows !== (parsed.blocker_codes.length === 0)
  ) {
    throw new Error("SCA P06 discovery reassessment host decision mismatch");
  }
  assertSelfDigest(parsed, "reassessment_sha256", "SCA P06 discovery reassessment");
  return parsed;
}

export function validateScaP06DiscoveryReassessmentAgainstContext(
  value: unknown,
  input: {
    readonly decision: ScaP06DecisionItemV1;
    readonly payload: ScaP06CognitivePayloadV1;
    readonly payload_ref: ArtifactRef;
    readonly model_output_ref: ArtifactRef;
    readonly base_obligation: ScaP06ObligationRevisionV1;
    readonly base_obligation_ref: ArtifactRef;
    readonly final_revision: ScaP05HypothesisRevisionV1;
    readonly disclosure_scope: ScaP06DisclosureScopeV1;
    readonly action_authority: ScaP06ActionAuthorityV1;
    readonly resource_policy: ScaP06ResourcePolicyV1;
  }
): ScaP06DiscoveryReassessmentV1 {
  const parsed = validateScaP06DiscoveryReassessmentV1(value);
  const discovery = input.decision.material_obligation_discovery;
  if (discovery === null) throw new Error("SCA P06 reassessment context lacks model discovery");
  const item = input.payload.items.find(
    (entry) => entry.hypothesis_id === input.decision.hypothesis_id
  );
  const authority = input.action_authority.hypothesis_authorities.find(
    (entry) => entry.hypothesis_id === input.decision.hypothesis_id
  );
  if (item === undefined || authority === undefined) {
    throw new Error("SCA P06 reassessment hypothesis is outside exact host policy");
  }
  const finalRevision = validateScaP05HypothesisRevisionV1(input.final_revision);
  const outcome = deriveScaP06DiscoveryReassessmentOutcome({
    decision: input.decision,
    base_obligation: input.base_obligation,
    disclosure_scope: input.disclosure_scope,
    resource_policy: input.resource_policy,
  });
  if (
    parsed.hypothesis_id !== input.decision.hypothesis_id ||
    !same(parsed.model_output_ref, input.model_output_ref) ||
    !same(parsed.cognitive_payload_ref, input.payload_ref) ||
    !same(parsed.model_discovery, discovery) ||
    !same(parsed.base_obligation_ref, input.base_obligation_ref) ||
    parsed.base_obligation_id !== input.base_obligation.obligation_id ||
    parsed.base_obligation_revision_sha256 !== input.base_obligation.revision_sha256 ||
    !same(parsed.promotion_chain_refs, [input.base_obligation_ref]) ||
    !same(parsed.final_hypothesis_revision_ref, item.final_revision_ref) ||
    parsed.final_hypothesis_revision_sha256 !== finalRevision.revision_sha256 ||
    parsed.final_hypothesis_body_sha256 !== finalRevision.body_sha256 ||
    !same(finalRevision.body, item.hypothesis) ||
    finalRevision.revision_sha256 !== item.revision_sha256 ||
    finalRevision.body_sha256 !== item.body_sha256 ||
    !same(parsed.source_snapshot_ref, finalRevision.source_snapshot_ref) ||
    parsed.source_snapshot_sha256 !== finalRevision.source_snapshot_sha256 ||
    !same(parsed.source_snapshot_ref, input.payload.source_snapshot_ref) ||
    parsed.source_snapshot_sha256 !== input.payload.source_snapshot_sha256 ||
    !same(parsed.disclosure_scope_ref, input.payload.disclosure_scope_ref) ||
    parsed.disclosure_scope_sha256 !== input.disclosure_scope.scope_sha256 ||
    !same(parsed.action_authority_ref, input.payload.action_authority_ref) ||
    parsed.action_authority_sha256 !== input.action_authority.authority_sha256 ||
    !same(parsed.resource_policy_ref, input.payload.resource_policy_ref) ||
    parsed.resource_policy_sha256 !== input.resource_policy.policy_sha256 ||
    !same(authority, item.authority) ||
    !same(input.resource_policy.profiles, item.resource_profiles) ||
    parsed.scope_result !== outcome.scope_result ||
    parsed.disclosure_scope_result !== outcome.disclosure_scope_result ||
    parsed.action_authority_result !== outcome.action_authority_result ||
    parsed.resource_policy_result !== outcome.resource_policy_result ||
    parsed.host_decision !== outcome.host_decision ||
    !same(parsed.blocker_codes, outcome.blocker_codes)
  ) {
    throw new Error("SCA P06 discovery reassessment exact host binding mismatch");
  }
  return parsed;
}

export function validateScaP06ActionRecordV1(value: unknown): ScaP06ActionRecordV1 {
  const parsed = validateContract(ScaP06ActionRecordV1Schema, value, "SCA P06 action record");
  assertNoBlankStrings(parsed, "SCA P06 action record");
  if (
    parsed.authority_sha256 !== parsed.authority_ref.content_digest ||
    parsed.resource_policy_sha256 !== parsed.resource_policy_ref.content_digest ||
    parsed.obligation_revision_sha256 !== parsed.obligation_revision_ref.content_digest ||
    (parsed.discovery_reassessment_ref === null) !==
      (parsed.discovery_reassessment_sha256 === null) ||
    (parsed.discovery_reassessment_ref !== null &&
      parsed.discovery_reassessment_sha256 !== parsed.discovery_reassessment_ref.content_digest) ||
    parsed.effective_obligation_id.endsWith("_material_0001") !==
      (parsed.discovery_reassessment_ref !== null)
  ) {
    throw new Error("SCA P06 action record exact-ref digest binding mismatch");
  }
  assertSelfDigest(parsed, "record_sha256", "SCA P06 action record");
  return parsed;
}
export function validateScaP06CheckpointV1(value: unknown): ScaP06CheckpointV1 {
  const parsed = validateContract(ScaP06CheckpointV1Schema, value, "SCA P06 checkpoint");
  assertSelfDigest(parsed, "checkpoint_sha256", "SCA P06 checkpoint");
  return parsed;
}
export function validateScaP06TraceabilityV1(value: unknown): ScaP06TraceabilityV1 {
  const parsed = validateContract(ScaP06TraceabilityV1Schema, value, "SCA P06 traceability");
  assertSortedUnique(parsed.active_hypothesis_ids, "P06 traceability active hypotheses");
  assertSortedUnique(
    parsed.rows.map((entry) => entry.hypothesis_id),
    "P06 traceability row hypotheses"
  );
  assertSortedUnique(parsed.action_record_ids, "P06 traceability action ids");
  assertSortedUnique(parsed.blocked_hypothesis_ids, "P06 traceability blocked hypotheses");
  assertSortedUnique(parsed.checkpointed_hypothesis_ids, "P06 traceability checkpoint hypotheses");
  if (
    !same(
      parsed.active_hypothesis_ids,
      parsed.rows.map((entry) => entry.hypothesis_id)
    )
  ) {
    throw new Error("SCA P06 traceability is not exhaustive");
  }
  const blocked = parsed.rows
    .filter((entry) => entry.disposition === "blocked_no_authorized_action")
    .map((entry) => entry.hypothesis_id)
    .sort();
  const checkpointed = parsed.rows
    .filter((entry) => entry.disposition === "checkpointed_invalid")
    .map((entry) => entry.hypothesis_id)
    .sort();
  if (
    !same(blocked, parsed.blocked_hypothesis_ids) ||
    !same(checkpointed, parsed.checkpointed_hypothesis_ids)
  ) {
    throw new Error("SCA P06 traceability partitions mismatch");
  }
  for (const row of parsed.rows) {
    const action = row.action_record_ref !== null;
    const checkpoint = row.checkpoint_ref !== null;
    if (
      action === checkpoint ||
      (row.disposition === "checkpointed_invalid" &&
        (!checkpoint || row.decision_classification !== null)) ||
      (row.disposition !== "checkpointed_invalid" &&
        (!action || row.decision_classification === null))
    ) {
      throw new Error("SCA P06 traceability conditional refs mismatch");
    }
  }
  assertSelfDigest(parsed, "traceability_sha256", "SCA P06 traceability");
  return parsed;
}
export function validateScaP06EvidenceManifestV1(value: unknown): ScaP06EvidenceManifestV1 {
  const parsed = validateContract(
    ScaP06EvidenceManifestV1Schema,
    value,
    "SCA P06 evidence manifest"
  );
  assertSortedUnique(parsed.artifact_ids, "P06 evidence manifest artifact ids");
  if (
    !same(
      parsed.artifact_ids,
      [...new Set(parsed.evidence_refs.map((ref) => ref.artifact_id))].sort()
    )
  ) {
    throw new Error("SCA P06 evidence manifest ref/id mismatch");
  }
  assertSelfDigest(parsed, "manifest_sha256", "SCA P06 evidence manifest");
  return parsed;
}
export function validateScaP06SuccessorLedgerV1(value: unknown): ScaP06SuccessorLedgerV1 {
  const parsed = validateContract(ScaP06SuccessorLedgerV1Schema, value, "SCA P06 successor ledger");
  if (
    !same(
      parsed.phase_obligations.map((entry) => entry.obligation_id),
      [...SCA_P06_OBLIGATION_IDS]
    )
  ) {
    throw new Error("SCA P06 successor ledger phase-obligation order mismatch");
  }
  assertSortedUnique(
    parsed.evidence_obligations.map((entry) => entry.hypothesis_id),
    "P06 successor evidence hypotheses"
  );
  if (
    parsed.predecessor_ledger_sha256 !== parsed.predecessor_ledger_ref.content_digest ||
    parsed.all_p06_decisions_valid !==
      parsed.phase_obligations.every((entry) => entry.status === "satisfied") ||
    parsed.p07_ready !== parsed.evidence_obligations.every((entry) => entry.status === "selected")
  ) {
    throw new Error("SCA P06 successor ledger status mismatch");
  }
  for (const entry of [...parsed.phase_obligations, ...parsed.evidence_obligations]) {
    const status = entry.status;
    const satisfied = status === "satisfied" || status === "selected";
    if (satisfied !== (entry.blocker_codes.length === 0)) {
      throw new Error("SCA P06 successor ledger blocker mismatch");
    }
    if (
      "action_record_ref" in entry &&
      ((entry.status === "pending_invalid") !== (entry.action_record_ref === null) ||
        (entry.status === "selected" &&
          entry.obligation_id.endsWith("_material_0001") !==
            (entry.discovery_reassessment_ref !== null)) ||
        (entry.status === "blocked_authority" && entry.discovery_reassessment_ref !== null))
    ) {
      throw new Error("SCA P06 successor ledger evidence ref/status mismatch");
    }
  }
  assertSelfDigest(parsed, "ledger_sha256", "SCA P06 successor ledger");
  return parsed;
}
export function validateScaP06GateV1(value: unknown): ScaP06GateV1 {
  const parsed = validateContract(ScaP06GateV1Schema, value, "SCA P06 gate");
  assertSortedUnique(
    parsed.discovery_reassessment_refs.map((ref) => ref.artifact_id),
    "P06 gate discovery reassessment refs"
  );
  if (parsed.denied_discovery_count > parsed.discovery_reassessment_refs.length) {
    throw new Error("SCA P06 gate discovery reassessment count mismatch");
  }
  const structurallyValid =
    parsed.exhaustive_accounting &&
    parsed.immutable_p05_lineage_valid &&
    parsed.least_consequence_valid &&
    parsed.authority_and_resource_bindings_valid &&
    parsed.discovery_reassessments_valid &&
    parsed.denied_discovery_count === 0 &&
    parsed.obligations_registered_before_action &&
    parsed.child_policy_valid &&
    parsed.p07_execution_claims_absent &&
    parsed.checkpoint_count === 0;
  const expected = !structurallyValid
    ? "blocked_invalid"
    : parsed.blocked_action_count > 0
      ? "pass_blocked"
      : "pass_ready";
  if (
    parsed.verdict !== expected ||
    (expected === "pass_ready" && parsed.blocker_codes.length !== 0) ||
    (expected !== "pass_ready" && parsed.blocker_codes.length === 0)
  ) {
    throw new Error("SCA P06 gate verdict mismatch");
  }
  assertSelfDigest(parsed, "gate_sha256", "SCA P06 gate");
  return parsed;
}
export function validateScaP06ToP07TransitionV1(value: unknown): ScaP06ToP07TransitionV1 {
  const parsed = validateContract(
    ScaP06ToP07TransitionV1Schema,
    value,
    "SCA P06 to P07 transition"
  );
  assertSortedUnique(
    parsed.action_record_refs.map((ref) => ref.artifact_id),
    "P06 transition action refs"
  );
  assertSortedUnique(
    parsed.discovery_reassessment_refs.map((ref) => ref.artifact_id),
    "P06 transition discovery reassessment refs"
  );
  assertSelfDigest(parsed, "transition_sha256", "SCA P06 to P07 transition");
  return parsed;
}
export function validateScaP06TerminalV1(value: unknown): ScaP06TerminalV1 {
  const parsed = validateContract(ScaP06TerminalV1Schema, value, "SCA P06 terminal");
  if (
    parsed.p07_decision_handoff_ready !== (parsed.p07_transition_ref !== null) ||
    (parsed.p07_decision_handoff_ready &&
      (parsed.status !== "candidate_complete" ||
        parsed.gate_ref === null ||
        parsed.blocker_codes.length !== 0)) ||
    (!parsed.p07_decision_handoff_ready && parsed.status === "candidate_complete") ||
    ((parsed.status === "blocked" || parsed.status === "cancelled") &&
      parsed.blocker_codes.length === 0)
  ) {
    throw new Error("SCA P06 terminal handoff/ref mismatch");
  }
  return parsed;
}

export function createScaP06Request(input: {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly p05_transition_ref: ArtifactRef;
  readonly implementation_identity_ref: ArtifactRef;
  readonly runtime_policy_ref: ArtifactRef;
  readonly action_authority_ref: ArtifactRef;
  readonly resource_policy_ref: ArtifactRef;
  readonly disclosure_scope_ref: ArtifactRef;
  readonly requested_at: string;
}): ScaP06RequestV1 {
  return validateScaP06RequestV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_REQUEST_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: input.tenant_id,
        project_id: input.project_id,
        run_id: input.run_id,
        phase_id: SCA_P06_PHASE_ID,
        p05_transition_ref: input.p05_transition_ref,
        implementation_identity_ref: input.implementation_identity_ref,
        runtime_policy_ref: input.runtime_policy_ref,
        action_authority_ref: input.action_authority_ref,
        resource_policy_ref: input.resource_policy_ref,
        disclosure_scope_ref: input.disclosure_scope_ref,
        requested_at: input.requested_at,
      },
      "request_sha256"
    )
  );
}
