import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Type, type Static } from "typebox";

import { validateContract } from "../../../orchestration/src/contracts.js";
import { Sha256Schema } from "../../../orchestration/src/skill-contracts/common.js";
import { runBoundedScaProcess, type ScaProcessResultV1 } from "../process.js";

const MAX_PATH_BYTES = 4_096;
const MAX_VERSION_BYTES = 256;
const MAX_FIXED_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4_096;

export const SCA_SEMGREP_REQUEST_SCHEMA = "penny.sca-semgrep-request.v1";
export const SCA_SEMGREP_RESULT_SCHEMA = "penny.sca-semgrep-result.v1";

const ScaSemgrepRuntimeV1Schema = Type.Union([
  Type.Object(
    {
      state: Type.Literal("available"),
      executable: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
      executable_sha256: Sha256Schema,
      fixed_arguments: Type.Array(Type.String({ maxLength: MAX_ARGUMENT_BYTES }), {
        maxItems: MAX_FIXED_ARGUMENTS,
      }),
      tool_version: Type.String({ minLength: 1, maxLength: MAX_VERSION_BYTES }),
      runtime_identity: Type.String({ minLength: 1, maxLength: MAX_VERSION_BYTES }),
      runtime_sha256: Sha256Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      state: Type.Literal("unavailable"),
      reason: Type.Union([
        Type.Literal("missing_runtime"),
        Type.Literal("unqualified_runtime"),
        Type.Literal("unsupported_platform"),
      ]),
    },
    { additionalProperties: false }
  ),
]);

export const ScaSemgrepRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SEMGREP_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    source_root: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    rule_config: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    rule_config_sha256: Sha256Schema,
    runtime: ScaSemgrepRuntimeV1Schema,
    timeout_ms: Type.Integer({ minimum: 1, maximum: 5_400_000 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: 268_435_456 }),
  },
  { additionalProperties: false }
);

const ScaSemgrepStatusV1Schema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("findings"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
  Type.Literal("cancelled"),
  Type.Literal("output_limit"),
  Type.Literal("unavailable"),
]);

export const ScaSemgrepResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SEMGREP_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    rule_config_sha256: Sha256Schema,
    status: ScaSemgrepStatusV1Schema,
    tool_version: Type.Union([
      Type.String({ minLength: 1, maxLength: MAX_VERSION_BYTES }),
      Type.Null(),
    ]),
    runtime_identity: Type.Union([
      Type.String({ minLength: 1, maxLength: MAX_VERSION_BYTES }),
      Type.Null(),
    ]),
    runtime_sha256: Type.Union([Sha256Schema, Type.Null()]),
    invocation_sha256: Type.Union([Sha256Schema, Type.Null()]),
    exit_code: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
    finding_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    engine_error_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    raw_stdout: Type.String(),
    raw_stderr: Type.String(),
    raw_stdout_sha256: Sha256Schema,
    raw_stderr_sha256: Sha256Schema,
    truncated: Type.Boolean(),
    error_code: Type.Union([
      Type.Literal("none"),
      Type.Literal("service_unavailable"),
      Type.Literal("scanner_failed"),
      Type.Literal("invalid_output"),
      Type.Literal("timeout"),
      Type.Literal("cancelled"),
      Type.Literal("output_limit"),
      Type.Literal("rule_config_drift"),
    ]),
  },
  { additionalProperties: false }
);

export type ScaSemgrepRequestV1 = Static<typeof ScaSemgrepRequestV1Schema>;
export type ScaSemgrepResultV1 = Static<typeof ScaSemgrepResultV1Schema>;

export class ScaSemgrepError extends Error {
  constructor(
    readonly code: "invalid_request" | "unsafe_path" | "rule_config_drift",
    message: string
  ) {
    super(message);
    this.name = "ScaSemgrepError";
  }
}

function emptyDigest(): string {
  return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
}

async function digestFile(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semgrepCounts(
  stdout: string
): { readonly findings: number; readonly errors: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results) || !Array.isArray(parsed.errors)) {
    return null;
  }
  return { findings: parsed.results.length, errors: parsed.errors.length };
}

function adapterStatus(processResult: ScaProcessResultV1): ScaSemgrepResultV1["status"] {
  if (processResult.status === "timed_out") return "timed_out";
  if (processResult.status === "cancelled") return "cancelled";
  if (processResult.status === "output_limit") return "output_limit";
  return "failed";
}

function processErrorCode(processResult: ScaProcessResultV1): ScaSemgrepResultV1["error_code"] {
  if (processResult.status === "timed_out") return "timeout";
  if (processResult.status === "cancelled") return "cancelled";
  if (processResult.status === "output_limit") return "output_limit";
  return "scanner_failed";
}

