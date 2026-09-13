import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import type { RunIdentity } from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine } from "../src/engine.js";
import {
  LivenessController,
  LivenessExhaustedError,
  activeWorkLivenessPolicy,
  legacyResearchLivenessPolicy,
  malformedErrorDigest,
  researchLivenessPolicy,
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
  it("projects the Quick inactivity lease and accepts past former worker external-call counts", () => {
    const root = temporaryDirectory();
    let now = 750;
    const { checkpointer, liveness, engine } = runtime(root, () => now);
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
    expect(liveness.workerPromptBudget("worker-prompt-budget-run", "worker-1")).toMatchObject({
      schema_version: 3,
      preset: "quick",
      purpose: "phase",
      inactivity_lease: {
        interval_ms: 10 * 60_000,
        remaining_ms: 10 * 60_000,
        accepted_progress_signals: 0,
      },
    });
    expect(checkpointer.events("worker-prompt-budget-run")).toEqual(eventsBeforeProjection);

    const first = liveness.sessionSink({
      runId: "worker-prompt-budget-run",
      workerId: "worker-1",
      stateId: "researching",
    });
    // 20 crosses former per-worker tool (20) and external (8) ceilings.
    for (let index = 0; index < 20; index += 1)
      first({ kind: "tool_call", tool_name: "web_fetch" });
    expect(liveness.snapshot("worker-prompt-budget-run").external_calls).toBe(20);
    now += 1;
    expect(liveness.workerPromptBudget("worker-prompt-budget-run", "worker-1")).toMatchObject({
      schema_version: 3,
      inactivity_lease: { remaining_ms: 10 * 60_000 - 1 },
    });
    liveness.endWorker("worker-prompt-budget-run", "worker-1", "complete");
    checkpointer.close();
  });

  it("lets slow productive work exceed the former fixed worker duration", () => {
    const root = temporaryDirectory();
    let now = 0;
    const { checkpointer, liveness, engine } = runtime(root, () => now);
    start(engine, root, "slow-productive-run");
    liveness.admitInvocation({
      runId: "slow-productive-run",
      stateId: "researching",
      branchId: null,
      attempt: 1,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: "slow-productive-run",
      workerId: "worker-slow",
      stateId: "researching",
      branchId: null,
      purpose: "phase",
    });
    liveness.bindWorkerProgressLease({
      runId: "slow-productive-run",
      workerId: "worker-slow",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    const sink = liveness.sessionSink({
      runId: "slow-productive-run",
      workerId: "worker-slow",
      stateId: "researching",
    });
    for (let index = 0; index < 3; index += 1) {
      now += 5 * 60_000;
      sink({
        kind: "activity",
        activity_class: "assistant_thinking_delta",
        observed_units: 1,
      });
    }
    expect(now).toBe(15 * 60_000);
    expect(liveness.workerPromptBudget("slow-productive-run", "worker-slow")).toMatchObject({
      schema_version: 3,
      inactivity_lease: {
        interval_ms: 6 * 60_000,
        remaining_ms: 6 * 60_000,
        accepted_progress_signals: 3,
      },
    });
    liveness.endWorker("slow-productive-run", "worker-slow", "complete");
    checkpointer.close();
  });

  it("does not replay the full durable history for every streaming progress delta", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 1_000);
    start(engine, root, "streaming-progress-run");
    liveness.admitInvocation({
      runId: "streaming-progress-run",
      stateId: "researching",
      branchId: null,
      attempt: 1,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: "streaming-progress-run",
      workerId: "worker-streaming",
      stateId: "researching",
      branchId: null,
      purpose: "phase",
    });
    liveness.bindWorkerProgressLease({
      runId: "streaming-progress-run",
      workerId: "worker-streaming",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });

    const initialEventCount = checkpointer.events("streaming-progress-run").length;
    const suffixReads = vi.spyOn(checkpointer, "eventsAfter");
    const restarted = new LivenessController(checkpointer, () => 1_000);
    const sink = restarted.sessionSink({
      runId: "streaming-progress-run",
      workerId: "worker-streaming",
      stateId: "researching",
    });
    for (let index = 0; index < 256; index += 1) {
      sink({ kind: "activity", activity_class: "assistant_text_delta", observed_units: 1 });
      restarted.workerInactivityLease("streaming-progress-run", "worker-streaming");
    }

    expect(
      restarted.workerPromptBudget("streaming-progress-run", "worker-streaming")
    ).toMatchObject({
      schema_version: 3,
      inactivity_lease: { accepted_progress_signals: 256 },
    });
    const cursors = suffixReads.mock.calls.map(([, sequence]) => sequence);
    expect(cursors.filter((sequence) => sequence === 0)).toHaveLength(1);
    let previousCursor = 0;
    for (const sequence of cursors) {
      expect(sequence).toBeGreaterThanOrEqual(previousCursor);
      previousCursor = sequence;
    }
    expect(
      suffixReads.mock.results.reduce(
        (count, result) => count + (result.type === "return" ? result.value.length : 0),
        0
      )
    ).toBe(initialEventCount + 256);
    suffixReads.mockRestore();
    expect(
      checkpointer
        .events("streaming-progress-run")
        .filter((event) => event.eventType === "liveness_progress_observed")
    ).toHaveLength(256);
    const recovered = new LivenessController(checkpointer, () => 1_000);
    expect(
      recovered.workerPromptBudget("streaming-progress-run", "worker-streaming")
    ).toMatchObject({
      schema_version: 3,
      inactivity_lease: { accepted_progress_signals: 256 },
    });
    checkpointer.close();
  });

  it("incrementally observes workflow events appended outside the liveness controller", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 1_000);
    start(engine, root, "external-event-run");
    expect(liveness.snapshot("external-event-run").terminal_reason).toBeNull();

    const context = checkpointer.loadRunById("external-event-run");
    if (context === undefined) throw new Error("external-event-run was not persisted");
    checkpointer.saveRun(context, "fixture_terminal_reason", {
      terminal_reason: "worker_wall_clock_exhausted",
    });

    expect(liveness.snapshot("external-event-run").terminal_reason).toBe(
      "worker_wall_clock_exhausted"
    );
    checkpointer.close();
  });

  it("expires a stalled V3 worker at the exact inactivity boundary", () => {
    const root = temporaryDirectory();
    let now = 0;
    const { checkpointer, liveness, engine } = runtime(root, () => now);
    start(engine, root, "stalled-lease-run");
    liveness.admitInvocation({
      runId: "stalled-lease-run",
      stateId: "researching",
      branchId: null,
      attempt: 1,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: "stalled-lease-run",
      workerId: "worker-stalled",
      stateId: "researching",
      branchId: null,
      purpose: "phase",
    });
    liveness.bindWorkerProgressLease({
      runId: "stalled-lease-run",
      workerId: "worker-stalled",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    now = 6 * 60_000;
    expect(() =>
      liveness.sessionSink({
        runId: "stalled-lease-run",
        workerId: "worker-stalled",
        stateId: "researching",
      })({ kind: "activity", activity_class: "assistant_text_delta", observed_units: 1 })
    ).toThrowError(new LivenessExhaustedError("worker_inactivity_lease_expired"));
    expect(
      checkpointer
        .events("stalled-lease-run")
        .filter((event) => event.eventType === "liveness_progress_observed")
    ).toHaveLength(0);
    checkpointer.close();
  });

  it("retains external-call telemetry past the former run ceiling across restart", () => {
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
    for (let index = 0; index < 20; index += 1)
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
    for (let index = 0; index < 40; index += 1)
      second({ kind: "tool_call", tool_name: "web_fetch" });
    const before = checkpointer
      .events("external-run")
      .filter((event) => event.eventType === "liveness_tool_call_charged").length;
    expect(before).toBe(60);
    expect(liveness.snapshot("external-run").external_calls).toBe(60);

    now += 1;
    const restarted = new LivenessController(checkpointer, () => now);
    expect(restarted.snapshot("external-run").external_calls).toBe(60);
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

  it("retains wall-time telemetry but does not charge process downtime to a V3 lease", () => {
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
    now += 20 * 60_000;
    const recovered = engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity("wall-run"),
    });
    expect(recovered.action).not.toBe("incomplete");
    expect(liveness.snapshot("wall-run").open_workers).toBe(0);
    checkpointer.close();
  });

  it("retains per-state/branch attempt telemetry without ordinary phase admission ceilings", () => {
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
    liveness.admitInvocation({
      runId: "phase-projection-run",
      stateId: "researching",
      branchId: "same-branch",
      attempt: 7,
      purpose: "phase",
    });
    expect(liveness.phaseAttemptProjection("phase-projection-run")).toEqual({
      '{"branch_id":"same-branch","state_id":"researching"}': 7,
    });
    const restarted = new LivenessController(checkpointer, () => 9_001);
    expect(restarted.phaseAttemptProjection("phase-projection-run")).toEqual(
      liveness.phaseAttemptProjection("phase-projection-run")
    );
    checkpointer.close();
  });

  it("replays an exact V2 active-work policy without reinterpreting it as a lease", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const run = RunContext.create({
      identity: identity("v2-continuation-run"),
      goal: "V2 continuation",
      constraints: { mode: "quick" },
      projectRoot: root,
      trustProfile: "trusted-interactive",
      maxSteps: 96,
    });
    checkpointer.createRun(run, "run_started", { fixture: true });
    const original = new LivenessController(checkpointer, () => 0);
    original.setPolicyResolver(() =>
      activeWorkLivenessPolicy({
        scope: "research",
        preset: "quick",
        worker_active_work_budget_ms: 5 * 60_000,
        run_active_work_budget_ms: 15 * 60_000,
      })
    );
    expect(original.bindPolicy(run).schema_version).toBe(2);
    const recovered = new LivenessController(checkpointer, () => 20 * 60_000);
    recovered.setPolicyResolver(() => researchLivenessPolicy("quick"));
    const bound = recovered.bindPolicy(run);
    expect(bound.schema_version).toBe(2);
    expect(bound).toHaveProperty("worker_active_work_budget_ms", 5 * 60_000);
    checkpointer.close();
  });

  it("recovers an exact V1 bound policy rather than resolving it as V3", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const run = RunContext.create({
      identity: identity("v1-continuation-run"),
      goal: "V1 continuation",
      constraints: { mode: "quick" },
      projectRoot: root,
      trustProfile: "trusted-interactive",
      maxSteps: 96,
    });
    checkpointer.createRun(run, "run_started", { fixture: true });
    const original = new LivenessController(checkpointer, () => 0);
    original.setPolicyResolver(() => legacyResearchLivenessPolicy("quick"));
    expect(original.bindPolicy(run).schema_version).toBe(1);
    const recovered = new LivenessController(checkpointer, () => 1);
    recovered.setPolicyResolver(() => researchLivenessPolicy("quick"));
    const bound = recovered.bindPolicy(run);
    expect(bound.schema_version).toBe(1);
    recovered.admitInvocation({
      runId: run.identity.run_id,
      stateId: "researching",
      branchId: "v1",
      attempt: 1,
      purpose: "phase",
    });
    recovered.startWorker({
      runId: run.identity.run_id,
      workerId: "v1-worker",
      stateId: "researching",
      branchId: "v1",
      purpose: "phase",
    });
    const sink = recovered.sessionSink({
      runId: run.identity.run_id,
      workerId: "v1-worker",
      stateId: "researching",
    });
    for (let index = 0; index < 8; index += 1) sink({ kind: "tool_call", tool_name: "web_fetch" });
    expect(() => sink({ kind: "tool_call", tool_name: "web_fetch" })).toThrowError(
      new LivenessExhaustedError("external_request_budget_exhausted")
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
