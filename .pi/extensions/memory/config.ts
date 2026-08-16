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
import { MemoryError, type MemoryRuntimeConfig } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_SOURCE_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CURSOR_TTL_MS = 5 * 60 * 1_000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type MemoryActor = "primary" | "denied";

/**
 * The primary runtime is identified by the absence of a marker. Markers are
 * deny-only: even a value of "primary" cannot grant memory capabilities.
 */
export function resolveMemoryActor(env: Readonly<Record<string, string | undefined>>): MemoryActor {
  return env.PENNY_RUNTIME_ROLE === undefined ? "primary" : "denied";
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
      uninstallDisposition: required(env, "PENNY_MEMORY_UNINSTALL_DISPOSITION") as "preserve",
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
  if (mode === "disabled") {
    return {
      mode,
      writeEnabled: false,
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
      budget: resolveToolResultBudget(env),
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
