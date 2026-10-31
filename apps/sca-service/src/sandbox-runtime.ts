import path from "node:path";

import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  ScaStrongerExecutionAuthorizationV1Schema,
  validateScaStrongerExecutionAuthorizationV1,
} from "../../orchestration/dist/sca/human-authorization.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
} from "../../orchestration/dist/skill-contracts/common.js";
import { ScaProcessResultV1Schema, type ScaProcessResultV1 } from "./process.js";

const MAX_TEXT = 8_192;
const MAX_ARGS = 256;
const MAX_CAPABILITIES = 64;

export const SCA_SANDBOX_PROFILE_INPUT_SCHEMA = "penny.sca-sandbox-profile-input.v1";
export const SCA_SANDBOX_PROFILE_SCHEMA = "penny.sca-sandbox-profile.v1";
export const SCA_EVIDENCE_EXECUTION_REQUEST_SCHEMA = "penny.sca-evidence-execution-request.v1";
export const SCA_EVIDENCE_EXECUTION_RECEIPT_SCHEMA = "penny.sca-evidence-execution-receipt.v1";

const ActionTypeSchema = Type.Union([
  Type.Literal("build"),
  Type.Literal("test"),
  Type.Literal("harness"),
  Type.Literal("proof_of_concept"),
]);

const EnvironmentEntrySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Z][A-Z0-9_]*$" }),
    value: Type.String({ maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

const CommandTemplateSchema = Type.Object(
  {
    tool_id: OpaqueIdSchema,
    action_type: ActionTypeSchema,
    fixed_arguments: Type.Array(Type.String({ maxLength: MAX_TEXT }), { maxItems: MAX_ARGS }),
    max_extra_arguments: Type.Integer({ minimum: 0, maximum: MAX_ARGS }),
    allowed_environment_names: Type.Array(
      Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Z][A-Z0-9_]*$" }),
      { maxItems: 64 }
    ),
  },
  { additionalProperties: false }
);

export const ScaSandboxProfileInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SANDBOX_PROFILE_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    profile_id: OpaqueIdSchema,
    isolation_backend: Type.Literal("container"),
    read_only_source: Type.Literal(true),
    read_only_root_filesystem: Type.Literal(true),
    no_new_privileges: Type.Literal(true),
    network_policy: Type.Union([
      Type.Literal("none"),
      Type.Literal("loopback_only"),
      Type.Literal("fixed_destinations"),
    ]),
    fixed_network_destinations: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      maxItems: 64,
    }),
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1,
      maxItems: MAX_CAPABILITIES,
    }),
    runtime_executable: Type.String({ minLength: 1, maxLength: 4_096 }),
    runtime_executable_sha256: Sha256Schema,
    runtime_identity_sha256: Sha256Schema,
    command_templates: Type.Array(CommandTemplateSchema, { minItems: 1, maxItems: 64 }),
    limits: Type.Object(
      {
        max_timeout_ms: Type.Integer({ minimum: 1, maximum: 21_600_000 }),
        max_stdout_bytes: Type.Integer({ minimum: 1, maximum: 268_435_456 }),
        max_stderr_bytes: Type.Integer({ minimum: 1, maximum: 268_435_456 }),
        max_memory_bytes: Type.Integer({ minimum: 1, maximum: 274_877_906_944 }),
        max_cpu_millis: Type.Integer({ minimum: 1, maximum: 21_600_000 }),
        max_processes: Type.Integer({ minimum: 1, maximum: 4_096 }),
      },
      { additionalProperties: false }
    ),
    qualification_suite_sha256: Sha256Schema,
    qualification_evidence_sha256: Sha256Schema,
    qualification_status: Type.Literal("passed"),
  },
  { additionalProperties: false }
);

