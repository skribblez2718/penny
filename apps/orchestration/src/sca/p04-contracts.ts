import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, type ArtifactRef, validateContract } from "../contracts.js";
import { ScaP03QueryCandidateV2Schema } from "./p03-contracts.js";
import type { RequiredModelIdentityV1 } from "../required-model.js";
import {
  SCA_MODEL_ALIAS,
  SCA_MODEL_ID,
  SCA_MODEL_OVERRIDE,
  SCA_MODEL_PROVIDER,
} from "./model-identity.js";

export const SCA_P04_REQUIRED_MODEL: RequiredModelIdentityV1 = Object.freeze({
  schema_version: 1,
  alias: SCA_MODEL_ALIAS,
  override: SCA_MODEL_OVERRIDE,
  provider: SCA_MODEL_PROVIDER,
  model: SCA_MODEL_ID,
});

export const SCA_P04_PHASE_ID = "SCA-P04" as const;
export const SCA_P04_SPECIALIST_STATE = "selecting_surfaces" as const;
export const SCA_P04_SCANNER_SPECIALIST = "scanner_dependency_lead" as const;
export const SCA_P04_UNDERDETECTED_SPECIALIST = "underdetected_no_alert" as const;
export const SCA_P04_SPECIALIST_IDS = Object.freeze([
  SCA_P04_SCANNER_SPECIALIST,
  SCA_P04_UNDERDETECTED_SPECIALIST,
] as const);

export function scaP04SpecialistTask(specialistId: string): string {
  if (specialistId === SCA_P04_SCANNER_SPECIALIST) {
    return "Select and prioritize focused scanner and dependency leads from the inline admitted payload. This is surface selection for P05, not vulnerability adjudication. Account for every assigned stable ID exactly once. No tools are available; fail closed if the inline payload or disclosure is absent or inconsistent.";
  }
  if (specialistId === SCA_P04_UNDERDETECTED_SPECIALIST) {
    return "Select and prioritize underdetected, graph-derived, and no-alert source surfaces from the inline admitted payload. Absence of a scanner alert is never evidence of safety. This is surface selection for P05, not vulnerability adjudication. Account for every assigned stable ID exactly once. No tools are available; fail closed if the inline payload or disclosure is absent or inconsistent.";
  }
  throw new Error(`unknown P04 specialist '${specialistId}'`);
}

export const SCA_P04_REQUEST_V1_SCHEMA = "penny.sca-p04-request.v1" as const;
export const SCA_P04_IMPLEMENTATION_IDENTITY_V1_SCHEMA =
  "penny.sca-p04-implementation-identity.v1" as const;
export const SCA_P04_RUNTIME_POLICY_V1_SCHEMA = "penny.sca-p04-runtime-policy.v1" as const;
export const SCA_P04_ACCEPTED_COHORT_V1_SCHEMA = "penny.sca-p04-accepted-cohort.v1" as const;
export const SCA_P04_POPULATION_V1_SCHEMA = "penny.sca-p04-selection-population.v1" as const;
export const SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA = "penny.sca-p04-cognitive-payload.v1" as const;
export const SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA =
  "penny.sca-p04-disclosure-admission.v1" as const;
export const SCA_P04_SPECIALIST_RESULT_V1_SCHEMA = "penny.sca-p04-specialist-result.v1" as const;
export const SCA_P04_SPECIALIST_DOSSIER_V1_SCHEMA = "penny.sca-p04-specialist-dossier.v1" as const;
export const SCA_P04_CONVERGENCE_MATRIX_V1_SCHEMA = "penny.sca-p04-convergence-matrix.v1" as const;
export const SCA_P04_SELECTION_DOSSIER_V1_SCHEMA = "penny.sca-p04-selection-dossier.v1" as const;
export const SCA_P04_OMISSION_DOSSIER_V1_SCHEMA = "penny.sca-p04-omission-dossier.v1" as const;
export const SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA = "penny.sca-p04-coverage-dossier.v1" as const;
export const SCA_P04_EVIDENCE_MANIFEST_V1_SCHEMA = "penny.sca-p04-evidence-manifest.v1" as const;
export const SCA_P04_SUCCESSOR_LEDGER_V1_SCHEMA =
  "penny.sca-p04-successor-obligation-ledger.v1" as const;
export const SCA_P04_GATE_V1_SCHEMA = "penny.sca-p04-gate.v1" as const;
export const SCA_P04_TO_P05_TRANSITION_V1_SCHEMA = "penny.sca-p04-to-p05-transition.v1" as const;
export const SCA_P04_TERMINAL_V1_SCHEMA = "penny.sca-p04-terminal.v1" as const;

export const SCA_P04_REQUIRED_TOOL_SUBSET = Object.freeze([] as const);
export const SCA_P04_PROVIDER_OPENING_GUARD = "sca_p04_payload_disclosure_v1" as const;

export const SCA_P04_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-P04-ACCEPTANCE",
  "SCA-OBL-OUTPUT-P04-SPECIALIST-DOSSIERS",
  "SCA-OBL-OUTPUT-P04-SELECTION-DOSSIER",
  "SCA-OBL-OUTPUT-P04-OMISSION-DOSSIER",
  "SCA-OBL-OUTPUT-P04-COVERAGE-DOSSIER",
] as const);

const MAX_TEXT = 16_384;
const MAX_ITEMS = 10_000;
const MAX_REFS = 20_000;
const OpaqueIdSchema = Type.String({ minLength: 1, maxLength: 512 });
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Rfc3339UtcSchema = Type.String({ format: "date-time", maxLength: 64 });
const SpecialistIdSchema = Type.Union([
  Type.Literal(SCA_P04_SCANNER_SPECIALIST),
  Type.Literal(SCA_P04_UNDERDETECTED_SPECIALIST),
]);
const QualificationScopeSchema = Type.Union([
  Type.Literal("live_qualified"),
  Type.Literal("deterministic_test_only"),
]);
const RequiredModelSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    alias: Type.Literal(SCA_P04_REQUIRED_MODEL.alias),
    override: Type.Literal(SCA_P04_REQUIRED_MODEL.override),
    provider: Type.Literal(SCA_P04_REQUIRED_MODEL.provider),
    model: Type.Literal(SCA_P04_REQUIRED_MODEL.model),
  },
  { additionalProperties: false }
);
const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);

export const ScaP04RequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_REQUEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    p03_transition_ref: ArtifactRefSchema,
    implementation_identity_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    requested_at: Rfc3339UtcSchema,
    request_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_REQUEST_V1_SCHEMA }
);
export type ScaP04RequestV1 = Readonly<Static<typeof ScaP04RequestV1Schema>>;

