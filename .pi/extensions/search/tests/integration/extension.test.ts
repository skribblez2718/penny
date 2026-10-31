import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import searchExtension, {
  cleanupStaleWebSearchSpills,
  WEB_SEARCH_MAX_OUTPUT_LINES,
  WEB_SEARCH_MAX_SPILLS_PER_SESSION,
  WEB_SEARCH_STALE_SPILL_AGE_MS,
  truncateWebSearchLines,
} from "../../index.js";
import {
  HARD_MAX_RESULT_BYTES,
  fitsToolResultBudget,
  measureToolResult,
  resolveToolResultBudget,
} from "../../../lib/tool-result-budget.js";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import {
  isRecord,
  parseJson,
  requireArray,
  requireArrayElement,
  requireRecord,
} from "../../../../lib/tests/test-narrowers.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

function isEventHandler(
  value: unknown
): value is (event: unknown, context: unknown) => Promise<unknown> | unknown {
  return typeof value === "function";
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.execute === "function"
  );
}

function resultPayload(
  result: Awaited<ReturnType<RegisteredTool["execute"]>>
): Record<string, unknown> {
  const content = requireArrayElement(result.content, 0, "search tool returned no content");
  return requireRecord(parseJson(content.text), "search tool returned a non-object payload");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("search extension integration", () => {
  let tools: Map<string, RegisteredTool>;
  let activeTools: string[];
  let eventHandlers: Map<string, (event: unknown, context: unknown) => Promise<void>>;
  const savedEnv = { ...process.env };

  function getTool(name: string): RegisteredTool {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  }

  beforeEach(() => {
    tools = new Map();
    activeTools = [];
    eventHandlers = new Map();
    const mockPi = createTestExtensionApi({
      getActiveTools: () => activeTools,
      onEvent(event, handler) {
        if (!isEventHandler(handler)) throw new Error("search event handler is invalid");
        eventHandlers.set(event, async (eventValue, contextValue) => {
          await handler(eventValue, contextValue);
        });
      },
      onRegisterTool(tool) {
        if (!isRegisteredTool(tool)) throw new Error("search extension registered an invalid tool");
        tools.set(tool.name, tool);
      },
    });
    searchExtension(mockPi);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.unstubAllGlobals();
  });

  it("registers web_search and web_fetch with fallback guidance", () => {
    expect([...tools.keys()].sort()).toEqual(["web_fetch", "web_search"]);
    expect(getTool("web_fetch").description).toMatch(/api\.github\.com/);
    expect(getTool("web_fetch").description).toMatch(/playwright_navigate/);
  });

  it("web_search returns success:false with guidance when OLLAMA_API_KEY is missing", async () => {
    delete process.env.OLLAMA_API_KEY;
    const result = await getTool("web_search").execute("t1", { query: "anything" });
    const payload = resultPayload(result);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/OLLAMA_API_KEY/);
  });

  it("web_search returns results end-to-end through the tool interface", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        expect(input).toBe("https://ollama.com/api/web_search");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer integration-key");
        return jsonResponse({
          results: [{ title: "Doc", url: "https://docs.ollama.com", content: "snippet" }],
        });
      })
    );

    const result = await getTool("web_search").execute("t2", {
      query: "ollama",
      max_results: 2,
    });
    const payload = resultPayload(result);
    const results = requireArray(payload.results, "web_search payload omitted results");
    const firstResult = requireRecord(
      requireArrayElement(results, 0, "web_search payload returned no result"),
      "web_search result was not an object"
    );
    expect(payload.success).toBe(true);
    expect(payload.query).toBe("ollama");
    expect(results).toHaveLength(1);
    expect(firstResult.url).toBe("https://docs.ollama.com");
  });

  it("web_search preserves the established JSON representation for bounded responses", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    const body = {
      results: [{ title: "Doc", url: "https://docs.ollama.com", content: "small" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body))
    );

    const result = await getTool("web_search").execute("t2-small", { query: "bounded" });
    expect(result.content[0]?.text).toBe(
      JSON.stringify({ success: true, query: "bounded", results: body.results }, null, 2)
    );
  });

  it("web_search bounds oversized multiline UTF-8 output and exposes an owner-only full copy", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    const oversizedContent = Array.from(
      { length: WEB_SEARCH_MAX_OUTPUT_LINES + 500 },
      (_, index) => `line-${index}-${"x".repeat(30)}`
    ).join("\n");
    const body = {
      results: Array.from({ length: 5 }, (_, index) => ({
        title: `Large-${index}-🙂`,
        url: `https://example.com/large/${index}`,
        content: oversizedContent,
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body))
    );

    const result = await getTool("web_search").execute("t2-large", { query: "large" });
    const text = result.content[0]?.text ?? "";
    expect(
      fitsToolResultBudget(measureToolResult(result), resolveToolResultBudget(process.env))
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      HARD_MAX_RESULT_BYTES
    );
    expect(text.split("\n").length).toBeLessThanOrEqual(WEB_SEARCH_MAX_OUTPUT_LINES);
    expect(text).toContain("[web_search output truncated]");
    expect(text).toContain("🙂");
    expect(text).not.toContain("�");
    const visible = text.slice(0, text.indexOf("\n[web_search output truncated]"));
    const completeSerialization = JSON.stringify(
      { success: true, query: "large", results: body.results },
      null,
      2
    );
    expect(completeSerialization.startsWith(visible)).toBe(true);
    expect(completeSerialization.slice(visible.length, visible.length + 1)).toBe("\n");

    const pathMatch = /^Full result: (.+)$/mu.exec(text);
    expect(pathMatch?.[1]).toBeDefined();
    const fullResultPath = pathMatch?.[1] ?? "";
    try {
      expect(JSON.parse(readFileSync(fullResultPath, "utf8"))).toEqual({
        success: true,
        query: "large",
        results: body.results,
      });
      expect(statSync(fullResultPath).mode & 0o077).toBe(0);
      expect(statSync(dirname(fullResultPath)).mode & 0o077).toBe(0);
    } finally {
      if (fullResultPath.length > 0)
        rmSync(dirname(fullResultPath), { recursive: true, force: true });
    }
  });

  it("web_search bounds a single oversized line without splitting UTF-8", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    const body = {
      results: [
        {
          title: "Large",
          url: "https://example.com/large",
          content: "🙂".repeat(HARD_MAX_RESULT_BYTES),
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body))
    );

    const result = await getTool("web_search").execute("t2-bytes", { query: "large" });
    const text = result.content[0]?.text ?? "";
    expect(
      fitsToolResultBudget(measureToolResult(result), resolveToolResultBudget(process.env))
    ).toBe(true);
    expect(text).not.toContain("�");
    const fullResultPath = /^Full result: (.+)$/mu.exec(text)?.[1] ?? "";
    if (fullResultPath.length > 0)
      rmSync(dirname(fullResultPath), { recursive: true, force: true });
  });

  it("applies the independent 2,000-line defense at complete line boundaries", () => {
    const source = Array.from(
      { length: WEB_SEARCH_MAX_OUTPUT_LINES + 25 },
      (_, index) => `line-${index}`
    ).join("\n");
    const bounded = truncateWebSearchLines(source, WEB_SEARCH_MAX_OUTPUT_LINES);
    expect(bounded.truncated).toBe(true);
    expect(bounded.content.split("\n")).toHaveLength(WEB_SEARCH_MAX_OUTPUT_LINES);
    expect(bounded.content.endsWith(`line-${WEB_SEARCH_MAX_OUTPUT_LINES - 1}`)).toBe(true);
  });

  it("web_search honors owner-supplied lower caps on the complete result envelope", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    process.env.PENNY_TOOL_RESULT_MAX_BYTES = "4096";
    process.env.PENNY_TOOL_RESULT_MAX_CHARACTERS = "4096";
    process.env.PENNY_TOOL_RESULT_MAX_TOKENS = "4096";
    const body = {
      results: [
        {
          title: "Large",
          url: "https://example.com/large",
          content: 'escaped-\\-"-🙂'.repeat(10_000),
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body))
    );

    const result = await getTool("web_search").execute("t2-lower-cap", { query: "large" });
    const measurement = measureToolResult(result);
    expect(fitsToolResultBudget(measurement, resolveToolResultBudget(process.env))).toBe(true);
    expect(measurement.bytes).toBeLessThanOrEqual(4096);
    expect(measurement.characters).toBeLessThanOrEqual(4096);
    const fullResultPath = /^Full result: (.+)$/mu.exec(result.content[0]?.text ?? "")?.[1] ?? "";
    if (fullResultPath.length > 0) {
      rmSync(dirname(fullResultPath), { recursive: true, force: true });
    }
  });

  it("removes full-result spill files at session shutdown", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    const body = {
      results: [
        {
          title: "Large",
          url: "https://example.com/large",
          content: "🙂".repeat(HARD_MAX_RESULT_BYTES),
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body))
    );

    const result = await getTool("web_search").execute("t2-cleanup", { query: "large" });
    const fullResultPath = /^Full result: (.+)$/mu.exec(result.content[0]?.text ?? "")?.[1] ?? "";
    expect(existsSync(fullResultPath)).toBe(true);
    const shutdown = eventHandlers.get("session_shutdown");
    if (shutdown === undefined) throw new Error("session_shutdown handler is absent");
    await shutdown({}, {});
    expect(existsSync(fullResultPath)).toBe(false);
  });

  it("keeps only the bounded newest spill set for one session", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [
            {
              title: "Large",
              url: "https://example.com/large",
              content: "x".repeat(HARD_MAX_RESULT_BYTES * 2),
            },
          ],
        })
      )
    );
    const paths: string[] = [];
    for (let index = 0; index < WEB_SEARCH_MAX_SPILLS_PER_SESSION + 1; index += 1) {
      const result = await getTool("web_search").execute(`t2-quota-${index}`, {
        query: `large-${index}`,
      });
      const fullResultPath = /^Full result: (.+)$/mu.exec(result.content[0]?.text ?? "")?.[1];
      if (fullResultPath === undefined) throw new Error(`spill ${index} path is absent`);
      paths.push(fullResultPath);
    }

    expect(existsSync(paths[0] ?? "")).toBe(false);
    for (const retained of paths.slice(-WEB_SEARCH_MAX_SPILLS_PER_SESSION)) {
      expect(existsSync(retained)).toBe(true);
    }
    const shutdown = eventHandlers.get("session_shutdown");
    if (shutdown === undefined) throw new Error("session_shutdown handler is absent");
    await shutdown({}, {});
  });

  it("removes bounded stale spills left by abnormal termination", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [
            {
              title: "Large",
              url: "https://example.com/large",
              content: "🙂".repeat(HARD_MAX_RESULT_BYTES),
            },
          ],
        })
      )
    );
    const result = await getTool("web_search").execute("t2-stale", { query: "large" });
    const fullResultPath = /^Full result: (.+)$/mu.exec(result.content[0]?.text ?? "")?.[1] ?? "";
    if (fullResultPath.length === 0) throw new Error("stale spill path is absent");
    const directory = dirname(fullResultPath);
    const oldTime = new Date(Date.now() - WEB_SEARCH_STALE_SPILL_AGE_MS - 1_000);
    utimesSync(directory, oldTime, oldTime);

    cleanupStaleWebSearchSpills();
    expect(existsSync(directory)).toBe(false);
  });

  it("web_search rejects provider result counts above the requested maximum", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: Array.from({ length: 6 }, (_, index) => ({
            title: `Result ${index}`,
            url: `https://example.com/${index}`,
            content: "snippet",
          })),
        })
      )
    );

    const result = await getTool("web_search").execute("t2-count", { query: "large" });
    const payload = resultPayload(result);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/received 6 results for a maximum of 5/u);
  });

  it("web_fetch rejects invalid URLs before hitting the network", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await getTool("web_fetch").execute("t3", {
      url: "file:///etc/passwd",
    });
    const payload = resultPayload(result);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/Unsupported URL scheme/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("web_fetch returns page content end-to-end through the tool interface", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        expect(input).toBe("https://ollama.com/api/web_fetch");
        return jsonResponse({ title: "Page", content: "Full text", links: ["https://a.com"] });
      })
    );

    const result = await getTool("web_fetch").execute("t4", {
      url: "https://example.com",
    });
    const payload = resultPayload(result);
    expect(payload.success).toBe(true);
    expect(payload.title).toBe("Page");
    expect(payload.content).toBe("Full text");
    expect(payload.truncated).toBe(false);
    expect(payload.links).toEqual(["https://a.com"]);
  });

  it("web_search surfaces API errors as success:false", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401))
    );

    const result = await getTool("web_search").execute("t5", { query: "q" });
    const payload = resultPayload(result);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/Authentication failed/);
  });

  it("web_fetch reports generic provider failures against the requested URL", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    activeTools = ["playwright_navigate"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "page unsupported" }, 404))
    );

    const result = await getTool("web_fetch").execute("t6", {
      url: "https://example.com/page",
    });
    const payload = resultPayload(result);
    const retry = requireRecord(payload.retry_with, "web_fetch payload omitted retry guidance");
    const retryArguments = requireRecord(retry.arguments, "retry guidance omitted arguments");
    expect(payload.success).toBe(false);
    expect(payload.url).toBe("https://example.com/page");
    expect(payload.error).toMatch(/Unable to fetch the requested URL/);
    expect(payload.error).not.toContain("/api/web_fetch returned HTTP 404");
    expect(payload.failure_scope).toBe("target_fetch");
    expect(payload.provider_status).toBe(404);
    expect(payload.diagnostic).toMatch(/not proof of the destination/);
    expect(retry.tool).toBe("playwright_navigate");
    expect(retry.available).toBe(true);
    expect(retryArguments.url).toBe("https://example.com/page");
  });

  it("web_fetch automatically retries safe GitHub routes through api.github.com", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    const requestedUrls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, init: RequestInit) => {
        if (typeof init.body !== "string") throw new Error("expected a JSON request body");
        const body = requireRecord(parseJson(init.body), "expected a request object");
        requestedUrls.push(body.url);
        if (requestedUrls.length === 1) {
          return jsonResponse({ error: "page unsupported" }, 404);
        }
        return jsonResponse({
          title: "GitHub API",
          content:
            '{"title":"Example issue","number":42,"html_url":"https://github.com/owner/repo/issues/42"}',
          links: [],
        });
      })
    );

    const result = await getTool("web_fetch").execute("t7", {
      url: "https://github.com/owner/repo/issues/42",
    });
    const payload = resultPayload(result);
    const fallback = requireRecord(payload.fallback, "web_fetch payload omitted fallback metadata");
    expect(payload.success).toBe(true);
    expect(payload.url).toBe("https://github.com/owner/repo/issues/42");
    expect(payload.content).toContain("Example issue");
    expect(fallback.strategy).toBe("github_api");
    expect(fallback.kind).toBe("issue");
    expect(fallback.fetched_url).toBe("https://api.github.com/repos/owner/repo/issues/42");
    expect(requestedUrls).toEqual([
      "https://github.com/owner/repo/issues/42",
      "https://api.github.com/repos/owner/repo/issues/42",
    ]);
  });

  it("web_fetch decodes raw GitHub file content returned by the API fallback", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) return jsonResponse({ error: "page unsupported" }, 404);
        return jsonResponse({
          title: "GitHub API",
          content: JSON.stringify({
            type: "file",
            name: "README.md",
            encoding: "base64",
            content: Buffer.from("# Read me\n").toString("base64"),
            download_url: "https://raw.githubusercontent.com/owner/repo/main/README.md",
          }),
          links: [],
        });
      })
    );

    const commitSha = "a".repeat(40);
    const result = await getTool("web_fetch").execute("t8", {
      url: `https://raw.githubusercontent.com/owner/repo/${commitSha}/README.md`,
    });
    const payload = resultPayload(result);
    expect(payload.success).toBe(true);
    expect(payload.title).toBe("README.md");
    expect(payload.content).toBe("# Read me\n");
    expect(payload.links).toEqual(["https://raw.githubusercontent.com/owner/repo/main/README.md"]);
  });

  it("web_fetch does not report unusable GitHub API content as success", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse({ error: "page unsupported" }, 404)
          : jsonResponse({ title: "GitHub API", content: "", links: [] });
      })
    );

    const result = await getTool("web_fetch").execute("t9", {
      url: "https://github.com/owner/repo",
    });
    const payload = resultPayload(result);
    const fallback = requireRecord(
      payload.github_api_fallback,
      "web_fetch payload omitted the unusable GitHub API attempt"
    );
    const retry = requireRecord(payload.retry_with, "web_fetch payload omitted retry guidance");
    expect(payload.success).toBe(false);
    expect(fallback.error).toMatch(/not valid JSON/);
    expect(retry.available).toBe(false);
  });

  it("web_fetch reports a failed GitHub API attempt before recommending Playwright", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    activeTools = ["playwright_navigate"];
    const fetchMock = vi.fn(async (_input: string) =>
      jsonResponse({ error: "page unsupported" }, 404)
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getTool("web_fetch").execute("t10", {
      url: "https://github.com/owner/repo",
    });
    const payload = resultPayload(result);
    const fallback = requireRecord(
      payload.github_api_fallback,
      "web_fetch payload omitted the failed GitHub API attempt"
    );
    const retry = requireRecord(payload.retry_with, "web_fetch payload omitted retry guidance");
    expect(payload.success).toBe(false);
    expect(fallback.kind).toBe("repository");
    expect(fallback.url).toBe("https://api.github.com/repos/owner/repo");
    expect(fallback.error).toMatch(/Unable to fetch the requested URL/);
    expect(retry.tool).toBe("playwright_navigate");
    expect(retry.available).toBe(true);
    const providerCalls = fetchMock.mock.calls.filter(
      ([input]) => input === "https://ollama.com/api/web_fetch"
    );
    expect(providerCalls).toHaveLength(2);
  });

  it("web_fetch does not retry a caller cancellation", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    activeTools = ["playwright_navigate"];
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      })
    );

    const result = await getTool("web_fetch").execute(
      "t11",
      { url: "https://github.com/owner/repo" },
      controller.signal
    );
    const payload = resultPayload(result);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/caller cancelled/);
    expect(payload.failure_scope).toBe("cancelled");
    expect(payload).not.toHaveProperty("retry_with");
    expect(payload).not.toHaveProperty("github_api_fallback");
  });

  it("web_fetch does not dispatch a GitHub fallback after caller cancellation", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    activeTools = ["playwright_navigate"];
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: string) => {
      controller.abort();
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getTool("web_fetch").execute(
      "t12",
      { url: "https://github.com/owner/repo" },
      controller.signal
    );
    const payload = resultPayload(result);
    expect(payload.failure_scope).toBe("cancelled");
    expect(payload).not.toHaveProperty("retry_with");
    const providerCalls = fetchMock.mock.calls.filter(
      ([input]) => input === "https://ollama.com/api/web_fetch"
    );
    expect(providerCalls).toHaveLength(1);
  });

  it("web_fetch does not recommend Playwright after cancellation during a failed fallback", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    activeTools = ["playwright_navigate"];
    const controller = new AbortController();
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        if (attempt === 2) controller.abort();
        return jsonResponse({}, 404);
      })
    );

    const result = await getTool("web_fetch").execute(
      "t13",
      { url: "https://github.com/owner/repo" },
      controller.signal
    );
    const payload = resultPayload(result);
    expect(attempt).toBe(2);
    expect(payload.failure_scope).toBe("cancelled");
    expect(payload.primary_provider_status).toBe(404);
    expect(payload).not.toHaveProperty("retry_with");
  });

  it("web_fetch does not retry a 451 response through GitHub or Playwright", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    activeTools = ["playwright_navigate"];
    const fetchMock = vi.fn(async (_input: string) => jsonResponse({}, 451));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getTool("web_fetch").execute("t14", {
      url: "https://github.com/owner/repo",
    });
    const payload = resultPayload(result);
    expect(payload.success).toBe(false);
    expect(payload.provider_status).toBe(451);
    expect(payload).not.toHaveProperty("retry_with");
    expect(payload).not.toHaveProperty("github_api_fallback");
    const providerCalls = fetchMock.mock.calls.filter(
      ([input]) => input === "https://ollama.com/api/web_fetch"
    );
    expect(providerCalls).toHaveLength(1);
  });

  it("web_fetch suppresses Playwright when the GitHub fallback returns 451", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    activeTools = ["playwright_navigate"];
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        return jsonResponse({}, attempt === 1 ? 404 : 451);
      })
    );

    const result = await getTool("web_fetch").execute("t15", {
      url: "https://github.com/owner/repo",
    });
    const payload = resultPayload(result);
    const fallback = requireRecord(
      payload.github_api_fallback,
      "web_fetch payload omitted the failed GitHub API attempt"
    );
    expect(payload.success).toBe(false);
    expect(payload.provider_status).toBe(451);
    expect(payload.primary_provider_status).toBe(404);
    expect(fallback.provider_status).toBe(451);
    expect(payload).not.toHaveProperty("retry_with");
  });
});
