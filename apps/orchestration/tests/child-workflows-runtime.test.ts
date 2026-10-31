import { projectChildGate } from "../dist/child-workflows/gates.js";
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
  validateDecision,
  validateChildWorkflowResult,
  validateDirective,
  validateEvidenceContext,
  type AgentCompletion,
  type ArtifactRef,
  canonicalizePlanRequest,
  childWorkflowCallId,
  childWorkflowRunIdentity,
  type AgentInvocation,
  type ArtifactHostStore,
  type Directive,
  type ModelClient,
  type PlaybookRegistration,
  type Playbook,
  type RunContext,
} from "../dist/index.js";
import { decisionRequest, persistedDecisionDraft } from "./fixtures/decision-fixtures.js";
import {
  genericSpecificationFixture,
  persistedSpecificationDraftV3,
} from "./fixtures/define-fixtures.js";
import { defineRequestConstraints } from "../dist/skill-contracts/define.js";
import { persistEvidenceContext } from "./helpers/evidence-context.js";

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

class ChildDispatchParent implements Playbook {
  constructor(
    private readonly artifacts: ArtifactHostStore,
    private readonly projectId: string,
    private readonly includeEvidenceContext = false,
    private readonly composition?: {
      readonly specification: ArtifactRef | null;
      readonly policy: "reviewed_definition" | "semantic_only";
    }
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
    const planNative =
      this.composition === undefined
        ? undefined
        : canonicalizePlanRequest({
            goal: "Plan a bounded transition.",
            constraints: {
              schema_version: 1,
              desired_outcomes: ["A bounded next step exists."],
              current_state: { status: "provided", facts: ["The specification is available."] },
              hard_constraints: [],
              non_goals: [],
              known_uncertainties: [],
              prior_decisions: [],
            },
            exactInputArtifactIds:
              this.composition.specification === null
                ? []
                : [this.composition.specification.artifact_id],
          });
    const request = {
      schema_id: "penny.child-workflow-request.v1" as const,
      schema_version: 1 as const,
      child_name: this.composition === undefined ? "decide" : "plan",
      provider_request_schema_id:
        this.composition === undefined ? "penny.decision-request.v1" : "penny.plan-request.v1",
      provider_request_schema_version: 1,
      provider_request: planNative ?? decisionRequest(),
      ...(this.composition === undefined
        ? {}
        : {
            invocation_policy: {
              schema_version: 2 as const,
              specification_assurance: this.composition.policy,
            },
          }),
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
    const evidenceContext = this.includeEvidenceContext
      ? persistEvidenceContext(this.artifacts, `child-runtime-${context.identity.run_id}`)
      : undefined;
    const target = PLAYBOOK_REGISTRY.get("assess")?.generic_child?.parent_policy.targets.find(
      (candidate) => candidate.child_name === request.child_name
    );
    if (target === undefined || target.schema_version !== 2) {
      throw new Error("missing lease-bound child target");
    }
    const directive = validateDirective({
      schema_version: 3,
      action: "invoke_child_workflow",
      identity: context.identity,
      state_id: context.stateId,
      call_key: "one-decision",
      child_name: request.child_name,
      request_ref: requestRef,
      input_artifacts: {
        schema_version: 2,
        artifacts:
          this.composition !== undefined
            ? this.composition.specification === null
              ? []
              : [{ slot: "specification", ref: this.composition.specification }]
            : evidenceContext === undefined
              ? []
              : [{ slot: "evidence_context", ref: evidenceContext.ref }],
      },
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

function parentRegistration(
  projectId: string,
  includeEvidenceContext = false,
  composition?: {
    readonly specification: ArtifactRef | null;
    readonly policy: "reviewed_definition" | "semantic_only";
  }
): PlaybookRegistration {
  return {
    ...(PLAYBOOK_REGISTRY.get("assess") ?? ASSESS_PLAYBOOK_REGISTRATION),
    construct: (options) => {
      if (options.artifactStore === undefined) throw new Error("fixture parent requires artifacts");
      return new ChildDispatchParent(
        options.artifactStore,
        projectId,
        includeEvidenceContext,
        composition
      );
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function waitingDecideRegistration(): PlaybookRegistration {
  const original = PLAYBOOK_REGISTRY.get("decide") ?? DECIDE_PLAYBOOK_REGISTRATION;
  return {
    ...original,
    construct: (options) => {
      const base = original.construct(options);
      return new Proxy(base, {
        get(target, property, receiver) {
          if (property === "initialize")
            return (context: RunContext): Directive => {
              base.initialize(context);
              const gate = validateDirective({
                schema_version: 2,
                action: "await_user",
                identity: context.identity,
                state_id: context.stateId,
                gate_id: "child-clarify",
                challenge: "exact-child-challenge",
                payload_digest: "b".repeat(64),
                questions: [{ id: "material", prompt: "Which alternative?" }],
              });
              context.pendingDirective = gate;
              context.status = "awaiting_user";
              return gate;
            };
          if (property === "resume")
            return (context: RunContext): Directive => {
              context.status = "running";
              return base.dispatch(context);
            };
          const value: unknown = Reflect.get(target, property, receiver);
          return value;
        },
      });
    },
  };
}

function waitStart(runId: string) {
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: {
      schema_version: 2 as const,
      run_id: runId,
      session_id: runId,
      playbook: "assess",
      engine_owner: "typescript" as const,
    },
    goal: "Assess a child clarification.",
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
  };
}

function waitReply(gate: Extract<Directive, { action: "await_user" }>) {
  return {
    schema_version: 2,
    action: "respond",
    identity: gate.identity,
    gate_id: gate.gate_id,
    challenge: gate.challenge,
    response: {
      schema_id: "penny.projected-child-response.v1",
      schema_version: 1,
      projection: gate.child_workflow,
      payload_digest: gate.payload_digest,
      reply: { answer: "first" },
    },
  };
}

describe("projected child gates", () => {
  it("rolls back the parent gate and call transition together if projection cannot commit", async () => {
    const env = environment();
    const config = loadRuntimeConfig(PROJECT_ROOT, env);
    const parent = parentRegistration(config.projectId);
    const registry = new Map([
      ["assess", parent],
      ["decide", waitingDecideRegistration()],
    ]);
    const client = new ScriptedClient([]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (sqlite === undefined) throw new Error("Node SQLite unavailable");
    using db = new sqlite.DatabaseSync(config.dbPath);
    db.exec(`CREATE TRIGGER projection_failure BEFORE UPDATE ON child_workflow_calls
      WHEN NEW.lifecycle='waiting_user' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END;`);
    const start = waitStart("projection-atomic-rollback");
    await expect(service.execute(start)).rejects.toThrow(/injected projection failure/u);
    const call = service.checkpointer.childWorkflowCallsForParent(start.identity.run_id)[0];
    if (call === undefined) throw new Error("call missing");
    expect(call.lifecycle).toBe("running");
    expect(service.checkpointer.loadRun(start.identity).pendingDirective?.action).toBe(
      "invoke_child_workflow"
    );
    const childGate = service.checkpointer.loadRun(call.child_identity).pendingDirective;
    if (childGate?.action !== "await_user") throw new Error("durable child gate missing");
    const projection = projectChildGate(call, childGate);
    expect(
      service.checkpointer.gateResponseBinding(start.identity.run_id, projection.gate_id)
    ).toBeUndefined();
    db.exec("DROP TRIGGER projection_failure");
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: start.identity })
    ).toEqual(projection);
    expect(client.invocations).toHaveLength(0);
  });

  it("recovers after child reply commits but before its call leaves waiting_user", async () => {
    const env = environment();
    const parent = parentRegistration(loadRuntimeConfig(PROJECT_ROOT, env).projectId);
    const registry = new Map([
      ["assess", parent],
      ["decide", waitingDecideRegistration()],
    ]);
    const start = waitStart("projection-child-reply-commit");
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedClient([]),
        playbookRegistration: parent,
        childWorkflowRegistry: registry,
      });
      const gate = await service.execute(start);
      if (gate.action !== "await_user" || gate.child_workflow === undefined)
        throw new Error("gate missing");
      service.handle(waitReply(gate));
      const transition = service.checkpointer.transitionChildWorkflowCall.bind(
        service.checkpointer
      );
      const fault = vi
        .spyOn(service.checkpointer, "transitionChildWorkflowCall")
        .mockImplementation((input) => {
          if (input.from === "waiting_user") throw new Error("injected after child reply");
          return transition(input);
        });
      await expect(
        service.execute({ schema_version: 2, action: "recover", identity: start.identity })
      ).rejects.toThrow(/injected after child reply/u);
      fault.mockRestore();
      const call = service.checkpointer.childWorkflowCallsForParent(start.identity.run_id)[0];
      if (call === undefined) throw new Error("call missing");
      expect(call.lifecycle).toBe("waiting_user");
      expect(
        service.checkpointer.gateResponseBinding(
          call.child_identity.run_id,
          gate.child_workflow.child_gate_id
        )?.status
      ).toBe("answered");
    }
    const client = new ScriptedClient(childOutputs());
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: start.identity })
    ).toMatchObject({ action: "incomplete" });
    expect(client.invocations).toHaveLength(4);
    const call = service.checkpointer.childWorkflowCallsForParent(start.identity.run_id)[0];
    if (call === undefined) throw new Error("call missing");
    expect(
      service.checkpointer
        .events(call.child_identity.run_id)
        .filter((event) => event.eventType === "user_gate_answered")
    ).toHaveLength(1);
  });
  it("persists exact waits across service restart and commits one mediated reply and consumption", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const parent = parentRegistration(projectId);
    const registry = new Map([
      ["assess", parent],
      ["decide", waitingDecideRegistration()],
    ]);
    const client = new ScriptedClient(childOutputs());
    const start = waitStart("projected-wait-restart");
    let gate: Extract<Directive, { action: "await_user" }>;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: parent,
        childWorkflowRegistry: registry,
      });
      const boundary = await service.execute(start);
      expect(boundary.action).toBe("await_user");
      if (boundary.action !== "await_user") throw new Error("missing projected wait");
      gate = boundary;
      expect(gate.child_workflow).toMatchObject({
        schema_version: 2,
        child_gate_id: "child-clarify",
      });
      expect(
        service.checkpointer.childWorkflowCallsForParent(start.identity.run_id)[0]?.lifecycle
      ).toBe("waiting_user");
      expect(client.invocations).toHaveLength(0);
    }
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: start.identity })
    ).toEqual(gate);
    const reply = waitReply(gate);
    expect(await service.execute(reply)).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations).toHaveLength(4);
    expect(
      service.checkpointer.childWorkflowCallsForParent(start.identity.run_id)[0]?.lifecycle
    ).toBe("consumed");
    expect(
      service.checkpointer
        .events(start.identity.run_id)
        .filter((e) => e.eventType === "child_workflow_reply_staged")
    ).toHaveLength(1);
    expect(
      service.checkpointer
        .events(start.identity.run_id)
        .filter((e) => e.eventType === "child_workflow_consumed")
    ).toHaveLength(1);
    await expect(service.execute(reply)).rejects.toThrow(/already answered/u);
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: start.identity })
    ).toMatchObject({ action: "incomplete" });
    expect(client.invocations).toHaveLength(4);
  });

  it("refuses wrong call/run/challenge/digest/version and direct child replies without advancing either wait", async () => {
    const env = environment();
    const parent = parentRegistration(loadRuntimeConfig(PROJECT_ROOT, env).projectId);
    const registry = new Map([
      ["assess", parent],
      ["decide", waitingDecideRegistration()],
    ]);
    const client = new ScriptedClient([]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    const start = waitStart("projected-wait-invalid");
    const gate = await service.execute(start);
    if (gate.action !== "await_user" || gate.child_workflow === undefined)
      throw new Error("missing projected gate");
    const reply = waitReply(gate);
    const variations = [
      { ...reply, challenge: "wrong-challenge" },
      { ...reply, identity: { ...reply.identity, run_id: "different-parent" } },
      { ...reply, response: { ...reply.response, payload_digest: "a".repeat(64) } },
      { ...reply, response: { ...reply.response, schema_version: 2 } },
      ...["call_id", "child_run_id", "child_challenge", "invocation_sha256"].map((key) => ({
        ...reply,
        response: {
          ...reply.response,
          projection: {
            ...reply.response.projection,
            [key]: key.endsWith("sha256") ? "a".repeat(64) : "wrong-value",
          },
        },
      })),
    ];
    for (const bad of variations) await expect(service.execute(bad)).rejects.toThrow();
    const call = service.checkpointer.childWorkflowCallsForParent(start.identity.run_id)[0];
    if (call === undefined) throw new Error("call missing");
    using childService = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: registry.get("decide") ?? DECIDE_PLAYBOOK_REGISTRATION,
      childWorkflowRegistry: registry,
    });
    await expect(
      childService.execute({
        schema_version: 2,
        action: "respond",
        identity: call.child_identity,
        gate_id: gate.child_workflow.child_gate_id,
        challenge: gate.child_workflow.child_challenge,
        response: { answer: "bypass parent" },
      })
    ).rejects.toThrow(/parent mediation/u);
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: start.identity })
    ).toEqual(gate);
    expect(client.invocations).toHaveLength(0);
  });

  it.each(["payload_digest", "questions"] as const)(
    "refuses a staged reply when the exact child gate %s changes before delivery",
    async (field) => {
      const env = environment();
      const parent = parentRegistration(loadRuntimeConfig(PROJECT_ROOT, env).projectId);
      const registry = new Map([
        ["assess", parent],
        ["decide", waitingDecideRegistration()],
      ]);
      const client = new ScriptedClient(childOutputs());
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: parent,
        childWorkflowRegistry: registry,
      });
      const start = waitStart(`projected-staged-drift-${field}`);
      const gate = await service.execute(start);
      if (gate.action !== "await_user") throw new Error("missing projected gate");
      expect(service.handle(waitReply(gate)).action).toBe("invoke_child_workflow");
      const call = service.checkpointer.childWorkflowCallsForParent(start.identity.run_id)[0];
      if (call === undefined) throw new Error("missing child call");
      const child = service.checkpointer.loadRun(call.child_identity);
      const original = child.pendingDirective;
      if (original?.action !== "await_user") throw new Error("missing child gate");
      // Preserve gate ID/challenge: a challenge-only check cannot catch this drift.
      child.pendingDirective = validateDirective({
        ...original,
        ...(field === "payload_digest"
          ? { payload_digest: "c".repeat(64) }
          : { questions: [{ id: "material", prompt: "Changed material choice?" }] }),
      });
      service.checkpointer.saveRun(child, "fixture_child_gate_drift", {});
      await expect(
        service.execute({ schema_version: 2, action: "recover", identity: start.identity })
      ).rejects.toThrow(/projected child gate.*(?:changed|binding|current)/u);
      expect(client.invocations).toHaveLength(0);
      expect(service.checkpointer.childWorkflowCall(call.call_id)?.lifecycle).toBe("waiting_user");
      expect(
        service.checkpointer.gateResponseBinding(call.child_identity.run_id, original.gate_id)
          ?.status
      ).toBe("pending");
    }
  );

  it("resumes a staged parent reply after restart without asking again", async () => {
    const env = environment();
    const parent = parentRegistration(loadRuntimeConfig(PROJECT_ROOT, env).projectId);
    const registry = new Map([
      ["assess", parent],
      ["decide", waitingDecideRegistration()],
    ]);
    const start = waitStart("projected-staged-restart");
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedClient([]),
        playbookRegistration: parent,
        childWorkflowRegistry: registry,
      });
      const gate = await service.execute(start);
      if (gate.action !== "await_user") throw new Error("missing gate");
      expect(service.handle(waitReply(gate)).action).toBe("invoke_child_workflow");
    }
    const client = new ScriptedClient(childOutputs());
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: start.identity })
    ).toMatchObject({ action: "incomplete" });
    expect(client.invocations).toHaveLength(4);
  });

  it("cancels a waiting child and rejects a late parent reply", async () => {
    const env = environment();
    const parent = parentRegistration(loadRuntimeConfig(PROJECT_ROOT, env).projectId);
    const registry = new Map([
      ["assess", parent],
      ["decide", waitingDecideRegistration()],
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedClient([]),
      playbookRegistration: parent,
      childWorkflowRegistry: registry,
    });
    const start = waitStart("projected-wait-cancel");
    const gate = await service.execute(start);
    if (gate.action !== "await_user") throw new Error("missing gate");
    expect(
      await service.execute({
        schema_version: 2,
        action: "cancel",
        identity: start.identity,
        reason: "stop",
      })
    ).toMatchObject({ action: "cancelled" });
    const call = service.checkpointer.childWorkflowCallsForParent(start.identity.run_id)[0];
    if (call === undefined) throw new Error("missing child");
    expect(call.lifecycle).toBe("cancelled");
    expect(service.checkpointer.loadRun(call.child_identity).status).toBe("cancelled");
    await expect(service.execute(waitReply(gate))).rejects.toThrow();
    expect(
      service.checkpointer
        .events(start.identity.run_id)
        .filter((e) => e.eventType === "child_workflow_consumed")
    ).toHaveLength(0);
  });
});

