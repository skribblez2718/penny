import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import type { RunIdentity } from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine } from "../src/engine.js";
import {
  LivenessController,
  LivenessExhaustedError,
  malformedErrorDigest,
  researchThinkingLevelForLivenessPreset,
} from "../src/liveness.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "penny-liveness-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: "session-liveness",
    playbook: "research",
    engine_owner: "typescript",
  };
}

function start(engine: OrchestrationEngine, root: string, runId: string, mode = "quick") {
  return engine.handle({
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: "Synthetic liveness fixture",
    constraints: { mode },
    project_root: root,
    trust_profile: "trusted-interactive",
  });
}

function runtime(root: string, clock: () => number) {
  const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
  const liveness = new LivenessController(checkpointer, clock);
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: 96,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    livenessController: liveness,
  });
  return { checkpointer, liveness, engine };
}

describe("research liveness inference effort", () => {
  it.each([
    ["bootstrap", "high"],
    ["quick", "low"],
    ["standard", "high"],
    ["deep", "xhigh"],
  ] as const)("maps the durable %s preset to %s thinking", (preset, expected) => {
    expect(researchThinkingLevelForLivenessPreset(preset)).toBe(expected);
  });

  it("fails closed for an unknown Research preset", () => {
    expect(() => researchThinkingLevelForLivenessPreset("future-preset")).toThrow(
      "unknown research liveness preset 'future-preset'"
    );
  });
});

