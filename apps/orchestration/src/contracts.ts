import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { ContentSchemaIdentityV1Schema, SchemaIdSchema } from "./skill-contracts/common.js";

const ID_MAX_LENGTH = 256;
const TEXT_MAX_LENGTH = 32_768;
const ERROR_MAX_LENGTH = 4_096;
const MAX_BRANCHES = 64;

const Id = Type.String({ minLength: 1, maxLength: ID_MAX_LENGTH });
const BoundedText = Type.String({ maxLength: TEXT_MAX_LENGTH });
const IsoTimestamp = Type.String({ minLength: 20, maxLength: 40 });
const ArtifactKind = Type.String({ pattern: "^[a-z][a-z0-9-]*$" });

export const ConfidenceSchema = Type.Union([
  Type.Literal("CERTAIN"),
  Type.Literal("PROBABLE"),
  Type.Literal("POSSIBLE"),
  Type.Literal("UNCERTAIN"),
]);
export type Confidence = Static<typeof ConfidenceSchema>;

export const EngineOwnerSchema = Type.Literal("typescript");
export type EngineOwner = Static<typeof EngineOwnerSchema>;

export const TrustProfileSchema = Type.Union([
  Type.Literal("trusted-interactive"),
  Type.Literal("hardened-untrusted"),
]);
export type TrustProfile = Static<typeof TrustProfileSchema>;

export const RunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("awaiting_user"),
  Type.Literal("complete"),
  Type.Literal("incomplete"),
  Type.Literal("error"),
  Type.Literal("cancelled"),
]);
export type RunStatus = Static<typeof RunStatusSchema>;

export const JsonValueSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue"
);
export type JsonValue = Static<typeof JsonValueSchema>;

export const RunIdentitySchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    run_id: Id,
    session_id: Id,
    playbook: Id,
    engine_owner: EngineOwnerSchema,
  },
  { additionalProperties: false }
);
export type RunIdentity = Static<typeof RunIdentitySchema>;

/** Immutable active-registration binding persisted with every new run. */
export const RegistrationContractBindingV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    registration_name: Id,
    contract_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    registration_sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  },
  { additionalProperties: false }
);
export type RegistrationContractBindingV1 = Static<typeof RegistrationContractBindingV1Schema>;

const ArtifactRefCommon = {
  artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
  run_id: Id,
  phase: Id,
  branch_id: Type.Union([Id, Type.Null()]),
  kind: ArtifactKind,
  operation_id: Id,
  version: Type.Integer({ minimum: 1 }),
  producer: Id,
  media_type: Id,
  content_schema: Type.Optional(ContentSchemaIdentityV1Schema),
  byte_length: Type.Integer({ minimum: 0 }),
  content_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  store_ref: Type.String({ pattern: "^artifact://sha256/[a-f0-9]{64}$" }),
} as const;

/** Canonical artifact communication address. It carries lineage, not authorization. */
export const CurrentArtifactRefSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    ...ArtifactRefCommon,
  },
  { additionalProperties: false }
);

export const ArtifactRefSchema = CurrentArtifactRefSchema;
export type ArtifactRef = Static<typeof ArtifactRefSchema>;
export type CurrentArtifactRef = ArtifactRef;

export const InputArtifactBindingSchema = Type.Object(
  {
    slot: Id,
    ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);

/** Exact inputs may originate in any run; slots are routing labels only. */
export const InputArtifactsSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    artifacts: Type.Array(InputArtifactBindingSchema),
  },
  { additionalProperties: false }
);
export type InputArtifacts = Static<typeof InputArtifactsSchema>;

export const CurrentOutputArtifactMetadataSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    run_id: Id,
    phase: Id,
    branch_id: Type.Union([Id, Type.Null()]),
    kind: ArtifactKind,
    operation_id: Id,
    version: Type.Integer({ minimum: 1 }),
    producer: Id,
    media_type: Id,
    content_schema: Type.Optional(ContentSchemaIdentityV1Schema),
    parent_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    upstream_refs: Type.Array(ArtifactRefSchema),
  },
  { additionalProperties: false }
);

export const OutputArtifactMetadataSchema = CurrentOutputArtifactMetadataSchema;
export type OutputArtifactMetadata = Static<typeof OutputArtifactMetadataSchema>;

export const ExecutionReceiptSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    receipt_id: Id,
    run_id: Id,
    state_id: Id,
    branch_id: Type.Union([Id, Type.Null()]),
    agent: Id,
    attempt: Type.Integer({ minimum: 1 }),
    worker_id: Id,
    executor: Type.Literal("pi-sdk"),
    command: Type.Array(Id, { minItems: 1, maxItems: 16 }),
    model: Type.Union([Id, Type.Null()]),
    working_directory: Id,
    trust_profile: TrustProfileSchema,
    started_at: IsoTimestamp,
    ended_at: IsoTimestamp,
    exit_code: Type.Integer(),
    output_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    output_artifact_ref: ArtifactRefSchema,
    trusted_invocation_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    signature: Type.String({ pattern: "^hmac-sha256:[a-f0-9]{64}$" }),
  },
  { additionalProperties: false }
);
export type ExecutionReceipt = Static<typeof ExecutionReceiptSchema>;

export const StartRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("start"),
    identity: RunIdentitySchema,
    goal: Type.String({ minLength: 1 }),
    constraints: Type.Record(Type.String(), JsonValueSchema),
    project_root: Type.String({ minLength: 1 }),
    trust_profile: TrustProfileSchema,
    /** Optional owner-persisted inputs seeded before the first playbook state. */
    input_artifacts: Type.Optional(InputArtifactsSchema),
  },
  { additionalProperties: false }
);
export type StartRequest = Static<typeof StartRequestSchema>;

