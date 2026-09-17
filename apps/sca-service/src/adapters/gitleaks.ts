import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Type, type Static } from "typebox";

import { validateContract } from "../../../orchestration/src/contracts.js";
import { Sha256Schema } from "../../../orchestration/src/skill-contracts/common.js";
import { runBoundedScaProcess, type ScaProcessResultV1 } from "../process.js";

const MAX_PATH_BYTES = 4_096;
const MAX_VERSION_BYTES = 256;
const MAX_ARGUMENT_BYTES = 4_096;
const MAX_FIXED_ARGUMENTS = 64;

export const SCA_GITLEAKS_REQUEST_SCHEMA = "penny.sca-gitleaks-request.v1";
export const SCA_GITLEAKS_RESULT_SCHEMA = "penny.sca-gitleaks-result.v1";

const ScaGitleaksRuntimeV1Schema = Type.Union([
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

export const ScaGitleaksRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_GITLEAKS_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    source_root: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    configuration_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    configuration_sha256: Sha256Schema,
    runtime: ScaGitleaksRuntimeV1Schema,
    timeout_ms: Type.Integer({ minimum: 1, maximum: 5_400_000 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: 268_435_456 }),
  },
  { additionalProperties: false }
);

export const ScaGitleaksResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_GITLEAKS_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    configuration_sha256: Sha256Schema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("findings"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("cancelled"),
      Type.Literal("output_limit"),
      Type.Literal("unavailable"),
    ]),
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
      Type.Literal("configuration_drift"),
    ]),
  },
  { additionalProperties: false }
);

export type ScaGitleaksRequestV1 = Static<typeof ScaGitleaksRequestV1Schema>;
export type ScaGitleaksResultV1 = Static<typeof ScaGitleaksResultV1Schema>;

export class ScaGitleaksError extends Error {
  constructor(
    readonly code: "invalid_request" | "unsafe_path",
    message: string
  ) {
    super(message);
    this.name = "ScaGitleaksError";
  }
}

function digestBytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestFile(filePath: string): Promise<string> {
  return digestBytes(await readFile(filePath));
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function findingCount(stdout: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  return isUnknownArray(parsed) ? parsed.length : null;
}

function unavailableResult(
  request: ScaGitleaksRequestV1,
  errorCode: "service_unavailable" | "configuration_drift"
): ScaGitleaksResultV1 {
  const empty = digestBytes("");
  return validateContract(
    ScaGitleaksResultV1Schema,
    {
      schema_id: SCA_GITLEAKS_RESULT_SCHEMA,
      schema_version: 1,
      source_snapshot_sha256: request.source_snapshot_sha256,
      configuration_sha256: request.configuration_sha256,
      status: errorCode === "service_unavailable" ? "unavailable" : "failed",
      tool_version: null,
      runtime_identity: null,
      runtime_sha256: null,
      invocation_sha256: null,
      exit_code: null,
      finding_count: 0,
      raw_stdout: "",
      raw_stderr: "",
      raw_stdout_sha256: empty,
      raw_stderr_sha256: empty,
      truncated: false,
      error_code: errorCode,
    },
    "SCA Gitleaks result"
  );
}

export function gitleaksArguments(value: unknown): readonly string[] {
  const request = validateContract(ScaGitleaksRequestV1Schema, value, "SCA Gitleaks request");
  return [
    ...(request.runtime.state === "available" ? request.runtime.fixed_arguments : []),
    "dir",
    ".",
    "--config",
    request.configuration_path,
    "--no-banner",
    "--redact",
    "--report-format",
    "json",
    "--report-path",
    "-",
    "--exit-code",
    "1",
  ];
}

function failedStatus(processResult: ScaProcessResultV1): ScaGitleaksResultV1["status"] {
  if (processResult.status === "timed_out") return "timed_out";
  if (processResult.status === "cancelled") return "cancelled";
  if (processResult.status === "output_limit") return "output_limit";
  return "failed";
}

function failedCode(processResult: ScaProcessResultV1): ScaGitleaksResultV1["error_code"] {
  if (processResult.status === "timed_out") return "timeout";
  if (processResult.status === "cancelled") return "cancelled";
  if (processResult.status === "output_limit") return "output_limit";
  return "scanner_failed";
}

export async function runScaGitleaksV1(
  value: unknown,
  signal?: AbortSignal
): Promise<ScaGitleaksResultV1> {
  let request: ScaGitleaksRequestV1;
  try {
    request = validateContract(ScaGitleaksRequestV1Schema, value, "SCA Gitleaks request");
  } catch (error) {
    throw new ScaGitleaksError(
      "invalid_request",
      error instanceof Error ? error.message : "Gitleaks request is invalid"
    );
  }
  if (!path.isAbsolute(request.source_root) || !path.isAbsolute(request.configuration_path)) {
    throw new ScaGitleaksError(
      "unsafe_path",
      "Gitleaks source and configuration paths must be absolute"
    );
  }
  if (request.runtime.state === "unavailable") {
    return unavailableResult(request, "service_unavailable");
  }
  if ((await digestFile(request.configuration_path)) !== request.configuration_sha256) {
    return unavailableResult(request, "configuration_drift");
  }

  const processResult = await runBoundedScaProcess(
    {
      schema_id: "penny.sca-process-request.v1",
      schema_version: 1,
      executable: request.runtime.executable,
      executable_sha256: request.runtime.executable_sha256,
      arguments: gitleaksArguments(request),
      cwd: request.source_root,
      environment: [{ name: "HOME", value: "/nonexistent" }],
      timeout_ms: request.timeout_ms,
      max_stdout_bytes: request.max_output_bytes,
      max_stderr_bytes: request.max_output_bytes,
    },
    signal
  );

  if ((await digestFile(request.configuration_path)) !== request.configuration_sha256) {
    return unavailableResult(request, "configuration_drift");
  }
  const count = findingCount(processResult.stdout);
  const validExit = processResult.exit_code === 0 || processResult.exit_code === 1;
  const completed =
    validExit &&
    count !== null &&
    processResult.status !== "timed_out" &&
    processResult.status !== "cancelled" &&
    processResult.status !== "output_limit" &&
    processResult.status !== "spawn_failed";
  const status: ScaGitleaksResultV1["status"] = completed
    ? count > 0
      ? "findings"
      : "succeeded"
    : failedStatus(processResult);
  const errorCode: ScaGitleaksResultV1["error_code"] = completed
    ? "none"
    : validExit && count === null
      ? "invalid_output"
      : failedCode(processResult);

  return validateContract(
    ScaGitleaksResultV1Schema,
    {
      schema_id: SCA_GITLEAKS_RESULT_SCHEMA,
      schema_version: 1,
      source_snapshot_sha256: request.source_snapshot_sha256,
      configuration_sha256: request.configuration_sha256,
      status,
      tool_version: request.runtime.tool_version,
      runtime_identity: request.runtime.runtime_identity,
      runtime_sha256: request.runtime.runtime_sha256,
      invocation_sha256: processResult.request_sha256,
      exit_code: processResult.exit_code,
      finding_count: count ?? 0,
      raw_stdout: processResult.stdout,
      raw_stderr: processResult.stderr,
      raw_stdout_sha256: processResult.stdout_sha256,
      raw_stderr_sha256: processResult.stderr_sha256,
      truncated: processResult.stdout_truncated || processResult.stderr_truncated,
      error_code: errorCode,
    },
    "SCA Gitleaks result"
  );
}
