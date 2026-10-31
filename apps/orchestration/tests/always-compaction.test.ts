import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  agentDir: "",
  runtime: undefined as ModelRuntime | undefined,
  loaderManagers: [] as Array<SettingsManager | undefined>,
  factoryManagers: [] as SettingsManager[],
  privateResources: [] as string[][],
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    getAgentDir: () => harness.agentDir,
    DefaultResourceLoader: class extends actual.DefaultResourceLoader {
      constructor(options: ConstructorParameters<typeof actual.DefaultResourceLoader>[0]) {
        super(options);
        harness.loaderManagers.push(options.settingsManager);
      }
    },
    createAgentSession: vi.fn(
      async (options: NonNullable<Parameters<typeof actual.createAgentSession>[0]>) => {
        if (!options.settingsManager || !harness.runtime)
          throw new Error("actual factory missing settings/runtime");
        harness.factoryManagers.push(options.settingsManager);
        expect(options.settingsManager.getCompactionEnabled()).toBe(true);
        const result = await actual.createAgentSession({
          ...options,
          modelRuntime: harness.runtime,
        });
        expect(result.session.settingsManager).toBe(options.settingsManager);
        expect(result.session.autoCompactionEnabled).toBe(true);
        result.session.setAutoCompactionEnabled(false);
        result.session.settingsManager.setHideThinkingBlock(true);
        await result.session.reload();
        expect(result.session.autoCompactionEnabled).toBe(true);
        if (options.noTools === "all") {
          if (!options.resourceLoader) throw new Error("missing isolated loader");
          harness.privateResources.push([
            ...options.resourceLoader.getExtensions().extensions.map((entry) => entry.path),
            ...options.resourceLoader.getSkills().skills.map((entry) => entry.name),
            ...options.resourceLoader.getPrompts().prompts.map((entry) => entry.name),
            ...options.resourceLoader.getAgentsFiles().agentsFiles.map((entry) => entry.path),
          ]);
        }
        vi.spyOn(result.session, "prompt").mockImplementation(async () => {
          result.session.messages.push(fauxAssistantMessage("finished"));
        });
        return result;
      }
    ),
  };
});

import {
  PiAgentClient,
  type AgentInvocation,
  type PiAgentClientOptions,
} from "../dist/model-client.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  harness.loaderManagers.length = 0;
  harness.factoryManagers.length = 0;
  harness.privateResources.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  vi.stubGlobal("fetch", () => {
    throw new Error("network forbidden");
  });
  const root = mkdtempSync(path.join(tmpdir(), "penny-factory-compaction-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  harness.agentDir = path.join(root, "agent");
  mkdirSync(harness.agentDir);
  mkdirSync(path.join(projectRoot, ".pi/agents"), { recursive: true });
  mkdirSync(path.join(projectRoot, "guidance"));
  writeFileSync(
    path.join(harness.agentDir, "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: false,
        reserveTokens: 111,
        keepRecentTokens: 22,
        modelOverrides: { "faux/faux-1": { reserveTokens: 333 } },
      },
      cacheWarming: "off",
    })
  );
  writeFileSync(
    path.join(projectRoot, ".pi/settings.json"),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } })
  );
  writeFileSync(
    path.join(projectRoot, ".pi/SYSTEM.md"),
    "<system_context>\nYou are **Penny**.\n# On-Demand Protocols\nPrimary only\n</system_context>"
  );
  writeFileSync(path.join(projectRoot, "AGENTS.md"), "Fixture project index");
  writeFileSync(
    path.join(projectRoot, ".pi/agents/echo.md"),
    "---\nname: echo\ntools: read\n---\nFixture role\n<agent_boundary>\nRole ends here.\n</agent_boundary>"
  );
  writeFileSync(path.join(projectRoot, "guidance/echo.md"), "Fixture guidance");
  const faux = fauxProvider({ tokensPerSecond: 0 });
  harness.runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  harness.runtime.registerNativeProvider(faux.provider);
  const invocation: AgentInvocation = {
    agent: "echo",
    stateId: "work",
    task: "Finish",
    projectRoot,
    trustProfile: "trusted-interactive",
    inputArtifacts: [],
    modelOverride: "faux/faux-1",
    registration: {
      playbook_name: "fixture",
      workflow_name: "fixture",
      guidance: { skill_root: "guidance", resolution: "per_agent" },
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
    },
  };
  const options: PiAgentClientOptions = {
    resolveModel: () => faux.getModel(),
    testOnlySessionManagerFactory: () => SessionManager.inMemory(projectRoot),
  };
  return { projectRoot, invocation, options };
}

