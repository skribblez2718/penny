import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, type ArtifactRef, validateContract } from "../contracts.js";
import { validateRequiredModelIdentity, type RequiredModelIdentityV1 } from "../required-model.js";
import { SCA_P04_TO_P05_TRANSITION_V1_SCHEMA } from "./p04-contracts.js";

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const OpaqueIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" });
const NonEmptyTextSchema = Type.String({ minLength: 1, maxLength: 16_384 });
const Rfc3339UtcSchema = Type.String({
  pattern:
    "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?Z$",
});

export const SCA_P05_PHASE_ID = "SCA-P05" as const;
export const SCA_P05_FORMING_STATE = "forming_hypotheses" as const;
export const SCA_P05_CHALLENGING_STATE = "challenging_hypotheses" as const;
export const SCA_P05_FINAL_STATE = "finalizing_hypotheses" as const;
export const SCA_P05_CONSTRUCTOR_ROLE = "hypothesis_constructor" as const;
export const SCA_P05_CHALLENGER_ROLE = "falsification_challenger" as const;
export const SCA_P05_REQUIRED_MODEL: RequiredModelIdentityV1 = Object.freeze({
  schema_version: 1,
  alias: "deepseek-flash",
  provider: "ollama",
  model: "deepseek-v4.1-flash:cloud",
  override: "ollama/deepseek-v4.1-flash:cloud",
});
export const SCA_P05_REQUIRED_TOOL_SUBSET = Object.freeze([] as const);
export const SCA_P05_PROVIDER_OPENING_GUARD = "sca_p05_payload_disclosure_v1" as const;

export const SCA_P05_REQUEST_V1_SCHEMA = "penny.sca-p05-request.v1" as const;
export const SCA_P05_IMPLEMENTATION_IDENTITY_V1_SCHEMA =
  "penny.sca-p05-implementation-identity.v1" as const;
export const SCA_P05_RUNTIME_POLICY_V1_SCHEMA = "penny.sca-p05-runtime-policy.v1" as const;
export const SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA =
  "penny.sca-p05-disclosure-authority.v1" as const;
export const SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA = "penny.sca-p05-disclosure-scope.v1" as const;
export const SCA_P05_ACCEPTED_COHORT_V1_SCHEMA = "penny.sca-p05-accepted-cohort.v1" as const;
export const SCA_P05_CONTROL_RECORD_V1_SCHEMA = "penny.sca-p05-control-record.v1" as const;
export const SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA = "penny.sca-p05-cognitive-payload.v1" as const;
export const SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA =
  "penny.sca-p05-disclosure-admission.v1" as const;
export const SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA = "penny.sca-p05-constructor-result.v1" as const;
export const SCA_P05_CHALLENGER_RESULT_V1_SCHEMA = "penny.sca-p05-challenger-result.v1" as const;
export const SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA =
  "penny.sca-p05-hypothesis-revision.v1" as const;
export const SCA_P05_CHECKPOINT_V1_SCHEMA = "penny.sca-p05-checkpoint.v1" as const;
export const SCA_P05_TRACEABILITY_V1_SCHEMA = "penny.sca-p05-traceability.v1" as const;
export const SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA = "penny.sca-p05-evidence-manifest.v1" as const;
export const SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA = "penny.sca-p05-successor-ledger.v1" as const;
export const SCA_P05_GATE_V1_SCHEMA = "penny.sca-p05-gate.v1" as const;
export const SCA_P05_TO_P06_TRANSITION_V1_SCHEMA = "penny.sca-p05-to-p06-transition.v1" as const;
export const SCA_P05_TERMINAL_V1_SCHEMA = "penny.sca-p05-terminal.v1" as const;

export const SCA_P05_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-P05-ACCEPTANCE",
  "SCA-OBL-OUTPUT-P05-FALSIFIABLE-HYPOTHESES",
  "SCA-OBL-OUTPUT-P05-HYPOTHESIS-TRACEABILITY",
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

export const ScaP05RequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_REQUEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    p04_transition_ref: ArtifactRefSchema,
    implementation_identity_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    requested_at: Rfc3339UtcSchema,
    request_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_REQUEST_V1_SCHEMA }
);
export type ScaP05RequestV1 = Readonly<Static<typeof ScaP05RequestV1Schema>>;

export const ScaP05ImplementationIdentityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_IMPLEMENTATION_IDENTITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    implementation_revision: OpaqueIdSchema,
    contracts_sha256: Sha256Schema,
    prompts_sha256: Sha256Schema,
    identity_scope: Type.Literal("caller_declaration_not_runtime_attestation"),
    host_issued: Type.Literal(true),
    required_model: RequiredModelSchema,
  },
  { additionalProperties: false, $id: SCA_P05_IMPLEMENTATION_IDENTITY_V1_SCHEMA }
);
export type ScaP05ImplementationIdentityV1 = Readonly<
  Static<typeof ScaP05ImplementationIdentityV1Schema>
>;

export const ScaP05RuntimePolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_RUNTIME_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    policy_id: OpaqueIdSchema,
    required_model: RequiredModelSchema,
    required_tools: Type.Tuple([]),
    max_selected_items: Type.Integer({ minimum: 1, maximum: 10_000 }),
    max_evidence_atoms: Type.Integer({ minimum: 1, maximum: 100_000 }),
    max_source_segment_bytes: Type.Integer({ minimum: 1, maximum: 524_288 }),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 786_432 }),
    max_provider_calls: Type.Integer({ minimum: 2, maximum: 2 }),
    allow_payload_truncation: Type.Literal(false),
    allow_model_fallback: Type.Literal(false),
    malformed_semantic_output: Type.Literal("checkpoint_without_retry"),
    remote_unknown_recovery: Type.Literal("quarantine_without_replay"),
    status: Type.Literal("approved"),
  },
  { additionalProperties: false, $id: SCA_P05_RUNTIME_POLICY_V1_SCHEMA }
);
export type ScaP05RuntimePolicyV1 = Readonly<Static<typeof ScaP05RuntimePolicyV1Schema>>;

export const ScaP05DisclosureAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    source_snapshot_sha256: Sha256Schema,
    required_model: RequiredModelSchema,
    destination_class: Type.Literal("cloud"),
    purposes: Type.Tuple([
      Type.Literal("p05_hypothesis_construction"),
      Type.Literal("p05_falsification_challenge"),
    ]),
    provider_retention_status: Type.Literal("known"),
    provider_retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    provider_logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_training_use: Type.Literal("prohibited"),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 786_432 }),
    max_provider_calls: Type.Literal(2),
    decision: Type.Literal("approved"),
    issued_at: Rfc3339UtcSchema,
    authority_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA }
);
export type ScaP05DisclosureAuthorityV1 = Readonly<
  Static<typeof ScaP05DisclosureAuthorityV1Schema>
>;

