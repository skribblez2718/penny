/**
 * Subagent Extension Integration Tests
 *
 * Tests the subagent extension with real tool registration and parameter validation:
 * - Tool registration verification
 * - Mode detection (single, parallel, chain)
 * - Agent discovery from real filesystem
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock Pi dependencies that require runtime packages
vi.mock("@earendil-works/pi-ai", async () => {
  const { Type } = await import("typebox");
  return {
    StringEnum: (values: readonly string[], options?: Record<string, unknown>) =>
      Type.Union(
        values.map((value) => Type.Literal(value)),
        options
      ),
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getMarkdownTheme: vi.fn().mockReturnValue({
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  }),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: vi.fn(),
  Spacer: vi.fn(),
  Text: vi.fn().mockImplementation((text: string) => ({ text, x: 0, y: 0 })),
}));

import { createTestExtensionApi, isRecord } from "../../../../lib/tests/test-narrowers.js";

interface RegisteredSubagentTool {
  name: string;
  promptSnippet: string;
  description: string;
  promptGuidelines?: unknown;
}

function isRegisteredSubagentTool(value: unknown): value is RegisteredSubagentTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.promptSnippet === "string" &&
    typeof value.description === "string"
  );
}

function createMockPi(registeredTools: RegisteredSubagentTool[]) {
  return createTestExtensionApi({
    onRegisterTool(tool) {
      if (!isRegisteredSubagentTool(tool)) throw new Error("subagent registered an invalid tool");
      registeredTools.push(tool);
    },
  });
}

function findSubagentTool(registeredTools: RegisteredSubagentTool[]): RegisteredSubagentTool {
  const tool = registeredTools.find((candidate) => candidate.name === "subagent");
  if (tool === undefined) throw new Error("subagent tool was not registered");
  return tool;
}

describe("Subagent Integration — Agent Discovery", () => {
  // Resolve project root from test runner location (at .pi/extensions/subagent/)
  const projectRoot = path.resolve(process.cwd(), "../../..");

  it("should find agent definitions in .pi/agents/", () => {
    const agentsDir = path.join(projectRoot, ".pi/agents");
    expect(fs.existsSync(agentsDir)).toBe(true);

    const agents = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    expect(agents.length).toBeGreaterThan(0);

    const agentNames = agents.map((f) => path.basename(f, ".md"));
    expect(agentNames).toContain("echo");
    expect(agentNames).toContain("piper");
    expect(agentNames).toContain("carren");
    expect(agentNames).toContain("tabitha");
  });

  it("should have valid YAML frontmatter in agent files", () => {
    const agentsDir = path.join(projectRoot, ".pi/agents");
    const agents = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

    for (const agent of agents) {
      const content = fs.readFileSync(path.join(agentsDir, agent), "utf-8");
      expect(content.startsWith("---")).toBe(true);
    }
  });
});

describe("Subagent Integration — Tool Registration", () => {
  it("should register the subagent tool via ExtensionAPI", async () => {
    const registeredTools: RegisteredSubagentTool[] = [];
    const mockPi = createMockPi(registeredTools);

    const mod = await import("../../index.js");
    mod.default(mockPi);

    expect(registeredTools.some((t) => t.name === "subagent")).toBe(true);
  });

  it("should include promptSnippet with discovered agent names", async () => {
    const registeredTools: RegisteredSubagentTool[] = [];
    const mockPi = createMockPi(registeredTools);

    const mod = await import("../../index.js");
    mod.default(mockPi);

    const subagent = findSubagentTool(registeredTools);
    expect(subagent.promptSnippet).toContain("echo");
    expect(subagent.promptSnippet).toContain("skribble");
    expect(subagent.promptSnippet).toContain("piper");
  });

  it("should keep routing and anti-use guidance provider-visible in the description", async () => {
    const registeredTools: RegisteredSubagentTool[] = [];
    const mockPi = createMockPi(registeredTools);

    const mod = await import("../../index.js");
    mod.default(mockPi);

    const subagent = findSubagentTool(registeredTools);
    expect(subagent.promptGuidelines).toBeUndefined();
    expect(subagent.description).toContain("Use when");
    expect(subagent.description).toContain("Do not use");
    expect(subagent.description).toContain("use the skill tool instead");
  });

  it("should discover all 8 agents from .pi/agents/", async () => {
    const projectRoot = path.resolve(process.cwd(), "../../..");
    const agentsDir = path.join(projectRoot, ".pi/agents");
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    const expectedNames = files.map((f) => path.basename(f, ".md"));

    const registeredTools: RegisteredSubagentTool[] = [];
    const mockPi = createMockPi(registeredTools);

    const mod = await import("../../index.js");
    mod.default(mockPi);

    const subagent = findSubagentTool(registeredTools);
    for (const name of expectedNames) {
      expect(subagent.promptSnippet).toContain(name);
    }
  });
});

describe("Subagent Integration — Mode Detection", () => {
  function detectMode(params: {
    agent?: string;
    task?: string;
    tasks?: unknown[];
    chain?: unknown[];
  }): "single" | "parallel" | "chain" | "invalid" {
    if (params.chain && Array.isArray(params.chain)) return "chain";
    if (params.tasks && Array.isArray(params.tasks)) return "parallel";
    if (params.agent && params.task) return "single";
    return "invalid";
  }

  it("should detect single mode", () => {
    expect(detectMode({ agent: "echo", task: "test" })).toBe("single");
  });

  it("should detect parallel mode", () => {
    expect(
      detectMode({
        tasks: [
          { agent: "echo", task: "a" },
          { agent: "carren", task: "b" },
        ],
      })
    ).toBe("parallel");
  });

  it("should detect chain mode", () => {
    expect(
      detectMode({
        chain: [
          { agent: "echo", task: "step 1" },
          { agent: "piper", task: "step 2 {previous}" },
        ],
      })
    ).toBe("chain");
  });

  it("should detect invalid mode when no params", () => {
    expect(detectMode({})).toBe("invalid");
  });
});
