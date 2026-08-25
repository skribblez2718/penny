import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, setSessionId } from "../../../../lib/logger/logger.js";
import { parseJson, requireDefined, requireRecord } from "../../../../lib/tests/test-narrowers.js";

describe("memory integration content-free logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("emits result-budget metadata without result content", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 }))
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
    const firstCall = requireDefined(fetchSpy.mock.calls[0], "logger request was not sent");
    const init = requireDefined(firstCall[1], "logger request init was absent");
    if (typeof init.body !== "string") throw new Error("logger request body was not text");
    const body = requireRecord(parseJson(init.body), "logger request body was not an object");
    const data = requireRecord(body.data, "logger request body omitted data");
    const compactionCorrelation = requireRecord(
      data.compactionCorrelation,
      "logger request body omitted compaction correlation"
    );
    expect(body.event).toBe("memory_tool_result");
    expect(data.serializedBytes).toBe(2048);
    expect(data.truncated).toBe(true);
    expect(compactionCorrelation.status).toBe("not_evaluated");
    expect(JSON.stringify(body)).not.toContain("drawer content");
  });
});
