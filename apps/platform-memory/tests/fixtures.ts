import type { IsolatedPlatformMemoryConfigV1 } from "../src/index.js";

export const ALPHA_TOKEN = "a".repeat(64);
export const BETA_TOKEN = "b".repeat(64);

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

export function requestBody(init?: RequestInit): {
  id: string;
  params: { name: string; arguments: Record<string, unknown> };
} {
  return JSON.parse(String(init?.body));
}
