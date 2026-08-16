import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, setSessionId } from "../../../../lib/logger/logger.js";

describe("memory integration content-free logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("emits result-budget metadata without result content", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve({ ok: true } as Response)
    );
    vi.stubGlobal("fetch", fetchSpy);
    const logger = createLogger("memory");
    setSessionId("memory-session");
    logger.warn("memory_tool_result", {
      tool: "memory_get_drawer",
      requestId: "request-id",
      serializedBytes: 2048,
      estimatedTokens: 2048,
      releaseHeadroom: {
        releaseMinimumContextHeadroomTokens: 16384,
        requiredReservedAfterResultTokens: 8192,
        estimatedReservedAfterResultTokens: 14336,
        invariantPreserved: true,
      },
      truncated: true,
      page: 1,
      compactionCorrelation: {
        status: "not_evaluated",
        keys: ["session:memory-session"],
      },
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.event).toBe("memory_tool_result");
    expect(body.data.serializedBytes).toBe(2048);
    expect(body.data.truncated).toBe(true);
    expect(body.data.compactionCorrelation.status).toBe("not_evaluated");
    expect(JSON.stringify(body)).not.toContain("drawer content");
  });
});
