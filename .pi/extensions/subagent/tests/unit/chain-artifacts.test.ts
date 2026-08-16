import { describe, expect, it } from "vitest";

import { expectedArtifactRef } from "../../../artifacts/owner-client.js";
import { resolveToolResultBudget } from "../../../lib/tool-result-budget.js";
import {
  directChainEnvironment,
  directChainInput,
  directChainOutputMetadata,
  directChainTask,
} from "../../chain-artifacts.js";

const RUN_ID = "subagent-chain:00000000-0000-4000-8000-000000000001";

describe("direct chain exact-artifact handoff", () => {
  it("keeps large multibyte prior bytes out of the next task and grants only their exact ref", () => {
    const largePrevious = `PRIVATE-MULTIBYTE-${"🙂漢é".repeat(10_000)}`;
    const metadata = directChainOutputMetadata({
      runId: RUN_ID,
      stepIndex: 0,
      totalSteps: 2,
      agent: "echo",
    });
    const ref = expectedArtifactRef(metadata, largePrevious);
    const input = directChainInput({ runId: RUN_ID, stepIndex: 1, previousRef: ref });
    const task = directChainTask({
      task: "Review {previous} exactly.",
      input,
      budget: resolveToolResultBudget({
        PENNY_TOOL_RESULT_MAX_BYTES: "2048",
        PENNY_TOOL_RESULT_MAX_CHARACTERS: "2048",
        PENNY_TOOL_RESULT_MAX_TOKENS: "2048",
      }),
    });
    const environment = directChainEnvironment(input, "invocation-2");
    const invocation = JSON.parse(environment.PENNY_ARTIFACT_INVOCATION_JSON as string);

    expect(task).toContain("artifact_read");
    expect(task).toContain(ref.artifact_id);
    expect(task).not.toContain("{previous}");
    expect(task).not.toContain("PRIVATE-MULTIBYTE");
    expect(task).not.toContain("🙂漢é");
    expect(Buffer.byteLength(task, "utf8")).toBeLessThan(2048);
    expect(invocation.caller).toMatchObject({
      run_id: RUN_ID,
      consumer_ref: "subagent-chain:step:0002",
    });
    expect(
      invocation.grants.map(
        (grant: { artifact: { artifact_id: string } }) => grant.artifact.artifact_id
      )
    ).toEqual([ref.artifact_id]);
  });

  it("binds every step identity to one owner run and rejects a wrong-run predecessor", () => {
    const first = directChainOutputMetadata({
      runId: RUN_ID,
      stepIndex: 0,
      totalSteps: 2,
      agent: "echo",
    });
    const ref = expectedArtifactRef(first, "exact");
    const second = directChainOutputMetadata({
      runId: RUN_ID,
      stepIndex: 1,
      totalSteps: 2,
      agent: "synthia",
      previousRef: ref,
    });

    expect(second.upstream_refs).toEqual([ref]);
    expect(second.consumer_scope).toEqual(["subagent-chain:caller"]);
    expect(() =>
      directChainInput({
        runId: "subagent-chain:other",
        stepIndex: 1,
        previousRef: ref,
      })
    ).toThrow(/directive run/);
  });
});
