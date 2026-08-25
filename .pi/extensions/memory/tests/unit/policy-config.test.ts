import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FORBIDDEN_MODEL_MEMORY_TOOLS,
  MemoryAdapter,
  MemoryError,
  PRIMARY_MEMORY_TOOL_BUNDLES,
  createMemoryExtension,
  loadMemoryRuntimeConfig,
  primaryMemoryToolNames,
  resolveMemoryActor,
} from "../../index.js";
import {
  TEST_TOKEN,
  asMemoryExtensionApi,
  extensionEnv,
  testConfig,
  type MemoryExtensionApiFake,
  type MemoryExtensionHandler,
  type RegisteredMemoryTool,
} from "../fixtures.js";

function piRecorder() {
  const tools: RegisteredMemoryTool[] = [];
  const handlers = new Map<string, MemoryExtensionHandler[]>();
  const pi: MemoryExtensionApiFake = {
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand: vi.fn(),
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  };
  return { tools, handlers, pi };
}

describe("runtime role policy", () => {
  it("treats only marker absence as primary; all marker values are deny-only", () => {
    expect(resolveMemoryActor({})).toBe("primary");
    expect(resolveMemoryActor({ PENNY_RUNTIME_ROLE: "" })).toBe("denied");
    expect(resolveMemoryActor({ PENNY_RUNTIME_ROLE: "worker" })).toBe("denied");
    expect(resolveMemoryActor({ PENNY_RUNTIME_ROLE: "skill-driver" })).toBe("denied");
    expect(resolveMemoryActor({ PENNY_RUNTIME_ROLE: "primary" })).toBe("denied");
    expect(resolveMemoryActor({ PENNY_RUNTIME_ROLE: "invented-grant" })).toBe("denied");
  });

  it("resolves worker-read for the worker-read marker", () => {
    expect(resolveMemoryActor({ PENNY_RUNTIME_ROLE: "worker-read" })).toBe("worker-read");
  });

  it.each(["", "worker", "skill-driver", "primary", "invented-grant"])(
    "registers zero tools and zero lifecycle hooks for marker %s",
    (role) => {
      const recorder = piRecorder();
      const fetchSpy = vi.fn();
      createMemoryExtension({
        env: { PENNY_RUNTIME_ROLE: role },
        fetch: fetchSpy as typeof fetch,
      })(asMemoryExtensionApi(recorder.pi));
      expect(recorder.tools).toEqual([]);
      expect(recorder.handlers.size).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it("registers the explicit primary bundles without model-visible admin tools", () => {
    const recorder = piRecorder();
    createMemoryExtension({ env: extensionEnv(), fetch: vi.fn() as typeof fetch })(
      asMemoryExtensionApi(recorder.pi)
    );
    const names = recorder.tools.map((tool) => tool.name);
    expect(names).toEqual(primaryMemoryToolNames({ writeEnabled: true }));
    expect(new Set(Object.values(PRIMARY_MEMORY_TOOL_BUNDLES).flat())).toEqual(new Set(names));
    for (const forbidden of FORBIDDEN_MODEL_MEMORY_TOOLS) expect(names).not.toContain(forbidden);
    expect(names).toContain("memory_get_drawer");
    expect(names).toContain("memory_kg_supersede");
    expect(names).not.toContain("memory_status");
  });

  it("registers only read tools for worker-read and no lifecycle hooks", () => {
    const recorder = piRecorder();
    const fetchSpy = vi.fn();
    const workerEnv = {
      PENNY_RUNTIME_ROLE: "worker-read",
      PENNY_MEMORY_MCP_ENDPOINT: "http://127.0.0.1:8766",
      PENNY_MEMORY_MCP_TOKEN_ENV: "TEST_MEMORY_TOKEN",
      TEST_MEMORY_TOKEN: TEST_TOKEN,
      PENNY_MEMORY_PALACE_ID: "penny-primary",
      PENNY_MEMORY_PRINCIPAL_ID: "agent-echo",
      PENNY_MEMORY_TRUST_MODE: "isolated",
      PENNY_MEMORY_ISOLATION_BOUNDARY_ID: "penny-primary-local",
      PENNY_TOOL_RESULT_MAX_BYTES: "4096",
      PENNY_TOOL_RESULT_MAX_CHARACTERS: "4096",
      PENNY_TOOL_RESULT_MAX_TOKENS: "4096",
    };
    createMemoryExtension({
      env: workerEnv,
      fetch: fetchSpy as typeof fetch,
    })(asMemoryExtensionApi(recorder.pi));
    const names = recorder.tools.map((tool) => tool.name);
    // Read-only tools only (writeEnabled=false filters out write operations)
    expect(names).toEqual(primaryMemoryToolNames({ writeEnabled: false }));
    // No write tools
    expect(names).not.toContain("memory_add_drawer");
    expect(names).not.toContain("memory_diary_write");
    expect(names).not.toContain("memory_kg_add");
    expect(names).not.toContain("memory_kg_invalidate");
    expect(names).not.toContain("memory_kg_supersede");
    // No logstream tools
    expect(names).not.toContain("memory_logstream_append");
    // No admin tools
    for (const forbidden of FORBIDDEN_MODEL_MEMORY_TOOLS) expect(names).not.toContain(forbidden);
    // No lifecycle hooks (no auto-diary)
    expect(recorder.handlers.size).toBe(0);
    // Read tools ARE present
    expect(names).toContain("memory_smart_search");
    expect(names).toContain("memory_get_drawer");
    expect(names).toContain("memory_kg_query");
    expect(names).toContain("memory_diary_read");
  });

  it("defaults hub clients to read-only qualification with no write tools", async () => {
    const recorder = piRecorder();
    const fetchSpy = vi.fn();
    createMemoryExtension({
      env: extensionEnv({ PENNY_MEMORY_WRITE_MODE: undefined }),
      fetch: fetchSpy as typeof fetch,
    })(asMemoryExtensionApi(recorder.pi));
    const names = recorder.tools.map((tool) => tool.name);
    expect(names).toEqual(primaryMemoryToolNames());
    for (const writeTool of [
      "memory_add_drawer",
      "memory_diary_write",
      "memory_kg_add",
      "memory_kg_invalidate",
      "memory_kg_supersede",
    ]) {
      expect(names).not.toContain(writeTool);
    }
    expect(names).toContain("memory_check_duplicate");
    expect(names).toContain("memory_diary_read");
    expect(recorder.handlers.has("session_shutdown")).toBe(true);
    await recorder.handlers.get("session_shutdown")?.[0]?.({ reason: "test" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("denies direct adapter writes while qualification is read-only", async () => {
    const fetchSpy = vi.fn();
    const adapter = new MemoryAdapter(testConfig({ writeEnabled: false }), {
      fetch: fetchSpy as typeof fetch,
    });
    const execution = await adapter.execute(
      "add_drawer",
      { wing: "penny", room: "test", content: "must not leave process" },
      { callerId: "primary:test" }
    );
    expect(execution.code).toBe("MEMPALACE_INVALID");
    await expect(
      adapter.invokeRaw("diary_write", { agent_name: "penny", entry: "blocked" })
    ).rejects.toMatchObject({ code: "MEMPALACE_INVALID" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("disabled mode registers no tools or lifecycle hooks", () => {
    const recorder = piRecorder();
    createMemoryExtension({ env: { PENNY_MEMORY_MODE: "disabled" } })(
      asMemoryExtensionApi(recorder.pi)
    );
    expect(recorder.tools).toEqual([]);
    expect(recorder.handlers.size).toBe(0);
  });
});

describe("hub-only configuration", () => {
  it.each(["legacy", "shadow", "prefer", "direct"])("rejects production mode %s", (mode) => {
    expect(() => loadMemoryRuntimeConfig(extensionEnv({ PENNY_MEMORY_MODE: mode }))).toThrow(
      MemoryError
    );
  });

  it("defaults writes off, accepts explicit enablement, and rejects unknown write modes", () => {
    expect(
      loadMemoryRuntimeConfig(extensionEnv({ PENNY_MEMORY_WRITE_MODE: undefined })).writeEnabled
    ).toBe(false);
    expect(loadMemoryRuntimeConfig(extensionEnv()).writeEnabled).toBe(true);
    expect(() =>
      loadMemoryRuntimeConfig(extensionEnv({ PENNY_MEMORY_WRITE_MODE: "shadow" }))
    ).toThrow(/WRITE_MODE/);
  });

  it("normalizes the configured endpoint to HTTP POST /mcp", () => {
    const config = loadMemoryRuntimeConfig(extensionEnv());
    expect(config.platformConfig).toMatchObject({
      contractVersion: 1,
      mode: "isolated",
      target: {
        endpoint: "http://127.0.0.1:8765/mcp",
        palaceId: "penny-personal",
        dataRootId: "penny-memory-root",
      },
      trust: { kind: "isolated", isolationBoundaryId: "penny-primary-palace" },
      custody: { uninstallDisposition: "preserve" },
    });
    expect(config.bearerToken).toBe(TEST_TOKEN);
  });

  it("loads a bearer token only from an owner-only file reference", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-token-"));
    const path = join(directory, "token");
    writeFileSync(path, `${TEST_TOKEN}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    const config = loadMemoryRuntimeConfig(
      extensionEnv({
        PENNY_MEMORY_MCP_TOKEN_ENV: undefined,
        TEST_MEMORY_TOKEN: undefined,
        PENNY_MEMORY_MCP_TOKEN_FILE: path,
      })
    );
    expect(config.bearerToken).toBe(TEST_TOKEN);

    chmodSync(path, 0o644);
    expect(() =>
      loadMemoryRuntimeConfig(
        extensionEnv({
          PENNY_MEMORY_MCP_TOKEN_ENV: undefined,
          TEST_MEMORY_TOKEN: undefined,
          PENNY_MEMORY_MCP_TOKEN_FILE: path,
        })
      )
    ).toThrow(/owner-only/);
  });

  it("requires caller-supplied palace/root/trust/custody settings", () => {
    expect(() =>
      loadMemoryRuntimeConfig(extensionEnv({ PENNY_MEMORY_DATA_ROOT_ID: undefined }))
    ).toThrow(/DATA_ROOT_ID/);
    expect(() =>
      loadMemoryRuntimeConfig(extensionEnv({ PENNY_MEMORY_TRUST_MODE: undefined }))
    ).toThrow(/TRUST_MODE/);
    expect(() =>
      loadMemoryRuntimeConfig(extensionEnv({ PENNY_MEMORY_UNINSTALL_DISPOSITION: "delete" }))
    ).toThrow(/preserve/);
  });

  it("requires whole-palace acknowledgement for shared-trust-domain mode", () => {
    expect(() =>
      loadMemoryRuntimeConfig(
        extensionEnv({
          PENNY_MEMORY_TRUST_MODE: "shared-trust-domain",
          PENNY_MEMORY_ISOLATION_BOUNDARY_ID: undefined,
          PENNY_MEMORY_TRUST_DOMAIN_ID: "trusted-primary-fleet",
          PENNY_MEMORY_WHOLE_PALACE_TRUST_ACK: undefined,
        })
      )
    ).toThrow(/whole-palace/);
    expect(
      loadMemoryRuntimeConfig(
        extensionEnv({
          PENNY_MEMORY_TRUST_MODE: "shared-trust-domain",
          PENNY_MEMORY_ISOLATION_BOUNDARY_ID: undefined,
          PENNY_MEMORY_TRUST_DOMAIN_ID: "trusted-primary-fleet",
          PENNY_MEMORY_WHOLE_PALACE_TRUST_ACK: "whole-palace",
        })
      ).platformConfig.mode
    ).toBe("shared-trust-domain");
  });

  it("rejects direct secret values and non-HTTP endpoints", () => {
    expect(() =>
      loadMemoryRuntimeConfig(
        extensionEnv({
          PENNY_MEMORY_MCP_TOKEN_ENV: undefined,
          PENNY_MEMORY_MCP_TOKEN_FILE: undefined,
          PENNY_MEMORY_MCP_TOKEN: TEST_TOKEN,
        })
      )
    ).toThrow(/Exactly one/);
    expect(() =>
      loadMemoryRuntimeConfig(extensionEnv({ PENNY_MEMORY_MCP_ENDPOINT: "file:///tmp/palace" }))
    ).toThrow(/HTTP/);
  });
});
