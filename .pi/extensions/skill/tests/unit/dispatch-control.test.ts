import { describe, expect, it } from "vitest";

import {
  artifactDispatchRecoveryV1,
  parseArtifactDispatchMode as engineDispatchModeParser,
  type ArtifactDispatchPauseV1,
  type RunIdentity,
} from "@penny/orchestration/source";
import { parseArtifactDispatchMode, parseArtifactDispatchPause } from "../../dispatch-control.js";

const identity: RunIdentity = {
  schema_version: 2,
  run_id: "run-1",
  session_id: "session-1",
  playbook: "research",
  engine_owner: "typescript",
};

function currentPause(): ArtifactDispatchPauseV1 {
  const dispatch = parseArtifactDispatchMode("paused");
  const reason = dispatch.reason;
  return {
    schema_version: 2,
    pause_schema_version: 1,
    action: "paused",
    identity,
    status: "running",
    state_id: "researching",
    code: "DISPATCH_PAUSED",
    reason,
    retryable: true,
    dispatch,
    recovery: artifactDispatchRecoveryV1({
      identity,
      stateId: "researching",
      reason,
      kind: "recoverable_checkpoint",
      checkpointExists: true,
    }),
  };
}

describe("artifact dispatch engine contract adapter", () => {
  it("re-exports the sole engine-owned setting parser without wrapping it", () => {
    expect(parseArtifactDispatchMode).toBe(engineDispatchModeParser);
    expect(parseArtifactDispatchMode(undefined)).toMatchObject({
      configured_as: "unset",
      dispatch_allowed: true,
    });
    for (const configured of ["", "ACTIVE", " paused", "paused ", "legacy"]) {
      expect(parseArtifactDispatchMode(configured)).toMatchObject({
        mode: "paused",
        configured_as: "invalid",
        code: "DISPATCH_MODE_INVALID",
        dispatch_allowed: false,
      });
    }
  });

  it("consumes current engine pause and recovery facts without reconstruction", () => {
    const pause = currentPause();
    expect(parseArtifactDispatchPause(pause)).toBe(pause);
    expect(pause.recovery).toMatchObject({
      kind: "recoverable_checkpoint",
      action: "recover",
      checkpoint_exists: true,
      checkpoint_preserved: true,
      resumable: true,
    });
  });

  it("projects immutable historical paused shapes without optimistic recovery facts", () => {
    const historical = {
      schema_version: 2 as const,
      action: "paused" as const,
      identity,
      status: "running" as const,
      state_id: "researching",
      code: "DISPATCH_PAUSED" as const,
      reason: "artifact dispatch is paused by the execution owner",
      retryable: true as const,
      recovery: {
        action: "recover" as const,
        run_id: identity.run_id,
        checkpoint_preserved: true,
      },
    };
    const pause = parseArtifactDispatchPause(historical);
    expect(pause).toMatchObject({
      pause_schema_version: 1,
      identity,
      retryable: false,
      recovery: {
        kind: "saved_but_ineligible",
        action: "status_or_cancel",
        ineligibility_code: "LEGACY_CHECKPOINT_UNVERIFIED",
        identity,
        checkpoint_exists: null,
        checkpoint_preserved: null,
        legacy_checkpoint_preserved_claim: true,
        resumable: false,
      },
    });
    expect(
      parseArtifactDispatchPause({
        ...historical,
        recovery: { ...historical.recovery, checkpoint_preserved: false },
      }).recovery
    ).toMatchObject({
      kind: "saved_but_ineligible",
      action: "status_or_cancel",
      ineligibility_code: "LEGACY_CHECKPOINT_UNVERIFIED",
      checkpoint_exists: null,
      checkpoint_preserved: null,
      legacy_checkpoint_preserved_claim: false,
      resumable: false,
    });
    expect(
      parseArtifactDispatchPause({
        ...historical,
        code: "LEGACY_UNMETERED",
        reason: "active legacy run has no durable liveness policy; recovery is paused",
      })
    ).toMatchObject({
      retryable: false,
      recovery: {
        kind: "saved_but_ineligible",
        ineligibility_code: "LEGACY_UNMETERED",
        checkpoint_exists: null,
        legacy_checkpoint_preserved_claim: true,
        resumable: false,
      },
    });
  });

  it("rejects widened or identity-inconsistent recovery facts", () => {
    const pause = currentPause();
    expect(() => parseArtifactDispatchPause({ ...pause, semantic_payload: "forbidden" })).toThrow(
      /schema validation/u
    );
    expect(() => parseArtifactDispatchPause({ ...pause, pause_schema_version: 2 })).toThrow(
      /schema validation/u
    );
    expect(() =>
      parseArtifactDispatchPause({
        ...pause,
        recovery: {
          ...pause.recovery,
          identity: { ...pause.recovery.identity, run_id: "different-run" },
        },
      })
    ).toThrow(/exactly match/u);
  });
});
