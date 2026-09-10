import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { canonicalJson, Checkpointer } from "../src/checkpointer.js";
import {
  artifactDispatchRecoveryV1,
  parseArtifactDispatchPause,
  type ArtifactDispatchPauseV1,
  type RunIdentity,
} from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine, parseArtifactDispatchMode } from "../src/engine.js";
import type { ModelClient } from "../src/model-client.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "penny-artifact-dispatch-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identity(runId: string, sessionId = `session-${runId}`): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: sessionId,
    playbook: "research",
    engine_owner: "typescript",
  };
}

function startRequest(root: string, runIdentity: RunIdentity) {
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: runIdentity,
    goal: "Verify exact execution-owner artifact dispatch behavior.",
    constraints: { mode: "quick" },
    project_root: root,
    trust_profile: "trusted-interactive" as const,
  };
}

function engine(
  checkpointer: Checkpointer,
  root: string,
  dispatchMode: () => string | undefined
): OrchestrationEngine {
  return new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: 96,
    dispatchMode,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
  });
}

function requirePause(value: unknown): ArtifactDispatchPauseV1 {
  return parseArtifactDispatchPause(value);
}

describe("artifact dispatch mode parser", () => {
  it.each([
    [undefined, "active", "unset", "DISPATCH_ACTIVE", true],
    ["active", "active", "active", "DISPATCH_ACTIVE", true],
    ["paused", "paused", "paused", "DISPATCH_PAUSED", false],
    ["", "paused", "invalid", "DISPATCH_MODE_INVALID", false],
    [" ", "paused", "invalid", "DISPATCH_MODE_INVALID", false],
    [" active", "paused", "invalid", "DISPATCH_MODE_INVALID", false],
    ["active ", "paused", "invalid", "DISPATCH_MODE_INVALID", false],
    ["PAUSED", "paused", "invalid", "DISPATCH_MODE_INVALID", false],
    ["Active", "paused", "invalid", "DISPATCH_MODE_INVALID", false],
    ["unknown", "paused", "invalid", "DISPATCH_MODE_INVALID", false],
    [null, "paused", "invalid", "DISPATCH_MODE_INVALID", false],
  ] as const)("parses %p exactly", (configured, mode, configuredAs, code, dispatchAllowed) => {
    expect(parseArtifactDispatchMode(configured)).toMatchObject({
      schema_version: 1,
      mode,
      configured_as: configuredAs,
      code,
      dispatch_allowed: dispatchAllowed,
    });
  });
});

describe("legacy pause compatibility projection", () => {
  it.each([
    ["DISPATCH_PAUSED", true, "LEGACY_CHECKPOINT_UNVERIFIED"],
    ["DISPATCH_MODE_INVALID", false, "LEGACY_CHECKPOINT_UNVERIFIED"],
    ["LEGACY_UNMETERED", true, "LEGACY_UNMETERED"],
    ["LEGACY_UNMETERED", false, "LEGACY_UNMETERED"],
  ] as const)(
    "keeps %s checkpoint_preserved=%s as an unverified claim",
    (code, checkpointPreserved, ineligibilityCode) => {
      const runIdentity = identity(`legacy-${code.toLowerCase()}-${String(checkpointPreserved)}`);
      const pause = parseArtifactDispatchPause({
        schema_version: 2,
        action: "paused",
        identity: runIdentity,
        status: "running",
        state_id: "researching",
        code,
        reason: "immutable historical pause reason",
        retryable: true,
        recovery: {
          action: "recover",
          run_id: runIdentity.run_id,
          checkpoint_preserved: checkpointPreserved,
        },
      });

      expect(pause.retryable).toBe(false);
      expect(pause.recovery).toEqual({
        schema_version: 1,
        kind: "saved_but_ineligible",
        action: "status_or_cancel",
        ineligibility_code: ineligibilityCode,
        identity: runIdentity,
        state_id: "researching",
        reason:
          "Historical pause metadata cannot verify current checkpoint existence or resumability.",
        checkpoint_exists: null,
        checkpoint_preserved: null,
        legacy_checkpoint_preserved_claim: checkpointPreserved,
        resumable: false,
        requires_dispatch_mode: null,
      });
    }
  );

  it("reserves LEGACY_CHECKPOINT_UNVERIFIED for compatibility projection", () => {
    expect(() =>
      artifactDispatchRecoveryV1({
        identity: identity("current-cannot-claim-legacy-compatibility"),
        stateId: "researching",
        reason: "current storage lookup completed",
        kind: "saved_but_ineligible",
        checkpointExists: true,
        ineligibilityCode: "LEGACY_CHECKPOINT_UNVERIFIED",
      })
    ).toThrow(/cannot be emitted as current observed storage facts/u);
  });
});

