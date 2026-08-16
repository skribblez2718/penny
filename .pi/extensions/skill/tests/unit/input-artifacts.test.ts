import { describe, expect, it } from "vitest";

import {
  artifactIdFor,
  expectedArtifactRef,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../../artifact-client.js";
import {
  ARTIFACT_GRANT_TTL_MS,
  appendInputArtifactInstruction,
  buildArtifactInvocationEnvironment,
  parseInputArtifacts,
} from "../../input-artifacts.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const CURSOR_KEY = Buffer.alloc(32, 0x2a);

function artifactRef(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 1,
    run_id: overrides.run_id ?? "run-1",
    phase: overrides.phase ?? "observing",
    branch_id: overrides.branch_id ?? null,
    kind: overrides.kind ?? "agent-output",
    operation_id: overrides.operation_id ?? "observe-v1",
    version: overrides.version ?? 1,
    producer: overrides.producer ?? "agent:echo",
    consumer_scope: overrides.consumer_scope ?? ["state:framing"],
    media_type: overrides.media_type ?? "text/markdown; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
  };
  return { ...expectedArtifactRef(metadata, "exact predecessor bytes"), ...overrides };
}

function inputArtifacts(refs: ArtifactRef[] = [artifactRef()]) {
  return {
    schema_version: 1,
    run_id: "run-1",
    consumer: "state:framing",
    artifacts: refs.map((ref, index) => ({
      slot: `upstream-${index.toString().padStart(4, "0")}`,
      ref,
    })),
  };
}

describe("strict input_artifacts parser", () => {
  it("accepts the closed schema and binds exact refs to the trusted action", () => {
    const value = inputArtifacts();
    expect(parseInputArtifacts(value, { runId: "run-1", consumer: "state:framing" })).toEqual(
      value
    );
  });

  it("rejects wrong action run, wrong consumer, and a forged or mismatched ref", () => {
    expect(() =>
      parseInputArtifacts(inputArtifacts(), { runId: "run-other", consumer: "state:framing" })
    ).toThrowError(/trusted action identity/);
    expect(() =>
      parseInputArtifacts(inputArtifacts(), { runId: "run-1", consumer: "state:publishing" })
    ).toThrowError(/trusted action identity/);

    const wrongRun = inputArtifacts([artifactRef({ run_id: "run-other" })]);
    expect(() => parseInputArtifacts(wrongRun)).toThrowError(/directive run/);

    const wrongConsumer = inputArtifacts([artifactRef({ consumer_scope: ["state:publishing"] })]);
    expect(() => parseInputArtifacts(wrongConsumer)).toThrowError(/does not grant/);

    const valid = artifactRef();
    const forged = { ...valid, artifact_id: `art_${"f".repeat(64)}` };
    expect(() => parseInputArtifacts(inputArtifacts([forged]))).toThrowError(/identity/);
  });

  it("rejects pairwise wrong grants across legitimate orchestration phases", () => {
    const phases = [
      "state:planning",
      "state:researching",
      "state:synthesizing",
      "state:validating",
      "state:report_writing",
      "state:complete",
    ];

    for (const granted of phases) {
      const ref = artifactRef({ consumer_scope: [granted] });
      for (const actual of phases) {
        const input = { ...inputArtifacts([ref]), consumer: actual };
        if (actual === granted) {
          expect(parseInputArtifacts(input).consumer).toBe(actual);
        } else {
          expect(() => parseInputArtifacts(input)).toThrowError(/does not grant/);
        }
      }
    }
  });

  it("rejects missing, unknown, duplicate-slot, and duplicate-ref shapes", () => {
    expect(() => parseInputArtifacts(undefined)).toThrowError(/must be an object/);
    expect(() => parseInputArtifacts({ ...inputArtifacts(), extra: true })).toThrowError(
      /unknown fields/
    );

    const duplicateSlot = inputArtifacts([
      artifactRef(),
      artifactRef({ operation_id: "observe-v2" }),
    ]);
    duplicateSlot.artifacts[1]!.slot = duplicateSlot.artifacts[0]!.slot;
    expect(() => parseInputArtifacts(duplicateSlot)).toThrowError(/slots must be unique/);

    const duplicateRef = inputArtifacts();
    duplicateRef.artifacts.push({ slot: "second", ref: duplicateRef.artifacts[0]!.ref });
    expect(() => parseInputArtifacts(duplicateRef)).toThrowError(/refs must be unique/);
  });
});

describe("owner artifact invocation handoff", () => {
  it("builds exact-ref grants with caller identity, bounded expiry, and a cursor key", () => {
    const input = parseInputArtifacts(inputArtifacts());
    const environment = buildArtifactInvocationEnvironment(input, "invocation-1", {
      now: NOW,
      cursorKey: CURSOR_KEY,
    });
    const invocation = JSON.parse(environment.PENNY_ARTIFACT_INVOCATION_JSON as string);

    expect(invocation.caller).toEqual({
      run_id: "run-1",
      consumer_ref: "state:framing",
      invocation_id: "invocation-1",
    });
    expect(invocation.grants).toHaveLength(1);
    expect(invocation.grants[0].artifact).toEqual(input.artifacts[0]!.ref);
    expect(invocation.grants[0].artifact).not.toHaveProperty("created_at");
    expect(invocation.grants[0].artifact).not.toHaveProperty("parent_ref");
    expect(Date.parse(invocation.grants[0].expires_at) - NOW).toBe(ARTIFACT_GRANT_TTL_MS);
    expect(Buffer.from(environment.PENNY_ARTIFACT_CURSOR_HMAC_KEY as string, "base64url")).toEqual(
      CURSOR_KEY
    );
    expect(environment.PENNY_ARTIFACT_INVOCATION_FILE).toBeUndefined();
  });

  it("appends slot/ref metadata without payload and emits no grant for an empty state", () => {
    const payloadSentinel = "PAYLOAD-MUST-NOT-BE-IN-TASK";
    const input = parseInputArtifacts(inputArtifacts());
    const task = appendInputArtifactInstruction("Review the predecessor.", input);

    expect(task).toContain('slot "upstream-0000"');
    expect(task).toContain(input.artifacts[0]!.ref.artifact_id);
    expect(task).not.toContain(payloadSentinel);
    expect(task).not.toContain("exact predecessor bytes");

    const empty = parseInputArtifacts({ ...inputArtifacts([]), artifacts: [] });
    expect(appendInputArtifactInstruction("No predecessor.", empty)).toBe("No predecessor.");
    expect(buildArtifactInvocationEnvironment(empty, "invocation-empty")).toEqual({
      PENNY_ARTIFACT_INVOCATION_JSON: undefined,
      PENNY_ARTIFACT_INVOCATION_FILE: undefined,
      PENNY_ARTIFACT_CURSOR_HMAC_KEY: undefined,
    });
  });

  it("uses canonical artifact identities in test fixtures", () => {
    const ref = artifactRef();
    expect(ref.artifact_id).toBe(artifactIdFor(ref));
  });
});
