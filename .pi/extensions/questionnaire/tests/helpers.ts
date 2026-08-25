/** Shared fail-fast fixtures for questionnaire extension tests. */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import * as path from "node:path";

export interface RegisteredQuestionnaireTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(...args: unknown[]): Promise<unknown>;
  renderCall?: (args: unknown, theme: unknown) => unknown;
  renderResult?: (result: unknown, options: unknown, theme: unknown) => unknown;
}

export interface RegisteredQuestionnaireCommand {
  name: string;
  description?: string;
  handler(args: unknown, ctx: unknown): Promise<void>;
}

export interface QuestionnaireToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

export interface QuestionnaireExtensionApiHarness {
  api: ExtensionAPI;
  registeredTools: unknown[];
  registeredCommands: unknown[];
}

export interface QuestionnaireUiHost {
  tui: TUI;
  theme: Theme;
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail a test with a useful invariant when an expected fixture value is absent. */
export function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

export function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new Error(message);
  return value;
}

export function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

export function requireBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw new Error(message);
  return value;
}

function isUnknownFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

export function requireQuestionnaireTool(
  value: unknown,
  message = "questionnaire tool was not registered"
): RegisteredQuestionnaireTool {
  const candidate = requireRecord(value, message);
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.description !== "string" ||
    !isUnknownFunction(candidate.execute)
  ) {
    throw new Error(`${message}: registered tool has an incompatible shape`);
  }
  const execute = candidate.execute;
  const renderCall = candidate.renderCall;
  const renderResult = candidate.renderResult;
  if (renderCall !== undefined && !isUnknownFunction(renderCall)) {
    throw new Error(`${message}: renderCall is not callable`);
  }
  if (renderResult !== undefined && !isUnknownFunction(renderResult)) {
    throw new Error(`${message}: renderResult is not callable`);
  }
  return {
    name: candidate.name,
    label: candidate.label,
    description: candidate.description,
    parameters: candidate.parameters,
    async execute(...args: unknown[]): Promise<unknown> {
      return await execute(...args);
    },
    renderCall: renderCall === undefined ? undefined : (args, theme) => renderCall(args, theme),
    renderResult:
      renderResult === undefined
        ? undefined
        : (result, options, theme) => renderResult(result, options, theme),
  };
}

export function requireQuestionnaireCommand(
  value: unknown,
  message = "questionnaire command was not registered"
): RegisteredQuestionnaireCommand {
  const candidate = requireRecord(value, message);
  const config = requireRecord(candidate.config, `${message}: command config is missing`);
  if (typeof candidate.name !== "string" || !isUnknownFunction(config.handler)) {
    throw new Error(`${message}: registered command has an incompatible shape`);
  }
  if (config.description !== undefined && typeof config.description !== "string") {
    throw new Error(`${message}: command description is invalid`);
  }
  const handler = config.handler;
  return {
    name: candidate.name,
    description: config.description,
    async handler(args: unknown, ctx: unknown): Promise<void> {
      await handler(args, ctx);
    },
  };
}

export function requireQuestionnaireToolResult(
  value: unknown,
  message = "questionnaire tool returned an incompatible result"
): QuestionnaireToolResult {
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
    details:
      result.details === undefined
        ? undefined
        : requireRecord(result.details, `${message}: details are not an object`),
  };
}

export function requireTextComponent(value: unknown, message: string): { text: string } {
  const component = requireRecord(value, message);
  return { text: requireString(component.text, `${message}: text is missing`) };
}

export function createExtensionApiHarness(): QuestionnaireExtensionApiHarness {
  const registeredTools: unknown[] = [];
  const registeredCommands: unknown[] = [];
  const registrationHost: Pick<ExtensionAPI, "on" | "registerTool" | "registerCommand"> = {
    on: () => {},
    registerTool(tool) {
      registeredTools.push(tool);
    },
    registerCommand(name, config) {
      registeredCommands.push({ name, config });
    },
  };
  const guardedHost = new Proxy(registrationHost, {
    get(target, property, receiver) {
      if (!Reflect.has(target, property)) {
        throw new Error(
          `Questionnaire ExtensionAPI test seam does not implement ${String(property)}`
        );
      }
      return reflectGetUnknown(target, property, receiver);
    },
  });

  // Test-host exception rule: UNSAFE_ASSERTION. Rationale: Pi extension factories require a complete ExtensionAPI although these tests exercise only registration methods.
  // Removal condition: Remove when Pi exposes a registration-only API accepted by extension factories.
  // Focused test: .pi/extensions/questionnaire/tests/unit/questionnaire.test.ts#fails fast when the exact partial ExtensionAPI seam is exceeded
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Pi requires the complete host type at this guarded partial test seam.
  const api = guardedHost as ExtensionAPI;
  return { api, registeredTools, registeredCommands };
}

export function createQuestionnaireUiHost(requestRender: () => void): QuestionnaireUiHost {
  const tuiHost: Pick<TUI, "requestRender"> = { requestRender };
  const themeHost: Pick<Theme, "fg" | "bg" | "bold"> = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
  };
  const guardedTui = new Proxy(tuiHost, {
    get(target, property, receiver) {
      if (!Reflect.has(target, property)) {
        throw new Error(`Questionnaire TUI test seam does not implement ${String(property)}`);
      }
      return reflectGetUnknown(target, property, receiver);
    },
  });
  const guardedTheme = new Proxy(themeHost, {
    get(target, property, receiver) {
      if (!Reflect.has(target, property)) {
        throw new Error(`Questionnaire Theme test seam does not implement ${String(property)}`);
      }
      return reflectGetUnknown(target, property, receiver);
    },
  });

  // Test-host exception rule: UNSAFE_ASSERTION. Rationale: The mocked Editor and questionnaire UI exercise only requestRender and fg/bg/bold on partial Pi hosts.
  // Removal condition: Remove when the production helper accepts those narrowed TUI and Theme contracts.
  // Focused test: .pi/extensions/questionnaire/tests/unit/questionnaire.test.ts#fails fast when the exact partial TUI or Theme seam is exceeded
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Pi requires the complete host type at this guarded partial test seam.
  const tui = guardedTui as TUI;

  // Test-host exception rule: UNSAFE_ASSERTION. Rationale: The mocked Editor and questionnaire UI exercise only requestRender and fg/bg/bold on partial Pi hosts.
  // Removal condition: Remove when the production helper accepts those narrowed TUI and Theme contracts.
  // Focused test: .pi/extensions/questionnaire/tests/unit/questionnaire.test.ts#fails fast when the exact partial TUI or Theme seam is exceeded
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Pi requires the complete host type at this guarded partial test seam.
  const theme = guardedTheme as Theme;
  return { tui, theme };
}

function reflectGetUnknown(target: object, property: PropertyKey, receiver: unknown): unknown {
  return Reflect.get(target, property, receiver);
}

/** Resolve the pi command for E2E tests. */
export function getPiCommand(): string {
  const execName = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(execName)) {
    return "pi";
  }
  return process.execPath;
}