const SourceSegmentPermissionSchema = Type.Object(
  {
    segment_id: Type.String({ pattern: "^p05s_[a-f0-9]{64}$" }),
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    origin_ref: ArtifactRefSchema,
    source_path: Type.String({ minLength: 1, maxLength: 4096 }),
    start_line: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    end_line_exclusive: Type.Integer({ minimum: 2, maximum: 10_000_001 }),
    transformation: Type.Union([Type.Literal("verbatim"), Type.Literal("redacted")]),
    visible_text_sha256: Sha256Schema,
    visible_text_utf8: Type.String({ minLength: 1, maxLength: 524_288 }),
    redaction_ranges: Type.Array(
      Type.Object(
        {
          start_byte: Type.Integer({ minimum: 0, maximum: 524_287 }),
          end_byte_exclusive: Type.Integer({ minimum: 1, maximum: 524_288 }),
          reason_code: Type.Union([Type.Literal("secret"), Type.Literal("personal_data")]),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1024 }
    ),
    secrets_status: Type.Union([Type.Literal("absent"), Type.Literal("redacted")]),
    personal_data_status: Type.Union([Type.Literal("absent"), Type.Literal("redacted")]),
    allowed: Type.Literal(true),
  },
  { additionalProperties: false }
);
export type ScaP05SourceSegmentPermissionV1 = Readonly<
  Static<typeof SourceSegmentPermissionSchema>
>;

const EvidencePermissionSchema = Type.Object(
  {
    atom_id: Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }),
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    atom_kind: Type.Union([
      Type.Literal("source_segment"),
      Type.Literal("p02_observation"),
      Type.Literal("p03_graph_candidate"),
      Type.Literal("p04_selection_record"),
      Type.Literal("control_record"),
    ]),
    origin_ref: ArtifactRefSchema,
    selector: Type.String({ minLength: 1, maxLength: 4096 }),
    value_sha256: Sha256Schema,
    allowed: Type.Literal(true),
  },
  { additionalProperties: false }
);
export type ScaP05EvidencePermissionV1 = Readonly<Static<typeof EvidencePermissionSchema>>;

export const ScaP05ControlRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_CONTROL_RECORD_V1_SCHEMA),
    schema_version: Type.Literal(1),
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    control_id: OpaqueIdSchema,
    control_type: Type.Union([
      Type.Literal("authorization"),
      Type.Literal("validation"),
      Type.Literal("sanitization"),
      Type.Literal("isolation"),
      Type.Literal("integrity"),
    ]),
    enforcement_point: NonEmptyTextSchema,
    controlled_actor_or_input: NonEmptyTextSchema,
    prevented_outcome: NonEmptyTextSchema,
    source_snapshot_sha256: Sha256Schema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 1024 }),
    record_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_CONTROL_RECORD_V1_SCHEMA }
);
export type ScaP05ControlRecordV1 = Readonly<Static<typeof ScaP05ControlRecordV1Schema>>;

export const ScaP05DisclosureScopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    required_model: RequiredModelSchema,
    destination_class: Type.Literal("cloud"),
    purposes: Type.Tuple([
      Type.Literal("p05_hypothesis_construction"),
      Type.Literal("p05_falsification_challenge"),
    ]),
    source_segments: Type.Array(SourceSegmentPermissionSchema, { minItems: 1, maxItems: 10_000 }),
    evidence_permissions: Type.Array(EvidencePermissionSchema, {
      minItems: 1,
      maxItems: 100_000,
    }),
    provider_retention_status: Type.Literal("known"),
    provider_retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    provider_logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_training_use: Type.Literal("prohibited"),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 786_432 }),
    max_provider_calls: Type.Literal(2),
    authority_ref: ArtifactRefSchema,
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }), {
      maxItems: 32,
    }),
    scope_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA }
);
export type ScaP05DisclosureScopeV1 = Readonly<Static<typeof ScaP05DisclosureScopeV1Schema>>;

export const ScaP05AcceptedCohortV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_ACCEPTED_COHORT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    run_id: OpaqueIdSchema,
    p05_request_ref: ArtifactRefSchema,
    p04_transition_ref: ArtifactRefSchema,
    p04_gate_ref: ArtifactRefSchema,
    p04_successor_ledger_ref: ArtifactRefSchema,
    p04_selection_dossier_ref: ArtifactRefSchema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    selected_item_ids: Type.Array(Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 10_000,
    }),
    runtime_policy_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    admitted_at: Rfc3339UtcSchema,
    cohort_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_ACCEPTED_COHORT_V1_SCHEMA }
);
export type ScaP05AcceptedCohortV1 = Readonly<Static<typeof ScaP05AcceptedCohortV1Schema>>;

const EvidenceAtomSchema = Type.Object(
  {
    atom_id: Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }),
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    atom_kind: EvidencePermissionSchema.properties.atom_kind,
    origin_ref: ArtifactRefSchema,
    selector: Type.String({ minLength: 1, maxLength: 4096 }),
    value_sha256: Sha256Schema,
    value: Type.Union([
      Type.String({ minLength: 1, maxLength: 524_288 }),
      Type.Record(Type.String(), Type.Unknown()),
      Type.Array(Type.Unknown(), { maxItems: 10_000 }),
    ]),
  },
  { additionalProperties: false }
);
export type ScaP05EvidenceAtomV1 = Readonly<Static<typeof EvidenceAtomSchema>>;

const PayloadItemSchema = Type.Object(
  {
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    expected_hypothesis_id: Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }),
    normalized_locator: Type.String({ minLength: 1, maxLength: 4096 }),
    source_path: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    package_coordinate: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    selection_rationale_code: Type.String({ minLength: 1, maxLength: 128 }),
    evidence_atom_ids: Type.Array(Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 1024,
    }),
  },
  { additionalProperties: false }
);

export const ScaP05CognitivePayloadV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    call_id: OpaqueIdSchema,
    role: Type.Union([
      Type.Literal(SCA_P05_CONSTRUCTOR_ROLE),
      Type.Literal(SCA_P05_CHALLENGER_ROLE),
    ]),
    purpose: Type.Union([
      Type.Literal("p05_hypothesis_construction"),
      Type.Literal("p05_falsification_challenge"),
    ]),
    required_model: RequiredModelSchema,
    accepted_cohort_ref: ArtifactRefSchema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    assigned_item_ids: Type.Array(Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 10_000,
    }),
    items: Type.Array(PayloadItemSchema, { minItems: 1, maxItems: 10_000 }),
    evidence_atoms: Type.Array(EvidenceAtomSchema, { minItems: 1, maxItems: 100_000 }),
    constructor_result_ref: NullableArtifactRefSchema,
    constructor_result: Type.Union([Type.Unknown(), Type.Null()]),
    disclosure_scope_ref: ArtifactRefSchema,
    content_mode: Type.Literal("authorized_segments_and_exact_evidence_atoms"),
    payload_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA }
);
export type ScaP05CognitivePayloadV1 = Readonly<Static<typeof ScaP05CognitivePayloadV1Schema>>;

