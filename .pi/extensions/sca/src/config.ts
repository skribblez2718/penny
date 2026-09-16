import path from "node:path";

export const SCA_SERVICE_SOCKET_ENV = "PENNY_SCA_SERVICE_SOCKET_PATH" as const;
export const SCA_SERVICE_TOKEN_ENV = "PENNY_SCA_SERVICE_TOKEN" as const;
export const SCA_CLIENT_RESPONSE_TIMEOUT_ENV = "PENNY_SCA_CLIENT_RESPONSE_TIMEOUT_MS" as const;
export const SCA_CLIENT_POLL_INTERVAL_ENV = "PENNY_SCA_CLIENT_POLL_INTERVAL_MS" as const;
export const SCA_CLIENT_MAX_POLL_ATTEMPTS_ENV = "PENNY_SCA_CLIENT_MAX_POLL_ATTEMPTS" as const;
export const SCA_CLIENT_MAX_RESPONSE_BYTES_ENV = "PENNY_SCA_CLIENT_MAX_RESPONSE_BYTES" as const;

const TOKEN_MIN_LENGTH = 32;
const TOKEN_MAX_LENGTH = 512;
const SOCKET_PATH_MAX_BYTES = 107;
const CLIENT_TIMEOUT_MIN_MS = 50;
const CLIENT_TIMEOUT_MAX_MS = 30_000;
const POLL_INTERVAL_MIN_MS = 1;
const POLL_INTERVAL_MAX_MS = 5_000;
const POLL_ATTEMPTS_MIN = 1;
const POLL_ATTEMPTS_MAX = 10_000;
const RESPONSE_BYTES_MIN = 1_024;
const RESPONSE_BYTES_MAX = 4 * 1_024 * 1_024;

export const DEFAULT_SCA_CLIENT_RESPONSE_TIMEOUT_MS = 5_000;
export const DEFAULT_SCA_CLIENT_POLL_INTERVAL_MS = 25;
export const DEFAULT_SCA_CLIENT_MAX_POLL_ATTEMPTS = 2_000;
export const DEFAULT_SCA_CLIENT_MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;

export interface ScaClientConfig {
  readonly socketPath: string;
  readonly token: string;
  readonly responseTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;
  readonly maxResponseBytes: number;
}

export class ScaClientConfigError extends Error {
  readonly code = "service_unavailable";

  constructor() {
    super("SCA service configuration is unavailable");
    this.name = "ScaClientConfigError";
  }
}

function failConfiguration(): never {
  throw new ScaClientConfigError();
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return failConfiguration();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return failConfiguration();
  }
  return parsed;
}

function validateSocketPath(value: string | undefined): string {
  if (
    process.platform !== "linux" ||
    value === undefined ||
    value.length === 0 ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.dirname(value) === path.parse(value).root ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    Buffer.byteLength(value, "utf8") > SOCKET_PATH_MAX_BYTES
  ) {
    return failConfiguration();
  }
  return value;
}

function validateToken(value: string | undefined): string {
  const byteLength = value === undefined ? 0 : Buffer.byteLength(value, "utf8");
  if (
    value === undefined ||
    byteLength < TOKEN_MIN_LENGTH ||
    byteLength > TOKEN_MAX_LENGTH ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return failConfiguration();
  }
  return value;
}

/** Reads service-owned connection data only when a tool call starts. */
export function loadScaClientConfig(environment: NodeJS.ProcessEnv = process.env): ScaClientConfig {
  return {
    socketPath: validateSocketPath(environment[SCA_SERVICE_SOCKET_ENV]),
    token: validateToken(environment[SCA_SERVICE_TOKEN_ENV]),
    responseTimeoutMs: parseBoundedInteger(
      environment[SCA_CLIENT_RESPONSE_TIMEOUT_ENV],
      DEFAULT_SCA_CLIENT_RESPONSE_TIMEOUT_MS,
      CLIENT_TIMEOUT_MIN_MS,
      CLIENT_TIMEOUT_MAX_MS
    ),
    pollIntervalMs: parseBoundedInteger(
      environment[SCA_CLIENT_POLL_INTERVAL_ENV],
      DEFAULT_SCA_CLIENT_POLL_INTERVAL_MS,
      POLL_INTERVAL_MIN_MS,
      POLL_INTERVAL_MAX_MS
    ),
    maxPollAttempts: parseBoundedInteger(
      environment[SCA_CLIENT_MAX_POLL_ATTEMPTS_ENV],
      DEFAULT_SCA_CLIENT_MAX_POLL_ATTEMPTS,
      POLL_ATTEMPTS_MIN,
      POLL_ATTEMPTS_MAX
    ),
    maxResponseBytes: parseBoundedInteger(
      environment[SCA_CLIENT_MAX_RESPONSE_BYTES_ENV],
      DEFAULT_SCA_CLIENT_MAX_RESPONSE_BYTES,
      RESPONSE_BYTES_MIN,
      RESPONSE_BYTES_MAX
    ),
  };
}
