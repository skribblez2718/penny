import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  fitsToolResultBudget,
  measureToolResult,
  resolveToolResultBudget,
  type ToolResultBudget,
} from "../../../lib/tool-result-budget.js";
import { createMemoryExtension } from "../../index.js";
import { extensionEnv, mcpResponse, requestBody } from "../fixtures.js";

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function advisoryEnv() {
  return extensionEnv({
    PENNY_MEMORY_LOGSTREAM_MODE: "primary-advisory",
    PENNY_MEMORY_LOGSTREAM_STREAM: "project/advisory",
    PENNY_MEMORY_LOGSTREAM_ROOMS: "status",
  });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_20260816T120000_abcdef123456",
    seq: 1,
    origin_replica: "replica-test",
    origin_seq: 1,
    hlc: "0000000000001-000001-replica-test",
    type: "advisory.note",
    stream: "project/advisory",
    room: "status",
    from_agent: "penny-primary",
    to_agent: "penny-primary",
    correlation_id: "corr-read",
    branch: null,
    base_commit: null,
    status: null,
    artifact_ids: [],
    body: "hello",
    created_at: "2026-08-16T12:00:00Z",
    metadata: {},
    ...overrides,
  };
}

function registeredTools(fetchImpl: typeof fetch) {
  const tools = new Map<string, any>();
  createMemoryExtension({ env: advisoryEnv(), fetch: fetchImpl })({
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as any);
  return tools;
}

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

async function collectStructuredPages(options: {
  tool: any;
  params: Record<string, unknown>;
  budget: ToolResultBudget;
}) {
  const parts: Buffer[] = [];
  const pages: Record<string, any>[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 1; pageNumber < 128; pageNumber += 1) {
    const result = await options.tool.execute(
      `logstream-call-${pageNumber}`,
      { ...options.params, ...(cursor ? { cursor } : {}) },
      new AbortController().signal
    );
    expect(fitsToolResultBudget(measureToolResult(result), options.budget)).toBe(true);
    const page = parseResult(result);
    pages.push(page);
    if (page.type === "memory_result") parts.push(Buffer.from(JSON.stringify(page.data), "utf8"));
    else parts.push(Buffer.from(page.fragment, "utf8"));
    if (!page.truncated) return { pages, bytes: Buffer.concat(parts) };
    cursor = page.continuation.cursor;
  }
  throw new Error("advisory continuation did not terminate");
}

describe("registered advisory logstream tools", () => {
  it("bounds and exactly continues a twenty-event list with one upstream read", async () => {
    const events = Array.from({ length: 20 }, (_, index) =>
      event({
        id: `evt_20260816T1200${String(index).padStart(2, "0")}_${String(index).padStart(12, "a")}`,
        seq: index + 1,
        origin_seq: index + 1,
        body: `${index}:🙂`.repeat(300),
      })
    );
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      expect(request.params.name).toBe("mempalace_event_list");
      expect(request.params.arguments).toMatchObject({
        stream: "project/advisory",
        room: "status",
        from_agent: "penny-primary",
        to_agent: "penny-primary",
        limit: 20,
        preview: false,
      });
      return Promise.resolve(mcpResponse(request.id, { events, count: events.length }));
    });
    const tools = registeredTools(fetchSpy as typeof fetch);
    const list = tools.get("memory_logstream_list");
    expect(list).toBeDefined();
    const config = advisoryEnv();
    const budget = resolveToolResultBudget(config);
    const collected = await collectStructuredPages({
      tool: list,
      params: { room: "status", correlation_id: "corr-read", limit: 20 },
      budget,
    });

    const normalized = JSON.parse(collected.bytes.toString("utf8"));
    expect(normalized.events).toHaveLength(20);
    expect(normalized.events[0]).toEqual({
      event_id: events[0]!.id,
      type: "advisory.note",
      room: "status",
      correlation_id: "corr-read",
      status: null,
      body: events[0]!.body,
      created_at: "2026-08-16T12:00:00Z",
    });
    expect(collected.pages.length).toBeGreaterThan(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("continues an append response without replaying the ambiguous write", async () => {
    const body = "advisory🙂".repeat(550);
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      expect(request.params.name).toBe("mempalace_event_append");
      return Promise.resolve(
        mcpResponse(request.id, {
          success: true,
          event: event({ correlation_id: "corr-write", body }),
        })
      );
    });
    const tools = registeredTools(fetchSpy as typeof fetch);
    const append = tools.get("memory_logstream_append");
    const budget = resolveToolResultBudget(advisoryEnv());
    const collected = await collectStructuredPages({
      tool: append,
      params: {
        type: "advisory.note",
        room: "status",
        correlation_id: "corr-write",
        body,
      },
      budget,
    });

    expect(JSON.parse(collected.bytes.toString("utf8")).event.body).toBe(body);
    expect(collected.pages.length).toBeGreaterThan(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("contains only the four approved upstream event calls and no forbidden transport surfaces", () => {
    const production = readdirSync(extensionRoot)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(extensionRoot, name), "utf8"))
      .join("\n");
    expect(production).not.toMatch(
      /mempalace_artifact_(?:put|get)|mempalace_patch_submit|\/logstream\/stream|\/sync\/(?:ops|artifact|version_vector)|mempalace_mesh_peers/
    );
    for (const allowed of [
      "mempalace_event_append",
      "mempalace_event_list",
      "mempalace_event_wait",
      "mempalace_event_ack",
    ]) {
      expect(production).toContain(allowed);
    }
  });
});