export const LivenessTerminalReasonSchema = Type.Union([
  Type.Literal("malformed_result_budget_exhausted"),
  Type.Literal("identical_error_stall"),
  Type.Literal("protocol_error_budget_exhausted"),
  Type.Literal("model_turn_budget_exhausted"),
  Type.Literal("tool_call_budget_exhausted"),
  Type.Literal("external_request_budget_exhausted"),
  Type.Literal("worker_wall_clock_exhausted"),
  Type.Literal("run_wall_clock_exhausted"),
  Type.Literal("routing_repair_binding_invalid"),
]);
export type LivenessTerminalReason = Static<typeof LivenessTerminalReasonSchema>;

const LivenessRepairPolicySchema = Type.Object(
  {
    max_invocations_per_state_branch: Type.Literal(1),
    model_turns_per_worker: Type.Literal(4),
    tool_calls_per_worker: Type.Literal(2),
    external_calls_per_worker: Type.Literal(0),
    worker_wall_clock_ms: Type.Literal(120_000),
  },
  { additionalProperties: false }
);

export const LivenessPolicyV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    scope: Type.String({ pattern: "^[a-z][a-z0-9-]*$", maxLength: 128 }),
    preset: Type.String({ minLength: 1, maxLength: 32 }),
    total_phase_repair_invocations: Type.Integer({ minimum: 1 }),
    model_turns_per_worker: Type.Integer({ minimum: 1 }),
    model_turns_per_run: Type.Integer({ minimum: 1 }),
    tool_calls_per_worker: Type.Integer({ minimum: 1 }),
    tool_calls_per_run: Type.Integer({ minimum: 1 }),
    external_calls_per_worker: Type.Integer({ minimum: 0 }),
    external_calls_per_run: Type.Integer({ minimum: 0 }),
    worker_wall_clock_ms: Type.Integer({ minimum: 1 }),
    run_wall_clock_ms: Type.Integer({ minimum: 1 }),
    malformed_results_per_state_branch: Type.Literal(2),
    identical_malformed_digest_limit: Type.Literal(2),
    protocol_errors_per_worker: Type.Literal(4),
    identical_protocol_digest_limit: Type.Literal(2),
    routing_repair: LivenessRepairPolicySchema,
  },
  { additionalProperties: false }
);
export type LivenessPolicyV1 = Static<typeof LivenessPolicyV1Schema>;

export const LivenessSnapshotV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    policy_state: Type.Union([Type.Literal("bound"), Type.Literal("legacy_unmetered")]),
    preset: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
    phase_invocations: Type.Integer({ minimum: 0 }),
    repair_invocations: Type.Integer({ minimum: 0 }),
    model_turns: Type.Integer({ minimum: 0 }),
    tool_calls: Type.Integer({ minimum: 0 }),
    external_calls: Type.Integer({ minimum: 0 }),
    malformed_results: Type.Integer({ minimum: 0 }),
    protocol_errors: Type.Integer({ minimum: 0 }),
    active_wall_clock_ms: Type.Integer({ minimum: 0 }),
    open_workers: Type.Integer({ minimum: 0 }),
    terminal_reason: Type.Union([LivenessTerminalReasonSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type LivenessSnapshotV1 = Static<typeof LivenessSnapshotV1Schema>;

export const RoutingRepairBindingV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    source_state_id: Id,
    source_branch_id: Type.Union([Id, Type.Null()]),
    source_agent: Id,
    source_attempt: Type.Integer({ minimum: 1 }),
    source_artifact_ref: ArtifactRefSchema,
    source_receipt_id: Id,
    source_result_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false }
);
export type RoutingRepairBindingV1 = Static<typeof RoutingRepairBindingV1Schema>;

export const PhaseResultSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    run_id: Id,
    state_id: Id,
    agent: Id,
    attempt: Type.Integer({ minimum: 1 }),
    branch_id: Type.Optional(Id),
    confidence: ConfidenceSchema,
    details: Type.Record(Type.String(), JsonValueSchema),
    output_artifact: ArtifactRefSchema,
    worker_receipt: ExecutionReceiptSchema,
  },
  { additionalProperties: false }
);
export type PhaseResult = Static<typeof PhaseResultSchema>;

export const StepRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("step"),
    identity: RunIdentitySchema,
    result: PhaseResultSchema,
  },
  { additionalProperties: false }
);
export type StepRequest = Static<typeof StepRequestSchema>;

export const StatusRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("status"),
    identity: RunIdentitySchema,
  },
  { additionalProperties: false }
);
export type StatusRequest = Static<typeof StatusRequestSchema>;

export const RecoverRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("recover"),
    identity: RunIdentitySchema,
    retry_errored: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);
export type RecoverRequest = Static<typeof RecoverRequestSchema>;

export const CancelRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("cancel"),
    identity: RunIdentitySchema,
    reason: Type.Optional(Type.String({ maxLength: ERROR_MAX_LENGTH })),
  },
  { additionalProperties: false }
);
export type CancelRequest = Static<typeof CancelRequestSchema>;

export const RespondRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("respond"),
    identity: RunIdentitySchema,
    gate_id: Id,
    challenge: Id,
    response: JsonValueSchema,
  },
  { additionalProperties: false }
);
export type RespondRequest = Static<typeof RespondRequestSchema>;

export const BranchDispatchSchema = Type.Object(
  {
    branch_id: Id,
    state_id: Id,
    agent: Id,
    attempt: Type.Integer({ minimum: 1 }),
    trust_profile: TrustProfileSchema,
    model_override: Type.Optional(Id),
    execution_purpose: Type.Optional(
      Type.Union([Type.Literal("phase"), Type.Literal("routing_repair")])
    ),
    routing_repair_binding: Type.Optional(RoutingRepairBindingV1Schema),
    task: BoundedText,
    input_artifacts: InputArtifactsSchema,
    output_artifact: OutputArtifactMetadataSchema,
  },
  { additionalProperties: false }
);
export type BranchDispatch = Static<typeof BranchDispatchSchema>;

export const InvokeAgentDirectiveSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("invoke_agent"),
    identity: RunIdentitySchema,
    state_id: Id,
    agent: Id,
    attempt: Type.Integer({ minimum: 1 }),
    trust_profile: TrustProfileSchema,
    model_override: Type.Optional(Id),
    execution_purpose: Type.Optional(
      Type.Union([Type.Literal("phase"), Type.Literal("routing_repair")])
    ),
    routing_repair_binding: Type.Optional(RoutingRepairBindingV1Schema),
    task: BoundedText,
    input_artifacts: InputArtifactsSchema,
    output_artifact: OutputArtifactMetadataSchema,
  },
  { additionalProperties: false }
);

export const InvokeParallelDirectiveSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("invoke_agents_parallel"),
    identity: RunIdentitySchema,
    state_id: Id,
    branches: Type.Array(BranchDispatchSchema, {
      minItems: 1,
      maxItems: MAX_BRANCHES,
    }),
  },
  { additionalProperties: false }
);

/** Finite aggregate allocation reserved by a parent before one child starts. */
export const ChildWorkflowBudgetAllocationV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    model_turns: Type.Integer({ minimum: 1, maximum: 1_024 }),
    tool_calls: Type.Integer({ minimum: 0, maximum: 4_096 }),
    external_calls: Type.Integer({ minimum: 0, maximum: 1_024 }),
    wall_clock_ms: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
    max_steps: Type.Integer({ minimum: 1, maximum: 4_096 }),
    output_bytes: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
  },
  { additionalProperties: false }
);
export type ChildWorkflowBudgetAllocationV1 = Static<typeof ChildWorkflowBudgetAllocationV1Schema>;

/** Exact semantic product the parent is prepared to consume. */
export const ChildWorkflowOutputContractV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    port_name: Id,
    schema_id: SchemaIdSchema,
    schema_version_required: Type.Integer({ minimum: 1 }),
    artifact_kind: ArtifactKind,
  },
  { additionalProperties: false }
);
export type ChildWorkflowOutputContractV1 = Static<typeof ChildWorkflowOutputContractV1Schema>;

/** Host-revalidated scope and destination binding; labels themselves grant no authority. */
export const ChildWorkflowPolicyBindingV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: Id,
    principal_id: Id,
    scope_id: Id,
    source_policy_id: Id,
    destination_policy_id: Id,
  },
  { additionalProperties: false }
);
export type ChildWorkflowPolicyBindingV1 = Static<typeof ChildWorkflowPolicyBindingV1Schema>;

const ChildWorkflowResumeV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    child_gate_id: Id,
    child_challenge: Id,
    child_payload_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    response: JsonValueSchema,
  },
  { additionalProperties: false }
);

/** Internal, depth-one engine directive. It is never accepted as a public start request. */
export const InvokeChildWorkflowDirectiveSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("invoke_child_workflow"),
    identity: RunIdentitySchema,
    state_id: Id,
    call_key: Id,
    child_name: Id,
    request_ref: ArtifactRefSchema,
    input_artifacts: InputArtifactsSchema,
    expected_output: ChildWorkflowOutputContractV1Schema,
    policy_binding: ChildWorkflowPolicyBindingV1Schema,
    budget: ChildWorkflowBudgetAllocationV1Schema,
    resume: Type.Optional(ChildWorkflowResumeV1Schema),
  },
  { additionalProperties: false }
);
export type InvokeChildWorkflowDirective = Static<typeof InvokeChildWorkflowDirectiveSchema>;

const ChildWorkflowGateProjectionV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    call_id: Id,
    child_run_id: Id,
    child_gate_id: Id,
    child_challenge: Id,
    child_payload_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false }
);

export const UserGateDirectiveSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("await_user"),
    identity: RunIdentitySchema,
    state_id: Id,
    gate_id: Id,
    challenge: Id,
    payload_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    child_workflow: Type.Optional(ChildWorkflowGateProjectionV1Schema),
    questions: Type.Array(
      Type.Object(
        {
          id: Id,
          prompt: Type.String({ minLength: 1, maxLength: ERROR_MAX_LENGTH }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 16 }
    ),
  },
  { additionalProperties: false }
);

export const TerminalDirectiveSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Union([
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Literal("error"),
      Type.Literal("cancelled"),
    ]),
    identity: RunIdentitySchema,
    status: RunStatusSchema,
    met: Type.Boolean(),
    result: Type.Record(Type.String(), JsonValueSchema),
    artifacts: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
    unresolved: Type.Array(Type.String({ maxLength: ERROR_MAX_LENGTH }), {
      maxItems: 128,
    }),
  },
  { additionalProperties: false }
);

export const ArtifactDispatchPauseCodeSchema = Type.Union([
  Type.Literal("DISPATCH_PAUSED"),
  Type.Literal("DISPATCH_MODE_INVALID"),
  Type.Literal("LEGACY_UNMETERED"),
]);
export type ArtifactDispatchPauseCode = Static<typeof ArtifactDispatchPauseCodeSchema>;

const ObservedArtifactDispatchIneligibilityCodeSchema = Type.Union([
  Type.Literal("LEGACY_UNMETERED"),
  Type.Literal("CHECKPOINT_NOT_RESUMABLE"),
]);
export const ArtifactDispatchIneligibilityCodeSchema = Type.Union([
  ObservedArtifactDispatchIneligibilityCodeSchema,
  Type.Literal("LEGACY_CHECKPOINT_UNVERIFIED"),
]);
export type ArtifactDispatchIneligibilityCode = Static<
  typeof ArtifactDispatchIneligibilityCodeSchema
>;

