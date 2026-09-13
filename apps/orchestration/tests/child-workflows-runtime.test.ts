import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ASSESS_PLAYBOOK_REGISTRATION,
  DECIDE_PLAYBOOK_REGISTRATION,
  PLAYBOOK_REGISTRY,
  OrchestrationService,
  canonicalJson,
  initializePennyState,
  loadRuntimeConfig,
  validateDirective,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactHostStore,
  type Directive,
  type ModelClient,
  type PlaybookRegistrationV1,
  type PlaybookV1,
  type RunContext,
} from "../src/index.js";
import { decisionRequest, persistedDecisionDraft } from "./fixtures/decision-fixtures.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-child-runtime-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return env;
}

function summary(details: Record<string, unknown>): string {
  return `Child report body.\nSUMMARY:${JSON.stringify({ confidence: "PROBABLE", ...details })}`;
}

function childOutputs(): readonly string[] {
  return [
    summary({
      analysis_complete: true,
      gap_kind: "none",
      repair_owner: "none",
      findings: ["All alternatives mapped."],
      strategy_delta: "Proceed with the bounded decision assessment.",
    }),
    persistedDecisionDraft("selected"),
    summary({
      verdict: "PASS",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["Exact latest DecisionV2 satisfies request and lineage checks."],
      strategy_delta: "Advance the exact product to independent quality critique.",
    }),
    summary({
      verdict: "APPROVE",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["The Vera-passed decision is balanced and decision-useful."],
      strategy_delta: "Approve the exact latest product.",
    }),
  ];
}

class ScriptedClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private index = 0;

  constructor(
    private readonly outputs: readonly string[],
    private readonly simulatedUsage = { modelTurns: 0, toolCalls: 0 }
  ) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    for (let index = 0; index < this.simulatedUsage.modelTurns; index += 1) {
      invocation.liveness?.({ kind: "model_turn", source: "turn_start" });
    }
    for (let index = 0; index < this.simulatedUsage.toolCalls; index += 1) {
      invocation.liveness?.({ kind: "tool_call", tool_name: "artifact_read" });
    }
    const output = this.outputs[this.index];
    this.index += 1;
    if (output === undefined) throw new Error("child model output is exhausted");
    return { text: output };
  }
}

class BlockingClient implements ModelClient {
  private startedResolve: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.startedResolve?.();
    return await new Promise<AgentCompletion>((_resolve, reject) => {
      const rejectAbort = (): void => reject(new Error("child model invocation was cancelled"));
      if (invocation.signal?.aborted) {
        rejectAbort();
        return;
      }
      invocation.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  }
}

class ChildDispatchParent implements PlaybookV1 {
  constructor(
    private readonly artifacts: ArtifactHostStore,
    private readonly projectId: string
  ) {}

