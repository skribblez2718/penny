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
  const savedEnv = { ...process.env };

  function getTool(name: string): RegisteredTool {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  }

  beforeEach(() => {
    tools = new Map();
    const mockPi = createTestExtensionApi({
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

  it("registers web_search and web_fetch", () => {
    expect([...tools.keys()].sort()).toEqual(["web_fetch", "web_search"]);
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
});
