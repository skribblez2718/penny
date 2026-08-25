/**
 * `formatResult` builds the ONLY model-visible text the skill tool returns.
 * `details.output_artifact_ref` reaches renderers but never a provider, so the
 * terminal artifact id has to appear in this string or it cannot be read back.
 */

import { describe, expect, it } from "vitest";

import { formatResult, type SkillResult } from "../../skill-utils.js";

const plain = (_color: string, text: string) => text;
const ARTIFACT_ID = `art_${"c".repeat(64)}`;

function ref(id: string) {
  return {
    schema_version: 2,
    artifact_id: id,
    run_id: "run-1",
    phase: "complete",
    branch_id: null,
    kind: "agent-output",
    operation_id: "op-1",
    version: 1,
    producer: "agent:skribble",
    media_type: "text/markdown; charset=utf-8",
    byte_length: 42,
    content_digest: "d".repeat(64),
    store_ref: `artifact://sha256/${"d".repeat(64)}`,
  } as SkillResult["output_artifact_ref"];
}

function baseResult(overrides: Partial<SkillResult> = {}): SkillResult {
  return {
    success: true,
    session_id: "sess-1",
    skill_name: "research",
    state: "complete",
    requires_approval: false,
    steps_total: 3,
    agents_invoked: ["echo", "synthia", "skribble"],
    errors: [],
    ...overrides,
  } as SkillResult;
}

describe("formatResult exact-artifact visibility", () => {
  it("names the terminal artifact id on success", () => {
    const text = formatResult(baseResult({ output_artifact_ref: ref(ARTIFACT_ID) }), plain);
    expect(text).toContain(ARTIFACT_ID);
    expect(text).toContain(`artifact_read({"artifact":"${ARTIFACT_ID}"})`);
  });

  it("names the plan artifact id when approval is required", () => {
    const text = formatResult(
      baseResult({
        requires_approval: true,
        plan_steps: [{ step: 1, title: "Gather sources" }],
        output_artifact_ref: ref(ARTIFACT_ID),
      }),
      plain
    );
    // Approval guidance must include the exact plan ID; a name-only pointer is unactionable.
    expect(text).toContain("artifact_read");
    expect(text).toContain(ARTIFACT_ID);
  });

  it("prints every parallel and chain-step output ID", () => {
    const parallelId = `art_${"a".repeat(64)}`;
    const chainId = `art_${"b".repeat(64)}`;
    const text = formatResult(
      baseResult({
        parallel_results: [
          baseResult({ skill_name: "research-a", output_artifact_ref: ref(parallelId) }),
        ],
        chain_results: [
          baseResult({
            skill_name: "research-b",
            chain_step: 1,
            output_artifact_ref: ref(chainId),
          }),
        ],
      }),
      plain
    );
    expect(text).toContain(parallelId);
    expect(text).toContain(chainId);
    expect(text).toContain("parallel 1");
    expect(text).toContain("chain step 1");
  });

  it("adds nothing when the run produced no artifact", () => {
    const text = formatResult(baseResult(), plain);
    expect(text).not.toContain("Exact output artifact");
    expect(text).not.toContain("art_");
  });

  it("stays bounded: two short lines per result", () => {
    const withRef = formatResult(baseResult({ output_artifact_ref: ref(ARTIFACT_ID) }), plain);
    const without = formatResult(baseResult(), plain);
    expect(withRef.length - without.length).toBeLessThan(220);
  });
});