describe("durable liveness budgets", () => {
  it("projects the Quick worker budget without charging and denies a ninth same-worker external call", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 750);
    start(engine, root, "worker-prompt-budget-run");
    liveness.admitInvocation({
      runId: "worker-prompt-budget-run",
      stateId: "researching",
      branchId: "sq1",
      attempt: 1,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: "worker-prompt-budget-run",
      workerId: "worker-1",
      stateId: "researching",
      branchId: "sq1",
      purpose: "phase",
    });

    const eventsBeforeProjection = checkpointer.events("worker-prompt-budget-run");
    expect(liveness.workerPromptBudget("worker-prompt-budget-run", "worker-1")).toEqual({
      schema_version: 1,
      preset: "quick",
      purpose: "phase",
      model_turns: { worker_remaining: 16, run_remaining: 48, effective_remaining: 16 },
      tool_calls: { worker_remaining: 20, run_remaining: 64, effective_remaining: 20 },
      external_requests: { worker_remaining: 8, run_remaining: 12, effective_remaining: 8 },
    });
    expect(checkpointer.events("worker-prompt-budget-run")).toEqual(eventsBeforeProjection);

    const first = liveness.sessionSink({
      runId: "worker-prompt-budget-run",
      workerId: "worker-1",
      stateId: "researching",
    });
    for (let index = 0; index < 7; index += 1) {
      first({ kind: "tool_call", tool_name: "web_fetch" });
    }
    expect(
      liveness.workerPromptBudget("worker-prompt-budget-run", "worker-1").external_requests
    ).toEqual({ worker_remaining: 1, run_remaining: 5, effective_remaining: 1 });
    first({ kind: "tool_call", tool_name: "bash" });
    expect(() => first({ kind: "tool_call", tool_name: "playwright_navigate" })).toThrowError(
      new LivenessExhaustedError("external_request_budget_exhausted")
    );
    liveness.endWorker("worker-prompt-budget-run", "worker-1", "complete");

    liveness.admitInvocation({
      runId: "worker-prompt-budget-run",
      stateId: "researching",
      branchId: "sq2",
      attempt: 1,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: "worker-prompt-budget-run",
      workerId: "worker-2",
      stateId: "researching",
      branchId: "sq2",
      purpose: "phase",
    });
    expect(
      liveness.workerPromptBudget("worker-prompt-budget-run", "worker-2").external_requests
    ).toEqual({ worker_remaining: 8, run_remaining: 4, effective_remaining: 4 });
    expect(
      checkpointer
        .events("worker-prompt-budget-run")
        .filter((event) => event.eventType === "liveness_tool_call_charged")
    ).toHaveLength(8);
    checkpointer.close();
  });

  it("charges before admission, survives controller restart, and denies a thirteenth quick external call", () => {
    const root = temporaryDirectory();
    let now = 1_000;
    const { checkpointer, liveness, engine } = runtime(root, () => now);
    start(engine, root, "external-run");

    liveness.admitInvocation({
      runId: "external-run",
      stateId: "researching",
      branchId: "sq1",
      attempt: 1,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: "external-run",
      workerId: "worker-1",
      stateId: "researching",
      branchId: "sq1",
      purpose: "phase",
    });
    const first = liveness.sessionSink({
      runId: "external-run",
      workerId: "worker-1",
      stateId: "researching",
    });
    for (let index = 0; index < 8; index += 1)
      first({ kind: "tool_call", tool_name: "web_search" });
    liveness.endWorker("external-run", "worker-1", "complete");

    liveness.admitInvocation({
      runId: "external-run",
      stateId: "researching",
      branchId: "sq2",
      attempt: 1,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: "external-run",
      workerId: "worker-2",
      stateId: "researching",
      branchId: "sq2",
      purpose: "phase",
    });
    const second = liveness.sessionSink({
      runId: "external-run",
      workerId: "worker-2",
      stateId: "researching",
    });
    for (let index = 0; index < 4; index += 1) second({ kind: "tool_call", tool_name: "bash" });
    const before = checkpointer
      .events("external-run")
      .filter((event) => event.eventType === "liveness_tool_call_charged").length;
    expect(before).toBe(12);
    expect(() => second({ kind: "tool_call", tool_name: "web_fetch" })).toThrowError(
      new LivenessExhaustedError("external_request_budget_exhausted")
    );
    expect(
      checkpointer
        .events("external-run")
        .filter((event) => event.eventType === "liveness_tool_call_charged")
    ).toHaveLength(12);

    now += 1;
    const restarted = new LivenessController(checkpointer, () => now);
    expect(restarted.snapshot("external-run").external_calls).toBe(12);
    checkpointer.close();
  });

  it("charges Pi retry, summarization, compaction, and turn sources as model turns", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 5_000);
    start(engine, root, "turn-run");
    liveness.admitInvocation({
      runId: "turn-run",
      stateId: "researching",
      branchId: null,
      attempt: 1,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: "turn-run",
      workerId: "worker-turns",
      stateId: "researching",
      branchId: null,
      purpose: "phase",
    });
    const sink = liveness.sessionSink({
      runId: "turn-run",
      workerId: "worker-turns",
      stateId: "researching",
    });
    sink({ kind: "model_turn", source: "turn_start" });
    sink({ kind: "model_turn", source: "auto_retry_start" });
    sink({ kind: "model_turn", source: "summarization_retry_attempt_start" });
    sink({ kind: "model_turn", source: "compaction_start" });
    expect(liveness.snapshot("turn-run").model_turns).toBe(4);
    checkpointer.close();
  });

  it("folds parallel wall time as a union and charges interruption downtime on recovery", () => {
    const root = temporaryDirectory();
    let now = 0;
    const { checkpointer, liveness, engine } = runtime(root, () => now);
    start(engine, root, "wall-run");
    for (const workerId of ["worker-a", "worker-b"]) {
      liveness.admitInvocation({
        runId: "wall-run",
        stateId: "researching",
        branchId: workerId,
        attempt: 1,
        purpose: "phase",
      });
      liveness.startWorker({
        runId: "wall-run",
        workerId,
        stateId: "researching",
        branchId: workerId,
        purpose: "phase",
      });
    }
    now = 60_000;
    liveness.endWorker("wall-run", "worker-a", "complete");
    now = 120_000;
    liveness.endWorker("wall-run", "worker-b", "complete");
    expect(liveness.snapshot("wall-run").active_wall_clock_ms).toBe(120_000);

    liveness.admitInvocation({
      runId: "wall-run",
      stateId: "researching",
      branchId: "worker-c",
      attempt: 2,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: "wall-run",
      workerId: "worker-c",
      stateId: "researching",
      branchId: "worker-c",
      purpose: "phase",
    });
    now += 5 * 60_000;
    const recovered = engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity("wall-run"),
    });
    expect(recovered.action).toBe("incomplete");
    if (recovered.action === "incomplete") {
      expect(recovered.result.terminal_reason).toBe("worker_wall_clock_exhausted");
      expect(recovered.met).toBe(false);
    }
    expect(liveness.snapshot("wall-run").open_workers).toBe(0);
    checkpointer.close();
  });

  it("projects per-state/branch attempts from durable events without lowering the P1 total ceiling", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 9_000);
    start(engine, root, "phase-projection-run");
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      liveness.admitInvocation({
        runId: "phase-projection-run",
        stateId: "researching",
        branchId: "same-branch",
        attempt,
        purpose: "phase",
      });
    }
    expect(liveness.phaseAttemptProjection("phase-projection-run")).toEqual({
      '{"branch_id":"same-branch","state_id":"researching"}': 6,
    });
    expect(() =>
      liveness.admitInvocation({
        runId: "phase-projection-run",
        stateId: "researching",
        branchId: "same-branch",
        attempt: 7,
        purpose: "phase",
      })
    ).toThrowError(new LivenessExhaustedError("model_turn_budget_exhausted"));
    const restarted = new LivenessController(checkpointer, () => 9_001);
    expect(restarted.phaseAttemptProjection("phase-projection-run")).toEqual(
      liveness.phaseAttemptProjection("phase-projection-run")
    );
    checkpointer.close();
  });

  it("quarantines active legacy runs without guessing historical spend", () => {
    const root = temporaryDirectory();
    const { checkpointer, engine } = runtime(root, () => 10_000);
    const runIdentity = identity("legacy-active-run");
    const legacy = RunContext.create({
      identity: runIdentity,
      goal: "Legacy active fixture",
      constraints: { mode: "quick" },
      projectRoot: root,
      trustProfile: "trusted-interactive",
      maxSteps: 96,
    });
    legacy.transition("researching");
    checkpointer.createRun(legacy, "legacy_fixture", { fixture: true });
    const status = engine.handle({ schema_version: 2, action: "status", identity: runIdentity });
    expect(status.action).toBe("status");
    if (status.action === "status") {
      expect(status.liveness?.policy_state).toBe("legacy_unmetered");
    }
    const recover = engine.handle({ schema_version: 2, action: "recover", identity: runIdentity });
    expect(recover.action).toBe("paused");
    if (recover.action === "paused") expect(recover.code).toBe("LEGACY_UNMETERED");
    checkpointer.close();
  });

  it("stalls on the second identical malformed digest and exhausts on a second distinct one", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 10_000);
    start(engine, root, "malformed-run");
    const digest = malformedErrorDigest({
      kind: "malformed_result",
      stateId: "researching",
      branchId: null,
      schemaIssues: ["/explore_complete: required"],
    });
    expect(
      liveness.chargeMalformed({
        runId: "malformed-run",
        stateId: "researching",
        branchId: null,
        digest,
      })
    ).toBeNull();
    expect(
      liveness.chargeMalformed({
        runId: "malformed-run",
        stateId: "researching",
        branchId: null,
        digest,
      })
    ).toBe("identical_error_stall");

    start(engine, root, "distinct-run");
    expect(
      liveness.chargeMalformed({
        runId: "distinct-run",
        stateId: "researching",
        branchId: null,
        digest: "a".repeat(64),
      })
    ).toBeNull();
    expect(
      liveness.chargeMalformed({
        runId: "distinct-run",
        stateId: "researching",
        branchId: null,
        digest: "b".repeat(64),
      })
    ).toBe("malformed_result_budget_exhausted");
    checkpointer.close();
  });
});
