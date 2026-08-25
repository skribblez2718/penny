import { describe, expect, it, vi } from "vitest";

import { PlatformMemoryClientV1, PlatformMemoryError } from "../../src/index.js";
import {
  ALPHA_TOKEN,
  isolatedConfig,
  mcpResponse,
  mcpToolErrorResponse,
  requestBody,
  requireDefined,
} from "../fixtures.js";

function hangingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      );
    })) as typeof fetch;
}

describe("HTTP-only client", () => {
  it("sends a bounded authenticated MCP call with contract and palace routing metadata", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      return Promise.resolve(mcpResponse(request.id, { results: [], count: 0 }));
    });
    const client = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
      fetch: fetchSpy as typeof fetch,
      credentialResolver: () => ALPHA_TOKEN,
      randomId: () => "request-1",
    });

    const result = await client.invoke("smart_search", { query: "fixture", limit: 3 });
    expect(result).toMatchObject({
      contractVersion: 1,
      operation: "smart_search",
      requestId: "platform-memory-request-1",
      palaceId: "palace-alpha",
      data: { results: [], count: 0 },
      attempts: 1,
    });
    const [url, init] = requireDefined(fetchSpy.mock.calls[0], "memory request was not sent");
    expect(url).toBe("https://memory-alpha.invalid/mcp");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${ALPHA_TOKEN}`);
    expect(headers.get("X-Platform-Memory-Contract")).toBe("1");
    expect(headers.get("X-Platform-Memory-Palace")).toBe("palace-alpha");
    expect(requestBody(init)).toEqual({
      jsonrpc: "2.0",
      id: "platform-memory-request-1",
      method: "tools/call",
      params: {
        name: "mempalace_search",
        arguments: { query: "fixture", limit: 3 },
      },
    });
  });

  it("binds diary identity from config and rejects caller diary impersonation", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      return Promise.resolve(mcpResponse(request.id, { entries: [] }));
    });
    const client = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
      fetch: fetchSpy as typeof fetch,
      credentialResolver: () => ALPHA_TOKEN,
    });
    await client.invoke("diary_read", { last_n: 2 });
    const firstCall = requireDefined(fetchSpy.mock.calls[0], "diary request was not sent");
    expect(requestBody(firstCall[1]).params.arguments).toEqual({
      last_n: 2,
      agent_name: "diary-alpha",
    });
    await expect(
      client.invoke("diary_read", { last_n: 2, agent_name: "diary-beta" })
    ).rejects.toMatchObject({ code: "MEMORY_INVALID_REQUEST" });
  });

  it("retries known-safe reads but never retries writes", async () => {
    const readFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (readFetch.mock.calls.length < 3) {
        return Promise.resolve(new Response("busy", { status: 503 }));
      }
      return Promise.resolve(mcpResponse(requestBody(init).id, { results: [] }));
    });
    const readClient = new PlatformMemoryClientV1(
      isolatedConfig("alpha", { transport: { maxReadAttempts: 3 } }),
      {
        fetch: readFetch as typeof fetch,
        credentialResolver: () => ALPHA_TOKEN,
        sleep: () => Promise.resolve(),
      }
    );
    expect((await readClient.invoke("search", { query: "x" })).attempts).toBe(3);

    const writeFetch = vi.fn(() => Promise.resolve(new Response("busy", { status: 503 })));
    const writeClient = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
      fetch: writeFetch as typeof fetch,
      credentialResolver: () => ALPHA_TOKEN,
      sleep: () => Promise.resolve(),
    });
    await expect(
      writeClient.invoke("add_drawer", { wing: "w", room: "r", content: "x" })
    ).rejects.toMatchObject({ code: "MEMORY_UNAVAILABLE" });
    expect(writeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "MEMORY_INVALID_REQUEST", false],
    [401, "MEMORY_UNAUTHORIZED", false],
    [403, "MEMORY_UNAUTHORIZED", false],
    [404, "MEMORY_INVALID_REQUEST", false],
    [409, "MEMORY_CONFLICT", false],
    [413, "MEMORY_INVALID_REQUEST", false],
    [422, "MEMORY_INVALID_REQUEST", false],
    [429, "MEMORY_UNAVAILABLE", true],
    [502, "MEMORY_UNAVAILABLE", true],
    [503, "MEMORY_UNAVAILABLE", true],
    [504, "MEMORY_UNAVAILABLE", true],
    [-32700, "MEMORY_INVALID_REQUEST", false],
    [-32600, "MEMORY_INVALID_REQUEST", false],
    [-32601, "MEMORY_INVALID_REQUEST", false],
    [-32602, "MEMORY_INVALID_REQUEST", false],
    [-32001, "MEMORY_CONFLICT", false],
    [-32002, "MEMORY_INTEGRITY", false],
    [-32003, "MEMORY_CONFLICT", false],
    [-32004, "MEMORY_INTEGRITY", false],
    [-32005, "MEMORY_CONFLICT", false],
  ] as const)(
    "maps the supported HTTP-200 MCP tool error code %i to typed %s",
    async (upstreamCode, code, retryable) => {
      const client = new PlatformMemoryClientV1(
        isolatedConfig("alpha", { transport: { maxReadAttempts: 1 } }),
        {
          fetch: ((_url: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(
              mcpToolErrorResponse(requestBody(init).id, {
                error: { code: upstreamCode, message: "synthetic upstream error" },
              })
            )) as typeof fetch,
          credentialResolver: () => ALPHA_TOKEN,
        }
      );

      await expect(client.invoke("search", { query: "x" })).rejects.toMatchObject({
        code,
        retryable,
      });
    }
  );

  it("rejects MCP isError before success normalization and retries only an explicit safe-read unavailable code", async () => {
    const unsupportedFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(mcpToolErrorResponse(requestBody(init).id, { results: [], count: 0 }))
    );
    const unsupported = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
      fetch: unsupportedFetch as typeof fetch,
      credentialResolver: () => ALPHA_TOKEN,
      sleep: () => Promise.resolve(),
    });

    await expect(unsupported.invoke("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMORY_UNAVAILABLE",
      retryable: false,
    });
    expect(unsupportedFetch).toHaveBeenCalledTimes(1);

    const retryableFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (retryableFetch.mock.calls.length < 3) {
        return Promise.resolve(
          mcpToolErrorResponse(request.id, {
            error: { code: 503, message: "synthetic upstream unavailable" },
          })
        );
      }
      return Promise.resolve(mcpResponse(request.id, { results: [], count: 0 }));
    });
    const retryable = new PlatformMemoryClientV1(
      isolatedConfig("alpha", { transport: { maxReadAttempts: 3 } }),
      {
        fetch: retryableFetch as typeof fetch,
        credentialResolver: () => ALPHA_TOKEN,
        sleep: () => Promise.resolve(),
      }
    );

    expect((await retryable.invoke("search", { query: "x" })).attempts).toBe(3);
    expect(retryableFetch).toHaveBeenCalledTimes(3);
  });

  it("never retries or advertises retryability for an ambiguous MCP write failure", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        mcpToolErrorResponse(requestBody(init).id, {
          error: { code: 503, message: "write outcome is unknown" },
        })
      )
    );
    const client = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
      fetch: fetchSpy as typeof fetch,
      credentialResolver: () => ALPHA_TOKEN,
      sleep: () => Promise.resolve(),
    });

    await expect(
      client.invoke("add_drawer", { wing: "w", room: "r", content: "x" })
    ).rejects.toMatchObject({ code: "MEMORY_UNAVAILABLE", retryable: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails closed for malformed and unknown MCP tool error payloads", async () => {
    for (const [payload, code] of [
      [{ error: { code: "503", message: "wrong code type" } }, "MEMORY_INTEGRITY"],
      [{ error: { code: 999, message: "unknown code" } }, "MEMORY_UNAVAILABLE"],
    ] as const) {
      const client = new PlatformMemoryClientV1(
        isolatedConfig("alpha", { transport: { maxReadAttempts: 1 } }),
        {
          fetch: ((_url: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(mcpToolErrorResponse(requestBody(init).id, payload))) as typeof fetch,
          credentialResolver: () => ALPHA_TOKEN,
        }
      );
      await expect(client.invoke("search", { query: "x" })).rejects.toMatchObject({
        code,
        retryable: false,
      });
    }

    const malformedJson = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
      fetch: ((_url: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: requestBody(init).id,
              result: {
                isError: true,
                content: [{ type: "text", text: "not-json" }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )) as typeof fetch,
      credentialResolver: () => ALPHA_TOKEN,
    });
    await expect(malformedJson.invoke("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMORY_INTEGRITY",
      retryable: false,
    });
  });

  it("supports bounded timeout and caller cancellation", async () => {
    const timeoutClient = new PlatformMemoryClientV1(
      isolatedConfig("alpha", {
        transport: { requestTimeoutMs: 100, maxReadAttempts: 1 },
      }),
      { fetch: hangingFetch(), credentialResolver: () => ALPHA_TOKEN }
    );
    await expect(timeoutClient.invoke("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMORY_TIMEOUT",
    });

    const cancelClient = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
      fetch: hangingFetch(),
      credentialResolver: () => ALPHA_TOKEN,
    });
    const controller = new AbortController();
    const pending = cancelClient.invoke("search", { query: "x" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "MEMORY_CANCELLED" });
  });

  it("maps auth, conflict, malformed, and oversized responses to typed errors", async () => {
    for (const [status, code] of [
      [401, "MEMORY_UNAUTHORIZED"],
      [403, "MEMORY_UNAUTHORIZED"],
      [409, "MEMORY_CONFLICT"],
    ] as const) {
      const client = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
        fetch: (() => Promise.resolve(new Response("", { status }))) as typeof fetch,
        credentialResolver: () => ALPHA_TOKEN,
      });
      await expect(client.invoke("search", { query: "x" })).rejects.toMatchObject({ code });
    }

    const malformed = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
      fetch: (() =>
        Promise.resolve(
          new Response("not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )) as typeof fetch,
      credentialResolver: () => ALPHA_TOKEN,
    });
    await expect(malformed.invoke("search", { query: "x" })).rejects.toBeInstanceOf(
      PlatformMemoryError
    );

    const oversized = new PlatformMemoryClientV1(
      isolatedConfig("alpha", { transport: { maxResponseBytes: 65_536 } }),
      {
        fetch: ((_url: string | URL | Request, init?: RequestInit) =>
          Promise.resolve(
            mcpResponse(requestBody(init).id, { content: "x".repeat(70_000) })
          )) as typeof fetch,
        credentialResolver: () => ALPHA_TOKEN,
      }
    );
    await expect(oversized.invoke("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMORY_INTEGRITY",
    });
  });
});
