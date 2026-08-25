/**
 * Guards the invariant that makes the artifact plane readable at all.
 *
 * Pi transmits only a tool result's `content` to the provider; no pi-ai
 * provider conversion serializes `details`. An artifact ref surfaced solely in
 * `details` is invisible to the model, and `artifact_read` exposes no
 * list/search/discovery surface — so an unseen ref is an unreadable artifact.
 *
 * These are source-level assertions (same approach as the compaction
 * source guard) because the three mode returns are inside one large
 * `execute` closure that cannot be invoked without a full Pi tool harness.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const indexSource = readFileSync(join(extensionRoot, "index.ts"), "utf8");

/** Isolate one mode's return block so an assertion cannot pass on another mode's text. */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing anchor: ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `missing anchor: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("subagent model-visible artifact refs", () => {
  it("renders refs through the single shared formatter", () => {
    expect(indexSource).toContain('from "../artifacts/visible-refs.js"');
  });

  it("no longer emits the ref-less artifact_read hint that started this", () => {
    // The old parallel suffix told the model to call artifact_read but named no
    // ID, which is unactionable because discovery is deliberately unavailable.
    expect(indexSource).not.toContain("[exact output: artifact_read]");
  });

  it("single mode appends the exact output ref to model-visible content", () => {
    const block = sliceBetween(
      indexSource,
      "artifactRunId = `subagent-single:",
      "const available = agents.map"
    );
    expect(block).toContain("exactOutputBlock(result.outputArtifactRef)");
    // The ref must be inside the `content` array, not only `details`.
    expect(block).toMatch(/content:\s*\[[\s\S]*exactOutputBlock/);
  });

  it("parallel mode names each agent's exact ref inline with its preview", () => {
    const block = sliceBetween(
      indexSource,
      "artifactRunId = `subagent-parallel:",
      "if (params.agent && params.task)"
    );
    expect(block).toContain("inlineArtifactMarker(r.outputArtifactRef)");
    expect(block).toMatch(/content:\s*\[[\s\S]*anyParallelRef/);
  });

  it("chain mode lists every step's exact ref, not just the final step", () => {
    const block = sliceBetween(
      indexSource,
      "const chainRefs = results.flatMap",
      'details: makeDetails("chain")(results)'
    );
    expect(block).toContain("exactOutputListBlock(chainRefs)");
    expect(block).toMatch(/content:\s*\[[\s\S]*exactOutputListBlock/);
  });

  it("keeps the full envelope in details for renderers", () => {
    // Only the opaque id goes to the model; the envelope still reaches the TUI.
    expect(indexSource).toContain("outputArtifactRefs");
    expect(indexSource).toContain("finalOutputArtifactRef");
  });
});
