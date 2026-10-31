import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { vi } from "vitest";

import { registerTool } from "../pi-tool-registration.js";
import { requireDefined } from "./test-narrowers.js";

// Use the installed SDK even when the consuming test mocks provider/session boundaries.
const { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } =
  await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent"
  );

export interface TestExtensionApiHooks {
  onEvent?(event: string, handler: unknown): void;
  onRegisterTool?(tool: unknown): void;
  onRegisterCommand?(name: string, options: unknown): void;
  onAppendEntry?(customType: string, data: unknown): void;
  getActiveTools?(): string[];
  onSetActiveTools?(names: string[]): void;
  getAllTools?(): ReturnType<ExtensionAPI["getAllTools"]>;
  getFlag?(name: string): boolean | string | undefined;
}

function createTestEventBus(): ExtensionAPI["events"] {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const channelHandlers = handlers.get(channel) ?? new Set();
      channelHandlers.add(handler);
      handlers.set(channel, channelHandlers);
      return () => channelHandlers.delete(handler);
    },
  };
}

type TestToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

function unsupported(capability: string): never {
  throw new Error(`test ExtensionAPI capability is not implemented: ${capability}`);
}

/** Obtain interface shape and tool metadata from the installed SDK, not a copied API. */
async function loadSdkTestTemplates(): Promise<{ api: ExtensionAPI; tool: TestToolInfo }> {
  const sandbox = mkdtempSync(path.join(tmpdir(), "penny-test-sdk-host-"));
  try {
    const agentDir = path.join(sandbox, "agent");
    mkdirSync(agentDir);
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      cacheWarming: "off",
    });
    let api: ExtensionAPI | undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd: sandbox,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Isolated test host",
      appendSystemPrompt: [],
      extensionFactories: [
        (host) => {
          api = host;
          registerTool(host, {
            name: "test_provider_template",
            label: "Test provider template",
            description: "test provider tool",
            parameters: Type.Object({}),
            execute: async () => {
              throw new Error("test host must never prompt a model or execute template tools");
            },
          });
        },
      ],
    });
    await resourceLoader.reload();
    if (resourceLoader.getExtensions().errors.length > 0) {
      throw new Error("SDK test host extension failed to load");
    }
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ tokensPerSecond: 0 });
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({
      cwd: sandbox,
      agentDir,
      settingsManager,
      modelRuntime,
      model: faux.getModel(),
      sessionManager: SessionManager.inMemory(sandbox),
      resourceLoader,
      tools: ["test_provider_template"],
    });
    try {
      if (faux.state.callCount !== 0) {
        throw new Error("SDK test host unexpectedly called its model");
      }
      const apiTemplate = { ...requireDefined(api, "SDK did not supply an ExtensionAPI") };
      for (const property of Reflect.ownKeys(apiTemplate)) {
        const member: unknown = Reflect.get(apiTemplate, property);
        // Retain shape, not session-owned values, even through property descriptors.
        Reflect.set(
          apiTemplate,
          property,
          typeof member === "function" ? () => unsupported(String(property)) : undefined
        );
      }
      return {
        api: apiTemplate,
        tool: requireDefined(
          session.getAllTools().find((tool) => tool.name === "test_provider_template"),
          "SDK did not supply tool metadata"
        ),
      };
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// One isolated SDK initialization per module; callers retain their synchronous fixture API.
const sdkTemplates = await loadSdkTestTemplates();

export function createTestToolInfos(
  names: readonly string[]
): ReturnType<ExtensionAPI["getAllTools"]> {
  return names.map((name) => ({
    ...sdkTemplates.tool,
    name,
    parameters: Type.Object({}),
    sourceInfo: {
      ...sdkTemplates.tool.sourceInfo,
      path: `/test-tools/${name}`,
      source: "test-host",
      scope: "project",
      origin: "top-level",
    },
  }));
}

/**
 * SDK-shaped host for focused tests. Only explicitly modeled capabilities are
 * usable; newly added SDK methods fail closed until a test supplies behavior.
 * Registration values remain unknown at hooks and must be narrowed by tests.
 */
export function createTestExtensionApi(hooks: TestExtensionApiHooks = {}): ExtensionAPI {
  const overrides = {
    on: (event: string, handler: unknown) => {
      hooks.onEvent?.(event, handler);
      return () => {};
    },
    registerTool: (tool: unknown) => hooks.onRegisterTool?.(tool),
    registerCommand: (name: string, options: unknown) => hooks.onRegisterCommand?.(name, options),
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: (name: string) => hooks.getFlag?.(name),
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: (customType: string, data?: unknown) => hooks.onAppendEntry?.(customType, data),
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: () => unsupported("exec"),
    getActiveTools: () => hooks.getActiveTools?.() ?? [],
    getAllTools: () => hooks.getAllTools?.() ?? [],
    setActiveTools: (names: string[]) => hooks.onSetActiveTools?.(names),
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: createTestEventBus(),
  } satisfies Partial<ExtensionAPI>;

  // Keep real SDK shape without delegating capabilities to the disposed SDK session.
  // Each fixture gets its own target and mutable overrides (e.g. vi.spyOn).
  return new Proxy(
    { ...sdkTemplates.api, ...overrides },
    {
      get(target, property): unknown {
        const member: unknown = Reflect.get(target, property);
        if (Object.hasOwn(overrides, property) || !Object.hasOwn(target, property)) return member;
        if (typeof member === "function") return () => unsupported(String(property));
        return unsupported(String(property));
      },
    }
  );
}
