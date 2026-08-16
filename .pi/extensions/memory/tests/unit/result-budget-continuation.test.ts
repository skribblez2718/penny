import { describe, expect, it, vi } from "vitest";

import { MemoryAdapter } from "../../adapter.js";
import { createPrimaryMemoryTools } from "../../tools.js";
import { fitsToolResultBudget, measureToolResult } from "../../../lib/tool-result-budget.js";
import type { MemoryOperation } from "../../types.js";
import { mcpResponse, requestBody, testConfig } from "../fixtures.js";

function payloadOf(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

function adapterForPayload(
  payload: Record<string, unknown> | ((tool: string, call: number) => Record<string, unknown>),
  options: { now?: () => number; config?: ReturnType<typeof testConfig> } = {}
) {
  let calls = 0;
  const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const request = requestBody(init);
    const responsePayload =
      typeof payload === "function" ? payload(request.params.name, calls) : payload;
    return Promise.resolve(mcpResponse(request.id, responsePayload));
  });
  const config = options.config ?? testConfig();
  const adapter = new MemoryAdapter(config, {
    fetch: fetchSpy as typeof fetch,
    now: options.now,
    randomId: () => String(calls + 1),
  });
  return { adapter, fetchSpy, config };
}

async function collectPages(options: {
  adapter: MemoryAdapter;
  operation: MemoryOperation;
  params: Record<string, unknown>;
  callerId?: string;
  config: ReturnType<typeof testConfig>;
}) {
  const parts: Buffer[] = [];
  const pages: Record<string, any>[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 256; index += 1) {
    const execution = await options.adapter.execute(
      options.operation,
      { ...options.params, ...(cursor ? { cursor } : {}) },
      { callerId: options.callerId ?? "primary:test" }
    );
    expect(execution.code).toBe("OK");
    expect(fitsToolResultBudget(measureToolResult(execution.result), options.config.budget)).toBe(
      true
    );
    const page = payloadOf(execution.result);
    pages.push(page);
    if (page.type === "memory_result") {
      parts.push(Buffer.from(JSON.stringify(page.data), "utf8"));
    } else if (page.type === "memory_exact") {
      parts.push(Buffer.from(page.content, "utf8"));
    } else {
      parts.push(Buffer.from(page.fragment, "utf8"));
    }
    if (!page.truncated) return { bytes: Buffer.concat(parts), pages };
    cursor = page.continuation.cursor;
  }
  throw new Error("continuation did not terminate");
}