export const ScaP05DisclosureAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    call_id: OpaqueIdSchema,
    role: Type.Union([
      Type.Literal(SCA_P05_CONSTRUCTOR_ROLE),
      Type.Literal(SCA_P05_CHALLENGER_ROLE),
    ]),
    purpose: Type.Union([
      Type.Literal("p05_hypothesis_construction"),
      Type.Literal("p05_falsification_challenge"),
    ]),
    required_model: RequiredModelSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    disclosure_scope_sha256: Sha256Schema,
    payload_ref: ArtifactRefSchema,
    payload_sha256: Sha256Schema,
    payload_byte_length: Type.Integer({ minimum: 1, maximum: 786_432 }),
    serialized_opening_byte_limit: Type.Integer({ minimum: 1, maximum: 786_432 }),
    authorized_segment_ids: Type.Array(Type.String({ pattern: "^p05s_[a-f0-9]{64}$" }), {
      maxItems: 10_000,
    }),
    authorized_atom_ids: Type.Array(Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 100_000,
    }),
    destination: Type.Literal("cloud"),
    retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    training: Type.Literal("prohibited"),
    secrets_embedded: Type.Literal(false),
    personal_data_embedded: Type.Literal(false),
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }), {
      maxItems: 32,
    }),
    evaluated_before_dispatch: Type.Literal(true),
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA }
);
export type ScaP05DisclosureAdmissionV1 = Readonly<
  Static<typeof ScaP05DisclosureAdmissionV1Schema>
>;

const EvidenceClaimSchema = Type.Object(
  {
    claim: NonEmptyTextSchema,
    evidence_atom_ids: Type.Array(Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 128,
    }),
  },
  { additionalProperties: false }
);
const CausalLinkSchema = Type.Object(
  {
    ordinal: Type.Integer({ minimum: 1, maximum: 128 }),
    causal_link: NonEmptyTextSchema,
    state_before: NonEmptyTextSchema,
    state_after: NonEmptyTextSchema,
    basis: Type.Union([Type.Literal("observed"), Type.Literal("inferred")]),
    evidence_atom_ids: Type.Array(Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 128,
    }),
  },
  { additionalProperties: false }
);
const ObservableSchema = Type.Object(
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
const ReopeningConditionSchema = Type.Object(
  {
    trigger: NonEmptyTextSchema,
    changed_basis_required: NonEmptyTextSchema,
  },
  { additionalProperties: false }
);

export const ScaP05HypothesisBodyV1Schema = Type.Object(
  {
    hypothesis_id: Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }),
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    bounded_claim: NonEmptyTextSchema,
    actor: EvidenceClaimSchema,
    controlled_input: EvidenceClaimSchema,
    relevant_state: EvidenceClaimSchema,
    causal_path: Type.Array(CausalLinkSchema, { minItems: 1, maxItems: 128 }),
    security_sensitive_outcome: EvidenceClaimSchema,
    competing_benign_explanation: Type.Object(
      {
        explanation: NonEmptyTextSchema,
        discriminating_observation: NonEmptyTextSchema,
        evidence_atom_ids: Type.Array(Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }), {
          minItems: 1,
          maxItems: 128,
        }),
      },
      { additionalProperties: false }
    ),
    expected_supporting_observations: Type.Array(ObservableSchema, {
      minItems: 1,
      maxItems: 128,
    }),
    expected_refuting_observations: Type.Array(ObservableSchema, {
      minItems: 1,
      maxItems: 128,
    }),
    next_evidence_need: Type.Object(
      {
        question: NonEmptyTextSchema,
        evidence_mode: Type.Union([
          Type.Literal("source"),
          Type.Literal("graph"),
          Type.Literal("application"),
        ]),
        target: NonEmptyTextSchema,
        discriminating_result: NonEmptyTextSchema,
      },
      { additionalProperties: false }
    ),
    stopping_conditions: Type.Object(
      {
        supported: NonEmptyTextSchema,
        refuted: NonEmptyTextSchema,
        inconclusive: NonEmptyTextSchema,
      },
      { additionalProperties: false }
    ),
    reopening_conditions: Type.Array(ReopeningConditionSchema, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false }
);
export type ScaP05HypothesisBodyV1 = Readonly<Static<typeof ScaP05HypothesisBodyV1Schema>>;

const ConstructorFormedItemSchema = Type.Object(
  {
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    disposition: Type.Literal("formed"),
    hypothesis: ScaP05HypothesisBodyV1Schema,
  },
  { additionalProperties: false }
);
const ConstructorCheckpointItemSchema = Type.Object(
  {
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    disposition: Type.Literal("checkpointed_incomplete"),
    hypothesis: Type.Null(),
    reason_code: Type.Union([
      Type.Literal("insufficient_causal_basis"),
      Type.Literal("missing_source_binding"),
      Type.Literal("payload_limit"),
      Type.Literal("unsupported_surface"),
    ]),
    missing_evidence_need: NonEmptyTextSchema,
    stop_condition: NonEmptyTextSchema,
    reopen_condition: NonEmptyTextSchema,
    vulnerability_adjudication: Type.Literal("not_performed"),
    safe_claim: Type.Literal(false),
  },
  { additionalProperties: false }
);
const ConstructorItemSchema = Type.Union([
  ConstructorFormedItemSchema,
  ConstructorCheckpointItemSchema,
]);
export type ScaP05ConstructorItemV1 = Readonly<Static<typeof ConstructorItemSchema>>;

export const ScaP05ConstructorResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    role: Type.Literal(SCA_P05_CONSTRUCTOR_ROLE),
    payload_sha256: Sha256Schema,
    assigned_item_ids: Type.Array(Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 10_000,
    }),
    items: Type.Array(ConstructorItemSchema, { minItems: 1, maxItems: 10_000 }),
    complete: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA }
);
export type ScaP05ConstructorResultV1 = Readonly<Static<typeof ScaP05ConstructorResultV1Schema>>;

const ChallengerAcceptItemSchema = Type.Object(
  {
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    hypothesis_id: Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }),
    decision: Type.Literal("accept_for_investigation"),
    replacement_hypothesis: Type.Null(),
    control_atom_ids: Type.Tuple([]),
    rationale: NonEmptyTextSchema,
  },
  { additionalProperties: false }
);
const ChallengerReviseItemSchema = Type.Object(
  {
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    hypothesis_id: Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }),
    decision: Type.Literal("revise_for_investigation"),
    replacement_hypothesis: ScaP05HypothesisBodyV1Schema,
    control_atom_ids: Type.Tuple([]),
    changed_fields: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      minItems: 1,
      maxItems: 64,
    }),
    rationale: NonEmptyTextSchema,
  },
  { additionalProperties: false }
);
const ChallengerRefuteItemSchema = Type.Object(
  {
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    hypothesis_id: Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }),
    decision: Type.Literal("refute_with_existing_control"),
    replacement_hypothesis: Type.Null(),
    control_atom_ids: Type.Array(Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 128,
    }),
    bounded_refutation: NonEmptyTextSchema,
    safe_claim: Type.Literal(false),
    rationale: NonEmptyTextSchema,
  },
  { additionalProperties: false }
);
const ChallengerUnableItemSchema = Type.Object(
  {
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    hypothesis_id: Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }),
    decision: Type.Literal("unable_to_validate"),
    replacement_hypothesis: Type.Null(),
    control_atom_ids: Type.Tuple([]),
    reason_code: Type.Union([
      Type.Literal("missing_counterevidence_basis"),
      Type.Literal("inconsistent_causal_record"),
      Type.Literal("unsupported_surface"),
    ]),
    missing_evidence_need: NonEmptyTextSchema,
    stop_condition: NonEmptyTextSchema,
    reopen_condition: NonEmptyTextSchema,
    rationale: NonEmptyTextSchema,
  },
  { additionalProperties: false }
);
const ChallengerItemSchema = Type.Union([
  ChallengerAcceptItemSchema,
  ChallengerReviseItemSchema,
  ChallengerRefuteItemSchema,
  ChallengerUnableItemSchema,
]);
export type ScaP05ChallengerItemV1 = Readonly<Static<typeof ChallengerItemSchema>>;

