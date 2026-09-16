import path from "node:path";

export const SCA_SERVICE_ENV = Object.freeze({
  socketPath: "PENNY_SCA_SERVICE_SOCKET_PATH",
  authenticationToken: "PENNY_SCA_SERVICE_TOKEN",
  requestTimeoutMs: "PENNY_SCA_SERVICE_REQUEST_TIMEOUT_MS",
  shutdownTimeoutMs: "PENNY_SCA_SERVICE_SHUTDOWN_TIMEOUT_MS",
} as const);

export const SCA_SERVICE_DEFAULTS = Object.freeze({
  requestTimeoutMs: 5_000,
  shutdownTimeoutMs: 2_000,
  maxFrameBytes: 256 * 1024,
  maxConnections: 32,
} as const);

const MAX_UNIX_SOCKET_PATH_BYTES = 107;
const INTERNAL_SOCKET_BASENAME_BYTES = 31;
const MIN_AUTHENTICATION_TOKEN_BYTES = 32;
const MAX_AUTHENTICATION_TOKEN_BYTES = 512;

export interface ScaServiceConfigInput {
  readonly socketPath: string;
  readonly authenticationToken: string;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxConnections?: number;
}

export interface ScaServiceConfig {
  readonly socketPath: string;
  readonly authenticationToken: string;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly maxConnections: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unsupported SCA service config key: ${key}`);
  }
}

function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return candidate;
}

function parseEnvironmentInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a base-10 integer`);
  }
  return boundedInteger(Number(value), name, fallback, minimum, maximum);
}

function validateSocketPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("socketPath is required");
  }
  if (process.platform !== "linux") {
    throw new Error("the SCA service supports Linux Unix-domain sockets only");
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("socketPath contains a forbidden control character");
  }
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error("socketPath must be an absolute normalized path");
  }
  const parent = path.dirname(value);
  if (parent === path.parse(value).root || path.basename(value).length === 0) {
    throw new Error("socketPath must be inside a dedicated owner-only directory");
  }
  if (Buffer.byteLength(value) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("socketPath exceeds the Linux Unix-domain socket path limit");
  }
  if (Buffer.byteLength(parent) + 1 + INTERNAL_SOCKET_BASENAME_BYTES > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("socketPath directory leaves no room for the private bound socket");
  }
  return value;
}

export function validateScaAuthenticationToken(value: unknown): string {
  if (typeof value !== "string") throw new Error("authenticationToken is required");
  const length = Buffer.byteLength(value);
  if (
    length < MIN_AUTHENTICATION_TOKEN_BYTES ||
    length > MAX_AUTHENTICATION_TOKEN_BYTES ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error(
      `authenticationToken must be ${MIN_AUTHENTICATION_TOKEN_BYTES}-${MAX_AUTHENTICATION_TOKEN_BYTES} bytes without line breaks`
    );
  }
  return value;
}

export function validateScaServiceConfig(value: unknown): ScaServiceConfig {
  if (!isRecord(value)) throw new Error("SCA service config must be an object");
  assertExactKeys(
    value,
    new Set([
      "socketPath",
      "authenticationToken",
      "requestTimeoutMs",
      "shutdownTimeoutMs",
      "maxFrameBytes",
      "maxConnections",
    ])
  );
  return Object.freeze({
    socketPath: validateSocketPath(value.socketPath),
    authenticationToken: validateScaAuthenticationToken(value.authenticationToken),
    requestTimeoutMs: boundedInteger(
      value.requestTimeoutMs,
      "requestTimeoutMs",
      SCA_SERVICE_DEFAULTS.requestTimeoutMs,
      10,
      300_000
    ),
    shutdownTimeoutMs: boundedInteger(
      value.shutdownTimeoutMs,
      "shutdownTimeoutMs",
      SCA_SERVICE_DEFAULTS.shutdownTimeoutMs,
      10,
      30_000
    ),
    maxFrameBytes: boundedInteger(
      value.maxFrameBytes,
      "maxFrameBytes",
      SCA_SERVICE_DEFAULTS.maxFrameBytes,
      1_024,
      1024 * 1024
    ),
    maxConnections: boundedInteger(
      value.maxConnections,
      "maxConnections",
      SCA_SERVICE_DEFAULTS.maxConnections,
      1,
      128
    ),
  });
}

/** Load only the documented trusted environment keys; no host or TCP setting is supported. */
export function loadScaServiceConfig(
  environment: NodeJS.ProcessEnv = process.env
): ScaServiceConfig {
  return validateScaServiceConfig({
    socketPath: environment[SCA_SERVICE_ENV.socketPath],
    authenticationToken: environment[SCA_SERVICE_ENV.authenticationToken],
    requestTimeoutMs: parseEnvironmentInteger(
      environment[SCA_SERVICE_ENV.requestTimeoutMs],
      SCA_SERVICE_ENV.requestTimeoutMs,
      SCA_SERVICE_DEFAULTS.requestTimeoutMs,
      10,
      300_000
    ),
    shutdownTimeoutMs: parseEnvironmentInteger(
      environment[SCA_SERVICE_ENV.shutdownTimeoutMs],
      SCA_SERVICE_ENV.shutdownTimeoutMs,
      SCA_SERVICE_DEFAULTS.shutdownTimeoutMs,
      10,
      30_000
    ),
  });
}
