import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { Sha256Schema } from "../../orchestration/dist/skill-contracts/common.js";

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 16_384;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_VALUE_BYTES = 8_192;
const MAX_OUTPUT_BYTES = 268_435_456;
const MAX_INACTIVITY_MS = 5_400_000;
const TERMINATION_GRACE_MS = 1_000;
const EXIT_CONFIRMATION_GRACE_MS = 1_000;
const CLEANUP_POLL_MS = 25;
const MAX_EXECUTABLE_BYTES = 536_870_912;
const MAX_PROC_ENTRIES = 65_536;
const MAX_GROUP_PROCESSES = 4_096;

// libuv's spawn can fall back to /bin/sh on ENOEXEC even with shell:false.
// Bootstrap the already-running Node image (not a mutable host pathname), then use
// execve: unsupported formats/interpreters fail instead of activating that fallback.
// Invocation data travels on a private descriptor, never as JavaScript or shell text.
const EXECVE_BOOTSTRAP = `const fs = require('node:fs');
const invocation = JSON.parse(fs.readFileSync(3, 'utf8'));
fs.closeSync(3);
process.execve(invocation.file, invocation.argv, invocation.env);`;

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
    /** Legacy wire name; enforced as renewable trusted-process inactivity, never total runtime. */
    timeout_ms: Type.Integer({ minimum: 1, maximum: MAX_INACTIVITY_MS }),
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
      Type.Literal("cleanup_failed"),
    ]),
  },
  { additionalProperties: false }
);

export type ScaProcessRequestV1 = Static<typeof ScaProcessRequestV1Schema>;
export type ScaProcessResultV1 = Static<typeof ScaProcessResultV1Schema>;
/** Component-level injection seam. Direct spawn is only the adapter default, never the live P02 fallback. */
export interface ScaProcessRunnerV1 {
  run(request: ScaProcessRequestV1, signal?: AbortSignal): Promise<ScaProcessResultV1>;
}
export const directScaProcessRunnerV1: ScaProcessRunnerV1 = { run: runBoundedScaProcess };

export class ScaProcessError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unsafe_executable"
      | "unsafe_cwd"
      | "environment_collision"
      | "executable_digest_mismatch"
      | "unsupported_platform",
    message: string
  ) {
    super(message);
    this.name = "ScaProcessError";
  }
}

function bufferSha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface PinnedExecutable {
  readonly invocation: FileHandle;
  dispose(): Promise<void>;
}

class PreparationCancelled extends Error {}

/** Copy and measure the same bounded bytes. Only new, private staging permissions change.
 * The source may be replaced or modified at any time: it is never opened for execution.
 * The retained staging name supports native tools that re-exec themselves. Execution itself
 * uses the retained parent descriptor, also readable by shebang interpreters after exec.
 * Node execve closes non-stdio child descriptors, so /proc/self/fd is not sufficient.
 * Interpreters, shared libraries and tool-relative resources are not independently pinned here.
 */