export const ScaP05ChallengerResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_CHALLENGER_RESULT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    role: Type.Literal(SCA_P05_CHALLENGER_ROLE),
    payload_sha256: Sha256Schema,
    assigned_item_ids: Type.Array(Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }), {
      maxItems: 10_000,
    }),
    items: Type.Array(ChallengerItemSchema, { maxItems: 10_000 }),
    complete: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P05_CHALLENGER_RESULT_V1_SCHEMA }
);
export type ScaP05ChallengerResultV1 = Readonly<Static<typeof ScaP05ChallengerResultV1Schema>>;

export const ScaP05HypothesisRevisionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    hypothesis_id: Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }),
    revision: Type.Union([Type.Literal(1), Type.Literal(2)]),
    parent_revision_ref: NullableArtifactRefSchema,
    parent_revision_sha256: Type.Union([Sha256Schema, Type.Null()]),
    body: ScaP05HypothesisBodyV1Schema,
    body_sha256: Sha256Schema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    p04_transition_ref: ArtifactRefSchema,
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    cognitive_payload_ref: ArtifactRefSchema,
    model_output_ref: ArtifactRefSchema,
    evidence_atom_ids: Type.Array(Type.String({ pattern: "^p05a_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 100_000,
    }),
    change_reason_codes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      minItems: 1,
      maxItems: 32,
    }),
    changed_fields: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 64,
    }),
    created_at: Rfc3339UtcSchema,
    revision_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA }
);
export type ScaP05HypothesisRevisionV1 = Readonly<Static<typeof ScaP05HypothesisRevisionV1Schema>>;

export const ScaP05CheckpointV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_CHECKPOINT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    stage: Type.Union([
      Type.Literal("host_context"),
      Type.Literal("constructor"),
      Type.Literal("challenger"),
    ]),
    reason_code: Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 1024 }),
    missing_evidence_need: NonEmptyTextSchema,
    stop_condition: NonEmptyTextSchema,
    reopen_condition: NonEmptyTextSchema,
    vulnerability_adjudication: Type.Literal("not_performed"),
    safe_claim: Type.Literal(false),
    checkpoint_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_CHECKPOINT_V1_SCHEMA }
);
export type ScaP05CheckpointV1 = Readonly<Static<typeof ScaP05CheckpointV1Schema>>;

const TraceabilityRowSchema = Type.Object(
  {
    selected_item_id: Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }),
    disposition: Type.Union([
      Type.Literal("active_hypothesis"),
      Type.Literal("refuted_by_existing_control"),
      Type.Literal("checkpointed_incomplete"),
    ]),
    hypothesis_id: Type.Union([Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }), Type.Null()]),
    constructor_output_ref: NullableArtifactRefSchema,
    constructor_guard_ref: NullableArtifactRefSchema,
    constructor_receipt_ref: NullableArtifactRefSchema,
    initial_revision_ref: NullableArtifactRefSchema,
    challenger_output_ref: NullableArtifactRefSchema,
    challenger_guard_ref: NullableArtifactRefSchema,
    challenger_receipt_ref: NullableArtifactRefSchema,
    final_revision_ref: NullableArtifactRefSchema,
    checkpoint_ref: NullableArtifactRefSchema,
    safe_claim: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type ScaP05TraceabilityRowV1 = Readonly<Static<typeof TraceabilityRowSchema>>;

export const ScaP05TraceabilityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_TRACEABILITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    selected_item_ids: Type.Array(Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 10_000,
    }),
    rows: Type.Array(TraceabilityRowSchema, { minItems: 1, maxItems: 10_000 }),
    active_hypothesis_ids: Type.Array(Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }), {
      maxItems: 10_000,
    }),
    refuted_hypothesis_ids: Type.Array(Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }), {
      maxItems: 10_000,
    }),
    checkpointed_item_ids: Type.Array(Type.String({ pattern: "^p04[di]_[a-f0-9]{64}$" }), {
      maxItems: 10_000,
    }),
    exhaustive: Type.Literal(true),
    traceability_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_TRACEABILITY_V1_SCHEMA }
);
export type ScaP05TraceabilityV1 = Readonly<Static<typeof ScaP05TraceabilityV1Schema>>;

export const ScaP05EvidenceManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 100_000 }),
    artifact_ids: Type.Array(Type.String({ pattern: "^art_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 100_000,
    }),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA }
);
export type ScaP05EvidenceManifestV1 = Readonly<Static<typeof ScaP05EvidenceManifestV1Schema>>;

const ObligationStatusSchema = Type.Object(
  {
    obligation_id: Type.Union([
      Type.Literal("SCA-OBL-P05-ACCEPTANCE"),
      Type.Literal("SCA-OBL-OUTPUT-P05-FALSIFIABLE-HYPOTHESES"),
      Type.Literal("SCA-OBL-OUTPUT-P05-HYPOTHESIS-TRACEABILITY"),
    ]),
    class: Type.Literal("required-result"),
    status: Type.Union([Type.Literal("satisfied"), Type.Literal("pending")]),
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1024 }),
    blocker_codes: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }), {
      maxItems: 32,
    }),
  },
  { additionalProperties: false }
);

export const ScaP05SuccessorLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    run_id: OpaqueIdSchema,
    predecessor_ledger_ref: ArtifactRefSchema,
    predecessor_ledger_sha256: Sha256Schema,
    obligations: Type.Array(ObligationStatusSchema, { minItems: 3, maxItems: 3 }),
    all_required_satisfied: Type.Boolean(),
    pending_phase_ids: Type.Tuple([
      Type.Literal("SCA-P06"),
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
  { additionalProperties: false, $id: SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA }
);
export type ScaP05SuccessorLedgerV1 = Readonly<Static<typeof ScaP05SuccessorLedgerV1Schema>>;

export const ScaP05GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_GATE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    criterion_id: Type.Literal("AC-P05"),
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("blocked")]),
    p04_gate_ref: ArtifactRefSchema,
    traceability_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    exhaustive_accounting: Type.Boolean(),
    immutable_revisions_valid: Type.Boolean(),
    disclosure_and_model_evidence_valid: Type.Boolean(),
    checkpoint_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    blocker_codes: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }), {
      maxItems: 64,
    }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_GATE_V1_SCHEMA }
);
export type ScaP05GateV1 = Readonly<Static<typeof ScaP05GateV1Schema>>;

