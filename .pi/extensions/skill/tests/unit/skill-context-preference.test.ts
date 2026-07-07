/**
 * Skill Extension skillContext Preference Tests
 *
 * Proves the single-agent (invoke_agent) dispatch path honours an explicit
 * orchestrator-supplied `action.skillContext` field, and falls back to the
 * legacy bare `assets/prompts/{agent}.md` guess only when no explicit context
 * is supplied.
 *
 * Design of the assertion point: index.ts selects a skill-context file path,
 * guards it with existsSync, then hands it to resolveSkillContext (in
 * agent-runner) which readFileSync's the WINNING path. So the set of
 * readFileSync calls against `assets/prompts/*` tells us exactly which prompt
 * file "won" — a precise, non-brittle signal that does not depend on temp-file
 * plumbing.
 *
 * Fallback discipline (deliberate, documented choice): when an explicit
 * skillContext is supplied but does NOT exist on disk (or is empty/whitespace),
 * the code falls THROUGH to the legacy bare `{agent}.md` guess — i.e. an
 * explicit-but-missing context degrades to exactly the pre-existing behaviour,
 * never crashing, never "explicitly no context".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Resolve the project root dynamically from this test file's location
// (.pi/extensions/skill/tests/unit/ → five levels up) instead of hardcoding.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

const { mockSpawn, fsState } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  fsState: {
    // Suffixes (path endings) that should report as NON-existent for this test.
    nonExistent: new Set<string>(),
    // Records readFileSync calls against assets/prompts/* (the "winning" file).
    promptReads: [] as string[],
  },
}));

vi.mock("child_process", () => ({ spawn: mockSpawn }));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const isNonExistent = (p: string) => {
    for (const suffix of fsState.nonExistent) {
      if (p.endsWith(suffix)) return true;
    }
    return false;
  };
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      const s = String(p);
      if (isNonExistent(s)) return false;
      if (s.includes("orchestrate.py")) return true;
      if (s.includes("SKILL.md")) return true;
      if (s.includes("assets/prompts") && s.endsWith(".md")) return true;
      if (s.includes(".pi/agents")) return true;
      if (s.endsWith(".md")) return true;
      return (actual.existsSync as any)(p);
    }),
    readFileSync: vi.fn((p: string, ...rest: any[]) => {
      const s = String(p);
      if (s.includes("SKILL.md")) return "---\nname: test-skill\ndescription: test\n---";
      if (s.includes(".pi/agents/")) {
        return "---\nname: echo\ndescription: desc\n---\n# Prompt\n";
      }
      if (s.includes("assets/prompts")) {
        fsState.promptReads.push(s);
        if (s.endsWith("echo-threat-model.md")) return "EXPLICIT_CONTEXT_MARKER";
        return "BARE_CONTEXT_MARKER";
      }
      return (actual.readFileSync as any)(p, ...rest);
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
      if (String(p).includes(".pi/skills") || String(p).includes(".pi/agents")) {
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
      // Agent pi subprocess — no output, close cleanly.
      return {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: Function) => {
          if (event === "close") setTimeout(() => cb(0), 0);
        }),
      };
    }
    const payload = actionPayloads[idx++];
    return {
      stdout: {
        on: vi.fn((event: string, cb: Function) => {
          if (event === "data" && payload) cb(Buffer.from(JSON.stringify(payload)));
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: Function) => {
        if (event === "close") setTimeout(() => cb(0), 0);
      }),
    };
  };
}

async function runSingleAgentSkill(action: Record<string, unknown>) {
  mockSpawn.mockImplementation(
    buildPythonSpawner([
      { state_id: "s1", session_id: "sess1", ...action, action: "invoke_agent" },
      { action: "complete", state_id: "s2", session_id: "sess1" },
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
}

function promptReadsInAssets(): string[] {
  return fsState.promptReads.filter((p) => p.includes("assets/prompts"));
}

describe("skill extension skillContext preference (single-agent path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsState.nonExistent.clear();
    fsState.promptReads.length = 0;
    process.env.PROJECT_ROOT = PROJECT_ROOT;
  });

  afterEach(() => {
    delete process.env.PROJECT_ROOT;
  });

  it("(a) explicit action.skillContext wins over the bare {agent}.md guess", async () => {
    // Both files exist on disk. The explicit context MUST win.
    await runSingleAgentSkill({
      agent: "echo",
      task_summary: "do something",
      skillContext: "assets/prompts/echo-threat-model.md",
    });

    const reads = promptReadsInAssets();
    expect(reads.some((p) => p.endsWith("echo-threat-model.md"))).toBe(true);
    expect(reads.some((p) => p.endsWith("prompts/echo.md"))).toBe(false);
  });

  it("(b) no skillContext field → legacy bare {agent}.md guess is preserved", async () => {
    await runSingleAgentSkill({
      agent: "echo",
      task_summary: "do something",
      // no skillContext
    });

    const reads = promptReadsInAssets();
    expect(reads.some((p) => p.endsWith("prompts/echo.md"))).toBe(true);
    expect(reads.some((p) => p.endsWith("echo-threat-model.md"))).toBe(false);
  });

  it("(c) explicit skillContext pointing at a missing file → falls through to bare guess (no crash)", async () => {
    fsState.nonExistent.add("echo-threat-model.md");
    await runSingleAgentSkill({
      agent: "echo",
      task_summary: "do something",
      skillContext: "assets/prompts/echo-threat-model.md",
    });

    const reads = promptReadsInAssets();
    // Explicit missing → degrade to legacy bare guess.
    expect(reads.some((p) => p.endsWith("prompts/echo.md"))).toBe(true);
    expect(reads.some((p) => p.endsWith("echo-threat-model.md"))).toBe(false);
  });

  it("(d) whitespace-only skillContext is treated as absent → bare guess", async () => {
    await runSingleAgentSkill({
      agent: "echo",
      task_summary: "do something",
      skillContext: "   ",
    });

    const reads = promptReadsInAssets();
    expect(reads.some((p) => p.endsWith("prompts/echo.md"))).toBe(true);
  });
});
