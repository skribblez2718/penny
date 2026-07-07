import { describe, it, expect, vi, afterEach } from "vitest";
import { observabilityRestFetch, buildDiaryFromObservability } from "../../index.js";

describe("observabilityRestFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns JSON on successful fetch", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0 }),
      } as Response)
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await observabilityRestFetch(
      "http://localhost:8765/sessions/s1/entries",
      "key123"
    );
    expect(result).toEqual({ items: [], total: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; signal: AbortSignal },
    ];
    // Observability REST auth is Bearer-only; sending x-api-key 401'd every fetch.
    expect(call[1].headers["Authorization"]).toBe("Bearer key123");
    expect(call[1].signal).toBeDefined(); // AbortSignal
  });

  it("returns null on non-ok response", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: false, status: 503 } as Response));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await observabilityRestFetch("http://localhost:8765/sessions/s1/entries", "");
    expect(result).toBeNull();
  });

  it("returns null on fetch error", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await observabilityRestFetch("http://localhost:8765/sessions/s1/entries", "");
    expect(result).toBeNull();
  });

  it("returns null on fetch timeout", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("The operation was aborted")));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await observabilityRestFetch("http://localhost:8765/sessions/s1/entries", "");
    expect(result).toBeNull();
  });
});

describe("buildDiaryFromObservability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds correct AAAK entry from observability data", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes("agent_start")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: [
                { event_type: "agent_start", data: { agent: "echo" } },
                { event_type: "agent_start", data: { agent: "piper" } },
                { event_type: "agent_start", data: { agent: "carren" } },
              ],
              total: 3,
            }),
        } as Response);
      }
      if (url.includes("tool_execution_start")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: [
                { event_type: "tool_execution_start", data: { toolName: "read" } },
                { event_type: "tool_execution_start", data: { toolName: "read" } },
                { event_type: "tool_execution_start", data: { toolName: "write" } },
                { event_type: "tool_execution_start", data: { toolName: "bash" } },
              ],
              total: 4,
            }),
        } as Response);
      }
      return Promise.resolve({ ok: false } as Response);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const entry = await buildDiaryFromObservability(
      "sess-123",
      "quit",
      "ws://localhost:8765/ws",
      "abc"
    );
    expect(entry).not.toBeNull();
    expect(entry).toMatch(/^SESSION:\d{4}-\d{2}-\d{2}\|session-end\|/);
    expect(entry).toContain("Agents:3.");
    expect(entry).toContain("Tools:read(2)+write(1)+bash(1).");
    expect(entry).toContain("Reason:quit");
    expect(entry).toContain("|★★");
  });

  it("returns null when agents fetch fails", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes("agent_start")) {
        return Promise.resolve({ ok: false } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0 }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const entry = await buildDiaryFromObservability(
      "sess-123",
      "quit",
      "ws://localhost:8765/ws",
      ""
    );
    expect(entry).toBeNull();
  });

  it("returns null when tools fetch fails", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes("tool_execution_start")) {
        return Promise.resolve({ ok: false } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0 }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const entry = await buildDiaryFromObservability(
      "sess-123",
      "quit",
      "ws://localhost:8765/ws",
      ""
    );
    expect(entry).toBeNull();
  });

  it("handles empty tool results gracefully", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0 }),
      } as Response)
    );
    vi.stubGlobal("fetch", fetchSpy);

    const entry = await buildDiaryFromObservability(
      "sess-123",
      "quit",
      "ws://localhost:8765/ws",
      ""
    );
    expect(entry).not.toBeNull();
    expect(entry).toContain("Agents:0.");
    expect(entry).toContain("Tools:none.");
  });

  it("limits tool names to top 6 by count", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes("agent_start")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [{}, {}], total: 2 }),
        } as Response);
      }
      if (url.includes("tool_execution_start")) {
        const items = [
          { data: { toolName: "a" } },
          { data: { toolName: "a" } },
          { data: { toolName: "a" } },
          { data: { toolName: "b" } },
          { data: { toolName: "b" } },
          { data: { toolName: "c" } },
          { data: { toolName: "c" } },
          { data: { toolName: "d" } },
          { data: { toolName: "e" } },
          { data: { toolName: "f" } },
          { data: { toolName: "g" } },
          { data: { toolName: "h" } },
        ];
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items, total: items.length }),
        } as Response);
      }
      return Promise.resolve({ ok: false } as Response);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const entry = await buildDiaryFromObservability(
      "sess-123",
      "reload",
      "ws://localhost:8765/ws",
      ""
    );
    expect(entry).toBeDefined();
    expect(entry).toContain("Tools:a(3)+b(2)+c(2)+d(1)+e(1)+f(1).");
    expect(entry).not.toContain("+g(");
  });

  it("derives REST URL correctly from ws URL", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0 }),
      } as Response)
    );
    vi.stubGlobal("fetch", fetchSpy);

    await buildDiaryFromObservability("sess-123", "new", "ws://obs.local:9999/ws", "");

    const urls = fetchSpy.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(
      "http://obs.local:9999/sessions/sess-123/entries?event_type=agent_start&limit=500"
    );
    expect(urls[1]).toBe(
      "http://obs.local:9999/sessions/sess-123/entries?event_type=tool_execution_start&limit=500"
    );
  });
});
