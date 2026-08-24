import { describe, expect, it } from "vitest";
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

function requestJson(init: RequestInit): unknown {
  if (typeof init.body !== "string") throw new Error("expected a string request body");
  const value: unknown = JSON.parse(init.body);
  return value;
}

async function searchApiError(operation: Promise<unknown>): Promise<SearchApiError> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof SearchApiError) return error;
    throw error;
  }
  throw new Error("expected a SearchApiError");
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
    const capturedRequests: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      capturedRequests.push({ input, init });
      return jsonResponse({
        results: [{ title: "T", url: "https://x.com", content: "C" }],
      });
    };

    const response = await webSearch("test query", 3, CONFIG, undefined, fetchImpl);

    expect(response.results).toEqual([{ title: "T", url: "https://x.com", content: "C" }]);
    const captured = capturedRequests[0];
    if (captured === undefined) throw new Error("web search request was not captured");
    expect(captured.input).toBe("https://ollama.com/api/web_search");
    expect(captured.init.method).toBe("POST");
    expect(new Headers(captured.init.headers).get("Authorization")).toBe("Bearer test-key");
    expect(requestJson(captured.init)).toEqual({
      query: "test query",
      max_results: 3,
    });
  });

  it("normalizes missing and wrong-type results containers", async () => {
    for (const body of [{}, { results: "not-an-array" }, { results: null }]) {
      const fetchImpl: FetchLike = async () => jsonResponse(body);
      const response = await webSearch("q", 5, CONFIG, undefined, fetchImpl);
      expect(response.results).toEqual([]);
    }
  });

  it("accepts open response objects and preserves result extras", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        request_id: "ignored-at-envelope",
        results: [
          {
            title: "T",
            url: "https://x.com",
            content: "C",
            score: 0.9,
          },
        ],
      });
    const response = await webSearch("q", 5, CONFIG, undefined, fetchImpl);
    expect(response).toEqual({
      results: [{ title: "T", url: "https://x.com", content: "C", score: 0.9 }],
    });
  });

  it("rejects malformed top-level responses with the existing server error class", async () => {
    for (const body of [null, [], "response"]) {
      const fetchImpl: FetchLike = async () => jsonResponse(body);
      const error = await searchApiError(webSearch("q", 5, CONFIG, undefined, fetchImpl));
      expect(error.kind).toBe("server_error");
      expect(error.status).toBe(200);
      expect(error.message).toMatch(/malformed response/);
    }
  });

  it("rejects result entries with missing or wrong-type known fields", async () => {
    for (const result of [
      { title: "T", url: "https://x.com" },
      { title: "T", url: 42, content: "C" },
    ]) {
      const fetchImpl: FetchLike = async () => jsonResponse({ results: [result] });
      const error = await searchApiError(webSearch("q", 5, CONFIG, undefined, fetchImpl));
      expect(error.kind).toBe("server_error");
      expect(error.message).toMatch(/title, url, and content/);
    }
  });

  it("throws api_key_missing without calling fetch when key is empty", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return jsonResponse({});
    };
    const error = await searchApiError(
      webSearch("q", 5, { ...CONFIG, apiKey: "" }, undefined, fetchImpl)
    );
    expect(error.kind).toBe("api_key_missing");
    expect(called).toBe(false);
  });

  it("maps 401 to client_error with an auth hint", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "unauthorized" }, 401);
    const error = await searchApiError(webSearch("q", 5, CONFIG, undefined, fetchImpl));
    expect(error.kind).toBe("client_error");
    expect(error.message).toMatch(/OLLAMA_API_KEY/);
    expect(error.status).toBe(401);
  });

  it("maps 500 to server_error", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "boom" }, 500);
    const error = await searchApiError(webSearch("q", 5, CONFIG, undefined, fetchImpl));
    expect(error.kind).toBe("server_error");
  });

  it("maps fetch rejection to network_error", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connection refused");
    };
    const error = await searchApiError(webSearch("q", 5, CONFIG, undefined, fetchImpl));
    expect(error.kind).toBe("network_error");
    expect(error.message).toMatch(/connection refused/);
  });

  it("maps AbortError to aborted", async () => {
    const fetchImpl: FetchLike = async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    };
    const error = await searchApiError(webSearch("q", 5, CONFIG, undefined, fetchImpl));
    expect(error.kind).toBe("aborted");
  });
});

describe("webFetch", () => {
  it("posts url and returns normalized page data", async () => {
    const capturedRequests: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      capturedRequests.push({ input, init });
      return jsonResponse({ title: "Page", content: "Body", links: ["https://a.com"] });
    };

    const page = await webFetch("https://example.com", CONFIG, undefined, fetchImpl);

    expect(page).toEqual({ title: "Page", content: "Body", links: ["https://a.com"] });
    const captured = capturedRequests[0];
    if (captured === undefined) throw new Error("web fetch request was not captured");
    expect(captured.input).toBe("https://ollama.com/api/web_fetch");
    expect(requestJson(captured.init)).toEqual({ url: "https://example.com" });
  });

  it("normalizes missing and wrong-type fields", async () => {
    for (const body of [{}, { title: 1, content: false, links: "not-an-array" }]) {
      const fetchImpl: FetchLike = async () => jsonResponse(body);
      const page = await webFetch("https://example.com", CONFIG, undefined, fetchImpl);
      expect(page).toEqual({ title: "", content: "", links: [] });
    }

    const malformedLinks: FetchLike = async () =>
      jsonResponse({ title: "Page", content: "Body", links: ["https://a.com", 42] });
    const page = await webFetch("https://example.com", CONFIG, undefined, malformedLinks);
    expect(page).toEqual({ title: "Page", content: "Body", links: [] });
  });

  it("accepts extra fields but returns only the documented fetch fields", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        title: "Page",
        content: "Body",
        links: ["https://a.com"],
        request_id: "ignored",
      });
    const page = await webFetch("https://example.com", CONFIG, undefined, fetchImpl);
    expect(page).toEqual({ title: "Page", content: "Body", links: ["https://a.com"] });
  });

  it("rejects malformed top-level responses with the existing server error class", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(null);
    const error = await searchApiError(
      webFetch("https://example.com", CONFIG, undefined, fetchImpl)
    );
    expect(error.kind).toBe("server_error");
    expect(error.status).toBe(200);
  });

  it("throws server_error on invalid JSON", async () => {
    const fetchImpl: FetchLike = async () => new Response("<html>not json</html>", { status: 200 });
    const error = await searchApiError(
      webFetch("https://example.com", CONFIG, undefined, fetchImpl)
    );
    expect(error.kind).toBe("server_error");
    expect(error.status).toBe(200);
    expect(error.message).toMatch(/invalid JSON/);
  });
});
