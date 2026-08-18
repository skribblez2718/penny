/**
 * End-to-end composition test: the memory extension's worker-read factory,
 * loaded through the orchestration app's worker loader (the exact seam the
 * TypeScript research engine uses), registers READ-ONLY memory tools and
 * registers NO write-capable tools.
 *
 * This is the security property the task requires: TS-engine workers gain
 * memory read access (grant) and cannot write (blocked by non-registration).
 *
 * Hermetic: a minimal worker-read env (fake endpoint + token-ENV name) is used
 * so the config validates and the tools are built without any network/MCP call.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createWorkerResourceLoader } from "@penny/orchestration/source";
import { createMemoryExtension, primaryMemoryToolNames } from "@penny/memory-extension";

function findPennyRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, ".pi", "extensions", "memory", "index.ts"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Penny project root not found from " + start);
    dir = parent;
  }
}

const WORKER_READ_TOKEN_NAME = "PENNY_IT_WORKER_READ_TOKEN";
// A minimal, self-consistent worker-read environment (no network needed at build time).
// The credential is resolved from the env object itself (not process.env), so the
// secret value must be a key in the returned record.
function workerReadEnv(): Record<string, string | undefined> {
  const secret = "hermetic-worker-read-token-0123456789abcdef-9876543210"; // 58 bytes >= 32
  const env: Record<string, string | undefined> = {
    PENNY_MEMORY_MCP_ENDPOINT: "http://127.0.0.1:9/mcp",
    PENNY_MEMORY_MCP_TOKEN_ENV: WORKER_READ_TOKEN_NAME,
    PENNY_MEMORY_PALACE_ID: "it-palace",
    PENNY_MEMORY_PRINCIPAL_ID: "it-principal",
    PENNY_MEMORY_TRUST_MODE: "isolated",
    PENNY_MEMORY_ISOLATION_BOUNDARY_ID: "it-boundary",
    PENNY_RUNTIME_ROLE: "worker-read",
  };
  env[WORKER_READ_TOKEN_NAME] = secret; // the bounded secret itself
  return env;
}

describe("worker-read memory grant (composition: app seam + memory factory)", () => {
  it("registers the read-only memory tools and no write tools in a worker session", async () => {
    const projectRoot = findPennyRoot(__dirname);

    // The memory extension builds the worker-read (read-only) toolset for this actor.
    const readEnv = workerReadEnv();
    const factory = createMemoryExtension({ env: readEnv }); // throws if config invalid
    const expectedRead = primaryMemoryToolNames({ writeEnabled: false });
    const expectedWrite = primaryMemoryToolNames({ writeEnabled: true }).filter(
      (tool) => !expectedRead.includes(tool)
    );
    expect(expectedRead.length).toBeGreaterThan(0);
    expect(expectedWrite.length).toBeGreaterThan(0);

    // Load it exactly as the production path does: the grant's *extension* (an
    // InlineExtension) is passed to the worker resource loader.
    const loader = await createWorkerResourceLoader(projectRoot, [factory]);
    const loaded = loader.getExtensions().extensions;

    // Collect every tool registered across the loaded extensions.
    const tools = new Set<string>();
    for (const extension of loaded) {
      for (const name of extension.tools.keys()) tools.add(name);
    }

    // Every read tool is available to the worker ...
    for (const tool of expectedRead) expect(tools.has(tool), `read tool missing: ${tool}`).toBe(true);
    // ... and NO write-capable tool is available (blocked by non-registration).
    for (const tool of expectedWrite) {
      expect(tools.has(tool), `write tool must be absent: ${tool}`).toBe(false);
    }
    // Spot-check the canonical pair from the task (recall read vs. curated write).
    expect(tools.has("memory_smart_search")).toBe(true);
    expect(tools.has("memory_add_drawer")).toBe(false);
  });

  it("does not expose memory at all when no grant is supplied (base stays memory-free)", async () => {
    const projectRoot = findPennyRoot(__dirname);
    const loader = await createWorkerResourceLoader(projectRoot);
    const tools = new Set<string>();
    for (const extension of loader.getExtensions().extensions) {
      for (const name of extension.tools.keys()) tools.add(name);
    }
    for (const tool of primaryMemoryToolNames({ writeEnabled: true })) {
      expect(tools.has(tool), `memory tool present without grant: ${tool}`).toBe(false);
    }
  });
});
