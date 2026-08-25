import { requireValue } from "./helpers/narrowing.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { CheckpointIdentityError, Checkpointer, sha256 } from "../src/checkpointer.js";
import type { JsonValue, RunIdentity } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";

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
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
} {
  const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
  return {
    checkpointer,
    engine: new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
    }),
  };
}

class FakeResearchClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const result: Record<string, AgentCompletion> = {
      planning: {
        text: "plan",
        confidence: "CERTAIN",
        details: {
          plan_steps: ["first sub-query", "second sub-query"],
          plan_complete: true,
          mode: "standard",
        },
      },
      researching: {
        text: `findings for ${invocation.task}`,
        confidence: "PROBABLE",
        details: { explore_complete: true },
      },
      synthesizing: {
        text: "complete cited synthesis",
        confidence: "PROBABLE",
        details: { synthesis_complete: true },
      },
      validating: {
        text: "grounding verdict",
        confidence: "CERTAIN",
        details: {
          verdict: "PASS",
          unsupported_claims: [],
          evidence: [{ claim: "c1", source: "s1" }],
        },
      },
      report_writing: {
        text: "# report.md\nReport\n# sources.md\nSources\n# README.md\nReadme",
        confidence: "CERTAIN",
        details: { write_complete: true },
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
    const { checkpointer, engine } = runtime(root);
    const client = new FakeResearchClient();
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
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
    expect(terminal.artifacts).toHaveLength(1);
    expect(
      artifacts
        .read(
          requireValue(terminal.artifacts[0], "apps/orchestration/tests/core-runtime.test.ts:140"),
          "state:complete"
        )
        .toString("utf8")
    ).toContain("# report.md");
    expect(client.invocations.map((call) => call.stateId)).toEqual([
      "researching",
      "synthesizing",
      "validating",
      "report_writing",
    ]);
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
    const { checkpointer, engine } = runtime(root);
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const workers = new WorkerExecutor(new FakeResearchClient(), artifacts, {
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
    const { checkpointer, engine } = runtime(root);
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const workers = new WorkerExecutor(new FakeResearchClient(), artifacts, {
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
    const reissued = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: { ...first, details: {} },
    });
    expect(reissued.action).toBe("invoke_agents_parallel");
    if (reissued.action !== "invoke_agents_parallel") {
      throw new Error("expected bounded malformed branch reissue");
    }
    expect(reissued.branches.map((branch) => branch.branch_id)).toEqual([
      second.branch_id,
      first.branch_id,
    ]);
    const retryAssignment = reissued.branches.find(
      (branch) => branch.branch_id === first.branch_id
    );
    expect(retryAssignment?.attempt).toBe(first.attempt + 1);
    expect(retryAssignment?.output_artifact.version).toBe(2);
    expect(retryAssignment?.output_artifact.parent_ref?.artifact_id).toBe(
      first.output_artifact.artifact_id
    );

    const retryOnly = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: second,
    });
    expect(retryOnly.action).toBe("invoke_agents_parallel");
    if (retryOnly.action !== "invoke_agents_parallel") {
      throw new Error("expected only the malformed branch to remain");
    }
    expect(retryOnly.branches.map((branch) => branch.branch_id)).toEqual([first.branch_id]);
    const synthesis = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: requireValue(
        (await workers.execute(retryOnly))[0],
        "apps/orchestration/tests/core-runtime.test.ts:313"
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
    checkpointer.close();
  });

  it("uses a challenge-bound user gate and rejects tampering without mutation", async () => {
    const root = temporaryDirectory();
    const { checkpointer, engine } = runtime(root);
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const workers = new WorkerExecutor(new FakeResearchClient(), artifacts, {
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
    const { checkpointer, engine } = runtime(root);
    const client = new FakeResearchClient();
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
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
    const { checkpointer, engine } = runtime(root);
    const client = new FakeResearchClient();
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
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
