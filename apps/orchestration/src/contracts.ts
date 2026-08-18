import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const ID_MAX_LENGTH = 256;
const TEXT_MAX_LENGTH = 32_768;
const ERROR_MAX_LENGTH = 4_096;
const MAX_BRANCHES = 64;

const Id = Type.String({ minLength: 1, maxLength: ID_MAX_LENGTH });
const BoundedText = Type.String({ maxLength: TEXT_MAX_LENGTH });
const IsoTimestamp = Type.String({ minLength: 20, maxLength: 40 });

export const ConfidenceSchema = Type.Union([
  Type.Literal("CERTAIN"),
  Type.Literal("PROBABLE"),
  Type.Literal("POSSIBLE"),
  Type.Literal("UNCERTAIN"),
]);
export type Confidence = Static<typeof ConfidenceSchema>;

export const EngineOwnerSchema = Type.Union([Type.Literal("python"), Type.Literal("typescript")]);
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

export const ArtifactRefSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
    run_id: Id,
    phase: Id,
    branch_id: Type.Union([Id, Type.Null()]),
    kind: Id,
    operation_id: Id,
    version: Type.Integer({ minimum: 1 }),
    producer: Id,
    media_type: Id,
    byte_length: Type.Integer({ minimum: 0 }),
    content_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    store_ref: Type.String({ pattern: "^artifact://sha256/[a-f0-9]{64}$" }),
    consumer_scope: Type.Array(Id, { maxItems: 128, uniqueItems: true }),
  },
  { additionalProperties: false }
);
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

export const InputArtifactBindingSchema = Type.Object(
  {
    slot: Id,
    ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);

export const InputArtifactsSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: Id,
    consumer: Id,
    artifacts: Type.Array(InputArtifactBindingSchema, { maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type InputArtifacts = Static<typeof InputArtifactsSchema>;

export const OutputArtifactMetadataSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: Id,
    phase: Id,
    branch_id: Type.Union([Id, Type.Null()]),
    kind: Type.Literal("agent-output"),
    operation_id: Id,
    version: Type.Integer({ minimum: 1 }),
    producer: Id,
    consumer_scope: Type.Array(Id, { minItems: 1, maxItems: 128, uniqueItems: true }),
    media_type: Id,
    parent_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    upstream_refs: Type.Array(ArtifactRefSchema, { maxItems: 128, uniqueItems: true }),
  },
  { additionalProperties: false }
);
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
  },
  { additionalProperties: false }
);
export type StartRequest = Static<typeof StartRequestSchema>;

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

export const UserGateDirectiveSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("await_user"),
    identity: RunIdentitySchema,
    state_id: Id,
    gate_id: Id,
    challenge: Id,
    payload_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
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

export const PausedDirectiveSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("paused"),
    identity: RunIdentitySchema,
    status: Type.Literal("running"),
    state_id: Id,
    code: Type.String({ pattern: "^(DISPATCH_PAUSED|DISPATCH_MODE_INVALID)$" }),
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

export const StatusDirectiveSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    action: Type.Literal("status"),
    identity: RunIdentitySchema,
    status: RunStatusSchema,
    state_id: Id,
    terminal: Type.Boolean(),
    met: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const DirectiveSchema = Type.Union([
  InvokeAgentDirectiveSchema,
  InvokeParallelDirectiveSchema,
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
  /** Worker output was structurally invalid -> reissue the assignment. */
  Type.Literal("malformed_result"),
]);
export type FeedbackKind = Static<typeof FeedbackKindSchema>;

export const EvaluationResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: FeedbackKindSchema,
    detail: Type.String({ maxLength: 4_096 }),
    target_state: Type.Optional(Type.String({ maxLength: 128 })),
    exhausted: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type EvaluationResult = Static<typeof EvaluationResultSchema>;

/**
 * W7 — the conditions a run must satisfy before the engine admits a terminal outcome.
 * Research's `write_complete` + `met` semantics are the first consumer.
 */
export const CompletionGateSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    /** Receipt kinds that must exist before terminal. */
    required_receipts: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 32 }),
    /** States the run must have passed through before terminal. */
    required_states: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 32 }),
    /**
     * Maximum unresolved items permitted for a `met: true` terminal.
     *
     * Optional, and **absent means not enforced**. Research deliberately converts an
     * exhausted critique budget into a warning rather than a blocker, so a met research
     * run can legitimately carry unresolved items; forcing an allowance of 0 on it would
     * change behaviour, which this stage forbids. A stricter skill declares a number.
     */
    unresolved_allowance: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);
export type CompletionGate = Static<typeof CompletionGateSchema>;

/**
 * W3 — the universal skill contract.
 *
 * Extracted from research, which is expressed as the reference instance. A playbook
 * declares what it accepts, produces, must not violate, and how its workers are
 * resourced; the engine enforces. The model never supplies any of it.
 */
export const SkillContractSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    objective: Type.String({ minLength: 1, maxLength: 2_048 }),
    /** Artifact kinds consumed. */
    accepts: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 }),
    /** Artifact kinds produced. */
    produces: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 }),
    /** Statements that must hold for every run of this skill. */
    invariants: Type.Array(Type.String({ maxLength: 1_024 }), { maxItems: 32 }),
    authority: Type.Object(
      {
        trust_profiles: Type.Array(TrustProfileSchema, { minItems: 1, maxItems: 8 }),
      },
      { additionalProperties: false }
    ),
    guidance: Type.Object(
      {
        /** Domain-guidance root, relative to the project root. */
        skill_root: Type.String({ minLength: 1, maxLength: 256 }),
        /**
         * `per_agent` -> `<agent>.md` (research today).
         * `per_agent_phase` -> `<agent>-<phase>.md`, required by the knowledge-base
         * prompt shape in agents-md-research §4.6.
         */
        resolution: Type.Union([Type.Literal("per_agent"), Type.Literal("per_agent_phase")]),
      },
      { additionalProperties: false }
    ),
    feedback_kinds: Type.Array(FeedbackKindSchema, { maxItems: 8 }),
    /**
     * Declarative only in the Foundation stage: records the budget knob names and
     * current defaults this skill accepts. Runtime budget ownership does not move here
     * -- that is W4, deferred to workstream 3, which is why the `research-mode-presets`
     * compatibility loan stays open.
     */
    budgets: Type.Record(Type.String({ maxLength: 128 }), Type.Integer()),
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

export function validateDirective(value: unknown): Directive {
  const parsed = validateContract(DirectiveSchema, value, "directive");
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
