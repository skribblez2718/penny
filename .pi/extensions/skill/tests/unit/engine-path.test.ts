/**
 * Engine-path tests: every skill runs on the run_id/checkpointer contract —
 * recover first, then start/step with `--run-id` and NEVER `--state` (the
 * legacy --state argv transport has been removed entirely; the durable
 * checkpointer owns all FSM state). The ONLY skill without an orchestrate.py
 * is `rez` (a content-only skill) — it hits the `hasOrchestrate` guard and
 * never spawns Python at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("child_process", () => ({ spawn: mockSpawn }));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

// Toggle per test: `engine` is now cosmetic (SKILL.md metadata is no longer
// consulted for routing — every skill with an orchestrate.py runs on the
// engine substrate), `hasOrchestrate` controls whether the mocked skill has
// scripts/orchestrate.py on disk (rez does not).
const { state } = vi.hoisted(() => ({ state: { engine: true, hasOrchestrate: true } }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (p.includes("orchestrate.py")) return state.hasOrchestrate;
      if (p.includes("SKILL.md")) return true;
      if (p.includes("assets/prompts")) return false;
      if (p.includes(".pi/agents")) return true;
      if (String(p).endsWith(".md")) return true;
      return (actual.existsSync as any)(p);
    }),
    readFileSync: vi.fn((p: string) => {
      if (p.includes("SKILL.md")) {
        const eng = state.engine ? "\nmetadata:\n  penny:\n    engine: orchestration" : "";
        return `---\nname: eng-skill\ndescription: test${eng}\n---`;
      }
      if (p.includes(".pi/agents/")) return "---\nname: echo\ndescription: desc\n---\n# Prompt\n";
      return (actual.readFileSync as any)(p);
    }),
    readdirSync: vi.fn((p: string, _opts?: any) => {
      if (String(p).includes(".pi/skills"))
        return [{ name: "eng-skill", isDirectory: () => true }] as any;
      if (String(p).includes(".pi/agents"))
        return [
          {
            name: "echo.md",
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          },
        ] as any;
      return [];
    }),
    statSync: vi.fn((p: string) => ({
      isDirectory: () => String(p).includes(".pi/skills") || String(p).includes(".pi/agents"),
    })),
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_p: string, fn: () => any) => fn()),
  parseFrontmatter: (content: string) => {
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return { frontmatter: {}, body: content };
    const fm: Record<string, string> = {};
    for (const line of m[1].split("\n")) {
      const mm = line.match(/^(\w+):\s*(.+)$/);
      if (mm) fm[mm[1]] = mm[2].trim();
    }
    return { frontmatter: fm, body: content.replace(/^---\n[\s\S]*?\n---\n?/, "") };
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

function buildPythonSpawner(payloads: any[]) {
  let idx = 0;
  return (_cmd: string, args: string[]) => {
    if (!args[0]?.includes("orchestrate.py")) {
      return {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((e: string, cb: Function) => {
          if (e === "close") setTimeout(() => cb(0), 0);
        }),
      };
    }
    const payload = payloads[idx++];
    return {
      stdout: {
        on: vi.fn((e: string, cb: Function) => {
          if (e === "data" && payload) cb(Buffer.from(JSON.stringify(payload)));
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((e: string, cb: Function) => {
        if (e === "close") setTimeout(() => cb(0), 0);
      }),
    };
  };
}

function orchestrateCalls() {
  return mockSpawn.mock.calls.filter((c: any) => (c[1] as string[])[0]?.includes("orchestrate.py"));
}
const cmdOf = (call: any) => (call[1] as string[])[1];
const argsOf = (call: any) => call[1] as string[];

async function run() {
  const mod = await import("../../index.js");
  const pi = createMockPi();
  mod.default(pi);
  const ctx = { cwd: process.cwd(), ui: { theme: { fg: () => "" }, notify: vi.fn() } };
  return registeredTool.execute(
    "t1",
    { skill_name: "eng-skill", goal: "prove it" },
    undefined,
    undefined,
    ctx
  );
}

describe("skill engine path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    state.engine = true;
    state.hasOrchestrate = true;
    process.env.PROJECT_ROOT = PROJECT_ROOT;
  });
  afterEach(() => {
    delete process.env.PROJECT_ROOT;
  });

  it("engine skill: recover first, then start/step with --run-id and no --state", async () => {
    state.engine = true;
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" }, // recover -> none
        {
          action: "invoke_agent",
          state_id: "framing",
          session_id: "s",
          run_id: "R",
          agent: "echo",
          task_summary: "frame it",
        }, // start
        { action: "complete", state_id: "complete", session_id: "s", run_id: "R" }, // step
      ])
    );
    await run();
    const calls = orchestrateCalls();
    const cmds = calls.map(cmdOf);
    expect(cmds[0]).toBe("recover");
    expect(cmds).toContain("start");
    expect(cmds).toContain("step");
    for (const c of calls) {
      const a = argsOf(c);
      if (a[1] === "start" || a[1] === "step") {
        expect(a).toContain("--run-id");
        expect(a).not.toContain("--state");
      }
    }
  });

  it("engine skill: missing SUMMARY passes through empty + summary_missing (no domain default synthesized)", async () => {
    state.engine = true;
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
        {
          action: "invoke_agent",
          state_id: "exploring",
          session_id: "s",
          run_id: "R",
          agent: "echo",
          task_summary: "explore",
        },
        { action: "complete", state_id: "complete", session_id: "s", run_id: "R" },
      ])
    );
    await run();
    const stepCall = orchestrateCalls().find((c) => cmdOf(c) === "step");
    expect(stepCall).toBeTruthy();
    const a = argsOf(stepCall);
    const parsed = JSON.parse(a[a.indexOf("--result") + 1]);
    expect(parsed.summary).toEqual({});
    expect(parsed.summary_missing).toBe(true);
    // The engine path must NOT synthesize a domain-shaped default (e.g. echo's
    // explore_complete/findings_count) — the playbook's contract is the validator.
    expect(parsed.summary).not.toHaveProperty("explore_complete");
    expect(parsed.summary).not.toHaveProperty("findings_count");
  });

  it("skill without orchestrate.py (matching rez): hits the hasOrchestrate guard, never spawns Python", async () => {
    // rez is a content-only skill with no scripts/orchestrate.py. The legacy
    // per-skill execution path has been removed entirely — there is no
    // fallback route for a skill lacking orchestrate.py, it simply errors.
    state.engine = false;
    state.hasOrchestrate = false;
    mockSpawn.mockImplementation(buildPythonSpawner([]));
    const result = await run();
    expect(result.details.success).toBe(false);
    expect(result.details.errors).toContain("Skill has no orchestrate.py");
    // No orchestrate.py spawns at all — not recover, not start, not step.
    expect(orchestrateCalls().length).toBe(0);
  });
});
