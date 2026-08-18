/**
 * Real-environment proof (operator-provisioned .env): the exact grant
 * construction the TypeScript-engine skill driver performs (reading the
 * minimal read-only worker-read vars from the process env built from .env,
 * validating with loadWorkerReadConfig, and loading the memory factory
 * through the app seam) yields READ-ONLY memory tools and NO write tools.
 *
 * Skips (rather than fails) when the worker-read vars are not provisioned,
 * so it stays green on unconfigured machines while proving the real path here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createWorkerResourceLoader } from "@penny/orchestration/source";
import {
  createMemoryExtension,
  loadWorkerReadConfig,
  primaryMemoryToolNames,
} from "@penny/memory-extension";

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

function loadDotEnv(root: string): void {
  try {
    const text = readFileSync(path.join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) (process.env as Record<string, string>)[key] = value;
    }
  } catch {
    /* .env absent: tests that need it will skip */
  }
}

const WORKER_READ_VARS = [
  "PENNY_MEMORY_MCP_ENDPOINT",
  "PENNY_MEMORY_MCP_TOKEN_FILE",
  "PENNY_MEMORY_MCP_TOKEN_ENV",
  "PENNY_MEMORY_PALACE_ID",
  "PENNY_MEMORY_PRINCIPAL_ID",
  "PENNY_MEMORY_TRUST_MODE",
  "PENNY_MEMORY_ISOLATION_BOUNDARY_ID",
  "PENNY_MEMORY_DATA_ROOT_ID",
  "PENNY_MEMORY_MAX_RESPONSE_BYTES",
  "PENNY_MEMORY_REQUEST_TIMEOUT_MS",
];

describe("worker-read memory grant (real .env path, as the skill driver builds it)", () => {
  it("builds a working read-only grant from the provisioned .env and loads read-only tools", async () => {
    const projectRoot = findPennyRoot(__dirname);
    loadDotEnv(projectRoot);

    const hasCredential =
      (process.env.PENNY_MEMORY_MCP_TOKEN_FILE?.trim().length ?? 0) > 0 ||
      (process.env.PENNY_MEMORY_MCP_TOKEN_ENV?.trim().length ?? 0) > 0;
    const requiredBase = [
      "PENNY_MEMORY_MCP_ENDPOINT",
      "PENNY_MEMORY_PALACE_ID",
      "PENNY_MEMORY_PRINCIPAL_ID",
      "PENNY_MEMORY_TRUST_MODE",
      "PENNY_MEMORY_ISOLATION_BOUNDARY_ID",
    ];
    const baseOk = requiredBase.every((name) => (process.env[name]?.trim().length ?? 0) > 0);
    if (!baseOk || !hasCredential) {
      // Not provisioned on this machine -> the skill driver fails closed (no grant).
      return;
    }

    // Mirror the skill driver's exact construction.
    const readEnv: Record<string, string> = {};
    for (const name of WORKER_READ_VARS) {
      const value = process.env[name];
      if (value && value.trim().length > 0) readEnv[name] = value;
    }
    readEnv.PENNY_RUNTIME_ROLE = "worker-read";

    // Validate provisioning the way the driver does (throws if incomplete).
    const config = loadWorkerReadConfig(process.env);
    expect(config.mode).toBe("hub");
    expect(config.writeEnabled).toBe(false);

    const factory = createMemoryExtension({ env: readEnv });
    const loader = await createWorkerResourceLoader(projectRoot, [factory]);

    const tools = new Set<string>();
    for (const extension of loader.getExtensions().extensions) {
      for (const name of extension.tools.keys()) tools.add(name);
    }

    const expectedRead = primaryMemoryToolNames({ writeEnabled: false });
    const expectedWrite = primaryMemoryToolNames({ writeEnabled: true }).filter(
      (tool) => !expectedRead.includes(tool)
    );
    for (const tool of expectedRead) {
      expect(tools.has(tool), `read tool missing: ${tool}`).toBe(true);
    }
    for (const tool of expectedWrite) {
      expect(tools.has(tool), `write tool must be absent: ${tool}`).toBe(false);
    }
    expect(tools.has("memory_smart_search")).toBe(true);
    expect(tools.has("memory_add_drawer")).toBe(false);
  });
});