describe("lease-bound depth-one child-workflow owner", () => {
  it("refuses an uncommitted SpecificationV1 under explicit strict policy before child run reservation", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const fixture = genericSpecificationFixture();
    using owner = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "plan",
      modelClient: new ScriptedClient([]),
    });
    const specification = owner.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "uncommitted-define",
        phase: "sealing_specification",
        branch_id: null,
        kind: "specification",
        operation_id: "uncommitted-specification",
        version: 1,
        producer: "host:specification-sealer",
        media_type: "application/json",
        content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(fixture.specification),
    });
    const parent = parentRegistration(projectId, false, {
      specification,
      policy: "reviewed_definition",
    });
    const client = new ScriptedClient([]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: new Map([
        ["assess", parent],
        [
          "plan",
          PLAYBOOK_REGISTRY.get("plan") ??
            (() => {
              throw new Error("plan missing");
            })(),
        ],
      ]),
    });
    const identity = {
      schema_version: 2 as const,
      run_id: "strict-child-refusal",
      session_id: "strict-child-refusal",
      playbook: "assess",
      engine_owner: "typescript" as const,
    };
    await expect(
      service.execute({
        schema_version: 2,
        action: "start",
        identity,
        goal: "Assess child policy.",
        constraints: {
          schema_version: 1,
          target: "fixture",
          criteria: [{ statement: "Review", importance: "required" }],
          supplied_evidence: [],
          hard_constraints: [],
          non_goals: [],
          known_uncertainties: [],
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      })
    ).rejects.toThrow(/SPECIFICATION_ASSURANCE_UNAVAILABLE/u);
    expect(service.checkpointer.childWorkflowCallsForParent(identity.run_id)).toHaveLength(0);
    const prospective = childWorkflowRunIdentity({
      call_id: childWorkflowCallId({
        parent_run_id: identity.run_id,
        parent_state_id: "child",
        call_key: "one-decision",
      }),
      parent: identity,
      child_name: "plan",
    });
    expect(service.checkpointer.runExists(prospective.run_id)).toBe(false);
    expect(client.invocations).toHaveLength(0);
  });

  it("preflights a reviewed Define product for the exact prospective child before any Plan worker", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const fixture = genericSpecificationFixture();
    const orientation = summary({
      orientation_complete: true,
      gap_kind: "none",
      repair_owner: "none",
      selected_profile_id: "generic",
      profile_selection_basis: "Caller requested generic.",
      route: "author",
      route_reason: "No outstanding question.",
      clarification_questions: [],
      evidence_questions: [],
      findings: [],
      specification_delta: "Preserve all caller boundaries.",
    });
    const pass = summary({
      verdict: "PASS",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["Exact source checked."],
      specification_delta: "No change required.",
    });
    const approve = summary({
      verdict: "APPROVE",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["Latest specification checked."],
      specification_delta: "No revision required.",
    });
    using producer = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "define",
      modelClient: new ScriptedClient([
        orientation,
        Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
        pass,
        approve,
      ]),
    });
    const produced = await producer.execute({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: "reviewed-source",
        session_id: "reviewed-source",
        playbook: "define",
        engine_owner: "typescript",
      },
      goal: fixture.request.goal,
      constraints: defineRequestConstraints(fixture.request),
      project_root: PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
    });
    if (produced.action !== "complete") throw new Error(`producer ${produced.action}`);
    const specification = produced.artifacts.find((ref) => ref.kind === "specification");
    if (specification === undefined) throw new Error("producer omitted specification");
    const parent = parentRegistration(projectId, false, {
      specification,
      policy: "reviewed_definition",
    });
    const client = new ScriptedClient([]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: new Map([
        ["assess", parent],
        [
          "plan",
          PLAYBOOK_REGISTRY.get("plan") ??
            (() => {
              throw new Error("plan missing");
            })(),
        ],
      ]),
    });
    const identity = {
      schema_version: 2 as const,
      run_id: "strict-child-positive",
      session_id: "strict-child-positive",
      playbook: "assess",
      engine_owner: "typescript" as const,
    };
    await expect(
      service.execute({
        schema_version: 2,
        action: "start",
        identity,
        goal: "Assess child policy.",
        constraints: {
          schema_version: 1,
          target: "fixture",
          criteria: [{ statement: "Review", importance: "required" }],
          supplied_evidence: [],
          hard_constraints: [],
          non_goals: [],
          known_uncertainties: [],
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      })
    ).rejects.toThrow(/child model output is exhausted/u);
    const call = service.checkpointer.childWorkflowCallsForParent(identity.run_id)[0];
    if (call === undefined) throw new Error("preflight did not admit child");
    const child = service.checkpointer.loadRun(call.child_identity);
    const assuranceRef = child.selectedArtifacts.find(
      (ref) => ref.kind === "composition-assurance"
    );
    if (assuranceRef === undefined) throw new Error("child assurance missing");
    expect(JSON.parse(service.artifacts.read(assuranceRef).toString("utf8"))).toMatchObject({
      mode: "reviewed_definition",
      specification_ref: specification,
      consumer: { run_id: call.child_identity.run_id },
    });
    expect(client.invocations.length).toBeGreaterThan(0);
    await expect(
      service.execute({ schema_version: 2, action: "recover", identity })
    ).rejects.toThrow(/child model output is exhausted/u);
    const adopted = service.checkpointer.loadRun(call.child_identity);
    expect(adopted.selectedArtifacts.filter((ref) => ref.kind === "composition-assurance")).toEqual(
      [assuranceRef]
    );
    expect(service.checkpointer.childWorkflowCallsForParent(identity.run_id)).toHaveLength(1);
  });
  it("retains actual no-spec input assurance through the child terminal and consumed result", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const parent = parentRegistration(projectId, false, {
      specification: null,
      policy: "reviewed_definition",
    });
    const core = {
      schema_version: 2,
      disposition: "not_applicable",
      applicability_reason: "No planning work applies to the already completed goal.",
      outcomes: [],
      dependencies: [],
      request_coverage: {
        current_state_fact_indexes: [],
        input_artifact_slots: [],
        hard_constraint_indexes: [],
        non_goal_indexes: [],
        uncertainty_indexes: [],
        prior_decision_indexes: [],
        blocked_desired_outcome_indexes: [],
      },
      blockers: [],
      confidence: "CERTAIN",
      source_item_coverage: [],
      unsupported_strategy_elements: [],
    };
    const client = new ScriptedClient([
      summary({
        orientation_complete: true,
        gap_kind: "none",
        repair_owner: "none",
        findings: ["The request and current state were inspected."],
        strategy_delta: "Assess applicability.",
      }),
      `No planning work applies.\nSTRATEGY_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`,
      summary({
        verdict: "PASS",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["The exact latest product is valid."],
        strategy_delta: "Advance to critique.",
      }),
      summary({
        verdict: "APPROVE",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["The Vera-passed product is usable."],
        strategy_delta: "Approve.",
      }),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: parent,
      childWorkflowRegistry: new Map([
        ["assess", parent],
        [
          "plan",
          PLAYBOOK_REGISTRY.get("plan") ??
            (() => {
              throw new Error("plan missing");
            })(),
        ],
      ]),
    });
    const identity = {
      schema_version: 2 as const,
      run_id: "no-spec-child-parent",
      session_id: "no-spec-child-parent",
      playbook: "assess",
      engine_owner: "typescript" as const,
    };
    const terminal = await service.execute({
      schema_version: 2,
      action: "start",
      identity,
      goal: "Assess child policy.",
      constraints: {
        schema_version: 1,
        target: "fixture",
        criteria: [{ statement: "Review", importance: "required" }],
        supplied_evidence: [],
        hard_constraints: [],
        non_goals: [],
        known_uncertainties: [],
      },
      project_root: PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
    });
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    if (terminal.action !== "incomplete") throw new Error("parent did not consume child");
    const call = service.checkpointer.childWorkflowCallsForParent(identity.run_id)[0];
    if (call === undefined) throw new Error("child call missing");
    expect(call.lifecycle).toBe("consumed");
    const child = service.checkpointer.loadRun(call.child_identity);
    const assurance = child.selectedArtifacts.find((ref) => ref.kind === "composition-assurance");
    if (assurance === undefined) throw new Error("child assurance missing");
    expect(JSON.parse(service.artifacts.read(assurance).toString("utf8"))).toMatchObject({
      mode: "not_applicable",
      specification_ref: null,
    });
    const resultRef = terminal.artifacts.find((ref) => ref.kind === "child-result");
    if (resultRef === undefined) throw new Error("child result missing");
    const result = validateChildWorkflowResult(
      JSON.parse(service.artifacts.read(resultRef).toString("utf8"))
    );
    expect(result.terminal_action).toBe("complete");
    expect(result.artifacts).toContainEqual(assurance);
  });

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

  it("runs a real registered child with exact EvidenceContext, records its native terminal once, and resumes the parent", async () => {
    const env = environment();
    const projectId = loadRuntimeConfig(PROJECT_ROOT, env).projectId;
    const parent = parentRegistration(projectId, true);
    const registry = new Map<string, PlaybookRegistration>([
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
    expect(call.input_artifacts.artifacts).toHaveLength(1);
    const contextBinding = call.input_artifacts.artifacts[0];
    if (contextBinding === undefined) throw new Error("child EvidenceContext binding is absent");
    expect(contextBinding.slot).toBe("evidence_context");
    expect(contextBinding.ref.kind).toBe("evidence-context");
    expect(contextBinding.ref.content_schema).toEqual({
      schema_id: "penny.evidence-context.v1",
      schema_version: 1,
    });
    const context = validateEvidenceContext(
      JSON.parse(service.artifacts.readById(contextBinding.ref.artifact_id).toString("utf8"))
    );
    const statementMarker = context.entries[0]?.statement;
    if (statementMarker === undefined) throw new Error("child EvidenceContext statement is absent");
    expect(client.invocations).toHaveLength(4);
    for (const invocation of client.invocations) {
      expect(
        invocation.inputArtifacts.filter(
          (artifact) => artifact.artifact_id === contextBinding.ref.artifact_id
        )
      ).toEqual([contextBinding.ref]);
      expect(invocation.task).not.toContain(statementMarker);
    }
    const childRun = service.checkpointer.loadRun(call.child_identity);
    const childRequestRef = childRun.selectedArtifacts.find(
      (artifact) => artifact.kind === "decision-request" && artifact.phase === "intake"
    );
    if (childRequestRef === undefined) throw new Error("child native request ref is absent");
    expect(service.artifacts.metadata(childRequestRef).upstream_refs).toEqual([contextBinding.ref]);
    if (call.output_artifact === null) throw new Error("child native terminal ref is absent");
    const decision = validateDecision(
      JSON.parse(service.artifacts.readById(call.output_artifact.artifact_id).toString("utf8"))
    );
    expect(decision.request).toEqual(decisionRequest());
    expect(decision.source_lineage.input_artifact_ids).toEqual([contextBinding.ref.artifact_id]);
    expect(
      service.artifacts
        .metadata(call.output_artifact)
        .upstream_refs.filter((artifact) => artifact.artifact_id === contextBinding.ref.artifact_id)
    ).toEqual([contextBinding.ref]);
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
    const registry = new Map<string, PlaybookRegistration>([
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
    const registry = new Map<string, PlaybookRegistration>([
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
    const registry = new Map<string, PlaybookRegistration>([
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
    const registry = new Map<string, PlaybookRegistration>([
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
