import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ASSESS_PLAYBOOK_REGISTRATION,
  DECIDE_PLAYBOOK_REGISTRATION,
  PLAYBOOK_REGISTRY,
  OrchestrationService,
  canonicalJson,
  initializePennyState,
  loadRuntimeConfig,
  resolvePennyRuntimeState,
  upgradePennyState,
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
import { PiAgentClient } from "../src/model-client.js";
import { decisionRequest } from "../tests/fixtures/decision-fixtures.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
const originalPennyStateRoot = process.env.PENNY_STATE_ROOT;

function selectedOllamaModel(): string {
  return process.env.PENNY_CHILD_WORKFLOW_MODEL_SMOKE_MODEL ?? "qwen3.8:latest";
}

async function environment(): Promise<NodeJS.ProcessEnv> {
  const root = mkdtempSync(path.join(tmpdir(), "penny-child-workflow-live-smoke-"));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  const backupRoot = path.join(root, "backups");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: stateRoot,
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
    PENNY_ORCHESTRATION_HOST_OPERATION_DEADLINE_MS: "120000",
  };
  const initialized = initializePennyState(PROJECT_ROOT, { env });
  const sqlite = process.getBuiltinModule("node:sqlite");
  if (sqlite === undefined) throw new Error("live child smoke requires node:sqlite");
  {
    using database = new sqlite.DatabaseSync(initialized.paths.orchestration.database);
    database.exec("DROP TABLE child_workflow_calls; PRAGMA user_version=10;");
  }
  mkdirSync(backupRoot, { mode: 0o700 });
  const upgrade = await upgradePennyState({
    projectRoot: PROJECT_ROOT,
    backupDirectory: backupRoot,
    rootOptions: { env },
  });
  if (
    !upgrade.changed ||
    upgrade.sourceVersion !== 10 ||
    upgrade.targetVersion !== 12 ||
    upgrade.backupDatabase === null
  ) {
    throw new Error("live child smoke did not complete its required backup-first v10→v12 upgrade");
  }
  resolvePennyRuntimeState(PROJECT_ROOT, { env });
  // artifact_read is a Pi extension and resolves its project partition from process.env.
  // Keep its runtime binding identical to the service's isolated smoke configuration.
  process.env.PENNY_STATE_ROOT = stateRoot;
  return env;
}

/** Pins every real worker session to the caller-approved Ollama model before session creation. */
class PinnedOllamaClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  readonly resolvedModels: { provider: string; model: string }[] = [];
  private readonly delegate: PiAgentClient;

  constructor(
    catalogSessions: { readonly projectId: string; readonly root: string },
    private readonly model: string
  ) {
    this.delegate = new PiAgentClient({ catalogSessions });
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const priorAdmission = invocation.admitResolvedModel;
    return await this.delegate.runAgent({
      ...invocation,
      modelOverride: `ollama/${this.model}`,
      // Keep the opt-in smoke bounded on the local provider; this does not mutate agent SSOT.
      thinkingLevel: "low",
      admitResolvedModel: (resolved) => {
        if (resolved.provider !== "ollama" || resolved.model !== this.model) {
          throw new Error(
            `live child smoke refused resolved model '${resolved.provider}/${resolved.model}'`
          );
        }
        this.resolvedModels.push(resolved);
        priorAdmission?.(resolved);
      },
    });
  }
}

/** A disposable parent that has exactly one registered native child target and never claims success. */
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
        unresolved: ["Smoke parent consumed the child result without claiming parent success."],
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
      principal_id: "principal-child-workflow-live-smoke",
      scope_id: "scope-child-workflow-live-smoke",
      source_policy_id: "source-policy-child-workflow-live-smoke",
      destination_policy_id: "destination-policy-child-workflow-live-smoke",
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
        producer: "host:child-workflow-live-smoke",
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
      throw new Error("missing active lease-bound decide target");
    }
    const directive = validateDirective({
      schema_version: 3,
      action: "invoke_child_workflow",
      identity: context.identity,
      state_id: context.stateId,
      call_key: "one-live-decision",
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
    throw new Error("live smoke parent has no user gate");
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
    throw new Error("live smoke parent has no worker phases");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}

function parentRegistration(projectId: string): PlaybookRegistrationV1 {
  return {
    ...(PLAYBOOK_REGISTRY.get("assess") ?? ASSESS_PLAYBOOK_REGISTRATION),
    construct: (options) => {
      if (options.artifactStore === undefined)
        throw new Error("live smoke parent requires artifacts");
      return new ChildDispatchParent(options.artifactStore, projectId);
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalPennyStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = originalPennyStateRoot;
});

describe("opt-in Ollama active child-workflow smoke", () => {
  it(
    "runs one native child through dispatch, terminal capture, semantic acceptance, and parent resume",
    async () => {
      const env = await environment();
      const config = loadRuntimeConfig(PROJECT_ROOT, env);
      const parent = parentRegistration(config.projectId);
      const registry = new Map<string, PlaybookRegistrationV1>([
        ["assess", parent],
        ["decide", PLAYBOOK_REGISTRY.get("decide") ?? DECIDE_PLAYBOOK_REGISTRATION],
      ]);
      const model = selectedOllamaModel();
      const client = new PinnedOllamaClient(
        {
          projectId: config.projectId,
          root: config.subagentSessionRoot,
        },
        model
      );
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: parent,
        childWorkflowRegistry: registry,
        enableChildWorkflows: true,
      });
      const identity = {
        schema_version: 2 as const,
        run_id: "child-workflow-live-smoke-parent",
        session_id: "child-workflow-live-smoke-parent",
        playbook: "assess",
        engine_owner: "typescript" as const,
      };
      const terminal = await service.execute({
        schema_version: 2,
        action: "start",
        identity,
        goal: "Run one bounded, self-contained active child workflow smoke test.",
        constraints: {
          schema_version: 1,
          target: "A fixed local smoke fixture with no requested external research.",
          criteria: [
            { statement: "Exercises the child dispatch boundary.", importance: "required" },
          ],
          supplied_evidence: [],
          hard_constraints: [
            {
              statement:
                "Use only the supplied fixture; do not perform external research or actions.",
            },
          ],
          non_goals: [{ statement: "Do not make a parent success claim." }],
          known_uncertainties: [],
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      });

      expect(terminal).toMatchObject({ action: "incomplete", met: false });
      expect(client.invocations.map((item) => item.stateId)).toEqual(
        expect.arrayContaining(["analyzing_decision", "deciding"])
      );
      expect(client.resolvedModels).toEqual(
        expect.arrayContaining([{ provider: "ollama", model }])
      );
      expect(client.resolvedModels).toHaveLength(client.invocations.length);
      const calls = service.checkpointer.childWorkflowCallsForParent(identity.run_id);
      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (call === undefined) throw new Error("live child smoke omitted its durable call");
      expect(call).not.toHaveProperty("budget");
      expect(call).toMatchObject({
        schema_version: 2,
        lifecycle: "consumed",
        child_identity: { playbook: "decide" },
        output_artifact: {
          content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
        },
      });
      expect(["complete", "incomplete"]).toContain(call.terminal_action);
      expect(
        service.checkpointer
          .events(identity.run_id)
          .filter((event) => event.eventType === "child_workflow_consumed")
      ).toHaveLength(1);
    },
    10 * 60_000
  );
});