export const ArtifactDispatchStateV1Schema = Type.Union([
  Type.Object(
    {
      schema_version: Type.Literal(1),
      mode: Type.Literal("active"),
      configured_as: Type.Union([Type.Literal("unset"), Type.Literal("active")]),
      code: Type.Literal("DISPATCH_ACTIVE"),
      reason: Type.String({ minLength: 1, maxLength: ERROR_MAX_LENGTH }),
      dispatch_allowed: Type.Literal(true),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      schema_version: Type.Literal(1),
      mode: Type.Literal("paused"),
      configured_as: Type.Literal("paused"),
      code: Type.Literal("DISPATCH_PAUSED"),
      reason: Type.String({ minLength: 1, maxLength: ERROR_MAX_LENGTH }),
      dispatch_allowed: Type.Literal(false),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      schema_version: Type.Literal(1),
      mode: Type.Literal("paused"),
      configured_as: Type.Literal("invalid"),
      code: Type.Literal("DISPATCH_MODE_INVALID"),
      reason: Type.String({ minLength: 1, maxLength: ERROR_MAX_LENGTH }),
      dispatch_allowed: Type.Literal(false),
    },
    { additionalProperties: false }
  ),
]);
export type ArtifactDispatchStateV1 = Static<typeof ArtifactDispatchStateV1Schema>;

const ArtifactDispatchRecoveryCommonV1 = {
  schema_version: Type.Literal(1),
  identity: RunIdentitySchema,
  state_id: Id,
  reason: Type.String({ minLength: 1, maxLength: ERROR_MAX_LENGTH }),
};

export const ArtifactDispatchRecoveryV1Schema = Type.Union([
  Type.Object(
    {
      ...ArtifactDispatchRecoveryCommonV1,
      kind: Type.Literal("recoverable_checkpoint"),
      action: Type.Literal("recover"),
      checkpoint_exists: Type.Literal(true),
      checkpoint_preserved: Type.Literal(true),
      resumable: Type.Literal(true),
      requires_dispatch_mode: Type.Literal("active"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...ArtifactDispatchRecoveryCommonV1,
      kind: Type.Literal("start_retry"),
      action: Type.Literal("retry_start"),
      checkpoint_exists: Type.Boolean(),
      checkpoint_preserved: Type.Boolean(),
      resumable: Type.Literal(false),
      requires_dispatch_mode: Type.Literal("active"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...ArtifactDispatchRecoveryCommonV1,
      kind: Type.Literal("saved_but_ineligible"),
      action: Type.Literal("status_or_cancel"),
      ineligibility_code: ObservedArtifactDispatchIneligibilityCodeSchema,
      checkpoint_exists: Type.Literal(true),
      checkpoint_preserved: Type.Literal(true),
      resumable: Type.Literal(false),
      requires_dispatch_mode: Type.Null(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...ArtifactDispatchRecoveryCommonV1,
      kind: Type.Literal("saved_but_ineligible"),
      action: Type.Literal("status_or_cancel"),
      ineligibility_code: Type.Union([
        Type.Literal("LEGACY_UNMETERED"),
        Type.Literal("LEGACY_CHECKPOINT_UNVERIFIED"),
      ]),
      checkpoint_exists: Type.Null(),
      checkpoint_preserved: Type.Null(),
      legacy_checkpoint_preserved_claim: Type.Boolean(),
      resumable: Type.Literal(false),
      requires_dispatch_mode: Type.Null(),
    },
    { additionalProperties: false }
  ),
]);
export type ArtifactDispatchRecoveryV1 = Static<typeof ArtifactDispatchRecoveryV1Schema>;

/** Historical v2 paused wire shape. Readers accept and project it; writers emit v1 facts. */
export const LegacyPausedDirectiveV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("paused"),
    identity: RunIdentitySchema,
    status: Type.Literal("running"),
    state_id: Id,
    code: ArtifactDispatchPauseCodeSchema,
    reason: Type.String({ minLength: 1, maxLength: ERROR_MAX_LENGTH }),
    retryable: Type.Literal(true),
    recovery: Type.Object(
      {
        action: Type.Literal("recover"),
        run_id: Id,
        checkpoint_preserved: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type LegacyPausedDirectiveV2 = Static<typeof LegacyPausedDirectiveV2Schema>;

export const ArtifactDispatchPauseV1Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    pause_schema_version: Type.Literal(1),
    action: Type.Literal("paused"),
    identity: RunIdentitySchema,
    status: RunStatusSchema,
    state_id: Id,
    code: ArtifactDispatchPauseCodeSchema,
    reason: Type.String({ minLength: 1, maxLength: ERROR_MAX_LENGTH }),
    retryable: Type.Boolean(),
    dispatch: ArtifactDispatchStateV1Schema,
    recovery: ArtifactDispatchRecoveryV1Schema,
  },
  { additionalProperties: false }
);
export type ArtifactDispatchPauseV1 = Static<typeof ArtifactDispatchPauseV1Schema>;

export const PausedDirectiveSchema = Type.Union([
  ArtifactDispatchPauseV1Schema,
  LegacyPausedDirectiveV2Schema,
]);

export const StatusDirectiveSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("status"),
    identity: RunIdentitySchema,
    status: RunStatusSchema,
    state_id: Id,
    terminal: Type.Boolean(),
    met: Type.Boolean(),
    liveness: Type.Optional(LivenessSnapshotV1Schema),
  },
  { additionalProperties: false }
);

export const DirectiveSchema = Type.Union([
  InvokeAgentDirectiveSchema,
  InvokeParallelDirectiveSchema,
  InvokeChildWorkflowDirectiveSchema,
  UserGateDirectiveSchema,
  TerminalDirectiveSchema,
  PausedDirectiveSchema,
  StatusDirectiveSchema,
]);
export type Directive = Static<typeof DirectiveSchema>;

// ---------------------------------------------------------------------------
// Universal-skills Foundation stage (workstream 1 of 3): W3 / W5 / W7 contracts.
//
// All three shapes are declared together so the contract is frozen in one place.
// Their behaviour is activated in separate phases: W3 validates the contract at
// dispatch (F4), W5 routes repair by feedback kind (F5), W7 evaluates the completion
// gate before terminal (F7).
// ---------------------------------------------------------------------------

/**
 * W5 — how a detected gap is classified, so the engine can route repair by cause
 * instead of by bespoke per-playbook branching.
 */
export const FeedbackKindSchema = Type.Union([
  /** Evidence is missing or ungrounded -> gather more evidence. */
  Type.Literal("evidence_gap"),
  /** Evidence is adequate but the synthesis over it is not -> re-synthesize. */
  Type.Literal("synthesis_gap"),
  /** A claim is not supported by its cited evidence -> repair claims. */
  Type.Literal("validation_gap"),
  /** Decision/strategy analysis is incomplete or internally inconsistent. */
  Type.Literal("analysis_gap"),
  /** The latest decision/strategy semantic product needs author-owned revision. */
  Type.Literal("product_gap"),
  /** The latest diagnosis semantic product needs author-owned revision. */
  Type.Literal("diagnosis_product_gap"),
  /** The latest assessment semantic product needs author-owned revision. */
  Type.Literal("assessment_product_gap"),
  /** Structurally valid phase result honestly reports incomplete work. */
  Type.Literal("phase_incomplete"),
  /** Worker output was structurally invalid -> engine-owned P1.2 routing repair. */
  Type.Literal("malformed_result"),
]);
export type FeedbackKind = Static<typeof FeedbackKindSchema>;

export const EvaluationResultV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    kind: FeedbackKindSchema,
    detail: Type.String({ maxLength: 4_096 }),
    findings: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 32 }),
    strategy_delta: Type.String({ minLength: 1, maxLength: 4_096 }),
  },
  { additionalProperties: false }
);
export type EvaluationResultV2 = Static<typeof EvaluationResultV2Schema>;

