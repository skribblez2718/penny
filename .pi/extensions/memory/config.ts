import { createHash } from "node:crypto";

import {
  PlatformMemoryError,
  resolveMemoryCredentialReference,
  validatePlatformMemoryConfigV1,
  type MemoryCredentialReference,
  type PlatformMemoryConfigV1,
  type PlatformMemoryMode,
} from "platform-memory";

import { ToolResultBudgetConfigError, resolveToolResultBudget } from "../lib/tool-result-budget.js";
import { MemoryError, type MemoryLogstreamConfig, type MemoryRuntimeConfig } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_SOURCE_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CURSOR_TTL_MS = 5 * 60 * 1_000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOGSTREAM_STREAM_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const LOGSTREAM_ROOM_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOGSTREAM_PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_LOGSTREAM_STREAM_CHARACTERS = 128;
const MAX_LOGSTREAM_ROOMS = 16;

export type MemoryActor = "primary" | "worker-read" | "denied";

/**
 * The primary runtime is identified by the absence of a marker. Markers are
 * deny-only: even a value of "primary" cannot grant memory capabilities.
 *
 * The execution owner may set ``PENNY_RUNTIME_ROLE=worker-read`` on a spawned
 * agent process to grant read-only memory access. This value is set by the
 * agent runner (isolatedAgentEnvironment), never by the child process itself,
 * so a child cannot escalate its own role. The memory extension's policy
 * decision to register only read tools for this actor is its own, not a grant
 * from the child.
 */
export function resolveMemoryActor(env: Readonly<Record<string, string | undefined>>): MemoryActor {
  const role = env.PENNY_RUNTIME_ROLE;
  if (role === undefined) return "primary";
  if (role === "worker-read") return "worker-read";
  return "denied";
}

/**
 * Load a read-only memory runtime config for worker agents.
 *
 * Requires only the minimal set of env vars needed for authenticated read
 * access: endpoint, credential, palace ID, principal ID, trust mode, and
 * isolation boundary. Custody/backup/migration/retention fields are not
 * required because workers do not write. Write is always disabled. Logstream
 * is always disabled. Diary write and KG write are never available.
 */
export function loadWorkerReadConfig(
  env: Readonly<Record<string, string | undefined>>
): MemoryRuntimeConfig {
  const endpoint = required(env, "PENNY_MEMORY_MCP_ENDPOINT");
  const palaceId = required(env, "PENNY_MEMORY_PALACE_ID");
  const principalId = required(env, "PENNY_MEMORY_PRINCIPAL_ID");
  const mode = platformMode(env);

  if (mode !== "isolated") {
    configError("Worker read access requires PENNY_MEMORY_TRUST_MODE=isolated");
  }

  const credential = credentialReference(env);
  const isolationBoundaryId = required(env, "PENNY_MEMORY_ISOLATION_BOUNDARY_ID");

  const platformConfig: PlatformMemoryConfigV1 = {
    contractVersion: 1,
    mode: "isolated",
    principalId,
    target: {
      endpoint,
      palaceId,
      dataRootId: env.PENNY_MEMORY_DATA_ROOT_ID?.trim() || `${palaceId}-data-root`,
    },
    credential,
    custody: {
      ownerId: env.PENNY_MEMORY_OWNER_ID?.trim() || "penny-operator",
      backupPolicyRef: env.PENNY_MEMORY_BACKUP_POLICY_REF?.trim() || "worker-read-default",
      migrationPolicyRef: env.PENNY_MEMORY_MIGRATION_POLICY_REF?.trim() || "worker-read-default",
      retentionPolicyRef: env.PENNY_MEMORY_RETENTION_POLICY_REF?.trim() || "worker-read-default",
      uninstallDisposition: "preserve" as const,
    },
    capabilities: ["recall-read", "kg-read", "primary-diary"] as const,
    primaryDiaryId: "penny",
    transport: {
      requestTimeoutMs: parseInteger(
        env.PENNY_MEMORY_REQUEST_TIMEOUT_MS,
        "PENNY_MEMORY_REQUEST_TIMEOUT_MS",
        DEFAULT_TIMEOUT_MS,
        100,
        30_000
      ),
      maxReadAttempts: 3,
      maxRequestBytes: MAX_REQUEST_BYTES,
      maxResponseBytes: parseInteger(
        env.PENNY_MEMORY_MAX_RESPONSE_BYTES,
        "PENNY_MEMORY_MAX_RESPONSE_BYTES",
        DEFAULT_MAX_RESPONSE_BYTES,
        65_536,
        DEFAULT_MAX_RESPONSE_BYTES
      ),
    },
    trust: {
      kind: "isolated",
      isolationBoundaryId,
    },
  };

  const validated = validatePlatformConfig(platformConfig);

  let bearerToken: string;
  try {
    bearerToken = resolveMemoryCredentialReference(credential, { env });
  } catch (error) {
    if (error instanceof PlatformMemoryError) configError(error.message);
    throw error;
  }

  let budget;
  try {
    budget = resolveToolResultBudget(env);
  } catch (error) {
    if (error instanceof ToolResultBudgetConfigError) configError(error.message);
    throw error;
  }

  return {
    mode: "hub",
    writeEnabled: false,
    logstream: { mode: "disabled", stream: null, rooms: [] },
    platformConfig: validated,
    bearerToken,
    cursorKey: createHash("sha256")
      .update("penny-memory-cursor-v1\0", "utf8")
      .update(bearerToken, "utf8")
      .digest(),
    cursorTtlMs: DEFAULT_CURSOR_TTL_MS,
    sourceCacheMaxBytes: DEFAULT_SOURCE_CACHE_BYTES,
    sourceCacheMaxEntries: 8,
    budget,
  };
}

