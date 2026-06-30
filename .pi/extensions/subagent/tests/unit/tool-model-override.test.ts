/**
 * Subagent Tool Model Override Tests
 *
 * Verifies that the subagent tool forwards model/modelOverride correctly
 * in single, parallel, and chain modes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunSingleAgent = vi.fn(() =>
  Promise.resolve({
    agent: "echo",
    agentSource: "project" as const,
    task: "test",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  })
);

vi.mock("../../agent-runner.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../agent-runner.js")>("../../agent-runner.js");
  return {
    ...actual,
    runSingleAgent: mockRunSingleAgent,
  };
});

vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: (values: readonly string[], _opts?: any) => ({
    anyOf: values.map((v: string) => ({ type: "string", const: v })),
  }),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getMarkdownTheme: () => ({}),
  parseFrontmatter: <T extends Record<string, string>>(content: string) => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { frontmatter: {} as T, body: content };
    const fm: Record<string, string> = {};
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) fm[m[1]] = m[2].trim();
    }
    return {
      frontmatter: fm as T,
      body: content.replace(/^---\n[\s\S]*?\n---\n?/, ""),
    };
  },
}));

vi.mock("@mariozechner/pi-tui", () => ({
  Container: class ContainerMock {
    addChild() {}
  },
  Markdown: class MarkdownMock {},
  Spacer: class SpacerMock {},
  Text: class TextMock {
    constructor(_text: string, _x: number, _y: number) {}
  },
}));

let registeredTool: any;

function createMockPi(): any {
  registeredTool = undefined;
  return {
    registerTool: (def: any) => {
      registeredTool = def;
    },
  };
}

function getModelOverride(callIndex: number): any {
  return (mockRunSingleAgent.mock.calls[callIndex] as any[])[11];
}

describe("subagent tool model override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("single mode: forwards params.model as modelOverride", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = { cwd: process.cwd(), hasUI: false };
    await registeredTool.execute(
      "tool-1",
      { agent: "echo", task: "hello", model: "single-override" },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
    expect(getModelOverride(0)).toBe("single-override");
  });

  it("parallel mode: forwards per-task model as modelOverride", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = { cwd: process.cwd(), hasUI: false };
    await registeredTool.execute(
      "tool-1",
      {
        tasks: [
          { agent: "echo", task: "hello", model: "parallel-model-a" },
          { agent: "skribble", task: "world" },
        ],
      },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(2);
    expect(getModelOverride(0)).toBe("parallel-model-a");
    expect(getModelOverride(1)).toBeUndefined();
  });

  it("chain mode: forwards per-step model as modelOverride", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = { cwd: process.cwd(), hasUI: false };
    await registeredTool.execute(
      "tool-1",
      {
        chain: [
          { agent: "echo", task: "step1", model: "chain-model" },
          { agent: "piper", task: "step2" },
        ],
      },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(2);
    expect(getModelOverride(0)).toBe("chain-model");
    expect(getModelOverride(1)).toBeUndefined();
  });

  it("backward compatibility: no model means undefined modelOverride", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = { cwd: process.cwd(), hasUI: false };
    await registeredTool.execute(
      "tool-1",
      { agent: "echo", task: "hello" },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
    expect(getModelOverride(0)).toBeUndefined();
  });

  it("schema includes model in SubagentParams", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const params = registeredTool.parameters as any;
    expect(params.properties).toHaveProperty("model");
    expect(params.properties.model.type).toBe("string");
  });
});
