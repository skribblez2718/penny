import { afterEach, describe, expect, it } from "vitest";

import { compactionResultBudget, fitCompactionSummary, parseResumeRefs } from "../../index.js";
import {
  HARD_MAX_ESTIMATED_TOKENS,
  RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS,
  createTextToolResult,
  enforceToolResultBudget,
  measureToolResult,
  type ToolResultBudget,
} from "../../../lib/tool-result-budget.js";

const saved = {
  bytes: process.env.PENNY_TOOL_RESULT_MAX_BYTES,
  characters: process.env.PENNY_TOOL_RESULT_MAX_CHARACTERS,
  tokens: process.env.PENNY_TOOL_RESULT_MAX_TOKENS,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    PENNY_TOOL_RESULT_MAX_BYTES: saved.bytes,
    PENNY_TOOL_RESULT_MAX_CHARACTERS: saved.characters,
    PENNY_TOOL_RESULT_MAX_TOKENS: saved.tokens,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("compaction shared final result budget", () => {
  it("cannot be enlarged by giant owner values and fits giant prose", () => {
    process.env.PENNY_TOOL_RESULT_MAX_BYTES = "999999999";
    process.env.PENNY_TOOL_RESULT_MAX_CHARACTERS = "999999999";
    process.env.PENNY_TOOL_RESULT_MAX_TOKENS = "999999999";
    const budget = compactionResultBudget();
    const resumeRefs = {
      version: 2 as const,
      refs: [{ type: "run" as const, run_id: "run-exact" }],
    };
    const fitted = fitCompactionSummary("界".repeat(1_000_000), resumeRefs, budget);

    const measurement = measureToolResult(createTextToolResult({ summary: fitted.summary }));
    expect(() =>
      enforceToolResultBudget(createTextToolResult({ summary: fitted.summary }), budget)
    ).not.toThrow();
    expect(measurement.bytes).toBeLessThanOrEqual(HARD_MAX_ESTIMATED_TOKENS);
    expect(measurement.estimatedTokens * 2).toBeLessThanOrEqual(
      RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS
    );
    expect(fitted.summary).toContain("[prose truncated to fit the shared result budget]");
    expect(parseResumeRefs(fitted.summary).refs).toEqual(resumeRefs.refs);
  });

  it("keeps the versioned refs block structurally valid under a tiny lower cap", () => {
    const budget: ToolResultBudget = {
      maxBytes: 512,
      maxCharacters: 512,
      maxEstimatedTokens: 256,
    };
    const fitted = fitCompactionSummary(
      "## Goal\n" + "x".repeat(10_000),
      {
        version: 2,
        refs: [
          { type: "run", run_id: "run-exact" },
          {
            type: "artifact",
            artifact_id: `art_${"a".repeat(64)}`,
            digest: "b".repeat(64),
          },
        ],
      },
      budget
    );
    expect(() => parseResumeRefs(fitted.summary)).not.toThrow();
    expect(fitted.summary).toContain("run:run-exact");
    expect(fitted.summary).toContain("[/RESUME-REFS]");
  });
});