  initialize(context: RunContext): Directive {
    context.transition("child");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    const existing = context.selectedArtifacts.find((artifact) => artifact.kind === "child-result");
    if (existing !== undefined) {
      const terminal = validateDirective({
        schema_version: 2,
        action: "incomplete",
        identity: context.identity,
        status: "incomplete",
        met: false,
        result: { child_result_artifact_id: existing.artifact_id },
        artifacts: [existing],
        unresolved: [
          "Fixture parent consumed the exact child result without claiming parent success.",
        ],
      });
      context.status = "incomplete";
      context.met = false;
      context.pendingDirective = terminal;
      context.terminalDirective = terminal;
      return terminal;
    }
    const policyBinding = {
      schema_version: 1 as const,
      project_id: this.projectId,
      principal_id: "principal-child-runtime",
      scope_id: "scope-child-runtime",
      source_policy_id: "source-policy-child-runtime",
      destination_policy_id: "destination-policy-child-runtime",
    };
    const request = {
      schema_id: "penny.child-workflow-request.v1" as const,
      schema_version: 1 as const,
      child_name: "decide",
      provider_request_schema_id: "penny.decision-request.v1",
      provider_request_schema_version: 1,
      provider_request: decisionRequest(),
      policy_binding: policyBinding,
    };
    const requestRef = this.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: context.stateId,
        branch_id: null,
        kind: "child-request",
        operation_id: `child-request:${context.identity.run_id}`,
        version: 1,
        producer: "host:test-child-parent",
        media_type: "application/json",
        content_schema: {
          schema_id: "penny.child-workflow-request.v1",
          schema_version: 1,
        },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(request),
    });
    const target = PLAYBOOK_REGISTRY.get("assess")?.generic_child?.parent_policy.targets.find(
      (candidate) => candidate.child_name === "decide"
    );
    if (target === undefined || target.schema_version !== 2) {
      throw new Error("missing lease-bound decide target");
    }
    const directive = validateDirective({
      schema_version: 3,
      action: "invoke_child_workflow",
      identity: context.identity,
      state_id: context.stateId,
      call_key: "one-decision",
      child_name: "decide",
      request_ref: requestRef,
      input_artifacts: { schema_version: 2, artifacts: [] },
      expected_output: target.expected_output,
      policy_binding: policyBinding,
      progress_lease: target.progress_lease,
    });
    context.pendingDirective = directive;
    context.status = "running";
    return directive;
  }

  resume(): Directive {
    throw new Error("fixture parent has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    const terminal = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: { reason },
      artifacts: context.selectedArtifacts,
      unresolved: [reason],
    });
    context.status = "cancelled";
    context.met = false;
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    return terminal;
  }

  acceptSummary(): Directive {
    throw new Error("fixture parent has no worker phases");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}

