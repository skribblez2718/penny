/**
 * Agent-Runner Model Override Tests
 *
 * Verifies that runSingleAgent respects modelOverride vs agent.model
 * when building the pi process invocation args and result metadata.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, fn: () => any) => fn()),
}));

import { runSingleAgent } from "../../agent-runner.js";

function createMockProc(exitCode = 0) {
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: Function) => {
      if (event === "close") setTimeout(() => cb(exitCode), 0);
    }),
  };
}

function makeDetails(results: any[]) {
  return {
    mode: "single" as const,
    agentScope: "project" as const,
    projectAgentsDir: "/agents",
    results,
  };
}

describe("runSingleAgent modelOverride", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(createMockProc(0));
  });

  it("prefers modelOverride over agent.model in args", async () => {
    const agents = [
      {
        name: "test-agent",
        source: "project" as const,
        description: "desc",
        filePath: "/agents/test.md",
        systemPrompt: "prompt",
        model: "default-model",
      },
    ];

    await runSingleAgent(
      "/cwd",
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

    const spawnCall = mockSpawn.mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("override-model");
    expect(args).toContain("--session-dir");
    // Agents must load project extensions so their declared tools (e.g. the
    // memory_* tools from the memory extension) are available. Only the
    // compaction extension is added explicitly via -e; --no-extensions would
    // strip the others and break agents that depend on them.
    expect(args).not.toContain("--no-extensions");
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
        model: "default-model",
        provider: "litellm",
      },
    ];

    await runSingleAgent(
      "/cwd",
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

    const spawnCall = mockSpawn.mock.calls[0];
    const args = spawnCall[1] as string[];
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
        model: "default-model",
      },
    ];

    await runSingleAgent(
      "/cwd",
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

    const spawnCall = mockSpawn.mock.calls[0];
    const args = spawnCall[1] as string[];
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
        model: "default-model",
      },
    ];

    const result = await runSingleAgent(
      "/cwd",
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
        model: "default-model",
      },
    ];

    const result = await runSingleAgent(
      "/cwd",
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

  it("omits --model arg when both modelOverride and agent.model are absent", async () => {
    const agents = [
      {
        name: "test-agent",
        source: "project" as const,
        description: "desc",
        filePath: "/agents/test.md",
        systemPrompt: "prompt",
      },
    ];

    await runSingleAgent(
      "/cwd",
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

    const spawnCall = mockSpawn.mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).not.toContain("--model");
  });
});