export const ScaP05ToP06TransitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_TO_P06_TRANSITION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    source_phase_id: Type.Literal(SCA_P05_PHASE_ID),
    target_phase_id: Type.Literal("SCA-P06"),
    authorized: Type.Literal(true),
    qualification_scope: Type.Literal("live_qualified"),
    p05_request_ref: ArtifactRefSchema,
    accepted_cohort_ref: ArtifactRefSchema,
    traceability_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    p05_gate_ref: ArtifactRefSchema,
    active_hypothesis_ids: Type.Array(Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }), {
      maxItems: 10_000,
    }),
    refuted_hypothesis_ids: Type.Array(Type.String({ pattern: "^p05h_[a-f0-9]{64}$" }), {
      maxItems: 10_000,
    }),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P05_TO_P06_TRANSITION_V1_SCHEMA }
);
export type ScaP05ToP06TransitionV1 = Readonly<Static<typeof ScaP05ToP06TransitionV1Schema>>;

export const ScaP05TerminalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P05_TERMINAL_V1_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P05_PHASE_ID),
    status: Type.Union([
      Type.Literal("candidate_complete"),
      Type.Literal("incomplete"),
      Type.Literal("blocked"),
      Type.Literal("cancelled"),
    ]),
    gate_ref: NullableArtifactRefSchema,
    p06_transition_ref: NullableArtifactRefSchema,
    p06_authorized: Type.Boolean(),
    selected_artifact_refs: Type.Array(ArtifactRefSchema, { maxItems: 100_000 }),
    blocker_codes: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" }), {
      maxItems: 64,
    }),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    nonterminal_campaign: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P05_TERMINAL_V1_SCHEMA }
);
export type ScaP05TerminalV1 = Readonly<Static<typeof ScaP05TerminalV1Schema>>;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function assertSelfDigest<T extends Readonly<Record<string, unknown>>>(
  value: T,
  field: keyof T,
  label: string
): void {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  const expected = sha256(canonicalJson(body));
  if (value[field] !== expected) throw new Error(`${label} self digest mismatch`);
}
function assertSortedUnique(values: readonly string[], label: string): void {
  const expected = [...new Set(values)].sort();
  if (!same(values, expected))
    throw new Error(`${label} must be unique and lexicographically sorted`);
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
  if (!same(value, SCA_P05_REQUIRED_MODEL))
    throw new Error(`${label} is not exact DeepSeek identity`);
}

export function withSelfDigest<T extends Readonly<Record<string, unknown>>, K extends string>(
  value: T,
  field: K
): T & Readonly<Record<K, string>> {
  const digest = sha256(canonicalJson(value));
  return { ...value, [field]: digest } as T & Readonly<Record<K, string>>;
}

export function scaP05HypothesisId(sourceSnapshotSha256: string, selectedItemId: string): string {
  return `p05h_${sha256(canonicalJson({ source_snapshot_sha256: sourceSnapshotSha256, selected_item_id: selectedItemId }))}`;
}
export function scaP05SourceSegmentId(input: {
  readonly origin_ref: ArtifactRef;
  readonly source_path: string;
  readonly start_line: number;
  readonly end_line_exclusive: number;
  readonly visible_text_sha256: string;
}): string {
  return `p05s_${sha256(canonicalJson(input))}`;
}
export function scaP05EvidenceAtomId(input: {
  readonly origin_ref: ArtifactRef;
  readonly selector: string;
  readonly value_sha256: string;
}): string {
  return `p05a_${sha256(canonicalJson(input))}`;
}
export function scaP05ObservableId(input: {
  readonly selected_item_id: string;
  readonly kind: "supporting" | "refuting";
  readonly ordinal: number;
}): string {
  const selectedDigest = input.selected_item_id.replace(/^p04[di]_/u, "");
  if (
    !/^[a-f0-9]{64}$/u.test(selectedDigest) ||
    !Number.isInteger(input.ordinal) ||
    input.ordinal < 1
  ) {
    throw new Error("SCA P05 observable identity input is invalid");
  }
  return `p05o_${selectedDigest}_${input.kind}_${String(input.ordinal).padStart(4, "0")}`;
}

