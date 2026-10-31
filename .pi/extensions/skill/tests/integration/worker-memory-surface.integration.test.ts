import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  createMemoryExtension,
  memoryExtensionSource,
  primaryMemoryToolNames,
} from "@penny/memory-extension";
import {
  createWorkerResourceLoader,
  type WorkerExtensionSourceReplacement,
} from "@penny/orchestration";
import { afterEach, describe, expect, it, vi } from "vitest";

const memorySource = memoryExtensionSource;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "penny-worker-memory-"));
  roots.push(root);
  const extensions = path.join(root, ".pi", "extensions");
  mkdirSync(extensions, { recursive: true });
  symlinkSync(path.dirname(memorySource), path.join(extensions, "memory"), "dir");
  const repository = path.resolve(path.dirname(memorySource), "../../..");
  symlinkSync(path.join(repository, ".pi/lib"), path.join(root, ".pi/lib"), "dir");
  symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
  // Keep expected unconfigured-service warnings off the logger's HTTP transport.
  vi.stubEnv("PI_LOG_LEVEL_MEMORY", "CRITICAL");
  // This ambient role reproduced the original duplicate. The explicit provider
  // must supersede its source even when hidden registration would still conflict.
  vi.stubEnv("PENNY_RUNTIME_ROLE", "worker-read");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  const registration = path.resolve(
    path.dirname(memorySource),
    "../../lib/pi-tool-registration.ts"
  );
  const sentinel = `import {registerTool} from ${JSON.stringify(registration)};
    import {Type} from "typebox";
    export default pi => registerTool(pi, {
      name:"nonmemory_sentinel", label:"sentinel", description:"Fixture only",
      parameters:Type.Object({}),
      execute:async()=>({content:[], details:{}})
    });`;
  writeFileSync(path.join(extensions, "sentinel.js"), sentinel);
  return { root, extensions, sentinel };
}

function replacement(
  env: Readonly<Record<string, string | undefined>>
): WorkerExtensionSourceReplacement {
  return {
    source: memorySource,
    extension: {
      name: "memory-worker-read",
      hidden: true,
      factory: createMemoryExtension({ env }),
    },
  };
}

async function load(root: string, env: Readonly<Record<string, string | undefined>>) {
  return createWorkerResourceLoader(
    root,
    [],
    undefined,
    undefined,
    SettingsManager.inMemory(),
    undefined,
    undefined,
    [replacement(env)]
  );
}

function expectReadOnlyOwners(loader: Awaited<ReturnType<typeof load>>): void {
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  const read = primaryMemoryToolNames({ writeEnabled: false });
  expect(read).toHaveLength(10);
  for (const name of read) {
    expect(
      loaded.extensions
        .filter((extension) => extension.tools.has(name))
        .map((extension) => extension.path),
      name
    ).toEqual(["<inline:memory-worker-read>"]);
  }
  const owner = loaded.extensions.find(
    (extension) => extension.path === "<inline:memory-worker-read>"
  );
  if (owner === undefined) throw new Error("scoped memory owner missing");
  expect([...owner.tools.keys()].sort()).toEqual([...read].sort());
  // Shared registration installs error-result middleware, not primary lifecycle hooks.
  expect([...owner.handlers.keys()]).toEqual(["tool_result"]);
  expect(owner.commands.size).toBe(0);
  const registered = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
  for (const name of primaryMemoryToolNames({ writeEnabled: true }).filter(
    (name) => !read.includes(name)
  )) {
    expect(registered, `worker must not expose ${name}`).not.toContain(name);
  }
  expect(registered.filter((name) => !read.includes(name))).toEqual(["nonmemory_sentinel"]);
  // No ambient memory factory (and therefore no primary writes or hooks) survives.
  expect(loaded.extensions).toHaveLength(2);
  expect(
    loaded.extensions
      .filter((extension) => !extension.path.startsWith("<inline:"))
      .map((extension) => path.basename(extension.path))
  ).toEqual(["sentinel.js"]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
}

describe("normal worker loader memory source composition", () => {
  it("keeps exactly one scoped owner per read tool with synthetic worker configuration", async () => {
    const { root } = fixture();
    const loader = await load(root, {
      PENNY_RUNTIME_ROLE: "worker-read",
      PENNY_MEMORY_MCP_ENDPOINT: "http://127.0.0.1:9/mcp",
      PENNY_MEMORY_MCP_TOKEN_ENV: "PENNY_IT_WORKER_READ_TOKEN",
      PENNY_IT_WORKER_READ_TOKEN: "hermetic-worker-read-token-0123456789abcdef-9876543210",
      PENNY_MEMORY_PALACE_ID: "it-palace",
      PENNY_MEMORY_PRINCIPAL_ID: "it-principal",
      PENNY_MEMORY_TRUST_MODE: "isolated",
      PENNY_MEMORY_ISOLATION_BOUNDARY_ID: "it-boundary",
    });
    expectReadOnlyOwners(loader);
  });

  it("has zero errors and one read-only owner per capability when memory is unavailable, preserving nonmemory providers", async () => {
    const { root } = fixture();
    const loader = await load(root, { PENNY_RUNTIME_ROLE: "worker-read" });
    expectReadOnlyOwners(loader);
  });

  it("still refuses an unrelated duplicate under normal discovery", async () => {
    const { root, extensions, sentinel } = fixture();
    writeFileSync(path.join(extensions, "duplicate.js"), sentinel);
    await expect(load(root, { PENNY_RUNTIME_ROLE: "worker-read" })).rejects.toThrow(
      /EXTENSION_CONFLICT/u
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
