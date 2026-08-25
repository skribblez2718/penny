import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  isRecord,
  parseJson,
  requireArray,
  requireDefined as requireFixture,
} from "../../../../lib/tests/test-narrowers.js";

import { MemoryAdapter } from "../../adapter.js";
import { createPrimaryMemoryTools } from "../../tools.js";
import { fitsToolResultBudget, measureToolResult } from "../../../lib/tool-result-budget.js";
import type { MemoryOperation } from "../../types.js";
import {
  mcpResponse,
  parseTextResult,
  requestBody,
  requireDefined,
  testConfig,
} from "../fixtures.js";

interface MemoryExactPayload {
  type: "memory_exact";
  content: string;
  truncated: boolean;
  continuation?: { cursor: string };
  metadata: {
    metadata_reduced?: boolean;
    chunk_ids_count?: number;
    chunk_ids?: unknown;
  };
  source: { digest: string; revision: string };
  returned_range: { start: number; end: number };
  returned_bytes: number;
}

interface MemoryResultPayload {
  type: "memory_result";
  data: unknown;
  truncated: boolean;
  continuation?: { cursor: string };
}

interface MemoryFragmentPayload {
  type: "memory_continuation";
  fragment: string;
  truncated: boolean;
  continuation?: { cursor: string };
}

interface MemoryErrorPayload {
  type: "memory_error";
  error: { code: string; message: string; retryable: boolean };
  request_id: string | null;
}

type ParsedMemoryPayload =
  | MemoryExactPayload
  | MemoryResultPayload
  | MemoryFragmentPayload
  | MemoryErrorPayload;

interface TelemetryContext {
  compactionCorrelation: { status: string; keys: string[] };
  releaseHeadroom: { invariantPreserved: boolean };
}

function projectTelemetryContext(context: Record<string, unknown>): TelemetryContext {
  if (
    !isRecord(context.compactionCorrelation) ||
    typeof context.compactionCorrelation.status !== "string" ||
    !Array.isArray(context.compactionCorrelation.keys) ||
    !context.compactionCorrelation.keys.every((key) => typeof key === "string") ||
    !isRecord(context.releaseHeadroom) ||
    typeof context.releaseHeadroom.invariantPreserved !== "boolean"
  ) {
    throw new Error("memory tool emitted invalid telemetry context");
  }
  return {
    compactionCorrelation: {
      status: context.compactionCorrelation.status,
      keys: context.compactionCorrelation.keys,
    },
    releaseHeadroom: {
      invariantPreserved: context.releaseHeadroom.invariantPreserved,
    },
  };
}

function hasContinuation(value: Record<string, unknown>): boolean {
  return (
    value.truncated === false ||
    (isRecord(value.continuation) && typeof value.continuation.cursor === "string")
  );
}

function isParsedMemoryPayload(value: unknown): value is ParsedMemoryPayload {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "memory_error") {
    return (
      isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string" &&
      typeof value.error.retryable === "boolean" &&
      (typeof value.request_id === "string" || value.request_id === null)
    );
  }
  if (typeof value.truncated !== "boolean" || !hasContinuation(value)) return false;
  if (value.type === "memory_result") return "data" in value;
  if (value.type === "memory_continuation") return typeof value.fragment === "string";
  return (
    value.type === "memory_exact" &&
    typeof value.content === "string" &&
    isRecord(value.metadata) &&
    isRecord(value.source) &&
    typeof value.source.digest === "string" &&
    typeof value.source.revision === "string" &&
    isRecord(value.returned_range) &&
    typeof value.returned_range.start === "number" &&
    typeof value.returned_range.end === "number" &&
    typeof value.returned_bytes === "number"
  );
}

function payloadOf(result: {
  content: Array<{ type: "text"; text: string }>;
}): ParsedMemoryPayload {
  const value = parseTextResult(result);
  if (!isParsedMemoryPayload(value)) {
    const keys = isRecord(value) ? Object.keys(value).join(",") : typeof value;
    const type = isRecord(value) ? String(value.type) : "n/a";
    throw new Error(`memory tool returned an invalid payload (type=${type}; keys=${keys})`);
  }
  return value;
}

function requireExactPayload(value: ParsedMemoryPayload): MemoryExactPayload {
  if (value.type !== "memory_exact") throw new Error("expected an exact memory payload");
  return value;
}

function requireErrorPayload(value: ParsedMemoryPayload): MemoryErrorPayload {
  if (value.type !== "memory_error") throw new Error("expected a memory error payload");
  return value;
}

function requireResultPayload(value: ParsedMemoryPayload): MemoryResultPayload {
  if (value.type !== "memory_result") throw new Error("expected a structured memory payload");
  return value;
}

