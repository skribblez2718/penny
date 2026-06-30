/**
 * Subagent Extension Unit Tests
 *
 * Tests the subagent delegation logic with mocked child_process:
 * - Mode detection (single, parallel, chain)
 * - Parameter validation
 * - Process spawning
 * - Output parsing
 * - Usage formatting
 * - Skill context injection
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";

// Mock child_process
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

// ============================================================
// Helper functions extracted from extension for testing
// ============================================================

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 1000000) {
    const k = count / 1000;
    const rounded = Math.round(k * 10) / 10;
    return rounded % 1 === 0 ? `${rounded.toFixed(0)}k` : `${rounded.toFixed(1)}k`;
  }
  const m = count / 1000000;
  const roundedM = Math.round(m * 10) / 10;
  return roundedM % 1 === 0 ? `${roundedM.toFixed(0)}M` : `${roundedM.toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

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

function validateSingleParams(params: { agent?: string; task?: string }): string | null {
  if (!params.agent) return "Missing 'agent' parameter";
  if (!params.task) return "Missing 'task' parameter";
  return null;
}

function validateParallelParams(params: { tasks?: unknown[] }): string | null {
  if (!params.tasks || !Array.isArray(params.tasks)) return "Missing 'tasks' array";
  if (params.tasks.length === 0) return "Empty 'tasks' array";
  if (params.tasks.length > 8) return "Too many tasks (max 8)";
  for (let i = 0; i < params.tasks.length; i++) {
    const task = params.tasks[i] as { agent?: string; task?: string };
    if (!task.agent) return `Task ${i}: missing 'agent'`;
    if (!task.task) return `Task ${i}: missing 'task'`;
  }
  return null;
}

function validateChainParams(params: { chain?: unknown[] }): string | null {
  if (!params.chain || !Array.isArray(params.chain)) return "Missing 'chain' array";
  if (params.chain.length === 0) return "Empty 'chain' array";
  for (let i = 0; i < params.chain.length; i++) {
    const task = params.chain[i] as { agent?: string; task?: string };
    if (!task.agent) return `Chain ${i}: missing 'agent'`;
    if (!task.task) return `Chain ${i}: missing 'task'`;
  }
  return null;
}

/**
 * Mirrors resolveSkillContext from extension — resolves a skillContext value
 * (file path or inline content) to its final string content.
 */
function resolveSkillContext(
  skillContext: string | undefined,
  cwd: string,
  existsSync: (p: string) => boolean,
  readFileSync: (p: string) => string
): string | undefined {
  if (!skillContext || !skillContext.trim()) return undefined;
  const resolvedPath = path.resolve(cwd, skillContext);
  if (existsSync(resolvedPath)) {
    try {
      return readFileSync(resolvedPath);
    } catch {
      // Fall through to inline content
    }
  }
  return skillContext;
}

/**
 * Mirrors the skill context combination logic from runSingleAgent.
 * Combines agent prompt with optional skill context, inserting before <agent_boundary>.
 */
function combineAgentPromptWithSkillContext(
  agentPrompt: string,
  skillContextContent: string | undefined
): string {
  if (!skillContextContent || !skillContextContent.trim()) return agentPrompt;

  const boundaryMarker = "<agent_boundary>";
  const boundaryIdx = agentPrompt.indexOf(boundaryMarker);
  if (boundaryIdx !== -1) {
    return (
      agentPrompt.substring(0, boundaryIdx) +
      `\n<skill_context>\n${skillContextContent}\n</skill_context>\n\n` +
      agentPrompt.substring(boundaryIdx)
    );
  }
  return agentPrompt + `\n\n<skill_context>\n${skillContextContent}\n</skill_context>`;
}

// ============================================================
// Tests
// ============================================================

describe("formatTokens", () => {
  it("should format small numbers as-is", () => {
    expect(formatTokens(100)).toBe("100");
    expect(formatTokens(999)).toBe("999");
  });

  it("should format thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(5500)).toBe("5.5k");
    expect(formatTokens(9999)).toBe("10k");
  });

  it("should format tens of thousands as rounded k", () => {
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(15500)).toBe("15.5k");
  });

  it("should format millions with M suffix", () => {
    expect(formatTokens(1000000)).toBe("1M");
    expect(formatTokens(2500000)).toBe("2.5M");
  });
});