describe("engine-owned pause and recovery facts", () => {
  it("reports a checkpointless paused start without creating a run row", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const runIdentity = identity("fresh-no-row");
    const paused = requirePause(
      engine(checkpointer, root, () => "paused").handle(startRequest(root, runIdentity))
    );

    expect(checkpointer.runExists(runIdentity.run_id)).toBe(false);
    expect(paused.identity).toEqual(runIdentity);
    expect(paused.state_id).toBe("intake");
    expect(paused.recovery).toMatchObject({
      kind: "start_retry",
      action: "retry_start",
      checkpoint_exists: false,
      checkpoint_preserved: false,
      resumable: false,
      requires_dispatch_mode: "active",
    });
    checkpointer.close();
  });

  it("reports an actual admission row while retaining start/retry semantics", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const runIdentity = identity("fresh-with-row");
    const admitted = RunContext.create({
      identity: runIdentity,
      goal: "Verify an already-admitted start.",
      constraints: { mode: "quick" },
      projectRoot: root,
      trustProfile: "trusted-interactive",
      maxSteps: 96,
    });
    checkpointer.createRun(admitted, "admitted_fixture", { fixture: true });

    const paused = requirePause(
      engine(checkpointer, root, () => "paused").handle(startRequest(root, runIdentity))
    );
    expect(paused.identity).toEqual(runIdentity);
    expect(paused.recovery).toMatchObject({
      kind: "start_retry",
      action: "retry_start",
      checkpoint_exists: true,
      checkpoint_preserved: true,
      resumable: false,
    });
    checkpointer.close();
  });

  it("preserves current checkpoint bytes and exports exact recoverable identity", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const runIdentity = identity("saved-current", "session-saved-current");
    const initial = engine(checkpointer, root, () => "active").handle(
      startRequest(root, runIdentity)
    );
    const before = canonicalJson(checkpointer.loadRun(runIdentity).snapshot());

    const paused = requirePause(
      engine(checkpointer, root, () => "paused").handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      })
    );
    expect(paused.identity).toEqual(runIdentity);
    expect(paused.recovery.identity).toEqual(runIdentity);
    expect(paused.recovery.state_id).toBe(paused.state_id);
    expect(paused.recovery).toMatchObject({
      kind: "recoverable_checkpoint",
      action: "recover",
      checkpoint_exists: true,
      checkpoint_preserved: true,
      resumable: true,
    });
    expect(canonicalJson(checkpointer.loadRun(runIdentity).snapshot())).toBe(before);
    const resumed = engine(checkpointer, root, () => "active").handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    expect(resumed).toEqual(initial);
    checkpointer.close();
  });

  it("does not call a saved checkpoint resumable when no continuation exists", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const runIdentity = identity("saved-without-continuation");
    engine(checkpointer, root, () => "active").handle(startRequest(root, runIdentity));
    const damaged = checkpointer.loadRun(runIdentity);
    damaged.pendingDirective = null;
    checkpointer.saveRun(damaged, "missing_pending_fixture", { fixture: true });
    const before = canonicalJson(checkpointer.loadRun(runIdentity).snapshot());

    const paused = requirePause(
      engine(checkpointer, root, () => "paused").handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      })
    );
    expect(paused.recovery).toMatchObject({
      kind: "saved_but_ineligible",
      action: "status_or_cancel",
      ineligibility_code: "CHECKPOINT_NOT_RESUMABLE",
      checkpoint_exists: true,
      resumable: false,
    });
    expect(canonicalJson(checkpointer.loadRun(runIdentity).snapshot())).toBe(before);
    checkpointer.close();
  });

  it("preserves legacy checkpoint bytes and refuses to invent liveness authority", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const runIdentity = identity("saved-legacy", "session-saved-legacy");
    const legacy = RunContext.create({
      identity: runIdentity,
      goal: "Legacy saved run",
      constraints: { mode: "quick" },
      projectRoot: root,
      trustProfile: "trusted-interactive",
      maxSteps: 96,
    });
    legacy.transition("researching");
    checkpointer.createRun(legacy, "legacy_fixture", { fixture: true });
    const before = canonicalJson(checkpointer.loadRun(runIdentity).snapshot());

    const paused = requirePause(
      engine(checkpointer, root, () => "active").handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      })
    );
    expect(paused).toMatchObject({
      code: "LEGACY_UNMETERED",
      retryable: false,
      recovery: {
        kind: "saved_but_ineligible",
        action: "status_or_cancel",
        checkpoint_exists: true,
        checkpoint_preserved: true,
        resumable: false,
        requires_dispatch_mode: null,
      },
    });
    expect(canonicalJson(checkpointer.loadRun(runIdentity).snapshot())).toBe(before);
    checkpointer.close();
  });

  it.each(["paused", "", " active", "PAUSED", "unknown"])(
    "returns a non-dispatch directive and invokes zero workers for %p",
    async (setting) => {
      const root = temporaryDirectory();
      const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
      let workerCalls = 0;
      const client: ModelClient = {
        runAgent: async () => {
          workerCalls += 1;
          throw new Error("blocked setting reached a worker");
        },
      };
      const owner = engine(checkpointer, root, () => setting);
      const workers = new WorkerExecutor(client, new ArtifactStore(path.join(root, "artifacts")), {
        projectRoot: root,
        parallelConcurrency: 4,
      });
      const runner = new OrchestrationRunner(owner, workers);
      const runIdentity = identity(
        `zero-dispatch-${Buffer.from(setting).toString("hex") || "blank"}`
      );
      const initial = owner.handle(startRequest(root, runIdentity));
      const boundary = await runner.runUntilBoundary(initial);

      expect(boundary.action).toBe("paused");
      expect(workerCalls).toBe(0);
      expect(checkpointer.runExists(runIdentity.run_id)).toBe(false);
      checkpointer.close();
    }
  );

  it("rechecks the owner setting at the final runner boundary before worker dispatch", async () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    let setting: string | undefined = "active";
    let workerCalls = 0;
    const client: ModelClient = {
      runAgent: async () => {
        workerCalls += 1;
        throw new Error("final dispatch boundary reached a worker");
      },
    };
    const owner = engine(checkpointer, root, () => setting);
    const workers = new WorkerExecutor(client, new ArtifactStore(path.join(root, "artifacts")), {
      projectRoot: root,
      parallelConcurrency: 4,
    });
    const runner = new OrchestrationRunner(owner, workers);
    const runIdentity = identity("dispatch-boundary-recheck");
    const initial = owner.handle(startRequest(root, runIdentity));
    expect(initial.action).toBe("invoke_agent");
    setting = " active";

    const boundary = requirePause(await runner.runUntilBoundary(initial));
    expect(boundary.code).toBe("DISPATCH_MODE_INVALID");
    expect(boundary.recovery.kind).toBe("recoverable_checkpoint");
    expect(workerCalls).toBe(0);
    checkpointer.close();
  });

  it("keeps status and cancel available while the setting is invalid", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    let setting: string | undefined = "active";
    const owner = engine(checkpointer, root, () => setting);
    const runIdentity = identity("status-cancel-invalid");
    owner.handle(startRequest(root, runIdentity));
    setting = "invalid";

    expect(
      owner.handle({ schema_version: 2, action: "status", identity: runIdentity }).action
    ).toBe("status");
    expect(
      owner.handle({
        schema_version: 2,
        action: "cancel",
        identity: runIdentity,
        reason: "operator cancellation while dispatch configuration is invalid",
      }).action
    ).toBe("cancelled");
    checkpointer.close();
  });
});
