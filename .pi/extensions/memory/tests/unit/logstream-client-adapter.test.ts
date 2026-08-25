import { describe, expect, it, vi } from "vitest";

import { isRecord } from "../../../../lib/tests/test-narrowers.js";

import { MemoryAdapter } from "../../adapter.js";
import { MemoryLogstreamAdapter } from "../../logstream-adapter.js";
import { MemoryLogstreamClient } from "../../logstream-client.js";
import type { LogstreamOperation } from "../../types.js";
import {
  mcpResponse,
  mcpToolErrorResponse,
  parseTextResult,
  requestBody,
  requireDefined,
  testConfig,
} from "../fixtures.js";

function advisoryConfig(options: { writeEnabled?: boolean; maxReadAttempts?: number } = {}) {
  return testConfig({
    writeEnabled: options.writeEnabled ?? true,
    maxReadAttempts: options.maxReadAttempts ?? 3,
    logstream: {
      mode: "primary-advisory",
      stream: "project/advisory",
      rooms: ["status", "questions"],
    },
  });
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const type = overrides.type ?? "advisory.note";
  return {
    id: "evt_20260816T120000_abcdef123456",
    seq: 1,
    origin_replica: "replica-test",
    origin_seq: 1,
    hlc: "0000000000001-000001-replica-test",
    type,
    stream: "project/advisory",
    room: "status",
    from_agent: "test-primary",
    to_agent: "test-primary",
    correlation_id: "corr-1",
    branch: null,
    base_commit: null,
    status: null,
    artifact_ids: [],
    body: "hello",
    created_at: "2026-08-16T12:00:00Z",
    metadata: type === "event.ack" ? { ack_of: "evt_20260816T115900_123456abcdef" } : {},
    ...overrides,
  };
}

interface ErrorPayload {
  type: string;
}

function payloadOf(result: { content: Array<{ type: "text"; text: string }> }): ErrorPayload {
  const value = parseTextResult(result);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("memory adapter returned an invalid error payload");
  }
  return { type: value.type };
}

function adapterWithFetch(fetchImpl: typeof fetch, writeEnabled = true) {
  const config = advisoryConfig({ writeEnabled });
  const pager = new MemoryAdapter(config, { fetch: fetchImpl, randomId: () => "ordinary" });
  const client = new MemoryLogstreamClient(config, {
    fetch: fetchImpl,
    randomId: () => "advisory",
    sleep: () => Promise.resolve(),
  });
  return new MemoryLogstreamAdapter(config, pager, client);
}