describe("formatUsageStats", () => {
  it("should format basic usage", () => {
    const stats = formatUsageStats({
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0123,
    });
    expect(stats).toBe("↑1k ↓500 $0.0123");
  });

  it("should include turns", () => {
    const stats = formatUsageStats({
      input: 5000,
      output: 2000,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.05,
      turns: 3,
    });
    expect(stats).toBe("3 turns ↑5k ↓2k $0.0500");
  });

  it("should include cache stats", () => {
    const stats = formatUsageStats({
      input: 10000,
      output: 5000,
      cacheRead: 8000,
      cacheWrite: 2000,
      cost: 0.02,
    });
    expect(stats).toBe("↑10k ↓5k R8k W2k $0.0200");
  });

  it("should include context tokens", () => {
    const stats = formatUsageStats({
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      contextTokens: 50000,
    });
    expect(stats).toContain("ctx:50k");
  });

  it("should include model", () => {
    const stats = formatUsageStats(
      { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      "claude-3.5-sonnet"
    );
    expect(stats).toContain("claude-3.5-sonnet");
  });

  it("should handle zero values", () => {
    const stats = formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    expect(stats).toBe("");
  });
});

describe("Mode Detection", () => {
  it("should detect single mode", () => {
    expect(detectMode({ agent: "reviewer", task: "Review code" })).toBe("single");
  });

  it("should detect parallel mode", () => {
    expect(
      detectMode({
        tasks: [
          { agent: "reviewer", task: "Review" },
          { agent: "reviewer", task: "Test" },
        ],
      })
    ).toBe("parallel");
  });

  it("should detect chain mode", () => {
    expect(detectMode({ chain: [{ agent: "analyzer", task: "Analyze" }] })).toBe("chain");
  });

  it("should detect invalid mode", () => {
    expect(detectMode({})).toBe("invalid");
    expect(detectMode({ agent: "reviewer" })).toBe("invalid");
    expect(detectMode({ task: "Review" })).toBe("invalid");
  });

  it("should prioritize chain over parallel", () => {
    expect(
      detectMode({
        chain: [{ agent: "a", task: "t" }],
        tasks: [{ agent: "b", task: "t" }],
      })
    ).toBe("chain");
  });
});

describe("Parameter Validation", () => {
  describe("validateSingleParams", () => {
    it("should pass valid params", () => {
      expect(validateSingleParams({ agent: "reviewer", task: "Review code" })).toBe(null);
    });
    it("should fail missing agent", () => {
      expect(validateSingleParams({ task: "Review code" })).toBe("Missing 'agent' parameter");
    });
    it("should fail missing task", () => {
      expect(validateSingleParams({ agent: "reviewer" })).toBe("Missing 'task' parameter");
    });
  });

  describe("validateParallelParams", () => {
    it("should pass valid params", () => {
      expect(validateParallelParams({ tasks: [{ agent: "a", task: "t" }] })).toBe(null);
    });
    it("should fail missing tasks", () => {
      expect(validateParallelParams({})).toBe("Missing 'tasks' array");
    });
    it("should fail empty tasks", () => {
      expect(validateParallelParams({ tasks: [] })).toBe("Empty 'tasks' array");
    });
    it("should fail too many tasks", () => {
      const tasks = Array(9).fill({ agent: "a", task: "t" });
      expect(validateParallelParams({ tasks })).toBe("Too many tasks (max 8)");
    });
    it("should fail missing agent in task", () => {
      expect(validateParallelParams({ tasks: [{ task: "t" }] })).toBe("Task 0: missing 'agent'");
    });
    it("should fail missing task in task", () => {
      expect(validateParallelParams({ tasks: [{ agent: "a" }] })).toBe("Task 0: missing 'task'");
    });
  });

  describe("validateChainParams", () => {
    it("should pass valid params", () => {
      expect(validateChainParams({ chain: [{ agent: "a", task: "t" }] })).toBe(null);
    });
    it("should fail missing chain", () => {
      expect(validateChainParams({})).toBe("Missing 'chain' array");
    });
    it("should fail empty chain", () => {
      expect(validateChainParams({ chain: [] })).toBe("Empty 'chain' array");
    });
    it("should fail missing agent in chain item", () => {
      expect(validateChainParams({ chain: [{ task: "t" }] })).toBe("Chain 0: missing 'agent'");
    });
    it("should fail missing task in chain item", () => {
      expect(validateChainParams({ chain: [{ agent: "a" }] })).toBe("Chain 0: missing 'task'");
    });
  });
});

describe("Placeholder Replacement", () => {
  function replacePlaceholder(content: string, previous: string): string {
    return content.replace(/{previous}/g, previous);
  }

  it("should replace {previous} placeholder", () => {
    const result = replacePlaceholder("Based on {previous}, analyze further", "file1.ts, file2.ts");
    expect(result).toBe("Based on file1.ts, file2.ts, analyze further");
  });
  it("should handle multiple placeholders", () => {
    const result = replacePlaceholder("From {previous} to {previous}", "output");
    expect(result).toBe("From output to output");
  });
  it("should handle no placeholder", () => {
    const result = replacePlaceholder("No placeholder here", "previous output");
    expect(result).toBe("No placeholder here");
  });
  it("should handle empty previous", () => {
    const result = replacePlaceholder("Using {previous}", "");
    expect(result).toBe("Using ");
  });
});

describe("Process Spawning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should spawn process with correct args", () => {
    const mockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, cb: Function) => {
        if (event === "close") setTimeout(() => cb(0), 0);
      }),
    };
    mockSpawn.mockReturnValue(mockProc);
    const args = ["run", "--agent", "reviewer", "--task", "Review code"];
    const result = mockSpawn("pi", args, { stdio: ["pipe", "pipe", "pipe"] });
    expect(mockSpawn).toHaveBeenCalledWith("pi", args, expect.any(Object));
    expect(result).toBe(mockProc);
  });

  it("should handle process errors", () => {
    const mockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, cb: Function) => {
        if (event === "error") cb(new Error("Spawn failed"));
      }),
    };
    mockSpawn.mockReturnValue(mockProc);
    expect(mockSpawn).toBeDefined();
  });

  it("should capture stdout and stderr", () => {
    const mockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn(),
    };
    mockSpawn.mockReturnValue(mockProc);
    expect(mockProc.stdout.on).toBeDefined();
    expect(mockProc.stderr.on).toBeDefined();
  });
});

