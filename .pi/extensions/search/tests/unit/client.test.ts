import { describe, it, expect } from "vitest";
import {
  clampMaxResults,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESULTS,
  DEFAULT_TIMEOUT_MS,
  MAX_RESULTS_LIMIT,
  resolveConfig,
  SearchApiError,
  truncateContent,
  validateHttpUrl,
  webFetch,
  webSearch,
  type FetchLike,
  type SearchConfig,
} from "../../client.js";

const CONFIG: SearchConfig = {
  baseUrl: "https://ollama.com",
  apiKey: "test-key",
  timeoutMs: 5000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveConfig", () => {
  it("uses defaults when env is empty", () => {
    const config = resolveConfig({});
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.apiKey).toBe("");
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("reads OLLAMA_API_KEY and trims whitespace", () => {
    expect(resolveConfig({ OLLAMA_API_KEY: "  abc  " }).apiKey).toBe("abc");
  });

  it("strips trailing slashes from base URL override", () => {
    const config = resolveConfig({ OLLAMA_WEB_SEARCH_BASE_URL: "http://localhost:8080///" });
    expect(config.baseUrl).toBe("http://localhost:8080");
  });

  it("ignores invalid timeout overrides", () => {
    expect(resolveConfig({ OLLAMA_WEB_SEARCH_TIMEOUT_MS: "nope" }).timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS
    );
    expect(resolveConfig({ OLLAMA_WEB_SEARCH_TIMEOUT_MS: "-1" }).timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS
    );
    expect(resolveConfig({ OLLAMA_WEB_SEARCH_TIMEOUT_MS: "10000" }).timeoutMs).toBe(10000);
  });
});

describe("clampMaxResults", () => {
  it("defaults when undefined", () => {
    expect(clampMaxResults(undefined)).toBe(DEFAULT_MAX_RESULTS);
  });

  it("clamps to the API limit", () => {
    expect(clampMaxResults(50)).toBe(MAX_RESULTS_LIMIT);
  });

  it("clamps to a minimum of 1 and floors fractions", () => {
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxResults(-5)).toBe(1);
    expect(clampMaxResults(3.9)).toBe(3);
  });
});

describe("truncateContent", () => {
  it("passes short content through", () => {
    expect(truncateContent("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("truncates long content", () => {
    const { text, truncated } = truncateContent("a".repeat(20), 10);
    expect(text).toHaveLength(10);
    expect(truncated).toBe(true);
  });
});

describe("validateHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(validateHttpUrl("https://example.com/page")).toBeNull();
    expect(validateHttpUrl("http://localhost:8080")).toBeNull();
  });

  it("rejects non-http schemes", () => {
    expect(validateHttpUrl("ftp://example.com")).toMatch(/Unsupported URL scheme/);
    expect(validateHttpUrl("file:///etc/passwd")).toMatch(/Unsupported URL scheme/);
  });

  it("rejects unparseable URLs", () => {
    expect(validateHttpUrl("not a url")).toMatch(/Invalid URL/);
  });
});

describe("webSearch", () => {
  it("posts query and bearer token, returns results", async () => {
    let captured: { input: string; init: RequestInit } | null = null;
    const fetchImpl: FetchLike = async (input, init) => {
      captured = { input, init };
      return jsonResponse({
        results: [{ title: "T", url: "https://x.com", content: "C" }],
      });
    };

    const response = await webSearch("test query", 3, CONFIG, undefined, fetchImpl);

    expect(response.results).toEqual([{ title: "T", url: "https://x.com", content: "C" }]);
    expect(captured!.input).toBe("https://ollama.com/api/web_search");
    expect(captured!.init.method).toBe("POST");
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key"
    );
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      query: "test query",
      max_results: 3,
    });
  });

  it("normalizes a missing results array", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({});
    const response = await webSearch("q", 5, CONFIG, undefined, fetchImpl);
    expect(response.results).toEqual([]);
  });

  it("throws api_key_missing without calling fetch when key is empty", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return jsonResponse({});
    };
    const err = await webSearch("q", 5, { ...CONFIG, apiKey: "" }, undefined, fetchImpl).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(SearchApiError);
    expect((err as SearchApiError).kind).toBe("api_key_missing");
    expect(called).toBe(false);
  });

  it("maps 401 to client_error with an auth hint", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "unauthorized" }, 401);
    const err = await webSearch("q", 5, CONFIG, undefined, fetchImpl).catch((e: unknown) => e);
    expect((err as SearchApiError).kind).toBe("client_error");
    expect((err as SearchApiError).message).toMatch(/OLLAMA_API_KEY/);
    expect((err as SearchApiError).status).toBe(401);
  });

  it("maps 500 to server_error", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "boom" }, 500);
    const err = await webSearch("q", 5, CONFIG, undefined, fetchImpl).catch((e: unknown) => e);
    expect((err as SearchApiError).kind).toBe("server_error");
  });

  it("maps fetch rejection to network_error", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connection refused");
    };
    const err = await webSearch("q", 5, CONFIG, undefined, fetchImpl).catch((e: unknown) => e);
    expect((err as SearchApiError).kind).toBe("network_error");
    expect((err as SearchApiError).message).toMatch(/connection refused/);
  });

  it("maps AbortError to aborted", async () => {
    const fetchImpl: FetchLike = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const err = await webSearch("q", 5, CONFIG, undefined, fetchImpl).catch((e: unknown) => e);
    expect((err as SearchApiError).kind).toBe("aborted");
  });
});

describe("webFetch", () => {
  it("posts url and returns normalized page data", async () => {
    let captured: { input: string; init: RequestInit } | null = null;
    const fetchImpl: FetchLike = async (input, init) => {
      captured = { input, init };
      return jsonResponse({ title: "Page", content: "Body", links: ["https://a.com"] });
    };

    const page = await webFetch("https://example.com", CONFIG, undefined, fetchImpl);

    expect(page).toEqual({ title: "Page", content: "Body", links: ["https://a.com"] });
    expect(captured!.input).toBe("https://ollama.com/api/web_fetch");
    expect(JSON.parse(captured!.init.body as string)).toEqual({ url: "https://example.com" });
  });

  it("normalizes missing fields", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({});
    const page = await webFetch("https://example.com", CONFIG, undefined, fetchImpl);
    expect(page).toEqual({ title: "", content: "", links: [] });
  });

  it("throws server_error on invalid JSON", async () => {
    const fetchImpl: FetchLike = async () => new Response("<html>not json</html>", { status: 200 });
    const err = await webFetch("https://example.com", CONFIG, undefined, fetchImpl).catch(
      (e: unknown) => e
    );
    expect((err as SearchApiError).kind).toBe("server_error");
  });
});
