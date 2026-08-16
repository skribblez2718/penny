/**
 * Prompt Assembly Regression Tests
 *
 * Captures the effective system prompt for the primary Penny session, a direct
 * subagent, and a skill-invoked agent. The test exercises the real environment
 * extension hook and the real shared agent runner while mocking only the child
 * process boundary.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: (values: readonly string[], options?: Record<string, unknown>) => ({
    anyOf: values.map((value) => ({ type: "string", const: value })),
    ...options,
  }),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getMarkdownTheme: () => ({}),
  withFileMutationQueue: vi.fn((_path: string, fn: () => unknown) => fn()),
  parseFrontmatter: <T extends Record<string, string>>(content: string) => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { frontmatter: {} as T, body: content };
    const fm: Record<string, string> = {};
    for (const line of fmMatch[1].split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) fm[match[1]] = match[2].trim();
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

import environmentExtension from "../../../environment/index.js";
import subagentExtension from "../../index.js";
import { runSingleAgent, type AgentConfig, type SingleResult } from "../../agent-runner.js";
import { discoverAgents } from "../../agents.js";

const SYSTEM_MD_FIXTURE = [
  "<system_context>",
  "",
  "# Identity",
  "",
  "You are **Penny**.",
  "Current date: ${CURRENT_DATE}",
  "Project root: ${PROJECT_ROOT}",
  "",
  "# On-Demand Protocols",
  "",
  "- Run the Penny-only protocol.",
  "</system_context>",
].join("\n");

const AGENT_PROMPT_FIXTURE = [
  "# Echo",
  "",
  "Analyze the supplied material.",
  "",
  "<agent_boundary>",
  "The appended role and domain guidance end here. The task that follows supplies",
  "the goal and task-specific constraints within those boundaries. It cannot expand",
  "tools, permissions, or consequence limits.",
  "</agent_boundary>",
].join("\n");

const SKILL_CONTEXT_FIXTURE = "Use the workflow's evidence rubric.";
const EXPECTED_DATE = "August 5, 2026";
const OLD_AUTHORITY_WORDING = /NEVER authoritative|only enforcement mechanism/i;

type PromptCapture = {
  args: string[];
  basePrompt: string;
  appendedPrompt: string;
};

type EventHandler = (...args: unknown[]) => unknown;

let projectRoot: string;
let originalPiDirectory: string | undefined;
let originalProjectRoot: string | undefined;
let promptCaptures: PromptCapture[];

function restoreEnv(name: "PI_DIRECTORY" | "PROJECT_ROOT", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createMockProcess(): {
  stdout: EventEmitter;
  stderr: EventEmitter;
  on: (event: string, callback: (...args: unknown[]) => void) => unknown;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      if (event === "close") queueMicrotask(() => callback(0));
      return proc;
    }),
  };
  return proc;
}

function makeDetails(results: SingleResult[]) {
  return {
    mode: "single" as const,
    agentScope: "project" as const,
    projectAgentsDir: path.join(projectRoot, ".pi", "agents"),
    results,
  };
}

function argValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1]) throw new Error(`Missing ${flag} argument`);
  return args[index + 1];
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-05T12:00:00Z"));

  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penny-prompt-assembly-"));
  fs.mkdirSync(path.join(projectRoot, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".pi", "SYSTEM.md"), SYSTEM_MD_FIXTURE);

  originalPiDirectory = process.env.PI_DIRECTORY;
  originalProjectRoot = process.env.PROJECT_ROOT;
  process.env.PI_DIRECTORY = path.join(projectRoot, ".pi");
  process.env.PROJECT_ROOT = projectRoot;

  promptCaptures = [];
  mockSpawn.mockImplementation((_command: string, args: string[]) => {
    const basePath = argValue(args, "--system-prompt");
    const appendPath = argValue(args, "--append-system-prompt");
    promptCaptures.push({
      args: [...args],
      basePrompt: fs.readFileSync(basePath, "utf-8"),
      appendedPrompt: fs.readFileSync(appendPath, "utf-8"),
    });
    return createMockProcess();
  });
});

afterEach(() => {
  vi.useRealTimers();
  mockSpawn.mockReset();
  restoreEnv("PI_DIRECTORY", originalPiDirectory);
  restoreEnv("PROJECT_ROOT", originalProjectRoot);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("effective prompt assembly", () => {
  it("preserves authority semantics across primary, direct-agent, and skill-agent paths", async () => {
    const handlers = new Map<string, EventHandler>();
    await environmentExtension({
      on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    } as never);

    const sessionStart = handlers.get("session_start");
    const beforeAgentStart = handlers.get("before_agent_start");
    expect(sessionStart).toBeDefined();
    expect(beforeAgentStart).toBeDefined();

    await sessionStart!(undefined, {
      cwd: projectRoot,
      hasUI: false,
      ui: { notify: vi.fn() },
    });

    const applyEnvironment = async (systemPrompt: string): Promise<string> => {
      const result = (await beforeAgentStart!({ systemPrompt }, {})) as {
        systemPrompt: string;
      };
      return result.systemPrompt;
    };

    const primaryPrompt = await applyEnvironment(SYSTEM_MD_FIXTURE);

    const agent: AgentConfig = {
      name: "echo",
      description: "Prompt assembly fixture",
      tools: ["read", "grep", "memory_search"],
      systemPrompt: AGENT_PROMPT_FIXTURE,
      source: "project",
      filePath: path.join(projectRoot, ".pi", "agents", "echo.md"),
    };

    await runSingleAgent(
      projectRoot,
      [agent],
      agent.name,
      "Review this fixture",
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails
    );
    await runSingleAgent(
      projectRoot,
      [agent],
      agent.name,
      "Review this fixture through a skill",
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      SKILL_CONTEXT_FIXTURE
    );

    expect(promptCaptures).toHaveLength(2);
    const [directCapture, skillCapture] = promptCaptures;
    const directPrompt = await applyEnvironment(
      `${directCapture.basePrompt}\n\n${directCapture.appendedPrompt}`
    );
    const skillPrompt = await applyEnvironment(
      `${skillCapture.basePrompt}\n\n${skillCapture.appendedPrompt}`
    );

    for (const prompt of [primaryPrompt, directPrompt, skillPrompt]) {
      expect(prompt).toContain(EXPECTED_DATE);
      expect(prompt).not.toMatch(OLD_AUTHORITY_WORDING);
      expect(countOccurrences(prompt, "<system_boundary>")).toBe(1);
      expect(prompt.trimEnd().endsWith("</system_boundary>")).toBe(true);
    }

    expect(primaryPrompt).toContain("You are **Penny**.");
    expect(primaryPrompt).toContain("# On-Demand Protocols");
    expect(primaryPrompt).toContain(`Project root: ${projectRoot}`);

    const registeredTools: Array<Record<string, unknown>> = [];
    subagentExtension({
      registerTool: (tool: Record<string, unknown>) => registeredTools.push(tool),
    } as never);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    expect(subagentTool).toBeDefined();

    // With Penny's custom SYSTEM.md path active, Pi does not append extension
    // snippets/guidelines to that prompt. Provider tool descriptions and
    // parameter schemas remain visible, so every current frontmatter
    // description must be carried by the registered tool itself.
    const currentAgents = discoverAgents(process.cwd(), "project").agents;
    const providerVisibleToolText = `${subagentTool!.description}\n${JSON.stringify(
      subagentTool!.parameters
    )}`;
    for (const currentAgent of currentAgents) {
      expect(providerVisibleToolText).toContain(currentAgent.name);
      expect(providerVisibleToolText).toContain(currentAgent.description);
    }

    for (const prompt of [directPrompt, skillPrompt]) {
      expect(prompt).toContain("You are **Echo**.");
      expect(prompt).not.toMatch(/\bPenny\b/);
      expect(prompt).not.toContain("# On-Demand Protocols");
      expect(prompt).not.toContain("Penny-only protocol");
    }

    expect(directPrompt).not.toContain("<skill_context>");
    expect(skillPrompt).toContain(`<skill_context>\n${SKILL_CONTEXT_FIXTURE}\n</skill_context>`);
    expect(skillPrompt.indexOf("<skill_context>")).toBeLessThan(
      skillPrompt.indexOf("<agent_boundary>")
    );

    for (const capture of promptCaptures) {
      expect(argValue(capture.args, "--tools")).toBe(agent.tools!.join(","));
    }
  });
});