export function validateScaP05RequestV1(value: unknown): ScaP05RequestV1 {
  const parsed = validateContract(ScaP05RequestV1Schema, value, "SCA P05 request");
  assertSelfDigest(parsed, "request_sha256", "SCA P05 request");
  if (parsed.p04_transition_ref.content_schema?.schema_id !== SCA_P04_TO_P05_TRANSITION_V1_SCHEMA) {
    throw new Error("SCA P05 request does not reference a P04 transition");
  }
  return parsed;
}
export function validateScaP05ImplementationIdentityV1(
  value: unknown
): ScaP05ImplementationIdentityV1 {
  const parsed = validateContract(
    ScaP05ImplementationIdentityV1Schema,
    value,
    "SCA P05 implementation identity"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P05 implementation identity model");
  return parsed;
}
export function validateScaP05RuntimePolicyV1(value: unknown): ScaP05RuntimePolicyV1 {
  const parsed = validateContract(ScaP05RuntimePolicyV1Schema, value, "SCA P05 runtime policy");
  assertExactRequiredModel(parsed.required_model, "SCA P05 runtime policy model");
  return parsed;
}
export function validateScaP05DisclosureAuthorityV1(value: unknown): ScaP05DisclosureAuthorityV1 {
  const parsed = validateContract(
    ScaP05DisclosureAuthorityV1Schema,
    value,
    "SCA P05 disclosure authority"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P05 disclosure authority model");
  assertSelfDigest(parsed, "authority_sha256", "SCA P05 disclosure authority");
  return parsed;
}
export function validateScaP05ControlRecordV1(value: unknown): ScaP05ControlRecordV1 {
  const parsed = validateContract(ScaP05ControlRecordV1Schema, value, "SCA P05 control record");
  assertNoBlankStrings(parsed, "SCA P05 control record");
  assertSelfDigest(parsed, "record_sha256", "SCA P05 control record");
  return parsed;
}
export function validateScaP05DisclosureScopeV1(value: unknown): ScaP05DisclosureScopeV1 {
  const parsed = validateContract(ScaP05DisclosureScopeV1Schema, value, "SCA P05 disclosure scope");
  assertExactRequiredModel(parsed.required_model, "SCA P05 disclosure scope model");
  assertSelfDigest(parsed, "scope_sha256", "SCA P05 disclosure scope");
  assertSortedUnique(
    parsed.source_segments.map((entry) => entry.segment_id),
    "P05 segment ids"
  );
  assertSortedUnique(
    parsed.evidence_permissions.map((entry) => entry.atom_id),
    "P05 atom permissions"
  );
  for (const segment of parsed.source_segments) {
    if (segment.start_line >= segment.end_line_exclusive)
      throw new Error("P05 source segment range is empty");
    if (sha256(Buffer.from(segment.visible_text_utf8, "utf8")) !== segment.visible_text_sha256) {
      throw new Error(`P05 source segment '${segment.segment_id}' visible-text digest mismatch`);
    }
    if (
      segment.segment_id !==
      scaP05SourceSegmentId({
        origin_ref: segment.origin_ref,
        source_path: segment.source_path,
        start_line: segment.start_line,
        end_line_exclusive: segment.end_line_exclusive,
        visible_text_sha256: segment.visible_text_sha256,
      })
    ) {
      throw new Error(`P05 source segment '${segment.segment_id}' identity mismatch`);
    }
    if (
      (segment.transformation === "verbatim" &&
        (segment.redaction_ranges.length !== 0 ||
          segment.secrets_status !== "absent" ||
          segment.personal_data_status !== "absent")) ||
      (segment.transformation === "redacted" &&
        (segment.redaction_ranges.length === 0 ||
          (segment.secrets_status !== "redacted" && segment.personal_data_status !== "redacted")))
    ) {
      throw new Error(`P05 source segment '${segment.segment_id}' redaction binding mismatch`);
    }
  }
  for (const atom of parsed.evidence_permissions) {
    if (
      atom.atom_id !==
      scaP05EvidenceAtomId({
        origin_ref: atom.origin_ref,
        selector: atom.selector,
        value_sha256: atom.value_sha256,
      })
    ) {
      throw new Error(`P05 evidence permission '${atom.atom_id}' identity mismatch`);
    }
  }
  if ((parsed.decision === "allow") !== (parsed.blocker_codes.length === 0)) {
    throw new Error("P05 disclosure scope decision/blocker mismatch");
  }
  return parsed;
}
export function validateScaP05AcceptedCohortV1(value: unknown): ScaP05AcceptedCohortV1 {
  const parsed = validateContract(ScaP05AcceptedCohortV1Schema, value, "SCA P05 accepted cohort");
  assertSortedUnique(parsed.selected_item_ids, "P05 selected item ids");
  assertSelfDigest(parsed, "cohort_sha256", "SCA P05 accepted cohort");
  return parsed;
}
export function validateScaP05CognitivePayloadV1(value: unknown): ScaP05CognitivePayloadV1 {
  const parsed = validateContract(
    ScaP05CognitivePayloadV1Schema,
    value,
    "SCA P05 cognitive payload"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P05 cognitive payload model");
  if (
    (parsed.role === SCA_P05_CONSTRUCTOR_ROLE) !==
    (parsed.purpose === "p05_hypothesis_construction")
  ) {
    throw new Error("SCA P05 payload role/purpose mismatch");
  }
  if ((parsed.role === SCA_P05_CONSTRUCTOR_ROLE) !== (parsed.constructor_result_ref === null)) {
    throw new Error("SCA P05 payload constructor predecessor mismatch");
  }
  assertSortedUnique(parsed.assigned_item_ids, "P05 payload assigned ids");
  assertSortedUnique(
    parsed.items.map((entry) => entry.selected_item_id),
    "P05 payload item ids"
  );
  if (
    !same(
      parsed.assigned_item_ids,
      parsed.items.map((entry) => entry.selected_item_id)
    )
  ) {
    throw new Error("SCA P05 payload items are not exhaustive");
  }
  assertSortedUnique(
    parsed.evidence_atoms.map((entry) => entry.atom_id),
    "P05 payload atom ids"
  );
  const atomIds = new Set(parsed.evidence_atoms.map((entry) => entry.atom_id));
  const assignedIds = new Set(parsed.assigned_item_ids);
  for (const atom of parsed.evidence_atoms) {
    if (
      !assignedIds.has(atom.selected_item_id) ||
      atom.value_sha256 !== sha256(canonicalJson(atom.value)) ||
      atom.atom_id !==
        scaP05EvidenceAtomId({
          origin_ref: atom.origin_ref,
          selector: atom.selector,
          value_sha256: atom.value_sha256,
        })
    ) {
      throw new Error(`P05 evidence atom '${atom.atom_id}' exact value/owner binding mismatch`);
    }
  }
  const atomById = new Map(parsed.evidence_atoms.map((entry) => [entry.atom_id, entry]));
  for (const item of parsed.items) {
    if (
      item.expected_hypothesis_id !==
      scaP05HypothesisId(parsed.source_snapshot_sha256, item.selected_item_id)
    ) {
      throw new Error(`P05 '${item.selected_item_id}' expected hypothesis identity mismatch`);
    }
    assertSortedUnique(item.evidence_atom_ids, `P05 '${item.selected_item_id}' evidence atom ids`);
    if (
      item.evidence_atom_ids.some(
        (id) => !atomIds.has(id) || atomById.get(id)?.selected_item_id !== item.selected_item_id
      )
    ) {
      throw new Error(
        `P05 '${item.selected_item_id}' references an absent or cross-item evidence atom`
      );
    }
  }
  assertSelfDigest(parsed, "payload_sha256", "SCA P05 cognitive payload");
  return parsed;
}
export function validateScaP05DisclosureAdmissionV1(value: unknown): ScaP05DisclosureAdmissionV1 {
  const parsed = validateContract(
    ScaP05DisclosureAdmissionV1Schema,
    value,
    "SCA P05 disclosure admission"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P05 disclosure admission model");
  assertSortedUnique(parsed.authorized_segment_ids, "P05 disclosure segment ids");
  assertSortedUnique(parsed.authorized_atom_ids, "P05 disclosure atom ids");
  if ((parsed.decision === "allow") !== (parsed.blocker_codes.length === 0)) {
    throw new Error("P05 disclosure admission decision/blocker mismatch");
  }
  assertSelfDigest(parsed, "admission_sha256", "SCA P05 disclosure admission");
  return parsed;
}

function hypothesisAtomIds(body: ScaP05HypothesisBodyV1): string[] {
  return [
    ...body.actor.evidence_atom_ids,
    ...body.controlled_input.evidence_atom_ids,
    ...body.relevant_state.evidence_atom_ids,
    ...body.causal_path.flatMap((entry) => entry.evidence_atom_ids),
    ...body.security_sensitive_outcome.evidence_atom_ids,
    ...body.competing_benign_explanation.evidence_atom_ids,
    ...body.expected_supporting_observations.flatMap((entry) => entry.basis_atom_ids),
    ...body.expected_refuting_observations.flatMap((entry) => entry.basis_atom_ids),
  ];
}
export function validateScaP05HypothesisBodyV1(value: unknown): ScaP05HypothesisBodyV1 {
  const parsed = validateContract(ScaP05HypothesisBodyV1Schema, value, "SCA P05 hypothesis body");
  assertNoBlankStrings(parsed, "SCA P05 hypothesis body");
  parsed.causal_path.forEach((entry, index) => {
    if (entry.ordinal !== index + 1)
      throw new Error("SCA P05 causal path ordinals must be contiguous");
    const prior = parsed.causal_path[index - 1];
    if (prior !== undefined && prior.state_after !== entry.state_before) {
      throw new Error("SCA P05 causal path state transitions must be continuous");
    }
    assertSortedUnique(entry.evidence_atom_ids, `P05 causal link ${entry.ordinal} atom ids`);
  });
  const supportIds = parsed.expected_supporting_observations.map((entry) => entry.observable_id);
  const refuteIds = parsed.expected_refuting_observations.map((entry) => entry.observable_id);
  for (const [index, observation] of parsed.expected_supporting_observations.entries()) {
    if (
      observation.observable_id !==
      scaP05ObservableId({
        selected_item_id: parsed.selected_item_id,
        kind: "supporting",
        ordinal: index + 1,
      })
    ) {
      throw new Error("SCA P05 supporting observable identity mismatch");
    }
    if (!observation.expected_if_claim) {
      throw new Error("SCA P05 supporting observable expectation must be true");
    }
    assertSortedUnique(observation.basis_atom_ids, "P05 supporting observable atom ids");
  }
  for (const [index, observation] of parsed.expected_refuting_observations.entries()) {
    if (
      observation.observable_id !==
      scaP05ObservableId({
        selected_item_id: parsed.selected_item_id,
        kind: "refuting",
        ordinal: index + 1,
      })
    ) {
      throw new Error("SCA P05 refuting observable identity mismatch");
    }
    if (observation.expected_if_claim) {
      throw new Error("SCA P05 refuting observable expectation must be false");
    }
    assertSortedUnique(observation.basis_atom_ids, "P05 refuting observable atom ids");
  }
  assertSortedUnique(supportIds, "P05 supporting observable ids");
  assertSortedUnique(refuteIds, "P05 refuting observable ids");
  if (supportIds.some((id) => refuteIds.includes(id))) {
    throw new Error("SCA P05 supporting and refuting observables must be disjoint");
  }
  for (const [label, ids] of [
    ["actor", parsed.actor.evidence_atom_ids],
    ["controlled input", parsed.controlled_input.evidence_atom_ids],
    ["relevant state", parsed.relevant_state.evidence_atom_ids],
    ["security outcome", parsed.security_sensitive_outcome.evidence_atom_ids],
    ["benign explanation", parsed.competing_benign_explanation.evidence_atom_ids],
  ] as const) {
    assertSortedUnique(ids, `P05 ${label} atom ids`);
  }
  return parsed;
}
export function validateScaP05ConstructorResultV1(value: unknown): ScaP05ConstructorResultV1 {
  const parsed = validateContract(
    ScaP05ConstructorResultV1Schema,
    value,
    "SCA P05 constructor result"
  );
  assertSortedUnique(parsed.assigned_item_ids, "P05 constructor assigned ids");
  assertSortedUnique(
    parsed.items.map((entry) => entry.selected_item_id),
    "P05 constructor item ids"
  );
  if (
    !same(
      parsed.assigned_item_ids,
      parsed.items.map((entry) => entry.selected_item_id)
    )
  ) {
    throw new Error("SCA P05 constructor result is not exhaustive");
  }
  for (const item of parsed.items) {
    if (item.disposition === "formed") {
      const body = validateScaP05HypothesisBodyV1(item.hypothesis);
      if (body.selected_item_id !== item.selected_item_id) {
        throw new Error("SCA P05 formed hypothesis item binding mismatch");
      }
    }
  }
  return parsed;
}
export function validateScaP05ChallengerResultV1(value: unknown): ScaP05ChallengerResultV1 {
  const parsed = validateContract(
    ScaP05ChallengerResultV1Schema,
    value,
    "SCA P05 challenger result"
  );
  assertSortedUnique(parsed.assigned_item_ids, "P05 challenger assigned ids");
  assertSortedUnique(
    parsed.items.map((entry) => entry.selected_item_id),
    "P05 challenger item ids"
  );
  if (
    !same(
      parsed.assigned_item_ids,
      parsed.items.map((entry) => entry.selected_item_id)
    )
  ) {
    throw new Error("SCA P05 challenger result is not exhaustive");
  }
  for (const item of parsed.items) {
    if (item.decision === "revise_for_investigation") {
      const replacement = validateScaP05HypothesisBodyV1(item.replacement_hypothesis);
      if (
        replacement.selected_item_id !== item.selected_item_id ||
        replacement.hypothesis_id !== item.hypothesis_id
      ) {
        throw new Error("SCA P05 challenger replacement identity mismatch");
      }
      assertSortedUnique(item.changed_fields, "P05 challenger changed fields");
    }
    assertSortedUnique(item.control_atom_ids, "P05 challenger control atoms");
  }
  return parsed;
}
export function validateScaP05HypothesisAgainstPayload(
  body: ScaP05HypothesisBodyV1,
  payload: ScaP05CognitivePayloadV1
): void {
  validateScaP05HypothesisBodyV1(body);
  const item = payload.items.find((entry) => entry.selected_item_id === body.selected_item_id);
  if (item === undefined) throw new Error("SCA P05 hypothesis is outside the assigned payload");
  if (
    body.hypothesis_id !== scaP05HypothesisId(payload.source_snapshot_sha256, body.selected_item_id)
  ) {
    throw new Error("SCA P05 hypothesis stable identity mismatch");
  }
  const atoms = new Map(payload.evidence_atoms.map((entry) => [entry.atom_id, entry]));
  const cited = [...new Set(hypothesisAtomIds(body))];
  if (cited.some((id) => !atoms.has(id) || !item.evidence_atom_ids.includes(id))) {
    throw new Error("SCA P05 hypothesis cites an unauthorized evidence atom");
  }
  if (!cited.some((id) => atoms.get(id)?.atom_kind === "source_segment")) {
    throw new Error("SCA P05 hypothesis lacks an exact source binding");
  }
}
export function validateScaP05HypothesisRevisionV1(value: unknown): ScaP05HypothesisRevisionV1 {
  const parsed = validateContract(
    ScaP05HypothesisRevisionV1Schema,
    value,
    "SCA P05 hypothesis revision"
  );
  validateScaP05HypothesisBodyV1(parsed.body);
  if (
    parsed.body.hypothesis_id !== parsed.hypothesis_id ||
    parsed.body.selected_item_id !== parsed.selected_item_id ||
    parsed.body_sha256 !== sha256(canonicalJson(parsed.body))
  ) {
    throw new Error("SCA P05 revision body binding mismatch");
  }
  if (
    (parsed.revision === 1 &&
      (parsed.parent_revision_ref !== null ||
        parsed.parent_revision_sha256 !== null ||
        parsed.changed_fields.length !== 0)) ||
    (parsed.revision === 2 &&
      (parsed.parent_revision_ref === null ||
        parsed.parent_revision_sha256 === null ||
        parsed.changed_fields.length === 0))
  ) {
    throw new Error("SCA P05 immutable revision chain shape mismatch");
  }
  assertSortedUnique(parsed.evidence_atom_ids, "P05 revision evidence atom ids");
  assertSortedUnique(parsed.change_reason_codes, "P05 revision change reason codes");
  assertSortedUnique(parsed.changed_fields, "P05 revision changed fields");
  assertSelfDigest(parsed, "revision_sha256", "SCA P05 hypothesis revision");
  return parsed;
}
export function validateScaP05CheckpointV1(value: unknown): ScaP05CheckpointV1 {
  const parsed = validateContract(ScaP05CheckpointV1Schema, value, "SCA P05 checkpoint");
  assertSelfDigest(parsed, "checkpoint_sha256", "SCA P05 checkpoint");
  return parsed;
}
export function validateScaP05TraceabilityV1(value: unknown): ScaP05TraceabilityV1 {
  const parsed = validateContract(ScaP05TraceabilityV1Schema, value, "SCA P05 traceability");
  assertSortedUnique(parsed.selected_item_ids, "P05 traceability selected ids");
  assertSortedUnique(
    parsed.rows.map((entry) => entry.selected_item_id),
    "P05 traceability row ids"
  );
  if (
    !same(
      parsed.selected_item_ids,
      parsed.rows.map((entry) => entry.selected_item_id)
    )
  ) {
    throw new Error("SCA P05 traceability is not exhaustive");
  }
  assertSortedUnique(parsed.active_hypothesis_ids, "P05 active hypothesis ids");
  assertSortedUnique(parsed.refuted_hypothesis_ids, "P05 refuted hypothesis ids");
  assertSortedUnique(parsed.checkpointed_item_ids, "P05 checkpointed item ids");
  const expectedActive = parsed.rows
    .filter((entry) => entry.disposition === "active_hypothesis")
    .map((entry) => entry.hypothesis_id)
    .filter((id): id is string => id !== null)
    .sort();
  const expectedRefuted = parsed.rows
    .filter((entry) => entry.disposition === "refuted_by_existing_control")
    .map((entry) => entry.hypothesis_id)
    .filter((id): id is string => id !== null)
    .sort();
  const expectedCheckpointed = parsed.rows
    .filter((entry) => entry.disposition === "checkpointed_incomplete")
    .map((entry) => entry.selected_item_id)
    .sort();
  if (
    !same(parsed.active_hypothesis_ids, expectedActive) ||
    !same(parsed.refuted_hypothesis_ids, expectedRefuted) ||
    !same(parsed.checkpointed_item_ids, expectedCheckpointed) ||
    expectedActive.some((id) => expectedRefuted.includes(id))
  ) {
    throw new Error("SCA P05 traceability disposition partitions are inconsistent");
  }
  for (const row of parsed.rows) {
    const hasConstructor =
      row.constructor_output_ref !== null &&
      row.constructor_guard_ref !== null &&
      row.constructor_receipt_ref !== null;
    const anyConstructor =
      row.constructor_output_ref !== null ||
      row.constructor_guard_ref !== null ||
      row.constructor_receipt_ref !== null;
    const hasRevision = row.initial_revision_ref !== null && row.final_revision_ref !== null;
    const hasChallenge =
      row.challenger_output_ref !== null &&
      row.challenger_guard_ref !== null &&
      row.challenger_receipt_ref !== null;
    const anyChallenge =
      row.challenger_output_ref !== null ||
      row.challenger_guard_ref !== null ||
      row.challenger_receipt_ref !== null;
    const hasCheckpoint = row.checkpoint_ref !== null;
    if (
      anyConstructor !== hasConstructor ||
      anyChallenge !== hasChallenge ||
      (row.disposition === "checkpointed_incomplete" &&
        (!hasCheckpoint ||
          row.final_revision_ref !== null ||
          (row.initial_revision_ref === null) !== (row.hypothesis_id === null))) ||
      (row.disposition !== "checkpointed_incomplete" &&
        (row.hypothesis_id === null ||
          !hasConstructor ||
          !hasRevision ||
          !hasChallenge ||
          hasCheckpoint))
    ) {
      throw new Error(
        `SCA P05 traceability row '${row.selected_item_id}' conditional refs mismatch`
      );
    }
  }
  assertSelfDigest(parsed, "traceability_sha256", "SCA P05 traceability");
  return parsed;
}
export function validateScaP05EvidenceManifestV1(value: unknown): ScaP05EvidenceManifestV1 {
  const parsed = validateContract(
    ScaP05EvidenceManifestV1Schema,
    value,
    "SCA P05 evidence manifest"
  );
  assertSortedUnique(parsed.artifact_ids, "P05 evidence manifest artifact ids");
  if (
    !same(
      parsed.artifact_ids,
      [...new Set(parsed.evidence_refs.map((ref) => ref.artifact_id))].sort()
    )
  ) {
    throw new Error("SCA P05 evidence manifest ref/id mismatch");
  }
  assertSelfDigest(parsed, "manifest_sha256", "SCA P05 evidence manifest");
  return parsed;
}
export function validateScaP05SuccessorLedgerV1(value: unknown): ScaP05SuccessorLedgerV1 {
  const parsed = validateContract(ScaP05SuccessorLedgerV1Schema, value, "SCA P05 successor ledger");
  if (
    !same(
      parsed.obligations.map((entry) => entry.obligation_id),
      [...SCA_P05_OBLIGATION_IDS]
    )
  ) {
    throw new Error("SCA P05 successor ledger obligation set mismatch");
  }
  if (
    parsed.predecessor_ledger_sha256 !== parsed.predecessor_ledger_ref.content_digest ||
    parsed.all_required_satisfied !==
      parsed.obligations.every((entry) => entry.status === "satisfied") ||
    parsed.obligations.some(
      (entry) =>
        (entry.status === "satisfied" &&
          (entry.evidence_refs.length === 0 || entry.blocker_codes.length !== 0)) ||
        (entry.status === "pending" && entry.blocker_codes.length === 0)
    )
  ) {
    throw new Error("SCA P05 successor ledger satisfaction or evidence mismatch");
  }
  assertSelfDigest(parsed, "ledger_sha256", "SCA P05 successor ledger");
  return parsed;
}
export function validateScaP05GateV1(value: unknown): ScaP05GateV1 {
  const parsed = validateContract(ScaP05GateV1Schema, value, "SCA P05 gate");
  const passes =
    parsed.exhaustive_accounting &&
    parsed.immutable_revisions_valid &&
    parsed.disclosure_and_model_evidence_valid &&
    parsed.checkpoint_count === 0 &&
    parsed.blocker_codes.length === 0;
  if (
    (parsed.verdict === "pass") !== passes ||
    (parsed.verdict === "blocked" && parsed.blocker_codes.length === 0)
  ) {
    throw new Error("SCA P05 gate verdict mismatch");
  }
  assertSelfDigest(parsed, "gate_sha256", "SCA P05 gate");
  return parsed;
}
export function validateScaP05ToP06TransitionV1(value: unknown): ScaP05ToP06TransitionV1 {
  const parsed = validateContract(
    ScaP05ToP06TransitionV1Schema,
    value,
    "SCA P05 to P06 transition"
  );
  assertSortedUnique(parsed.active_hypothesis_ids, "P05 transition active ids");
  assertSortedUnique(parsed.refuted_hypothesis_ids, "P05 transition refuted ids");
  if (parsed.active_hypothesis_ids.some((id) => parsed.refuted_hypothesis_ids.includes(id))) {
    throw new Error("SCA P05 transition active/refuted partitions overlap");
  }
  assertSelfDigest(parsed, "transition_sha256", "SCA P05 to P06 transition");
  return parsed;
}
export function validateScaP05TerminalV1(value: unknown): ScaP05TerminalV1 {
  const parsed = validateContract(ScaP05TerminalV1Schema, value, "SCA P05 terminal");
  if (
    parsed.p06_authorized !== (parsed.p06_transition_ref !== null) ||
    (parsed.p06_authorized &&
      (parsed.gate_ref === null ||
        parsed.status !== "candidate_complete" ||
        parsed.blocker_codes.length !== 0)) ||
    (!parsed.p06_authorized && parsed.status === "candidate_complete") ||
    ((parsed.status === "blocked" || parsed.status === "cancelled") &&
      parsed.blocker_codes.length === 0)
  ) {
    throw new Error("SCA P05 terminal authorization/ref mismatch");
  }
  return parsed;
}
