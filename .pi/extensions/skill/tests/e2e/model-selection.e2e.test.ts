/** Real public ingress, worker and SDK resolution. Only the provider session factory is replaced. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SessionManager,
  resolveCliModel,
  type createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializePennyState,
  ArtifactStore,
  WorkerExecutor,
  type Directive,
  PiAgentClient,
  PLAYBOOK_REGISTRY,
  parseSsotTools,
  type AgentInvocation,
} from "@penny/orchestration";
import { SCA_P04_CANDIDATE_REGISTRATION } from "../../../../../apps/orchestration/dist/sca/p04-playbook.js";
import { SCA_P04_REQUIRED_MODEL } from "../../../../../apps/orchestration/dist/sca/p04-contracts.js";
import { ssotModel, ssotProvider } from "../../../../../apps/orchestration/dist/model-client.js";
import {
  FIXTURE_HEAVY_MODEL_ID,
  FIXTURE_MID_MODEL_ID,
  FIXTURE_OVERRIDE_MODEL_ID,
  writeModelSelectionFixture,
} from "../../../../../apps/orchestration/tests/helpers/model-selection-fixture.js";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";
import createSkillExtension from "../../index.js";

type SessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
const boundary = vi.hoisted(() => ({
  options: [] as SessionOptions[],
  error: new Error("provider-free session factory boundary"),
  drift: false,
  promptCalls: 0,
  disposed: false,
  waitForSiblings: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (options: SessionOptions) => {
      boundary.options.push(options);
      if (boundary.waitForSiblings !== undefined) await boundary.waitForSiblings();
      if (!boundary.drift) throw boundary.error;
      const runtime = options.modelRuntime;
      const wrong = runtime?.getModel("fixture-other", FIXTURE_OVERRIDE_MODEL_ID);
      if (wrong === undefined) throw new Error("session drift fixture model absent");
      const created = await actual.createAgentSession({ ...options, model: wrong });
      vi.spyOn(created.session, "prompt").mockImplementation(async () => {
        boundary.promptCalls += 1;
        throw new Error("drifted model must never prompt");
      });
      const dispose = created.session.dispose.bind(created.session);
      vi.spyOn(created.session, "dispose").mockImplementation(() => {
        boundary.disposed = true;
        dispose();
      });
      return created;
    },
  };
});

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const ORDINARY = ["assess", "decide", "define", "diagnose", "plan", "produce", "research"];
let root: string;
let project: string;
let agentDir: string;
interface SkillTool {
  name: "skill";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    context: unknown
  ): Promise<unknown>;
}
function isSkillTool(value: unknown): value is SkillTool {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}
let tool: SkillTool | undefined;
function skillTool(): SkillTool {
  if (tool === undefined) throw new Error("public skill tool was not registered");
  return tool;
}
function context() {
  return {
    cwd: project,
    isProjectTrusted: () => true,
    ui: { theme: { fg: (_color: string, text: string) => text }, notify: () => {} },
  };
}
async function invoke(params: Record<string, unknown>): Promise<unknown> {
  try {
    return await skillTool().execute("model-selection", params, undefined, undefined, context());
  } catch (error) {
    if (error !== boundary.error) throw error;
    return undefined;
  }
}
function step(name: string, model?: string) {
  const statement = { statement: "Supplied provider-free material." };
  const shared = { hard_constraints: [statement], non_goals: [statement], known_uncertainties: [] };
  const requests: Record<string, Record<string, unknown>> = {
    assess: {
      schema_version: 1,
      target: [statement],
      criteria: [{ ...statement, importance: "required" }],
      supplied_evidence: [statement],
      ...shared,
    },
    decide: {
      schema_version: 1,
      alternatives: [
        { alternative_id: "one", label: "One", description: "First option" },
        { alternative_id: "two", label: "Two", description: "Second option" },
      ],
      hard_constraints: [],
      objectives: [{ objective_id: "quality", statement: "Prefer quality" }],
      preferences: [],
      uncertainties: [],
      evidence: [],
    },
    define: {
      schema_version: 1,
      mode: "create",
      requested_profile_id: "generic",
      desired_outcomes: ["A bounded specification"],
      audiences: ["Reviewers"],
      in_scope: ["A bounded product"],
      out_of_scope: [],
      hard_constraints: ["Do not execute"],
      non_goals: [],
      known_assumptions: [],
      known_uncertainties: [],
      prior_decisions: [],
      standard_hints: [],
    },
    diagnose: {
      schema_version: 1,
      symptoms: [statement],
      supplied_observations: [statement],
      environment_facts: [statement],
      permitted_test_boundary: { mode: "none" },
      ...shared,
    },
    plan: {
      schema_version: 1,
      desired_outcomes: ["A bounded strategy"],
      current_state: { status: "provided", facts: ["A current system exists"] },
      hard_constraints: ["Do not execute"],
      non_goals: [],
      known_uncertainties: [],
      prior_decisions: [],
    },
    produce: {
      schema_version: 1,
      output_name: "fixture.md",
      artifact_kind: "markdown",
      specification: [statement],
      source_material: [statement],
      acceptance_criteria: [statement],
      ...shared,
    },
    research: {},
  };
  const constraints = requests[name];
  if (constraints === undefined) throw new Error(`missing native test request for ${name}`);
  return {
    skill_name: name,
    goal: "Provider-free model selection",
    constraints,
    ...(model === undefined ? {} : { model }),
  };
}
function catalogInvocation(
  agent = "echo",
  state = "researching",
  skill = "research"
): AgentInvocation {
  const registration = PLAYBOOK_REGISTRY.get(skill);
  if (registration?.worker.kind !== "catalog-agent") throw new Error("catalog registration absent");
  return {
    agent,
    stateId: state,
    task: "Stop at the provider-free session boundary.",
    projectRoot: project,
    trustProfile: "trusted-interactive",
    inputArtifacts: [],
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
function client(): PiAgentClient {
  return new PiAgentClient({
    testOnlySessionManagerFactory: () => SessionManager.inMemory(project),
  });
}
function doc(agent = "echo"): string {
  return readFileSync(path.join(project, ".pi", "agents", `${agent}.md`), "utf8");
}
function replaceIdentity(model: string | undefined, provider: string | undefined): void {
  const text = doc()
    .replace(/^model:.*$/mu, model === undefined ? "" : `model: ${model}`)
    .replace(/^provider:.*$/mu, provider === undefined ? "" : `provider: ${provider}`);
  writeFileSync(path.join(project, ".pi", "agents", "echo.md"), text);
}
function captured(index = boundary.options.length - 1): SessionOptions {
  const options = boundary.options[index];
  if (options === undefined) throw new Error("session factory was not reached");
  return options;
}
function assertIdentity(options: SessionOptions, provider: string, id: string): void {
  expect(options.model).toMatchObject({ provider, id });
  if (options.modelRuntime === undefined) throw new Error("resolved runtime omitted from session");
  const expected = resolveCliModel({
    cliProvider: provider,
    cliModel: id,
    modelRuntime: options.modelRuntime,
  });
  expect(expected.error).toBeUndefined();
  expect(expected.warning).toBeUndefined();
  expect(options.model).toStrictEqual(expected.model);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "penny-public-model-selection-"));
  project = path.join(root, "project");
  agentDir = path.join(root, "agent");
  mkdirSync(path.join(project, ".pi"), { recursive: true, mode: 0o700 });
  for (const part of ["agents", "skills"])
    cpSync(path.join(PROJECT_ROOT, ".pi", part), path.join(project, ".pi", part), {
      recursive: true,
    });
  cpSync(path.join(PROJECT_ROOT, "docs", "agents"), path.join(project, "docs", "agents"), {
    recursive: true,
  });
  cpSync(path.join(PROJECT_ROOT, ".pi", "SYSTEM.md"), path.join(project, ".pi", "SYSTEM.md"));
  writeFileSync(path.join(project, "AGENTS.md"), "Provider-free project fixture.");
  writeModelSelectionFixture(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PROJECT_ROOT", project);
  vi.stubEnv("PENNY_STATE_ROOT", path.join(root, "state"));
  vi.stubEnv("PENNY_SKILLS_DIR", path.join(project, ".pi", "skills"));
  vi.stubEnv("PENNY_RESEARCH_DEFAULT_MODEL", undefined);
  vi.stubEnv("PI_OBSERVABILITY_ENABLED", "false");
  vi.stubEnv("PI_OBSERVABILITY_AUTO_START", "false");
  initializePennyState(project, { env: process.env });
  boundary.options.length = 0;
  boundary.drift = false;
  boundary.promptCalls = 0;
  boundary.disposed = false;
  boundary.waitForSiblings = undefined;
  tool = undefined;
  createSkillExtension(
    createTestExtensionApi({
      onRegisterTool(definition) {
        if (isSkillTool(definition)) tool = definition;
      },
    })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("generic catalog model selection (provider execution NOT RUN)", () => {
  it("resolves every active catalog role's exact SSOT alias within its provider, never the global default", async () => {
    const roles = new Map<string, AgentInvocation>();
    for (const registration of PLAYBOOK_REGISTRY.values()) {
      if (registration.worker.kind !== "catalog-agent") continue;
      for (const [state, phase] of registration.worker.phases) {
        if (!roles.has(phase.agent))
          roles.set(phase.agent, catalogInvocation(phase.agent, state, registration.name));
      }
    }
    expect(roles.size).toBeGreaterThan(1);
    for (const [agent, invocation] of roles) {
      await expect(client().runAgent(invocation)).rejects.toBe(boundary.error);
      const source = doc(agent);
      const alias = ssotModel(source);
      expect(ssotProvider(source)).toBe("openai-codex");
      if (alias !== "sol" && alias !== "terra")
        throw new Error(`fixture has no declared alias '${alias}'`);
      assertIdentity(
        captured(),
        "openai-codex",
        alias === "sol" ? FIXTURE_HEAVY_MODEL_ID : FIXTURE_MID_MODEL_ID
      );
      expect(captured().tools).toEqual(parseSsotTools(source, agent));
    }
    expect(boundary.options).toHaveLength(roles.size);
  });

  it.each([
    [undefined, "openai-codex", /requires both 'model:' and 'provider:'/u],
    ["sol", undefined, /requires both 'model:' and 'provider:'/u],
    ["not-configured", "openai-codex", /unavailable or not configured/u],
    ["sol", "not-configured", /unavailable or not configured/u],
    ["fixture", "openai-codex", /does not match configured identity/u],
  ])(
    "refuses missing/unavailable/mismatched SSOT identity %s / %s before a session",
    async (model, provider, message) => {
      replaceIdentity(model, provider);
      await expect(client().runAgent(catalogInvocation())).rejects.toThrow(message);
      expect(boundary.options).toHaveLength(0);
    }
  );

  it("refuses an unauthenticated configured model rather than using a global default", async () => {
    writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "fixture-no-auth": {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            models: [{ id: "exact", name: "sol" }],
          },
        },
      })
    );
    replaceIdentity("sol", "fixture-no-auth");
    await expect(client().runAgent(catalogInvocation())).rejects.toThrow(/unavailable/u);
    expect(boundary.options).toHaveLength(0);
  });

  it("honors bare aliases on the catalog provider and composite overrides on another provider without changing host thinking/tools", async () => {
    await expect(
      client().runAgent({ ...catalogInvocation(), modelOverride: "terra", thinkingLevel: "medium" })
    ).rejects.toBe(boundary.error);
    assertIdentity(captured(), "openai-codex", FIXTURE_MID_MODEL_ID);
    await expect(
      client().runAgent({
        ...catalogInvocation(),
        modelOverride: "fixture-other/approved",
        thinkingLevel: "low",
      })
    ).rejects.toBe(boundary.error);
    assertIdentity(captured(), "fixture-other", FIXTURE_OVERRIDE_MODEL_ID);
    expect(boundary.options.map((item) => item.thinkingLevel)).toEqual(["medium", "low"]);
    for (const options of boundary.options)
      expect(options.tools).toEqual(parseSsotTools(doc(), "echo"));
  });

  it("resolves models registered by a loaded provider extension before session creation", async () => {
    const providerClient = new PiAgentClient({
      testOnlySessionManagerFactory: () => SessionManager.inMemory(project),
      workerExtensions: [
        {
          name: "model-selection-provider-fixture",
          factory: (pi) => {
            pi.registerProvider("fixture-extension", {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1/v1",
              apiKey: "provider-free-fixture-not-a-secret",
              models: [
                {
                  id: "extension-model",
                  name: "extension-alias",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            });
          },
        },
      ],
    });
    await expect(
      providerClient.runAgent({
        ...catalogInvocation(),
        modelOverride: "fixture-extension/extension-alias",
      })
    ).rejects.toBe(boundary.error);
    assertIdentity(captured(), "fixture-extension", "extension-model");
  });

  it("rejects session identity drift and disposes before any prompt", async () => {
    // A built-in-only tool surface lets this factory create a real SDK session without optional tools.
    writeFileSync(
      path.join(project, ".pi", "agents", "echo.md"),
      doc().replace(/^tools:.*$/mu, "tools: read")
    );
    boundary.drift = true;
    await expect(client().runAgent(catalogInvocation())).rejects.toThrow(
      /session model does not match/u
    );
    expect(boundary.promptCalls).toBe(0);
    expect(boundary.disposed).toBe(true);
  });

  it.each(ORDINARY)(
    "public %s override reaches the real worker in single, parallel and chain modes",
    async (name) => {
      await invoke(step(name));
      const defaults = captured();
      expect(defaults.model?.provider).toBe("openai-codex");
      expect([FIXTURE_HEAVY_MODEL_ID, FIXTURE_MID_MODEL_ID]).toContain(defaults.model?.id);
      for (const params of [
        step(name, "fixture-other/approved"),
        {
          skills: [step(name)],
          model: "fixture-other/approved",
        },
        {
          chain: [step(name)],
          model: "fixture-other/approved",
        },
      ]) {
        const before = boundary.options.length;
        await invoke(params);
        expect(boundary.options.length, `${name} did not reach session creation`).toBe(before + 1);
        assertIdentity(captured(), "fixture-other", FIXTURE_OVERRIDE_MODEL_ID);
        expect(captured().tools).toEqual(defaults.tools);
        expect(captured().thinkingLevel).toEqual(defaults.thinkingLevel);
      }
    }
  );

  it("gives per-step overrides precedence over the common override in parallel and chain", async () => {
    let release: (() => void) | undefined;
    const siblingsReachedFactory = new Promise<void>((resolve) => {
      release = resolve;
    });
    boundary.waitForSiblings = async () => {
      if (boundary.options.length === 2) {
        if (release === undefined) throw new Error("parallel fixture barrier absent");
        release();
      }
      await siblingsReachedFactory;
    };
    await invoke({
      model: "fixture-other/approved",
      skills: [step("assess", "terra"), step("diagnose")],
    });
    expect(boundary.options.map((item) => item.model?.id).sort()).toEqual(
      [FIXTURE_MID_MODEL_ID, FIXTURE_OVERRIDE_MODEL_ID].sort()
    );
    boundary.waitForSiblings = undefined;
    await invoke({
      model: "fixture-other/approved",
      chain: [step("assess", "terra")],
    });
    assertIdentity(captured(), "openai-codex", FIXTURE_MID_MODEL_ID);
  });

  it("takes the invocation override ahead of a Research directive default without mutating environment", async () => {
    vi.stubEnv("PENNY_RESEARCH_DEFAULT_MODEL", "openai-codex/terra");
    await invoke(step("research"));
    assertIdentity(captured(), "openai-codex", FIXTURE_MID_MODEL_ID);
    await invoke(step("research", "fixture-other/approved"));
    expect(boundary.options).toHaveLength(2);
    assertIdentity(captured(), "fixture-other", FIXTURE_OVERRIDE_MODEL_ID);
    expect(process.env.PENNY_RESEARCH_DEFAULT_MODEL).toBe("openai-codex/terra");
  });
  it.each([
    ["conflicting invocation override", SCA_P04_REQUIRED_MODEL.override, "fixture-other/approved"],
    ["mismatched directive", "fixture-other/approved", SCA_P04_REQUIRED_MODEL.override],
  ])(
    "refuses %s at the real guarded-zero-tool SCA required-model boundary before any session",
    async (_label, directiveOverride, invocationOverride) => {
      using store = new ArtifactStore(path.join(root, "required-model-artifacts"));
      const registration = SCA_P04_CANDIDATE_REGISTRATION;
      const workers = new WorkerExecutor(new PiAgentClient(), store, {
        projectRoot: project,
        parallelConcurrency: 1,
        registration,
        modelOverride: invocationOverride,
      });
      const directive: Extract<Directive, { action: "invoke_agent" }> = {
        schema_version: 2,
        action: "invoke_agent",
        identity: {
          schema_version: 2,
          run_id: "required-conflict",
          session_id: "required-conflict",
          playbook: registration.name,
          engine_owner: "typescript",
        },
        state_id: "selecting_surfaces",
        agent: "annie",
        attempt: 1,
        task: "Provider-free required-model conflict check",
        trust_profile: "hardened-untrusted",
        input_artifacts: { schema_version: 2, artifacts: [] },
        output_artifact: {
          schema_version: 2,
          run_id: "required-conflict",
          phase: "selecting_surfaces",
          branch_id: null,
          kind: "agent-output",
          operation_id: "required-conflict",
          version: 1,
          producer: "agent:annie",
          media_type: "text/plain",
          parent_ref: null,
          upstream_refs: [],
        },
        model_override: directiveOverride,
      };
      await expect(workers.execute(directive)).rejects.toMatchObject({
        blockerCode: "opening_policy_denied",
      });
      expect(boundary.options).toHaveLength(0);
    }
  );

  it("does not let a matching required override omit admission/dispatch fences", async () => {
    const invocation = catalogInvocation();
    await expect(
      client().runAgent({
        ...invocation,
        modelOverride: SCA_P04_REQUIRED_MODEL.override,
        registration: { ...invocation.registration, required_model: SCA_P04_REQUIRED_MODEL },
      })
    ).rejects.toThrow(/lacks required model admission or dispatch fencing/u);
    expect(boundary.options).toHaveLength(0);
  });
});
