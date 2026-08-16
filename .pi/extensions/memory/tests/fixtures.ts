import { resolveToolResultBudget } from "../../lib/tool-result-budget.js";
import type { MemoryRuntimeConfig } from "../types.js";

export const TEST_TOKEN = "t".repeat(64);

interface TestConfigOverrides extends Partial<MemoryRuntimeConfig> {
  endpoint?: string;
  timeoutMs?: number;
  maxReadAttempts?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export function testConfig(overrides: TestConfigOverrides = {}): MemoryRuntimeConfig {
  const {
    endpoint = "http://127.0.0.1:8765/mcp",
    timeoutMs = 1_000,
    maxReadAttempts = 3,
    maxRequestBytes = 16 * 1024 * 1024,
    maxResponseBytes = 16 * 1024 * 1024,
    ...runtimeOverrides
  } = overrides;
  return {
    mode: "hub",
    writeEnabled: true,
    logstream: { mode: "disabled", stream: null, rooms: [] },
    platformConfig: {
      contractVersion: 1,
      mode: "isolated",
      principalId: "test-primary",
      target: {
        endpoint,
        palaceId: "test-palace",
        dataRootId: "test-data-root",
      },
      credential: { kind: "environment", name: "TEST_MEMORY_TOKEN" },
      trust: { kind: "isolated", isolationBoundaryId: "test-isolation-boundary" },
      custody: {
        ownerId: "test-owner",
        backupPolicyRef: "policy:test-backup",
        migrationPolicyRef: "policy:test-migration",
        retentionPolicyRef: "policy:test-retention",
        uninstallDisposition: "preserve",
      },
      capabilities: ["recall-read", "curated-write", "kg-read", "kg-write", "primary-diary"],
      primaryDiaryId: "penny",
      transport: {
        requestTimeoutMs: timeoutMs,
        maxReadAttempts,
        maxRequestBytes,
        maxResponseBytes,
      },
    },
    bearerToken: TEST_TOKEN,
    cursorKey: Buffer.alloc(32, 7),
    cursorTtlMs: 60_000,
    sourceCacheMaxBytes: 32 * 1024 * 1024,
    sourceCacheMaxEntries: 8,
    budget: resolveToolResultBudget({
      PENNY_TOOL_RESULT_MAX_BYTES: "4096",
      PENNY_TOOL_RESULT_MAX_CHARACTERS: "4096",
      PENNY_TOOL_RESULT_MAX_TOKENS: "4096",
    }),
    ...runtimeOverrides,
  };
}

export function mcpResponse(id: string, payload: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export function rpcErrorResponse(id: string, code: number, message = "error"): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function mcpToolErrorResponse(id: string, payload: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export function requestBody(init?: RequestInit): {
  id: string;
  method: string;
  params: { name: string; arguments: Record<string, unknown> };
} {
  return JSON.parse(String(init?.body));
}

export function extensionEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    PENNY_MEMORY_MODE: "hub",
    PENNY_MEMORY_WRITE_MODE: "enabled",
    PENNY_MEMORY_TRUST_MODE: "isolated",
    PENNY_MEMORY_PRINCIPAL_ID: "penny-primary",
    PENNY_MEMORY_MCP_ENDPOINT: "http://127.0.0.1:8765",
    PENNY_MEMORY_PALACE_ID: "penny-personal",
    PENNY_MEMORY_DATA_ROOT_ID: "penny-memory-root",
    PENNY_MEMORY_ISOLATION_BOUNDARY_ID: "penny-primary-palace",
    PENNY_MEMORY_OWNER_ID: "penny-operator",
    PENNY_MEMORY_BACKUP_POLICY_REF: "policy:penny-memory-backup",
    PENNY_MEMORY_MIGRATION_POLICY_REF: "policy:penny-memory-migration",
    PENNY_MEMORY_RETENTION_POLICY_REF: "policy:penny-memory-retention",
    PENNY_MEMORY_UNINSTALL_DISPOSITION: "preserve",
    PENNY_MEMORY_MCP_TOKEN_ENV: "TEST_MEMORY_TOKEN",
    TEST_MEMORY_TOKEN: TEST_TOKEN,
    PENNY_TOOL_RESULT_MAX_BYTES: "4096",
    PENNY_TOOL_RESULT_MAX_CHARACTERS: "4096",
    PENNY_TOOL_RESULT_MAX_TOKENS: "4096",
    PENNY_MEMORY_MAX_READ_ATTEMPTS: "1",
    PI_OBSERVABILITY_ENABLED: "false",
    ...overrides,
  };
}
