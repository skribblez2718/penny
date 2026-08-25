import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface RegisteredPowerpointTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: { properties: Record<string, unknown> };
  execute(...args: unknown[]): Promise<unknown>;
}

export interface ExtensionApiHarness {
  api: ExtensionAPI;
  registeredTools: unknown[];
}

export interface PowerpointToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

export function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new Error(message);
  return value;
}

export function requireNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message);
  return value;
}

export function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function isUnknownFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

export function requirePowerpointTool(
  value: unknown,
  message = "powerpoint_generate was not registered"
): RegisteredPowerpointTool {
  const candidate = requireRecord(value, message);
  const parameters = requireRecord(candidate.parameters, `${message}: parameters are missing`);
  const properties = requireRecord(
    parameters.properties,
    `${message}: parameter properties are missing`
  );
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.description !== "string" ||
    (candidate.promptSnippet !== undefined && typeof candidate.promptSnippet !== "string") ||
    !isUnknownFunction(candidate.execute)
  ) {
    throw new Error(`${message}: registered tool has an incompatible shape`);
  }
  const execute = candidate.execute;
  return {
    name: candidate.name,
    label: candidate.label,
    description: candidate.description,
    promptSnippet: candidate.promptSnippet,
    parameters: { properties },
    async execute(...args: unknown[]): Promise<unknown> {
      return await execute(...args);
    },
  };
}

export function requirePowerpointToolResult(
  value: unknown,
  message = "powerpoint_generate returned an incompatible result"
): PowerpointToolResult {
  const result = requireRecord(value, message);
  if (!Array.isArray(result.content)) throw new Error(`${message}: content is missing`);
  const content = result.content.map((item, index) => {
    const record = requireRecord(item, `${message}: content item ${index} is not an object`);
    return {
      type: requireString(record.type, `${message}: content item ${index} has no type`),
      text: requireString(record.text, `${message}: content item ${index} has no text`),
    };
  });
  return {
    content,
    details: requireRecord(result.details, `${message}: details are missing`),
  };
}

export function createExtensionApiHarness(): ExtensionApiHarness {
  const registeredTools: unknown[] = [];
  const registrationHost: Pick<ExtensionAPI, "on" | "registerTool" | "registerCommand"> = {
    on: () => {},
    registerTool(tool) {
      registeredTools.push(tool);
    },
    registerCommand: () => {},
  };
  const guardedHost = new Proxy(registrationHost, {
    get(target, property, receiver) {
      if (!Reflect.has(target, property)) {
        throw new Error(`PowerPoint ExtensionAPI test seam does not implement ${String(property)}`);
      }
      return reflectGetUnknown(target, property, receiver);
    },
  });

  // Test-host exception rule: UNSAFE_ASSERTION. Rationale: Pi extension factories require a complete ExtensionAPI although these tests exercise only registration methods.
  // Removal condition: Remove when Pi exposes a registration-only API accepted by extension factories.
  // Focused test: .pi/extensions/powerpoint/tests/unit/extension.test.ts#fails fast when the exact partial ExtensionAPI seam is exceeded
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Pi requires the complete host type at this guarded partial test seam.
  const api = guardedHost as ExtensionAPI;
  return { api, registeredTools };
}

function reflectGetUnknown(target: object, property: PropertyKey, receiver: unknown): unknown {
  return Reflect.get(target, property, receiver);
}
