import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { canonicalJson, Checkpointer } from "../src/checkpointer.js";
import type { RunIdentity } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import {
  OrchestrationRunner,
  WorkerExecutor,
  type OrchestrationProgressEvent,
} from "../src/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const CANCELLATION_GRACE_MS = 5_000;
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "penny-cancel-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identity(): RunIdentity {
  return {
    schema_version: 2,
    run_id: "cancel-fan-run",
    session_id: "cancel-session",
    playbook: "research",
    engine_owner: "typescript",
  };
}

class CancellableResearchClient implements ModelClient {
  readonly states: string[] = [];
  private releaseSecondStart: (() => void) | undefined;
  readonly secondStarted = new Promise<void>((resolve) => {
    this.releaseSecondStart = resolve;
  });

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.states.push(invocation.stateId);
    if (invocation.stateId === "planning") {
      return {
        text: 'plan\nSUMMARY:{"confidence":"CERTAIN","plan_steps":["first sub-query","second sub-query"],"plan_complete":true,"mode":"standard"}',
        confidence: "CERTAIN",
        details: {
          plan_steps: ["first sub-query", "second sub-query"],
          plan_complete: true,
          mode: "standard",
        },
      };
    }
    if (invocation.stateId === "researching" && invocation.task.includes("first sub-query")) {
      return {
        text: 'first complete finding\nSUMMARY:{"confidence":"PROBABLE","explore_complete":true}',
        confidence: "PROBABLE",
        details: { explore_complete: true },
      };
    }
    if (invocation.stateId === "researching" && invocation.task.includes("second sub-query")) {
      this.releaseSecondStart?.();
      await new Promise<void>((_resolve, reject) => {
        const rejectAbort = (): void => reject(new Error("synthetic cooperative abort"));
        if (invocation.signal?.aborted) rejectAbort();
        else invocation.signal?.addEventListener("abort", rejectAbort, { once: true });
      });
      throw new Error("unreachable synthetic branch");
    }
    throw new Error(`unexpected post-cancel dispatch to ${invocation.stateId}`);
  }
}

class GraceExpiryResearchClient implements ModelClient {
  readonly states: string[] = [];
  private releaseDelayed: (() => void) | undefined;
  private releaseNeverStart: (() => void) | undefined;
  private readonly delayed = new Promise<void>((resolve) => {
    this.releaseDelayed = resolve;
  });
  readonly neverStarted = new Promise<void>((resolve) => {
    this.releaseNeverStart = resolve;
  });

  releaseDelayedBranch(): void {
    const release = this.releaseDelayed;
    if (release === undefined) throw new Error("delayed branch was already released");
    this.releaseDelayed = undefined;
    release();
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.states.push(invocation.stateId);
    if (invocation.stateId === "planning") {
      return {
        text: 'three-branch plan\nSUMMARY:{"confidence":"CERTAIN","plan_steps":["delayed first","fast second","never third"],"plan_complete":true,"mode":"standard"}',
        confidence: "CERTAIN",
        details: {
          plan_steps: ["delayed first", "fast second", "never third"],
          plan_complete: true,
          mode: "standard",
        },
      };
    }
    if (invocation.stateId === "researching" && invocation.task.includes("delayed first")) {
      await this.delayed;
      return {
        text: 'first branch completed second\nSUMMARY:{"confidence":"PROBABLE","explore_complete":true}',
        confidence: "PROBABLE",
        details: { explore_complete: true },
      };
    }
    if (invocation.stateId === "researching" && invocation.task.includes("fast second")) {
      return {
        text: 'second branch completed first\nSUMMARY:{"confidence":"PROBABLE","explore_complete":true}',
        confidence: "PROBABLE",
        details: { explore_complete: true },
      };
    }
    if (invocation.stateId === "researching" && invocation.task.includes("never third")) {
      this.releaseNeverStart?.();
      this.releaseNeverStart = undefined;
      await new Promise<void>(() => undefined);
      throw new Error("unreachable never-settling branch");
    }
    throw new Error(`unexpected post-cancel dispatch to ${invocation.stateId}`);
  }
}

