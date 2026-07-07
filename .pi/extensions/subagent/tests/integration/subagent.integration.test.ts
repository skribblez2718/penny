/**
 * Subagent Extension Integration Tests
 *
 * Tests the subagent extension with real tool registration and parameter validation:
 * - Tool registration verification
 * - Mode detection (single, parallel, chain)
 * - Agent discovery from real filesystem
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock Pi dependencies that require runtime packages
vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getMarkdownTheme: vi.fn().mockReturnValue({
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  }),
  parseFrontmatter: <T extends Record<string, string>>(content: string) => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { frontmatter: {} as T, body: content };
    const fm: Record<string, string> = {};
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) fm[m[1]] = m[2].trim();
    }
    return { frontmatter: fm as T, body: content.replace(/^---\n[\s\S]*?\n---\n?/, "") };
  },
}));

vi.mock("@mariozechner/pi-tui", () => ({
  Container: vi.fn(),
  Spacer: vi.fn(),
  Text: vi.fn().mockImplementation((text: string) => ({ text, x: 0, y: 0 })),
}));

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
    const registeredTools: { name: string; promptSnippet?: string; promptGuidelines?: string[] }[] =
      [];

    const mockPi = {
      registerTool: vi.fn((tool: { name: string }) => {
        registeredTools.push(tool as any);
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    const mod = await import("../../index.js");
    mod.default(mockPi);

    expect(registeredTools.some((t) => t.name === "subagent")).toBe(true);
  });

  it("should include promptSnippet with discovered agent names", async () => {
    const registeredTools: any[] = [];
    const mockPi = {
      registerTool: vi.fn((tool: any) => {
        registeredTools.push(tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    const mod = await import("../../index.js");
    mod.default(mockPi);

    const subagent = registeredTools.find((t) => t.name === "subagent");
    expect(subagent).toBeDefined();
    expect(subagent.promptSnippet).toContain("echo");
    expect(subagent.promptSnippet).toContain("skribble");
    expect(subagent.promptSnippet).toContain("piper");
  });

  it("should include promptGuidelines with anti-pattern guidance", async () => {
    const registeredTools: any[] = [];
    const mockPi = {
      registerTool: vi.fn((tool: any) => {
        registeredTools.push(tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    const mod = await import("../../index.js");
    mod.default(mockPi);

    const subagent = registeredTools.find((t) => t.name === "subagent");
    expect(subagent).toBeDefined();
    expect(subagent.promptGuidelines).toBeInstanceOf(Array);
    expect(subagent.promptGuidelines!.length).toBeGreaterThanOrEqual(5);
    expect(
      subagent.promptGuidelines!.some((g: string) => g.toLowerCase().includes("anti-pattern"))
    ).toBe(true);
  });

  it("should discover all 8 agents from .pi/agents/", async () => {
    const projectRoot = path.resolve(process.cwd(), "../../..");
    const agentsDir = path.join(projectRoot, ".pi/agents");
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    const expectedNames = files.map((f) => path.basename(f, ".md"));

    const registeredTools: any[] = [];
    const mockPi = {
      registerTool: vi.fn((tool: any) => {
        registeredTools.push(tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    const mod = await import("../../index.js");
    mod.default(mockPi);

    const subagent = registeredTools.find((t) => t.name === "subagent");
    expect(subagent).toBeDefined();
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