function configError(message: string): never {
  throw new MemoryError("MEMPALACE_INVALID", message);
}

function parseInteger(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  if (!/^\d+$/.test(raw.trim())) configError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    configError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) configError(`${name} is required in hub mode`);
  return value;
}

function preserveUninstallDisposition(
  env: Readonly<Record<string, string | undefined>>
): "preserve" {
  const value = required(env, "PENNY_MEMORY_UNINSTALL_DISPOSITION");
  if (value !== "preserve") configError("custody.uninstallDisposition must be preserve");
  return value;
}

function credentialReference(
  env: Readonly<Record<string, string | undefined>>
): MemoryCredentialReference {
  const file = env.PENNY_MEMORY_MCP_TOKEN_FILE?.trim();
  const environmentName = env.PENNY_MEMORY_MCP_TOKEN_ENV?.trim();
  if ((!file && !environmentName) || (file && environmentName)) {
    configError(
      "Exactly one of PENNY_MEMORY_MCP_TOKEN_FILE or PENNY_MEMORY_MCP_TOKEN_ENV is required"
    );
  }
  if (file) return { kind: "file", path: file };
  if (!environmentName || !ENV_NAME_PATTERN.test(environmentName)) {
    configError("PENNY_MEMORY_MCP_TOKEN_ENV must name a valid environment variable");
  }
  return { kind: "environment", name: environmentName };
}

function platformMode(
  env: Readonly<Record<string, string | undefined>>
): Exclude<PlatformMemoryMode, "none"> {
  const mode = env.PENNY_MEMORY_TRUST_MODE?.trim();
  if (mode === "isolated" || mode === "shared-trust-domain") return mode;
  configError("PENNY_MEMORY_TRUST_MODE must be isolated or shared-trust-domain in hub mode");
}

