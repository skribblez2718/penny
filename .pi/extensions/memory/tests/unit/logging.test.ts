import { beforeEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../../../lib/logger/test-logger.js";
import { requireDefined } from "../fixtures.js";

describe("memory metadata logging", () => {
  const state = createTestLogger("memory");

  beforeEach(() => {
    state.clear();
    state.setSessionId("test-session");
  });

  it("records typed result-budget metadata without payload content", () => {
    state.logger.warn("memory_tool_result", {
      tool: "memory_smart_search",
      requestId: "request-1",
      code: "OK",
      serializedBytes: 1024,
      estimatedTokens: 1024,
      releaseHeadroom: {
        releaseMinimumContextHeadroomTokens: 16384,
        requiredReservedAfterResultTokens: 8192,
        estimatedReservedAfterResultTokens: 15360,
        invariantPreserved: true,
      },
      truncated: false,
      page: 1,
      compactionCorrelation: {
        status: "not_evaluated",
        keys: ["session:test-session"],
      },
    });
    expect(state.buffer).toHaveLength(1);
    const record = requireDefined(state.buffer[0], "memory log record was not captured");
    expect(record.message).toBe("memory_tool_result");
    expect(record.context).toMatchObject({
      serializedBytes: 1024,
      page: 1,
      compactionCorrelation: { status: "not_evaluated" },
    });
    expect(JSON.stringify(record)).not.toContain("private memory content");
  });
});
