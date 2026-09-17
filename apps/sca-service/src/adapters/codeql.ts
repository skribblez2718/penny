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

export const SCA_CODEQL_REQUEST_SCHEMA = "penny.sca-codeql-request.v1";
export const SCA_CODEQL_RESULT_SCHEMA = "penny.sca-codeql-result.v1";

const ScaCodeqlRuntimeV1Schema = Type.Union([
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
        Type.Literal("unsupported_language"),
        Type.Literal("licence_unavailable"),
      ]),
    },
    { additionalProperties: false }
  ),
]);

export const ScaCodeqlRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_CODEQL_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    database_root: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    query_suite: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    query_suite_sha256: Sha256Schema,
    runtime: ScaCodeqlRuntimeV1Schema,
    timeout_ms: Type.Integer({ minimum: 1, maximum: 5_400_000 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: 268_435_456 }),
  },
  { additionalProperties: false }
);

const ScaCodeqlStatusV1Schema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("findings"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
  Type.Literal("cancelled"),
  Type.Literal("output_limit"),
  Type.Literal("unavailable"),
]);

export const ScaCodeqlResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_CODEQL_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    query_suite_sha256: Sha256Schema,
    status: ScaCodeqlStatusV1Schema,
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
      Type.Literal("query_suite_drift"),
    ]),
  },
  { additionalProperties: false }
);

export type ScaCodeqlRequestV1 = Static<typeof ScaCodeqlRequestV1Schema>;
export type ScaCodeqlResultV1 = Static<typeof ScaCodeqlResultV1Schema>;

export class ScaCodeqlError extends Error {
  constructor(
    readonly code: "invalid_request" | "unsafe_path",
    message: string
  ) {
    super(message);
    this.name = "ScaCodeqlError";
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

function sarifFindingCount(stdout: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== "2.1.0" || !Array.isArray(parsed.runs)) return null;
  let total = 0;
  for (const run of parsed.runs) {
    if (!isRecord(run) || !Array.isArray(run.results)) return null;
    total += run.results.length;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function processStatus(processResult: ScaProcessResultV1): ScaCodeqlResultV1["status"] {
  if (processResult.status === "timed_out") return "timed_out";
  if (processResult.status === "cancelled") return "cancelled";
  if (processResult.status === "output_limit") return "output_limit";
  return "failed";
}

function processError(processResult: ScaProcessResultV1): ScaCodeqlResultV1["error_code"] {
  if (processResult.status === "timed_out") return "timeout";
  if (processResult.status === "cancelled") return "cancelled";
  if (processResult.status === "output_limit") return "output_limit";
  return "scanner_failed";
}

function unavailableResult(
  request: ScaCodeqlRequestV1,
  errorCode: "service_unavailable" | "query_suite_drift"
): ScaCodeqlResultV1 {
  const empty = emptyDigest();
  return validateContract(
    ScaCodeqlResultV1Schema,
    {
      schema_id: SCA_CODEQL_RESULT_SCHEMA,
      schema_version: 1,
      source_snapshot_sha256: request.source_snapshot_sha256,
      query_suite_sha256: request.query_suite_sha256,
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
    "SCA CodeQL result"
  );
}

/** Build one closed CodeQL database-analyze argv without shell evaluation. */
export function codeqlArguments(value: unknown): readonly string[] {
  const request = validateContract(ScaCodeqlRequestV1Schema, value, "SCA CodeQL request");
  return [
    ...("fixed_arguments" in request.runtime ? request.runtime.fixed_arguments : []),
    "database",
    "analyze",
    request.database_root,
    request.query_suite,
    "--format=sarif-latest",
    "--output=/dev/stdout",
    "--no-print-diagnostics-summary",
    "--threads=1",
  ];
}

export async function runScaCodeqlV1(
  value: unknown,
  signal?: AbortSignal
): Promise<ScaCodeqlResultV1> {
  let request: ScaCodeqlRequestV1;
  try {
    request = validateContract(ScaCodeqlRequestV1Schema, value, "SCA CodeQL request");
  } catch (error) {
    throw new ScaCodeqlError(
      "invalid_request",
      error instanceof Error ? error.message : "CodeQL request is invalid"
    );
  }
  if (!path.isAbsolute(request.database_root) || !path.isAbsolute(request.query_suite)) {
    throw new ScaCodeqlError("unsafe_path", "CodeQL database and query paths must be absolute");
  }
  if (request.runtime.state === "unavailable")
    return unavailableResult(request, "service_unavailable");
  if ((await digestFile(request.query_suite)) !== request.query_suite_sha256) {
    return unavailableResult(request, "query_suite_drift");
  }

  const processResult = await runBoundedScaProcess(
    {
      schema_id: "penny.sca-process-request.v1",
      schema_version: 1,
      executable: request.runtime.executable,
      executable_sha256: request.runtime.executable_sha256,
      arguments: codeqlArguments(request),
      cwd: request.database_root,
      environment: [{ name: "HOME", value: "/nonexistent" }],
      timeout_ms: request.timeout_ms,
      max_stdout_bytes: request.max_output_bytes,
      max_stderr_bytes: request.max_output_bytes,
    },
    signal
  );

  const suiteStable = (await digestFile(request.query_suite)) === request.query_suite_sha256;
  const findingCount = sarifFindingCount(processResult.stdout);
  const completed = suiteStable && processResult.exit_code === 0 && findingCount !== null;
  const status: ScaCodeqlResultV1["status"] = completed
    ? findingCount > 0
      ? "findings"
      : "succeeded"
    : processStatus(processResult);
  const errorCode: ScaCodeqlResultV1["error_code"] = !suiteStable
    ? "query_suite_drift"
    : completed
      ? "none"
      : findingCount === null && processResult.exit_code === 0
        ? "invalid_output"
        : processError(processResult);

  return validateContract(
    ScaCodeqlResultV1Schema,
    {
      schema_id: SCA_CODEQL_RESULT_SCHEMA,
      schema_version: 1,
      source_snapshot_sha256: request.source_snapshot_sha256,
      query_suite_sha256: request.query_suite_sha256,
      status: errorCode === "none" ? status : "failed",
      tool_version: request.runtime.tool_version,
      runtime_identity: request.runtime.runtime_identity,
      runtime_sha256: request.runtime.runtime_sha256,
      invocation_sha256: processResult.request_sha256,
      exit_code: processResult.exit_code,
      finding_count: findingCount ?? 0,
      raw_stdout: processResult.stdout,
      raw_stderr: processResult.stderr,
      raw_stdout_sha256: processResult.stdout_sha256,
      raw_stderr_sha256: processResult.stderr_sha256,
      truncated: processResult.stdout_truncated || processResult.stderr_truncated,
      error_code: errorCode,
    },
    "SCA CodeQL result"
  );
}
