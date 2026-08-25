import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Fail immediately when a fixture value that an oracle depends on is absent. */
export function requireDefined<T>(
  value: T | null | undefined,
  message = "expected fixture value to be defined"
): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(
  value: unknown,
  message = "expected an object fixture"
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

export function requireString(value: unknown, message = "expected a string fixture"): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

export function requireArray(value: unknown, message = "expected an array fixture"): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

export function requireArrayElement<T>(
  values: readonly T[],
  index: number,
  message = `expected fixture element at index ${index}`
): T {
  return requireDefined(values[index], message);
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export type UnknownFunction = (...args: unknown[]) => unknown;

export function isUnknownFunction(value: unknown): value is UnknownFunction {
  return typeof value === "function";
}

export function requireFunction(
  value: unknown,
  message = "expected a function fixture"
): UnknownFunction {
  if (!isUnknownFunction(value)) throw new Error(message);
  return value;
}

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

export function createTestToolInfos(
  names: readonly string[]
): ReturnType<ExtensionAPI["getAllTools"]> {
  return names.map((name) => ({
    name,
    description: "test provider tool",
    parameters: Type.Object({}),
    sourceInfo: {
      path: `/test-tools/${name}`,
      source: "test-host",
      scope: "project",
      origin: "top-level",
    },
  }));
}

/**
 * Complete, typed Pi host factory for focused extension tests. Unused host
 * capabilities are inert; exercised registration surfaces are exposed as
 * unknown to hooks and must be narrowed by the receiving test.
 */
export function createTestExtensionApi(hooks: TestExtensionApiHooks = {}): ExtensionAPI {
  const unsupported = (capability: string): never => {
    throw new Error(`test ExtensionAPI capability is not implemented: ${capability}`);
  };

  return {
    on: (event: string, handler: unknown) => hooks.onEvent?.(event, handler),
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
  };
}
