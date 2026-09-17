import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../orchestration/src/canonical-json.js";
import { validateContract } from "../../orchestration/src/contracts.js";
import { Sha256Schema } from "../../orchestration/src/skill-contracts/common.js";

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 16_384;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_VALUE_BYTES = 8_192;
const MAX_OUTPUT_BYTES = 268_435_456;
const MAX_TIMEOUT_MS = 5_400_000;
const TERMINATION_GRACE_MS = 1_000;

export const SCA_PROCESS_REQUEST_SCHEMA = "penny.sca-process-request.v1";
export const SCA_PROCESS_RESULT_SCHEMA = "penny.sca-process-result.v1";

const ScaEnvironmentEntryV1Schema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Z_][A-Z0-9_]*$" }),
    value: Type.String({ maxLength: MAX_ENVIRONMENT_VALUE_BYTES }),
  },
  { additionalProperties: false }
);

export const ScaProcessRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PROCESS_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    executable: Type.String({ minLength: 1, maxLength: 4_096 }),
    executable_sha256: Sha256Schema,
    arguments: Type.Array(Type.String({ maxLength: MAX_ARGUMENT_BYTES }), {
      maxItems: MAX_ARGUMENTS,
    }),
    cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
    environment: Type.Array(ScaEnvironmentEntryV1Schema, {
      maxItems: MAX_ENVIRONMENT_ENTRIES,
    }),
    timeout_ms: Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS }),
    max_stdout_bytes: Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_BYTES }),
    max_stderr_bytes: Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_BYTES }),
  },
  { additionalProperties: false }
);

const ScaProcessStatusV1Schema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("nonzero_exit"),
  Type.Literal("timed_out"),
  Type.Literal("cancelled"),
  Type.Literal("output_limit"),
  Type.Literal("spawn_failed"),
]);

export const ScaProcessResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PROCESS_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    request_sha256: Sha256Schema,
    status: ScaProcessStatusV1Schema,
    exit_code: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
    signal: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    stdout: Type.String(),
    stderr: Type.String(),
    stdout_sha256: Sha256Schema,
    stderr_sha256: Sha256Schema,
    stdout_bytes: Type.Integer({ minimum: 0, maximum: MAX_OUTPUT_BYTES }),
    stderr_bytes: Type.Integer({ minimum: 0, maximum: MAX_OUTPUT_BYTES }),
    stdout_truncated: Type.Boolean(),
    stderr_truncated: Type.Boolean(),
    failure_code: Type.Union([
      Type.Literal("none"),
      Type.Literal("nonzero_exit"),
      Type.Literal("timeout"),
      Type.Literal("cancelled"),
      Type.Literal("output_limit"),
      Type.Literal("spawn_failed"),
    ]),
  },
  { additionalProperties: false }
);

export type ScaProcessRequestV1 = Static<typeof ScaProcessRequestV1Schema>;
export type ScaProcessResultV1 = Static<typeof ScaProcessResultV1Schema>;

export class ScaProcessError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unsafe_executable"
      | "unsafe_cwd"
      | "environment_collision"
      | "executable_digest_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaProcessError";
  }
}

