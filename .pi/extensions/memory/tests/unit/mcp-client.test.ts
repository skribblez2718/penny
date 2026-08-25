import { describe, expect, it, vi } from "vitest";

import { MemoryMcpClient } from "../../mcp-client.js";
import { MemoryError } from "../../types.js";
import {
  mcpResponse,
  mcpToolErrorResponse,
  requestBody,
  rpcErrorResponse,
  requireDefined,
  testConfig,
} from "../fixtures.js";

function hangingFetch(): typeof fetch {
  return ((_input: URL | RequestInfo, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      );
    })) as typeof fetch;
}

describe("platform-memory HTTP MCP client integration", () => {
  it("sends bounded JSON-RPC tools/call with request ID and bearer auth", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      return Promise.resolve(mcpResponse(request.id, { total: 3 }));
    });
    const client = new MemoryMcpClient(testConfig(), {
      fetch: fetchSpy as typeof fetch,
      randomId: () => "request-1",
    });

    const result = await client.call("get_taxonomy", {});
    expect(result.requestId).toBe("platform-memory-request-1");
    expect(result.payload).toEqual({ total: 3 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = requireDefined(fetchSpy.mock.calls[0], "MCP request was not sent");
    const [url, init] = firstCall;
    expect(url).toBe("http://127.0.0.1:8765/mcp");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${testConfig().bearerToken}`
    );
    expect(requestBody(init)).toEqual({
      jsonrpc: "2.0",
      id: "platform-memory-request-1",
      method: "tools/call",
      params: { name: "mempalace_get_taxonomy", arguments: {} },
    });
  });

  it("times out and aborts a safe read within the configured bound", async () => {
    const client = new MemoryMcpClient(testConfig({ timeoutMs: 100, maxReadAttempts: 1 }), {
      fetch: hangingFetch(),
    });
    await expect(client.call("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMPALACE_TIMEOUT",
      retryable: true,
    });
  });

  it("propagates caller cancellation without retry", async () => {
    const fetchSpy = vi.fn(hangingFetch());
    const client = new MemoryMcpClient(testConfig(), { fetch: fetchSpy as typeof fetch });
    const controller = new AbortController();
    const pending = client.call("search", { query: "x" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "MEMPALACE_CANCELLED" });
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("retries only known-safe idempotent reads", async () => {
    const readFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (readFetch.mock.calls.length < 3) {
        return Promise.resolve(new Response("busy", { status: 503 }));
      }
      const request = requestBody(init);
      return Promise.resolve(mcpResponse(request.id, { ok: true }));
    });
    const readClient = new MemoryMcpClient(testConfig(), {
      fetch: readFetch as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    expect((await readClient.call("search", { query: "x" })).attempts).toBe(3);

    const writeFetch = vi.fn(() => Promise.resolve(new Response("busy", { status: 503 })));
    const writeClient = new MemoryMcpClient(testConfig(), {
      fetch: writeFetch as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    await expect(
      writeClient.call("add_drawer", { wing: "w", room: "r", content: "c" })
    ).rejects.toMatchObject({ code: "MEMPALACE_UNAVAILABLE" });
    expect(writeFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects HTTP-200 MCP tool errors, retries only explicit safe-read failures, and never retries writes", async () => {
    const unknownReadFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(mcpToolErrorResponse(requestBody(init).id, { results: [] }))
    );
    const unknownRead = new MemoryMcpClient(testConfig(), {
      fetch: unknownReadFetch as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    await expect(unknownRead.call("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMPALACE_UNAVAILABLE",
      retryable: false,
    });
    expect(unknownReadFetch).toHaveBeenCalledTimes(1);

    const knownReadFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (knownReadFetch.mock.calls.length === 1) {
        return Promise.resolve(
          mcpToolErrorResponse(request.id, {
            error: { code: 503, message: "explicitly unavailable" },
          })
        );
      }
      return Promise.resolve(mcpResponse(request.id, { results: [] }));
    });
    const knownRead = new MemoryMcpClient(testConfig(), {
      fetch: knownReadFetch as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    expect((await knownRead.call("search", { query: "x" })).attempts).toBe(2);

    const writeFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        mcpToolErrorResponse(requestBody(init).id, {
          error: { code: 503, message: "write outcome is unknown" },
        })
      )
    );
    const write = new MemoryMcpClient(testConfig(), {
      fetch: writeFetch as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    await expect(
      write.call("add_drawer", { wing: "w", room: "r", content: "c" })
    ).rejects.toMatchObject({ code: "MEMPALACE_UNAVAILABLE", retryable: false });
    expect(writeFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, mismatched, and oversized responses as integrity failures", async () => {
    const malformed = new MemoryMcpClient(testConfig(), {
      fetch: (() =>
        Promise.resolve(
          new Response("not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )) as typeof fetch,
    });
    await expect(malformed.call("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMPALACE_INTEGRITY",
    });

    const mismatched = new MemoryMcpClient(testConfig(), {
      fetch: (() => Promise.resolve(mcpResponse("wrong-id", { ok: true }))) as typeof fetch,
    });
    await expect(mismatched.call("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMPALACE_INTEGRITY",
    });

    const oversized = new MemoryMcpClient(testConfig({ maxResponseBytes: 65_536 }), {
      fetch: ((_url: string | URL | Request, init?: RequestInit) => {
        const request = requestBody(init);
        return Promise.resolve(mcpResponse(request.id, { content: "x".repeat(70_000) }));
      }) as typeof fetch,
    });
    await expect(oversized.call("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMPALACE_INTEGRITY",
    });
  });

  it.each([
    [401, "MEMPALACE_UNAUTHORIZED"],
    [403, "MEMPALACE_UNAUTHORIZED"],
    [409, "MEMPALACE_CONFLICT"],
    [400, "MEMPALACE_INVALID"],
  ])("maps HTTP %i to typed %s", async (status, code) => {
    const client = new MemoryMcpClient(testConfig({ maxReadAttempts: 1 }), {
      fetch: (() => Promise.resolve(new Response("", { status }))) as typeof fetch,
    });
    await expect(client.call("search", { query: "x" })).rejects.toMatchObject({ code });
  });

  it.each([
    [-32602, "MEMPALACE_INVALID"],
    [-32001, "MEMPALACE_CONFLICT"],
    [-32002, "MEMPALACE_INTEGRITY"],
    [-32004, "MEMPALACE_INTEGRITY"],
  ])("maps JSON-RPC %i to typed %s", async (rpcCode, code) => {
    const client = new MemoryMcpClient(testConfig(), {
      fetch: ((_url: string | URL | Request, init?: RequestInit) => {
        const request = requestBody(init);
        return Promise.resolve(rpcErrorResponse(request.id, rpcCode));
      }) as typeof fetch,
    });
    await expect(client.call("search", { query: "x" })).rejects.toMatchObject({ code });
  });

  it("uses MemoryError instances for all transport failures", async () => {
    const client = new MemoryMcpClient(testConfig({ maxReadAttempts: 1 }), {
      fetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
    });
    await expect(client.call("search", { query: "x" })).rejects.toBeInstanceOf(MemoryError);
  });
});
