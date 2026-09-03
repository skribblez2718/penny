import { requireValue } from "./helpers/narrowing.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { CheckpointIdentityError, Checkpointer, sha256 } from "../src/checkpointer.js";
import type { JsonValue, RunIdentity } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import {
  OrchestrationRunner,
  WorkerExecutor,
  type OrchestrationProgressEvent,
} from "../src/worker.js";
import { researchSemanticDraftFixture } from "./helpers/research-semantic-draft.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "penny-orch-core-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identity(runId = "run-001"): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: "session-001",
    playbook: "research",
    engine_owner: "typescript",
  };
}

function startRequest(
  root: string,
  runIdentity: RunIdentity,
  constraints: Record<string, JsonValue> = { mode: "quick" },
  goal = "Research the sentinel topic"
): unknown {
  return {
    schema_version: 2,
    action: "start",
    identity: runIdentity,
    goal,
    constraints,
    project_root: root,
    trust_profile: "trusted-interactive",
  };
}

function runtime(root: string): {
  artifacts: ArtifactStore;
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
} {
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
  return {
    artifacts,
    checkpointer,
    engine: new OrchestrationEngine(checkpointer, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot: root,
      maxSteps: 96,
      artifactRevisions: artifacts,
      artifactStore: artifacts,
      artifactReader: artifacts,
    }),
  };
}

class FakeResearchClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];

  constructor(private readonly artifacts: ArtifactStore) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    if (invocation.task.startsWith("Repair routing metadata only.")) {
      return {
        text: 'SUMMARY:{"explore_complete":true,"confidence":"PROBABLE"}',
        confidence: "PROBABLE",
        details: { explore_complete: true },
      };
    }
    if (invocation.stateId === "synthesizing") {
      const draft = researchSemanticDraftFixture(invocation, this.artifacts, {
        title: "Core runtime synthesis",
        executiveSummary: "The runtime produced a grounded semantic core.",
        claimStatement: "The runtime fixture is grounded.",
        sectionBody: "The runtime finding is grounded.",
      });
      return {
        text: `${JSON.stringify(draft)}\nSUMMARY:{"confidence":"PROBABLE","synthesis_complete":true}`,
        confidence: "PROBABLE",
        details: { synthesis_complete: true },
      };
    }
    const result: Record<string, AgentCompletion> = {
      planning: {
        text: 'plan\nSUMMARY:{"confidence":"CERTAIN","plan_steps":["first sub-query","second sub-query"],"plan_complete":true,"mode":"standard"}',
        confidence: "CERTAIN",
        details: {
          plan_steps: ["first sub-query", "second sub-query"],
          plan_complete: true,
          mode: "standard",
        },
      },
      researching: {
        text: `findings for ${invocation.task}\nSUMMARY:{"confidence":"PROBABLE","explore_complete":true}`,
        confidence: "PROBABLE",
        details: { explore_complete: true },
      },
      validating: {
        text: 'grounding verdict\nSUMMARY:{"confidence":"CERTAIN","verdict":"PASS","unsupported_claims":[],"evidence":[{"claim":"c1","source":"s1"}]}',
        confidence: "CERTAIN",
        details: {
          verdict: "PASS",
          unsupported_claims: [],
          evidence: [{ claim: "c1", source: "s1" }],
        },
      },
    };
    const completion = result[invocation.stateId];
    if (completion === undefined) {
      throw new Error(`no fake completion for ${invocation.stateId}`);
    }
    return completion;
  }
}

