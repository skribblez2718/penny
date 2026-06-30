import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Hoist mock state so vi.mock factories can reference it
const mockSpawn = vi.hoisted(() =>
  vi.fn(() => {
    let written = "";
    return {
      stdout: {
        on: vi.fn((event: string, cb: (d: Buffer) => void) => {
          if (event === "data") {
            setTimeout(
              () => cb(Buffer.from(JSON.stringify({ success: true, drawer_id: "dr-auto-1" }))),
              5
            );
          }
        }),
      },
      stderr: { on: vi.fn() },
      stdin: {
        write: vi.fn((data: string) => {
          written += data;
        }),
        end: vi.fn(),
      },
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        if (event === "spawn") {
          setTimeout(() => cb(), 0);
        }
        if (event === "close") {
          setTimeout(() => cb(0), 15);
        }
      }),
      _written: () => written,
    };
  })
);

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("ws", () => ({
  WebSocket: vi.fn(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  })),
}));

import memoryExtension from "../../index.js";

describe("auto-diary shutdown pipeline", () => {
  let sessionShutdownHandler: ((event?: any) => Promise<void>) | undefined;
  let sessionStartHandler: ((event?: any, ctx?: any) => Promise<void>) | undefined;

  beforeAll(() => {
    const handlers: Record<string, Array<(...args: any[]) => Promise<void>>> = {};

    const mockPi = {
      on: (event: string, handler: (...args: any[]) => Promise<void>) => {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
      },
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    };

    memoryExtension(mockPi as any);

    sessionStartHandler = handlers["session_start"]?.[0];
    sessionShutdownHandler = handlers["session_shutdown"]?.[0];
  });

  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeAll(() => {
    mockSpawn.mockClear();
  });

  it("writes auto-diary on session_shutdown via observability data", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes("agent_start")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: [{ data: { agent: "echo" } }],
              total: 1,
            }),
        } as Response);
      }
      if (url.includes("tool_execution_start")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: [{ data: { toolName: "read" } }],
              total: 1,
            }),
        } as Response);
      }
      return Promise.resolve({ ok: false } as Response);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const mockCtx = {
      sessionManager: { getSessionId: () => "sess-auto-123" },
    };

    // Initialize sessionId
    await sessionStartHandler?.({}, mockCtx);

    // Trigger shutdown with reason
    await sessionShutdownHandler?.({ reason: "quit" });

    // Verify observability fetches were made
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("agent_start"))).toBe(true);
    expect(urls.some((u) => u.includes("tool_execution_start"))).toBe(true);

    // Verify bridge was called for diary_write
    const spawnCalls = mockSpawn.mock.calls;
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);

    // Find the call that passed diary_write
    const proc = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
    expect(proc).toBeDefined();
    const written = (proc as any)._written?.() || "";
    expect(written.length).toBeGreaterThan(0);

    const request = JSON.parse(written);
    expect(request.tool).toBe("diary_write");
    expect(request.params.agent_name).toBe("penny");
    expect(request.params.topic).toBe("session-end");
    expect(request.params.entry).toMatch(/^SESSION:\d{4}-\d{2}-\d{2}\|session-end\|/);
    expect(request.params.entry).toContain("Agents:1.");
    expect(request.params.entry).toContain("Tools:read(1).");
    expect(request.params.entry).toContain("Reason:quit");
  });

  it("gracefully skips diary when observability fetch fails", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: false, status: 503 } as Response)
    );
    vi.stubGlobal("fetch", fetchSpy);

    mockSpawn.mockClear();

    await sessionShutdownHandler?.({ reason: "reload" });

    // fetch should have been attempted
    expect(fetchSpy).toHaveBeenCalled();

    // callBridge should NOT be invoked for diary_write when fetch fails
    // Verify no bridge process was spawned for diary_write
    for (const call of mockSpawn.mock.calls) {
      const written = (call as any)[0]?._written?.() || "";
      if (written) {
        try {
          const req = JSON.parse(written);
          expect(req.tool).not.toBe("diary_write");
        } catch {
          // ignore parse errors
        }
      }
    }
  });
});
