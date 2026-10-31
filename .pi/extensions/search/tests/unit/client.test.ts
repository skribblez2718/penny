import { describe, expect, it } from "vitest";
import {
  clampMaxResults,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESULTS,
  DEFAULT_TIMEOUT_MS,
  githubApiFallbackForUrl,
  MAX_PROVIDER_RESPONSE_BYTES,
  MAX_RESULTS_LIMIT,
  normalizeGithubApiFallbackPage,
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
const COMMIT_SHA = "a".repeat(40);

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

  it("rejects unparseable and credential-bearing URLs", () => {
    expect(validateHttpUrl("not a url")).toMatch(/Invalid URL/);
    expect(validateHttpUrl("https://user:secret@example.com/page")).toMatch(/embedded credentials/);
  });
});

describe("githubApiFallbackForUrl", () => {
  it("translates common GitHub HTML routes to public API URLs", () => {
    expect(githubApiFallbackForUrl("https://github.com/owner/repo")).toEqual({
      kind: "repository",
      url: "https://api.github.com/repos/owner/repo",
    });
    expect(githubApiFallbackForUrl("https://github.com/owner/repo/issues/42#discussion")).toEqual({
      kind: "issue",
      url: "https://api.github.com/repos/owner/repo/issues/42",
    });
    expect(githubApiFallbackForUrl("https://github.com/owner/repo/pull/7")).toEqual({
      kind: "pull_request",
      url: "https://api.github.com/repos/owner/repo/pulls/7",
    });
    expect(githubApiFallbackForUrl("https://github.com/owner/repo/commit/abc123")).toEqual({
      kind: "commit",
      url: "https://api.github.com/repos/owner/repo/commits/abc123",
    });
    expect(githubApiFallbackForUrl("https://github.com/owner/repo/releases/tag/v1.2.3")).toEqual({
      kind: "release",
      url: "https://api.github.com/repos/owner/repo/releases/tags/v1.2.3",
    });
    expect(githubApiFallbackForUrl("https://github.com/owner/repo/issues")).toEqual({
      kind: "issues",
      url: "https://api.github.com/repos/owner/repo/issues",
    });
    expect(githubApiFallbackForUrl("https://github.com/owner/repo/releases")).toEqual({
      kind: "releases",
      url: "https://api.github.com/repos/owner/repo/releases",
    });
  });

  it("translates immutable GitHub blob, tree, and raw content routes", () => {
    expect(
      githubApiFallbackForUrl(`https://github.com/owner/repo/blob/${COMMIT_SHA}/docs/read%20me.md`)
    ).toEqual({
      kind: "contents",
      url: `https://api.github.com/repos/owner/repo/contents/docs/read%20me.md?ref=${COMMIT_SHA}`,
      expectedContent: "file",
    });
    expect(
      githubApiFallbackForUrl(`https://github.com/owner/repo/tree/${COMMIT_SHA}/docs`)
    ).toEqual({
      kind: "contents",
      url: `https://api.github.com/repos/owner/repo/contents/docs?ref=${COMMIT_SHA}`,
      expectedContent: "directory",
    });
    expect(
      githubApiFallbackForUrl(
        `https://raw.githubusercontent.com/owner/repo/${COMMIT_SHA}/docs/config.json`
      )
    ).toEqual({
      kind: "contents",
      url: `https://api.github.com/repos/owner/repo/contents/docs/config.json?ref=${COMMIT_SHA}`,
      expectedContent: "file",
    });
  });

  it("rejects unrelated, ambiguous, credential-bearing, and encoded-slash routes", () => {
    expect(githubApiFallbackForUrl("https://example.com/owner/repo/issues/42")).toBeNull();
    expect(githubApiFallbackForUrl("https://github.com/search?q=repo")).toBeNull();
    expect(githubApiFallbackForUrl("https://user:secret@github.com/owner/repo")).toBeNull();
    expect(githubApiFallbackForUrl("https://github.com:444/owner/repo")).toBeNull();
    expect(githubApiFallbackForUrl("https://github.com/owner/repo/blob/main/file.md")).toBeNull();
    expect(
      githubApiFallbackForUrl(`https://github.com/owner/repo/blob/${COMMIT_SHA}/docs%2Fsecret`)
    ).toBeNull();
    expect(githubApiFallbackForUrl("https://github.com/owner/repo/actions")).toBeNull();
  });
});

