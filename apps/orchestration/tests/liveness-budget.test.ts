import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkpointer } from "../dist/checkpointer.js";
import {
  LivenessPolicySchema,
  LivenessPolicyV1Schema,
  LivenessPolicyV2Schema,
  validateContract,
  type RunIdentity,
} from "../dist/contracts.js";
import { ArtifactStore } from "../dist/artifact-store.js";
import { decodeCurrentLivenessPolicy, RetiredLivenessPolicyError } from "../dist/durable-state.js";
import { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import {
  LivenessController,
  LivenessExhaustedError,
  malformedErrorDigest,
  researchLivenessPolicy,
  researchThinkingLevelForLivenessPreset,
} from "../dist/liveness.js";
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

describe("current durable liveness contract", () => {
  it("accepts only the closed current execution codec without changing its input", () => {
    const policy = researchLivenessPolicy("standard");
    const original = structuredClone(policy);
    expect(decodeCurrentLivenessPolicy(policy)).toEqual(original);
    for (const value of [
      null,
      { ...policy, schema_version: 4 },
      { ...policy, worker_wall_clock_ms: 1 },
      { ...policy, unknown_provider_phase_inactivity_ms: 0 },
    ]) {
      expect(() => decodeCurrentLivenessPolicy(value)).toThrow();
    }
    expect(policy).toEqual(original);
  });

  it("keeps a worker's resolved model binding exact and refuses rebinding without mutation", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 0);
    const runId = "exact-model-lease";
    start(engine, root, runId);
    liveness.startWorker({
      runId,
      workerId: "worker",
      stateId: "planning",
      branchId: null,
      purpose: "phase",
    });
    const input = { runId, workerId: "worker", providerId: "openai-codex", modelId: "gpt-5.6-sol" };
    const binding = liveness.bindWorkerProgressLease(input);
    const before = checkpointer.events(runId);
    expect(liveness.bindWorkerProgressLease(input)).toEqual(binding);
    expect(() => liveness.bindWorkerProgressLease({ ...input, modelId: "another-model" })).toThrow(
      "already bound to another model"
    );
    expect(checkpointer.events(runId)).toEqual(before);
    checkpointer.close();
  });

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

  it("expires a stalled worker at the exact inactivity boundary", () => {
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

  it("retains wall-time telemetry but does not charge process downtime to a current lease", () => {
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

  it.each([1, 2] as const)(
    "refuses pending V%s policy records without changing retained state",
    (version) => {
      const root = temporaryDirectory();
      const source = runtime(root, () => 0);
      const runId = "retired-v" + version + "-run";
      start(source.engine, root, runId);
      const run = source.checkpointer.loadRunById(runId);
      if (run === undefined || run.pendingDirective === null)
        throw new Error("pending fixture is absent");
      source.checkpointer.close();

      const artifacts = new ArtifactStore(path.join(root, "artifacts"));
      const bytes = Buffer.from("Retained historical output: never delete or rewrite.");
      const ref = artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: runId,
          phase: "planning",
          branch_id: null,
          kind: "agent-output",
          operation_id: "retained-history",
          version: 1,
          producer: "piper",
          media_type: "text/plain",
          parent_ref: null,
          upstream_refs: [],
        },
        content: bytes,
      });
      run.selectedArtifacts.push(ref);
      const filename = path.join(root, "retained.db");
      const stored = new Checkpointer(filename);
      stored.createRun(run, "retained_fixture", { fixture: true });
      const protections = {
        scope: "research",
        preset: "quick",
        malformed_results_per_state_branch: 2,
        identical_malformed_digest_limit: 2,
        protocol_errors_per_worker: 4,
        identical_protocol_digest_limit: 2,
        routing_repair: {
          max_invocations_per_state_branch: 1,
          model_turns_per_worker: 4,
          tool_calls_per_worker: 2,
          external_calls_per_worker: 0,
          worker_wall_clock_ms: 120_000,
        },
      };
      const policy =
        version === 1
          ? validateContract(
              LivenessPolicyV1Schema,
              {
                ...protections,
                schema_version: 1,
                total_phase_repair_invocations: 6,
                model_turns_per_worker: 16,
                model_turns_per_run: 48,
                tool_calls_per_worker: 20,
                tool_calls_per_run: 64,
                external_calls_per_worker: 8,
                external_calls_per_run: 12,
                worker_wall_clock_ms: 300_000,
                run_wall_clock_ms: 900_000,
              },
              "historical V1 fixture"
            )
          : validateContract(
              LivenessPolicyV2Schema,
              {
                ...protections,
                schema_version: 2,
                worker_active_work_budget_ms: 300_000,
                run_active_work_budget_ms: 900_000,
              },
              "historical V2 fixture"
            );
      expect(() => validateContract(LivenessPolicySchema, policy, "current policy")).toThrow();
      expect(() => decodeCurrentLivenessPolicy(policy)).toThrow(RetiredLivenessPolicyError);
      stored.appendLivenessEvent(runId, "liveness_policy_bound", {
        schema_version: 1,
        at_ms: 0,
        policy,
      });
      stored.appendLivenessEvent(runId, "liveness_worker_started", {
        schema_version: 1,
        at_ms: 0,
        worker_id: "interrupted-legacy-worker",
        state_id: "planning",
        branch_id: null,
        purpose: "phase",
      });
      const beforeEvents = stored.events(runId);
      const beforeSnapshot = stored.loadRun(run.identity).snapshot();
      stored.close();

      const reopened = new Checkpointer(filename);
      const controller = new LivenessController(reopened, () => 3_600_000);
      const engine = new OrchestrationEngine(reopened, {
        projectRoot: root,
        receiptAuthority: TEST_RECEIPT_AUTHORITY,
        livenessController: controller,
      });
      for (const action of ["status", "recover", "cancel"] as const) {
        expect(() => engine.handle({ schema_version: 2, action, identity: run.identity })).toThrow(
          "retired liveness policy format: runtime execution refused; retained checkpoint unchanged"
        );
        expect(reopened.events(runId)).toEqual(beforeEvents);
        expect(reopened.loadRun(run.identity).snapshot()).toEqual(beforeSnapshot);
        expect(artifacts.refById(ref.artifact_id)).toEqual(ref);
        expect(artifacts.readById(ref.artifact_id)).toEqual(bytes);
      }
      expect(() =>
        controller.admitInvocation({
          runId,
          stateId: "planning",
          branchId: null,
          attempt: 2,
          purpose: "phase",
        })
      ).toThrow(RetiredLivenessPolicyError);
      expect(reopened.events(runId)).toEqual(beforeEvents);
      artifacts.close();
      reopened.close();
    }
  );

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

  it("fences interrupted and cancelled workers while a fresh recovered lease can progress", () => {
    const root = temporaryDirectory();
    let now = 0;
    const original = runtime(root, () => now);
    const runId = "current-recovery-fences";
    start(original.engine, root, runId);
    original.liveness.startWorker({
      runId,
      workerId: "interrupted",
      stateId: "planning",
      branchId: null,
      purpose: "phase",
    });
    const binding = original.liveness.bindWorkerProgressLease({
      runId,
      workerId: "interrupted",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    const bound = original.liveness.policy(runId);
    const pending = original.checkpointer.loadRun(identity(runId)).pendingDirective;
    original.checkpointer.close();

    now = 24 * 60 * 60_000;
    const recovered = runtime(root, () => now);
    expect(recovered.liveness.workerInactivityLease(runId, "interrupted").binding).toEqual(binding);
    expect(
      recovered.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(pending);
    expect(recovered.liveness.policy(runId)).toEqual(bound);
    const ended = recovered.checkpointer
      .events(runId)
      .filter((event) => event.eventType === "liveness_worker_ended");
    expect(ended.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ worker_id: "interrupted", outcome: "error" })
    );
    const staleSink = recovered.liveness.sessionSink({
      runId,
      workerId: "interrupted",
      stateId: "planning",
    });
    const beforeStale = recovered.checkpointer.events(runId);
    expect(() =>
      staleSink({ kind: "activity", activity_class: "assistant_text_delta", observed_units: 1 })
    ).toThrow("no open worker lease");
    expect(recovered.checkpointer.events(runId)).toEqual(beforeStale);

    recovered.liveness.startWorker({
      runId,
      workerId: "fresh",
      stateId: "planning",
      branchId: null,
      purpose: "phase",
    });
    const freshSink = recovered.liveness.sessionSink({
      runId,
      workerId: "fresh",
      stateId: "planning",
    });
    const beforeEmpty = recovered.checkpointer.events(runId);
    expect(() =>
      freshSink({ kind: "activity", activity_class: "assistant_text_delta", observed_units: 0 })
    ).toThrow("bounded positive integer");
    expect(recovered.checkpointer.events(runId)).toEqual(beforeEmpty);
    now += 1;
    freshSink({ kind: "activity", activity_class: "assistant_text_delta", observed_units: 1 });
    expect(
      recovered.liveness.workerPromptBudget(runId, "fresh").inactivity_lease
        .accepted_progress_signals
    ).toBe(1);
    const cancelled = recovered.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(runId),
    });
    expect(cancelled.action).toBe("cancelled");
    expect(recovered.liveness.snapshot(runId).open_workers).toBe(0);
    const beforeLate = recovered.checkpointer.events(runId);
    expect(() =>
      freshSink({ kind: "activity", activity_class: "assistant_text_delta", observed_units: 1 })
    ).toThrow("no open worker lease");
    expect(recovered.checkpointer.events(runId)).toEqual(beforeLate);
    expect(
      recovered.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(cancelled);
    recovered.checkpointer.close();
  });

  it("preserves explicit routing-repair limits without imposing ordinary-work quotas", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 0);
    liveness.setPolicyResolver(() => ({
      ...researchLivenessPolicy("quick"),
      routing_repair: {
        max_invocations_per_state_branch: 1,
        model_turns_per_worker: 1,
        tool_calls_per_worker: 2,
        external_calls_per_worker: 0,
      },
    }));
    const runId = "operator-repair-limits";
    start(engine, root, runId);
    const attempt = {
      runId,
      stateId: "planning",
      branchId: null,
      attempt: 1,
      purpose: "routing_repair",
    } as const;
    liveness.admitInvocation(attempt);
    const beforeAdmission = checkpointer.events(runId);
    expect(() => liveness.admitInvocation({ ...attempt, attempt: 2 })).toThrowError(
      new LivenessExhaustedError("malformed_result_budget_exhausted")
    );
    expect(checkpointer.events(runId)).toEqual(beforeAdmission);
    liveness.startWorker({ ...attempt, workerId: "repair" });
    const repair = liveness.sessionSink({ runId, workerId: "repair", stateId: "planning" });
    repair({ kind: "model_turn", source: "turn_start" });
    expect(() => repair({ kind: "model_turn", source: "turn_start" })).toThrowError(
      new LivenessExhaustedError("model_turn_budget_exhausted")
    );
    expect(() => repair({ kind: "tool_call", tool_name: "web_fetch" })).toThrowError(
      new LivenessExhaustedError("external_request_budget_exhausted")
    );
    repair({ kind: "tool_call", tool_name: "artifact_read" });
    repair({ kind: "tool_call", tool_name: "artifact_read" });
    const beforeTool = checkpointer.events(runId);
    expect(() => repair({ kind: "tool_call", tool_name: "artifact_read" })).toThrowError(
      new LivenessExhaustedError("tool_call_budget_exhausted")
    );
    expect(checkpointer.events(runId)).toEqual(beforeTool);
    expect(liveness.workerPromptBudget(runId, "repair")).toHaveProperty("inactivity_lease");
    liveness.endWorker(runId, "repair", "complete");
    liveness.startWorker({ ...attempt, purpose: "phase", workerId: "ordinary" });
    const ordinary = liveness.sessionSink({ runId, workerId: "ordinary", stateId: "planning" });
    for (let index = 0; index < 8; index += 1) {
      ordinary({ kind: "model_turn", source: "turn_start" });
      ordinary({ kind: "tool_call", tool_name: "web_fetch" });
      expect(
        liveness.chargeMalformed({
          runId,
          stateId: "planning",
          branchId: null,
          digest: "a".repeat(64),
        })
      ).toBeNull();
    }
    expect(liveness.snapshot(runId)).toMatchObject({
      model_turns: 9,
      tool_calls: 10,
      external_calls: 8,
      malformed_results: 8,
    });
    checkpointer.close();
  });

  it("retains explicit protocol-error and repeated-error limits under the current policy", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 0);
    for (const identical of [false, true]) {
      const runId = identical ? "identical-protocol-limit" : "protocol-count-limit";
      liveness.setPolicyResolver(() => ({
        ...researchLivenessPolicy("quick"),
        protocol_errors_per_worker: identical ? null : 2,
        identical_protocol_digest_limit: identical ? 2 : null,
      }));
      start(engine, root, runId);
      liveness.startWorker({
        runId,
        workerId: runId,
        stateId: "planning",
        branchId: null,
        purpose: "phase",
      });
      const sink = liveness.sessionSink({ runId, workerId: runId, stateId: "planning" });
      const event = {
        kind: "protocol_error",
        tool_name: "read_phase_brief",
        error_code: "schema_invalid",
      } as const;
      sink(event);
      expect(() => sink(event)).toThrowError(
        new LivenessExhaustedError(
          identical ? "identical_error_stall" : "protocol_error_budget_exhausted"
        )
      );
      expect(new LivenessController(checkpointer, () => 0).snapshot(runId).protocol_errors).toBe(2);
    }
    checkpointer.close();
  });

  it("enforces an explicit malformed policy and retains it across restart", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 10_000);
    liveness.setPolicyResolver(() => ({
      ...researchLivenessPolicy("quick"),
      malformed_results_per_state_branch: 5,
    }));
    start(engine, root, "operator-v3-limit");
    const recovered = new LivenessController(checkpointer, () => 10_000);
    for (let index = 0; index < 5; index += 1) {
      expect(
        recovered.chargeMalformed({
          runId: "operator-v3-limit",
          stateId: "researching",
          branchId: null,
          digest: "a".repeat(64),
        })
      ).toBe(index === 4 ? "malformed_result_budget_exhausted" : null);
    }
    expect(recovered.policy("operator-v3-limit")).toMatchObject({
      schema_version: 3,
      malformed_results_per_state_branch: 5,
    });
    checkpointer.close();
  });

  it("enforces explicit current malformed and identical-error controls", () => {
    const root = temporaryDirectory();
    const { checkpointer, liveness, engine } = runtime(root, () => 10_000);
    liveness.setPolicyResolver(() => ({
      ...researchLivenessPolicy("quick"),
      malformed_results_per_state_branch: 2,
      identical_malformed_digest_limit: 2,
    }));
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
