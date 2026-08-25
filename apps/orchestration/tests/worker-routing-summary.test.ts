import { describe, expect, it } from "vitest";

import { parsePersistedRoutingSummary } from "../src/worker.js";

describe("persisted assistant SUMMARY routing", () => {
  it("parses only one final closed SUMMARY line", () => {
    expect(
      parsePersistedRoutingSummary(
        'complete stage bytes\nSUMMARY:{"explore_complete":true,"confidence":"PROBABLE"}'
      )
    ).toEqual({
      confidence: "PROBABLE",
      details: { explore_complete: true, confidence: "PROBABLE" },
    });
    expect(
      parsePersistedRoutingSummary(
        'complete stage bytes\nSUMMARY:{"explore_complete":true,"confidence":"PROBABLE","future_metadata":{"retained":true}}'
      )
    ).toEqual({
      confidence: "PROBABLE",
      details: {
        explore_complete: true,
        confidence: "PROBABLE",
        future_metadata: { retained: true },
      },
    });
    expect(
      parsePersistedRoutingSummary(
        'SUMMARY:{"explore_complete":true,"confidence":"PROBABLE"}\ntrailing prose'
      )
    ).toBeUndefined();
  });

  it("treats malformed or missing routing as an explicit malformed result", () => {
    expect(parsePersistedRoutingSummary("complete bytes")).toBeUndefined();
    expect(parsePersistedRoutingSummary("SUMMARY:not-json")).toBeUndefined();
    expect(parsePersistedRoutingSummary('SUMMARY:{"confidence":"INVALID"}')).toBeUndefined();
  });
});