export const ScaP04ImplementationIdentityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_IMPLEMENTATION_IDENTITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    implementation_revision: OpaqueIdSchema,
    contracts_sha256: Sha256Schema,
    prompts_sha256: Sha256Schema,
    identity_scope: Type.Literal("caller_declaration_not_runtime_attestation"),
    host_issued: Type.Literal(true),
    required_model: RequiredModelSchema,
  },
  { additionalProperties: false, $id: SCA_P04_IMPLEMENTATION_IDENTITY_V1_SCHEMA }
);
export type ScaP04ImplementationIdentityV1 = Readonly<
  Static<typeof ScaP04ImplementationIdentityV1Schema>
>;

export const ScaP04RuntimePolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_RUNTIME_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    qualification_scope: Type.Literal("live_only"),
    max_population_items: Type.Integer({ minimum: 1, maximum: MAX_ITEMS }),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    max_selected_items: Type.Integer({ minimum: 1, maximum: MAX_ITEMS }),
    specialist_count: Type.Literal(2),
    independent_contexts_required: Type.Literal(true),
    semantic_reconciliation_call: Type.Literal(false),
    required_tools: Type.Tuple([]),
    required_model: RequiredModelSchema,
    host_issued: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P04_RUNTIME_POLICY_V1_SCHEMA }
);
export type ScaP04RuntimePolicyV1 = Readonly<Static<typeof ScaP04RuntimePolicyV1Schema>>;

const CohortRefsSchema = Type.Object(
  {
    p03_transition_ref: ArtifactRefSchema,
    p03_request_ref: ArtifactRefSchema,
    p03_entry_ref: ArtifactRefSchema,
    p03_qualification_ref: ArtifactRefSchema,
    p03_graph_manifest_ref: ArtifactRefSchema,
    p03_supported_matrix_ref: ArtifactRefSchema,
    p03_query_aggregate_ref: ArtifactRefSchema,
    p03_candidate_packet_ref: ArtifactRefSchema,
    p03_coverage_matrix_ref: ArtifactRefSchema,
    p03_evidence_manifest_ref: ArtifactRefSchema,
    p03_successor_ledger_ref: ArtifactRefSchema,
    p03_zero_model_ref: ArtifactRefSchema,
    p03_gate_ref: ArtifactRefSchema,
    p02_m1_ref: ArtifactRefSchema,
    p02_evidence_manifest_ref: ArtifactRefSchema,
    p01_request_ref: ArtifactRefSchema,
    p01_source_snapshot_ref: ArtifactRefSchema,
    p01_source_file_manifest_ref: ArtifactRefSchema,
    p01_source_custody_ref: ArtifactRefSchema,
    p01_model_data_policy_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);

export const ScaP04AcceptedCohortV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_ACCEPTED_COHORT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    p04_request_ref: ArtifactRefSchema,
    implementation_identity_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    refs: CohortRefsSchema,
    transitive_refs_sha256: Sha256Schema,
    transitive_ref_count: Type.Integer({ minimum: 20, maximum: MAX_REFS }),
    qualification_scope: QualificationScopeSchema,
    accepted_p03: Type.Literal(true),
    model_data_policy_status: Type.Literal("approved"),
    admitted_at: Rfc3339UtcSchema,
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_ACCEPTED_COHORT_V1_SCHEMA }
);
export type ScaP04AcceptedCohortV1 = Readonly<Static<typeof ScaP04AcceptedCohortV1Schema>>;

const ItemKindSchema = Type.Union([
  Type.Literal("scanner_lead"),
  Type.Literal("dependency_lead"),
  Type.Literal("source_surface"),
  Type.Literal("graph_candidate"),
  Type.Literal("context_record"),
]);
const AlertStateSchema = Type.Union([
  Type.Literal("scanner_alert"),
  Type.Literal("no_alert"),
  Type.Literal("context_only"),
  Type.Literal("not_applicable"),
]);

const NullableBoundedTextSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 4096 }),
  Type.Null(),
]);
const SelectionMetadataSchema = Type.Union([
  Type.Object(
    {
      metadata_kind: Type.Literal("scanner_observation"),
      operation_kind: OpaqueIdSchema,
      observation_id: OpaqueIdSchema,
      analyzer_id: OpaqueIdSchema,
      category: OpaqueIdSchema,
      subject: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
      start_line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      advisory_id: NullableBoundedTextSchema,
      correlation_id: OpaqueIdSchema,
      duplicate_group_id: NullableBoundedTextSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      metadata_kind: Type.Literal("scanner_context"),
      operation_kind: OpaqueIdSchema,
      correlation_id: OpaqueIdSchema,
      disposition: Type.Literal("context_only"),
      raw_record_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      metadata_kind: Type.Literal("source_surface"),
      content_sha256: Sha256Schema,
      scanner_alert_present: Type.Boolean(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      metadata_kind: Type.Literal("p03_graph_support"),
      requirement_id: OpaqueIdSchema,
      partition: OpaqueIdSchema,
      dimension: OpaqueIdSchema,
      subject: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      metadata_kind: Type.Literal("p03_graph_candidate"),
      candidate_id: ScaP03QueryCandidateV2Schema.properties.candidate_id,
      claim: ScaP03QueryCandidateV2Schema.properties.claim,
      disposition: ScaP03QueryCandidateV2Schema.properties.disposition,
      reason_code: ScaP03QueryCandidateV2Schema.properties.reason_code,
      graph_component_sha256: Sha256Schema,
      source_snapshot_sha256: Sha256Schema,
      query_release_sha256: Sha256Schema,
      graph_component_ref: ArtifactRefSchema,
      page_ref: ArtifactRefSchema,
      partition: OpaqueIdSchema,
      query_id: OpaqueIdSchema,
      stable_locator: Type.String({ minLength: 1, maxLength: 4096 }),
      summary: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    },
    { additionalProperties: false }
  ),
]);

export const ScaP04PopulationItemV1Schema = Type.Object(
  {
    stable_id: Type.String({ pattern: "^p04i_[a-f0-9]{64}$" }),
    item_kind: ItemKindSchema,
    normalized_locator: Type.String({ minLength: 1, maxLength: 4096 }),
    source_path: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    package_coordinate: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    alert_state: AlertStateSchema,
    aliases: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
      maxItems: 256,
    }),
    upstream_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 512 }),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 512 }),
    assigned_specialists: Type.Array(SpecialistIdSchema, { minItems: 1, maxItems: 2 }),
    selection_metadata: SelectionMetadataSchema,
    description: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);
export type ScaP04PopulationItemV1 = Readonly<Static<typeof ScaP04PopulationItemV1Schema>>;

