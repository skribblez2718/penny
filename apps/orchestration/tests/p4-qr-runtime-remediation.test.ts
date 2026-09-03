import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer } from "../src/checkpointer.js";
import type { RunIdentity } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import {
  buildAgentOpening,
  canonicalAssistantText,
  createDurableCatalogSession,
  finalizeDurableCatalogSession,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
} from "../src/model-client.js";
import { resolvePlaybook } from "../src/playbooks/registry.js";
import { OrchestrationRunner, WorkerExecutor, buildRoutingRepairGuidance } from "../src/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p4-qr-runtime-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function appendAssistant(manager: SessionManager, text: string): void {
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function customData(value: unknown): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new Error("session metadata is not an object");
  return value;
}

describe("P4-QR durable workflow sessions", () => {
  it("persists owner-only correlated JSONL for every provider-free outcome shape", async () => {
    const root = temporaryRoot();
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(
      root,
      "state",
      "projects",
      `prj_${"a".repeat(32)}`,
      "subagent-sessions"
    );
    mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    const projectId = `prj_${"a".repeat(32)}`;
    const cases: ReadonlyArray<{
      readonly outcome: string;
      readonly assistant: string | undefined;
      readonly purpose: "phase" | "routing_repair";
    }> = [
      { outcome: "success", assistant: "complete", purpose: "phase" },
      { outcome: "malformed", assistant: "not-json", purpose: "phase" },
      { outcome: "timeout", assistant: undefined, purpose: "phase" },
      { outcome: "abort", assistant: undefined, purpose: "phase" },
      { outcome: "provider-error", assistant: undefined, purpose: "phase" },
      {
        outcome: "repair",
        assistant: 'SUMMARY:{"write_complete":true,"confidence":"CERTAIN"}',
        purpose: "routing_repair",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const manager = createDurableCatalogSession({
        projectRoot,
        projectId,
        sessionRoot,
        agent: "skribble",
        stateId: "report_writing",
        correlation: {
          run_id: `run-${testCase.outcome}`,
          workflow_session_id: `workflow-${testCase.outcome}`,
          branch_id: null,
          attempt: index + 1,
          worker_id: `worker-${testCase.outcome}`,
          purpose: testCase.purpose,
        },
      });
      const initialSessionFile = manager.getSessionFile();
      if (initialSessionFile === undefined) {
        throw new Error("durable session has no initial JSONL path");
      }
      expect(existsSync(initialSessionFile)).toBe(true);
      expect(statSync(initialSessionFile).mode & 0o777).toBe(0o600);
      manager.appendMessage({
        role: "user",
        content: `provider-free ${testCase.outcome}`,
        timestamp: Date.now(),
      });
      if (testCase.assistant !== undefined) appendAssistant(manager, testCase.assistant);
      const sessionFile = finalizeDurableCatalogSession(manager);
      if (sessionFile === undefined) throw new Error("durable session returned no JSONL path");
      expect(statSync(sessionFile).mode & 0o777).toBe(0o600);

      const stored = SessionManager.open(sessionFile, path.dirname(sessionFile), projectRoot);
      const metadataEntry = stored
        .getEntries()
        .find(
          (entry) =>
            entry.type === "custom" && entry.customType === "penny.orchestration.worker-session"
        );
      if (metadataEntry?.type !== "custom") throw new Error("workflow correlation is absent");
      const metadata = customData(metadataEntry.data);
      expect(metadata).toMatchObject({
        schema_version: 1,
        project_id: projectId,
        run_id: `run-${testCase.outcome}`,
        workflow_session_id: `workflow-${testCase.outcome}`,
        state_id: "report_writing",
        branch_id: null,
        attempt: index + 1,
        worker_id: `worker-${testCase.outcome}`,
        agent: "skribble",
        purpose: testCase.purpose,
      });
      expect(
        Object.values(metadata).some((value) => typeof value === "string" && value.includes(root))
      ).toBe(false);
    }

    const agentDirectory = path.join(sessionRoot, "skribble");
    expect(statSync(agentDirectory).mode & 0o777).toBe(0o700);
    expect(readdirSync(agentDirectory).filter((name) => name.endsWith(".jsonl"))).toHaveLength(
      cases.length
    );
    expect(await SessionManager.list(projectRoot, agentDirectory)).toHaveLength(cases.length);
  });
});

class Fresh004LivenessClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    if (invocation.stateId !== "researching") {
      throw new Error(`unexpected Fresh-004 fixture state '${invocation.stateId}'`);
    }
    if (invocation.liveness === undefined || invocation.livenessBudget === undefined) {
      throw new Error("Fresh-004 fixture requires host liveness enforcement and projection");
    }
    for (let index = 0; index < 8; index += 1) {
      invocation.liveness({ kind: "tool_call", tool_name: "web_fetch" });
    }
    return {
      text: canonicalAssistantText([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "external_request_budget_exhausted",
        },
      ]),
    };
  }
}

class UnifiedMalformedSemanticDraftClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private synthesisCalls = 0;

  constructor(
    readonly malformedDraft: string,
    readonly malformedRepair: string
  ) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    if (invocation.executionPurpose === "routing_repair") {
      return { text: this.malformedRepair };
    }
    if (invocation.stateId === "researching") {
      return {
        text: 'accepted evidence\nSUMMARY:{"confidence":"CERTAIN","explore_complete":true}',
        confidence: "CERTAIN",
        details: { explore_complete: true },
      };
    }
    if (invocation.stateId === "synthesizing") {
      this.synthesisCalls += 1;
      return this.synthesisCalls === 1
        ? { text: "", confidence: "CERTAIN", details: { synthesis_complete: true } }
        : { text: this.malformedDraft };
    }
    throw new Error(`unexpected unified regression state '${invocation.stateId}'`);
  }
}

describe("P4-QR Fresh-004 liveness terminal regression", () => {
  it("preserves the exact Pi liveness error and durably terminalizes incomplete", async () => {
    const root = temporaryRoot();
    const runId = "run-p4-fresh-004-liveness";
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactRevisions: artifacts,
      artifactStore: artifacts,
      artifactReader: artifacts,
    });
    const client = new Fresh004LivenessClient();
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: root,
      parallelConcurrency: 1,
      registration: engine.registration,
    });
    const runner = new OrchestrationRunner(engine, workers);
    const identity = {
      schema_version: 2,
      run_id: runId,
      session_id: "session-p4-fresh-004-liveness",
      playbook: "research",
      engine_owner: "typescript",
    } satisfies RunIdentity;
    const start = engine.handle({
      schema_version: 2,
      action: "start",
      identity,
      goal: "Exercise the exact Fresh-004 liveness failure chain.",
      constraints: { mode: "quick" },
      project_root: root,
      trust_profile: "trusted-interactive",
    });

    const terminal = await runner.runUntilBoundary(start);
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("Fresh-004 did not terminalize");
    expect(terminal.status).toBe("incomplete");
    expect(terminal.met).toBe(false);
    expect(terminal.result.terminal_reason).toBe("external_request_budget_exhausted");
    expect(client.invocations).toHaveLength(1);
    expect(client.invocations[0]?.livenessBudget).toEqual({
      schema_version: 1,
      preset: "quick",
      purpose: "phase",
      model_turns: { worker_remaining: 16, run_remaining: 48, effective_remaining: 16 },
      tool_calls: { worker_remaining: 20, run_remaining: 64, effective_remaining: 20 },
      external_requests: { worker_remaining: 8, run_remaining: 12, effective_remaining: 8 },
    });
    expect(
      checkpointer.events(runId).filter((event) => event.eventType === "liveness_tool_call_charged")
    ).toHaveLength(8);
    expect(engine.liveness.snapshot(runId)).toMatchObject({
      external_calls: 8,
      open_workers: 0,
    });

    const durable = checkpointer.loadRunById(runId);
    if (durable === undefined) throw new Error("Fresh-004 durable run is absent");
    expect(durable.status).toBe("incomplete");
    expect(durable.stateId).toBe("complete");
    expect(durable.met).toBe(false);
    expect(durable.terminalDirective).toMatchObject({
      action: "incomplete",
      result: { terminal_reason: "external_request_budget_exhausted" },
    });
    expect(
      durable.selectedArtifacts.some((artifact) =>
        ["semantic-core", "product-envelope", "deterministic-render"].includes(artifact.kind)
      )
    ).toBe(false);
    expect(existsSync(path.join(root, "research"))).toBe(false);
    artifacts.close();
    checkpointer.close();
  });
});

