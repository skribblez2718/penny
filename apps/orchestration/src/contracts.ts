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

export const ExecutionReceiptSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    receipt_id: Id,
    run_id: Id,
    state_id: Id,
    agent: Id,
    attempt: Type.Integer({ minimum: 1 }),
    worker_id: Id,
    started_at: IsoTimestamp,
    ended_at: IsoTimestamp,
    exit_code: Type.Integer(),
    output_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
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
    output_artifact: Type.Optional(ArtifactRefSchema),
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
    input_artifacts: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
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
    input_artifacts: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
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
  StatusDirectiveSchema,
]);
export type Directive = Static<typeof DirectiveSchema>;

export const OrchestrationRequestSchema = Type.Union([
  StartRequestSchema,
  StepRequestSchema,
  StatusRequestSchema,
  RecoverRequestSchema,
  CancelRequestSchema,
  RespondRequestSchema,
]);
export type OrchestrationRequest = Static<typeof OrchestrationRequestSchema>;

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
