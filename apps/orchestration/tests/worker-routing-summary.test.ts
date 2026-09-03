import { describe, expect, it } from "vitest";

import { researchSummarySchema } from "../src/playbooks/research.js";
import { validateContract } from "../src/contracts.js";
import { normalizeTrustedRoutingCompletion, parsePersistedRoutingSummary } from "../src/worker.js";

describe("persisted assistant SUMMARY routing", () => {
  it("separates transport confidence before exact phase validation", () => {
    const routing = parsePersistedRoutingSummary(
      'complete stage bytes\nSUMMARY:{"explore_complete":true,"confidence":"PROBABLE"}'
    );
    expect(routing).toEqual({
      confidence: "PROBABLE",
      details: { explore_complete: true },
    });
    expect(() =>
      validateContract(researchSummarySchema("researching"), routing?.details, "Echo summary")
    ).not.toThrow();
  });

  it("preserves unknown semantic fields for the closed state schema to reject", () => {
    const routing = parsePersistedRoutingSummary(
      'complete stage bytes\nSUMMARY:{"explore_complete":true,"confidence":"PROBABLE","future_metadata":{"retained":true}}'
    );
    expect(routing).toEqual({
      confidence: "PROBABLE",
      details: {
        explore_complete: true,
        future_metadata: { retained: true },
      },
    });
    expect(() =>
      validateContract(researchSummarySchema("researching"), routing?.details, "Echo summary")
    ).toThrow(/additional properties/u);
  });

  it("ignores prose backticks while requiring one exact unique final SUMMARY line", () => {
    expect(
      parsePersistedRoutingSummary(
        'complete stage bytes\nSUMMARY:{"explore_complete":true,"confidence":"CERTAIN"}\n'
      )
    ).toEqual({ confidence: "CERTAIN", details: { explore_complete: true } });
    expect(
      parsePersistedRoutingSummary(
        'Inline `code` stays prose.\n```json\n{"stage":"complete"}\n```\nSUMMARY:{"explore_complete":true,"confidence":"CERTAIN"}'
      )
    ).toEqual({ confidence: "CERTAIN", details: { explore_complete: true } });
    expect(
      parsePersistedRoutingSummary(
        '```json\n{"stage":"complete"}\nSUMMARY:{"explore_complete":true,"confidence":"CERTAIN"}\n```'
      )
    ).toBeUndefined();
    expect(
      parsePersistedRoutingSummary(
        'prose\n`SUMMARY:{"explore_complete":true,"confidence":"CERTAIN"}`'
      )
    ).toBeUndefined();
    expect(
      parsePersistedRoutingSummary(
        'SUMMARY:{"explore_complete":true,"confidence":"PROBABLE"}\ntrailing prose'
      )
    ).toBeUndefined();
    expect(
      parsePersistedRoutingSummary(
        'SUMMARY:{"explore_complete":true}\nSUMMARY:{"explore_complete":true}'
      )
    ).toBeUndefined();
    expect(parsePersistedRoutingSummary('SUMMARY:{"explore_complete":true}\n\n')).toBeUndefined();
  });

  it("keeps missing-confidence compatibility but rejects invalid confidence", () => {
    expect(parsePersistedRoutingSummary('SUMMARY:{"explore_complete":true}')).toEqual({
      confidence: "UNCERTAIN",
      details: { explore_complete: true },
    });
    expect(parsePersistedRoutingSummary("complete bytes")).toBeUndefined();
    expect(parsePersistedRoutingSummary("SUMMARY:not-json")).toBeUndefined();
    expect(parsePersistedRoutingSummary('SUMMARY:{"confidence":"INVALID"}')).toBeUndefined();
  });

  it("normalizes trusted completions and rejects conflicting confidence", () => {
    expect(
      normalizeTrustedRoutingCompletion({
        confidence: "CERTAIN",
        details: { explore_complete: true, confidence: "CERTAIN" },
      })
    ).toEqual({ confidence: "CERTAIN", details: { explore_complete: true } });
    expect(
      normalizeTrustedRoutingCompletion({
        confidence: "CERTAIN",
        details: { explore_complete: true, confidence: "PROBABLE" },
      })
    ).toBeUndefined();
  });
});