function requirePagePayload(
  value: ParsedMemoryPayload
): MemoryExactPayload | MemoryResultPayload | MemoryFragmentPayload {
  if (value.type === "memory_error")
    throw new Error(`unexpected memory error: ${value.error.code}`);
  return value;
}

function requireCursor(
  value: MemoryExactPayload | MemoryResultPayload | MemoryFragmentPayload
): string {
  return requireFixture(value.continuation, "truncated memory payload omitted continuation").cursor;
}

function errorCodeOf(result: { content: Array<{ type: "text"; text: string }> }): string {
  return requireErrorPayload(payloadOf(result)).error.code;
}

interface SearchResultData {
  mode: string;
  results: Array<{
    content?: unknown;
    summary_truncated: boolean;
    content_bytes: number;
    summary_bytes: number;
  }>;
}

function requireSearchResultData(value: unknown): SearchResultData {
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new Error("memory search payload omitted result metadata");
  }
  const results = requireArray(value.results, "memory search payload omitted results").map(
    (entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.summary_truncated !== "boolean" ||
        typeof entry.content_bytes !== "number" ||
        typeof entry.summary_bytes !== "number"
      ) {
        throw new Error("memory search payload contained an invalid result");
      }
      return {
        content: entry.content,
        summary_truncated: entry.summary_truncated,
        content_bytes: entry.content_bytes,
        summary_bytes: entry.summary_bytes,
      };
    }
  );
  return { mode: value.mode, results };
}

function readCursorPayload(cursor: string): Record<string, unknown> {
  const [body, signature, extra] = cursor.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new Error("test cursor is not a two-segment signed cursor");
  }
  const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!isRecord(parsed)) throw new Error("test cursor payload is not an object");
  return parsed;
}

function signCursor(payload: Record<string, unknown>, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
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
  const pages: ParsedMemoryPayload[] = [];
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
    if (page.type === "memory_error")
      throw new Error(`unexpected memory error: ${page.error.code}`);
    if (page.type === "memory_result") {
      parts.push(Buffer.from(JSON.stringify(page.data), "utf8"));
    } else if (page.type === "memory_exact") {
      parts.push(Buffer.from(page.content, "utf8"));
    } else {
      parts.push(Buffer.from(page.fragment, "utf8"));
    }
    if (!page.truncated) return { bytes: Buffer.concat(parts), pages };
    cursor = requireCursor(page);
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
    const firstPage = requireExactPayload(
      requireDefined(collected.pages[0], "continuation returned no pages")
    );
    expect(firstPage.metadata.metadata_reduced).toBe(true);
    expect(firstPage.metadata.chunk_ids_count).toBe(5_000);
    expect(firstPage.metadata.chunk_ids).toBeUndefined();
    const digest = firstPage.source.digest;
    const revision = firstPage.source.revision;
    let expectedStart = 0;
    for (const value of collected.pages) {
      const page = requireExactPayload(value);
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
    const cursor = requireCursor(requireExactPayload(payloadOf(first.result)));

    const forged = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    expect(
      errorCodeOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "drawer-1", cursor: forged },
            { callerId: "primary:a" }
          )
        ).result
      )
    ).toBe("MEMPALACE_CURSOR_INVALID");

    expect(
      errorCodeOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "drawer-1", cursor },
            { callerId: "primary:b" }
          )
        ).result
      )
    ).toBe("MEMPALACE_CURSOR_INVALID");

    expect(
      errorCodeOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "other", cursor },
            { callerId: "primary:a" }
          )
        ).result
      )
    ).toBe("MEMPALACE_CURSOR_INVALID");

    adapter.clearContinuationCacheForTests();
    expect(
      errorCodeOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "drawer-1", cursor },
            { callerId: "primary:a" }
          )
        ).result
      )
    ).toBe("MEMPALACE_CURSOR_STALE");

    const fresh = await adapter.execute(
      "get_drawer",
      { drawer_id: "drawer-1" },
      { callerId: "primary:a" }
    );
    const expiringCursor = requireCursor(requireExactPayload(payloadOf(fresh.result)));
    now += config.cursorTtlMs + 1;
    expect(
      errorCodeOf(
        (
          await adapter.execute(
            "get_drawer",
            { drawer_id: "drawer-1", cursor: expiringCursor },
            { callerId: "primary:a" }
          )
        ).result
      )
    ).toBe("MEMPALACE_CURSOR_EXPIRED");
  });

  it("rejects correctly signed cursor payloads with either extra or missing properties", async () => {
    const { adapter, config } = adapterForPayload({
      drawer_id: "drawer-cursor-shape",
      content: "x".repeat(30_000),
    });
    const first = await adapter.execute(
      "get_drawer",
      { drawer_id: "drawer-cursor-shape" },
      { callerId: "primary:cursor-shape" }
    );
    const validCursor = requireCursor(requireExactPayload(payloadOf(first.result)));
    const validPayload = readCursorPayload(validCursor);
    const malformedPayloads = [
      { ...validPayload, unexpected: true },
      Object.fromEntries(Object.entries(validPayload).filter(([key]) => key !== "revision")),
    ];

    for (const malformedPayload of malformedPayloads) {
      const cursor = signCursor(malformedPayload, config.cursorKey);
      const execution = await adapter.execute(
        "get_drawer",
        { drawer_id: "drawer-cursor-shape", cursor },
        { callerId: "primary:cursor-shape" }
      );
      const envelope = payloadOf(execution.result);

      expect(execution).toMatchObject({
        code: "MEMPALACE_CURSOR_INVALID",
        truncated: false,
        page: 1,
      });
      expect(envelope).toEqual({
        schema_version: 1,
        ok: false,
        type: "memory_error",
        error: {
          code: "MEMPALACE_CURSOR_INVALID",
          message: "Memory continuation cursor is invalid",
          retryable: false,
        },
        request_id: null,
      });
    }
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
    const normalized = parseJson(collected.bytes.toString("utf8"));
    if (!isRecord(normalized)) throw new Error("continued drawer list was not an object");
    expect(requireArray(normalized.drawers, "continued drawer list omitted drawers")).toHaveLength(
      20
    );
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
    const cursor = requireCursor(requirePagePayload(payloadOf(first.result)));
    const second = await changing.adapter.execute(
      "list_drawers",
      { limit: 20, include_full: true, cursor },
      { callerId: "primary:list" }
    );
    expect(errorCodeOf(second.result)).toBe("MEMPALACE_CURSOR_STALE");
  });
});

