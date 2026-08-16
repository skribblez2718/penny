import { describe, expect, it } from "vitest";

import {
  HARD_MAX_ESTIMATED_TOKENS,
  HARD_MAX_RESULT_BYTES,
  RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS,
  assessReleaseHeadroom,
  createTextToolResult,
  enforceToolResultBudget,
  fitUtf8ToolResult,
  resolveToolResultBudget,
} from "../../tool-result-budget.js";

describe("shared result budget integration", () => {
  it("makes the hard estimated-token cap an 8192-byte serialized ceiling", () => {
    const source = Buffer.from('giant-🙂漢字-"-\\'.repeat(10_000), "utf8");
    const fitted = fitUtf8ToolResult({
      source,
      start: 0,
      end: source.length,
      budget: resolveToolResultBudget({}),
      build: (end, text, truncated) =>
        createTextToolResult({
          content: text,
          returned_range: { start: 0, end },
          truncated,
          continuation: truncated ? { next: end } : null,
        }),
    });
    const reserve = assessReleaseHeadroom(fitted.measurement.estimatedTokens);

    expect(fitted.measurement.bytes).toBeLessThanOrEqual(HARD_MAX_ESTIMATED_TOKENS);
    expect(fitted.measurement.bytes).toBeLessThan(HARD_MAX_RESULT_BYTES);
    expect(fitted.measurement.estimatedTokens).toBe(fitted.measurement.bytes);
    expect(fitted.measurement.estimatedTokens * 2).toBeLessThanOrEqual(
      RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS
    );
    expect(reserve.invariantPreserved).toBe(true);
  });

  it("enforces a lower cap on the complete text-tool result shape", () => {
    const budget = resolveToolResultBudget({
      PENNY_TOOL_RESULT_MAX_BYTES: "1024",
      PENNY_TOOL_RESULT_MAX_CHARACTERS: "1024",
      PENNY_TOOL_RESULT_MAX_TOKENS: "256",
    });
    const result = createTextToolResult(
      { ok: true, content: "small" },
      {
        details: { type: "integration" },
      }
    );

    expect(enforceToolResultBudget(result, budget).bytes).toBeLessThanOrEqual(1024);
  });
});