describe("normalizeGithubApiFallbackPage", () => {
  it("validates route-specific GitHub API schemas and rejects error envelopes", () => {
    const fallback = githubApiFallbackForUrl("https://github.com/owner/repo");
    if (fallback === null) throw new Error("expected a GitHub API fallback");
    const validPage = {
      title: "repository",
      content: JSON.stringify({
        id: 1,
        full_name: "owner/repo",
        html_url: "https://github.com/owner/repo",
      }),
      links: [],
    };
    expect(normalizeGithubApiFallbackPage(validPage, fallback)).toEqual({
      success: true,
      page: validPage,
    });
    expect(
      normalizeGithubApiFallbackPage(
        {
          title: "GitHub API",
          content: JSON.stringify({ message: "API rate limit exceeded", status: "403" }),
          links: [],
        },
        fallback
      )
    ).toEqual({
      success: false,
      reason: "the GitHub API response did not match the expected repository schema",
    });
  });

  it("decodes bounded UTF-8 file content from the GitHub contents API", () => {
    const fallback = githubApiFallbackForUrl(
      `https://raw.githubusercontent.com/owner/repo/${COMMIT_SHA}/README.md`
    );
    if (fallback === null) throw new Error("expected a GitHub API fallback");
    const result = normalizeGithubApiFallbackPage(
      {
        title: "API response",
        content: JSON.stringify({
          type: "file",
          name: "README.md",
          encoding: "base64",
          content: Buffer.from("# Hello\n").toString("base64"),
          download_url: "https://raw.githubusercontent.com/owner/repo/main/README.md",
        }),
        links: [],
      },
      fallback
    );
    expect(result).toEqual({
      success: true,
      page: {
        title: "README.md",
        content: "# Hello\n",
        links: ["https://raw.githubusercontent.com/owner/repo/main/README.md"],
      },
    });
  });

  it("accepts an empty file and rejects malformed or noncanonical content", () => {
    const fallback = githubApiFallbackForUrl(
      `https://github.com/owner/repo/blob/${COMMIT_SHA}/file.txt`
    );
    if (fallback === null) throw new Error("expected a GitHub API fallback");
    const base = { title: "API response", links: [] };
    expect(
      normalizeGithubApiFallbackPage(
        {
          ...base,
          content: JSON.stringify({
            type: "file",
            name: "file.txt",
            encoding: "base64",
            content: "",
          }),
        },
        fallback
      )
    ).toEqual({
      success: true,
      page: { title: "file.txt", content: "", links: [] },
    });
    expect(normalizeGithubApiFallbackPage({ ...base, content: "not-json" }, fallback)).toEqual({
      success: false,
      reason: "the GitHub Contents API response was not valid JSON",
    });
    expect(
      normalizeGithubApiFallbackPage(
        {
          ...base,
          content: JSON.stringify({
            type: "file",
            name: "file.txt",
            encoding: "base64",
            content: "Zh==",
          }),
        },
        fallback
      )
    ).toEqual({
      success: false,
      reason: "the GitHub Contents API response used noncanonical base64",
    });
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

  it("rejects provider bodies whose declared size exceeds the fixed response cap", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
        },
      });
    const error = await searchApiError(webSearch("q", 5, CONFIG, undefined, fetchImpl));
    expect(error.kind).toBe("server_error");
    expect(error.reason).toBe("provider_response");
    expect(error.message).toMatch(/response exceeds/u);
  });

  it("rejects streamed provider bodies that exceed the cap without a length header", async () => {
    let emittedBytes = 0;
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (emittedBytes > MAX_PROVIDER_RESPONSE_BYTES) {
              controller.close();
              return;
            }
            const chunk = new Uint8Array(1024 * 1024);
            emittedBytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    const error = await searchApiError(webSearch("q", 5, CONFIG, undefined, fetchImpl));
    expect(error.kind).toBe("server_error");
    expect(error.reason).toBe("provider_response");
    expect(error.message).toMatch(/response exceeds/u);
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
    expect(error.operation).toBe("web_search");
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

  it("renews transport inactivity on response chunks beyond the former total timeout", async () => {
    const chunks = ['{"title":"Page",', '"content":"Body",', '"links":[]', "}"];
    const encoder = new TextEncoder();
    let index = 0;
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise<void>((resolve) => setTimeout(resolve, 30));
            const chunk = chunks[index];
            if (chunk === undefined) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(chunk));
            index += 1;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );

    await expect(
      webFetch("https://example.com", { ...CONFIG, timeoutMs: 60 }, undefined, fetchImpl)
    ).resolves.toEqual({ title: "Page", content: "Body", links: [] });
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
    expect(error.message).toMatch(/Unable to fetch the requested URL/);
    expect(error.message).toMatch(/invalid JSON/);
  });

  it("describes authentication failures as failures to fetch the requested URL", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "unauthorized" }, 401);
    const error = await searchApiError(
      webFetch("https://example.com/private", CONFIG, undefined, fetchImpl)
    );
    expect(error.kind).toBe("client_error");
    expect(error.reason).toBe("authentication");
    expect(error.message).toMatch(/Unable to fetch the requested URL/);
    expect(error.message).toMatch(/Authentication failed/);
  });

  it("describes provider HTTP failures as failures to fetch the requested URL", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "page unsupported" }, 404);
    const error = await searchApiError(
      webFetch("https://example.com/missing", CONFIG, undefined, fetchImpl)
    );
    expect(error.kind).toBe("client_error");
    expect(error.operation).toBe("web_fetch");
    expect(error.status).toBe(404);
    expect(error.targetUrl).toBe("https://example.com/missing");
    expect(error.message).toMatch(/Unable to fetch the requested URL/);
    expect(error.message).toMatch(/provider HTTP 404/);
    expect(error.message).toMatch(/does not establish that the destination URL itself returned/);
    expect(error.message).not.toContain("/api/web_fetch returned HTTP 404");
  });

  it("uses fetch-specific wording for network failures", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connection refused");
    };
    const error = await searchApiError(
      webFetch("https://example.com", CONFIG, undefined, fetchImpl)
    );
    expect(error.kind).toBe("network_error");
    expect(error.operation).toBe("web_fetch");
    expect(error.reason).toBe("network");
    expect(error.message).toMatch(/Unable to fetch the requested URL/);
    expect(error.message).toMatch(/connection refused/);
  });

  it("distinguishes caller cancellation from provider inactivity", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelledFetch: FetchLike = async () => {
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    };
    const cancelled = await searchApiError(
      webFetch("https://example.com", CONFIG, controller.signal, cancelledFetch)
    );
    expect(cancelled.reason).toBe("cancelled");
    expect(cancelled.message).toMatch(/caller cancelled/);

    const timedOutFetch: FetchLike = async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    };
    const timedOut = await searchApiError(
      webFetch("https://example.com", CONFIG, undefined, timedOutFetch)
    );
    expect(timedOut.reason).toBe("timeout");
    expect(timedOut.message).toMatch(/inactive/);
  });
});