const RepairStateIdSchema = Type.String({ minLength: 1, maxLength: 128 });

export const RepairRouteV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    origin_state: RepairStateIdSchema,
    feedback_kind: FeedbackKindSchema,
    repair: Type.Object(
      {
        action: Type.Literal("transition"),
        target_state: RepairStateIdSchema,
      },
      { additionalProperties: false }
    ),
    budget: Type.Object(
      {
        counter: Type.Literal("iteration"),
        limit_source: Type.Literal("run.max_iterations"),
        reserved_attempts: Type.Union([Type.Literal(0), Type.Literal(1)]),
      },
      { additionalProperties: false }
    ),
    on_exhaustion: Type.Object(
      {
        action: Type.Literal("transition"),
        target_state: RepairStateIdSchema,
        reset_counter: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type RepairRouteV1 = Static<typeof RepairRouteV1Schema>;

export const RepairRoutingV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    routes: Type.Array(RepairRouteV1Schema, { maxItems: 64 }),
  },
  { additionalProperties: false }
);
export type RepairRoutingV1 = Static<typeof RepairRoutingV1Schema>;

export const FeedbackRouteEvidenceV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    origin_state: RepairStateIdSchema,
    feedback_kind: FeedbackKindSchema,
    detail_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    strategy_delta_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    disposition: Type.Union([Type.Literal("repair"), Type.Literal("exhausted")]),
    target_state: RepairStateIdSchema,
    budget: Type.Object(
      {
        counter: Type.Literal("iteration"),
        used_before: Type.Integer({ minimum: 0 }),
        limit: Type.Integer({ minimum: 1 }),
        used_after: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type FeedbackRouteEvidenceV1 = Static<typeof FeedbackRouteEvidenceV1Schema>;

/**
 * W7 — the conditions a run must satisfy before the engine admits a terminal outcome.
 * Research's `write_complete` + `met` semantics are the first consumer.
 */
const CompletionStateIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const CompletionPredicateIdSchema = Type.String({ minLength: 1, maxLength: 128 });

/** W7 v2 — the closed, engine-enforced completion-admission contract. */
export const CompletionGateSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    allowed_terminal_origins: Type.Array(CompletionStateIdSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    required_visited_states: Type.Array(CompletionStateIdSchema, {
      maxItems: 32,
      uniqueItems: true,
    }),
    required_receipt_predicates: Type.Array(CompletionPredicateIdSchema, {
      maxItems: 32,
      uniqueItems: true,
    }),
    latest_product: Type.Union([
      Type.Object(
        {
          selector: Type.Literal("terminal_artifact"),
          schema_id: Type.String({ minLength: 1, maxLength: 128 }),
          product_schema_version: Type.Integer({ minimum: 1 }),
          artifact_kind: Type.String({ minLength: 1, maxLength: 128 }),
          producing_state: CompletionStateIdSchema,
        },
        { additionalProperties: false }
      ),
      Type.Object(
        {
          selector: Type.Literal("terminal_result"),
          schema_id: Type.String({ minLength: 1, maxLength: 128 }),
          product_schema_version: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false }
      ),
    ]),
    unresolved_policy: Type.Union([
      Type.Object({ mode: Type.Literal("allow_any") }, { additionalProperties: false }),
      Type.Object(
        {
          mode: Type.Literal("max_count"),
          max_count: Type.Integer({ minimum: 0, maximum: 128 }),
        },
        { additionalProperties: false }
      ),
    ]),
  },
  { additionalProperties: false }
);
export type CompletionGate = Static<typeof CompletionGateSchema>;

export const CompletionFailureCodeSchema = Type.Union([
  Type.Literal("TERMINAL_ORIGIN_NOT_ALLOWED"),
  Type.Literal("REQUIRED_STATE_NOT_VISITED"),
  Type.Literal("LATEST_PRODUCT_MISSING"),
  Type.Literal("LATEST_PRODUCT_AMBIGUOUS"),
  Type.Literal("LATEST_PRODUCT_MISMATCH"),
  Type.Literal("RECEIPT_PREDICATE_FAILED"),
  Type.Literal("UNRESOLVED_LIMIT_EXCEEDED"),
]);
export type CompletionFailureCode = Static<typeof CompletionFailureCodeSchema>;

export const StateVisitSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    state_id: CompletionStateIdSchema,
    source: Type.Union([
      Type.Literal("create"),
      Type.Literal("transition"),
      Type.Literal("restored_current"),
    ]),
  },
  { additionalProperties: false }
);
export type StateVisit = Static<typeof StateVisitSchema>;