async function pinExecutable(
  request: ScaProcessRequestV1,
  signal?: AbortSignal
): Promise<PinnedExecutable> {
  if (
    process.platform !== "linux" ||
    process.release.name !== "node" ||
    typeof process.execve !== "function"
  ) {
    throw new ScaProcessError(
      "unsupported_platform",
      "pinned descriptor execution requires Linux /proc and Node process.execve"
    );
  }
  const source = await open(request.executable, constants.O_RDONLY | constants.O_NONBLOCK);
  let directory: string | undefined;
  let pinned: FileHandle | undefined;
  let invocation: FileHandle | undefined;
  try {
    const stats = await source.stat();
    if (!stats.isFile() || (stats.mode & 0o111) === 0 || stats.size > MAX_EXECUTABLE_BYTES) {
      throw new ScaProcessError(
        "unsafe_executable",
        "executable must be an executable regular file of at most 512 MiB"
      );
    }
    directory = await mkdtemp(path.join(tmpdir(), "penny-sca-executable-"));
    ownStagingDirectory(directory);
    const binaryDirectory = path.join(directory, "executable");
    await mkdir(binaryDirectory, { mode: 0o700 });
    const stagedPath = path.join(binaryDirectory, path.basename(request.executable));
    const writer = await open(
      stagedPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    );
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1_024);
      let position = 0;
      for (;;) {
        if (signal?.aborted) throw new PreparationCancelled();
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > MAX_EXECUTABLE_BYTES) {
          throw new ScaProcessError("unsafe_executable", "executable exceeds 512 MiB");
        }
        const bytes = buffer.subarray(0, bytesRead);
        await writer.writeFile(bytes);
        hash.update(bytes);
      }
      if (hash.digest("hex") !== request.executable_sha256) {
        throw new ScaProcessError(
          "executable_digest_mismatch",
          "process executable digest does not match its admitted identity"
        );
      }
      await writer.chmod(0o500);
    } finally {
      await writer.close();
    }
    pinned = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    // A separate exclusive name avoids collisions with the caller's executable basename.
    const invocationDirectory = path.join(directory, "invocation");
    await mkdir(invocationDirectory, { mode: 0o700 });
    const invocationPath = path.join(invocationDirectory, "argv.json");
    const invocationWriter = await open(invocationPath, "wx", 0o600);
    try {
      await invocationWriter.writeFile(
        JSON.stringify({
          file: `/proc/${process.pid}/fd/${pinned.fd}`,
          argv: [request.executable, ...request.arguments],
          env: environmentRecord(request.environment),
        })
      );
    } finally {
      await invocationWriter.close();
    }
    invocation = await open(invocationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handle = pinned;
    const invocationHandle = invocation;
    const root = directory;
    return {
      invocation: invocationHandle,
      async dispose() {
        try {
          await Promise.all([handle.close(), invocationHandle.close()]);
        } finally {
          await rm(root, { recursive: true, force: true });
          releaseStagingDirectory(root);
        }
      },
    };
  } catch (error) {
    await invocation?.close();
    await pinned?.close();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
      releaseStagingDirectory(directory);
    }
    throw error;
  } finally {
    await source.close();
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

interface GroupObservation {
  readonly complete: boolean;
  readonly live: number;
  readonly activity: string | undefined;
}

function vanished(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

/** Scan the group, not just PPIDs: descendants remain members after their parent exits.
 * Z/X states are exited workloads, although their PIDs may still answer kill(0).
 * Inaccessible/malformed/capped observations never prove successful cleanup.
 * This is process-group containment, not a sandbox against deliberate setsid/escape.
 */
function linuxProcessGroupObservation(group: number): GroupObservation {
  const observations: string[] = [];
  let live = 0;
  let complete = true;
  try {
    const entries = readdirSync("/proc");
    if (entries.length > MAX_PROC_ENTRIES) return { complete: false, live, activity: undefined };
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const fields = stat
          .slice(close + 2)
          .trim()
          .split(/\s+/u);
        if (close < 0 || fields.length < 20) {
          complete = false;
          continue;
        }
        if (fields[2] !== String(group)) continue;
        if (fields[0] === "Z" || fields[0] === "X") continue;
        live += 1;
        if (live > MAX_GROUP_PROCESSES) return { complete: false, live, activity: undefined };
        let io = "";
        try {
          io = readFileSync(`/proc/${entry}/io`, "utf8")
            .split("\n")
            .filter((line) => /^(?:rchar|wchar|read_bytes|write_bytes):/u.test(line))
            .join("|");
        } catch {
          /* CPU/tree progress still works when I/O counters are unavailable. */
        }
        observations.push(`${entry}:${fields[19]}:${fields[11]}:${fields[12]}:${io}`);
      } catch (error) {
        if (!vanished(error)) complete = false;
      }
    }
  } catch {
    complete = false;
  }
  return {
    complete,
    live,
    activity: observations.length === 0 ? undefined : sha256(observations.sort().join("\n")),
  };
}

