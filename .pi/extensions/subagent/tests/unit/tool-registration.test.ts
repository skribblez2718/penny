import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "typebox";

import { createTestExtensionApi, isRecord } from "../../../../lib/tests/test-narrowers.js";

// Mock external dependencies so index.ts can load in the test environment
vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[], _opts?: Record<string, unknown>) => ({
    anyOf: values.map((v: string) => ({ type: "string", const: v })),
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getMarkdownTheme: () => ({}),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class ContainerMock {
    addChild() {}
  },
  Markdown: class MarkdownMock {},
  Spacer: class SpacerMock {},
  Text: class TextMock {
    constructor(_text: string, _x: number, _y: number) {}
  },
}));

interface RegisteredToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

interface RegisteredSubagentTool {
  name: string;
  promptSnippet: string;
  description: string;
  promptGuidelines?: unknown;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<RegisteredToolResult>;
}

// Capture the tool definition when registerTool is called.
let registeredTool: RegisteredSubagentTool | undefined;

function isRegisteredSubagentTool(value: unknown): value is RegisteredSubagentTool {
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    candidate["name"] === "subagent" &&
    typeof candidate["promptSnippet"] === "string" &&
    typeof candidate["description"] === "string" &&
    typeof candidate["execute"] === "function" &&
    candidate["parameters"] !== undefined
  );
}

function createMockPi(providerNames?: string[]) {
  registeredTool = undefined;
  return createTestExtensionApi({
    onRegisterTool(definition) {
      if (!isRegisteredSubagentTool(definition)) {
        throw new Error("subagent registered an invalid tool");
      }
      registeredTool = definition;
    },
    getAllTools: providerNames
      ? () =>
          providerNames.map((name) => ({
            name,
            description: "provider fixture",
            parameters: Type.Object({}),
            sourceInfo: {
              path: `/fixture/${name}`,
              source: "subagent-test",
              scope: "project",
              origin: "top-level",
            },
          }))
      : undefined,
  });
}

function subagentTool(): RegisteredSubagentTool {
  if (registeredTool === undefined) throw new Error("subagent tool was not registered");
  return registeredTool;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  return object(object(schema)["properties"]);
}

describe("subagent tool registration", () => {
  beforeEach(() => {
    vi.resetModules();
    registeredTool = undefined;
  });

  it("registers with promptSnippet containing discovered agent names", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const snippet = subagentTool().promptSnippet;
    expect(snippet).toContain("echo");
    expect(snippet).toContain("skribble");
    expect(snippet).toContain("piper");
    expect(snippet).toContain("carren");
    expect(snippet).toContain("vera");
    expect(snippet).toContain("synthia");
    expect(snippet).toContain("tabitha");
    expect(snippet).toContain("skribble");
  });

  it("includes every discovered agent name and description in the tool description", async () => {
    const mod = await import("../../index.js");
    const { discoverAgents, formatModelVisibleAgentCatalog } = await import("../../agents.js");
    const pi = createMockPi();
    mod.default(pi);

    const agents = discoverAgents(process.cwd(), "project").agents;
    const expectedCatalog = formatModelVisibleAgentCatalog(agents);
    const description = subagentTool().description;
    expect(description).toContain(expectedCatalog);
    for (const agent of agents) expect(expectedCatalog).toContain(`${agent.name}:`);
  });

  it("keeps routing and anti-use guidance in the provider-visible description", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    expect(subagentTool().promptGuidelines).toBeUndefined();
    const description = subagentTool().description;
    expect(description).toContain("Use when");
    expect(description).toContain("Do not use");
    expect(description).toContain("use the skill tool instead");
    expect(description).toContain("cannot see the parent conversation");
  });

  it("fails before spawn when one YAML-declared provider is unregistered", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi(["read"]);
    mod.default(pi);
    const result = await subagentTool().execute(
      "call",
      { agent: "carren", task: "review" },
      undefined,
      undefined,
      { cwd: process.cwd(), hasUI: false }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TOOL_PROVIDER_MISSING");
    expect(result.content[0].text).toContain("artifact_read");
  });

  it("agent parameter schema references discovered agent names", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const properties = schemaProperties(subagentTool().parameters);
    const agentProp = properties["agent"];
    expect(agentProp).toBeDefined();

    // StringEnum produces an anyOf array of const schemas in our mock.
    // Verify the real agent names appear in the schema.
    const schemaText = JSON.stringify(agentProp);
    expect(schemaText).toContain("echo");
    expect(schemaText).toContain("skribble");
    expect(schemaText).toContain("piper");
    expect(object(properties["input_artifacts"])["maxItems"]).toBeUndefined();
    expect(schemaProperties(object(properties["tasks"])["items"])).toHaveProperty(
      "input_artifacts"
    );
    expect(schemaProperties(object(properties["chain"])["items"])).toHaveProperty(
      "input_artifacts"
    );
  });
});

describe("subagent tool registration with empty agent discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    registeredTool = undefined;
  });

  it("falls back to safe enum when no agents are discovered", async () => {
    // Mock the sole local discovery module to return an empty catalog.
    vi.doMock("../../agents.js", async () => {
      const actual = await vi.importActual<typeof import("../../agents.js")>("../../agents.js");
      return {
        ...actual,
        discoverAgents: vi.fn(() => ({ agents: [], projectAgentsDir: null })),
      };
    });

    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const snippet = subagentTool().promptSnippet;
    expect(snippet).toContain("no agents discovered");
    expect(subagentTool().description).toContain("Available agents: none discovered.");

    const agentProp = schemaProperties(subagentTool().parameters)["agent"];
    const schemaText = JSON.stringify(agentProp);
    expect(schemaText).toContain("no-agents-found");

    vi.doUnmock("../../agents.js");
  });
});
