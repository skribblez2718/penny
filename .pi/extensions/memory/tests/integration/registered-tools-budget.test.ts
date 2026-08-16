import { describe, expect, it, vi } from "vitest";

import {
  HARD_MAX_ESTIMATED_TOKENS,
  HARD_MAX_RESULT_BYTES,
  HARD_MAX_RESULT_CHARACTERS,
  RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS,
  fitsToolResultBudget,
  measureToolResult,
  resolveToolResultBudget,
} from "../../../lib/tool-result-budget.js";
import { MemoryAdapter, createMemoryExtension } from "../../index.js";
import { createPrimaryMemoryTools } from "../../tools.js";
import {
  extensionEnv,
  mcpResponse,
  mcpToolErrorResponse,
  requestBody,
  testConfig,
} from "../fixtures.js";

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

describe("actual registered Pi tool result path", () => {
  it("returns outer Pi isError and non-OK telemetry for an HTTP-200 MCP tool error", async () => {
    const fetchSpy = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(mcpToolErrorResponse(requestBody(init).id, { results: [], count: 0 }))
    );
    const telemetry = { info: vi.fn(), warn: vi.fn() };
    const adapter = new MemoryAdapter(testConfig(), {
      fetch: fetchSpy as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    const search = createPrimaryMemoryTools({
      adapter,
      callerId: () => "primary:tool-error-test",
      telemetry,
    }).find((tool) => tool.name === "memory_search");
    expect(search).toBeDefined();

    const result = await search!.execute("tool-error", { query: "fixture" });
    const payload = parseResult(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      ok: false,
      type: "memory_error",
      error: { code: "MEMPALACE_UNAVAILABLE", retryable: false },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(telemetry.info).not.toHaveBeenCalled();
    expect(telemetry.warn).toHaveBeenCalledWith(
      "memory_tool_error",
      expect.objectContaining({
        tool: "memory_search",
        operation: "search",
        code: "MEMPALACE_UNAVAILABLE",
      })
    );
  });

  it("hard-bounds and exactly reassembles a giant drawer through memory_get_drawer", async () => {
    const content = "actual-tool🙂漢字/".repeat(5_000);
    const fetchSpy = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      expect(request.params.name).toBe("mempalace_get_drawer");
      return Promise.resolve(
        mcpResponse(request.id, {
          drawer_id: "registered-drawer",
          content,
          wing: "penny",
          room: "tests",
          filed_at: "2026-08-15T00:00:00Z",
        })
      );
    });
    const env = extensionEnv({
      PENNY_TOOL_RESULT_MAX_BYTES: String(HARD_MAX_RESULT_BYTES),
      PENNY_TOOL_RESULT_MAX_CHARACTERS: String(HARD_MAX_RESULT_CHARACTERS),
      PENNY_TOOL_RESULT_MAX_TOKENS: String(HARD_MAX_ESTIMATED_TOKENS),
    });
    const tools = new Map<string, any>();
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const pi = {
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      on(event: string, handler: (...args: any[]) => Promise<void>) {
        handlers.set(event, handler);
      },
    };
    createMemoryExtension({ env, fetch: fetchSpy as typeof fetch })(pi as any);
    await handlers.get("session_start")!(
      {},
      {
        sessionManager: { getSessionId: () => "registered-tool-session" },
      }
    );

    const get = tools.get("memory_get_drawer");
    expect(get).toBeDefined();
    const budget = resolveToolResultBudget(env);
    const chunks: Buffer[] = [];
    let maximumObservedTokens = 0;
    let cursor: string | undefined;
    for (let pageNumber = 1; pageNumber < 256; pageNumber += 1) {
      const result = await get.execute(
        `tool-call-${pageNumber}`,
        { drawer_id: "registered-drawer", ...(cursor ? { cursor } : {}) },
        new AbortController().signal
      );
      const measurement = measureToolResult(result);
      maximumObservedTokens = Math.max(maximumObservedTokens, measurement.estimatedTokens);
      expect(fitsToolResultBudget(measurement, budget)).toBe(true);
      expect(measurement.bytes).toBeLessThanOrEqual(HARD_MAX_RESULT_BYTES);
      expect(measurement.characters).toBeLessThanOrEqual(HARD_MAX_RESULT_CHARACTERS);
      expect(measurement.estimatedTokens).toBeLessThanOrEqual(HARD_MAX_ESTIMATED_TOKENS);
      expect(measurement.estimatedTokens * 2).toBeLessThanOrEqual(
        RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS
      );
      const page = parseResult(result);
      expect(page.type).toBe("memory_exact");
      chunks.push(Buffer.from(page.content, "utf8"));
      if (!page.truncated) break;
      cursor = page.continuation.cursor;
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks).equals(Buffer.from(content, "utf8"))).toBe(true);
    expect(maximumObservedTokens).toBeLessThanOrEqual(HARD_MAX_ESTIMATED_TOKENS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