export const ScaP04SelectionPopulationV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_POPULATION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    run_id: OpaqueIdSchema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    accepted_cohort_ref: ArtifactRefSchema,
    items: Type.Array(ScaP04PopulationItemV1Schema, { minItems: 1, maxItems: MAX_ITEMS }),
    item_count: Type.Integer({ minimum: 1, maximum: MAX_ITEMS }),
    max_selected_items: Type.Integer({ minimum: 1, maximum: MAX_ITEMS }),
    specialist_ids: Type.Tuple([
      Type.Literal(SCA_P04_SCANNER_SPECIALIST),
      Type.Literal(SCA_P04_UNDERDETECTED_SPECIALIST),
    ]),
    population_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_POPULATION_V1_SCHEMA }
);
export type ScaP04SelectionPopulationV1 = Readonly<
  Static<typeof ScaP04SelectionPopulationV1Schema>
>;

const DataClassSchema = Type.Union([
  Type.Literal("source-code"),
  Type.Literal("scanner-evidence"),
  Type.Literal("dependency-coordinates"),
  Type.Literal("personal-data"),
  Type.Literal("secrets"),
]);

export const ScaP04CognitivePayloadV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    call_id: OpaqueIdSchema,
    specialist_id: SpecialistIdSchema,
    purpose: Type.Union([
      Type.Literal("scanner_dependency_lead_selection"),
      Type.Literal("underdetected_no_alert_selection"),
    ]),
    population_ref: ArtifactRefSchema,
    population_sha256: Sha256Schema,
    source_snapshot_ref: ArtifactRefSchema,
    required_model: RequiredModelSchema,
    assigned_items: Type.Array(ScaP04PopulationItemV1Schema, {
      minItems: 1,
      maxItems: MAX_ITEMS,
    }),
    assigned_item_ids: Type.Array(Type.String({ pattern: "^p04i_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_ITEMS,
    }),
    evidence_data_classes: Type.Array(DataClassSchema, { minItems: 1, maxItems: 5 }),
    minimization: Type.Object(
      {
        raw_source_embedded: Type.Literal(false),
        secrets_embedded: Type.Literal(false),
        personal_data_embedded: Type.Literal(false),
        content_mode: Type.Literal("bounded_selection_metadata_and_exact_evidence_refs"),
      },
      { additionalProperties: false }
    ),
    payload_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA }
);
export type ScaP04CognitivePayloadV1 = Readonly<Static<typeof ScaP04CognitivePayloadV1Schema>>;

const DataClassDecisionSchema = Type.Object(
  {
    data_class: DataClassSchema,
    included: Type.Boolean(),
    treatment: Type.Union([
      Type.Literal("allow-minimized"),
      Type.Literal("allow-redacted"),
      Type.Literal("deny"),
    ]),
    minimization: Type.Union([
      Type.Literal("normalized-metadata-only"),
      Type.Literal("stable-identifiers-only"),
      Type.Literal("excluded"),
    ]),
  },
  { additionalProperties: false }
);

export const ScaP04DisclosureAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    call_id: OpaqueIdSchema,
    specialist_id: SpecialistIdSchema,
    agent: Type.Union([Type.Literal("annie"), Type.Literal("echo")]),
    directive_state_id: Type.Literal(SCA_P04_SPECIALIST_STATE),
    required_model: RequiredModelSchema,
    model_data_policy_ref: ArtifactRefSchema,
    model_data_policy_sha256: Sha256Schema,
    payload_ref: ArtifactRefSchema,
    payload_sha256: Sha256Schema,
    payload_byte_length: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    serialized_opening_byte_limit: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
    destination: Type.Literal("cloud"),
    retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    training: Type.Literal("prohibited"),
    data_class_decisions: Type.Array(DataClassDecisionSchema, { minItems: 5, maxItems: 5 }),
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }), {
      maxItems: 32,
    }),
    evaluated_before_dispatch: Type.Literal(true),
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA }
);
export type ScaP04DisclosureAdmissionV1 = Readonly<
  Static<typeof ScaP04DisclosureAdmissionV1Schema>
>;

const RecommendationSchema = Type.Union([
  Type.Literal("select"),
  Type.Literal("omit"),
  Type.Literal("defer"),
  Type.Literal("block"),
]);
const SelectionReasonCodeSchema = Type.Union([
  Type.Literal("select_for_p05"),
  Type.Literal("omit_lower_relative_priority"),
  Type.Literal("defer_pending_evidence"),
  Type.Literal("block_required_evidence_gap"),
]);
const P05QuestionCodeSchema = Type.Union([
  Type.Literal("inspect_control_boundary"),
  Type.Literal("inspect_source_surface"),
  Type.Literal("resolve_dependency_reachability"),
  Type.Literal("resolve_evidence_gap"),
  Type.Literal("trace_data_flow"),
  Type.Literal("verify_dynamic_dispatch"),
]);
const UncertaintyCodeSchema = Type.Union([
  Type.Literal("bounded_metadata_only"),
  Type.Literal("missing_required_evidence"),
  Type.Literal("none_for_selection"),
  Type.Literal("scanner_absence_only"),
]);
const BranchGapCodeSchema = Type.Union([
  Type.Literal("assigned_evidence_incomplete"),
  Type.Literal("payload_metadata_insufficient"),
  Type.Literal("population_assignment_inconsistent"),
  Type.Literal("specialist_scope_unavailable"),
]);
const SpecialistResultItemSchema = Type.Object(
  {
    stable_id: Type.String({ pattern: "^p04i_[a-f0-9]{64}$" }),
    recommendation: RecommendationSchema,
    reason_code: SelectionReasonCodeSchema,
    evidence_status: Type.Union([
      Type.Literal("sufficient_for_selection"),
      Type.Literal("bounded_but_usable"),
      Type.Literal("evidence_gap"),
    ]),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 512 }),
    p05_question_codes: Type.Array(P05QuestionCodeSchema, { maxItems: 6 }),
    uncertainty_code: UncertaintyCodeSchema,
  },
  { additionalProperties: false }
);
export type ScaP04SpecialistResultItemV1 = Readonly<Static<typeof SpecialistResultItemSchema>>;

const DiscoverySchema = Type.Object(
  {
    stable_id: Type.String({ pattern: "^p04d_[a-f0-9]{64}$" }),
    basis_item_id: Type.String({ pattern: "^p04i_[a-f0-9]{64}$" }),
    source_path: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    package_coordinate: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    normalized_locator: Type.String({ minLength: 1, maxLength: 4096 }),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 512 }),
    recommendation: Type.Union([Type.Literal("select"), Type.Literal("omit")]),
    reason_code: Type.Union([
      Type.Literal("select_for_p05"),
      Type.Literal("omit_lower_relative_priority"),
    ]),
  },
  { additionalProperties: false }
);
export type ScaP04DiscoveryV1 = Readonly<Static<typeof DiscoverySchema>>;

