/**
 * Skill Extension Model Override Tests
 *
 * Verifies that when a skill orchestrator action includes a model field,
 * it is forwarded as modelOverride to runSingleAgent (observed via spawn
 * args) for both single-agent and parallel-agent invocations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (p.includes("orchestrate.py")) return true;
      if (p.includes("SKILL.md")) return true;
      if (p.includes("assets/prompts")) return false;
      if (p.includes(".pi/agents")) return true;
      if (String(p).endsWith(".md")) return true;
      return (actual.existsSync as any)(p);
    }),
    readFileSync: vi.fn((p: string) => {
      if (p.includes("SKILL.md"))
        return "---\nname: test-skill\ndescription: test\n---";
      if (p.includes(".pi/agents/")) {
        return "---\nname: echo\ndescription: desc\n---\n# Prompt\n";
      }
      return (actual.readFileSync as any)(p);
    }),
    readdirSync: vi.fn((p: string, _opts?: any) => {
      if (String(p).includes(".pi/skills")) {
        return [{ name: "test-skill", isDirectory: () => true }] as any;
      }
      if (String(p).includes(".pi/agents")) {
        return [
          {
            name: "echo.md",
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          },
        ] as any;
      }
      return [];
    }),
    statSync: vi.fn((p: string) => {
      if (
        String(p).includes(".pi/skills") ||
        String(p).includes(".pi/agents")
      ) {
        return { isDirectory: () => true };
      }
      return { isDirectory: () => false };
    }),
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, fn: () => any) => fn()),
  parseFrontmatter: (content: string) => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { frontmatter: {}, body: content };
    const fm: Record<string, string> = {};
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) fm[m[1]] = m[2].trim();
    }
    return {
      frontmatter: fm,
      body: content.replace(/^---\n[\s\S]*?\n---\n?/, ""),
    };
  },
}));

vi.mock("@mariozechner/pi-tui", () => ({
  Container: class {
    addChild() {}
  },
  Markdown: class {},
  Text: class {},
  Spacer: class {},
}));

let registeredTool: any;

function createMockPi(): any {
  registeredTool = undefined;
  return {
    registerTool: (def: any) => {
      registeredTool = def;
    },
    on: vi.fn(),
    registerCommand: vi.fn(),
  };
}

function buildPythonSpawner(actionPayloads: any[]) {
  let idx = 0;
  return (_cmd: string, args: string[]) => {
    if (!args[0]?.includes("orchestrate.py")) {
      return {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: Function) => {
          if (event === "close") setTimeout(() => cb(0), 0);
        }),
      };
    }
    const payload = actionPayloads[idx++];
    const mockProc = {
      stdout: {
        on: vi.fn((event: string, cb: Function) => {
          if (event === "data" && payload) {
            cb(Buffer.from(JSON.stringify(payload)));
          }
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: Function) => {
        if (event === "close") setTimeout(() => cb(0), 0);
      }),
    };
    return mockProc;
  };
}

function getAgentSpawnCalls() {
  return mockSpawn.mock.calls.filter((call: any) => {
    const args = call[1] as string[];
    return args.includes("--mode") && args.includes("json");
  });
}

function getModelArg(spawnCall: any): string | undefined {
  const args = spawnCall[1] as string[];
  const idx = args.indexOf("--model");
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe("skill extension model override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROJECT_ROOT = "/home/skribblez/projects/penny";
  });

  afterEach(() => {
    delete process.env.PROJECT_ROOT;
  });

  it("single agent: forwards action.model as modelOverride via --model arg", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        {
          action: "invoke_agent",
          state_id: "s1",
          session_id: "sess1",
          agent: "echo",
          task_summary: "do something",
          model: "skill-override-model",
        },
        {
          action: "complete",
          state_id: "s2",
          session_id: "sess1",
        },
      ])
    );

    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = {
      cwd: process.cwd(),
      ui: { theme: { fg: () => "" }, notify: vi.fn() },
    };
    await registeredTool.execute(
      "tool-1",
      { skill_name: "test-skill", goal: "test goal" },
      undefined,
      undefined,
      ctx
    );

    const agentCalls = getAgentSpawnCalls();
    expect(agentCalls.length).toBe(1);
    expect(getModelArg(agentCalls[0])).toBe("skill-override-model");
  });

  it("parallel agents: forwards per-task model as modelOverride via --model arg", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        {
          action: "invoke_agents_parallel",
          state_id: "s1",
          session_id: "sess1",
          tasks: [
            { agent: "echo", task_summary: "task1", model: "parallel-model-a" },
            { agent: "echo", task_summary: "task2" },
          ],
        },
        {
          action: "complete",
          state_id: "s2",
          session_id: "sess1",
        },
      ])
    );

    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = {
      cwd: process.cwd(),
      ui: { theme: { fg: () => "" }, notify: vi.fn() },
    };
    await registeredTool.execute(
      "tool-1",
      { skill_name: "test-skill", goal: "test goal" },
      undefined,
      undefined,
      ctx
    );

    const agentCalls = getAgentSpawnCalls();
    expect(agentCalls.length).toBe(2);
    expect(getModelArg(agentCalls[0])).toBe("parallel-model-a");
    expect(getModelArg(agentCalls[1])).toBeUndefined();
  });

  it("schema includes model in SkillStep", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const params = registeredTool.parameters as any;
    expect(params.properties).toHaveProperty("chain");
    expect(params.properties.chain.items.properties).toHaveProperty("model");
    expect(params.properties.chain.items.properties.model.type).toBe("string");
  });
});
