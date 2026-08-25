import type { IsolatedPlatformMemoryConfigV1 } from "../src/index.js";

export const ALPHA_TOKEN = "a".repeat(64);
export const BETA_TOKEN = "b".repeat(64);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

export function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

export function requireArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

export function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function isolatedConfig(
  name: "alpha" | "beta",
  overrides: Partial<IsolatedPlatformMemoryConfigV1> = {}
): IsolatedPlatformMemoryConfigV1 {
  const upper = name.toUpperCase();
  return {
    contractVersion: 1,
    mode: "isolated",
    principalId: `principal-${name}`,
    target: {
      endpoint: `https://memory-${name}.invalid/mcp`,
      palaceId: `palace-${name}`,
      dataRootId: `data-root-${name}`,
    },
    credential: { kind: "environment", name: `${upper}_MEMORY_TOKEN` },
    trust: { kind: "isolated", isolationBoundaryId: `boundary-${name}` },
    custody: {
      ownerId: `owner-${name}`,
      backupPolicyRef: `policy:backup:${name}`,
      migrationPolicyRef: `policy:migration:${name}`,
      retentionPolicyRef: `policy:retention:${name}`,
      uninstallDisposition: "preserve",
    },
    capabilities: ["recall-read", "curated-write", "kg-read", "kg-write", "primary-diary"],
    primaryDiaryId: `diary-${name}`,
    transport: { maxReadAttempts: 1 },
    ...overrides,
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

export interface TestMcpRequestBody {
  id: string;
  params: { name: string; arguments: Record<string, unknown> };
}

function isTestMcpRequestBody(value: unknown): value is TestMcpRequestBody {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isRecord(value.params) &&
    typeof value.params.name === "string" &&
    isRecord(value.params.arguments)
  );
}

export function requestBody(init?: RequestInit): TestMcpRequestBody {
  if (typeof init?.body !== "string") throw new Error("expected a valid MCP request body");
  let value: unknown;
  try {
    value = parseJson(init.body);
  } catch {
    throw new Error("expected a valid MCP request body");
  }
  if (!isTestMcpRequestBody(value)) throw new Error("expected a valid MCP request body");
  return value;
}