function buildPlatformConfig(
  env: Readonly<Record<string, string | undefined>>,
  transport: {
    requestTimeoutMs: number;
    maxReadAttempts: number;
    maxResponseBytes: number;
  }
): PlatformMemoryConfigV1 {
  const mode = platformMode(env);
  const common = {
    contractVersion: 1 as const,
    principalId: required(env, "PENNY_MEMORY_PRINCIPAL_ID"),
    target: {
      endpoint: required(env, "PENNY_MEMORY_MCP_ENDPOINT"),
      palaceId: required(env, "PENNY_MEMORY_PALACE_ID"),
      dataRootId: required(env, "PENNY_MEMORY_DATA_ROOT_ID"),
    },
    credential: credentialReference(env),
    custody: {
      ownerId: required(env, "PENNY_MEMORY_OWNER_ID"),
      backupPolicyRef: required(env, "PENNY_MEMORY_BACKUP_POLICY_REF"),
      migrationPolicyRef: required(env, "PENNY_MEMORY_MIGRATION_POLICY_REF"),
      retentionPolicyRef: required(env, "PENNY_MEMORY_RETENTION_POLICY_REF"),
      uninstallDisposition: preserveUninstallDisposition(env),
    },
    capabilities: ["recall-read", "curated-write", "kg-read", "kg-write", "primary-diary"] as const,
    primaryDiaryId: "penny",
    transport: { ...transport, maxRequestBytes: MAX_REQUEST_BYTES },
  };

  if (mode === "isolated") {
    return {
      ...common,
      mode,
      trust: {
        kind: "isolated",
        isolationBoundaryId: required(env, "PENNY_MEMORY_ISOLATION_BOUNDARY_ID"),
      },
    };
  }
  if (env.PENNY_MEMORY_WHOLE_PALACE_TRUST_ACK !== "whole-palace") {
    configError("shared-trust-domain requires PENNY_MEMORY_WHOLE_PALACE_TRUST_ACK=whole-palace");
  }
  return {
    ...common,
    mode,
    trust: {
      kind: "shared-trust-domain",
      trustDomainId: required(env, "PENNY_MEMORY_TRUST_DOMAIN_ID"),
      wholePalaceAccessAcknowledged: true,
    },
  };
}

function parseMode(raw: string | undefined): "hub" | "disabled" {
  const mode = raw?.trim() || "hub";
  if (mode === "hub" || mode === "disabled") return mode;
  configError(
    "Production memory mode must be hub or disabled; legacy/shadow compatibility expired under MEM-07 ownership"
  );
}

function parseWriteEnabled(raw: string | undefined): boolean {
  const mode = raw?.trim() || "disabled";
  if (mode === "disabled") return false;
  if (mode === "enabled") return true;
  configError("PENNY_MEMORY_WRITE_MODE must be disabled or enabled");
}

function parseLogstreamConfig(
  env: Readonly<Record<string, string | undefined>>,
  memoryMode: "hub" | "disabled"
): MemoryLogstreamConfig {
  const mode = env.PENNY_MEMORY_LOGSTREAM_MODE?.trim() || "disabled";
  if (mode === "disabled") return { mode, stream: null, rooms: [] };
  if (mode !== "primary-advisory") {
    configError("PENNY_MEMORY_LOGSTREAM_MODE must be disabled or primary-advisory");
  }
  if (memoryMode !== "hub") {
    configError("primary-advisory logstream mode requires PENNY_MEMORY_MODE=hub");
  }

  const stream = env.PENNY_MEMORY_LOGSTREAM_STREAM?.trim() ?? "";
  if (
    stream.length === 0 ||
    stream.length > MAX_LOGSTREAM_STREAM_CHARACTERS ||
    !LOGSTREAM_STREAM_PATTERN.test(stream) ||
    stream.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    configError(
      "PENNY_MEMORY_LOGSTREAM_STREAM must be a safe lowercase slash-separated identifier"
    );
  }

  const rawRooms = env.PENNY_MEMORY_LOGSTREAM_ROOMS;
  if (rawRooms === undefined || rawRooms.trim() === "") {
    configError("PENNY_MEMORY_LOGSTREAM_ROOMS must be a nonempty comma-separated allowlist");
  }
  const rooms = rawRooms.split(",").map((room) => room.trim());
  if (
    rooms.length > MAX_LOGSTREAM_ROOMS ||
    rooms.some((room) => !LOGSTREAM_ROOM_PATTERN.test(room))
  ) {
    configError(
      `PENNY_MEMORY_LOGSTREAM_ROOMS must contain 1-${MAX_LOGSTREAM_ROOMS} safe room identifiers`
    );
  }
  if (new Set(rooms).size !== rooms.length) {
    configError("PENNY_MEMORY_LOGSTREAM_ROOMS cannot contain duplicates");
  }
  return { mode, stream, rooms: Object.freeze([...rooms]) };
}

function validatePlatformConfig(config: PlatformMemoryConfigV1): PlatformMemoryConfigV1 {
  try {
    return validatePlatformMemoryConfigV1(config);
  } catch (error) {
    if (error instanceof PlatformMemoryError) configError(error.message);
    throw error;
  }
}