describe("REQ-028 exact continuation", () => {
  it("reassembles one giant multibyte drawer byte-for-byte from a bounded cached source", async () => {
    const content = "🙂漢字é/".repeat(4_000);
    const { adapter, fetchSpy, config } = adapterForPayload({
      drawer_id: "drawer-1",
      content,
      wing: "penny",
      room: "decisions",
      filed_at: "2026-08-15T00:00:00Z",
      chunks: 5_000,
      chunk_ids: Array.from({ length: 5_000 }, (_, index) => `chunk-${index}`),
      metadata: { filed_at: "2026-08-15T00:00:00Z", chunk_ids: ["not-inlined"] },
    });
    const collected = await collectPages({
      adapter,
      operation: "get_drawer",
      params: { drawer_id: "drawer-1" },
      config,
    });

    expect(collected.pages.length).toBeGreaterThan(1);
    expect(collected.bytes.equals(Buffer.from(content, "utf8"))).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(collected.pages[0]!.metadata.metadata_reduced).toBe(true);
    expect(collected.pages[0]!.metadata.chunk_ids_count).toBe(5_000);
    expect(collected.pages[0]!.metadata.chunk_ids).toBeUndefined();
    const digest = collected.pages[0]!.source.digest;
    const revision = collected.pages[0]!.source.revision;
    let expectedStart = 0;
    for (const page of collected.pages) {
      expect(page.source.digest).toBe(digest);
      expect(page.source.revision).toBe(revision);
      expect(page.returned_range.start).toBe(expectedStart);
      expect(page.returned_bytes).toBe(page.returned_range.end - page.returned_range.start);
      expectedStart = page.returned_range.end;
    }
    expect(expectedStart).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("fails invalid, wrong-caller, wrong-query, stale, and expired cursors", async () => {
    let now = 1_000;
    const content = "x".repeat(30_000);
    const { adapter, config } = adapterForPayload(
      { drawer_id: "drawer-1", content, wing: "penny", room: "r" },
      { now: () => now }
    );
    const first = await adapter.execute(
      "get_drawer",
      { drawer_id: "drawer-1" },
      { callerId: "primary:a" }
    );
    const cursor = payloadOf(first.result).continuation.cursor as string;

    const forged = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    expect(
      payloadOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "drawer-1", cursor: forged },
            { callerId: "primary:a" }
          )
        ).result
      ).error.code
    ).toBe("MEMPALACE_CURSOR_INVALID");

    expect(
      payloadOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "drawer-1", cursor },
            { callerId: "primary:b" }
          )
        ).result
      ).error.code
    ).toBe("MEMPALACE_CURSOR_INVALID");

    expect(
      payloadOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "other", cursor },
            { callerId: "primary:a" }
          )
        ).result
      ).error.code
    ).toBe("MEMPALACE_CURSOR_INVALID");

    adapter.clearContinuationCacheForTests();
    expect(
      payloadOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "drawer-1", cursor },
            { callerId: "primary:a" }
          )
        ).result
      ).error.code
    ).toBe("MEMPALACE_CURSOR_STALE");

    const fresh = await adapter.execute(
      "get_drawer",
      { drawer_id: "drawer-1" },
      { callerId: "primary:a" }
    );
    const expiringCursor = payloadOf(fresh.result).continuation.cursor as string;
    now += config.cursorTtlMs + 1;
    expect(
      payloadOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "drawer-1", cursor: expiringCursor },
            { callerId: "primary:a" }
          )
        ).result
      ).error.code
    ).toBe("MEMPALACE_CURSOR_EXPIRED");
  });

  it("re-fetches upstream-ranged list pages and rejects changed source revisions", async () => {
    const drawers = Array.from({ length: 20 }, (_, index) => ({
      drawer_id: `d-${index}`,
      wing: "penny",
      room: "r",
      content: `${index}:`.padEnd(1_500, "x"),
    }));
    const stable = adapterForPayload({ drawers, total: 20, count: 20, offset: 0, limit: 20 });
    const collected = await collectPages({
      adapter: stable.adapter,
      operation: "list_drawers",
      params: { limit: 20, include_full: true },
      config: stable.config,
    });
    expect(JSON.parse(collected.bytes.toString("utf8")).drawers).toHaveLength(20);
    expect(stable.fetchSpy.mock.calls.length).toBe(collected.pages.length);

    const changing = adapterForPayload((_tool, call) => ({
      drawers: call === 1 ? drawers : [...drawers, { drawer_id: "changed", content: "y" }],
      total: call === 1 ? 20 : 21,
      count: call === 1 ? 20 : 21,
      offset: 0,
      limit: 20,
    }));
    const first = await changing.adapter.execute(
      "list_drawers",
      { limit: 20, include_full: true },
      { callerId: "primary:list" }
    );
    const cursor = payloadOf(first.result).continuation.cursor;
    const second = await changing.adapter.execute(
      "list_drawers",
      { limit: 20, include_full: true, cursor },
      { callerId: "primary:list" }
    );
    expect(payloadOf(second.result).error.code).toBe("MEMPALACE_CURSOR_STALE");
  });
});

describe("result-budget telemetry metadata", () => {
  it("emits a correlation key without claiming that a compaction trial ran", async () => {
    const { adapter } = adapterForPayload({
      drawer_id: "drawer-telemetry",
      content: "bounded telemetry fixture",
    });
    const events: Array<{ event: string; context: Record<string, any> }> = [];
    const tool = createPrimaryMemoryTools({
      adapter,
      callerId: () => "primary:telemetry-session",
      telemetry: {
        info: (event, context) => events.push({ event, context }),
        warn: (event, context) => events.push({ event, context }),
      },
    }).find((candidate) => candidate.name === "memory_get_drawer");

    expect(tool).toBeDefined();
    await tool!.execute("telemetry-call", { drawer_id: "drawer-telemetry" });

    expect(events).toHaveLength(1);
    expect(events[0]!.context.compactionCorrelation).toEqual({
      status: "not_evaluated",
      keys: ["session:telemetry-session"],
    });
    expect(events[0]!.context.releaseHeadroom.invariantPreserved).toBe(true);
    expect(JSON.stringify(events)).not.toContain("bounded telemetry fixture");
  });
});