const ownedGroups = new Set<number>();
const ownedStagingDirectories = new Set<string>();
function killOwnedGroupsOnExit(): void {
  // A Node exit hook cannot wait. Abrupt SIGKILL/host death requires an outer supervisor.
  for (const group of ownedGroups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      /* No asynchronous reporting at exit. */
    }
  }
  for (const directory of ownedStagingDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Best effort only: an exit hook cannot report or await cleanup. */
    }
  }
}
function installOwnerExitHook(): void {
  if (ownedGroups.size === 0 && ownedStagingDirectories.size === 0)
    process.once("exit", killOwnedGroupsOnExit);
}
function removeIdleOwnerExitHook(): void {
  if (ownedGroups.size === 0 && ownedStagingDirectories.size === 0)
    process.removeListener("exit", killOwnedGroupsOnExit);
}
function ownGroup(group: number): void {
  installOwnerExitHook();
  ownedGroups.add(group);
}
function releaseGroup(group: number): void {
  ownedGroups.delete(group);
  removeIdleOwnerExitHook();
}
function ownStagingDirectory(directory: string): void {
  installOwnerExitHook();
  ownedStagingDirectories.add(directory);
}
function releaseStagingDirectory(directory: string): void {
  ownedStagingDirectories.delete(directory);
  removeIdleOwnerExitHook();
}

function resultFor(
  request: ScaProcessRequestV1,
  status: ScaProcessResultV1["status"],
  exitCode: number | null,
  signal: string | null,
  stdout: Buffer,
  stderr: Buffer,
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
  cleanupFailed = false
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
      failure_code: cleanupFailed ? "cleanup_failed" : failureCode,
    },
    "SCA process result"
  );
}

/** Run pinned bytes/argv with no shell or ambient environment. Linux only; no pathname fallback.
 * timeout_ms is renewable productive inactivity. Cleanup has a separate finite 1s TERM grace
 * and 1s KILL/exit-confirmation grace. A cleanup_failed failure code (spawn_failed status)
 * means exit could not be established; existing status-based consumers must fail closed.
 */