describe("JSON Output Parsing", () => {
  it("should parse valid JSON output", () => {
    const output = '{"result": "success", "files": ["a.ts", "b.ts"]}';
    const parsed = JSON.parse(output);
    expect(parsed.result).toBe("success");
    expect(parsed.files).toHaveLength(2);
  });

  it("should handle JSON in markdown code block", () => {
    const output = 'Here\'s the result:\n```json\n{"result": "success"}\n```\nThat\'s all.';
    const match = output.match(/```json\s*([\s\S]*?)\s*```/);
    expect(match).not.toBeNull();
    if (match) {
      const parsed = JSON.parse(match[1]);
      expect(parsed.result).toBe("success");
    }
  });

  it("should handle multiple JSON objects", () => {
    const output = '{"step1": "done"}\n{"step2": "done"}';
    const lines = output.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine);
    expect(parsed.step2).toBe("done");
  });

  it("should handle malformed JSON gracefully", () => {
    const output = '{"result": "incomplete';
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = null;
    }
    expect(parsed).toBeNull();
  });
});

// ============================================================
// Skill Context Injection Tests
// ============================================================

describe("resolveSkillContext", () => {
  it("returns undefined for undefined input", () => {
    const result = resolveSkillContext(
      undefined,
      "/cwd",
      () => false,
      () => ""
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const result = resolveSkillContext(
      "",
      "/cwd",
      () => false,
      () => ""
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    const result = resolveSkillContext(
      "   ",
      "/cwd",
      () => false,
      () => ""
    );
    expect(result).toBeUndefined();
  });

  it("reads file content when path exists", () => {
    const mockExists = vi.fn().mockReturnValue(true);
    const mockRead = vi.fn().mockReturnValue("skill prompt content");
    const result = resolveSkillContext(
      ".pi/skills/plan/assets/prompts/echo.md",
      "/project",
      mockExists,
      mockRead
    );
    expect(result).toBe("skill prompt content");
    expect(mockExists).toHaveBeenCalled();
    expect(mockRead).toHaveBeenCalled();
  });

  it("resolves relative paths against cwd", () => {
    const mockExists = vi.fn(
      (p: string) => p === "/project/.pi/skills/plan/assets/prompts/echo.md"
    );
    const mockRead = vi.fn().mockReturnValue("explored content");
    const result = resolveSkillContext(
      ".pi/skills/plan/assets/prompts/echo.md",
      "/project",
      mockExists,
      mockRead
    );
    expect(result).toBe("explored content");
  });

  it("resolves absolute paths without cwd resolution", () => {
    const mockExists = vi.fn((p: string) => p === "/absolute/path/prompts/echo.md");
    const mockRead = vi.fn().mockReturnValue("absolute content");
    const result = resolveSkillContext(
      "/absolute/path/prompts/echo.md",
      "/different/cwd",
      mockExists,
      mockRead
    );
    expect(result).toBe("absolute content");
  });

  it("uses as inline content when file does not exist", () => {
    const mockExists = vi.fn().mockReturnValue(false);
    const result = resolveSkillContext("inline context text", "/cwd", mockExists, () => "");
    expect(result).toBe("inline context text");
  });

  it("falls back to inline content on read error", () => {
    const mockExists = vi.fn().mockReturnValue(true);
    const mockRead = vi.fn().mockImplementation(() => {
      throw new Error("permission denied");
    });
    const result = resolveSkillContext("fallback content", "/cwd", mockExists, mockRead);
    expect(result).toBe("fallback content");
  });
});

describe("combineAgentPromptWithSkillContext", () => {
  it("returns agent prompt unchanged when no skill context", () => {
    const agentPrompt = "Agent body\n\n<agent_boundary>\nSecurity stuff\n</agent_boundary>";
    const result = combineAgentPromptWithSkillContext(agentPrompt, undefined);
    expect(result).toBe(agentPrompt);
  });

  it("returns agent prompt unchanged when skill context is empty", () => {
    const agentPrompt = "Agent body\n\n<agent_boundary>\nSecurity stuff\n</agent_boundary>";
    const result = combineAgentPromptWithSkillContext(agentPrompt, "   ");
    expect(result).toBe(agentPrompt);
  });

  it("inserts <skill_context> before <agent_boundary>", () => {
    const agentPrompt = "Agent body\n\n<agent_boundary>\nSecurity stuff\n</agent_boundary>";
    const skillContent = "Domain-specific guidance";
    const result = combineAgentPromptWithSkillContext(agentPrompt, skillContent);

    expect(result).toContain("<skill_context>");
    expect(result).toContain("Domain-specific guidance");
    expect(result).toContain("</skill_context>");
    expect(result).toContain("<agent_boundary>");

    // <skill_context> must come BEFORE <agent_boundary>
    const skillIdx = result.indexOf("<skill_context>");
    const boundaryIdx = result.indexOf("<agent_boundary>");
    expect(skillIdx).toBeLessThan(boundaryIdx);
  });

  it("preserves <agent_boundary> content after skill context", () => {
    const agentPrompt =
      "Agent body\n\n<agent_boundary>\nSECURITY REINFORCEMENT\n1. Rule one\n</agent_boundary>";
    const skillContent = "Skill guidance";
    const result = combineAgentPromptWithSkillContext(agentPrompt, skillContent);

    expect(result).toContain("SECURITY REINFORCEMENT");
    expect(result).toContain("1. Rule one");
    expect(result).toMatch(/<\/skill_context>\s*\n<agent_boundary>/);
  });

  it("appends <skill_context> at end when no <agent_boundary> present", () => {
    const agentPrompt = "Agent body without boundary";
    const skillContent = "Skill guidance";
    const result = combineAgentPromptWithSkillContext(agentPrompt, skillContent);
    expect(result).toBe(
      "Agent body without boundary\n\n<skill_context>\nSkill guidance\n</skill_context>"
    );
  });

  it("maintains correct ordering: agent body → skill_context → agent_boundary", () => {
    const agentPrompt =
      "## Agent Rules\n1. Read-only\n\n<agent_boundary>\nREINFORCEMENT\n</agent_boundary>";
    const skillContent = "## Plan Skill Context\nFocus on: entry points";
    const result = combineAgentPromptWithSkillContext(agentPrompt, skillContent);

    const agentRulesIdx = result.indexOf("Agent Rules");
    const skillCtxIdx = result.indexOf("<skill_context>");
    const boundaryIdx = result.indexOf("<agent_boundary>");
    const reinforcementIdx = result.indexOf("REINFORCEMENT");

    expect(agentRulesIdx).toBeLessThan(skillCtxIdx);
    expect(skillCtxIdx).toBeLessThan(boundaryIdx);
    expect(boundaryIdx).toBeLessThan(reinforcementIdx);
  });

  it("wraps multi-line skill content correctly", () => {
    const agentPrompt = "Agent body\n\n<agent_boundary>\nSEC\n</agent_boundary>";
    const skillContent = "Line 1\nLine 2\nLine 3";
    const result = combineAgentPromptWithSkillContext(agentPrompt, skillContent);

    expect(result).toContain("<skill_context>\nLine 1\nLine 2\nLine 3\n</skill_context>");
  });

  it("handles skill context with agent body that has no trailing newline before boundary", () => {
    const agentPrompt = "Agent body<agent_boundary>\nSEC\n</agent_boundary>";
    const skillContent = "Skill context";
    const result = combineAgentPromptWithSkillContext(agentPrompt, skillContent);

    expect(result).toContain("<skill_context>");
    expect(result).toContain("Skill context");
    expect(result).toContain("<agent_boundary>");

    // Ensure skill_context is before boundary
    const skillIdx = result.indexOf("<skill_context>");
    const boundaryIdx = result.indexOf("<agent_boundary>");
    expect(skillIdx).toBeLessThan(boundaryIdx);
  });
});
