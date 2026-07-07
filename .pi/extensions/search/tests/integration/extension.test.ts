import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import searchExtension from "../../index.js";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("search extension integration", () => {
  let tools: Map<string, RegisteredTool>;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tools = new Map();
    const mockPi = {
      registerTool: (tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      },
      on: () => {},
    } as unknown as ExtensionAPI;
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
    const result = await tools.get("web_search")!.execute("t1", { query: "anything" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/OLLAMA_API_KEY/);
  });

  it("web_search returns results end-to-end through the tool interface", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        expect(input).toBe("https://ollama.com/api/web_search");
        expect((init.headers as Record<string, string>).Authorization).toBe(
          "Bearer integration-key"
        );
        return jsonResponse({
          results: [{ title: "Doc", url: "https://docs.ollama.com", content: "snippet" }],
        });
      })
    );

    const result = await tools
      .get("web_search")!
      .execute("t2", { query: "ollama", max_results: 2 });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.query).toBe("ollama");
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].url).toBe("https://docs.ollama.com");
  });

  it("web_fetch rejects invalid URLs before hitting the network", async () => {
    process.env.OLLAMA_API_KEY = "integration-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await tools.get("web_fetch")!.execute("t3", { url: "file:///etc/passwd" });
    const payload = JSON.parse(result.content[0].text);
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

    const result = await tools.get("web_fetch")!.execute("t4", { url: "https://example.com" });
    const payload = JSON.parse(result.content[0].text);
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

    const result = await tools.get("web_search")!.execute("t5", { query: "q" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/Authentication failed/);
  });
});