export async function runBoundedScaProcess(
  value: unknown,
  signal?: AbortSignal,
  onActivity?: () => void
): Promise<ScaProcessResultV1> {
  const request = validateRequest(value);
  const empty = Buffer.alloc(0);
  if (signal?.aborted)
    return resultFor(request, "cancelled", null, null, empty, empty, false, false);
  let pinned: PinnedExecutable;
  try {
    pinned = await pinExecutable(request, signal);
  } catch (error) {
    if (error instanceof ScaProcessError) throw error;
    if (error instanceof PreparationCancelled)
      return resultFor(request, "cancelled", null, null, empty, empty, false, false);
    const diagnostic = boundedAppend(
      empty,
      Buffer.from(error instanceof Error ? error.message : "executable could not be pinned"),
      request.max_stderr_bytes
    );
    return resultFor(
      request,
      "spawn_failed",
      null,
      null,
      empty,
      diagnostic.value,
      false,
      diagnostic.overflow
    );
  }

  try {
    if (signal?.aborted)
      return resultFor(request, "cancelled", null, null, empty, empty, false, false);
    return await new Promise<ScaProcessResultV1>((resolve) => {
      let stdout: Buffer = empty;
      let stderr: Buffer = empty;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let forcedStatus: ScaProcessResultV1["status"] | null = null;
      let settled = false;
      let exited = false;
      let closed = false;
      let exitCode: number | null = null;
      let observedSignal: string | null = null;
      let cleanupStarted = false;
      let signalFailed = false;
      let inactivityTimer: NodeJS.Timeout | undefined;
      let activityProbe: NodeJS.Timeout | undefined;
      let cleanupProbe: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let confirmationTimer: NodeJS.Timeout | undefined;

      const child = spawn("/proc/self/exe", ["--input-type=commonjs", "-e", EXECVE_BOOTSTRAP], {
        cwd: request.cwd,
        env: {},
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", pinned.invocation.fd],
      });
      const group = child.pid;
      if (group !== undefined) ownGroup(group);

      const appendDiagnostic = (message: string): void => {
        const next = boundedAppend(stderr, Buffer.from(message), request.max_stderr_bytes);
        stderr = next.value;
        stderrTruncated ||= next.overflow;
      };
      const signalGroup = (sent: NodeJS.Signals): void => {
        if (group === undefined) return;
        try {
          process.kill(-group, sent);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
            signalFailed = true;
        }
      };
      const onAbort = (): void => terminate("cancelled");
      const finish = (cleanupConfirmed: boolean): void => {
        if (settled) return;
        settled = true;
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        if (activityProbe !== undefined) clearInterval(activityProbe);
        if (cleanupProbe !== undefined) clearInterval(cleanupProbe);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (confirmationTimer !== undefined) clearTimeout(confirmationTimer);
        signal?.removeEventListener("abort", onAbort);
        if (group !== undefined) releaseGroup(group);
        if (!cleanupConfirmed) {
          signalGroup("SIGKILL");
          appendDiagnostic(
            "\nprocess-group cleanup could not confirm direct-child exit, drained streams and no live group members within cleanup grace"
          );
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        }
        const status = !cleanupConfirmed
          ? "spawn_failed"
          : (forcedStatus ??
            (exitCode === 0 ? "succeeded" : exitCode === null ? "spawn_failed" : "nonzero_exit"));
        resolve(
          resultFor(
            request,
            status,
            exitCode,
            observedSignal,
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            !cleanupConfirmed
          )
        );
      };
      const checkCleanup = (): void => {
        if (!exited || !closed) return;
        if (group === undefined) {
          finish(true);
          return;
        }
        const observation = linuxProcessGroupObservation(group);
        if (observation.complete && observation.live === 0 && !signalFailed) finish(true);
      };
      const beginCleanup = (): void => {
        if (settled || cleanupStarted) return;
        cleanupStarted = true;
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        if (activityProbe !== undefined) clearInterval(activityProbe);
        signalGroup("SIGTERM");
        cleanupProbe = setInterval(checkCleanup, CLEANUP_POLL_MS);
        killTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          confirmationTimer = setTimeout(() => {
            checkCleanup();
            if (!settled) finish(false);
          }, EXIT_CONFIRMATION_GRACE_MS);
          checkCleanup();
        }, TERMINATION_GRACE_MS);
        checkCleanup();
      };
      function terminate(status: ScaProcessResultV1["status"]): void {
        if (settled) return;
        forcedStatus ??= status;
        beginCleanup();
      }
      const renewInactivity = (): void => {
        if (settled || cleanupStarted) return;
        try {
          onActivity?.();
        } catch {
          terminate("cancelled");
          return;
        }
        // The callback may synchronously abort the caller signal.
        if (cleanupStarted) return;
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => terminate("timed_out"), request.timeout_ms);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const next = boundedAppend(stdout, chunk, request.max_stdout_bytes);
        stdout = next.value;
        stdoutTruncated ||= next.overflow;
        if (next.overflow) terminate("output_limit");
        else if (chunk.byteLength > 0) renewInactivity();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const next = boundedAppend(stderr, chunk, request.max_stderr_bytes);
        stderr = next.value;
        stderrTruncated ||= next.overflow;
        if (next.overflow) terminate("output_limit");
        else if (chunk.byteLength > 0) renewInactivity();
      });
      child.once("error", (error) => {
        appendDiagnostic(error.message);
        forcedStatus = "spawn_failed";
        if (group === undefined) exited = true;
        beginCleanup();
      });
      child.once("exit", (code, receivedSignal) => {
        exited = true;
        exitCode = code;
        observedSignal = receivedSignal;
        // Do not wait for inherited pipes to close: a surviving descendant can hold them.
        beginCleanup();
      });
      child.once("close", () => {
        closed = true;
        checkCleanup();
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      renewInactivity();
      let lastKernelActivity =
        group === undefined ? undefined : linuxProcessGroupObservation(group).activity;
      if (group !== undefined && !cleanupStarted) {
        const probeEveryMs = Math.max(10, Math.min(1_000, Math.floor(request.timeout_ms / 4)));
        activityProbe = setInterval(() => {
          const observed = linuxProcessGroupObservation(group).activity;
          if (observed !== undefined && observed !== lastKernelActivity) {
            lastKernelActivity = observed;
            renewInactivity();
          }
        }, probeEveryMs);
      }
    });
  } finally {
    await pinned.dispose();
  }
}
