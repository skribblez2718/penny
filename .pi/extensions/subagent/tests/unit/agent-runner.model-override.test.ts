/**
 * Agent-Runner Model Override Tests
 *
 * Verifies that runSingleAgent respects modelOverride vs agent.model
 * when building the pi process invocation args and result metadata.
 */

import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializePennyState, resolvePennyProjectState } from "@penny/orchestration/source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => "test prompt"),
    promises: {
      mkdtemp: vi.fn(() => Promise.resolve("/tmp/pi-subagent-xyz")),
      writeFile: vi.fn(() => Promise.resolve()),
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn(<T>(_path: string, fn: () => T): T => fn()),
}));

import { runSingleAgent, type SingleResult, type SubagentDetails } from "../../agent-runner.js";

function createMockProc(exitCode = 0) {
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === "close") setTimeout(() => cb(exitCode), 0);
    }),
  };
}

function spawnedArgs(index = 0): string[] {
  const call = mockSpawn.mock.calls[index];
  if (call === undefined) throw new Error(`spawn call ${index} was not captured`);
  const args: unknown = call[1];
  if (!Array.isArray(args) || !args.every((argument) => typeof argument === "string")) {
    throw new Error(`spawn call ${index} omitted string arguments`);
  }
  return args;
}

function makeDetails(results: SingleResult[]): SubagentDetails {
  return {
    mode: "single" as const,
    agentScope: "project" as const,
    projectAgentsDir: "/agents",
    results,
  };
}

describe("runSingleAgent modelOverride", () => {
  let sandbox: string;
  let testProjectRoot: string;
  const previousStateRoot = process.env.PENNY_STATE_ROOT;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(createMockProc(0));
    sandbox = mkdtempSync(path.join(tmpdir(), "penny-agent-runner-model-test-"));
    testProjectRoot = path.join(sandbox, "project");
    mkdirSync(testProjectRoot, { mode: 0o700 });
    process.env.PENNY_STATE_ROOT = path.join(sandbox, "state");
    initializePennyState(testProjectRoot, { env: process.env });
  });

  afterEach(() => {
    if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
    else process.env.PENNY_STATE_ROOT = previousStateRoot;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("prefers modelOverride over agent.model in args", async () => {
    const agents = [
      {
        name: "test-agent",
        source: "project" as const,
        description: "desc",
        filePath: "/agents/test.md",
        systemPrompt: "prompt",
        tools: ["read"],
        model: "default-model",
      },
    ];

    await runSingleAgent(
      testProjectRoot,
      agents,
      "test-agent",
      "task",
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      undefined,
      undefined,
      "override-model"
    );

    const args = spawnedArgs();
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("override-model");
    expect(args).toContain("--session-dir");
    const sessionDirectory = args[args.indexOf("--session-dir") + 1];
    const projectState = resolvePennyProjectState(testProjectRoot, { env: process.env });
    expect(sessionDirectory).toBe(path.join(projectState.paths.subagentSessions, "test-agent"));
    expect(lstatSync(sessionDirectory).isDirectory()).toBe(true);
    // Agents load Penny's project extensions so their declared tools (e.g. the
    // memory_* tools) are available; at least one is passed via explicit -e.
    // The exact set (and the --no-extensions flag that makes it deterministic)
    // is covered by agent-runner.extension-args.test.ts.
    expect(args).toContain("-e");
    expect(args).not.toContain("--no-session");
  });

  it("passes --provider from agent.provider alongside --model", async () => {
    const agents = [
      {
        name: "test-agent",
        source: "project" as const,
        description: "desc",
        filePath: "/agents/test.md",
        systemPrompt: "prompt",
        tools: ["read"],
        model: "default-model",
        provider: "litellm",
      },
    ];

    await runSingleAgent(
      testProjectRoot,
      agents,
      "test-agent",
      "task",
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      undefined,
      undefined,
      undefined
    );

    const args = spawnedArgs();
    expect(args).toContain("--provider");
    expect(args[args.indexOf("--provider") + 1]).toBe("litellm");
  });

  it("falls back to agent.model when modelOverride is absent", async () => {
    const agents = [
      {
        name: "test-agent",
        source: "project" as const,
        description: "desc",
        filePath: "/agents/test.md",
        systemPrompt: "prompt",
        tools: ["read"],
        model: "default-model",
      },
    ];

    await runSingleAgent(
      testProjectRoot,
      agents,
      "test-agent",
      "task",
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      undefined,
      undefined,
      undefined
    );

    const args = spawnedArgs();
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("default-model");
  });

  it("sets result.model to modelOverride when provided", async () => {
    const agents = [
      {
        name: "test-agent",
        source: "project" as const,
        description: "desc",
        filePath: "/agents/test.md",
        systemPrompt: "prompt",
        tools: ["read"],
        model: "default-model",
      },
    ];

    const result = await runSingleAgent(
      testProjectRoot,
      agents,
      "test-agent",
      "task",
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      undefined,
      undefined,
      "override-model"
    );

    expect(result.model).toBe("override-model");
  });

  it("sets result.model to agent.model when modelOverride is absent", async () => {
    const agents = [
      {
        name: "test-agent",
        source: "project" as const,
        description: "desc",
        filePath: "/agents/test.md",
        systemPrompt: "prompt",
        tools: ["read"],
        model: "default-model",
      },
    ];

    const result = await runSingleAgent(
      testProjectRoot,
      agents,
      "test-agent",
      "task",
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      undefined,
      undefined,
      undefined
    );

    expect(result.model).toBe("default-model");
  });

  it("passes the exact YAML list without additions, filtering, or exclude overrides", async () => {
    const agents = [
      {
        name: "test-agent",
        source: "project" as const,
        description: "desc",
        filePath: "/agents/test.md",
        systemPrompt: "prompt",
        tools: ["read", "artifact_read", "memory_search"],
      },
    ];
    await runSingleAgent(
      testProjectRoot,
      agents,
      "test-agent",
      "task",
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      undefined,
      undefined,
      undefined,
      undefined
    );
    const args = spawnedArgs();
    expect(args[args.indexOf("--tools") + 1]).toBe("read,artifact_read,memory_search");
    expect(args).not.toContain("--exclude-tools");
    expect(args).not.toContain("--no-tools");
  });

  it("omits --model arg when both modelOverride and agent.model are absent", async () => {
    const agents = [
      {
        name: "test-agent",
        source: "project" as const,
        description: "desc",
        filePath: "/agents/test.md",
        systemPrompt: "prompt",
        tools: ["read"],
      },
    ];

    await runSingleAgent(
      testProjectRoot,
      agents,
      "test-agent",
      "task",
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      undefined,
      undefined,
      undefined
    );

    const args = spawnedArgs();
    expect(args).not.toContain("--model");
  });
});
