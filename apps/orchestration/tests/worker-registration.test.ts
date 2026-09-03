import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer } from "../src/checkpointer.js";
import type { Directive } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import {
  PiAgentClient,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
} from "../src/model-client.js";
import {
  DECIDE_CANDIDATE_REGISTRATION,
  DECIDE_UNSEALED_EVALUATION_REGISTRATION,
} from "../src/playbooks/decide.js";
import { resolvePlaybook } from "../src/playbooks/registry.js";
import { WorkerExecutor } from "../src/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-worker-registration-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function researchDirective(input: {
  runId: string;
  agent?: string;
  playbook?: string;
  stateId?: string;
}): Extract<Directive, { action: "invoke_agent" }> {
  const agent = input.agent ?? "piper";
  const playbook = input.playbook ?? "research";
  const stateId = input.stateId ?? "planning";
  return {
    schema_version: 2,
    action: "invoke_agent",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: `session-${input.runId}`,
      playbook,
      engine_owner: "typescript",
    },
    state_id: stateId,
    agent,
    attempt: 1,
    trust_profile: "hardened-untrusted",
    task: "Exercise active worker registration.",
    input_artifacts: { schema_version: 2, artifacts: [] },
    output_artifact: {
      schema_version: 2,
      run_id: input.runId,
      phase: stateId,
      branch_id: null,
      kind: "agent-output",
      operation_id: `operation-${input.runId}`,
      version: 1,
      producer: `agent:${agent}`,
      media_type: "text/plain; charset=utf-8",
      parent_ref: null,
      upstream_refs: [],
    },
  };
}

class CapturingClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  readonly boundary = new Error("captured before model execution");

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    throw this.boundary;
  }
}

describe("W6 active worker registration", () => {
  it("exposes the exact validated active registration and binds it in the service", () => {
    const root = temporaryRoot();
    using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 16,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
    });
    expect(engine.registration).toBe(resolvePlaybook("research"));
    expect(engine.contract).toBe(engine.registration.contract);

    const serviceSource = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");
    expect(serviceSource).toContain("registration: this.engine.registration");
  });

  it("projects bounded registration metadata into a direct shipped-registry worker", async () => {
    const root = temporaryRoot();
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const client = new CapturingClient();
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: PROJECT_ROOT,
      parallelConcurrency: 1,
    });

    await expect(
      workers.execute(researchDirective({ runId: "run-registration-capture" }))
    ).rejects.toBe(client.boundary);
    expect(client.invocations).toHaveLength(1);
    expect(client.invocations[0]?.registration).toEqual({
      playbook_name: "research",
      workflow_name: "research",
      guidance: {
        skill_root: ".pi/skills/research/assets/prompts",
        resolution: "per_agent_phase",
      },
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
    });
    expect(client.invocations[0]?.registration.allowed_tools).toBeUndefined();
  });

  it("omits the subset for an ordinary candidate phase and copies the registration-bound evaluation subset", async () => {
    const root = temporaryRoot();
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const client = new CapturingClient();
    const worker = DECIDE_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide candidate worker is absent");
    const phase = worker.phases.get("deciding");
    if (phase === undefined) throw new Error("deciding phase is absent");
    expect(phase).not.toHaveProperty("allowed_tools");
    const evaluationWorker = DECIDE_UNSEALED_EVALUATION_REGISTRATION.worker;
    if (evaluationWorker.kind !== "catalog-agent") {
      throw new Error("decide evaluation worker is absent");
    }
    const evaluationPhase = evaluationWorker.phases.get("deciding");
    if (evaluationPhase === undefined) throw new Error("evaluation deciding phase is absent");
    expect(evaluationPhase.allowed_tools).toEqual(["artifact_read"]);
    const ordinary = new WorkerExecutor(client, artifacts, {
      projectRoot: PROJECT_ROOT,
      parallelConcurrency: 1,
      registration: DECIDE_CANDIDATE_REGISTRATION,
    });

    await expect(
      ordinary.execute(
        researchDirective({
          runId: "run-candidate-subset-capture",
          playbook: DECIDE_CANDIDATE_REGISTRATION.name,
          stateId: "deciding",
          agent: phase.agent,
        })
      )
    ).rejects.toBe(client.boundary);
    expect(client.invocations[0]?.registration.allowed_tools).toBeUndefined();

    const evaluation = new WorkerExecutor(client, artifacts, {
      projectRoot: PROJECT_ROOT,
      parallelConcurrency: 1,
      registration: DECIDE_UNSEALED_EVALUATION_REGISTRATION,
    });
    await expect(
      evaluation.execute(
        researchDirective({
          runId: "run-evaluation-subset-capture",
          playbook: DECIDE_UNSEALED_EVALUATION_REGISTRATION.name,
          stateId: "deciding",
          agent: evaluationPhase.agent,
        })
      )
    ).rejects.toBe(client.boundary);
    expect(client.invocations[1]?.registration.allowed_tools).toEqual(["artifact_read"]);
  });

  it("refuses state/agent and injected-registration identity mismatches before model work", async () => {
    const root = temporaryRoot();
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const client = new CapturingClient();
    const research = resolvePlaybook("research");
    if (research === undefined) throw new Error("research registration unavailable");
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: PROJECT_ROOT,
      parallelConcurrency: 1,
      registration: research,
    });

    await expect(
      workers.execute(
        researchDirective({ runId: "run-registration-agent-mismatch", agent: "echo" })
      )
    ).rejects.toThrow(/state\/agent mismatch/);
    await expect(
      workers.execute(
        researchDirective({
          runId: "run-registration-playbook-mismatch",
          playbook: "knowledge-base",
        })
      )
    ).rejects.toThrow(/does not match directive playbook/);
    expect(client.invocations).toHaveLength(0);
  });

  it("refuses missing required guidance before session creation", async () => {
    const client = new PiAgentClient();
    await expect(
      client.runAgent({
        agent: "piper",
        stateId: "planning",
        task: "Do not create a session.",
        projectRoot: PROJECT_ROOT,
        trustProfile: "trusted-interactive",
        inputArtifacts: [],
        registration: {
          playbook_name: "research",
          workflow_name: "research",
          guidance: {
            skill_root: ".pi/skills/does-not-exist",
            resolution: "per_agent_phase",
          },
          result_transport: "persisted_summary",
          opening_policy: "registration_guidance_task_artifacts",
          model_policy: "directive_override_or_runtime_default",
        },
      })
    ).rejects.toThrow(/empty required guidance/);
  });
});