export const ScaSandboxProfileV1Schema = Type.Object(
  {
    ...ScaSandboxProfileInputV1Schema.properties,
    profile_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaEvidenceExecutionRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_EVIDENCE_EXECUTION_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    execution_id: OpaqueIdSchema,
    source_root: Type.String({ minLength: 1, maxLength: 4_096 }),
    source_snapshot_sha256: Sha256Schema,
    authorization: ScaStrongerExecutionAuthorizationV1Schema,
    sandbox_profile: ScaSandboxProfileV1Schema,
    tool_id: OpaqueIdSchema,
    arguments: Type.Array(Type.String({ maxLength: MAX_TEXT }), { maxItems: MAX_ARGS }),
    environment: Type.Array(EnvironmentEntrySchema, { maxItems: 64 }),
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1,
      maxItems: MAX_CAPABILITIES,
    }),
    timeout_ms: Type.Integer({ minimum: 1, maximum: 21_600_000 }),
    max_stdout_bytes: Type.Integer({ minimum: 1, maximum: 268_435_456 }),
    max_stderr_bytes: Type.Integer({ minimum: 1, maximum: 268_435_456 }),
  },
  { additionalProperties: false }
);

export const ScaEvidenceExecutionReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_EVIDENCE_EXECUTION_RECEIPT_SCHEMA),
    schema_version: Type.Literal(1),
    execution_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    authorization_id: Type.String({ pattern: "^scaauth_[a-f0-9]{64}$" }),
    sandbox_profile_sha256: Sha256Schema,
    tool_id: OpaqueIdSchema,
    action_type: ActionTypeSchema,
    action_plan_sha256: Sha256Schema,
    started_at: Rfc3339UtcSchema,
    completed_at: Rfc3339UtcSchema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("cancelled"),
      Type.Literal("output_limit"),
      Type.Literal("unavailable"),
    ]),
    exit_code: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
    stdout: Type.String(),
    stderr: Type.String(),
    stdout_sha256: Sha256Schema,
    stderr_sha256: Sha256Schema,
    truncated: Type.Boolean(),
    executor_receipt_sha256: Type.Union([Sha256Schema, Type.Null()]),
    failure_code: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    evidence_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaSandboxProfileInputV1 = Static<typeof ScaSandboxProfileInputV1Schema>;
export type ScaSandboxProfileV1 = Static<typeof ScaSandboxProfileV1Schema>;
export type ScaEvidenceExecutionRequestV1 = Static<typeof ScaEvidenceExecutionRequestV1Schema>;
export type ScaEvidenceExecutionReceiptV1 = Static<typeof ScaEvidenceExecutionReceiptV1Schema>;
type UnsignedProfile = Omit<ScaSandboxProfileV1, "profile_sha256">;
type UnsignedReceipt = Omit<ScaEvidenceExecutionReceiptV1, "evidence_sha256">;

export interface ScaSandboxExecutionSpecV1 {
  readonly executable: string;
  readonly executable_sha256: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: readonly { readonly name: string; readonly value: string }[];
  readonly timeout_ms: number;
  readonly max_stdout_bytes: number;
  readonly max_stderr_bytes: number;
  readonly sandbox_profile_sha256: string;
  readonly source_mount: "read_only";
  readonly root_filesystem: "read_only";
  readonly network_policy: ScaSandboxProfileV1["network_policy"];
  readonly fixed_network_destinations: readonly string[];
  readonly max_memory_bytes: number;
  readonly max_cpu_millis: number;
  readonly max_processes: number;
}

export interface ScaSandboxExecutorV1 {
  execute(
    spec: ScaSandboxExecutionSpecV1,
    signal?: AbortSignal
  ): Promise<{
    readonly process_result: ScaProcessResultV1;
    readonly executor_receipt_sha256: string;
  }>;
}