describe("result-budget telemetry metadata", () => {
  it("emits a correlation key without claiming that a compaction trial ran", async () => {
    const { adapter } = adapterForPayload({
      drawer_id: "drawer-telemetry",
      content: "bounded telemetry fixture",
    });
    const events: Array<{ event: string; context: Record<string, unknown> }> = [];
    const tool = createPrimaryMemoryTools({
      adapter,
      callerId: () => "primary:telemetry-session",
      telemetry: {
        info: (event, context) => events.push({ event, context }),
        warn: (event, context) => events.push({ event, context }),
      },
    }).find((candidate) => candidate.name === "memory_get_drawer");

    expect(tool).toBeDefined();
    const registeredTool = requireDefined(tool, "memory_get_drawer tool was not created");
    await registeredTool.execute("telemetry-call", { drawer_id: "drawer-telemetry" });

    expect(events).toHaveLength(1);
    const firstEvent = requireDefined(events[0], "tool telemetry was not emitted");
    const context = projectTelemetryContext(firstEvent.context);
    expect(context.compactionCorrelation).toEqual({
      status: "not_evaluated",
      keys: ["session:telemetry-session"],
    });
    expect(context.releaseHeadroom.invariantPreserved).toBe(true);
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
    const payload = requireResultPayload(payloadOf(execution.result));
    const data = requireSearchResultData(payload.data);
    const firstResult = requireDefined(data.results[0], "memory search returned no results");
    expect(payload.type).toBe("memory_result");
    expect(data.mode).toBe("summary");
    expect(firstResult.content).toBeUndefined();
    expect(firstResult.summary_truncated).toBe(true);
    expect(firstResult.content_bytes).toBeGreaterThan(firstResult.summary_bytes);
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
    const normalized = parseJson(collected.bytes.toString("utf8"));
    if (!isRecord(normalized)) throw new Error("continued search result was not an object");
    const results = requireArray(normalized.results, "continued search result omitted results");
    const firstResult = requireFixture(results[0], "continued search result was empty");
    if (!isRecord(firstResult) || typeof firstResult.content !== "string") {
      throw new Error("continued search result omitted verbatim content");
    }
    expect(normalized.mode).toBe("verbatim");
    expect(results).toHaveLength(count);
    expect(firstResult.content).toContain("🙂");
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
      expect(parseJson(collected.bytes.toString("utf8"))).toEqual(upstream);
      expect(collected.pages.length).toBeGreaterThan(1);
    }
  );

  it("accounts for the complete Pi envelope rather than only returned text", async () => {
    const content = `quoted-"-slash-\\-🙂`.repeat(2_000);
    const { adapter, config } = adapterForPayload({ drawer_id: "d", content });
    const first = await adapter.execute(
      "get_drawer",
      { drawer_id: "d" },
      { callerId: "primary:envelope" }
    );
    const page = requireExactPayload(payloadOf(first.result));
    const measurement = measureToolResult(first.result);
    expect(measurement.bytes).toBe(first.serializedBytes);
    expect(measurement.bytes).toBeGreaterThan(Buffer.byteLength(page.content, "utf8"));
    expect(fitsToolResultBudget(measurement, config.budget)).toBe(true);
    expect(page.truncated).toBe(true);
  });
});
