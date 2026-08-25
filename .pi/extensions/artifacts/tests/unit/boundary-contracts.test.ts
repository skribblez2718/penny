import { describe, expect, it } from "vitest";

import { parseInputArtifacts } from "../../handoff.js";
import {
  ArtifactClientError,
  canonicalArtifactJson,
  parseOutputArtifactMetadata,
} from "../../owner-client.js";
import { outputMetadata } from "../fixtures.js";

function expectArtifactClientError(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof ArtifactClientError)) throw error;
    expect(error.name).toBe("ArtifactClientError");
    expect(error.code).toBe("ARTIFACT_CONTRACT_INVALID");
    expect(error.message).toBe(message);
    return;
  }
  throw new Error("expected artifact boundary operation to throw");
}

describe("artifact JSON boundaries", () => {
  it("preserves canonical object handling and rejects arrays with the contract error", () => {
    expect(canonicalArtifactJson({ zebra: 1, alpha: { two: 2, one: 1 } })).toBe(
      '{"alpha":{"one":1,"two":2},"zebra":1}'
    );
    expectArtifactClientError(() => parseInputArtifacts([]), "input_artifacts must be an object");
  });

  it("keeps input handoffs exact while accepting extras inside artifact refs only per their parser", () => {
    expectArtifactClientError(
      () => parseInputArtifacts({ schema_version: 2, artifacts: [], extra: true }),
      "input_artifacts has unknown fields: extra"
    );
    expectArtifactClientError(
      () =>
        parseInputArtifacts({
          schema_version: 2,
          artifacts: [{ slot: "source", ref: {}, extra: true }],
        }),
      "input_artifacts.artifacts[0] has unknown fields: extra"
    );
  });

  it("retains exact metadata errors for unsafe integers, non-finite JSON, and extra fields", () => {
    expectArtifactClientError(
      () =>
        parseOutputArtifactMetadata({ ...outputMetadata(), version: Number.MAX_SAFE_INTEGER + 1 }),
      "output_artifact.version must be a positive integer"
    );
    expect(() => canonicalArtifactJson({ value: Number.POSITIVE_INFINITY })).toThrowError(
      new ArtifactClientError(
        "ARTIFACT_CONTRACT_INVALID",
        "artifact metadata cannot contain a non-finite number"
      )
    );
    expectArtifactClientError(
      () => parseOutputArtifactMetadata({ ...outputMetadata(), unexpected: "rejected" }),
      "output_artifact has unknown fields: unexpected"
    );
  });
});
