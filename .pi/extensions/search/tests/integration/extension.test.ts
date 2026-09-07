import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import searchExtension from "../../index.js";
import {
  createTestExtensionApi,
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
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
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
  const savedEnv = { ...process.env };

  function getTool(name: string): RegisteredTool {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  }

  beforeEach(() => {
    tools = new Map();
    activeTools = [];
    const mockPi = createTestExtensionApi({
      getActiveTools: () => activeTools,
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
