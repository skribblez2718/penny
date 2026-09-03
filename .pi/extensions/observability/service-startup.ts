import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

import type { ErrorCode } from "../../lib/logger/logger.js";

export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_STARTUP_POLL_INTERVAL_MS = 250;
export const DEFAULT_STARTUP_STDERR_MAX_BYTES = 16 * 1024;
const STARTUP_TERMINATION_GRACE_MS = 500;
const STARTUP_TERMINATION_POLL_MS = 25;

const SECRET_NAME =
  /(?:authorization|cookie|secret|token|password|passwd|api[_-]?key|access[_-]?key|credential|private[_-]?key)/iu;
const MIN_SECRET_REDACTION_LENGTH = 8;
const MAX_CONFIGURED_STARTUP_TIMEOUT_MS = 60_000;
const MAX_CONFIGURED_STDERR_BYTES = 64 * 1024;
const CHILD_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PENNY_STATE_ROOT",
  "PI_CODING_AGENT_DIR",
  "PI_OBSERVABILITY_API_KEY",
  "PI_OBSERVABILITY_MAX_ROWS",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
] as const;

interface LoopbackEndpoint {
  readonly baseUrl: string;
  readonly host: string;
  readonly port: number;
}

export interface ServiceStartupSuccess {
  readonly ready: true;
  readonly spawned: boolean;
  readonly childPid?: number;
}

export interface ServiceStartupFailure {
  readonly ready: false;
  readonly spawned: boolean;
  readonly stderr?: string;
  readonly stderrTruncated: boolean;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly error: Error & { readonly code: ErrorCode };
  readonly childPid?: number;
}

export type ServiceStartupResult = ServiceStartupSuccess | ServiceStartupFailure;

type SpawnService = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: true;
    stdio: ["ignore", "ignore", "pipe"];
  }
) => ChildProcess;

export interface ObservabilityServiceStarterOptions {
  readonly projectRoot: string;
  readonly baseUrl: string;
  readonly entryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly stderrMaxBytes?: number;
  readonly spawnService?: SpawnService;
  readonly fetchImplementation?: typeof fetch;
}

interface CapturedStderr {
  readonly text?: string;
  readonly truncated: boolean;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + STARTUP_TERMINATION_GRACE_MS;
  while (Date.now() < deadline) {
    if (childExited(child)) return true;
    await delay(STARTUP_TERMINATION_POLL_MS);
  }
  return childExited(child);
}

async function terminateUnhealthyChild(child: ChildProcess): Promise<void> {
  if (childExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child);
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function loopbackEndpoint(value: string): LoopbackEndpoint {
  const url = new URL(value);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  if (
    url.protocol !== "http:" ||
    (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("observability auto-start URL must be a credential-free loopback HTTP origin");
  }
  const port = url.port === "" ? 80 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("observability auto-start URL port is invalid");
  }
  return { baseUrl: url.origin, host, port };
}

function childEnvironment(
  source: NodeJS.ProcessEnv,
  endpoint: LoopbackEndpoint
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENVIRONMENT_KEYS) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.PI_OBSERVABILITY_HOST = endpoint.host;
  env.PI_OBSERVABILITY_PORT = String(endpoint.port);
  return env;
}

function startupError(message: string): Error & { readonly code: ErrorCode } {
  return Object.assign(new Error(message), {
    code: "OBSERVABILITY_SERVER_SPAWN_FAILED" as const,
  });
}

function configuredSecretValues(env: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    SECRET_NAME.test(name) &&
    typeof value === "string" &&
    value.length >= MIN_SECRET_REDACTION_LENGTH
      ? [value]
      : []
  );
}

/**
 * Remove credentials and terminal control bytes before startup stderr is surfaced.
 * The input has already been byte-bounded by the caller.
 */