export interface ScaEvidenceExecutionOptionsV1 {
  readonly executor?: ScaSandboxExecutorV1;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export class ScaSandboxRuntimeError extends Error {
  constructor(
    readonly code:
      | "invalid_profile"
      | "profile_digest_mismatch"
      | "qualification_invalid"
      | "invalid_request"
      | "authorization_invalid"
      | "authorization_expired"
      | "binding_mismatch"
      | "tool_not_allowed"
      | "capability_denied"
      | "limit_exceeded",
    message: string
  ) {
    super(message);
    this.name = "ScaSandboxRuntimeError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function uniqueSorted(values: readonly string[], code: ScaSandboxRuntimeError["code"]): string[] {
  if (new Set(values).size !== values.length) {
    throw new ScaSandboxRuntimeError(code, "SCA sandbox values must be unique");
  }
  return [...values].sort(compareUtf8);
}

function profileDigest(value: UnsignedProfile): string {
  return sha256(canonicalJson(value));
}

function receiptDigest(value: UnsignedReceipt): string {
  return sha256(canonicalJson(value));
}

export function buildScaSandboxProfileV1(value: unknown): ScaSandboxProfileV1 {
  let input: ScaSandboxProfileInputV1;
  try {
    input = validateContract(ScaSandboxProfileInputV1Schema, value, "SCA sandbox profile input");
  } catch (error) {
    throw new ScaSandboxRuntimeError(
      "invalid_profile",
      error instanceof Error ? error.message : "SCA sandbox profile is invalid"
    );
  }
  if (!path.isAbsolute(input.runtime_executable)) {
    throw new ScaSandboxRuntimeError(
      "qualification_invalid",
      "SCA sandbox runtime executable must be absolute"
    );
  }
  const toolIds = input.command_templates.map((template) => template.tool_id);
  uniqueSorted(toolIds, "qualification_invalid");
  const capabilities = uniqueSorted(input.capabilities, "qualification_invalid");
  const destinations = uniqueSorted(input.fixed_network_destinations, "qualification_invalid");
  if (
    (input.network_policy === "fixed_destinations") !== destinations.length > 0 ||
    input.command_templates.some(
      (template) =>
        new Set(template.allowed_environment_names).size !==
        template.allowed_environment_names.length
    )
  ) {
    throw new ScaSandboxRuntimeError(
      "qualification_invalid",
      "SCA sandbox network or command-template qualification is inconsistent"
    );
  }
  const unsigned: UnsignedProfile = {
    ...input,
    capabilities,
    fixed_network_destinations: destinations,
    command_templates: [...input.command_templates].sort((left, right) =>
      compareUtf8(left.tool_id, right.tool_id)
    ),
  };
  return validateContract(
    ScaSandboxProfileV1Schema,
    { ...unsigned, profile_sha256: profileDigest(unsigned) },
    "SCA sandbox profile"
  );
}

export function validateScaSandboxProfileV1(value: unknown): ScaSandboxProfileV1 {
  const profile = validateContract(ScaSandboxProfileV1Schema, value, "SCA sandbox profile");
  const { profile_sha256: observedDigest, ...unsigned } = profile;
  if (profileDigest(unsigned) !== observedDigest) {
    throw new ScaSandboxRuntimeError(
      "profile_digest_mismatch",
      "SCA sandbox profile digest mismatch"
    );
  }
  return profile;
}

export function scaEvidenceActionPlanSha256(value: {
  readonly source_snapshot_sha256: string;
  readonly sandbox_profile_sha256: string;
  readonly tool_id: string;
  readonly action_type: "build" | "test" | "harness" | "proof_of_concept";
  readonly arguments: readonly string[];
  readonly environment: readonly { readonly name: string; readonly value: string }[];
  readonly capabilities: readonly string[];
  readonly timeout_ms: number;
  readonly max_stdout_bytes: number;
  readonly max_stderr_bytes: number;
}): string {
  return sha256(
    canonicalJson({
      ...value,
      environment: [...value.environment].sort((left, right) => compareUtf8(left.name, right.name)),
      capabilities: [...value.capabilities].sort(compareUtf8),
    })
  );
}

function processStatus(
  value: ScaProcessResultV1["status"]
): ScaEvidenceExecutionReceiptV1["status"] {
  if (value === "succeeded") return "succeeded";
  if (value === "timed_out") return "timed_out";
  if (value === "cancelled") return "cancelled";
  if (value === "output_limit") return "output_limit";
  return "failed";
}

function unavailableReceipt(
  request: ScaEvidenceExecutionRequestV1,
  profile: ScaSandboxProfileV1,
  actionType: ScaEvidenceExecutionReceiptV1["action_type"],
  actionPlanSha256: string,
  now: string
): ScaEvidenceExecutionReceiptV1 {
  const empty = sha256("");
  const unsigned: UnsignedReceipt = {
    schema_id: SCA_EVIDENCE_EXECUTION_RECEIPT_SCHEMA,
    schema_version: 1,
    execution_id: request.execution_id,
    run_id: request.authorization.run_id,
    source_snapshot_sha256: request.source_snapshot_sha256,
    authorization_id: request.authorization.authorization_id,
    sandbox_profile_sha256: profile.profile_sha256,
    tool_id: request.tool_id,
    action_type: actionType,
    action_plan_sha256: actionPlanSha256,
    started_at: now,
    completed_at: now,
    status: "unavailable",
    exit_code: null,
    stdout: "",
    stderr: "",
    stdout_sha256: empty,
    stderr_sha256: empty,
    truncated: false,
    executor_receipt_sha256: null,
    failure_code: "qualified_executor_unavailable",
  };
  return validateContract(
    ScaEvidenceExecutionReceiptV1Schema,
    { ...unsigned, evidence_sha256: receiptDigest(unsigned) },
    "SCA evidence execution receipt"
  );
}

export async function executeScaEvidenceV1(
  value: unknown,
  options: ScaEvidenceExecutionOptionsV1 = {}
): Promise<ScaEvidenceExecutionReceiptV1> {
  let request: ScaEvidenceExecutionRequestV1;
  try {
    request = validateContract(
      ScaEvidenceExecutionRequestV1Schema,
      value,
      "SCA evidence execution request"
    );
  } catch (error) {
    throw new ScaSandboxRuntimeError(
      "invalid_request",
      error instanceof Error ? error.message : "SCA evidence execution request is invalid"
    );
  }
  const profile = validateScaSandboxProfileV1(request.sandbox_profile);
  let authorization;
  try {
    authorization = validateScaStrongerExecutionAuthorizationV1(request.authorization);
  } catch (error) {
    throw new ScaSandboxRuntimeError(
      "authorization_invalid",
      error instanceof Error ? error.message : "SCA execution authorization is invalid"
    );
  }
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new ScaSandboxRuntimeError("invalid_request", "SCA evidence execution clock is invalid");
  }
  if (now.getTime() > Date.parse(authorization.expires_at)) {
    throw new ScaSandboxRuntimeError(
      "authorization_expired",
      "SCA evidence execution authorization expired"
    );
  }
  if (
    !path.isAbsolute(request.source_root) ||
    request.source_snapshot_sha256 !== authorization.source_snapshot_sha256
  ) {
    throw new ScaSandboxRuntimeError(
      "binding_mismatch",
      "SCA evidence execution source or authorization binding differs"
    );
  }
  const template = profile.command_templates.find((entry) => entry.tool_id === request.tool_id);
  if (template === undefined || template.action_type !== authorization.action_type) {
    throw new ScaSandboxRuntimeError(
      "tool_not_allowed",
      "SCA evidence tool is not qualified for the authorized action"
    );
  }
  if (request.arguments.length > template.max_extra_arguments) {
    throw new ScaSandboxRuntimeError("limit_exceeded", "SCA evidence argument limit exceeded");
  }
  const environmentNames = request.environment.map((entry) => entry.name);
  if (
    new Set(environmentNames).size !== environmentNames.length ||
    environmentNames.some((name) => !template.allowed_environment_names.includes(name))
  ) {
    throw new ScaSandboxRuntimeError(
      "capability_denied",
      "SCA evidence environment is not allowed"
    );
  }
  const capabilities = uniqueSorted(request.capabilities, "capability_denied");
  if (
    canonicalJson(capabilities) !== canonicalJson(authorization.authorized_capabilities) ||
    capabilities.some((capability) => !profile.capabilities.includes(capability))
  ) {
    throw new ScaSandboxRuntimeError(
      "capability_denied",
      "SCA evidence capabilities differ from authorization or qualification"
    );
  }
  if (
    request.timeout_ms > profile.limits.max_timeout_ms ||
    request.max_stdout_bytes > profile.limits.max_stdout_bytes ||
    request.max_stderr_bytes > profile.limits.max_stderr_bytes
  ) {
    throw new ScaSandboxRuntimeError("limit_exceeded", "SCA evidence resource limit exceeded");
  }
  const actionPlanSha256 = scaEvidenceActionPlanSha256({
    source_snapshot_sha256: request.source_snapshot_sha256,
    sandbox_profile_sha256: profile.profile_sha256,
    tool_id: request.tool_id,
    action_type: template.action_type,
    arguments: request.arguments,
    environment: request.environment,
    capabilities,
    timeout_ms: request.timeout_ms,
    max_stdout_bytes: request.max_stdout_bytes,
    max_stderr_bytes: request.max_stderr_bytes,
  });
  if (actionPlanSha256 !== authorization.action_plan_sha256) {
    throw new ScaSandboxRuntimeError(
      "binding_mismatch",
      "SCA evidence request differs from the human-approved action plan"
    );
  }
  const startedAt = now.toISOString();
  if (options.executor === undefined) {
    return unavailableReceipt(request, profile, template.action_type, actionPlanSha256, startedAt);
  }
  const execution = await options.executor.execute(
    {
      executable: profile.runtime_executable,
      executable_sha256: profile.runtime_executable_sha256,
      arguments: [...template.fixed_arguments, ...request.arguments],
      cwd: request.source_root,
      environment: request.environment,
      timeout_ms: request.timeout_ms,
      max_stdout_bytes: request.max_stdout_bytes,
      max_stderr_bytes: request.max_stderr_bytes,
      sandbox_profile_sha256: profile.profile_sha256,
      source_mount: "read_only",
      root_filesystem: "read_only",
      network_policy: profile.network_policy,
      fixed_network_destinations: profile.fixed_network_destinations,
      max_memory_bytes: profile.limits.max_memory_bytes,
      max_cpu_millis: profile.limits.max_cpu_millis,
      max_processes: profile.limits.max_processes,
    },
    options.signal
  );
  const processResult = validateContract(
    ScaProcessResultV1Schema,
    execution.process_result,
    "SCA sandbox process result"
  );
  const completed = options.now?.() ?? new Date();
  if (!Number.isFinite(completed.getTime())) {
    throw new ScaSandboxRuntimeError("invalid_request", "SCA evidence completion clock is invalid");
  }
  const status = processStatus(processResult.status);
  const unsigned: UnsignedReceipt = {
    schema_id: SCA_EVIDENCE_EXECUTION_RECEIPT_SCHEMA,
    schema_version: 1,
    execution_id: request.execution_id,
    run_id: authorization.run_id,
    source_snapshot_sha256: request.source_snapshot_sha256,
    authorization_id: authorization.authorization_id,
    sandbox_profile_sha256: profile.profile_sha256,
    tool_id: request.tool_id,
    action_type: template.action_type,
    action_plan_sha256: actionPlanSha256,
    started_at: startedAt,
    completed_at: completed.toISOString(),
    status,
    exit_code: processResult.exit_code,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    stdout_sha256: processResult.stdout_sha256,
    stderr_sha256: processResult.stderr_sha256,
    truncated: processResult.stdout_truncated || processResult.stderr_truncated,
    executor_receipt_sha256: execution.executor_receipt_sha256,
    failure_code: status === "succeeded" ? null : processResult.failure_code,
  };
  return validateContract(
    ScaEvidenceExecutionReceiptV1Schema,
    { ...unsigned, evidence_sha256: receiptDigest(unsigned) },
    "SCA evidence execution receipt"
  );
}

export function validateScaEvidenceExecutionReceiptV1(
  value: unknown
): ScaEvidenceExecutionReceiptV1 {
  const receipt = validateContract(
    ScaEvidenceExecutionReceiptV1Schema,
    value,
    "SCA evidence execution receipt"
  );
  const { evidence_sha256: observedDigest, ...unsigned } = receipt;
  if (receiptDigest(unsigned) !== observedDigest) {
    throw new ScaSandboxRuntimeError(
      "binding_mismatch",
      "SCA evidence execution receipt digest mismatch"
    );
  }
  return receipt;
}