describe("REQ-028 broad result fixtures", () => {
  it("defaults search to explicit bounded summaries instead of verbatim content", async () => {
    const { adapter } = adapterForPayload({
      query: "architecture",
      filters: { wing: "penny" },
      total_before_filter: 1,
      results: [
        {
          drawer_id: "d-1",
          text: "secret-verbatim-" + "x".repeat(2_000),
          wing: "penny",
          room: "architecture",
          similarity: 0.9,
        },
      ],
    });
    const execution = await adapter.execute(
      "smart_search",
      { query: "architecture" },
      { callerId: "primary:search" }
    );
    const payload = payloadOf(execution.result);
    expect(payload.type).toBe("memory_result");
    expect(payload.data.mode).toBe("summary");
    expect(payload.data.results[0].content).toBeUndefined();
    expect(payload.data.results[0].summary_truncated).toBe(true);
    expect(payload.data.results[0].content_bytes).toBeGreaterThan(
      payload.data.results[0].summary_bytes
    );
  });

  it.each([
    ["search", 20],
    ["smart_search", 10],
  ] as const)("bounds and exactly continues %s include_full hits", async (operation, count) => {
    const upstream = {
      query: "q",
      filters: {},
      total_before_filter: count,
      results: Array.from({ length: count }, (_, index) => ({
        drawer_id: `d-${index}`,
        text: `${index}:🙂`.repeat(1_500),
        wing: "penny",
        room: "r",
        similarity: 0.8,
      })),
    };
    const { adapter, config } = adapterForPayload(upstream);
    const collected = await collectPages({
      adapter,
      operation,
      params: { query: "q", limit: count, include_full: true },
      config,
    });
    const normalized = JSON.parse(collected.bytes.toString("utf8"));
    expect(normalized.mode).toBe("verbatim");
    expect(normalized.results).toHaveLength(count);
    expect(normalized.results[0].content).toContain("🙂");
  });

  it.each(["get_taxonomy", "kg_timeline"] as const)(
    "bounds oversized %s and reassembles the normalized source exactly",
    async (operation) => {
      const upstream =
        operation === "get_taxonomy"
          ? {
              taxonomy: Object.fromEntries(
                Array.from({ length: 500 }, (_, index) => [
                  `wing-${index}`,
                  Object.fromEntries(
                    Array.from({ length: 5 }, (_unused, room) => [`room-${room}`, index + room])
                  ),
                ])
              ),
            }
          : {
              entity: "all",
              timeline: Array.from({ length: 1_000 }, (_, index) => ({
                subject: `s-${index}`,
                predicate: "uses",
                object: `o-${index}`,
                valid_from: "2026-01-01",
              })),
              count: 1_000,
            };
      const { adapter, config } = adapterForPayload(upstream);
      const collected = await collectPages({
        adapter,
        operation,
        params: {},
        config,
      });
      expect(JSON.parse(collected.bytes.toString("utf8"))).toEqual(upstream);
      expect(collected.pages.length).toBeGreaterThan(1);
    }
  );

  it("accounts for the complete Pi envelope rather than only returned text", async () => {
    const content = `quoted-\"-slash-\\-🙂`.repeat(2_000);
    const { adapter, config } = adapterForPayload({ drawer_id: "d", content });
    const first = await adapter.execute(
      "get_drawer",
      { drawer_id: "d" },
      { callerId: "primary:envelope" }
    );
    const page = payloadOf(first.result);
    const measurement = measureToolResult(first.result);
    expect(measurement.bytes).toBe(first.serializedBytes);
    expect(measurement.bytes).toBeGreaterThan(Buffer.byteLength(page.content, "utf8"));
    expect(fitsToolResultBudget(measurement, config.budget)).toBe(true);
    expect(page.truncated).toBe(true);
  });
});
