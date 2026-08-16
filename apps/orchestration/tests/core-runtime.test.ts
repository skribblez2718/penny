import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { CheckpointIdentityError, Checkpointer, sha256 } from "../src/checkpointer.js";
import type {
  Confidence,
  Directive,
  JsonValue,
  PhaseResult,
  RunIdentity,
} from "../src/contracts.js";
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

function phaseResult(input: {
  identity: RunIdentity;
  stateId: string;
  agent: string;
  attempt: number;
  details: Record<string, JsonValue>;
  confidence?: Confidence;
  branchId?: string;
  receiptId?: string;
}): PhaseResult {
  const receiptId =
    input.receiptId ??
    `receipt_${sha256(
      `${input.identity.run_id}/${input.stateId}/${input.branchId ?? "single"}/${input.agent}/${input.attempt}`
    )}`;
  return {
    schema_version: 2,
    run_id: input.identity.run_id,
    state_id: input.stateId,
    agent: input.agent,
    attempt: input.attempt,
    ...(input.branchId ? { branch_id: input.branchId } : {}),
    confidence: input.confidence ?? "CERTAIN",
    details: input.details,
    worker_receipt: {
      schema_version: 2,
      receipt_id: receiptId,
      run_id: input.identity.run_id,
      state_id: input.stateId,
      agent: input.agent,
      attempt: input.attempt,
      worker_id: `worker-${receiptId.slice(-12)}`,
      started_at: "2026-08-16T00:00:00.000Z",
      ended_at: "2026-08-16T00:00:01.000Z",
      exit_code: 0,
      output_digest: sha256(receiptId),
    },
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
    expect(artifacts.read(terminal.artifacts[0]!, "agent:synthia").toString("utf8")).toContain(
      "# report.md"
    );
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

  it("enforces parallel branch provenance and exact-once receipt replay", () => {
    const root = temporaryDirectory();
    const { checkpointer, engine } = runtime(root);
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
      result: phaseResult({
        identity: runIdentity,
        stateId: planning.state_id,
        agent: planning.agent,
        attempt: planning.attempt,
        details: {
          plan_steps: ["one", "two"],
          plan_complete: true,
        },
      }),
    });
    expect(fan.action).toBe("invoke_agents_parallel");
    if (fan.action !== "invoke_agents_parallel") {
      throw new Error("expected parallel directive");
    }
    const first = fan.branches[0]!;
    const wrongAgent = phaseResult({
      identity: runIdentity,
      stateId: first.state_id,
      agent: "synthia",
      attempt: first.attempt,
      branchId: first.branch_id,
      details: { explore_complete: true },
    });
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: wrongAgent,
      })
    ).toThrow("wrong_agent");

    const accepted = phaseResult({
      identity: runIdentity,
      stateId: first.state_id,
      agent: first.agent,
      attempt: first.attempt,
      branchId: first.branch_id,
      details: { explore_complete: true },
    });
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

  it("uses a challenge-bound user gate and rejects tampering without mutation", () => {
    const root = temporaryDirectory();
    const { checkpointer, engine } = runtime(root);
    const runIdentity = identity("gate-run");
    const research = engine.handle(startRequest(root, runIdentity));
    if (research.action !== "invoke_agent") {
      throw new Error("expected research directive");
    }
    const gate = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: phaseResult({
        identity: runIdentity,
        stateId: research.state_id,
        agent: research.agent,
        attempt: research.attempt,
        confidence: "UNCERTAIN",
        details: { explore_complete: true },
      }),
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
