import { describe, expect, it, vi } from "vitest";

import { buildDiaryFromObservability, createMemoryExtension } from "../../index.js";
import { extensionEnv, mcpResponse, requestBody } from "../fixtures.js";

function recorder() {
  const handlers = new Map<string, Array<(...args: any[]) => Promise<void>>>();
  return {
    handlers,
    pi: {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on(event: string, handler: (...args: any[]) => Promise<void>) {
        const values = handlers.get(event) ?? [];
        values.push(handler);
        handlers.set(event, values);
      },
    },
  };
}

function observabilityResponse(url: string): Response {
  if (url.includes("agent_start")) {
    return new Response(JSON.stringify({ items: [{ data: { agent: "echo" } }], total: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({
      items: [
        { data: { toolName: "read" } },
        { data: { toolName: "read" } },
        { data: { toolName: "write" } },
      ],
      total: 3,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
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
    })(state.pi as any);
    expect(state.handlers.get("session_shutdown")).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes one duplicate-checked bounded diary for a primary session", async () => {
    const state = recorder();
    const mcpTools: string[] = [];
    const fetchSpy = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/mcp")) return Promise.resolve(observabilityResponse(url));
      const request = requestBody(init);
      mcpTools.push(request.params.name);
      const payload =
        request.params.name === "mempalace_check_duplicate"
          ? { is_duplicate: false, matches: [] }
          : { success: true, entry_id: "diary-1" };
      return Promise.resolve(mcpResponse(request.id, payload));
    });
    createMemoryExtension({ env: extensionEnv(), fetch: fetchSpy as typeof fetch })(
      state.pi as any
    );

    await state.handlers.get("session_start")![0]!(
      {},
      {
        sessionManager: { getSessionId: () => "session-primary-1" },
      }
    );
    await state.handlers.get("session_shutdown")![0]!({ reason: "quit" });
    await state.handlers.get("session_shutdown")![0]!({ reason: "quit" });

    expect(mcpTools).toEqual(["mempalace_check_duplicate", "mempalace_diary_write"]);
    const diaryCall = fetchSpy.mock.calls.find((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === "POST" && requestBody(init).params.name === "mempalace_diary_write";
    });
    const entry = requestBody(diaryCall![1] as RequestInit).params.arguments.entry as string;
    expect(Buffer.byteLength(entry, "utf8")).toBeLessThanOrEqual(2_048);
    expect(entry).toContain("Agents:1");
    expect(entry).toContain("Tools:read(2)+write(1)");
    expect(requestBody(diaryCall![1] as RequestInit).params.arguments).not.toHaveProperty(
      "session_id"
    );
  });

  it("suppresses a duplicate diary without a write", async () => {
    const state = recorder();
    const mcpTools: string[] = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/mcp")) return Promise.resolve(observabilityResponse(url));
      const request = requestBody(init);
      mcpTools.push(request.params.name);
      return Promise.resolve(mcpResponse(request.id, { is_duplicate: true }));
    }) as typeof fetch;
    createMemoryExtension({ env: extensionEnv(), fetch: fetchImpl })(state.pi as any);
    await state.handlers.get("session_start")![0]!(
      {},
      {
        sessionManager: { getSessionId: () => "session-primary-duplicate" },
      }
    );
    await state.handlers.get("session_shutdown")![0]!({ reason: "quit" });
    expect(mcpTools).toEqual(["mempalace_check_duplicate"]);
  });

  it("builds content-free bounded metadata even with hostile long tool labels", async () => {
    const fetchImpl = ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("agent_start")) {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [], total: 0 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: Array.from({ length: 500 }, () => ({
              data: { toolName: `private|payload\n${"x".repeat(5_000)}` },
            })),
            total: 500,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }) as typeof fetch;
    const entry = await buildDiaryFromObservability(
      "session-secret-not-logged-verbatim",
      "quit|injected\nreason",
      "ws://observability.invalid/ws",
      "",
      fetchImpl
    );
    expect(entry).not.toBeNull();
    expect(Buffer.byteLength(entry!, "utf8")).toBeLessThanOrEqual(2_048);
    expect(entry).not.toContain("session-secret-not-logged-verbatim");
    expect(entry).not.toContain("\n");
  });
});
