import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOOL_RESULT_BUDGET,
  HARD_MAX_ESTIMATED_TOKENS,
  HARD_MAX_RESULT_BYTES,
  HARD_MAX_RESULT_CHARACTERS,
  RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS,
  RELEASE_RESERVED_AFTER_RESULT_TOKENS,
  ToolResultBudgetConfigError,
  assessReleaseHeadroom,
  createTextToolResult,
  enforceToolResultBudget,
  estimateSerializedTokens,
  fitUtf8ToolResult,
  fitsToolResultBudget,
  measureToolResult,
  resolveToolResultBudget,
} from "../../tool-result-budget.js";

describe("tool-result budget", () => {
  it("measures and enforces the final serialized Pi result envelope", () => {
    const payload = { text: 'quoted "payload"'.repeat(2_000) };
    const result = createTextToolResult(payload, {
      details: { continuation: true },
    });
    const measurement = measureToolResult(result);

    expect(measurement.bytes).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
    expect(measurement.bytes).toBeGreaterThan(Buffer.byteLength(result.content[0]!.text, "utf8"));
    expect(() => enforceToolResultBudget(result, DEFAULT_TOOL_RESULT_BUDGET)).toThrow();
  });

  it("charges one estimated token per serialized UTF-8 byte without tokenizer assumptions", () => {
    for (const result of [
      createTextToolResult({ text: 'token-dense ASCII and escapes \\"'.repeat(200) }),
      createTextToolResult({ text: "🙂漢字é/".repeat(200) }),
      createTextToolResult({ nested: { envelope: [true, false, null, 123] } }),
    ]) {
      const measurement = measureToolResult(result);
      expect(estimateSerializedTokens(measurement.bytes)).toBe(measurement.bytes);
      expect(measurement.estimatedTokens).toBe(measurement.bytes);
    }
  });

  it("keeps byte, character, and estimated-token caps independent", () => {
    const base = {
      serialized: "fixture",
      bytes: 100,
      characters: 100,
      estimatedTokens: 100,
    };
    const budget = {
      maxBytes: 512,
      maxCharacters: 512,
      maxEstimatedTokens: 256,
    };

    expect(fitsToolResultBudget({ ...base, bytes: 513 }, budget)).toBe(false);
    expect(fitsToolResultBudget({ ...base, characters: 513 }, budget)).toBe(false);
    expect(fitsToolResultBudget({ ...base, estimatedTokens: 257 }, budget)).toBe(false);
    expect(fitsToolResultBudget(base, budget)).toBe(true);
  });

  it("reserves one hard result cap after a maximum result at release minimum headroom", () => {
    const assessment = assessReleaseHeadroom(HARD_MAX_ESTIMATED_TOKENS);

    expect(RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS).toBeGreaterThanOrEqual(
      HARD_MAX_ESTIMATED_TOKENS * 2
    );
    expect(assessment.estimatedReservedAfterResultTokens).toBeGreaterThanOrEqual(
      RELEASE_RESERVED_AFTER_RESULT_TOKENS
    );
    expect(assessment.invariantPreserved).toBe(true);
    expect(assessReleaseHeadroom(HARD_MAX_ESTIMATED_TOKENS + 1).invariantPreserved).toBe(false);
  });

  it("uses the tighter of byte, character, and estimated-token caps", () => {
    const budget = resolveToolResultBudget({
      PENNY_TOOL_RESULT_MAX_BYTES: "32768",
      PENNY_TOOL_RESULT_MAX_CHARACTERS: "32768",
      PENNY_TOOL_RESULT_MAX_TOKENS: "256",
    });
    const result = createTextToolResult({ text: "a".repeat(900) });
    const measurement = measureToolResult(result);

    expect(measurement.bytes).toBeLessThan(HARD_MAX_RESULT_BYTES);
    expect(measurement.estimatedTokens).toBeGreaterThan(256);
    expect(fitsToolResultBudget(measurement, budget)).toBe(false);
  });

  it("accepts lower owner caps and rejects attempts to raise hard caps", () => {
    expect(
      resolveToolResultBudget({
        PENNY_TOOL_RESULT_MAX_BYTES: "4096",
        PENNY_TOOL_RESULT_MAX_CHARACTERS: "4096",
        PENNY_TOOL_RESULT_MAX_TOKENS: "1024",
      })
    ).toEqual({ maxBytes: 4096, maxCharacters: 4096, maxEstimatedTokens: 1024 });

    expect(() =>
      resolveToolResultBudget({
        PENNY_TOOL_RESULT_MAX_BYTES: String(HARD_MAX_RESULT_BYTES + 1),
      })
    ).toThrow(ToolResultBudgetConfigError);
    expect(() =>
      resolveToolResultBudget({
        PENNY_TOOL_RESULT_MAX_CHARACTERS: String(HARD_MAX_RESULT_CHARACTERS + 1),
      })
    ).toThrow(ToolResultBudgetConfigError);
    expect(() =>
      resolveToolResultBudget({
        PENNY_TOOL_RESULT_MAX_TOKENS: String(HARD_MAX_ESTIMATED_TOKENS + 1),
      })
    ).toThrow(ToolResultBudgetConfigError);
  });

  it("fits multibyte text on code-point boundaries for exact reassembly", () => {
    const source = Buffer.from("🙂漢字é/".repeat(3_000), "utf8");
    const budget = resolveToolResultBudget({
      PENNY_TOOL_RESULT_MAX_BYTES: "2048",
      PENNY_TOOL_RESULT_MAX_CHARACTERS: "2048",
      PENNY_TOOL_RESULT_MAX_TOKENS: "512",
    });
    const pages: Buffer[] = [];
    let start = 0;

    while (start < source.length) {
      const fitted = fitUtf8ToolResult({
        source,
        start,
        end: source.length,
        budget,
        build: (candidateEnd, text, truncated) =>
          createTextToolResult({
            text,
            returned_range: { start, end: candidateEnd },
            truncated,
            continuation: truncated ? { next: candidateEnd } : null,
          }),
      });
      expect(fitsToolResultBudget(fitted.measurement, budget)).toBe(true);
      expect(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(fitted.text))
      ).not.toThrow();
      pages.push(source.subarray(start, fitted.end));
      start = fitted.end;
    }

    expect(Buffer.concat(pages).equals(source)).toBe(true);
  });
});