describe("shared skill/standalone/child session factory compaction policy", () => {
  it("passes ONE enforced file-backed manager to both ordinary loader and actual SDK factory", async () => {
    const f = await fixture();
    expect((await new PiAgentClient(f.options).runAgent(f.invocation)).text).toBe("finished");
    expect(harness.factoryManagers).toHaveLength(1);
    expect(harness.loaderManagers).toEqual(harness.factoryManagers);
    expect(
      harness.factoryManagers[0]?.getCompactionSettings({ provider: "faux", id: "faux-1" })
    ).toEqual({ enabled: true, reserveTokens: 333, keepRecentTokens: 22 });
  });

  it("enforces injected false on every newly created worker without changing other host preferences", async () => {
    const f = await fixture();
    const injected = SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 77, keepRecentTokens: 11 },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const client = new PiAgentClient({
      ...f.options,
      sessionRuntime: {
        settingsManager: injected,
        noAmbientExtensions: true,
        attach: () => () => {},
      },
    });
    await client.runAgent(f.invocation);
    await injected.reload();
    injected.applyOverrides({ compaction: { enabled: false } });
    await client.runAgent({ ...f.invocation, task: "Nested child / resumed assignment" });
    expect(harness.loaderManagers).toEqual([injected, injected]);
    expect(harness.factoryManagers).toEqual([injected, injected]);
    expect(injected.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 77,
      keepRecentTokens: 11,
    });
    expect(injected.getRetryEnabled()).toBe(false);
  });

  it("keeps anonymous KB sessions enabled and ambient-resource-free, not joined to the injected catalog manager", async () => {
    const f = await fixture();
    const injected = SettingsManager.inMemory({
      compaction: { enabled: false },
      extensions: ["must-not-load"],
      skills: ["must-not-load"],
    });
    const client = new PiAgentClient({
      ...f.options,
      workerExtensions: [
        () => {
          throw new Error("ambient factory entered private KB");
        },
      ],
      sessionRuntime: {
        settingsManager: injected,
        noAmbientExtensions: true,
        attach: () => () => {},
      },
    });
    const privateInvocation: AgentInvocation = {
      ...f.invocation,
      agent: "anonymous-kb",
      registration: {
        ...f.invocation.registration,
        result_transport: "host_typed",
        opening_policy: "host_private_opening",
        model_policy: "host_private_ssot_model",
      },
      session: {
        isolatedSystemPrompt: "Private KB fixture",
        noTools: "all",
        tools: ["private_result"],
        customTools: [
          defineTool({
            name: "private_result",
            label: "private result",
            description: "fixture result",
            parameters: Type.Object({}),
            async execute() {
              return { content: [], details: undefined };
            },
          }),
        ],
        opening: "Private opening",
        readResult: () => "private finished",
        sensitiveOutput: true,
      },
    };
    expect((await client.runAgent(privateInvocation)).text).toBe("private finished");
    expect(harness.privateResources).toEqual([[]]);
    expect(harness.loaderManagers).toEqual(harness.factoryManagers);
    expect(harness.factoryManagers[0]).not.toBe(injected);
    expect(harness.factoryManagers[0]?.getCompactionEnabled()).toBe(true);
  });
});
