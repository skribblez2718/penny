import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  appendInputArtifactInstruction,
  parseInputArtifacts,
  replacePreviousWithArtifact,
  singleArtifactInput,
} from "../../input-artifacts.js";
import { artifactIdFor, type ArtifactRef } from "../../artifact-client.js";

function ref(runId: string, operationId: string): ArtifactRef {
  const identity = {
    run_id: runId,
    phase: "observing",
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
    producer: "agent:echo",
    media_type: "text/plain",
    byte_length: 1,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

describe("input artifact communication", () => {
  it("accepts unique exact refs from different runs", () => {
    const parsed = parseInputArtifacts({
      schema_version: 2,
      artifacts: [
        { slot: "a", ref: ref("run-a", "operation-a") },
        { slot: "b", ref: ref("run-b", "operation-b") },
      ],
    });
    expect(parsed.schema_version).toBe(2);
    expect(parsed.artifacts.map((binding) => binding.ref.run_id)).toEqual(["run-a", "run-b"]);
    expect(parsed).not.toHaveProperty("consumer");
    expect(parsed).not.toHaveProperty("run_id");
  });

  it("rejects retired schema-v1 wrappers and refs", () => {
    const current = ref("run-a", "operation-a");
    const legacy = { ...current, schema_version: 1 as const, consumer_scope: ["state:old"] };
    expect(() =>
      parseInputArtifacts({
        schema_version: 1,
        run_id: "retired-run",
        consumer: "retired-consumer",
        artifacts: [{ slot: "a", ref: legacy }],
      })
    ).toThrow(/unknown fields|unsupported input_artifacts schema version/);
  });

  it("rejects duplicate slots, duplicate IDs, and forged identities", () => {
    const value = ref("run-a", "operation-a");
    expect(() =>
      parseInputArtifacts({
        schema_version: 2,
        artifacts: [
          { slot: "same", ref: value },
          { slot: "same", ref: ref("run-b", "operation-b") },
        ],
      })
    ).toThrow(/slots must be unique/);
    expect(() =>
      parseInputArtifacts({
        schema_version: 2,
        artifacts: [
          { slot: "a", ref: value },
          { slot: "b", ref: value },
        ],
      })
    ).toThrow(/refs must be unique/);
    expect(() =>
      parseInputArtifacts({
        schema_version: 2,
        artifacts: [{ slot: "a", ref: { ...value, operation_id: "forged" } }],
      })
    ).toThrow(/canonical identity/);
  });

  it("appends IDs and replaces {previous} without payload substitution", () => {
    const value = ref("run-a", "operation-a");
    const input = singleArtifactInput({ slot: "previous", ref: value });
    const appended = appendInputArtifactInstruction("Use the review.", input);
    expect(appended).toContain(value.artifact_id);
    expect(appended).toContain("artifact_read");
    const replaced = replacePreviousWithArtifact("Revise {previous}", input);
    expect(replaced).not.toContain("{previous}");
    expect(replaced).toContain(value.artifact_id);
  });
});
