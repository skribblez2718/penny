import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  directAgentOutputMetadata,
  directChainInput,
  directChainOutputMetadata,
  directChainTask,
} from "../../chain-artifacts.js";
import { artifactIdFor, type ArtifactRef } from "../../../artifacts/owner-client.js";
import { DEFAULT_TOOL_RESULT_BUDGET } from "../../../lib/tool-result-budget.js";

function ref(runId: string, operationId: string): ArtifactRef {
  const identity = {
    run_id: runId,
    phase: "phase",
    branch_id: null,
    kind: "agent-output",
    operation_id: operationId,
    version: 1,
  };
  const digest = createHash("sha256").update(operationId).digest("hex");
  return {
    schema_version: 2,
    artifact_id: artifactIdFor(identity),
    ...identity,
    producer: "agent:fixture",
    media_type: "text/plain",
    byte_length: 1,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

describe("direct chain artifacts", () => {
  it("combines automatic previous output with arbitrary cross-run explicit inputs", () => {
    const previous = ref("run-a", "operation-a");
    const extra = ref("run-b", "operation-b");
    const input = directChainInput({ previousRef: previous, additionalRefs: [extra] });
    expect(input.schema_version).toBe(2);
    expect(input.artifacts.map((binding) => binding.ref.artifact_id)).toEqual([
      previous.artifact_id,
      extra.artifact_id,
    ]);
    expect(input).not.toHaveProperty("consumer");
    expect(input).not.toHaveProperty("run_id");
  });

  it("uses all exact inputs as lineage with schema-v2 metadata", () => {
    const upstream = [ref("run-a", "operation-a"), ref("run-b", "operation-b")];
    const metadata = directChainOutputMetadata({
      runId: "chain-run",
      stepIndex: 1,
      agent: "synthia",
      upstreamRefs: upstream,
    });
    expect(metadata.schema_version).toBe(2);
    expect(metadata.upstream_refs).toEqual(upstream);
    expect(metadata).not.toHaveProperty("consumer_scope");
  });

  it("replaces {previous} with an ID-based instruction, never payload bytes", () => {
    const previous = ref("run-a", "operation-a");
    const task = directChainTask({
      task: "Review {previous}",
      input: directChainInput({ previousRef: previous }),
      budget: DEFAULT_TOOL_RESULT_BUDGET,
    });
    expect(task).toContain(previous.artifact_id);
    expect(task).toContain("artifact_read");
    expect(task).not.toContain("{previous}");
  });

  it("builds single/parallel output metadata on schema v2", () => {
    const metadata = directAgentOutputMetadata({ runId: "run", index: 0, agent: "annie" });
    expect(metadata.schema_version).toBe(2);
    expect(metadata).not.toHaveProperty("consumer_scope");
  });
});