export const StateVisitRefSchema = Type.Object(
  {
    event_sequence: Type.Integer({ minimum: 1 }),
    offset: Type.Integer({ minimum: 0, maximum: 31 }),
    state_id: CompletionStateIdSchema,
    source: StateVisitSchema.properties.source,
  },
  { additionalProperties: false }
);
export type StateVisitRef = Static<typeof StateVisitRefSchema>;

export const CompletionEvidenceRefSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1, maxLength: 128 }),
    reference_id: Type.String({ minLength: 1, maxLength: 256 }),
    sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  },
  { additionalProperties: false }
);
export type CompletionEvidenceRef = Static<typeof CompletionEvidenceRefSchema>;

export const CompletionProductEvidenceSchema = Type.Object(
  {
    selector: Type.Union([Type.Literal("terminal_artifact"), Type.Literal("terminal_result")]),
    schema_id: Type.String({ minLength: 1, maxLength: 128 }),
    product_schema_version: Type.Integer({ minimum: 1 }),
    product_id: Type.String({ minLength: 1, maxLength: 256 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false }
);
export type CompletionProductEvidence = Static<typeof CompletionProductEvidenceSchema>;

export const CompletionAdmissionEnvelopeSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    terminal_envelope_id: Type.String({ pattern: "^tenv_[a-f0-9]{64}$" }),
    run_id: Id,
    gate_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    terminal_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    origin_state: CompletionStateIdSchema,
    state_visit_refs: Type.Array(StateVisitRefSchema, { minItems: 1, maxItems: 512 }),
    latest_product: CompletionProductEvidenceSchema,
    evidence_refs: Type.Array(CompletionEvidenceRefSchema, { maxItems: 128 }),
    unresolved_count: Type.Integer({ minimum: 0, maximum: 128 }),
  },
  { additionalProperties: false }
);
export type CompletionAdmissionEnvelope = Static<typeof CompletionAdmissionEnvelopeSchema>;

export const CompletionRefusalEvidenceSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    attempted_terminal_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    gate_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    origin_state: Type.Union([CompletionStateIdSchema, Type.Null()]),
    failure_codes: Type.Array(CompletionFailureCodeSchema, {
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type CompletionRefusalEvidence = Static<typeof CompletionRefusalEvidenceSchema>;

const SkillContractPortV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    direction: Type.Union([Type.Literal("input"), Type.Literal("output")]),
    transport: Type.Union([Type.Literal("inline_request"), Type.Literal("artifact")]),
    schema_id: SchemaIdSchema,
    schema_version_required: Type.Integer({ minimum: 1 }),
    artifact_kind: Type.Union([ArtifactKind, Type.Null()]),
    source: Type.Union([
      Type.Literal("caller"),
      Type.Literal("prior_skill"),
      Type.Literal("either"),
      Type.Literal("skill"),
    ]),
    min_items: Type.Integer({ minimum: 0 }),
    max_items: Type.Integer({ minimum: 1 }),
    semantic_product: Type.Boolean(),
  },
  { additionalProperties: false }
);

const SkillContractBehaviorV2Schema = Type.Object(
  {
    side_effects: Type.Object(
      {
        external_reads: Type.Union([
          Type.Literal("permitted_within_liveness_and_yaml"),
          Type.Literal("host_policy_only"),
        ]),
        external_mutations: Type.Union([
          Type.Literal("forbidden"),
          Type.Literal("host_approved_only"),
        ]),
        filesystem_writes: Type.Union([
          Type.Literal("forbidden"),
          Type.Literal("compatibility_report_only"),
          Type.Literal("host_policy_only"),
        ]),
        allowed_relative_paths: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          maxItems: 16,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false }
    ),
    approval: Type.Object(
      {
        policy: Type.Union([
          Type.Literal("caller_skill_request"),
          Type.Literal("caller_research_request"),
          Type.Literal("existing_host_gates"),
        ]),
        additional_approval_required: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
    stopping: Type.Object(
      {
        budget_exhaustion: Type.Literal("incomplete"),
        cancellation: Type.Literal("cancelled"),
        blocking_ambiguity: Type.Union([Type.Literal("await_user"), Type.Literal("incomplete")]),
      },
      { additionalProperties: false }
    ),
    escalation: Type.Object(
      {
        out_of_scope_effect: Type.Literal("non_positive"),
        sandbox_prevention_claim: Type.Literal(false),
      },
      { additionalProperties: false }
    ),
    violation_terminal: Type.Literal("incomplete"),
  },
  { additionalProperties: false }
);

const SkillBudgetPolicyBindingV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    policy_id: SchemaIdSchema,
    resolver_id: Type.String({ minLength: 1, maxLength: 128 }),
    admission_id: Type.String({ minLength: 1, maxLength: 128 }),
    snapshot_id: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false }
);

