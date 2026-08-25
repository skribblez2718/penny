import { describe, expect, it, vi } from "vitest";

import { requireString } from "../../../../lib/tests/test-narrowers.js";

import { buildDiaryFromSessionEntries, createMemoryExtension } from "../../index.js";
import {
  asMemoryExtensionApi,
  extensionEnv,
  mcpResponse,
  requestBody,
  requireDefined,
  type MemoryExtensionApiFake,
  type MemoryExtensionHandler,
} from "../fixtures.js";

function recorder() {
  const handlers = new Map<string, MemoryExtensionHandler[]>();
  const pi: MemoryExtensionApiFake = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  return { handlers, pi };
}

const SESSION_ENTRIES = [
  {
    type: "custom",
    customType: "penny.observability.agent-lifecycle",
    data: { phase: "start" },
  },
  { type: "message", message: { role: "toolResult", toolName: "read" } },
  { type: "message", message: { role: "toolResult", toolName: "read" } },
  { type: "message", message: { role: "toolResult", toolName: "write" } },
] as const;

function context(sessionId = "session-primary-1") {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [...SESSION_ENTRIES],
    },
  };
}

describe("primary-only automatic diary", () => {
  it.each([
    ["direct worker", "worker"],
    ["parallel worker", "worker"],
    ["chain worker", "worker"],
    ["skill worker", "worker"],
    ["skill driver", "skill-driver"],
    ["aborted worker", "worker"],
    ["normal worker", "worker"],
  ])("makes zero shutdown memory calls for %s", async (_case, role) => {
    const state = recorder();
    const fetchSpy = vi.fn();
    createMemoryExtension({
      env: extensionEnv({ PENNY_RUNTIME_ROLE: role }),
      fetch: fetchSpy as typeof fetch,
    })(asMemoryExtensionApi(state.pi));
    expect(state.handlers.get("session_shutdown")).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes one duplicate-checked bounded diary from direct Pi metadata", async () => {
    const state = recorder();
    const mcpTools: string[] = [];
    const fetchSpy = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      mcpTools.push(request.params.name);
      const payload =
        request.params.name === "mempalace_check_duplicate"
          ? { is_duplicate: false, matches: [] }
          : { success: true, entry_id: "diary-1" };
      return Promise.resolve(mcpResponse(request.id, payload));
    });
    createMemoryExtension({ env: extensionEnv(), fetch: fetchSpy as typeof fetch })(
      asMemoryExtensionApi(state.pi)
    );

    const ctx = context();
    const sessionStart = requireDefined(
      state.handlers.get("session_start")?.[0],
      "session_start handler was not registered"
    );
    const sessionShutdown = requireDefined(
      state.handlers.get("session_shutdown")?.[0],
      "session_shutdown handler was not registered"
    );
    await sessionStart({}, ctx);
    await sessionShutdown({ reason: "quit" }, ctx);
    await sessionShutdown({ reason: "quit" }, ctx);

    expect(mcpTools).toEqual(["mempalace_check_duplicate", "mempalace_diary_write"]);
    const diaryCall = requireDefined(
      fetchSpy.mock.calls.find((call) => {
        const init = call[1];
        return init?.method === "POST" && requestBody(init).params.name === "mempalace_diary_write";
      }),
      "diary write request was not sent"
    );
    const diaryInit = requireDefined(diaryCall[1], "diary write request init was absent");
    const entry = requireString(
      requestBody(diaryInit).params.arguments.entry,
      "diary write request entry was not text"
    );
    expect(Buffer.byteLength(entry, "utf8")).toBeLessThanOrEqual(2_048);
    expect(entry).toContain("Agents:1");
    expect(entry).toContain("Tools:read(2)+write(1)");
    expect(requestBody(diaryInit).params.arguments).not.toHaveProperty("session_id");
  });

  it("suppresses a duplicate diary without a write", async () => {
    const state = recorder();
    const mcpTools: string[] = [];
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      mcpTools.push(request.params.name);
      return Promise.resolve(mcpResponse(request.id, { is_duplicate: true }));
    }) as typeof fetch;
    createMemoryExtension({ env: extensionEnv(), fetch: fetchImpl })(
      asMemoryExtensionApi(state.pi)
    );
    const ctx = context("session-primary-duplicate");
    const sessionStart = requireDefined(
      state.handlers.get("session_start")?.[0],
      "session_start handler was not registered"
    );
    const sessionShutdown = requireDefined(
      state.handlers.get("session_shutdown")?.[0],
      "session_shutdown handler was not registered"
    );
    await sessionStart({}, ctx);
    await sessionShutdown({ reason: "quit" }, ctx);
    expect(mcpTools).toEqual(["mempalace_check_duplicate"]);
  });

  it("bounds and sanitizes hostile direct-session metadata", () => {
    const entry = buildDiaryFromSessionEntries(
      "session-secret-not-logged-verbatim",
      "quit|injected\nreason",
      Array.from({ length: 500 }, () => ({
        type: "message",
        message: { role: "toolResult", toolName: `private|payload\n${"x".repeat(5_000)}` },
      }))
    );
    expect(entry).not.toBeNull();
    const boundedEntry = requireDefined(entry, "hostile session metadata did not produce a diary");
    expect(Buffer.byteLength(boundedEntry, "utf8")).toBeLessThanOrEqual(2_048);
    expect(boundedEntry).not.toContain("session-secret-not-logged-verbatim");
    expect(boundedEntry).not.toContain("\n");
  });
});
