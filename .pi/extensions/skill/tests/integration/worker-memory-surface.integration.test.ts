import { existsSync } from "node:fs";
import path from "node:path";

import { createMemoryExtension, primaryMemoryToolNames } from "@penny/memory-extension";
import { createWorkerResourceLoader } from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

function findPennyRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, ".pi", "extensions", "memory", "index.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Penny project root not found from ${start}`);
    dir = parent;
  }
}

const TOKEN_NAME = "PENNY_IT_WORKER_READ_TOKEN";
function workerReadEnv(): Record<string, string | undefined> {
  return {
    PENNY_MEMORY_MCP_ENDPOINT: "http://127.0.0.1:9/mcp",
    PENNY_MEMORY_MCP_TOKEN_ENV: TOKEN_NAME,
    [TOKEN_NAME]: "hermetic-worker-read-token-0123456789abcdef-9876543210",
    PENNY_MEMORY_PALACE_ID: "it-palace",
    PENNY_MEMORY_PRINCIPAL_ID: "it-principal",
    PENNY_MEMORY_TRUST_MODE: "isolated",
    PENNY_MEMORY_ISOLATION_BOUNDARY_ID: "it-boundary",
    PENNY_RUNTIME_ROLE: "worker-read",
  };
}

async function withAmbientWorkerRead<T>(work: () => Promise<T>): Promise<T> {
  const previousRole = process.env.PENNY_RUNTIME_ROLE;
  process.env.PENNY_RUNTIME_ROLE = "worker-read";
  try {
    return await work();
  } finally {
    if (previousRole === undefined) delete process.env.PENNY_RUNTIME_ROLE;
    else process.env.PENNY_RUNTIME_ROLE = previousRole;
  }
}

function expectReadOnlyCatalog(registered: ReadonlySet<string>, unavailable = false): void {
  const expectedRead = primaryMemoryToolNames({ writeEnabled: false });
  const expectedWrite = primaryMemoryToolNames({ writeEnabled: true }).filter(
    (tool) => !expectedRead.includes(tool)
  );
  for (const tool of expectedRead) {
    expect(
      registered.has(tool),
      `${unavailable ? "missing unavailable" : "missing"} read provider: ${tool}`
    ).toBe(true);
  }
  for (const tool of expectedWrite) {
    expect(registered.has(tool), `worker-read must not register write provider: ${tool}`).toBe(
      false
    );
  }
}

describe("worker memory provider and exact YAML activation", () => {
  it("registers only the declared read providers without ambient primary configuration", async () => {
    await withAmbientWorkerRead(async () => {
      const projectRoot = findPennyRoot(__dirname);
      const loader = await createWorkerResourceLoader(projectRoot, [
        createMemoryExtension({ env: workerReadEnv() }),
      ]);
      const registered = new Set(
        loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
      );
      expectReadOnlyCatalog(registered);
    });
  });

  it("registers typed unavailable read providers when the optional service is unconfigured", async () => {
    await withAmbientWorkerRead(async () => {
      const projectRoot = findPennyRoot(__dirname);
      const loader = await createWorkerResourceLoader(projectRoot, [
        createMemoryExtension({ env: { PENNY_RUNTIME_ROLE: "worker-read" } }),
      ]);
      const registered = new Set(
        loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
      );
      expectReadOnlyCatalog(registered, true);
    });
  });
});