export function sanitizeStartupStderr(input: string, env: NodeJS.ProcessEnv): string {
  let sanitized = input;
  for (const secret of configuredSecretValues(env)) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  sanitized = sanitized
    .replace(/(\bAuthorization\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(/(\b(?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(
      /(\b(?:authorization|cookie|secret|token|password|passwd|api[_-]?key|access[_-]?key|credential|private[_-]?key)\b\s*[:=]\s*)([^\s,;]+)/giu,
      "$1[REDACTED]"
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)=)[^&#\s]+/giu,
      "$1[REDACTED]"
    );
  return Array.from(sanitized, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\t") return character;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "�" : character;
  }).join("");
}

function hasUnref(stream: Readable): stream is Readable & { unref(): void } {
  return "unref" in stream && typeof stream.unref === "function";
}

function unrefReadable(stream: Readable | null): void {
  if (stream && hasUnref(stream)) stream.unref();
}

function captureStartupStderr(
  stream: Readable | null,
  maximumBytes: number,
  env: NodeJS.ProcessEnv
): { readonly stop: () => CapturedStderr } {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let stopped = false;

  const onData = (value: unknown): void => {
    if (stopped) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const remaining = maximumBytes - capturedBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const accepted = chunk.subarray(0, remaining);
    chunks.push(accepted);
    capturedBytes += accepted.byteLength;
    if (accepted.byteLength < chunk.byteLength) truncated = true;
  };

  // Continue draining after the bounded startup window so the detached child cannot
  // block on a full pipe. Unref the pipe so it cannot keep the Pi parent alive.
  stream?.on("data", onData);
  stream?.on("error", () => undefined);
  stream?.resume();
  unrefReadable(stream);

  return {
    stop(): CapturedStderr {
      stopped = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      const text = raw ? sanitizeStartupStderr(raw, env) : undefined;
      return { ...(text ? { text } : {}), truncated };
    },
  };
}

function isHealthPayload(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true &&
    "service" in value &&
    value.service === "penny-observability" &&
    "schema_version" in value &&
    value.schema_version === 1
  );
}

export async function observabilityServiceAlive(
  baseUrl: string,
  fetchImplementation: typeof fetch = globalThis.fetch
): Promise<boolean> {
  try {
    const endpoint = loopbackEndpoint(baseUrl);
    const response = await fetchImplementation(`${endpoint.baseUrl}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return isHealthPayload(payload);
  } catch {
    return false;
  }
}

export class ObservabilityServiceStarter {
  private readonly projectRoot: string;
  private readonly baseUrl: string;
  private readonly entryPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly stderrMaxBytes: number;
  private readonly spawnService: SpawnService;
  private readonly fetchImplementation: typeof fetch;
  private serviceStarted = false;
  private startupInFlight: Promise<ServiceStartupResult> | undefined;

  constructor(options: ObservabilityServiceStarterOptions) {
    const endpoint = loopbackEndpoint(options.baseUrl);
    this.projectRoot = options.projectRoot;
    this.baseUrl = endpoint.baseUrl;
    this.entryPath =
      options.entryPath ??
      path.join(this.projectRoot, "apps", "observability", "dist", "server.js");
    this.env = childEnvironment(options.env ?? process.env, endpoint);
    this.startupTimeoutMs = positiveInteger(
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
      MAX_CONFIGURED_STARTUP_TIMEOUT_MS
    );
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_STARTUP_POLL_INTERVAL_MS,
      "pollIntervalMs",
      this.startupTimeoutMs
    );
    this.stderrMaxBytes = positiveInteger(
      options.stderrMaxBytes ?? DEFAULT_STARTUP_STDERR_MAX_BYTES,
      "stderrMaxBytes",
      MAX_CONFIGURED_STDERR_BYTES
    );
    this.spawnService = options.spawnService ?? (spawn as SpawnService);
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  }

  get isReady(): boolean {
    return this.serviceStarted;
  }

  ensureReady(): Promise<ServiceStartupResult> {
    if (this.startupInFlight) return this.startupInFlight;
    const attempt = this.startAttempt();
    this.startupInFlight = attempt;
    const clearAttempt = (): void => {
      if (this.startupInFlight === attempt) this.startupInFlight = undefined;
    };
    void attempt.then(clearAttempt, clearAttempt);
    return attempt;
  }

  private async serviceAlive(): Promise<boolean> {
    return observabilityServiceAlive(this.baseUrl, this.fetchImplementation);
  }

  private async startAttempt(): Promise<ServiceStartupResult> {
    if (await this.serviceAlive()) {
      this.serviceStarted = true;
      return { ready: true, spawned: false };
    }
    this.serviceStarted = false;

    if (!existsSync(this.entryPath)) {
      return {
        ready: false,
        spawned: false,
        stderrTruncated: false,
        error: startupError("TypeScript observability service is not built"),
      };
    }

    let child: ChildProcess;
    try {
      child = this.spawnService(process.execPath, [this.entryPath], {
        cwd: this.projectRoot,
        env: this.env,
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ready: false,
        spawned: false,
        stderrTruncated: false,
        error: startupError(`TypeScript observability service spawn failed: ${message}`),
      };
    }

    let spawnFailure: Error | undefined;
    let exitCode: number | undefined;
    let exitSignal: NodeJS.Signals | undefined;
    child.once("error", (error) => {
      spawnFailure = error;
    });
    child.once("exit", (code, signal) => {
      if (code !== null) exitCode = code;
      if (signal !== null) exitSignal = signal;
    });
    const stderrCapture = captureStartupStderr(child.stderr, this.stderrMaxBytes, this.env);
    child.unref();

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.serviceAlive()) {
        this.serviceStarted = true;
        stderrCapture.stop();
        return {
          ready: true,
          spawned: true,
          ...(child.pid === undefined ? {} : { childPid: child.pid }),
        };
      }
      if (spawnFailure || exitCode !== undefined || exitSignal !== undefined) break;
      await delay(this.pollIntervalMs);
    }

    const captured = stderrCapture.stop();
    await terminateUnhealthyChild(child);
    const cause = spawnFailure?.message
      ? `: ${spawnFailure.message}`
      : exitCode !== undefined
        ? ` with exit code ${exitCode}`
        : exitSignal !== undefined
          ? ` from signal ${exitSignal}`
          : ` within ${this.startupTimeoutMs}ms`;
    return {
      ready: false,
      spawned: true,
      ...(captured.text ? { stderr: captured.text } : {}),
      stderrTruncated: captured.truncated,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(exitSignal === undefined ? {} : { signal: exitSignal }),
      ...(child.pid === undefined ? {} : { childPid: child.pid }),
      error: startupError(`TypeScript observability service did not become ready${cause}`),
    };
  }
}