function parentRegistration(projectId: string): PlaybookRegistrationV1 {
  return {
    ...(PLAYBOOK_REGISTRY.get("assess") ?? ASSESS_PLAYBOOK_REGISTRATION),
    construct: (options) => {
      if (options.artifactStore === undefined) throw new Error("fixture parent requires artifacts");
      return new ChildDispatchParent(options.artifactStore, projectId);
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("lease-bound depth-one child-workflow owner", () => {
  it("fails closed before child work when the host explicitly disables child execution", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const parent = parentRegistration(projectId);
    const client = new ScriptedClient([]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      enableChildWorkflows: false,
    });
    const identity = {
      schema_version: 2 as const,
      run_id: "child-runtime-owner-unavailable",
      session_id: "child-runtime-owner-unavailable",
      playbook: "assess",
      engine_owner: "typescript" as const,
    };
    await expect(
      service.execute({
        schema_version: 2,
        action: "start",
        identity,
        goal: "Refuse explicitly disabled child execution.",
        constraints: {
          schema_version: 1,
          target: "fixture",
          criteria: [{ statement: "child refusal", importance: "required" }],
          supplied_evidence: [],
          hard_constraints: [],
          non_goals: [],
          known_uncertainties: [],
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      })
    ).resolves.toMatchObject({
      action: "error",
      met: false,
      result: { code: "CHILD_WORKFLOW_OWNER_UNAVAILABLE" },
    });
    expect(client.invocations).toHaveLength(0);
    expect(service.checkpointer.childWorkflowCallsForParent(identity.run_id)).toHaveLength(0);
  });

  it("runs a real registered child, records its terminal once, consumes the exact core, and resumes the parent", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const parent = parentRegistration(projectId);
    const registry = new Map<string, PlaybookRegistrationV1>([
      ["assess", parent],
      ["decide", PLAYBOOK_REGISTRY.get("decide") ?? DECIDE_PLAYBOOK_REGISTRATION],
    ]);
    // Four phases at this simulated usage exceed the removed child-specific V2 guesses
    // (8 model turns / 16 tool calls) while remaining governed by the child's active liveness.
    const client = new ScriptedClient(childOutputs(), { modelTurns: 3, toolCalls: 5 });
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    const identity = {
      schema_version: 2 as const,
      run_id: "child-runtime-parent",
      session_id: "child-runtime-parent",
      playbook: "assess",
      engine_owner: "typescript" as const,
    };
    const terminal = await service.execute({
      schema_version: 2,
      action: "start",
      identity,
      goal: "Assess a child workflow runtime fixture.",
      constraints: {
        schema_version: 1,
        target: "fixture",
        criteria: [{ statement: "child dispatch", importance: "required" }],
        supplied_evidence: [],
        hard_constraints: [],
        non_goals: [],
        known_uncertainties: [],
      },
      project_root: PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
    });
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations.map((item) => item.stateId)).toEqual([
      "analyzing_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
    ]);
    const calls = service.checkpointer.childWorkflowCallsForParent(identity.run_id);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("missing child call");
    expect(call).not.toHaveProperty("budget");
    expect(call).toMatchObject({
      schema_version: 2,
      lifecycle: "consumed",
      progress_lease: { operation_class: "child_execution" },
      usage: { model_turns: 12, tool_calls: 20, unknown_usage: false },
      child_identity: { playbook: "decide" },
      terminal_action: "complete",
      output_artifact: {
        content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
      },
    });
    expect(service.checkpointer.loadRun(identity).selectedArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "child-result",
          content_schema: { schema_id: "penny.child-workflow-result.v1", schema_version: 1 },
        }),
        expect.objectContaining({
          content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
        }),
      ])
    );
    expect(
      service.checkpointer
        .events(identity.run_id)
        .filter((event) => event.eventType === "child_workflow_consumed")
    ).toHaveLength(1);
  });

  it("expires a silent child through the active content-free inactivity lease", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-11T00:00:00.000Z") });
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const parent = parentRegistration(projectId);
    const registry = new Map<string, PlaybookRegistrationV1>([
      ["assess", parent],
      ["decide", PLAYBOOK_REGISTRY.get("decide") ?? DECIDE_PLAYBOOK_REGISTRATION],
    ]);
    const client = new BlockingClient();
    const service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    const identity = {
      schema_version: 2 as const,
      run_id: "child-runtime-inactivity-expiry",
      session_id: "child-runtime-inactivity-expiry",
      playbook: "assess",
      engine_owner: "typescript" as const,
    };
    try {
      const execution = service.execute({
        schema_version: 2,
        action: "start",
        identity,
        goal: "Expire a silent child through its inactivity lease.",
        constraints: {
          schema_version: 1,
          target: "fixture",
          criteria: [{ statement: "child inactivity lease", importance: "required" }],
          supplied_evidence: [],
          hard_constraints: [],
          non_goals: [],
          known_uncertainties: [],
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      });
      await client.started;
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      await expect(execution).resolves.toMatchObject({ action: "incomplete", met: false });
      expect(service.checkpointer.childWorkflowCallsForParent(identity.run_id)).toEqual([
        expect.objectContaining({ lifecycle: "consumed", terminal_action: "cancelled" }),
      ]);
    } finally {
      service[Symbol.dispose]();
      vi.useRealTimers();
    }
  });

  it("enforces the project-wide child admission limit across concurrent parents", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const parent = parentRegistration(projectId);
    const registry = new Map<string, PlaybookRegistrationV1>([
      ["assess", parent],
      ["decide", PLAYBOOK_REGISTRY.get("decide") ?? DECIDE_PLAYBOOK_REGISTRATION],
    ]);
    const client = new BlockingClient();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    const firstIdentity = {
      schema_version: 2 as const,
      run_id: "child-runtime-capacity-first",
      session_id: "child-runtime-capacity-first",
      playbook: "assess",
      engine_owner: "typescript" as const,
    };
    const firstController = new AbortController();
    const first = service.execute(
      {
        schema_version: 2,
        action: "start",
        identity: firstIdentity,
        goal: "Hold the sole project child-execution admission slot.",
        constraints: {
          schema_version: 1,
          target: "fixture",
          criteria: [{ statement: "child capacity", importance: "required" }],
          supplied_evidence: [],
          hard_constraints: [],
          non_goals: [],
          known_uncertainties: [],
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      },
      firstController.signal
    );
    await client.started;

    let secondError: unknown;
    try {
      await service.execute({
        schema_version: 2,
        action: "start",
        identity: {
          ...firstIdentity,
          run_id: "child-runtime-capacity-second",
          session_id: "child-runtime-capacity-second",
        },
        goal: "Attempt a second concurrent child execution.",
        constraints: {
          schema_version: 1,
          target: "fixture",
          criteria: [{ statement: "child capacity", importance: "required" }],
          supplied_evidence: [],
          hard_constraints: [],
          non_goals: [],
          known_uncertainties: [],
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      });
    } catch (error) {
      secondError = error;
    } finally {
      firstController.abort();
      await expect(first).resolves.toMatchObject({ action: "cancelled" });
    }
    if (!(secondError instanceof Error)) throw new Error("second child admission did not fail");
    expect(secondError.message).toBe("child workflow project capacity is exhausted");
    expect(service.checkpointer.activeChildWorkflowCallCount()).toBe(0);
  });

  it("propagates a durable parent cancel request to a running child", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const parent = parentRegistration(projectId);
    const registry = new Map<string, PlaybookRegistrationV1>([
      ["assess", parent],
      ["decide", PLAYBOOK_REGISTRY.get("decide") ?? DECIDE_PLAYBOOK_REGISTRATION],
    ]);
    const client = new BlockingClient();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    const identity = {
      schema_version: 2 as const,
      run_id: "child-runtime-parent-cancel",
      session_id: "child-runtime-parent-cancel",
      playbook: "assess",
      engine_owner: "typescript" as const,
    };
    const start = service.execute({
      schema_version: 2,
      action: "start",
      identity,
      goal: "Cancel a child through the durable parent request.",
      constraints: {
        schema_version: 1,
        target: "fixture",
        criteria: [{ statement: "child cancellation", importance: "required" }],
        supplied_evidence: [],
        hard_constraints: [],
        non_goals: [],
        known_uncertainties: [],
      },
      project_root: PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
    });
    await client.started;
    await expect(
      service.execute({
        schema_version: 2,
        action: "cancel",
        identity,
        reason: "cancel parent while child is running",
      })
    ).resolves.toMatchObject({ action: "cancelled", met: false });
    await expect(start).resolves.toMatchObject({ action: "cancelled", met: false });
    expect(service.checkpointer.childWorkflowCallsForParent(identity.run_id)).toEqual([
      expect.objectContaining({ lifecycle: "cancelled", terminal_action: "cancelled" }),
    ]);
    expect(service.checkpointer.loadRun(identity).terminalDirective).toMatchObject({
      action: "cancelled",
    });
  });

  it("cancels a running child durably and prevents its late boundary from resuming the parent", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const parent = parentRegistration(projectId);
    const registry = new Map<string, PlaybookRegistrationV1>([
      ["assess", parent],
      ["decide", PLAYBOOK_REGISTRY.get("decide") ?? DECIDE_PLAYBOOK_REGISTRATION],
    ]);
    const client = new BlockingClient();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    const identity = {
      schema_version: 2 as const,
      run_id: "child-runtime-cancel-parent",
      session_id: "child-runtime-cancel-parent",
      playbook: "assess",
      engine_owner: "typescript" as const,
    };
    const controller = new AbortController();
    const execution = service.execute(
      {
        schema_version: 2,
        action: "start",
        identity,
        goal: "Cancel a running child workflow fixture.",
        constraints: {
          schema_version: 1,
          target: "fixture",
          criteria: [{ statement: "child cancellation", importance: "required" }],
          supplied_evidence: [],
          hard_constraints: [],
          non_goals: [],
          known_uncertainties: [],
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      },
      controller.signal
    );
    await client.started;
    controller.abort(new Error("test cancellation"));
    await expect(execution).resolves.toMatchObject({ action: "cancelled", met: false });
    const calls = service.checkpointer.childWorkflowCallsForParent(identity.run_id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ lifecycle: "cancelled", terminal_action: "cancelled" });
    expect(service.checkpointer.loadRun(identity).terminalDirective).toMatchObject({
      action: "cancelled",
    });
  });
});