describe("primary advisory argument pinning and bounds", () => {
  it("pins append stream, sender, and recipient to trusted configuration", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      return Promise.resolve(
        mcpResponse(request.id, {
          success: true,
          event: event({
            type: "advisory.status",
            room: "questions",
            correlation_id: "corr-append",
            status: "ready",
            body: "bounded note",
          }),
        })
      );
    });
    const adapter = adapterWithFetch(fetchSpy as typeof fetch);
    const execution = await adapter.execute(
      "logstream_append",
      {
        type: "advisory.status",
        room: "questions",
        correlation_id: "corr-append",
        status: "ready",
        body: "bounded note",
      },
      { callerId: "primary:test" }
    );

    expect(execution.code).toBe("OK");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = requireDefined(fetchSpy.mock.calls[0], "append request was not sent");
    const [url, init] = firstCall;
    expect(url).toBe("http://127.0.0.1:8765/mcp");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${advisoryConfig().bearerToken}`
    );
    const request = requestBody(init);
    expect(request.params).toEqual({
      name: "mempalace_event_append",
      arguments: {
        type: "advisory.status",
        stream: "project/advisory",
        room: "questions",
        from_agent: "test-primary",
        to_agent: "test-primary",
        correlation_id: "corr-append",
        status: "ready",
        body: "bounded note",
      },
    });
    expect(request.params.arguments).not.toHaveProperty("metadata");
    expect(request.params.arguments).not.toHaveProperty("artifact_ids");
  });

  it("pins wait reads and preserves the five-second model timeout bound", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(mcpResponse(requestBody(init).id, { timed_out: true, events: [], count: 0 }))
    );
    const adapter = adapterWithFetch(fetchSpy as typeof fetch);
    const execution = await adapter.execute(
      "logstream_wait",
      {
        room: "status",
        type: "advisory.reply",
        correlation_id: "corr-wait",
        timeout_ms: 5_000,
        limit: 20,
      },
      { callerId: "primary:test" }
    );
    expect(execution.code).toBe("OK");
    const firstCall = requireDefined(fetchSpy.mock.calls[0], "wait request was not sent");
    const init = requireDefined(firstCall[1], "wait request init was absent");
    const request = requestBody(init);
    expect(request.params).toEqual({
      name: "mempalace_event_wait",
      arguments: {
        stream: "project/advisory",
        room: "status",
        from_agent: "test-primary",
        to_agent: "test-primary",
        type: "advisory.reply",
        correlation_id: "corr-wait",
        timeout_ms: 5_000,
        limit: 20,
      },
    });
  });

  it("rejects direct forbidden overrides before HTTP even outside schema validation", async () => {
    const fetchSpy = vi.fn();
    const adapter = adapterWithFetch(fetchSpy as typeof fetch);
    const execution = await adapter.execute(
      "logstream_append",
      {
        type: "advisory.note",
        room: "status",
        correlation_id: "corr-1",
        body: "hello",
        stream: "other",
        from_agent: "model-override",
      },
      { callerId: "primary:test" }
    );
    expect(execution.code).toBe("MEMPALACE_INVALID");
    expect(payloadOf(execution.result).type).toBe("memory_error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects overbound body, limit, timeout, room, type, and status before HTTP", async () => {
    const cases: Array<[LogstreamOperation, Record<string, unknown>]> = [
      [
        "logstream_append",
        {
          type: "advisory.note",
          room: "status",
          correlation_id: "corr-1",
          body: "🙂".repeat(2_049),
        },
      ],
      [
        "logstream_append",
        {
          type: "advisory.note",
          room: "status",
          correlation_id: "corr-1",
          body: "lone-surrogate-\ud800",
        },
      ],
      ["logstream_list", { room: "status", limit: 21 }],
      ["logstream_wait", { room: "status", timeout_ms: 5_001 }],
      ["logstream_list", { room: "not-allowed" }],
      ["logstream_list", { room: "status", type: "task.request" }],
      ["logstream_list", { room: "status", status: "done" }],
    ];
    for (const [operation, params] of cases) {
      const fetchSpy = vi.fn();
      const adapter = adapterWithFetch(fetchSpy as typeof fetch);
      const execution = await adapter.execute(operation, params, { callerId: "primary:test" });
      expect(execution.code).toBe("MEMPALACE_INVALID");
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("rejects direct append and ack while ordinary memory writes are disabled", async () => {
    const fetchSpy = vi.fn();
    const adapter = adapterWithFetch(fetchSpy as typeof fetch, false);
    for (const [operation, params] of [
      ["logstream_append", { type: "advisory.note", room: "status", correlation_id: "corr-1" }],
      ["logstream_ack", { event_id: "evt_1", correlation_id: "corr-1" }],
    ] as const) {
      const execution = await adapter.execute(operation, params, { callerId: "primary:test" });
      expect(execution.code).toBe("MEMPALACE_INVALID");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const adversarialReadCases = [
  {
    label: "an event with the wrong requested type",
    params: { type: "advisory.note" },
    events: [event({ type: "advisory.reply" })],
  },
  {
    label: "an event with the wrong requested status",
    params: { status: "ready" },
    events: [event({ status: "blocked" })],
  },
  {
    label: "the excluded anchor event itself",
    params: { since_event_id: "evt_anchor" },
    events: [event({ id: "evt_anchor" })],
  },
  {
    label: "duplicate event ids",
    params: {},
    events: [
      event({ id: "evt_duplicate", seq: 1 }),
      event({ id: "evt_duplicate", seq: 2, origin_seq: 2 }),
    ],
  },
  {
    label: "events reordered by sequence",
    params: {},
    events: [
      event({ id: "evt_order_2", seq: 2, origin_seq: 2 }),
      event({ id: "evt_order_1", seq: 1, origin_seq: 1 }),
    ],
  },
] as const;

for (const read of [
  {
    operation: "logstream_list",
    upstreamTool: "mempalace_event_list",
    wait: false,
  },
  {
    operation: "logstream_wait",
    upstreamTool: "mempalace_event_wait",
    wait: true,
  },
] as const) {
  describe(`${read.operation} adversarial response validation`, () => {
    it.each(adversarialReadCases)("rejects $label", async ({ params, events }) => {
      const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const request = requestBody(init);
        expect(request.params.name).toBe(read.upstreamTool);
        expect(request.params.arguments).toMatchObject({ room: "status", ...params });
        return Promise.resolve(
          mcpResponse(request.id, {
            ...(read.wait ? { timed_out: false } : {}),
            events,
            count: events.length,
          })
        );
      });
      const adapter = adapterWithFetch(fetchSpy as typeof fetch);
      const execution = await adapter.execute(
        read.operation,
        { room: "status", ...params },
        { callerId: "primary:test" }
      );

      expect(execution.code).toBe("MEMPALACE_INTEGRITY");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
}

describe("strict self-addressed response semantics", () => {
  it("rejects a raw upstream broadcast rather than widening a pinned list", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        mcpResponse(requestBody(init).id, {
          events: [event({ to_agent: null })],
          count: 1,
        })
      )
    );
    const adapter = adapterWithFetch(fetchSpy as typeof fetch);
    const execution = await adapter.execute(
      "logstream_list",
      { room: "status" },
      { callerId: "primary:test" }
    );

    expect(execution.code).toBe("MEMPALACE_INTEGRITY");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("strict MCP errors, retry policy, and response bounds", () => {
  it("accepts transport-envelope extras but rejects advisory-event extras", async () => {
    const envelopeExtraFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            transport_extra: { accepted: true },
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    event: event(),
                    tool_extra: "accepted",
                  }),
                  content_extra: true,
                },
              ],
              result_extra: true,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    });
    const client = new MemoryLogstreamClient(advisoryConfig(), {
      fetch: envelopeExtraFetch as typeof fetch,
    });
    await expect(client.call("append", {})).resolves.toMatchObject({
      payload: { success: true, tool_extra: "accepted" },
    });

    const eventExtraFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        mcpResponse(requestBody(init).id, {
          events: [event({ unexpected_event_field: true })],
          count: 1,
        })
      )
    );
    const adapter = adapterWithFetch(eventExtraFetch as typeof fetch);
    const execution = await adapter.execute(
      "logstream_list",
      { room: "status" },
      { callerId: "primary:test" }
    );
    expect(execution.code).toBe("MEMPALACE_INTEGRITY");
  });

  it("rejects HTTP-200 MCP isError and payload success:false", async () => {
    const isErrorFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        mcpToolErrorResponse(requestBody(init).id, {
          error: { code: 503, message: "unknown write outcome" },
        })
      )
    );
    const isErrorClient = new MemoryLogstreamClient(advisoryConfig(), {
      fetch: isErrorFetch as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    await expect(
      isErrorClient.call("append", {
        type: "advisory.note",
        stream: "project/advisory",
        room: "status",
        from_agent: "test-primary",
        to_agent: "test-primary",
      })
    ).rejects.toMatchObject({ code: "MEMPALACE_UNAVAILABLE", retryable: false });
    expect(isErrorFetch).toHaveBeenCalledTimes(1);

    const refusedFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(mcpResponse(requestBody(init).id, { success: false, error: "invalid event" }))
    );
    const refusedClient = new MemoryLogstreamClient(advisoryConfig(), {
      fetch: refusedFetch as typeof fetch,
    });
    await expect(
      refusedClient.call("ack", { event_id: "evt_1", from_agent: "test-primary" })
    ).rejects.toMatchObject({ code: "MEMPALACE_INVALID", retryable: false });
    expect(refusedFetch).toHaveBeenCalledTimes(1);
  });

  it("never retries append/ack or wait, but retries a bounded idempotent list", async () => {
    for (const operation of ["append", "ack", "wait"] as const) {
      const fetchSpy = vi.fn(() => Promise.resolve(new Response("busy", { status: 503 })));
      const client = new MemoryLogstreamClient(advisoryConfig(), {
        fetch: fetchSpy as typeof fetch,
        sleep: () => Promise.resolve(),
      });
      await expect(
        client.call(operation, {}, undefined, { allowReadRetry: true })
      ).rejects.toBeDefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }

    const listFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (listFetch.mock.calls.length === 1) {
        return Promise.resolve(new Response("busy", { status: 503 }));
      }
      return Promise.resolve(mcpResponse(requestBody(init).id, { events: [], count: 0 }));
    });
    const listClient = new MemoryLogstreamClient(advisoryConfig(), {
      fetch: listFetch as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    expect((await listClient.call("list", {}, undefined, { allowReadRetry: true })).attempts).toBe(
      2
    );
    expect(listFetch).toHaveBeenCalledTimes(2);
  });

  it("propagates caller cancellation without retrying a bounded wait", async () => {
    const fetchSpy = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const client = new MemoryLogstreamClient(advisoryConfig(), {
      fetch: fetchSpy as typeof fetch,
    });
    const controller = new AbortController();
    const pending = client.call("wait", { timeout_ms: 5_000 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "MEMPALACE_CANCELLED" });
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("rejects malformed, mismatched, missing-success, and oversized responses", async () => {
    const responses = [
      () =>
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      () => mcpResponse("wrong-id", { success: true, event: event() }),
      (_url: unknown, init?: RequestInit) => mcpResponse(requestBody(init).id, { event: event() }),
      (_url: unknown, init?: RequestInit) =>
        mcpResponse(requestBody(init).id, { success: true, padding: "x".repeat(530_000) }),
    ];
    for (const response of responses) {
      const client = new MemoryLogstreamClient(advisoryConfig(), {
        fetch: ((_url: string | URL | Request, init?: RequestInit) =>
          Promise.resolve(response(_url, init))) as typeof fetch,
      });
      await expect(client.call("append", {})).rejects.toMatchObject({
        code: "MEMPALACE_INTEGRITY",
      });
    }
  });
});

describe("acknowledgement scope proof", () => {
  it("proves the target under a bounded pinned read before one upstream ack", async () => {
    const targetId = "evt_20260816T115900_123456abcdef";
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.params.name === "mempalace_event_list") {
        return Promise.resolve(
          mcpResponse(request.id, {
            events: [event({ id: targetId, correlation_id: "corr-ack" })],
            count: 1,
          })
        );
      }
      return Promise.resolve(
        mcpResponse(request.id, {
          success: true,
          event: event({
            id: "evt_20260816T120001_abcdef654321",
            type: "event.ack",
            correlation_id: "corr-ack",
            status: "applied",
            body: "seen",
            metadata: { ack_of: targetId },
          }),
        })
      );
    });
    const adapter = adapterWithFetch(fetchSpy as typeof fetch);
    const execution = await adapter.execute(
      "logstream_ack",
      {
        event_id: targetId,
        correlation_id: "corr-ack",
        status: "applied",
        body: "seen",
      },
      { callerId: "primary:test" }
    );

    expect(execution.code).toBe("OK");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const proofCall = requireDefined(fetchSpy.mock.calls[0], "proof request was not sent");
    const proofInit = requireDefined(proofCall[1], "proof request init was absent");
    const proof = requestBody(proofInit);
    expect(proof.params).toEqual({
      name: "mempalace_event_list",
      arguments: {
        stream: "project/advisory",
        from_agent: "test-primary",
        to_agent: "test-primary",
        correlation_id: "corr-ack",
        limit: 20,
        preview: false,
      },
    });
    const ackCall = requireDefined(fetchSpy.mock.calls[1], "ack request was not sent");
    const ackInit = requireDefined(ackCall[1], "ack request init was absent");
    const ack = requestBody(ackInit);
    expect(ack.params).toEqual({
      name: "mempalace_event_ack",
      arguments: {
        event_id: targetId,
        from_agent: "test-primary",
        status: "applied",
        body: "seen",
      },
    });
  });

  it.each([
    ["wrong stream", { stream: "other/advisory" }],
    ["wrong principal", { to_agent: "other-primary" }],
    ["wrong correlation", { correlation_id: "corr-other" }],
    ["artifact-bearing", { artifact_ids: ["art_forbidden"] }],
  ])("fails closed without ack for %s proof", async (_case, override) => {
    const targetId = "evt_20260816T115900_123456abcdef";
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        mcpResponse(requestBody(init).id, {
          events: [event({ id: targetId, correlation_id: "corr-ack", ...override })],
          count: 1,
        })
      )
    );
    const adapter = adapterWithFetch(fetchSpy as typeof fetch);
    const execution = await adapter.execute(
      "logstream_ack",
      { event_id: targetId, correlation_id: "corr-ack" },
      { callerId: "primary:test" }
    );
    expect(execution.code).not.toBe("OK");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects when the exact target is not established within the twenty-event proof read", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        mcpResponse(requestBody(init).id, {
          events: Array.from({ length: 20 }, (_, index) =>
            event({
              id: `evt_20260816T1200${String(index).padStart(2, "0")}_${String(index).padStart(12, "a")}`,
              seq: index + 1,
              origin_seq: index + 1,
              correlation_id: "corr-ack",
            })
          ),
          count: 20,
        })
      )
    );
    const adapter = adapterWithFetch(fetchSpy as typeof fetch);
    const execution = await adapter.execute(
      "logstream_ack",
      { event_id: "evt_20260816T130000_target000001", correlation_id: "corr-ack" },
      { callerId: "primary:test" }
    );
    expect(execution.code).toBe("MEMPALACE_INVALID");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