export function loadMemoryRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>
): MemoryRuntimeConfig {
  const mode = parseMode(env.PENNY_MEMORY_MODE);
  const logstream = parseLogstreamConfig(env, mode);
  if (mode === "disabled") {
    let budget;
    try {
      budget = resolveToolResultBudget(env);
    } catch (error) {
      if (error instanceof ToolResultBudgetConfigError) configError(error.message);
      throw error;
    }
    return {
      mode,
      writeEnabled: false,
      logstream,
      platformConfig: {
        contractVersion: 1,
        mode: "none",
        principalId: env.PENNY_MEMORY_PRINCIPAL_ID?.trim() || "penny-primary",
      },
      bearerToken: "",
      cursorKey: Buffer.alloc(0),
      cursorTtlMs: DEFAULT_CURSOR_TTL_MS,
      sourceCacheMaxBytes: DEFAULT_SOURCE_CACHE_BYTES,
      sourceCacheMaxEntries: 8,
      budget,
    };
  }

  let budget;
  try {
    budget = resolveToolResultBudget(env);
  } catch (error) {
    if (error instanceof ToolResultBudgetConfigError) configError(error.message);
    throw error;
  }

  const maxResponseBytes = parseInteger(
    env.PENNY_MEMORY_MAX_RESPONSE_BYTES,
    "PENNY_MEMORY_MAX_RESPONSE_BYTES",
    DEFAULT_MAX_RESPONSE_BYTES,
    65_536,
    DEFAULT_MAX_RESPONSE_BYTES
  );
  const sourceCacheMaxBytes = parseInteger(
    env.PENNY_MEMORY_SOURCE_CACHE_MAX_BYTES,
    "PENNY_MEMORY_SOURCE_CACHE_MAX_BYTES",
    DEFAULT_SOURCE_CACHE_BYTES,
    maxResponseBytes,
    DEFAULT_SOURCE_CACHE_BYTES
  );
  const platformConfig = validatePlatformConfig(
    buildPlatformConfig(env, {
      requestTimeoutMs: parseInteger(
        env.PENNY_MEMORY_REQUEST_TIMEOUT_MS,
        "PENNY_MEMORY_REQUEST_TIMEOUT_MS",
        DEFAULT_TIMEOUT_MS,
        100,
        30_000
      ),
      maxReadAttempts: parseInteger(
        env.PENNY_MEMORY_MAX_READ_ATTEMPTS,
        "PENNY_MEMORY_MAX_READ_ATTEMPTS",
        3,
        1,
        3
      ),
      maxResponseBytes,
    })
  );
  if (platformConfig.mode === "none") configError("hub mode cannot resolve to none");
  if (
    logstream.mode === "primary-advisory" &&
    !LOGSTREAM_PRINCIPAL_PATTERN.test(platformConfig.principalId)
  ) {
    configError(
      "PENNY_MEMORY_PRINCIPAL_ID must be a safe bounded routing identifier in primary-advisory mode"
    );
  }

  let bearerToken: string;
  try {
    bearerToken = resolveMemoryCredentialReference(platformConfig.credential, { env });
  } catch (error) {
    if (error instanceof PlatformMemoryError) configError(error.message);
    throw error;
  }

  return {
    mode,
    writeEnabled: parseWriteEnabled(env.PENNY_MEMORY_WRITE_MODE),
    logstream,
    platformConfig,
    bearerToken,
    cursorKey: createHash("sha256")
      .update("penny-memory-cursor-v1\0", "utf8")
      .update(bearerToken, "utf8")
      .digest(),
    cursorTtlMs:
      parseInteger(
        env.PENNY_MEMORY_CURSOR_TTL_SECONDS,
        "PENNY_MEMORY_CURSOR_TTL_SECONDS",
        DEFAULT_CURSOR_TTL_MS / 1_000,
        30,
        15 * 60
      ) * 1_000,
    sourceCacheMaxBytes,
    sourceCacheMaxEntries: parseInteger(
      env.PENNY_MEMORY_SOURCE_CACHE_MAX_ENTRIES,
      "PENNY_MEMORY_SOURCE_CACHE_MAX_ENTRIES",
      8,
      1,
      32
    ),
    budget,
  };
}