function bufferSha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath: string): Promise<string> {
  const handle = await import("node:fs/promises").then((fs) => fs.open(filePath, "r"));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new ScaProcessError("unsafe_executable", "executable is not a file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function validateRequest(value: unknown): ScaProcessRequestV1 {
  let request: ScaProcessRequestV1;
  try {
    request = validateContract(ScaProcessRequestV1Schema, value, "SCA process request");
  } catch (error) {
    throw new ScaProcessError(
      "invalid_request",
      error instanceof Error ? error.message : "process request is invalid"
    );
  }
  if (!path.isAbsolute(request.executable) || request.executable.includes("\0")) {
    throw new ScaProcessError("unsafe_executable", "process executable must be an absolute path");
  }
  if (!path.isAbsolute(request.cwd) || request.cwd.includes("\0")) {
    throw new ScaProcessError("unsafe_cwd", "process cwd must be an absolute path");
  }
  if (request.arguments.some((argument) => argument.includes("\0"))) {
    throw new ScaProcessError("invalid_request", "process arguments must not contain NUL");
  }
  const names = new Set<string>();
  for (const entry of request.environment) {
    if (entry.value.includes("\0") || names.has(entry.name)) {
      throw new ScaProcessError(
        "environment_collision",
        "process environment must contain unique NUL-free entries"
      );
    }
    names.add(entry.name);
  }
  return request;
}

function boundedAppend(
  current: Buffer,
  incoming: Buffer,
  maximum: number
): { readonly value: Buffer; readonly overflow: boolean } {
  if (current.byteLength >= maximum) return { value: current, overflow: incoming.byteLength > 0 };
  const available = maximum - current.byteLength;
  if (incoming.byteLength <= available) {
    return { value: Buffer.concat([current, incoming]), overflow: false };
  }
  return { value: Buffer.concat([current, incoming.subarray(0, available)]), overflow: true };
}

function environmentRecord(entries: ScaProcessRequestV1["environment"]): NodeJS.ProcessEnv {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

function resultFor(
  request: ScaProcessRequestV1,
  status: ScaProcessResultV1["status"],
  exitCode: number | null,
  signal: string | null,
  stdout: Buffer,
  stderr: Buffer,
  stdoutTruncated: boolean,
  stderrTruncated: boolean
): ScaProcessResultV1 {
  const failureCode: ScaProcessResultV1["failure_code"] =
    status === "succeeded"
      ? "none"
      : status === "nonzero_exit"
        ? "nonzero_exit"
        : status === "timed_out"
          ? "timeout"
          : status;
  return validateContract(
    ScaProcessResultV1Schema,
    {
      schema_id: SCA_PROCESS_RESULT_SCHEMA,
      schema_version: 1,
      request_sha256: sha256(canonicalJson(request)),
      status,
      exit_code: exitCode,
      signal,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      stdout_sha256: bufferSha256(stdout),
      stderr_sha256: bufferSha256(stderr),
      stdout_bytes: stdout.byteLength,
      stderr_bytes: stderr.byteLength,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
      failure_code: failureCode,
    },
    "SCA process result"
  );
}

/** Run an exact executable/argv with no shell and only the supplied environment. */
export async function runBoundedScaProcess(
  value: unknown,
  signal?: AbortSignal
): Promise<ScaProcessResultV1> {
  const request = validateRequest(value);
  let observedDigest: string;
  try {
    observedDigest = await fileSha256(request.executable);
  } catch (error) {
    if (error instanceof ScaProcessError) throw error;
    return resultFor(
      request,
      "spawn_failed",
      null,
      null,
      Buffer.alloc(0),
      Buffer.from(error instanceof Error ? error.message : "executable could not be read", "utf8"),
      false,
      false
    );
  }
  if (observedDigest !== request.executable_sha256) {
    throw new ScaProcessError(
      "executable_digest_mismatch",
      "process executable digest does not match its admitted identity"
    );
  }
  if (signal?.aborted === true) {
    return resultFor(
      request,
      "cancelled",
      null,
      null,
      Buffer.alloc(0),
      Buffer.alloc(0),
      false,
      false
    );
  }

  return await new Promise<ScaProcessResultV1>((resolve) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let forcedStatus: ScaProcessResultV1["status"] | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(request.executable, request.arguments, {
      cwd: request.cwd,
      env: environmentRecord(request.environment),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const terminate = (status: ScaProcessResultV1["status"]): void => {
      if (forcedStatus === null) forcedStatus = status;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
      killTimer.unref();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const next = boundedAppend(stdout, chunk, request.max_stdout_bytes);
      stdout = next.value;
      stdoutTruncated ||= next.overflow;
      if (next.overflow) terminate("output_limit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = boundedAppend(stderr, chunk, request.max_stderr_bytes);
      stderr = next.value;
      stderrTruncated ||= next.overflow;
      if (next.overflow) terminate("output_limit");
    });

    const timeout = setTimeout(() => terminate("timed_out"), request.timeout_ms);
    timeout.unref();
    const onAbort = (): void => terminate("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, observedSignal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      const status =
        forcedStatus ??
        (exitCode === 0 ? "succeeded" : exitCode === null ? "spawn_failed" : "nonzero_exit");
      resolve(
        resultFor(
          request,
          status,
          exitCode,
          observedSignal,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated
        )
      );
    };

    child.once("error", (error) => {
      stderr = boundedAppend(
        stderr,
        Buffer.from(error.message, "utf8"),
        request.max_stderr_bytes
      ).value;
      forcedStatus = "spawn_failed";
      finish(null, null);
    });
    child.once("close", (exitCode, observedSignal) => finish(exitCode, observedSignal));
  });
}
