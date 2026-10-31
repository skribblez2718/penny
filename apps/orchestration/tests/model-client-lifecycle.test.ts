import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineTool, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerTool } from "../../../.pi/lib/pi-tool-registration.js";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real catalog-YAML session creation now serializes each agent's full tool
// surface, which exceeds the 5s default on slower hosts.
vi.setConfig({ testTimeout: 60_000 });

const lifecycleHarness = vi.hoisted(() => ({
  outcomes: [] as Array<
    | "success"
    | "private_success"
    | "provider_error"
    | "aborted"
    | "liveness"
    | "tool_mismatch"
    | "tool_addition"
    | "tool_replacement"
  >,
  events: [] as string[],
  promptCalls: 0,
  partialText:
    'partial αβ\nSUMMARY:{"confidence":"CERTAIN","plan_complete":true,"plan_steps":["first"]}',
  sdkActiveToolSets: [] as Array<readonly string[]>,
  sessionOptions: [] as Array<{
    readonly model: unknown;
    readonly thinkingLevel: unknown;
    readonly noTools: unknown;
    readonly tools: readonly string[] | undefined;
    readonly customTools: readonly string[] | undefined;
  }>,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn(async (...args: Parameters<typeof actual.createAgentSession>) => {
      lifecycleHarness.sessionOptions.push({
        model: args[0]?.model,
        thinkingLevel: args[0]?.thinkingLevel,
        noTools: args[0]?.noTools,
        tools: args[0]?.tools,
        customTools: args[0]?.customTools?.map((tool) => tool.name),
      });
      const outcome = lifecycleHarness.outcomes.shift();
      if (outcome === undefined) throw new Error("lifecycle fixture outcome is absent");
      const requestedTools = args[0]?.tools;
      if (requestedTools === undefined) {
        throw new Error("lifecycle fixture requested tools are absent");
      }
      const created = await actual.createAgentSession(...args);
      lifecycleHarness.sdkActiveToolSets.push([...created.session.getActiveToolNames()]);
      const originalDispose = created.session.dispose.bind(created.session);
      vi.spyOn(created.session, "dispose").mockImplementation(() => {
        lifecycleHarness.events.push("dispose");
        originalDispose();
      });
      if (outcome === "tool_mismatch") {
        created.session.setActiveToolsByName([]);
        return created;
      }
      if (outcome === "tool_addition") {
        vi.spyOn(created.session, "getActiveToolNames").mockReturnValue([
          ...requestedTools,
          "bash",
        ]);
        return created;
      }
      if (outcome === "tool_replacement") {
        vi.spyOn(created.session, "getActiveToolNames").mockReturnValue(["read"]);
        return created;
      }
      if (outcome !== "private_success") {
        vi.spyOn(created.session, "getActiveToolNames").mockReturnValue([...requestedTools]);
      }
      vi.spyOn(created.session, "prompt").mockImplementation(async () => {
        lifecycleHarness.promptCalls += 1;
        if (outcome === "success" || outcome === "private_success") {
          const message = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "complete lifecycle result" }],
            api: "anthropic-messages",
            provider: "lifecycle-fixture",
            model: "lifecycle-fixture",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
          created.session.messages.push(message);
          args[0]?.sessionManager?.appendMessage(message);
          return;
        }
        const message = {
          role: "assistant" as const,
          content:
            outcome === "liveness"
              ? []
              : [
                  { type: "text" as const, text: "partial α" },
                  { type: "thinking" as const, thinking: "not assistant output" },
                  {
                    type: "text" as const,
                    text: lifecycleHarness.partialText.slice("partial α".length),
                  },
                ],
          api: "anthropic-messages",
          provider: "lifecycle-fixture",
          model: "lifecycle-fixture",
          usage: {
            input: 1,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: outcome === "aborted" ? ("aborted" as const) : ("error" as const),
          errorMessage:
            outcome === "liveness"
              ? "external_request_budget_exhausted"
              : "PRIVATE_PROVIDER_ERROR_SENTINEL",
          timestamp: Date.now(),
        };
        created.session.messages.push(message);
        args[0]?.sessionManager?.appendMessage(message);
      });
      return created;
    }),
  };
});

import { ArtifactStore } from "../dist/artifact-store.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { initializePennyState } from "../dist/state/setup.js";
import { OrchestrationService } from "../dist/service.js";
import { ContractValidationError, type Directive } from "../dist/contracts.js";
import { sha256 } from "../dist/checkpointer.js";
import { LivenessExhaustedError } from "../dist/liveness.js";
import { admitImageInputModel } from "../dist/model-vision.js";
import {
  CATALOG_WORKER_CONTINUITY_METADATA,
  CATALOG_WORKER_SESSION_METADATA,
  PiAgentClient,
  createWorkerResourceLoader,
  parseSsotTools,
  validateCatalogWorkerContinuityMetadata,
  type AgentInvocation,
  type InlineExtension,
  type ModelClient,
  type PiAgentClientOptions,
} from "../dist/model-client.js";
import { DECIDE_PLAYBOOK_REGISTRATION } from "../dist/playbooks/decide.js";
import { validateContextSourceRef } from "../dist/skill-contracts/research.js";
import { resolvePlaybook } from "../dist/playbooks/registry.js";
import { WorkerExecutor } from "../dist/worker.js";
import { parseJson, requireRecord } from "./helpers/narrowing.js";

import {
  writeModelSelectionFixture,
  FIXTURE_HEAVY_MODEL_ID,
} from "./helpers/model-selection-fixture.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temporaryRoots: string[] = [];

function temporaryProject(catalog: "linked" | "copied" | "absent" = "linked"): {
  readonly projectRoot: string;
  readonly sessionRoot: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "penny-model-client-lifecycle-"));
  temporaryRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "subagent-sessions");
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
  if (catalog === "linked") {
    symlinkSync(path.join(PROJECT_ROOT, ".pi"), path.join(projectRoot, ".pi"), "dir");
  } else if (catalog === "copied") {
    const piRoot = path.join(projectRoot, ".pi");
    mkdirSync(piRoot, { recursive: true, mode: 0o700 });
    cpSync(path.join(PROJECT_ROOT, ".pi", "agents"), path.join(piRoot, "agents"), {
      recursive: true,
    });
    cpSync(
      path.join(PROJECT_ROOT, ".pi", "skills", "research"),
      path.join(piRoot, "skills", "research"),
      {
        recursive: true,
      }
    );
  }
  writeFileSync(path.join(projectRoot, "AGENTS.md"), "Canonical project index sentinel");
  mkdirSync(path.join(projectRoot, "docs", "agents"), { recursive: true, mode: 0o700 });
  cpSync(
    path.join(PROJECT_ROOT, "docs", "agents", "writing"),
    path.join(projectRoot, "docs", "agents", "writing"),
    { recursive: true }
  );
  if (catalog === "copied") {
    cpSync(path.join(PROJECT_ROOT, ".pi", "SYSTEM.md"), path.join(projectRoot, ".pi", "SYSTEM.md"));
  }
  return { projectRoot, sessionRoot };
}