/** P2 — closed, consumed skill contract. V1 declaration-only debt is not accepted. */
export const SkillContractSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    objective: Type.String({ minLength: 1, maxLength: 2_048 }),
    io: Type.Object(
      {
        request: SkillContractPortV1Schema,
        input_ports: Type.Array(SkillContractPortV1Schema, { maxItems: 32 }),
        active_output_ports: Type.Array(SkillContractPortV1Schema, {
          minItems: 1,
          maxItems: 32,
        }),
      },
      { additionalProperties: false }
    ),
    behavior: SkillContractBehaviorV2Schema,
    guidance: Type.Object(
      {
        skill_root: Type.String({ minLength: 1, maxLength: 256 }),
        resolution: Type.Union([Type.Literal("per_agent"), Type.Literal("per_agent_phase")]),
      },
      { additionalProperties: false }
    ),
    budget_policy: SkillBudgetPolicyBindingV1Schema,
    repair_routing: RepairRoutingV1Schema,
    completion_gate: CompletionGateSchema,
  },
  { additionalProperties: false }
);
export type SkillContract = Static<typeof SkillContractSchema>;

export const OrchestrationRequestSchema = Type.Union([
  StartRequestSchema,
  StepRequestSchema,
  StatusRequestSchema,
  RecoverRequestSchema,
  CancelRequestSchema,
  RespondRequestSchema,
]);
export type OrchestrationRequest = Static<typeof OrchestrationRequestSchema>;

function sameRunIdentity(left: RunIdentity, right: RunIdentity): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.run_id === right.run_id &&
    left.session_id === right.session_id &&
    left.playbook === right.playbook &&
    left.engine_owner === right.engine_owner
  );
}

function assertArtifactDispatchPauseV1(pause: ArtifactDispatchPauseV1): void {
  const issues: string[] = [];
  const legacyCompatibility =
    pause.recovery.kind === "saved_but_ineligible" &&
    "legacy_checkpoint_preserved_claim" in pause.recovery;
  if (!sameRunIdentity(pause.identity, pause.recovery.identity)) {
    issues.push("recovery identity must exactly match the paused run identity");
  }
  if (pause.state_id !== pause.recovery.state_id) {
    issues.push("recovery state_id must exactly match the paused state_id");
  }
  if (pause.recovery.kind !== "saved_but_ineligible" && pause.reason !== pause.recovery.reason) {
    issues.push("retryable recovery reason must exactly match the pause reason");
  }
  if (
    !legacyCompatibility &&
    pause.recovery.checkpoint_exists !== pause.recovery.checkpoint_preserved
  ) {
    issues.push("checkpoint_preserved must exactly equal observed checkpoint_exists");
  }
  if (pause.retryable !== (pause.recovery.kind !== "saved_but_ineligible")) {
    issues.push("pause retryable must exactly match recovery eligibility");
  }
  if (pause.code === "LEGACY_UNMETERED") {
    if (
      pause.recovery.kind !== "saved_but_ineligible" ||
      pause.recovery.ineligibility_code !== "LEGACY_UNMETERED"
    ) {
      issues.push("LEGACY_UNMETERED must carry its typed saved-but-ineligible recovery facts");
    }
  } else if ("legacy_checkpoint_preserved_claim" in pause.recovery) {
    if (pause.recovery.ineligibility_code !== "LEGACY_CHECKPOINT_UNVERIFIED") {
      issues.push("historical dispatch pauses must remain typed as checkpoint-unverified");
    }
    if (pause.dispatch.code !== pause.code || pause.dispatch.dispatch_allowed) {
      issues.push("historical dispatch state must retain its fail-closed pause code");
    }
  } else if (pause.dispatch.code !== pause.code || pause.dispatch.dispatch_allowed) {
    issues.push("dispatch pause code must match a fail-closed engine dispatch state");
  }
  if (issues.length > 0) {
    throw new ContractValidationError("artifact dispatch pause", issues);
  }
}

type ArtifactDispatchRecoveryInputV1 = {
  readonly identity: RunIdentity;
  readonly stateId: string;
  readonly reason: string;
  readonly checkpointExists: boolean;
} & (
  | {
      readonly kind: "recoverable_checkpoint" | "start_retry";
      readonly ineligibilityCode?: never;
    }
  | {
      readonly kind: "saved_but_ineligible";
      readonly ineligibilityCode: ArtifactDispatchIneligibilityCode;
    }
);

export function artifactDispatchRecoveryV1(
  input: ArtifactDispatchRecoveryInputV1
): ArtifactDispatchRecoveryV1 {
  if (input.kind === "recoverable_checkpoint") {
    if (!input.checkpointExists) {
      throw new ContractValidationError("artifact dispatch recovery", [
        "recoverable_checkpoint requires an observed checkpoint",
      ]);
    }
    return validateContract(
      ArtifactDispatchRecoveryV1Schema,
      {
        schema_version: 1,
        kind: input.kind,
        action: "recover",
        identity: input.identity,
        state_id: input.stateId,
        reason: input.reason,
        checkpoint_exists: true,
        checkpoint_preserved: true,
        resumable: true,
        requires_dispatch_mode: "active",
      },
      "artifact dispatch recovery"
    );
  }
  if (input.kind === "saved_but_ineligible") {
    if (!input.checkpointExists) {
      throw new ContractValidationError("artifact dispatch recovery", [
        "saved_but_ineligible requires an observed checkpoint",
      ]);
    }
    if (input.ineligibilityCode === "LEGACY_CHECKPOINT_UNVERIFIED") {
      throw new ContractValidationError("artifact dispatch recovery", [
        "legacy checkpoint compatibility cannot be emitted as current observed storage facts",
      ]);
    }
    return validateContract(
      ArtifactDispatchRecoveryV1Schema,
      {
        schema_version: 1,
        kind: input.kind,
        action: "status_or_cancel",
        ineligibility_code: input.ineligibilityCode,
        identity: input.identity,
        state_id: input.stateId,
        reason: input.reason,
        checkpoint_exists: true,
        checkpoint_preserved: true,
        resumable: false,
        requires_dispatch_mode: null,
      },
      "artifact dispatch recovery"
    );
  }
  return validateContract(
    ArtifactDispatchRecoveryV1Schema,
    {
      schema_version: 1,
      kind: input.kind,
      action: "retry_start",
      identity: input.identity,
      state_id: input.stateId,
      reason: input.reason,
      checkpoint_exists: input.checkpointExists,
      checkpoint_preserved: input.checkpointExists,
      resumable: false,
      requires_dispatch_mode: "active",
    },
    "artifact dispatch recovery"
  );
}