export const ScaP04SpecialistResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_SPECIALIST_RESULT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    specialist_id: SpecialistIdSchema,
    role: Type.Union([
      Type.Literal("scanner_and_dependency_leads"),
      Type.Literal("underdetected_and_no_alert_surfaces"),
    ]),
    population_sha256: Sha256Schema,
    assigned_item_ids: Type.Array(Type.String({ pattern: "^p04i_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_ITEMS,
    }),
    results: Type.Array(SpecialistResultItemSchema, { minItems: 1, maxItems: MAX_ITEMS }),
    discoveries: Type.Array(DiscoverySchema, { maxItems: MAX_ITEMS }),
    branch_gap_codes: Type.Array(BranchGapCodeSchema, { maxItems: 4 }),
    complete: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P04_SPECIALIST_RESULT_V1_SCHEMA }
);
export type ScaP04SpecialistResultV1 = Readonly<Static<typeof ScaP04SpecialistResultV1Schema>>;

export const ScaP04SpecialistDossierV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_SPECIALIST_DOSSIER_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    specialist_id: SpecialistIdSchema,
    role: Type.Union([
      Type.Literal("scanner_and_dependency_leads"),
      Type.Literal("underdetected_and_no_alert_surfaces"),
    ]),
    agent: Type.Union([Type.Literal("annie"), Type.Literal("echo")]),
    source_output_ref: ArtifactRefSchema,
    cognitive_payload_ref: ArtifactRefSchema,
    disclosure_admission_ref: ArtifactRefSchema,
    dispatch_guard_ref: ArtifactRefSchema,
    model_execution_receipt_ref: ArtifactRefSchema,
    result: ScaP04SpecialistResultV1Schema,
    dossier_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_SPECIALIST_DOSSIER_V1_SCHEMA }
);
export type ScaP04SpecialistDossierV1 = Readonly<Static<typeof ScaP04SpecialistDossierV1Schema>>;

const ConvergenceRecommendationSchema = Type.Object(
  {
    specialist_id: SpecialistIdSchema,
    recommendation: RecommendationSchema,
    reason_code: Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }),
    evidence_status: Type.Union([
      Type.Literal("sufficient_for_selection"),
      Type.Literal("bounded_but_usable"),
      Type.Literal("evidence_gap"),
    ]),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 512 }),
  },
  { additionalProperties: false }
);
const FinalDispositionSchema = Type.Union([
  Type.Literal("selected_for_p05"),
  Type.Literal("not_selected"),
  Type.Literal("deferred"),
  Type.Literal("blocked_evidence_gap"),
]);
const ConvergenceRowSchema = Type.Object(
  {
    stable_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    origin: Type.Union([Type.Literal("initial_population"), Type.Literal("branch_discovery")]),
    recommendations: Type.Array(ConvergenceRecommendationSchema, { minItems: 1, maxItems: 2 }),
    final_disposition: FinalDispositionSchema,
    host_reason_code: Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }),
  },
  { additionalProperties: false }
);
export type ScaP04ConvergenceRowV1 = Readonly<Static<typeof ConvergenceRowSchema>>;

export const ScaP04ConvergenceMatrixV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_CONVERGENCE_MATRIX_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    population_ref: ArtifactRefSchema,
    specialist_dossier_refs: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 2 }),
    rows: Type.Array(ConvergenceRowSchema, { minItems: 1, maxItems: MAX_ITEMS }),
    reconciler: Type.Literal("deterministic_host_union_partition"),
    semantic_model_call_used: Type.Literal(false),
    matrix_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_CONVERGENCE_MATRIX_V1_SCHEMA }
);
export type ScaP04ConvergenceMatrixV1 = Readonly<Static<typeof ScaP04ConvergenceMatrixV1Schema>>;

const FinalItemSchema = Type.Object(
  {
    stable_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    origin: Type.Union([Type.Literal("initial_population"), Type.Literal("branch_discovery")]),
    source_path: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    package_coordinate: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    reason_code: Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 1024 }),
  },
  { additionalProperties: false }
);

export const ScaP04SelectionDossierV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_SELECTION_DOSSIER_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    convergence_matrix_ref: ArtifactRefSchema,
    selected: Type.Array(FinalItemSchema, { maxItems: MAX_ITEMS }),
    selected_count: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
    purpose: Type.Literal("bounded_input_for_p05_analysis"),
    adjudication_status: Type.Literal("not_performed"),
    dossier_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_SELECTION_DOSSIER_V1_SCHEMA }
);
export type ScaP04SelectionDossierV1 = Readonly<Static<typeof ScaP04SelectionDossierV1Schema>>;

const OmittedItemSchema = Type.Object(
  {
    stable_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    origin: Type.Union([Type.Literal("initial_population"), Type.Literal("branch_discovery")]),
    source_path: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    package_coordinate: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    reason_code: Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 1024 }),
    disposition: Type.Union([
      Type.Literal("not_selected"),
      Type.Literal("deferred"),
      Type.Literal("blocked_evidence_gap"),
    ]),
    safe_claim: Type.Literal(false),
  },
  { additionalProperties: false }
);
export const ScaP04OmissionDossierV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_OMISSION_DOSSIER_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    convergence_matrix_ref: ArtifactRefSchema,
    omitted: Type.Array(OmittedItemSchema, { maxItems: MAX_ITEMS }),
    omitted_count: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
    no_safe_or_not_vulnerable_claims: Type.Literal(true),
    dossier_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_OMISSION_DOSSIER_V1_SCHEMA }
);
export type ScaP04OmissionDossierV1 = Readonly<Static<typeof ScaP04OmissionDossierV1Schema>>;

const CoverageEntrySchema = Type.Object(
  {
    stable_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    origin: Type.Union([Type.Literal("initial_population"), Type.Literal("branch_discovery")]),
    specialist_ids: Type.Array(SpecialistIdSchema, { minItems: 1, maxItems: 2 }),
    status: Type.Union([
      Type.Literal("selected"),
      Type.Literal("omitted"),
      Type.Literal("deferred"),
      Type.Literal("blocked"),
    ]),
    alert_state: AlertStateSchema,
  },
  { additionalProperties: false }
);
export const ScaP04CoverageDossierV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    population_ref: ArtifactRefSchema,
    entries: Type.Array(CoverageEntrySchema, { minItems: 1, maxItems: MAX_ITEMS }),
    initial_population_ids: Type.Array(Type.String({ pattern: "^p04i_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_ITEMS,
    }),
    final_accounted_ids: Type.Array(Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_ITEMS,
    }),
    exhaustive: Type.Literal(true),
    no_alert_semantics: Type.Literal("absence_of_scanner_alert_is_not_evidence_of_safety"),
    dossier_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA }
);
export type ScaP04CoverageDossierV1 = Readonly<Static<typeof ScaP04CoverageDossierV1Schema>>;

