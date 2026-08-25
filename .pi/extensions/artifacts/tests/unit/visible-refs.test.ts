import { describe, expect, it } from "vitest";

import {
  appendBlock,
  exactOutputBlock,
  exactOutputListBlock,
  inlineArtifactMarker,
} from "../../visible-refs.js";

const ID_A = `art_${"a".repeat(64)}`;
const ID_B = `art_${"b".repeat(64)}`;

describe("visible-refs", () => {
  it("names the exact artifact id in an inline marker", () => {
    const marker = inlineArtifactMarker({ artifact_id: ID_A });
    expect(marker).toContain(ID_A);
    // Leading space: the marker is appended to an existing preview line.
    expect(marker.startsWith(" [")).toBe(true);
  });

  it("emits both the id and a directly usable artifact_read call", () => {
    const block = exactOutputBlock({ artifact_id: ID_A });
    expect(block).toContain(ID_A);
    expect(block).toContain(`artifact_read({"artifact":"${ID_A}"})`);
  });

  it("lists several refs in the caller's order with their labels", () => {
    const block = exactOutputListBlock([
      { label: "step 1 (echo)", ref: { artifact_id: ID_A } },
      { label: "step 2 (piper)", ref: { artifact_id: ID_B } },
    ]);
    expect(block.indexOf(ID_A)).toBeLessThan(block.indexOf(ID_B));
    expect(block).toContain("step 1 (echo)");
    expect(block).toContain("step 2 (piper)");
    expect(block).toContain("artifact_read");
  });

  it("returns nothing for an empty ref list so callers add no empty block", () => {
    expect(exactOutputListBlock([])).toBe("");
    expect(appendBlock("output", "")).toBe("output");
  });

  it("separates an appended block from existing text by one blank line", () => {
    expect(appendBlock("output", "BLOCK")).toBe("output\n\nBLOCK");
    expect(appendBlock("", "BLOCK")).toBe("BLOCK");
  });

  it("stays within a bounded per-ref budget", () => {
    // ~80 bytes/ref keeps a 10-step chain far inside the 32 KiB result budget.
    const perRef = inlineArtifactMarker({ artifact_id: ID_A }).length;
    expect(perRef).toBeLessThan(120);
    const tenSteps = exactOutputListBlock(
      Array.from({ length: 10 }, (_, i) => ({
        label: `step ${i + 1} (agent)`,
        ref: { artifact_id: ID_A },
      }))
    );
    expect(tenSteps.length).toBeLessThan(1500);
  });
});