function offlineSessionRuntime(): NonNullable<PiAgentClientOptions["sessionRuntime"]> {
  return {
    settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "high" }),
    noAmbientExtensions: true,
    attach: () => () => {},
  };
}

function trackedResourceExtension(): {
  readonly extension: InlineExtension;
  readonly isOpen: () => boolean;
} {
  let timer: NodeJS.Timeout | undefined;
  const extension: InlineExtension = (pi) => {
    if (timer !== undefined) throw new Error("tracked lifecycle resource was opened twice");
    timer = setInterval(() => {}, 60_000);
    lifecycleHarness.events.push("resource_open");
    pi.on("session_shutdown", async (event) => {
      lifecycleHarness.events.push(`shutdown_${event.reason}_start`);
      await Promise.resolve();
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      lifecycleHarness.events.push(`shutdown_${event.reason}_end`);
    });
  };
  return { extension, isOpen: () => timer !== undefined };
}

function invocation(projectRoot: string, runId: string): AgentInvocation {
  const registration = resolvePlaybook("research");
  if (registration === undefined || registration.worker.kind !== "catalog-agent") {
    throw new Error("research catalog registration is absent");
  }
  return {
    agent: "echo",
    stateId: "researching",
    task: "Return the provider-free lifecycle fixture.",
    projectRoot,
    trustProfile: "trusted-interactive",
    inputArtifacts: [],
    workflowSession: {
      run_id: runId,
      workflow_session_id: `workflow-${runId}`,
      branch_id: null,
      attempt: 1,
      worker_id: `worker-${runId}`,
      purpose: "phase",
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
}

function workerDirective(input: {
  readonly runId: string;
  readonly modelOverride: string;
}): Extract<Directive, { action: "invoke_agent" }> {
  return {
    schema_version: 2,
    action: "invoke_agent",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: `session-${input.runId}`,
      playbook: "research",
      engine_owner: "typescript",
    },
    state_id: "planning",
    agent: "piper",
    attempt: 1,
    trust_profile: "hardened-untrusted",
    model_override: input.modelOverride,
    task: "Exercise generic-child YAML admission.",
    input_artifacts: { schema_version: 2, artifacts: [] },
    output_artifact: {
      schema_version: 2,
      run_id: input.runId,
      phase: "planning",
      branch_id: null,
      kind: "agent-output",
      operation_id: `operation-${input.runId}`,
      version: 1,
      producer: "agent:piper",
      media_type: "text/plain; charset=utf-8",
      parent_ref: null,
      upstream_refs: [],
    },
  };
}

function decideCandidateInvocation(input: {
  readonly projectRoot: string;
  readonly runId: string;
  readonly allowedTools?: readonly string[];
  readonly trustProfile?: AgentInvocation["trustProfile"];
  readonly task?: string;
}): AgentInvocation {
  const worker = DECIDE_PLAYBOOK_REGISTRATION.worker;
  if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
  const phase = worker.phases.get("deciding");
  if (phase === undefined) throw new Error("deciding phase is absent");
  const base = invocation(input.projectRoot, input.runId);
  return {
    ...base,
    agent: phase.agent,
    stateId: "deciding",
    trustProfile: input.trustProfile ?? base.trustProfile,
    task: input.task ?? base.task,
    registration: {
      playbook_name: DECIDE_PLAYBOOK_REGISTRATION.name,
      workflow_name: worker.workflow_name,
      guidance: worker.guidance,
      result_transport: worker.result_transport,
      opening_policy: worker.opening_policy,
      model_policy: worker.model_policy,
      ...(input.allowedTools === undefined ? {} : { allowed_tools: input.allowedTools }),
    },
  };
}

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "penny-lifecycle-model-config-"));
  temporaryRoots.push(root);
  writeModelSelectionFixture(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
});