describe("durable orchestration runtime", () => {
  it("runs a quick research workflow to grounded complete with exact artifacts", async () => {
    const root = temporaryDirectory();
    const { artifacts, checkpointer, engine } = runtime(root);
    const client = new FakeResearchClient(artifacts);
    const runner = new OrchestrationRunner(
      engine,
      new WorkerExecutor(client, artifacts, {
        projectRoot: root,
        parallelConcurrency: 2,
      })
    );
    const initial = engine.handle(startRequest(root, identity()));
    const terminal = await runner.runUntilBoundary(initial);

    expect(terminal.action).toBe("complete");
    if (terminal.action !== "complete") {
      throw new Error("expected terminal complete directive");
    }
    expect(terminal.met).toBe(true);
    expect(terminal.status).toBe("complete");
    expect(terminal.result.grounded).toBe(true);
    expect(terminal.artifacts).toHaveLength(7);
    const core = terminal.artifacts.find((artifact) => artifact.kind === "semantic-core");
    expect(core).toBeDefined();
    expect(
      artifacts
        .read(
          requireValue(core, "apps/orchestration/tests/core-runtime.test.ts:semantic-core"),
          "state:complete"
        )
        .toString("utf8")
    ).toContain("penny.grounded-synthesis.v1");
    expect(client.invocations.map((call) => call.stateId)).toEqual([
      "researching",
      "synthesizing",
      "validating",
    ]);
    const envelope = checkpointer.completionAdmission(identity().run_id);
    expect(envelope).toMatchObject({
      origin_state: "rendering",
      latest_product: {
        selector: "terminal_artifact",
        product_id: core?.artifact_id,
        sha256: core?.content_digest,
      },
    });
    expect(envelope?.evidence_refs).toHaveLength(1);
    expect(envelope?.evidence_refs[0]?.kind).toBe("execution_receipt");
    expect(envelope?.evidence_refs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope?.state_visit_refs.map((visit) => visit.state_id)).toEqual([
      "intake",
      "researching",
      "synthesizing",
      "sealing_core",
      "validating",
      "rendering",
    ]);
    checkpointer.close();
  });

  it("emits content-free progress for every shared runner phase and terminal boundary", async () => {
    const root = temporaryDirectory();
    const { artifacts, checkpointer, engine } = runtime(root);
    const client = new FakeResearchClient(artifacts);
    const runner = new OrchestrationRunner(
      engine,
      new WorkerExecutor(client, artifacts, {
        projectRoot: root,
        parallelConcurrency: 2,
      })
    );
    const progress: OrchestrationProgressEvent[] = [];
    const runIdentity = identity("progress-run");

    const terminal = await runner.runUntilBoundary(
      engine.handle(startRequest(root, runIdentity)),
      undefined,
      (event) => progress.push(event)
    );

    expect(terminal.action).toBe("complete");
    expect(
      progress.map((event) =>
        event.event === "boundary_reached"
          ? `${event.event}:${event.action}`
          : `${event.event}:${event.state_id}`
      )
    ).toEqual([
      "phase_started:researching",
      "worker_completed:researching",
      "phase_started:synthesizing",
      "worker_completed:synthesizing",
      "phase_started:validating",
      "worker_completed:validating",
      "boundary_reached:complete",
    ]);
    expect(progress[0]).toMatchObject({
      event: "phase_started",
      run_id: runIdentity.run_id,
      playbook: "research",
      state_id: "researching",
      workers: [
        {
          state_id: "researching",
          agent: "echo",
          attempt: 1,
          branch_id: null,
          execution_purpose: "phase",
        },
      ],
    });
    expect(JSON.stringify(progress)).not.toContain("Research the sentinel topic");
    checkpointer.close();
  });

  it("reports parallel branch starts and each completed worker through the same progress seam", async () => {
    const root = temporaryDirectory();
    const { artifacts, checkpointer, engine } = runtime(root);
    const runner = new OrchestrationRunner(
      engine,
      new WorkerExecutor(new FakeResearchClient(artifacts), artifacts, {
        projectRoot: root,
        parallelConcurrency: 2,
      })
    );
    const progress: OrchestrationProgressEvent[] = [];
    const runIdentity = identity("parallel-progress-run");

    const terminal = await runner.runUntilBoundary(
      engine.handle(startRequest(root, runIdentity, { mode: "standard" })),
      undefined,
      (event) => progress.push(event)
    );

    expect(terminal.action).toBe("complete");
    const branchStart = progress.find(
      (event) => event.event === "phase_started" && event.state_id === "researching"
    );
    expect(branchStart).toMatchObject({
      event: "phase_started",
      state_id: "researching",
      workers: [
        { agent: "echo", branch_id: "sq1" },
        { agent: "echo", branch_id: "sq2" },
      ],
    });
    const branchCompletions = progress.filter(
      (event) => event.event === "worker_completed" && event.state_id === "researching"
    );
    expect(branchCompletions).toHaveLength(2);
    expect(
      branchCompletions.map((event) =>
        event.event === "worker_completed" ? event.completed_workers : 0
      )
    ).toEqual([1, 2]);
    checkpointer.close();
  });

  it("preserves immutable identity and rejects start collisions without mutation", () => {
    const root = temporaryDirectory();
    const { checkpointer, engine } = runtime(root);
    const originalIdentity = identity("collision-run");
    const initial = engine.handle(startRequest(root, originalIdentity));
    expect(() =>
      engine.handle(
        startRequest(root, {
          ...originalIdentity,
          session_id: "different-session",
        })
      )
    ).toThrow(CheckpointIdentityError);
    expect(
      engine.handle({
        schema_version: 2,
        action: "recover",
        identity: originalIdentity,
      })
    ).toEqual(initial);
    checkpointer.close();
  });

  it("recovers the exact pending directive after a process restart", () => {
    const root = temporaryDirectory();
    const runIdentity = identity("restart-run");
    const first = runtime(root);
    const initial = first.engine.handle(startRequest(root, runIdentity));
    first.checkpointer.close();

    const second = runtime(root);
    expect(
      second.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      })
    ).toEqual(initial);
    second.checkpointer.close();
  });

  it("enforces parallel branch provenance and exact-once receipt replay", async () => {
    const root = temporaryDirectory();
    const { artifacts, checkpointer, engine } = runtime(root);
    const workers = new WorkerExecutor(new FakeResearchClient(artifacts), artifacts, {
      projectRoot: root,
      parallelConcurrency: 2,
    });
    workers.setReceiptAuthority(engine.receiptAuthority);
    const runIdentity = identity("parallel-run");
    const planning = engine.handle(startRequest(root, runIdentity, { mode: "standard" }));
    expect(planning.action).toBe("invoke_agent");
    if (planning.action !== "invoke_agent") {
      throw new Error("expected planning directive");
    }
    const fan = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: requireValue(
        (await workers.execute(planning))[0],
        "apps/orchestration/tests/core-runtime.test.ts:212"
      ),
    });
    expect(fan.action).toBe("invoke_agents_parallel");
    if (fan.action !== "invoke_agents_parallel") {
      throw new Error("expected parallel directive");
    }
    const branchResults = await workers.execute(fan);
    const accepted = requireValue(
      branchResults[0],
      "apps/orchestration/tests/core-runtime.test.ts:219"
    );
    const wrongAgent = { ...accepted, agent: "synthia" };
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: wrongAgent,
      })
    ).toThrow();

    expect(
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: accepted,
      }).action
    ).toBe("invoke_agents_parallel");
    expect(
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: accepted,
      }).action
    ).toBe("invoke_agents_parallel");
    checkpointer.close();
  });

  it("reissues only a malformed fan branch while accepting completed sibling work", async () => {
    const root = temporaryDirectory();
    const { artifacts, checkpointer, engine } = runtime(root);
    const workers = new WorkerExecutor(new FakeResearchClient(artifacts), artifacts, {
      projectRoot: root,
      parallelConcurrency: 2,
    });
    workers.setReceiptAuthority(engine.receiptAuthority);
    const runIdentity = identity("malformed-fan-run");
    const planning = engine.handle(startRequest(root, runIdentity, { mode: "standard" }));
    if (planning.action !== "invoke_agent") {
      throw new Error("expected planning directive");
    }
    const fan = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: requireValue(
        (await workers.execute(planning))[0],
        "apps/orchestration/tests/core-runtime.test.ts:267"
      ),
    });
    if (fan.action !== "invoke_agents_parallel") {
      throw new Error("expected research fan");
    }
    const original = await workers.execute(fan);
    const first = requireValue(original[0], "apps/orchestration/tests/core-runtime.test.ts:273");
    const second = requireValue(original[1], "apps/orchestration/tests/core-runtime.test.ts:274");
    const reissued = engine.acceptWorkerResults(runIdentity, [{ ...first, details: {} }, second]);
    expect(reissued.action).toBe("invoke_agent");
    if (reissued.action !== "invoke_agent") {
      throw new Error("expected bounded routing-only repair");
    }
    expect(reissued.execution_purpose).toBe("routing_repair");
    expect(reissued.agent).toBe(first.agent);
    expect(reissued.input_artifacts.artifacts).toEqual([
      { slot: "malformed-source", ref: first.output_artifact },
    ]);
    expect(reissued.output_artifact.kind).toBe("routing-metadata");
    expect(reissued.routing_repair_binding?.source_receipt_id).toBe(
      first.worker_receipt.receipt_id
    );

    const synthesis = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: requireValue(
        (await workers.execute(reissued))[0],
        "apps/orchestration/tests/core-runtime.test.ts:routing-repair"
      ),
    });
    expect(synthesis.action).toBe("invoke_agent");
    if (synthesis.action === "invoke_agent") {
      expect(synthesis.state_id).toBe("synthesizing");
    }
    expect(
      checkpointer
        .events(runIdentity.run_id)
        .filter((event) => event.eventType === "phase_result_malformed")
    ).toHaveLength(1);
    expect(
      checkpointer
        .events(runIdentity.run_id)
        .filter((event) => event.eventType === "routing_repair_accepted")
    ).toHaveLength(1);
    expect(
      checkpointer
        .loadRun(runIdentity)
        .selectedArtifacts.some((artifact) => artifact.kind === "routing-metadata")
    ).toBe(false);
    checkpointer.close();
  });

  it("uses a challenge-bound user gate and rejects tampering without mutation", async () => {
    const root = temporaryDirectory();
    const { artifacts, checkpointer, engine } = runtime(root);
    const workers = new WorkerExecutor(new FakeResearchClient(artifacts), artifacts, {
      projectRoot: root,
      parallelConcurrency: 1,
    });
    workers.setReceiptAuthority(engine.receiptAuthority);
    const runIdentity = identity("gate-run");
    const research = engine.handle(startRequest(root, runIdentity));
    if (research.action !== "invoke_agent") {
      throw new Error("expected research directive");
    }
    const researchResult = requireValue(
      (await workers.execute(research))[0],
      "apps/orchestration/tests/core-runtime.test.ts:341"
    );
    const gate = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: { ...researchResult, confidence: "UNCERTAIN" },
    });
    if (gate.action !== "await_user") {
      throw new Error("expected user gate");
    }
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "respond",
        identity: runIdentity,
        gate_id: gate.gate_id,
        challenge: "tampered-challenge",
        response: "narrow the scope",
      })
    ).toThrow("challenge mismatch");
    expect(
      engine.handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      })
    ).toEqual(gate);
    expect(
      engine.handle({
        schema_version: 2,
        action: "respond",
        identity: runIdentity,
        gate_id: gate.gate_id,
        challenge: gate.challenge,
        response: "narrow the scope",
      }).action
    ).toBe("invoke_agent");
    checkpointer.close();
  });

  it("keeps raw goals out of event telemetry and public results", async () => {
    const root = temporaryDirectory();
    const { artifacts, checkpointer, engine } = runtime(root);
    const client = new FakeResearchClient(artifacts);
    const sentinel = "PRIVATE_GOAL_SENTINEL_81f3b6";
    const runIdentity = identity("privacy-run");
    const terminal = await new OrchestrationRunner(
      engine,
      new WorkerExecutor(client, artifacts, {
        projectRoot: root,
        parallelConcurrency: 2,
      })
    ).runUntilBoundary(engine.handle(startRequest(root, runIdentity, { mode: "quick" }, sentinel)));
    expect(JSON.stringify(checkpointer.events(runIdentity.run_id))).not.toContain(sentinel);
    expect(JSON.stringify(terminal)).not.toContain(sentinel);
    expect(JSON.stringify(terminal)).toContain(sha256(sentinel));
    checkpointer.close();
  });

  it("propagates the validation model override and trust profile to workers", async () => {
    const root = temporaryDirectory();
    const { artifacts, checkpointer, engine } = runtime(root);
    const client = new FakeResearchClient(artifacts);
    const runIdentity = identity("override-run");
    await new OrchestrationRunner(
      engine,
      new WorkerExecutor(client, artifacts, {
        projectRoot: root,
        parallelConcurrency: 2,
      })
    ).runUntilBoundary(
      engine.handle(
        startRequest(root, runIdentity, {
          mode: "quick",
          validate_model: "provider/verifier-model",
        })
      )
    );
    const validation = client.invocations.find((invocation) => invocation.stateId === "validating");
    expect(validation?.modelOverride).toBe("provider/verifier-model");
    expect(validation?.trustProfile).toBe("trusted-interactive");
    checkpointer.close();
  });
});
