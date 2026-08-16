import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDiaryFromObservability, observabilityRestFetch } from "../../index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("observability metadata reads", () => {
  it("uses bearer auth and returns JSON without throwing", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const result = await observabilityRestFetch(
      "http://observability.invalid/sessions/s/entries",
      "key",
      fetchSpy as typeof fetch
    );
    expect(result).toEqual({ items: [], total: 0 });
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer key",
    });
  });

  it("returns null on fetch failure", async () => {
    const result = await observabilityRestFetch(
      "http://observability.invalid/sessions/s/entries",
      "",
      (() => Promise.reject(new Error("offline"))) as typeof fetch
    );
    expect(result).toBeNull();
  });

  it("returns null unless both bounded metadata responses are valid", async () => {
    const fetchImpl = ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).includes("agent_start")
          ? new Response("{}", {
              status: 503,
              headers: { "Content-Type": "application/json" },
            })
          : new Response(JSON.stringify({ items: [], total: 0 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
      )) as typeof fetch;
    expect(
      await buildDiaryFromObservability(
        "session",
        "quit",
        "ws://observability.invalid/ws",
        "",
        fetchImpl
      )
    ).toBeNull();
  });
});