afterEach(() => {
  lifecycleHarness.outcomes.length = 0;
  lifecycleHarness.events.length = 0;
  lifecycleHarness.promptCalls = 0;
  lifecycleHarness.sdkActiveToolSets.length = 0;
  lifecycleHarness.sessionOptions.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PiAgentClient created-session lifecycle", () => {
  it.each(["phase", "routing_repair"] as const)(
    "refuses throwing and duplicate factories before model/session creation for %s",
    async (purpose) => {
      const { projectRoot } = temporaryProject("copied");
      const sentinel = "PRIVATE_FACTORY_SENTINEL bearer=synthetic-secret /private/input";
      const reader: InlineExtension = (pi) => {
        registerTool(pi, {
          name: "artifact_read",
          label: "Fixture reader",
          description: "Registration-only fixture; never invoked.",
          parameters: Type.Object({}),
          execute: async () => ({ content: [], details: {} }),
        });
      };
      const scenarios = [
        {
          factories: [
            {
              name: sentinel,
              factory: () => {
                throw new Error(sentinel);
              },
            },
          ],
          classification: "EXTENSION_LOAD_ERROR",
        },
        {
          factories: [
            {
              name: "artifact-worker-read",
              factory: () => {
                throw new Error(`ORCHESTRATION_BUILD_STALE: ${sentinel}`);
              },
            },
          ],
          classification: "ORCHESTRATION_BUILD_STALE",
        },
        {
          factories: [
            {
              name: "artifact-worker-read",
              factory: () => {
                throw new Error("Installed artifact reader unavailable");
              },
            },
          ],
          classification: "INSTALLED_ARTIFACT_READER_UNAVAILABLE",
        },
        {
          factories: [{ name: sentinel, factory: reader }, reader],
          classification: "EXTENSION_CONFLICT",
        },
      ];
      for (const [index, scenario] of scenarios.entries()) {
        const resolveModel = vi.fn((): never => {
          throw new Error("model must not resolve");
        });
        const attach = vi.fn(() => () => {});
        const client = new PiAgentClient({
          resolveModel,
          workerExtensions: scenario.factories,
          sessionRuntime: {
            settingsManager: SettingsManager.inMemory(),
            noAmbientExtensions: true,
            attach,
          },
        });
        const base = invocation(projectRoot, `factory-${purpose}-${index}`);
        const active: AgentInvocation = {
          ...base,
          executionPurpose: purpose,
          ...(purpose === "routing_repair"
            ? { routingRepairGuidance: "Return SUMMARY only." }
            : {}),
          workflowSession: {
            ...base.workflowSession,
            run_id: `factory-${index}`,
            workflow_session_id: `factory-${index}`,
            branch_id: null,
            attempt: 1,
            worker_id: `factory-${index}`,
            purpose,
          },
          registration: { ...base.registration, allowed_tools: ["artifact_read"] },
        };
        let failure: unknown;
        try {
          await client.runAgent(active);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(ContractValidationError);
        if (!(failure instanceof ContractValidationError))
          throw new Error("expected loader refusal");
        expect(failure).toHaveProperty("code", "WORKER_EXTENSION_LOAD_FAILED");
        expect(failure.message).toContain(scenario.classification);
        if (index === 1 || index === 2)
          expect(failure.message).toContain("installed_artifact_reader");
        const disclosed = `${String(failure)} ${JSON.stringify(failure)} ${failure.stack}`;
        expect(disclosed).not.toContain(sentinel);
        expect(disclosed).not.toContain("synthetic-secret");
        expect(failure.message).not.toContain("missing=[artifact_read]");
        expect(resolveModel).not.toHaveBeenCalled();
        expect(attach).not.toHaveBeenCalled();
        expect(lifecycleHarness.sessionOptions).toHaveLength(0);
        expect(lifecycleHarness.promptCalls).toBe(0);
      }
    }
  );

  it("bounds real SDK loader diagnostics without forwarding unknown bodies, paths or causes", async () => {
    const { projectRoot } = temporaryProject("copied");
    const sentinel = "PRIVATE_ERROR_PATH_SENTINEL";
    const message = `${sentinel} token=not-a-real-secret ${"x".repeat(10_000)}`;
    const factories: InlineExtension[] = Array.from({ length: 100 }, (_, index) => ({
      name: `/private/${sentinel}/${index}`,
      factory: () => {
        throw new Error(message);
      },
    }));
    factories.push({
      name: "artifact-worker-read",
      factory: () => {
        throw new Error(`ORCHESTRATION_BUILD_STALE: ${message}`);
      },
    });
    const load = async () => {
      try {
        await createWorkerResourceLoader(projectRoot, factories, undefined, {
          settingsManager: SettingsManager.inMemory(),
          noAmbientExtensions: true,
          attach: () => () => {},
        });
      } catch (error) {
        if (error instanceof ContractValidationError) return error;
        throw error;
      }
      throw new Error("expected loader refusal");
    };
    const first = await load();
    const repeated = await load();
    expect(first.message).toBe(repeated.message);
    expect(first.message.length).toBeLessThan(4096);
    expect(first.issues[0]).toContain("extension_errors=101; omitted=93");
    expect(first.issues.slice(1)).toHaveLength(8);
    expect(first.issues[0]).toContain("installed_reader_errors=1; stale_build_errors=1");
    for (const [index, issue] of first.issues.slice(1).entries()) {
      expect(requireRecord(parseJson(issue), "safe extension diagnostic")).toEqual({
        source: index === 0 ? "installed_artifact_reader" : "inline_extension",
        classification: index === 0 ? "ORCHESTRATION_BUILD_STALE" : "EXTENSION_LOAD_ERROR",
        path_sha256: sha256(
          index === 0
            ? "<inline:artifact-worker-read>"
            : `<inline:/private/${sentinel}/${index - 1}>`
        ),
        error_sha256: sha256(index === 0 ? `ORCHESTRATION_BUILD_STALE: ${message}` : message),
      });
    }
    expect(JSON.stringify(first)).not.toContain(sentinel);
    expect(first).not.toHaveProperty("cause");
    expect(lifecycleHarness.sessionOptions).toHaveLength(0);
    expect(lifecycleHarness.promptCalls).toBe(0);
  });

  it.each(["phase", "routing_repair"] as const)(
    "retains final exact equality refusal for a silently non-registering reader during %s",
    async (purpose) => {
      const { projectRoot } = temporaryProject("copied");
      const base = invocation(projectRoot, `silent-${purpose}`);
      const active: AgentInvocation = {
        ...base,
        executionPurpose: purpose,
        ...(purpose === "routing_repair" ? { routingRepairGuidance: "Return SUMMARY only." } : {}),
        workflowSession: {
          run_id: "silent",
          workflow_session_id: "silent",
          branch_id: null,
          attempt: 1,
          worker_id: "silent",
          purpose,
        },
        registration: { ...base.registration, allowed_tools: ["artifact_read"] },
      };
      const attach = vi.fn(() => () => {});
      const client = new PiAgentClient({
        workerExtensions: [{ name: "artifact-worker-read", factory: () => {} }],
        testOnlySessionManagerFactory: () => SessionManager.inMemory(projectRoot),
        sessionRuntime: {
          settingsManager: SettingsManager.inMemory(),
          noAmbientExtensions: true,
          attach,
        },
      });
      // Do not mask real SDK tool activation with the lifecycle harness's ordinary success seam.
      lifecycleHarness.outcomes.push("private_success");
      await expect(client.runAgent(active)).rejects.toThrow(
        /tool surface mismatch before model invocation; missing=\[artifact_read\]/u
      );
      expect(lifecycleHarness.sdkActiveToolSets).toEqual([[]]);
      expect(lifecycleHarness.sessionOptions).toHaveLength(1);
      expect(lifecycleHarness.promptCalls).toBe(0);
      expect(attach).not.toHaveBeenCalled();
    }
  );

  it("refuses an unbound generic-child YAML carrier before resource, session, or model work even when the catalog appears later", async () => {
    const { projectRoot, sessionRoot } = temporaryProject("absent");
    const tracked = trackedResourceExtension();
    const modelResolver = vi.fn((): never => {
      throw new Error("model resolution must not run");
    });
    const piClient = new PiAgentClient({
      resolveModel: modelResolver,
      workerExtensions: [tracked.extension],
      catalogSessions: {
        projectId: `prj_${"3".repeat(32)}`,
        root: sessionRoot,
      },
    });
    const captured: AgentInvocation[] = [];
    const bridge: ModelClient = {
      async runAgent(activeInvocation) {
        captured.push(activeInvocation);
        symlinkSync(path.join(PROJECT_ROOT, ".pi"), path.join(projectRoot, ".pi"), "dir");
        return piClient.runAgent(activeInvocation);
      },
    };
    const registration = resolvePlaybook("research");
    if (registration === undefined) throw new Error("research registration is absent");
    using artifacts = new ArtifactStore(path.join(path.dirname(projectRoot), "artifacts-unbound"));
    const worker = new WorkerExecutor(bridge, artifacts, {
      projectRoot,
      parallelConcurrency: 1,
      registration,
    });

    await expect(
      worker.execute(
        workerDirective({
          runId: "unbound-generic-child-yaml",
          modelOverride: "must-not/resolve",
        })
      )
    ).rejects.toThrow(/unbound generic child YAML authority/u);

    expect(captured).toHaveLength(1);
    const activeInvocation = captured[0];
    if (activeInvocation === undefined) throw new Error("worker invocation was not captured");
    expect(activeInvocation.registration.generic_child_yaml_authority).toEqual({
      carrier: "catalog_agent_yaml_maximum",
      allowed_tools: null,
    });
    expect(modelResolver).not.toHaveBeenCalled();
    expect(lifecycleHarness.sessionOptions).toHaveLength(0);
    expect(lifecycleHarness.promptCalls).toBe(0);
    expect(lifecycleHarness.events).toEqual([]);
    expect(tracked.isOpen()).toBe(false);
  });

  it("accepts an anonymous host-private exact custom-tool session without catalog or generic-child authority", async () => {
    const { projectRoot } = temporaryProject("absent");
    const exactToolNames = ["read_private_fixture"] as const;
    const customTools = [
      defineTool({
        name: exactToolNames[0],
        label: "Read private fixture",
        description: "Read one host-private fixture through a closed offline test tool.",
        parameters: Type.Object(
          { schema_version: Type.Literal(1) },
          { additionalProperties: false }
        ),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "private fixture" }],
            details: { schema_version: 1 as const },
          };
        },
      }),
    ];
    const privateInvocation: AgentInvocation = {
      agent: "anonymous-private-regression",
      stateId: "query",
      task: "Exercise the offline anonymous private-session lifecycle.",
      projectRoot,
      trustProfile: "hardened-untrusted",
      inputArtifacts: [],
      registration: {
        playbook_name: "knowledge-base",
        workflow_name: "knowledge-base",
        guidance: {
          skill_root: ".pi/skills/knowledge-base/assets/prompts",
          resolution: "per_agent_phase",
        },
        result_transport: "host_typed",
        opening_policy: "host_private_opening",
        model_policy: "host_private_ssot_model",
      },
      session: {
        isolatedSystemPrompt: "Anonymous host-private regression system prompt.",
        noTools: "all",
        tools: exactToolNames,
        customTools,
        opening: "Return the offline typed fixture.",
        readResult: () => "typed private result",
      },
    };
    expect(privateInvocation.registration).not.toHaveProperty("allowed_tools");
    expect(privateInvocation.registration).not.toHaveProperty("generic_child_yaml_authority");
    expect(customTools).not.toHaveLength(0);

    lifecycleHarness.outcomes.push("private_success");
    const client = new PiAgentClient();
    await expect(client.runAgent(privateInvocation)).resolves.toEqual({
      text: "typed private result",
    });

    expect(lifecycleHarness.sessionOptions).toEqual([
      {
        model: undefined,
        thinkingLevel: undefined,
        noTools: "all",
        tools: exactToolNames,
        customTools: exactToolNames,
      },
    ]);
    expect(lifecycleHarness.sdkActiveToolSets).toEqual([exactToolNames]);
    expect(lifecycleHarness.sdkActiveToolSets[0]).not.toContain("artifact_read");
    expect(lifecycleHarness.sdkActiveToolSets[0]).not.toContain("bash");
    expect(lifecycleHarness.promptCalls).toBe(1);
  });

  it("refuses YAML drift introduced after worker validation and before Pi session admission", async () => {
    const { projectRoot, sessionRoot } = temporaryProject("copied");
    const definitionPath = path.join(projectRoot, ".pi", "agents", "piper.md");
    const original = readFileSync(definitionPath, "utf8");
    const boundYamlMaximum = parseSsotTools(original, "piper");
    const changedTools = boundYamlMaximum.slice(1);
    if (changedTools.length === 0) throw new Error("Piper YAML maximum is unexpectedly singular");
    const tracked = trackedResourceExtension();
    const modelResolver = vi.fn((): never => {
      throw new Error("model resolution must not run");
    });
    const piClient = new PiAgentClient({
      resolveModel: modelResolver,
      workerExtensions: [tracked.extension],
      catalogSessions: {
        projectId: `prj_${"4".repeat(32)}`,
        root: sessionRoot,
      },
    });
    const captured: AgentInvocation[] = [];
    const bridge: ModelClient = {
      async runAgent(activeInvocation) {
        captured.push(activeInvocation);
        writeFileSync(
          definitionPath,
          original.replace(/^tools:.*$/mu, `tools: ${changedTools.join(", ")}`),
          "utf8"
        );
        return piClient.runAgent(activeInvocation);
      },
    };
    const registration = resolvePlaybook("research");
    if (registration === undefined) throw new Error("research registration is absent");
    using artifacts = new ArtifactStore(path.join(path.dirname(projectRoot), "artifacts-drift"));
    const worker = new WorkerExecutor(bridge, artifacts, {
      projectRoot,
      parallelConcurrency: 1,
      registration,
    });

    await expect(
      worker.execute(
        workerDirective({
          runId: "post-validation-generic-child-yaml-drift",
          modelOverride: "must-not/resolve",
        })
      )
    ).rejects.toThrow(/generic child YAML authority drifted after registration binding/u);

    expect(captured).toHaveLength(1);
    const activeInvocation = captured[0];
    if (activeInvocation === undefined) throw new Error("worker invocation was not captured");
    expect(activeInvocation.registration.generic_child_yaml_authority).toEqual({
      carrier: "catalog_agent_yaml_maximum",
      allowed_tools: boundYamlMaximum,
    });
    expect(modelResolver).not.toHaveBeenCalled();
    expect(lifecycleHarness.sessionOptions).toHaveLength(0);
    expect(lifecycleHarness.promptCalls).toBe(0);
    expect(lifecycleHarness.events).toEqual([]);
    expect(tracked.isOpen()).toBe(false);
  });

  it.each([
    { label: "Cognitive Frame", relative: [".pi", "SYSTEM.md"] },
    { label: "root index", relative: ["AGENTS.md"] },
    { label: "role", relative: [".pi", "agents", "piper.md"] },
    {
      label: "phase guidance",
      relative: [".pi", "skills", "research", "assets", "prompts", "piper-planning.md"],
    },
  ])("refuses $label drift introduced after worker validation", async ({ label, relative }) => {
    const { projectRoot, sessionRoot } = temporaryProject("copied");
    const sourcePath = path.join(projectRoot, ...relative);
    const original = readFileSync(sourcePath, "utf8");
    const modelResolver = vi.fn((): never => {
      throw new Error("model resolution must not run");
    });
    const piClient = new PiAgentClient({
      resolveModel: modelResolver,
      catalogSessions: {
        projectId: `prj_${"d".repeat(32)}`,
        root: sessionRoot,
      },
    });
    const bridge: ModelClient = {
      async runAgent(activeInvocation) {
        writeFileSync(sourcePath, `${original}\nDrifted after binding.\n`, "utf8");
        return piClient.runAgent(activeInvocation);
      },
    };
    const registration = resolvePlaybook("research");
    if (registration === undefined) throw new Error("research registration is absent");
    using artifacts = new ArtifactStore(
      path.join(path.dirname(projectRoot), `artifacts-${label.replaceAll(" ", "-")}-drift`)
    );
    const worker = new WorkerExecutor(bridge, artifacts, {
      projectRoot,
      parallelConcurrency: 1,
      registration,
    });

    await expect(
      worker.execute(
        workerDirective({
          runId: `post-validation-${label.replaceAll(" ", "-")}-drift`,
          modelOverride: "must-not/resolve",
        })
      )
    ).rejects.toThrow(/Static prompt source binding drifted/u);
    expect(modelResolver).not.toHaveBeenCalled();
    expect(lifecycleHarness.sessionOptions).toHaveLength(0);
  });

  it("activates exact Demetri YAML for an ordinary Decide workflow phase", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    expect(DECIDE_PLAYBOOK_REGISTRATION.liveness.thinking_policy).toBe("agent_ssot");
    const worker = DECIDE_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const phase = worker.phases.get("deciding");
    if (phase === undefined) throw new Error("deciding phase is absent");
    expect(phase).not.toHaveProperty("allowed_tools");
    const expected = parseSsotTools(
      readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", "demetri.md"), "utf8"),
      "demetri"
    );
    const client = new PiAgentClient({
      sessionRuntime: offlineSessionRuntime(),
      catalogSessions: {
        projectId: `prj_${"d".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("success");
    await client.runAgent(
      decideCandidateInvocation({
        projectRoot,
        runId: "candidate-yaml-tools",
      })
    );
    expect(lifecycleHarness.sessionOptions[0]?.tools).toEqual(expected);
    expect(lifecycleHarness.sessionOptions[0]?.thinkingLevel).toBe("xhigh");
    expect(lifecycleHarness.sessionOptions[0]?.tools).toContain("artifact_read");
    expect(lifecycleHarness.sessionOptions[0]?.tools).toContain("web_search");
  });

  it("persists closed worker continuity metadata before the first model prompt", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const projectId = `prj_${"c".repeat(32)}`;
    const task = "Choose the bounded candidate without losing this exact assignment.";
    const invocationValue = decideCandidateInvocation({
      projectRoot,
      runId: "continuity-metadata",
      task,
    });
    const client = new PiAgentClient({ catalogSessions: { projectId, root: sessionRoot } });
    lifecycleHarness.outcomes.push("success");

    await client.runAgent(invocationValue);

    const files = readdirSync(path.join(sessionRoot, "demetri"));
    expect(files).toHaveLength(1);
    const entries = readFileSync(path.join(sessionRoot, "demetri", files[0] ?? ""), "utf8")
      .trim()
      .split("\n")
      .map((line, index) => requireRecord(parseJson(line), `catalog session entry ${index}`));
    const correlationIndex = entries.findIndex(
      (entry) => entry.customType === CATALOG_WORKER_SESSION_METADATA
    );
    const continuityIndex = entries.findIndex(
      (entry) => entry.customType === CATALOG_WORKER_CONTINUITY_METADATA
    );
    expect(correlationIndex).toBeGreaterThan(0);
    expect(continuityIndex).toBeGreaterThan(correlationIndex);
    const continuityEntry = entries[continuityIndex];
    if (continuityEntry === undefined) throw new Error("continuity entry is absent");
    const continuity = validateCatalogWorkerContinuityMetadata(continuityEntry.data);
    expect(continuity).toMatchObject({
      schema_version: 1,
      project_id: projectId,
      run_id: "continuity-metadata",
      state_id: "deciding",
      branch_id: null,
      agent: "demetri",
      purpose: "phase",
      task,
      input_artifacts: [],
    });
    expect(continuity.registered_guidance.length).toBeGreaterThan(0);
    expect(continuity.compaction_continuity.mode).toBe("exact_opening");
    if (continuity.compaction_continuity.mode !== "exact_opening") {
      throw new Error("catalog worker did not persist its exact opening");
    }
    expect(continuity.compaction_continuity.opening).toContain(
      "You are executing the 'demetri' role"
    );
    expect(continuity.compaction_continuity.opening).toContain(task);
    expect(continuity.compaction_continuity.opening).toContain("Return the complete stage output");

    expect(() =>
      validateCatalogWorkerContinuityMetadata({ ...continuity, unexpected: true })
    ).toThrow(/catalog worker continuity metadata/u);
  });

  it("marks owner-resolved context for Pi default compaction without copying it into the companion", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const projectId = `prj_${"b".repeat(32)}`;
    const fixture = requireRecord(
      parseJson(
        readFileSync(
          path.join(
            PROJECT_ROOT,
            "apps",
            "orchestration",
            "tests",
            "fixtures",
            "skills",
            "research",
            "positive-vectors.json"
          ),
          "utf8"
        )
      ),
      "research positive vectors"
    );
    const source = validateContextSourceRef(fixture.context_source_ref);
    const privateSentinel = "PRIVATE OWNER-RESOLVED BODY MUST NOT ENTER THE COMPANION";
    const invocationValue: AgentInvocation = {
      ...decideCandidateInvocation({
        projectRoot,
        runId: "private-context-continuity-mode",
      }),
      contextOverlays: [{ source, content: privateSentinel }],
    };
    const client = new PiAgentClient({ catalogSessions: { projectId, root: sessionRoot } });
    lifecycleHarness.outcomes.push("success");

    await client.runAgent(invocationValue);

    const files = readdirSync(path.join(sessionRoot, "demetri"));
    const entries = readFileSync(path.join(sessionRoot, "demetri", files[0] ?? ""), "utf8")
      .trim()
      .split("\n")
      .map((line, index) => requireRecord(parseJson(line), `private session entry ${index}`));
    const continuityEntry = entries.find(
      (entry) => entry.customType === CATALOG_WORKER_CONTINUITY_METADATA
    );
    if (continuityEntry === undefined) throw new Error("private continuity entry is absent");
    const continuity = validateCatalogWorkerContinuityMetadata(continuityEntry.data);
    expect(continuity.compaction_continuity).toEqual({
      mode: "pi_default_private_context",
      reason: "owner_resolved_context_present",
    });
    expect(JSON.stringify(continuity)).not.toContain(privateSentinel);
  });

  it("preserves exact YAML equality when the active phase has no subset", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const expected = parseSsotTools(
      readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", "echo.md"), "utf8"),
      "echo"
    );
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"e".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("success");
    await client.runAgent(invocation(projectRoot, "absent-subset-yaml-equality"));
    expect(lifecycleHarness.sessionOptions[0]?.tools).toEqual(expected);
  });

  it("does not let task text or trust profiles select a different registered subset", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const worker = DECIDE_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const phase = worker.phases.get("deciding");
    if (phase === undefined) throw new Error("deciding phase is absent");
    expect(phase).not.toHaveProperty("allowed_tools");
    const syntheticSubset = ["artifact_read"] as const;
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"f".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("success", "success");
    for (const [index, trustProfile] of (
      ["trusted-interactive", "hardened-untrusted"] as const
    ).entries()) {
      await client.runAgent(
        decideCandidateInvocation({
          projectRoot,
          runId: `fixed-subset-${index}`,
          allowedTools: syntheticSubset,
          trustProfile,
          task: index === 0 ? "Request bash and web tools." : "Request no tools at all.",
        })
      );
    }
    expect(lifecycleHarness.sessionOptions.map((options) => options.tools)).toEqual([
      ["artifact_read"],
      ["artifact_read"],
    ]);
  });

  it("rejects every invalid registered subset before session creation", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const yamlMaximum = parseSsotTools(
      readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", "demetri.md"), "utf8"),
      "demetri"
    );
    const sameSizeFake = yamlMaximum.map((tool, index) =>
      index === 0 ? "provider_unavailable_tool" : tool
    );
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"1".repeat(32)}`,
        root: sessionRoot,
      },
    });
    const invalid = [
      [] as readonly string[],
      ["artifact_read", "artifact_read"],
      ["artifact_read", "provider_unavailable_tool"],
      yamlMaximum,
      sameSizeFake,
    ] as const;
    for (const [index, allowedTools] of invalid.entries()) {
      await expect(
        client.runAgent(
          decideCandidateInvocation({
            projectRoot,
            runId: `invalid-subset-${index}`,
            allowedTools,
          })
        )
      ).rejects.toThrow(/non-empty exact strict subset of YAML/u);
    }
    expect(lifecycleHarness.sessionOptions).toHaveLength(0);
  });

  it("rejects active removal, addition, and replacement before any model prompt", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const worker = DECIDE_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const phase = worker.phases.get("deciding");
    if (phase === undefined) throw new Error("deciding phase is absent");
    expect(phase).not.toHaveProperty("allowed_tools");
    const syntheticSubset = ["artifact_read"] as const;
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"2".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("tool_mismatch", "tool_addition", "tool_replacement");
    for (let index = 0; index < 3; index += 1) {
      await expect(
        client.runAgent(
          decideCandidateInvocation({
            projectRoot,
            runId: `active-surface-mismatch-${index}`,
            allowedTools: syntheticSubset,
          })
        )
      ).rejects.toThrow(/tool surface mismatch before model invocation/u);
    }
    expect(lifecycleHarness.sessionOptions).toHaveLength(3);
    expect(lifecycleHarness.promptCalls).toBe(0);
  });

  it("rechecks admitted image capability before override session creation and again before prompt", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const baseModel = {
      id: "vision-model",
      name: "Vision Model",
      api: "openai-completions",
      provider: "fixture-provider",
      baseUrl: "http://127.0.0.1:1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 4_096,
    } satisfies Awaited<ReturnType<NonNullable<PiAgentClientOptions["resolveModel"]>>>;
    const admitted = admitImageInputModel(baseModel);
    const textOnlyModel = { ...baseModel, input: ["text" as const] };
    const refusingClient = new PiAgentClient({
      resolveModel: () => textOnlyModel,
      catalogSessions: {
        projectId: `prj_${"d".repeat(32)}`,
        root: sessionRoot,
      },
    });

    await expect(
      refusingClient.runAgent({
        ...invocation(projectRoot, "vision-refused"),
        modelOverride: "fixture-provider/vision-model",
        requiredImageCapability: admitted,
      })
    ).rejects.toMatchObject({ code: "MODEL_IMAGE_INPUT_UNSUPPORTED" });
    const registrationOwnedRefusal = invocation(projectRoot, "vision-registration-refused");
    await expect(
      refusingClient.runAgent({
        ...registrationOwnedRefusal,
        modelOverride: "fixture-provider/vision-model",
        registration: {
          ...registrationOwnedRefusal.registration,
          requires_image_input: true,
        },
      })
    ).rejects.toMatchObject({ code: "MODEL_IMAGE_INPUT_UNSUPPORTED" });
    expect(lifecycleHarness.sessionOptions).toHaveLength(0);
    expect(lifecycleHarness.promptCalls).toBe(0);

    const acceptingClient = new PiAgentClient({
      resolveModel: () => baseModel,
      catalogSessions: {
        projectId: `prj_${"d".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("success", "success");
    await acceptingClient.runAgent({
      ...invocation(projectRoot, "vision-accepted"),
      modelOverride: "fixture-provider/vision-model",
      requiredImageCapability: admitted,
    });
    const registrationOwnedAcceptance = invocation(projectRoot, "vision-registration-accepted");
    await acceptingClient.runAgent({
      ...registrationOwnedAcceptance,
      modelOverride: "fixture-provider/vision-model",
      registration: {
        ...registrationOwnedAcceptance.registration,
        requires_image_input: true,
      },
    });
    expect(lifecycleHarness.sessionOptions).toHaveLength(2);
    expect(lifecycleHarness.promptCalls).toBe(2);
  });

  it("passes model and thinking with explicit research preset, test seam, then catalog YAML precedence", async () => {
    const { projectRoot, sessionRoot } = temporaryProject("copied");
    const definition = path.join(projectRoot, ".pi", "agents", "echo.md");
    writeFileSync(
      definition,
      readFileSync(definition, "utf8").replace("thinking: xhigh", 'thinking: "off"')
    );
    const fixtureModel = {
      id: "fixture-model",
      name: "Fixture Model",
      api: "openai-completions",
      provider: "fixture-provider",
      baseUrl: "http://127.0.0.1:1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 4_096,
    } satisfies Awaited<ReturnType<NonNullable<PiAgentClientOptions["resolveModel"]>>>;
    const client = new PiAgentClient({
      resolveModel: (requested, provider) => {
        if (requested === "sol" && provider === "openai-codex") {
          return { ...fixtureModel, id: FIXTURE_HEAVY_MODEL_ID, name: "sol", provider };
        }
        return fixtureModel;
      },
      testOnlyThinkingLevelOverride: "low",
      sessionRuntime: offlineSessionRuntime(),
      catalogSessions: {
        projectId: `prj_${"c".repeat(32)}`,
        root: sessionRoot,
      },
    });

    const boundSessionModels: Array<{ provider: string; model: string }> = [];
    lifecycleHarness.outcomes.push("success", "success");
    await client.runAgent({
      ...invocation(projectRoot, "host-thinking"),
      modelOverride: "fixture-provider/fixture-model",
      thinkingLevel: "medium",
      bindResolvedSessionModel: (resolved) => {
        expect(lifecycleHarness.sdkActiveToolSets).toHaveLength(1);
        expect(lifecycleHarness.promptCalls).toBe(0);
        boundSessionModels.push(resolved);
      },
    });
    await client.runAgent(invocation(projectRoot, "test-thinking"));

    const normalClient = new PiAgentClient({
      sessionRuntime: offlineSessionRuntime(),
      catalogSessions: {
        projectId: `prj_${"c".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("success");
    await normalClient.runAgent(invocation(projectRoot, "catalog-thinking"));

    expect(boundSessionModels).toEqual([{ provider: "fixture-provider", model: "fixture-model" }]);
    expect(lifecycleHarness.sessionOptions.map(({ thinkingLevel }) => thinkingLevel)).toEqual([
      "medium",
      "low",
      "off",
    ]);
    expect(lifecycleHarness.sessionOptions.slice(0, 2).map(({ model }) => model)).toEqual([
      fixtureModel,
      { ...fixtureModel, id: FIXTURE_HEAVY_MODEL_ID, name: "sol", provider: "openai-codex" },
    ]);
    expect(lifecycleHarness.sessionOptions[2]).toMatchObject({
      model: { id: FIXTURE_HEAVY_MODEL_ID, name: "sol", provider: "openai-codex" },
    });
  }, 60_000);

  it.each(["provider_error", "aborted"] as const)(
    "rejects %s partial output through WorkerExecutor before any success receipt and awaits teardown",
    async (outcome) => {
      const { projectRoot, sessionRoot } = temporaryProject();
      const tracked = trackedResourceExtension();
      const client = new PiAgentClient({
        workerExtensions: [tracked.extension],
        sessionRuntime: offlineSessionRuntime(),
        catalogSessions: { projectId: `prj_${"e".repeat(32)}`, root: sessionRoot },
      });
      using artifacts = new ArtifactStore(path.join(path.dirname(projectRoot), "failed-artifacts"));
      const worker = new WorkerExecutor(client, artifacts, { projectRoot, parallelConcurrency: 1 });
      worker.setReceiptAuthority(TEST_RECEIPT_AUTHORITY);
      const directive = workerDirective({
        runId: `failed-terminal-${outcome}`,
        modelOverride: "openai-codex/sol",
      });
      lifecycleHarness.outcomes.push(outcome);
      let failure: unknown;
      try {
        await worker.execute(directive);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        name: "AgentTerminalError",
        stopReason: outcome === "aborted" ? "aborted" : "error",
        partialText: lifecycleHarness.partialText,
      });
      expect(
        artifacts.refFor(
          directive.identity.run_id,
          "planning",
          null,
          "agent-output",
          directive.output_artifact.operation_id,
          1
        )
      ).toBeNull();
      expect(lifecycleHarness.promptCalls).toBe(1);
      expect(lifecycleHarness.events).toEqual([
        "resource_open",
        "shutdown_quit_start",
        "shutdown_quit_end",
        "dispose",
      ]);
      expect(tracked.isOpen()).toBe(false);
      const files = readdirSync(path.join(sessionRoot, "piper")).filter((entry) =>
        entry.endsWith(".jsonl")
      );
      expect(files).toHaveLength(1);
      const file = files[0];
      if (file === undefined) throw new Error("failed terminal transcript absent");
      const transcript = readFileSync(path.join(sessionRoot, "piper", file), "utf8");
      expect(transcript).toContain("partial α");
      expect(transcript).toContain(
        JSON.stringify({
          type: "text",
          text: lifecycleHarness.partialText.slice("partial α".length),
        })
      );
      expect(transcript).toContain(`"stopReason":"${outcome === "aborted" ? "aborted" : "error"}"`);
    }
  );

  it.each(["provider_error", "aborted"] as const)(
    "does not admit a private typed result after %s or expose private partial evidence",
    async (outcome) => {
      const { projectRoot } = temporaryProject("absent");
      const readResult = vi.fn(() => "must not become successful typed text");
      const client = new PiAgentClient();
      lifecycleHarness.outcomes.push(outcome);
      let failure: unknown;
      try {
        await client.runAgent({
          agent: "anonymous-private-failed",
          stateId: "query",
          task: "offline private terminal fixture",
          projectRoot,
          trustProfile: "hardened-untrusted",
          inputArtifacts: [],
          registration: {
            playbook_name: "knowledge-base",
            workflow_name: "knowledge-base",
            guidance: {
              skill_root: ".pi/skills/knowledge-base/assets/prompts",
              resolution: "per_agent_phase",
            },
            result_transport: "host_typed",
            opening_policy: "host_private_opening",
            model_policy: "host_private_ssot_model",
          },
          session: {
            isolatedSystemPrompt: "Private fixture system prompt.",
            tools: ["read"],
            opening: "Private fixture opening.",
            sensitiveOutput: true,
            readResult,
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ name: "AgentTerminalError", partialText: "" });
      expect(readResult).not.toHaveBeenCalled();
      expect(String(failure)).not.toContain(lifecycleHarness.partialText);
      expect(JSON.stringify(failure)).not.toContain("PRIVATE_PROVIDER_ERROR_SENTINEL");
      expect(lifecycleHarness.sessionOptions[0]).toMatchObject({ thinkingLevel: undefined });
    }
  );

  it.each(["minimal", "low", "medium", "high", "xhigh", undefined])(
    "reads catalog thinking %s without replacing omitted settings policy",
    async (thinking) => {
      const { projectRoot } = temporaryProject("copied");
      const definition = path.join(projectRoot, ".pi", "agents", "echo.md");
      writeFileSync(
        definition,
        readFileSync(definition, "utf8").replace(
          "thinking: xhigh\n",
          thinking === undefined ? "" : `thinking: ${thinking}\n`
        )
      );
      const client = new PiAgentClient({
        sessionRuntime: offlineSessionRuntime(),
        testOnlySessionManagerFactory: () => SessionManager.inMemory(projectRoot),
      });
      lifecycleHarness.outcomes.push("success");
      await client.runAgent(invocation(projectRoot, `thinking-${thinking}`));
      expect(lifecycleHarness.sessionOptions[0]).toMatchObject({ thinkingLevel: thinking });
    }
  );

  it.each(["unknown", "", "42", "null"])(
    "refuses invalid catalog thinking '%s' before session creation",
    async (thinking) => {
      const { projectRoot } = temporaryProject("copied");
      const definition = path.join(projectRoot, ".pi", "agents", "echo.md");
      writeFileSync(
        definition,
        readFileSync(definition, "utf8").replace("thinking: xhigh", `thinking: ${thinking}`)
      );
      const client = new PiAgentClient({
        sessionRuntime: offlineSessionRuntime(),
        testOnlySessionManagerFactory: () => SessionManager.inMemory(projectRoot),
      });
      await expect(client.runAgent(invocation(projectRoot, "invalid-thinking"))).rejects.toThrow(
        /invalid catalog thinking level/u
      );
      expect(lifecycleHarness.sessionOptions).toHaveLength(0);
      expect(lifecycleHarness.promptCalls).toBe(0);
    }
  );

  it("keeps engine receipt admission bound to the directive while the invocation override selects the SDK model", async () => {
    vi.stubEnv("PENNY_RESEARCH_DEFAULT_MODEL", "openai-codex/terra");
    const { projectRoot, sessionRoot } = temporaryProject();
    const env = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(sessionRoot, "state"),
      PENNY_RESEARCH_DEFAULT_MODEL: "openai-codex/terra",
    };
    initializePennyState(projectRoot, { env });
    using service = new OrchestrationService({
      projectRoot,
      env,
      modelOverride: "fixture-other/approved",
    });
    const identity = {
      schema_version: 2,
      run_id: "override-receipt",
      session_id: "override-receipt",
      playbook: "research",
      engine_owner: "typescript",
    } as const;
    const directive = service.engine.handle({
      schema_version: 2,
      action: "start",
      identity,
      goal: "Check override receipt admission",
      constraints: {},
      project_root: projectRoot,
      trust_profile: "trusted-interactive",
    });
    if (directive.action !== "invoke_agent") throw new Error("expected Research worker directive");
    expect(directive.model_override).toBe("openai-codex/terra");
    lifecycleHarness.outcomes.push("success");
    const results = await service.workers.execute(directive);
    const result = results[0];
    if (result === undefined) throw new Error("worker result absent");
    expect(lifecycleHarness.sessionOptions[0]).toMatchObject({
      model: { provider: "fixture-other", id: "zz-fixture-override" },
    });
    expect(result.worker_receipt.model).toBe(directive.model_override);
    // The factory text deliberately has no SUMMARY. Receipt admission must succeed and route
    // that independent malformed-output condition, not reject the selected override's receipt.
    const next = service.engine.handle({ schema_version: 2, action: "step", identity, result });
    expect(next).toMatchObject({ action: "invoke_agent", execution_purpose: "routing_repair" });
  });

  it("awaits quit shutdown before dispose after success and exact liveness error", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const tracked = trackedResourceExtension();
    const client = new PiAgentClient({
      workerExtensions: [tracked.extension],
      catalogSessions: {
        projectId: `prj_${"a".repeat(32)}`,
        root: sessionRoot,
      },
    });

    lifecycleHarness.outcomes.push("success");
    await expect(client.runAgent(invocation(projectRoot, "lifecycle-success"))).resolves.toEqual({
      text: "complete lifecycle result",
    });
    expect(lifecycleHarness.events).toEqual([
      "resource_open",
      "shutdown_quit_start",
      "shutdown_quit_end",
      "dispose",
    ]);
    expect(tracked.isOpen()).toBe(false);

    lifecycleHarness.events.length = 0;
    lifecycleHarness.outcomes.push("liveness");
    await expect(
      client.runAgent(invocation(projectRoot, "lifecycle-liveness"))
    ).rejects.toThrowError(new LivenessExhaustedError("external_request_budget_exhausted"));
    expect(lifecycleHarness.events).toEqual([
      "resource_open",
      "shutdown_quit_start",
      "shutdown_quit_end",
      "dispose",
    ]);
    expect(tracked.isOpen()).toBe(false);

    const sessionFiles = readdirSync(path.join(sessionRoot, "echo"))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort();
    expect(sessionFiles).toHaveLength(2);
    const durableBytes = sessionFiles.map((entry) =>
      readFileSync(path.join(sessionRoot, "echo", entry), "utf8")
    );
    expect(durableBytes.some((bytes) => bytes.includes("complete lifecycle result"))).toBe(true);
    expect(durableBytes.some((bytes) => bytes.includes("external_request_budget_exhausted"))).toBe(
      true
    );
  }, 60_000);

  it("uses the same awaited shutdown path for a pre-model tool-surface mismatch", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const tracked = trackedResourceExtension();
    const client = new PiAgentClient({
      workerExtensions: [tracked.extension],
      catalogSessions: {
        projectId: `prj_${"b".repeat(32)}`,
        root: sessionRoot,
      },
    });

    lifecycleHarness.outcomes.push("tool_mismatch");
    await expect(client.runAgent(invocation(projectRoot, "lifecycle-mismatch"))).rejects.toThrow(
      /tool surface mismatch before model invocation/u
    );
    expect(lifecycleHarness.events).toEqual([
      "resource_open",
      "shutdown_quit_start",
      "shutdown_quit_end",
      "dispose",
    ]);
    expect(tracked.isOpen()).toBe(false);
    expect(
      readdirSync(path.join(sessionRoot, "echo")).filter((entry) => entry.endsWith(".jsonl"))
    ).toHaveLength(1);
  }, 60_000);
});