describe("P4-QR unified provider-free semantic-draft regression", () => {
  it("keeps an empty draft pending, persists a malformed draft, and stalls identical malformed repair", async () => {
    const root = temporaryRoot();
    const runId = "run-p4-unified-malformed-semantic-draft";
    const malformedDraft = "DRAFT_BODY\nSUMMARY: not-json";
    const malformedRepair =
      'REPAIR_BODY\nSUMMARY:{"confidence":"CERTAIN","synthesis_complete":true,"defect":"forbidden"}';
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactRevisions: artifacts,
      artifactStore: artifacts,
      artifactReader: artifacts,
    });
    const client = new UnifiedMalformedSemanticDraftClient(malformedDraft, malformedRepair);
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: root,
      parallelConcurrency: 1,
      registration: engine.registration,
    });
    const runner = new OrchestrationRunner(engine, workers);
    const identity = {
      schema_version: 2,
      run_id: runId,
      session_id: "session-p4-unified-malformed-semantic-draft",
      playbook: "research",
      engine_owner: "typescript",
    } satisfies RunIdentity;
    const start = engine.handle({
      schema_version: 2,
      action: "start",
      identity,
      goal: "Exercise the unified provider-free semantic-draft failure chain.",
      constraints: { mode: "quick" },
      project_root: root,
      trust_profile: "trusted-interactive",
    });

    await expect(runner.runUntilBoundary(start)).rejects.toThrow(
      /no non-empty final assistant text/u
    );
    const pendingRun = checkpointer.loadRunById(runId);
    if (pendingRun === undefined) throw new Error("pending semantic-draft run is absent");
    expect(pendingRun.stateId).toBe("synthesizing");
    expect(pendingRun.status).toBe("running");
    const pending = pendingRun.pendingDirective;
    if (pending?.action !== "invoke_agent")
      throw new Error("semantic-draft directive is not pending");
    expect(pendingRun.selectedArtifacts.map((artifact) => artifact.phase)).toEqual(
      expect.arrayContaining(["intake", "researching"])
    );
    expect(
      artifacts.lastVersion(
        runId,
        pending.output_artifact.phase,
        pending.output_artifact.branch_id,
        pending.output_artifact.kind,
        pending.output_artifact.operation_id
      )
    ).toBe(0);
    expect(
      checkpointer.events(runId).some((event) => event.eventType.startsWith("routing_repair"))
    ).toBe(false);
    expect(
      pendingRun.selectedArtifacts.some((artifact) =>
        ["semantic-core", "product-envelope", "deterministic-render"].includes(artifact.kind)
      )
    ).toBe(false);
    expect(existsSync(path.join(root, "research"))).toBe(false);

    const recovered = engine.handle({ schema_version: 2, action: "recover", identity });
    expect(recovered.action).toBe("invoke_agent");
    const terminal = await runner.runUntilBoundary(recovered);
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("malformed repair did not terminalize");
    expect(terminal.met).toBe(false);
    expect(terminal.result.terminal_reason).toBe("identical_error_stall");

    const draftRef = artifacts.refFor(
      runId,
      pending.output_artifact.phase,
      pending.output_artifact.branch_id,
      pending.output_artifact.kind,
      pending.output_artifact.operation_id,
      pending.output_artifact.version
    );
    if (draftRef === null) throw new Error("malformed semantic draft artifact was not persisted");
    expect(artifacts.readById(draftRef.artifact_id).toString("utf8")).toBe(malformedDraft);
    const repairInvocation = client.invocations.at(-1);
    if (repairInvocation?.executionPurpose !== "routing_repair") {
      throw new Error("routing repair invocation is absent");
    }
    expect(repairInvocation.inputArtifacts).toEqual([draftRef]);
    const malformedDigests = checkpointer
      .events(runId)
      .filter((event) => event.eventType === "liveness_malformed_charged")
      .map((event) => {
        const digest = event.payload["digest"];
        if (typeof digest !== "string") throw new Error("malformed digest is absent");
        return digest;
      });
    expect(malformedDigests).toHaveLength(2);
    expect(new Set(malformedDigests).size).toBe(1);

    const terminalRun = checkpointer.loadRunById(runId);
    expect(terminalRun?.status).toBe("incomplete");
    expect(
      terminalRun?.selectedArtifacts.some((artifact) =>
        ["semantic-core", "product-envelope", "deterministic-render"].includes(artifact.kind)
      )
    ).toBe(false);
    expect(existsSync(path.join(root, "research"))).toBe(false);
    expect(
      client.invocations.map(
        (invocation) => `${invocation.stateId}:${invocation.executionPurpose ?? "phase"}`
      )
    ).toEqual([
      "researching:phase",
      "synthesizing:phase",
      "synthesizing:phase",
      "synthesizing:routing_repair",
    ]);
    artifacts.close();
    checkpointer.close();
  });
});

