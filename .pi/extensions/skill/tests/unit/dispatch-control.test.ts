import { describe, expect, it } from "vitest";

import {
  artifactDispatchControl,
  isArtifactDispatchPause,
  localArtifactDispatchPause,
  parseArtifactDispatchPause,
} from "../../dispatch-control.js";

describe("artifact dispatch control", () => {
  it("defaults active and accepts only exact active|paused values", () => {
    expect(artifactDispatchControl({}).dispatchAllowed).toBe(true);
    expect(artifactDispatchControl({ PENNY_ARTIFACT_DISPATCH_MODE: "active" })).toMatchObject({
      mode: "active",
      dispatchAllowed: true,
    });
    expect(artifactDispatchControl({ PENNY_ARTIFACT_DISPATCH_MODE: "paused" })).toMatchObject({
      mode: "paused",
      code: "ARTIFACT_DISPATCH_PAUSED",
      dispatchAllowed: false,
    });
    for (const configured of ["", "ACTIVE", " paused", "legacy", "semantic-memory"]) {
      expect(artifactDispatchControl({ PENNY_ARTIFACT_DISPATCH_MODE: configured })).toMatchObject({
        mode: "paused",
        code: "ARTIFACT_DISPATCH_MODE_INVALID",
        dispatchAllowed: false,
      });
    }
  });

  it("round-trips the closed non-terminal recovery directive", () => {
    const pause = localArtifactDispatchPause(
      artifactDispatchControl({ PENNY_ARTIFACT_DISPATCH_MODE: "paused" }),
      { state_id: "researching", session_id: "session-1", run_id: "run-1" }
    );
    expect(isArtifactDispatchPause(pause)).toBe(true);
    expect(parseArtifactDispatchPause(pause)).toBe(pause);
    expect(pause).toMatchObject({
      schema_version: 1,
      action: "paused",
      retryable: true,
      dispatch_mode: "paused",
      run_status: "running",
      state_id: "researching",
      recovery: {
        action: "recover",
        run_id: "run-1",
        requires_dispatch_mode: "active",
        checkpoint_preserved: true,
      },
    });
  });

  it("rejects malformed or widened pause contracts", () => {
    const pause = localArtifactDispatchPause(
      artifactDispatchControl({ PENNY_ARTIFACT_DISPATCH_MODE: "paused" }),
      { state_id: "researching", session_id: "session-1", run_id: "run-1" }
    );
    expect(() => parseArtifactDispatchPause({ ...pause, semantic_payload: "forbidden" })).toThrow(
      /unknown or malformed/
    );
    const invalidRecovery = {
      ...pause,
      recovery: { ...pause.recovery, checkpoint_preserved: false },
    };
    expect(isArtifactDispatchPause(invalidRecovery)).toBe(false);
    expect(() => parseArtifactDispatchPause(invalidRecovery)).toThrow(/recovery directive/);
  });
});