class ObservedArtifactStore extends ArtifactStore {
  readonly persistedResearchBranches: string[] = [];
  private releaseFirstPersisted: (() => void) | undefined;
  private releaseSecondPersisted: (() => void) | undefined;
  readonly firstPersisted = new Promise<void>((resolve) => {
    this.releaseFirstPersisted = resolve;
  });
  readonly secondPersisted = new Promise<void>((resolve) => {
    this.releaseSecondPersisted = resolve;
  });

  override persist(
    input: Parameters<ArtifactStore["persist"]>[0]
  ): ReturnType<ArtifactStore["persist"]> {
    const ref = super.persist(input);
    if (ref.phase !== "researching" || ref.branch_id === null) return ref;
    this.persistedResearchBranches.push(ref.branch_id);
    if (ref.branch_id === "sq1") {
      this.releaseFirstPersisted?.();
      this.releaseFirstPersisted = undefined;
    }
    if (ref.branch_id === "sq2") {
      this.releaseSecondPersisted?.();
      this.releaseSecondPersisted = undefined;
    }
    return ref;
  }
}

describe("cooperative worker cancellation", () => {
  it("accepts completed siblings, stops dispatch, and returns path-free exact partials", async () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactRevisions: artifacts,
    });
    const client = new CancellableResearchClient();
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: root,
      parallelConcurrency: 2,
    });
    const runner = new OrchestrationRunner(engine, workers);
    const runIdentity = identity();
    const initial = engine.handle({
      schema_version: 2,
      action: "start",
      identity: runIdentity,
      goal: "Synthetic cancellation fixture",
      constraints: { mode: "standard" },
      project_root: root,
      trust_profile: "trusted-interactive",
    });
    const controller = new AbortController();
    const running = runner.runUntilBoundary(initial, controller.signal);
    await client.secondStarted;
    controller.abort("test cancellation");
    const terminal = await running;

    expect(terminal.action).toBe("cancelled");
    if (terminal.action !== "cancelled") throw new Error("expected cancelled terminal");
    expect(terminal.status).toBe("cancelled");
    expect(terminal.met).toBe(false);
    const partials = terminal.result.best_partial_artifact_refs;
    expect(Array.isArray(partials)).toBe(true);
    if (!Array.isArray(partials)) throw new Error("expected partial refs");
    expect(partials).toHaveLength(1);
    expect(terminal.result.output_artifact_ref).toEqual(partials[0]);
    expect(terminal.artifacts).toContainEqual(partials[0]);
    expect(terminal.result).not.toHaveProperty("report_dir");
    expect(terminal.result).not.toHaveProperty("report_files");
    expect(canonicalJson(terminal)).not.toContain(root);
    expect(client.states).not.toContain("synthesizing");

    const replayStatus = engine.handle({
      schema_version: 2,
      action: "status",
      identity: runIdentity,
    });
    const replayRecover = engine.handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    const replayCancel = engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: runIdentity,
    });
    expect(canonicalJson(replayStatus)).toBe(canonicalJson(terminal));
    expect(canonicalJson(replayRecover)).toBe(canonicalJson(terminal));
    expect(canonicalJson(replayCancel)).toBe(canonicalJson(terminal));
    expect(engine.liveness.snapshot(runIdentity.run_id).open_workers).toBe(0);

    artifacts.close();
    checkpointer.close();
  });

  it("closes progress at a cancelled boundary even if a non-cooperative worker settles later", async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const artifacts = new ObservedArtifactStore(path.join(root, "artifacts"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactRevisions: artifacts,
    });
    const client = new GraceExpiryResearchClient();
    const runner = new OrchestrationRunner(
      engine,
      new WorkerExecutor(client, artifacts, {
        projectRoot: root,
        parallelConcurrency: 3,
      })
    );
    const runIdentity = identity();
    const progress: OrchestrationProgressEvent[] = [];
    const controller = new AbortController();
    const running = runner.runUntilBoundary(
      engine.handle({
        schema_version: 2,
        action: "start",
        identity: runIdentity,
        goal: "Synthetic late-settlement progress fixture",
        constraints: { mode: "standard" },
        project_root: root,
        trust_profile: "trusted-interactive",
      }),
      controller.signal,
      (event) => progress.push(event)
    );

    await client.neverStarted;
    await artifacts.secondPersisted;
    controller.abort("test late settlement");
    await vi.advanceTimersByTimeAsync(CANCELLATION_GRACE_MS);
    const terminal = await running;
    expect(terminal.action).toBe("cancelled");
    expect(progress.at(-1)).toMatchObject({
      event: "boundary_reached",
      action: "cancelled",
    });
    const countAtTerminal = progress.length;

    client.releaseDelayedBranch();
    await artifacts.firstPersisted;
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveLength(countAtTerminal);
    expect(progress.at(-1)).toMatchObject({
      event: "boundary_reached",
      action: "cancelled",
    });

    artifacts.close();
    checkpointer.close();
  });

  it("accepts stable completed fan results before cancellation when grace expires", async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const artifacts = new ObservedArtifactStore(path.join(root, "artifacts"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactRevisions: artifacts,
    });
    const client = new GraceExpiryResearchClient();
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: root,
      parallelConcurrency: 3,
    });
    const runner = new OrchestrationRunner(engine, workers);
    const runIdentity = identity();
    const initial = engine.handle({
      schema_version: 2,
      action: "start",
      identity: runIdentity,
      goal: "Synthetic grace-expiry cancellation fixture",
      constraints: { mode: "standard" },
      project_root: root,
      trust_profile: "trusted-interactive",
    });
    const controller = new AbortController();
    const running = runner.runUntilBoundary(initial, controller.signal);

    await client.neverStarted;
    await artifacts.secondPersisted;
    client.releaseDelayedBranch();
    await artifacts.firstPersisted;
    controller.abort("test grace expiry");
    await vi.advanceTimersByTimeAsync(CANCELLATION_GRACE_MS);
    const terminal = await running;

    expect(terminal.action).toBe("cancelled");
    if (terminal.action !== "cancelled") throw new Error("expected cancelled terminal");
    expect(artifacts.persistedResearchBranches).toEqual(["sq2", "sq1"]);

    const first = artifacts.selected(runIdentity.run_id, "researching", "sq1");
    const second = artifacts.selected(runIdentity.run_id, "researching", "sq2");
    if (first === undefined || second === undefined) {
      throw new Error("completed research branches were not durably selected");
    }
    expect(terminal.result.best_partial_artifact_refs).toEqual([first, second]);
    expect(terminal.result.output_artifact_ref).toBeNull();
    expect(terminal.artifacts).toEqual([first, second]);

    const events = checkpointer.events(runIdentity.run_id);
    const accepted = events.filter(
      (event) =>
        event.eventType === "phase_result_accepted" && event.payload.state_id === "researching"
    );
    expect(accepted.map((event) => event.payload.branch_id)).toEqual(["sq1", "sq2"]);
    const lastAccepted = accepted.at(-1);
    const cancelled = events.find((event) => event.eventType === "run_cancelled");
    if (lastAccepted === undefined || cancelled === undefined) {
      throw new Error("acceptance and cancellation events were not durably recorded");
    }
    expect(lastAccepted.sequence).toBeLessThan(cancelled.sequence);
    expect(client.states).not.toContain("synthesizing");
    expect(engine.liveness.snapshot(runIdentity.run_id).open_workers).toBe(0);

    artifacts.close();
    checkpointer.close();
  });
});