function dispatchStateFromLegacyPause(pause: LegacyPausedDirectiveV2): ArtifactDispatchStateV1 {
  if (pause.code === "DISPATCH_PAUSED") {
    return {
      schema_version: 1,
      mode: "paused",
      configured_as: "paused",
      code: "DISPATCH_PAUSED",
      reason: pause.reason,
      dispatch_allowed: false,
    };
  }
  if (pause.code === "DISPATCH_MODE_INVALID") {
    return {
      schema_version: 1,
      mode: "paused",
      configured_as: "invalid",
      code: "DISPATCH_MODE_INVALID",
      reason: pause.reason,
      dispatch_allowed: false,
    };
  }
  // The historical engine emitted LEGACY_UNMETERED only after its active-mode gate.
  return {
    schema_version: 1,
    mode: "active",
    configured_as: "active",
    code: "DISPATCH_ACTIVE",
    reason: "artifact dispatch is active",
    dispatch_allowed: true,
  };
}

/** Parse current pause facts or project the immutable historical v2 pause shape. */
export function parseArtifactDispatchPause(value: unknown): ArtifactDispatchPauseV1 {
  const parsed = validateContract(PausedDirectiveSchema, value, "artifact dispatch pause");
  if ("pause_schema_version" in parsed) {
    assertArtifactDispatchPauseV1(parsed);
    return parsed;
  }
  if (parsed.recovery.run_id !== parsed.identity.run_id) {
    throw new ContractValidationError("legacy artifact dispatch pause", [
      "recovery run_id must exactly match the paused run identity",
    ]);
  }
  const recovery = validateContract(
    ArtifactDispatchRecoveryV1Schema,
    {
      schema_version: 1,
      kind: "saved_but_ineligible",
      action: "status_or_cancel",
      ineligibility_code:
        parsed.code === "LEGACY_UNMETERED" ? "LEGACY_UNMETERED" : "LEGACY_CHECKPOINT_UNVERIFIED",
      identity: parsed.identity,
      state_id: parsed.state_id,
      reason:
        "Historical pause metadata cannot verify current checkpoint existence or resumability.",
      checkpoint_exists: null,
      checkpoint_preserved: null,
      legacy_checkpoint_preserved_claim: parsed.recovery.checkpoint_preserved,
      resumable: false,
      requires_dispatch_mode: null,
    },
    "legacy artifact dispatch recovery"
  );
  const normalized: ArtifactDispatchPauseV1 = {
    schema_version: 2,
    pause_schema_version: 1,
    action: "paused",
    identity: parsed.identity,
    status: parsed.status,
    state_id: parsed.state_id,
    code: parsed.code,
    reason: parsed.reason,
    retryable: false,
    dispatch: dispatchStateFromLegacyPause(parsed),
    recovery,
  };
  assertArtifactDispatchPauseV1(normalized);
  return normalized;
}

export function validateDirective(value: unknown): Directive {
  const parsed = validateContract(DirectiveSchema, value, "directive");
  if (parsed.action === "paused" && "pause_schema_version" in parsed) {
    assertArtifactDispatchPauseV1(parsed);
  }
  if (parsed.action === "invoke_agent") {
    const purpose = parsed.execution_purpose ?? "phase";
    const hasBinding = parsed.routing_repair_binding !== undefined;
    if (
      (purpose === "routing_repair") !== hasBinding ||
      (purpose === "routing_repair" && parsed.output_artifact.kind !== "routing-metadata")
    ) {
      throw new ContractValidationError("routing repair directive", [
        "routing_repair requires its exact binding and routing-metadata output",
      ]);
    }
  }
  if (parsed.action === "invoke_agents_parallel") {
    for (const branch of parsed.branches) {
      const purpose = branch.execution_purpose ?? "phase";
      const hasBinding = branch.routing_repair_binding !== undefined;
      if (
        (purpose === "routing_repair") !== hasBinding ||
        (purpose === "routing_repair" && branch.output_artifact.kind !== "routing-metadata")
      ) {
        throw new ContractValidationError("routing repair branch directive", [
          "routing_repair requires its exact binding and routing-metadata output",
        ]);
      }
    }
  }
  if (
    parsed.action === "complete" ||
    parsed.action === "incomplete" ||
    parsed.action === "error" ||
    parsed.action === "cancelled"
  ) {
    const expected = {
      complete: { status: "complete", met: true },
      incomplete: { status: "incomplete", met: false },
      error: { status: "error", met: false },
      cancelled: { status: "cancelled", met: false },
    } as const;
    const truth = expected[parsed.action];
    if (parsed.status !== truth.status || parsed.met !== truth.met) {
      throw new ContractValidationError("directive terminal truth", [
        `${parsed.action} requires status=${truth.status} and met=${truth.met}`,
      ]);
    }
  }
  return parsed;
}

export class ContractValidationError extends Error {
  readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super(`${label} failed schema validation: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function validateContract<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  value: unknown,
  label: string
): Static<TSchemaValue> {
  if (Value.Check(schema, value)) {
    return value as Static<TSchemaValue>;
  }
  const issues = [...Value.Errors(schema, value)].map(
    (issue) => `${issue.instancePath || "/"}: ${issue.message}`
  );
  throw new ContractValidationError(label, issues);
}

export function isTerminalStatus(status: RunStatus): boolean {
  return ["complete", "incomplete", "error", "cancelled"].includes(status);
}