function unavailableResult(
  request: ScaSemgrepRequestV1,
  errorCode: "service_unavailable" | "rule_config_drift"
): ScaSemgrepResultV1 {
  const empty = emptyDigest();
  return validateContract(
    ScaSemgrepResultV1Schema,
    {
      schema_id: SCA_SEMGREP_RESULT_SCHEMA,
      schema_version: 1,
      source_snapshot_sha256: request.source_snapshot_sha256,
      rule_config_sha256: request.rule_config_sha256,
      status: errorCode === "service_unavailable" ? "unavailable" : "failed",
      tool_version: null,
      runtime_identity: null,
      runtime_sha256: null,
      invocation_sha256: null,
      exit_code: null,
      finding_count: 0,
      engine_error_count: 0,
      raw_stdout: "",
      raw_stderr: "",
      raw_stdout_sha256: empty,
      raw_stderr_sha256: empty,
      truncated: false,
      error_code: errorCode,
    },
    "SCA Semgrep result"
  );
}

/** Build the closed Semgrep argv suffix; values are separate argv entries and never shell text. */
export function semgrepArguments(value: unknown): readonly string[] {
  const request = validateContract(ScaSemgrepRequestV1Schema, value, "SCA Semgrep request");
  return [
    ...("fixed_arguments" in request.runtime ? request.runtime.fixed_arguments : []),
    "scan",
    "--json",
    "--error",
    "--metrics=off",
    "--disable-version-check",
    "--no-rewrite-rule-ids",
    "--config",
    request.rule_config,
    "--",
    ".",
  ];
}

export async function runScaSemgrepV1(
  value: unknown,
  signal?: AbortSignal
): Promise<ScaSemgrepResultV1> {
  let request: ScaSemgrepRequestV1;
  try {
    request = validateContract(ScaSemgrepRequestV1Schema, value, "SCA Semgrep request");
  } catch (error) {
    throw new ScaSemgrepError(
      "invalid_request",
      error instanceof Error ? error.message : "Semgrep request is invalid"
    );
  }
  if (!path.isAbsolute(request.source_root) || !path.isAbsolute(request.rule_config)) {
    throw new ScaSemgrepError("unsafe_path", "Semgrep source and rule paths must be absolute");
  }
  if (request.runtime.state === "unavailable")
    return unavailableResult(request, "service_unavailable");
  if ((await digestFile(request.rule_config)) !== request.rule_config_sha256) {
    return unavailableResult(request, "rule_config_drift");
  }

  const processResult = await runBoundedScaProcess(
    {
      schema_id: "penny.sca-process-request.v1",
      schema_version: 1,
      executable: request.runtime.executable,
      executable_sha256: request.runtime.executable_sha256,
      arguments: semgrepArguments(request),
      cwd: request.source_root,
      environment: [
        { name: "HOME", value: "/nonexistent" },
        { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
        { name: "SEMGREP_SEND_METRICS", value: "off" },
      ],
      timeout_ms: request.timeout_ms,
      max_stdout_bytes: request.max_output_bytes,
      max_stderr_bytes: request.max_output_bytes,
    },
    signal
  );

  const ruleConfigStable = (await digestFile(request.rule_config)) === request.rule_config_sha256;
  const counts = semgrepCounts(processResult.stdout);
  const validFindingExit = processResult.exit_code === 0 || processResult.exit_code === 1;
  const completed =
    ruleConfigStable &&
    counts !== null &&
    validFindingExit &&
    processResult.status !== "timed_out" &&
    processResult.status !== "cancelled" &&
    processResult.status !== "output_limit" &&
    processResult.status !== "spawn_failed";
  const status: ScaSemgrepResultV1["status"] = completed
    ? counts.findings > 0
      ? "findings"
      : "succeeded"
    : adapterStatus(processResult);
  const errorCode: ScaSemgrepResultV1["error_code"] = !ruleConfigStable
    ? "rule_config_drift"
    : completed
      ? counts.errors === 0
        ? "none"
        : "scanner_failed"
      : counts === null && validFindingExit
        ? "invalid_output"
        : processErrorCode(processResult);

  return validateContract(
    ScaSemgrepResultV1Schema,
    {
      schema_id: SCA_SEMGREP_RESULT_SCHEMA,
      schema_version: 1,
      source_snapshot_sha256: request.source_snapshot_sha256,
      rule_config_sha256: request.rule_config_sha256,
      status: errorCode === "none" ? status : "failed",
      tool_version: request.runtime.tool_version,
      runtime_identity: request.runtime.runtime_identity,
      runtime_sha256: request.runtime.runtime_sha256,
      invocation_sha256: processResult.request_sha256,
      exit_code: processResult.exit_code,
      finding_count: counts?.findings ?? 0,
      engine_error_count: counts?.errors ?? 0,
      raw_stdout: processResult.stdout,
      raw_stderr: processResult.stderr,
      raw_stdout_sha256: processResult.stdout_sha256,
      raw_stderr_sha256: processResult.stderr_sha256,
      truncated: processResult.stdout_truncated || processResult.stderr_truncated,
      error_code: errorCode,
    },
    "SCA Semgrep result"
  );
}