export const ScaP04EvidenceManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_EVIDENCE_MANIFEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    accepted_cohort_ref: ArtifactRefSchema,
    population_ref: ArtifactRefSchema,
    cognitive_payload_refs: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 2 }),
    disclosure_admission_refs: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 2 }),
    dispatch_guard_refs: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 2 }),
    model_execution_receipt_refs: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 2 }),
    specialist_output_refs: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 2 }),
    specialist_dossier_refs: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 2 }),
    convergence_matrix_ref: ArtifactRefSchema,
    selection_dossier_ref: ArtifactRefSchema,
    omission_dossier_ref: ArtifactRefSchema,
    coverage_dossier_ref: ArtifactRefSchema,
    all_refs: Type.Array(ArtifactRefSchema, { minItems: 17, maxItems: MAX_REFS }),
    complete: Type.Literal(true),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_EVIDENCE_MANIFEST_V1_SCHEMA }
);
export type ScaP04EvidenceManifestV1 = Readonly<Static<typeof ScaP04EvidenceManifestV1Schema>>;

const DispositionSchema = Type.Object(
  {
    obligation_id: Type.Union(SCA_P04_OBLIGATION_IDS.map((id) => Type.Literal(id))),
    status: Type.Union([Type.Literal("satisfied"), Type.Literal("pending")]),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: false }
);
const PendingObligationSchema = Type.Object(
  {
    obligation_id: Type.Literal("SCA-OBL-P04-ACCEPTANCE"),
    scope_id: Type.String({
      pattern: "^(p04[di]_[a-f0-9]{64}|scanner_dependency_lead|underdetected_no_alert)$",
    }),
    reason_code: Type.Union([
      Type.Literal("blocked_evidence_gap"),
      Type.Literal("branch_gap"),
      Type.Literal("deferred_selection"),
      Type.Literal("evidence_gap"),
      Type.Literal("material_unaccounted"),
    ]),
    detail_code: Type.Union([BranchGapCodeSchema, Type.Null()]),
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
  },
  { additionalProperties: false }
);
export const ScaP04SuccessorLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_SUCCESSOR_LEDGER_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    prior_ledger_ref: ArtifactRefSchema,
    prior_ledger_sha256: Sha256Schema,
    dispositions: Type.Array(DispositionSchema, { minItems: 5, maxItems: 5 }),
    pending_obligations: Type.Array(PendingObligationSchema, { maxItems: MAX_ITEMS }),
    pending_phase_ids: Type.Tuple([
      Type.Literal("SCA-P05"),
      Type.Literal("SCA-P06"),
      Type.Literal("SCA-P07"),
      Type.Literal("SCA-P08"),
      Type.Literal("SCA-P09"),
      Type.Literal("SCA-P10"),
      Type.Literal("SCA-P11"),
      Type.Literal("SCA-P12"),
    ]),
    append_only: Type.Literal(true),
    campaign_completion_claimed: Type.Literal(false),
    release_eligible: Type.Literal(false),
    recorded_at: Rfc3339UtcSchema,
    ledger_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_SUCCESSOR_LEDGER_V1_SCHEMA }
);
export type ScaP04SuccessorLedgerV1 = Readonly<Static<typeof ScaP04SuccessorLedgerV1Schema>>;

export const ScaP04GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_GATE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    qualification_scope: QualificationScopeSchema,
    accepted_cohort_ref: ArtifactRefSchema,
    population_ref: ArtifactRefSchema,
    selection_dossier_ref: ArtifactRefSchema,
    omission_dossier_ref: ArtifactRefSchema,
    coverage_dossier_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    required_model: RequiredModelSchema,
    specialist_count: Type.Literal(2),
    disclosure_admissions_allowed: Type.Boolean(),
    exhaustive_accounting: Type.Boolean(),
    pending_obligation_count: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
    gate_status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    blocker_codes: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }), {
      maxItems: 64,
    }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_GATE_V1_SCHEMA }
);
export type ScaP04GateV1 = Readonly<Static<typeof ScaP04GateV1Schema>>;

export const ScaP04ToP05TransitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_TO_P05_TRANSITION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    source_run_id: OpaqueIdSchema,
    source_phase_id: Type.Literal(SCA_P04_PHASE_ID),
    target_phase_id: Type.Literal("SCA-P05"),
    p04_request_ref: ArtifactRefSchema,
    accepted_cohort_ref: ArtifactRefSchema,
    selection_dossier_ref: ArtifactRefSchema,
    omission_dossier_ref: ArtifactRefSchema,
    coverage_dossier_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    gate_sha256: Sha256Schema,
    qualification_scope: Type.Literal("live_qualified"),
    authorized: Type.Literal(true),
    campaign_terminal: Type.Literal(false),
    release_eligible: Type.Literal(false),
    transitioned_at: Rfc3339UtcSchema,
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P04_TO_P05_TRANSITION_V1_SCHEMA }
);
export type ScaP04ToP05TransitionV1 = Readonly<Static<typeof ScaP04ToP05TransitionV1Schema>>;

export const ScaP04TerminalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P04_TERMINAL_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P04_PHASE_ID),
    status: Type.Union([
      Type.Literal("candidate_complete"),
      Type.Literal("blocked"),
      Type.Literal("cancelled"),
    ]),
    gate_ref: NullableArtifactRefSchema,
    p05_transition_ref: NullableArtifactRefSchema,
    p05_authorized: Type.Boolean(),
    selected_artifact_refs: Type.Array(ArtifactRefSchema, { maxItems: 32 }),
    blocker_codes: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }), {
      maxItems: 64,
    }),
    nonterminal_campaign: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P04_TERMINAL_V1_SCHEMA }
);
export type ScaP04TerminalV1 = Readonly<Static<typeof ScaP04TerminalV1Schema>>;

function assertSortedUnique(values: readonly string[], label: string): void {
  const sorted = [...new Set(values)].sort();
  if (canonicalJson(values) !== canonicalJson(sorted)) {
    throw new Error(`${label} must be unique and lexicographically sorted`);
  }
}

function assertSortedUniqueRefs(refs: readonly ArtifactRef[], label: string): void {
  assertSortedUnique(
    refs.map((ref) => ref.artifact_id),
    label
  );
}

function assertSelfDigest(value: object, digestField: string, label: string): void {
  const observed: unknown = Reflect.get(value, digestField);
  const body = Object.fromEntries(Object.entries(value).filter(([field]) => field !== digestField));
  if (observed !== sha256(canonicalJson(body))) {
    throw new Error(`${label} ${digestField} does not match canonical bytes`);
  }
}