describe("P4-QR summary-only repair prompt", () => {
  it("mechanically projects the registered schema and excludes production guidance", () => {
    const registration = resolvePlaybook("research");
    if (registration === undefined) throw new Error("research registration is absent");
    const guidance = buildRoutingRepairGuidance(registration, "synthesizing");
    expect(guidance).toContain("Summary-Only Routing Repair");
    expect(guidance).toContain('"synthesis_complete"');
    expect(guidance).toContain('"additionalProperties":false');
    expect(guidance).not.toContain("defect");
    expect(guidance).not.toContain("repair_via");

    const invocation: AgentInvocation = {
      agent: "synthia",
      stateId: "synthesizing",
      task: "Repair routing metadata only.",
      projectRoot: "/project-placeholder",
      trustProfile: "trusted-interactive",
      inputArtifacts: [],
      executionPurpose: "routing_repair",
      routingRepairGuidance: guidance,
      workflowSession: {
        run_id: "run-repair",
        workflow_session_id: "workflow-repair",
        branch_id: null,
        attempt: 2,
        worker_id: "worker-repair",
        purpose: "routing_repair",
      },
      registration: {
        playbook_name: registration.name,
        workflow_name: registration.worker.workflow_name,
        guidance: registration.worker.guidance,
        result_transport: registration.worker.result_transport,
        opening_policy: registration.worker.opening_policy,
        model_policy: registration.worker.model_policy,
      },
    };
    const opening = buildAgentOpening({
      invocation,
      registration: invocation.registration,
      agentGuidance: "ROLE_GUIDANCE_SENTINEL",
      domainGuidance: "FULL_CANDIDATE_GUIDANCE_SENTINEL",
      activeToolNames: ["artifact_read"],
    });
    expect(opening).toContain("ROLE_GUIDANCE_SENTINEL");
    expect(opening).toContain("Summary-Only Routing Repair");
    expect(opening).not.toContain("FULL_CANDIDATE_GUIDANCE_SENTINEL");
    expect(opening).toContain("Do not return prose or semantic body bytes");
  });
});