function assertExactRequiredModel(value: RequiredModelIdentityV1, label: string): void {
  if (canonicalJson(value) !== canonicalJson(SCA_P04_REQUIRED_MODEL)) {
    throw new Error(`${label} does not bind the exact required SCA model`);
  }
}

export function scaP04RequestSha256(request: Omit<ScaP04RequestV1, "request_sha256">): string {
  return sha256(canonicalJson(request));
}

export function validateScaP04RequestV1(value: unknown): ScaP04RequestV1 {
  const parsed = validateContract(ScaP04RequestV1Schema, value, "SCA P04 request");
  assertSelfDigest(parsed, "request_sha256", "SCA P04 request");
  return parsed;
}

export function validateScaP04ImplementationIdentityV1(
  value: unknown
): ScaP04ImplementationIdentityV1 {
  const parsed = validateContract(
    ScaP04ImplementationIdentityV1Schema,
    value,
    "SCA P04 implementation identity"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P04 implementation identity");
  return parsed;
}

export function validateScaP04RuntimePolicyV1(value: unknown): ScaP04RuntimePolicyV1 {
  const parsed = validateContract(ScaP04RuntimePolicyV1Schema, value, "SCA P04 runtime policy");
  assertExactRequiredModel(parsed.required_model, "SCA P04 runtime policy");
  if (canonicalJson(parsed.required_tools) !== canonicalJson(SCA_P04_REQUIRED_TOOL_SUBSET)) {
    throw new Error("SCA P04 runtime policy tool subset drift");
  }
  if (parsed.max_selected_items > parsed.max_population_items) {
    throw new Error("SCA P04 selected-item ceiling exceeds the admitted population ceiling");
  }
  return parsed;
}

export function validateScaP04AcceptedCohortV1(value: unknown): ScaP04AcceptedCohortV1 {
  const parsed = validateContract(ScaP04AcceptedCohortV1Schema, value, "SCA P04 accepted cohort");
  assertSelfDigest(parsed, "admission_sha256", "SCA P04 accepted cohort");
  return parsed;
}

export function scaP04StableItemId(input: {
  readonly source_snapshot_sha256: string;
  readonly item_kind: Static<typeof ItemKindSchema>;
  readonly normalized_locator: string;
  readonly upstream_ids: readonly string[];
}): string {
  return `p04i_${sha256(
    canonicalJson({
      source_snapshot_sha256: input.source_snapshot_sha256,
      item_kind: input.item_kind,
      normalized_locator: input.normalized_locator,
      upstream_ids: [...new Set(input.upstream_ids)].sort(),
    })
  )}`;
}

export function scaP04StableDiscoveryId(input: {
  readonly source_snapshot_sha256: string;
  readonly specialist_id: Static<typeof SpecialistIdSchema>;
  readonly basis_item_id: string;
  readonly normalized_locator: string;
  readonly evidence_refs: readonly ArtifactRef[];
}): string {
  return `p04d_${sha256(
    canonicalJson({
      source_snapshot_sha256: input.source_snapshot_sha256,
      specialist_id: input.specialist_id,
      basis_item_id: input.basis_item_id,
      normalized_locator: input.normalized_locator,
      evidence_refs: [...input.evidence_refs].sort((left, right) =>
        left.artifact_id.localeCompare(right.artifact_id)
      ),
    })
  )}`;
}

function validatePopulationItem(
  item: ScaP04PopulationItemV1,
  sourceSnapshotSha256: string,
  label: string
): void {
  assertSortedUnique(item.aliases, `${label} aliases`);
  assertSortedUnique(item.upstream_ids, `${label} upstream ids`);
  assertSortedUniqueRefs(item.evidence_refs, `${label} evidence refs`);
  assertSortedUnique(item.assigned_specialists, `${label} assigned specialists`);
  const expectedMetadataKinds =
    item.item_kind === "scanner_lead" || item.item_kind === "dependency_lead"
      ? ["scanner_observation"]
      : item.item_kind === "source_surface"
        ? ["source_surface"]
        : item.item_kind === "graph_candidate"
          ? ["p03_graph_candidate"]
          : ["scanner_context", "p03_graph_support"];
  if (!expectedMetadataKinds.includes(item.selection_metadata.metadata_kind)) {
    throw new Error(`${label} item/selection metadata kind mismatch`);
  }
  const metadata = item.selection_metadata;
  if (
    metadata.metadata_kind === "p03_graph_candidate" &&
    ((metadata.disposition === "supported") !== (metadata.reason_code === null) ||
      (metadata.claim === "unsupported_surface" && metadata.disposition === "supported") ||
      metadata.source_snapshot_sha256 !== sourceSnapshotSha256 ||
      metadata.graph_component_sha256 !== metadata.graph_component_ref.content_digest ||
      !item.evidence_refs.some(
        (ref) => canonicalJson(ref) === canonicalJson(metadata.graph_component_ref)
      ) ||
      !item.evidence_refs.some((ref) => canonicalJson(ref) === canonicalJson(metadata.page_ref)) ||
      !item.upstream_ids.includes(metadata.candidate_id) ||
      !item.upstream_ids.includes(metadata.query_id))
  )
    throw new Error(label + " graph candidate uncertainty/provenance mismatch");
  const expected = scaP04StableItemId({
    source_snapshot_sha256: sourceSnapshotSha256,
    item_kind: item.item_kind,
    normalized_locator: item.normalized_locator,
    upstream_ids: item.upstream_ids,
  });
  if (item.stable_id !== expected) throw new Error(`${label} stable id drift`);
}

export function validateScaP04SelectionPopulationV1(value: unknown): ScaP04SelectionPopulationV1 {
  const parsed = validateContract(
    ScaP04SelectionPopulationV1Schema,
    value,
    "SCA P04 selection population"
  );
  if (parsed.item_count !== parsed.items.length)
    throw new Error("SCA P04 population count mismatch");
  assertSortedUnique(
    parsed.items.map((item) => item.stable_id),
    "SCA P04 population stable ids"
  );
  for (const [index, item] of parsed.items.entries()) {
    validatePopulationItem(item, parsed.source_snapshot_sha256, `SCA P04 population item ${index}`);
  }
  for (const specialistId of SCA_P04_SPECIALIST_IDS) {
    if (!parsed.items.some((item) => item.assigned_specialists.includes(specialistId))) {
      throw new Error(`SCA P04 specialist '${specialistId}' has no assigned population`);
    }
  }
  assertSelfDigest(parsed, "population_sha256", "SCA P04 selection population");
  return parsed;
}

export function validateScaP04CognitivePayloadV1(value: unknown): ScaP04CognitivePayloadV1 {
  const parsed = validateContract(
    ScaP04CognitivePayloadV1Schema,
    value,
    "SCA P04 cognitive payload"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P04 cognitive payload");
  assertSortedUnique(parsed.assigned_item_ids, "SCA P04 payload item ids");
  const itemIds = parsed.assigned_items.map((item) => item.stable_id);
  if (canonicalJson(itemIds) !== canonicalJson(parsed.assigned_item_ids)) {
    throw new Error("SCA P04 payload items do not equal assigned item ids");
  }
  for (const item of parsed.assigned_items) {
    validatePopulationItem(item, parsed.source_snapshot_ref.content_digest, "SCA P04 payload item");
    if (!item.assigned_specialists.includes(parsed.specialist_id)) {
      throw new Error("SCA P04 payload contains an item not assigned to its specialist");
    }
  }
  assertSortedUnique(parsed.evidence_data_classes, "SCA P04 payload data classes");
  assertSelfDigest(parsed, "payload_sha256", "SCA P04 cognitive payload");
  return parsed;
}

export function validateScaP04DisclosureAdmissionV1(value: unknown): ScaP04DisclosureAdmissionV1 {
  const parsed = validateContract(
    ScaP04DisclosureAdmissionV1Schema,
    value,
    "SCA P04 disclosure admission"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P04 disclosure admission");
  assertSortedUnique(parsed.blocker_codes, "SCA P04 disclosure blocker codes");
  const classes = parsed.data_class_decisions.map((entry) => entry.data_class);
  assertSortedUnique(classes, "SCA P04 disclosure data classes");
  if (parsed.decision === "allow" && parsed.blocker_codes.length !== 0) {
    throw new Error("allowed SCA P04 disclosure has blockers");
  }
  if (parsed.decision === "deny" && parsed.blocker_codes.length === 0) {
    throw new Error("denied SCA P04 disclosure lacks blockers");
  }
  if (
    parsed.decision === "allow" &&
    parsed.data_class_decisions.some(
      (entry) =>
        (entry.included && (entry.treatment === "deny" || entry.minimization === "excluded")) ||
        (!entry.included && entry.minimization !== "excluded")
    )
  ) {
    throw new Error("allowed SCA P04 disclosure has inconsistent data-class treatment");
  }
  assertSelfDigest(parsed, "admission_sha256", "SCA P04 disclosure admission");
  return parsed;
}

export function assertScaP04SpecialistResultItemSemantics(
  entry: ScaP04SpecialistResultItemV1
): void {
  const expectedReason = {
    select: "select_for_p05",
    omit: "omit_lower_relative_priority",
    defer: "defer_pending_evidence",
    block: "block_required_evidence_gap",
  } as const;
  if (entry.reason_code !== expectedReason[entry.recommendation]) {
    throw new Error(`SCA P04 '${entry.stable_id}' recommendation/reason binding mismatch`);
  }

  const defersOrBlocks = entry.recommendation === "defer" || entry.recommendation === "block";
  const hasEvidenceGap = entry.evidence_status === "evidence_gap";
  const hasMissingEvidence = entry.uncertainty_code === "missing_required_evidence";
  const resolvesEvidenceGap = entry.p05_question_codes.includes("resolve_evidence_gap");
  if (
    hasEvidenceGap !== defersOrBlocks ||
    hasMissingEvidence !== defersOrBlocks ||
    resolvesEvidenceGap !== defersOrBlocks
  ) {
    throw new Error(`SCA P04 '${entry.stable_id}' evidence-gap semantics mismatch`);
  }
}

export function validateScaP04SpecialistResultV1(value: unknown): ScaP04SpecialistResultV1 {
  const parsed = validateContract(
    ScaP04SpecialistResultV1Schema,
    value,
    "SCA P04 specialist result"
  );
  const expectedRole =
    parsed.specialist_id === SCA_P04_SCANNER_SPECIALIST
      ? "scanner_and_dependency_leads"
      : "underdetected_and_no_alert_surfaces";
  if (parsed.role !== expectedRole) {
    throw new Error("SCA P04 specialist id/role binding mismatch");
  }
  assertSortedUnique(parsed.assigned_item_ids, "SCA P04 specialist assigned ids");
  const resultIds = parsed.results.map((entry) => entry.stable_id);
  assertSortedUnique(resultIds, "SCA P04 specialist result ids");
  if (canonicalJson(resultIds) !== canonicalJson(parsed.assigned_item_ids)) {
    throw new Error("SCA P04 specialist result is not exhaustive for its assignment");
  }
  for (const entry of parsed.results) {
    assertScaP04SpecialistResultItemSemantics(entry);
    assertSortedUnique(entry.p05_question_codes, `SCA P04 '${entry.stable_id}' question codes`);
  }
  assertSortedUnique(
    parsed.discoveries.map((entry) => entry.stable_id),
    "SCA P04 specialist discovery ids"
  );
  const expectedDiscoveryReason = {
    select: "select_for_p05",
    omit: "omit_lower_relative_priority",
  } as const;
  for (const discovery of parsed.discoveries) {
    if (discovery.reason_code !== expectedDiscoveryReason[discovery.recommendation]) {
      throw new Error(`SCA P04 '${discovery.stable_id}' discovery reason binding mismatch`);
    }
  }
  assertSortedUnique(parsed.branch_gap_codes, "SCA P04 specialist branch gap codes");
  return parsed;
}

export function validateScaP04SpecialistDossierV1(value: unknown): ScaP04SpecialistDossierV1 {
  const parsed = validateContract(
    ScaP04SpecialistDossierV1Schema,
    value,
    "SCA P04 specialist dossier"
  );
  validateScaP04SpecialistResultV1(parsed.result);
  if (parsed.specialist_id !== parsed.result.specialist_id || parsed.role !== parsed.result.role) {
    throw new Error("SCA P04 specialist dossier/result identity mismatch");
  }
  assertSelfDigest(parsed, "dossier_sha256", "SCA P04 specialist dossier");
  return parsed;
}

export function validateScaP04ConvergenceMatrixV1(value: unknown): ScaP04ConvergenceMatrixV1 {
  const parsed = validateContract(
    ScaP04ConvergenceMatrixV1Schema,
    value,
    "SCA P04 convergence matrix"
  );
  assertSortedUnique(
    parsed.specialist_dossier_refs.map((ref) => ref.artifact_id),
    "SCA P04 specialist dossier refs"
  );
  assertSortedUnique(
    parsed.rows.map((row) => row.stable_id),
    "SCA P04 convergence rows"
  );
  for (const row of parsed.rows) {
    assertSortedUnique(
      row.recommendations.map((entry) => entry.specialist_id),
      `SCA P04 convergence '${row.stable_id}' specialists`
    );
  }
  assertSelfDigest(parsed, "matrix_sha256", "SCA P04 convergence matrix");
  return parsed;
}

export function validateScaP04SelectionDossierV1(value: unknown): ScaP04SelectionDossierV1 {
  const parsed = validateContract(
    ScaP04SelectionDossierV1Schema,
    value,
    "SCA P04 selection dossier"
  );
  if (parsed.selected_count !== parsed.selected.length)
    throw new Error("SCA P04 selected count mismatch");
  assertSortedUnique(
    parsed.selected.map((entry) => entry.stable_id),
    "SCA P04 selected ids"
  );
  assertSelfDigest(parsed, "dossier_sha256", "SCA P04 selection dossier");
  return parsed;
}

export function validateScaP04OmissionDossierV1(value: unknown): ScaP04OmissionDossierV1 {
  const parsed = validateContract(ScaP04OmissionDossierV1Schema, value, "SCA P04 omission dossier");
  if (parsed.omitted_count !== parsed.omitted.length)
    throw new Error("SCA P04 omitted count mismatch");
  assertSortedUnique(
    parsed.omitted.map((entry) => entry.stable_id),
    "SCA P04 omitted ids"
  );
  assertSelfDigest(parsed, "dossier_sha256", "SCA P04 omission dossier");
  return parsed;
}

export function validateScaP04CoverageDossierV1(value: unknown): ScaP04CoverageDossierV1 {
  const parsed = validateContract(ScaP04CoverageDossierV1Schema, value, "SCA P04 coverage dossier");
  assertSortedUnique(parsed.initial_population_ids, "SCA P04 initial coverage ids");
  assertSortedUnique(parsed.final_accounted_ids, "SCA P04 final coverage ids");
  assertSortedUnique(
    parsed.entries.map((entry) => entry.stable_id),
    "SCA P04 coverage entries"
  );
  if (
    canonicalJson(parsed.entries.map((entry) => entry.stable_id)) !==
    canonicalJson(parsed.final_accounted_ids)
  ) {
    throw new Error("SCA P04 coverage entries are not the exhaustive final id set");
  }
  assertSelfDigest(parsed, "dossier_sha256", "SCA P04 coverage dossier");
  return parsed;
}

export function validateScaP04EvidenceManifestV1(value: unknown): ScaP04EvidenceManifestV1 {
  const parsed = validateContract(
    ScaP04EvidenceManifestV1Schema,
    value,
    "SCA P04 evidence manifest"
  );
  for (const [name, refs] of [
    ["cognitive payload", parsed.cognitive_payload_refs],
    ["disclosure admission", parsed.disclosure_admission_refs],
    ["dispatch guard", parsed.dispatch_guard_refs],
    ["model execution receipt", parsed.model_execution_receipt_refs],
    ["specialist output", parsed.specialist_output_refs],
    ["specialist dossier", parsed.specialist_dossier_refs],
    ["all", parsed.all_refs],
  ] as const) {
    assertSortedUniqueRefs(refs, `SCA P04 ${name} refs`);
  }
  assertSelfDigest(parsed, "manifest_sha256", "SCA P04 evidence manifest");
  return parsed;
}

export function validateScaP04SuccessorLedgerV1(value: unknown): ScaP04SuccessorLedgerV1 {
  const parsed = validateContract(ScaP04SuccessorLedgerV1Schema, value, "SCA P04 successor ledger");
  const expected = [...SCA_P04_OBLIGATION_IDS];
  if (
    canonicalJson(parsed.dispositions.map((entry) => entry.obligation_id)) !==
    canonicalJson(expected)
  ) {
    throw new Error("SCA P04 obligation ledger disposition set/order drift");
  }
  if (
    canonicalJson(parsed.pending_phase_ids) !==
    canonicalJson([
      "SCA-P05",
      "SCA-P06",
      "SCA-P07",
      "SCA-P08",
      "SCA-P09",
      "SCA-P10",
      "SCA-P11",
      "SCA-P12",
    ])
  ) {
    throw new Error("SCA P04 successor ledger must preserve exact pending P05-P12 work");
  }
  const acceptance = parsed.dispositions[0];
  if (
    acceptance?.obligation_id !== "SCA-OBL-P04-ACCEPTANCE" ||
    (acceptance.status === "pending") !== parsed.pending_obligations.length > 0 ||
    parsed.dispositions.slice(1).some((entry) => entry.status !== "satisfied")
  ) {
    throw new Error("SCA P04 successor ledger pending obligation truth is inconsistent");
  }
  const pendingKeys = parsed.pending_obligations.map(
    (entry) => `${entry.scope_id}:${entry.reason_code}:${entry.detail_code ?? ""}`
  );
  assertSortedUnique(pendingKeys, "SCA P04 pending obligations");
  assertSelfDigest(parsed, "ledger_sha256", "SCA P04 successor ledger");
  return parsed;
}

export function validateScaP04GateV1(value: unknown): ScaP04GateV1 {
  const parsed = validateContract(ScaP04GateV1Schema, value, "SCA P04 gate");
  assertExactRequiredModel(parsed.required_model, "SCA P04 gate");
  assertSortedUnique(parsed.blocker_codes, "SCA P04 gate blockers");
  const shouldPass =
    parsed.qualification_scope === "live_qualified" &&
    parsed.disclosure_admissions_allowed &&
    parsed.exhaustive_accounting &&
    parsed.pending_obligation_count === 0 &&
    parsed.blocker_codes.length === 0;
  if ((parsed.gate_status === "passed") !== shouldPass) {
    throw new Error("SCA P04 gate status is inconsistent with its positive conditions");
  }
  assertSelfDigest(parsed, "gate_sha256", "SCA P04 gate");
  return parsed;
}

export function validateScaP04ToP05TransitionV1(value: unknown): ScaP04ToP05TransitionV1 {
  const parsed = validateContract(
    ScaP04ToP05TransitionV1Schema,
    value,
    "SCA P04 to P05 transition"
  );
  assertSelfDigest(parsed, "transition_sha256", "SCA P04 to P05 transition");
  return parsed;
}

export function validateScaP04TerminalV1(value: unknown): ScaP04TerminalV1 {
  const parsed = validateContract(ScaP04TerminalV1Schema, value, "SCA P04 terminal");
  if (parsed.p05_authorized !== (parsed.p05_transition_ref !== null)) {
    throw new Error("SCA P04 terminal P05 authorization/ref mismatch");
  }
  if (parsed.status !== "candidate_complete" && parsed.p05_authorized) {
    throw new Error("blocked or cancelled SCA P04 terminal cannot authorize P05");
  }
  return parsed;
}

export function withSelfDigest<T extends Readonly<Record<string, unknown>>, K extends string>(
  value: T,
  field: K
): T & Readonly<Record<K, string>> {
  return { ...value, [field]: sha256(canonicalJson(value)) } as T & Readonly<Record<K, string>>;
}
