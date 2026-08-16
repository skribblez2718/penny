/**
 * Skill Extension Model Override Tests
 *
 * Verifies that when a skill orchestrator action includes a model field, it is
 * forwarded as the modelOverride argument to runSingleAgent (the pi SDK agent
 * runner — arg index 11) for both single-agent and parallel-agent invocations.
 * Agents are invoked via runSingleAgent, NOT a raw child_process spawn, so the
 * override is asserted on that call rather than on --model spawn args.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { artifactIdFor, type ArtifactRef } from "../../artifact-client.js";

// Resolve the project root dynamically from this test file's location
// (.pi/extensions/skill/tests/unit/ → five levels up) instead of hardcoding.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

const { mockSpawn, mockRunSingleAgent, mockPersistArtifactOutput, mockParseSummaryFromOutput } =
  vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockRunSingleAgent: vi.fn(),
    mockPersistArtifactOutput: vi.fn(),
    mockParseSummaryFromOutput: vi.fn(),
  }));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("../../artifact-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../artifact-client.js")>();
  mockPersistArtifactOutput.mockImplementation(
    async (input: { metadata: unknown; output: string | Buffer }) =>
      actual.expectedArtifactRef(input.metadata, input.output)
  );
  return { ...actual, persistArtifactOutput: mockPersistArtifactOutput };
});
vi.mock("../../skill-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../skill-utils.js")>();
  mockParseSummaryFromOutput.mockImplementation(actual.parseSummaryFromOutput);
  return { ...actual, parseSummaryFromOutput: mockParseSummaryFromOutput };
});

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
      if (p.includes("SKILL.md")) return "---\nname: test-skill\ndescription: test\n---";
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
  // Agents run through the pi SDK, not a raw spawn. The model override is the
  // 12th positional arg (index 11) to runSingleAgent; assert on that. The rest
  // are minimal stubs so the invoke_agent path reaches runSingleAgent.
  runSingleAgent: mockRunSingleAgent,
  getFinalOutput: vi.fn(() => "SUMMARY:{}"),
  discoverAgents: vi.fn(() => ({ agents: [], projectAgentsDir: "/fake/.pi/agents" })),
  resolveSkillContext: vi.fn(() => undefined),
  ProgressEmitter: class {
    on() {}
    emit() {}
  },
}));

vi.mock("../../../subagent/agent-runner.js", () => ({
  runSingleAgent: mockRunSingleAgent,
  getFinalOutput: vi.fn(() => "SUMMARY:{}"),
  discoverAgents: vi.fn(() => ({ agents: [], projectAgentsDir: "/fake/.pi/agents" })),
  resolveSkillContext: vi.fn(() => undefined),
  mapWithConcurrencyLimit: vi.fn(async (items: unknown[], _limit: number, fn: Function) =>
    Promise.all(items.map((item, index) => fn(item, index)))
  ),
  ProgressEmitter: class {
    on() {}
    removeAllListeners() {}
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

function outputArtifact(runId: string, phase: string, agent: string, branchId: string | null) {
  return {
    schema_version: 1,
    run_id: runId,
    phase,
    branch_id: branchId,
    kind: "agent-output",
    operation_id: `${phase}-${branchId ?? "single"}-output-v1`,
    version: 1,
    producer: `agent:${agent}`,
    consumer_scope: ["state:next"],
    media_type: "text/plain; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
  };
}

function inputArtifact(runId: string, stateId: string): ArtifactRef {
  const identity = {
    run_id: runId,
    phase: "upstream",
    branch_id: null,
    kind: "agent-output",
    operation_id: "upstream-output-v1",
    version: 1,
  };
  const digest = "a".repeat(64);
  return {
    schema_version: 1,
    artifact_id: artifactIdFor(identity),
    ...identity,
    producer: "agent:piper",
    consumer_scope: [`state:${stateId}`],
    media_type: "text/markdown; charset=utf-8",
    byte_length: 42,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function ownerBoundPayload(value: any, runId: string): any {
  const payload = structuredClone(value);
  payload.run_id = runId;
  if (payload.action === "invoke_agent") {
    payload.output_artifact = outputArtifact(
      runId,
      payload.state_id || "unknown",
      payload.agent,
      null
    );
  }
  if (payload.action === "invoke_agents_parallel" && Array.isArray(payload.tasks)) {
    payload.tasks = payload.tasks.map((task: any, index: number) => {
      const branchId = task.branch_id || `branch-${index + 1}`;
      return {
        ...task,
        branch_id: branchId,
        output_artifact: outputArtifact(runId, payload.state_id || "unknown", task.agent, branchId),
      };
    });
  }
  if (payload.action === "invoke_agent" || payload.action === "invoke_agents_parallel") {
    const stateId = payload.state_id || "unknown";
    const refs = payload.__with_input_artifact ? [inputArtifact(runId, stateId)] : [];
    payload.input_artifacts ??= {
      schema_version: 1,
      run_id: runId,
      consumer: `state:${stateId}`,
      artifacts: refs.map((ref, index) => ({ slot: `upstream-${index}`, ref })),
    };
  }
  delete payload.__with_input_artifact;
  return payload;
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
    const rawPayload = actionPayloads[idx++];
    const runIdIndex = args.indexOf("--run-id");
    const runId = runIdIndex >= 0 ? args[runIdIndex + 1] : "run-test";
    const payload = rawPayload ? ownerBoundPayload(rawPayload, runId) : rawPayload;
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

// runSingleAgent's model override is the 12th positional arg (index 11),
// followed by the optional owner-supplied environment.
const MODEL_ARG_INDEX = 11;
const OWNER_ENV_ARG_INDEX = 12;
const TASK_ARG_INDEX = 3;

describe("skill extension model override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROJECT_ROOT = PROJECT_ROOT;
    // A resolved agent result so the orchestrate loop advances to `complete`.
    mockRunSingleAgent.mockResolvedValue({ messages: [], exitCode: 0, stopReason: "stop" });
  });

  afterEach(() => {
    delete process.env.PROJECT_ROOT;
  });

  it("single agent: forwards action.model as modelOverride via --model arg", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        // 1st orchestrate.py call is `recover` (auto-recovery); no pending run.
        { action: "status", state_id: "s0", session_id: "sess1" },
        {
          action: "invoke_agent",
          state_id: "s1",
          session_id: "sess1",
          agent: "echo",
          task_summary: "do something",
          model: "skill-override-model",
          __with_input_artifact: true,
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
    const toolResult = await registeredTool.execute(
      "tool-1",
      { skill_name: "test-skill", goal: "test goal" },
      undefined,
      undefined,
      ctx
    );

    expect(toolResult.details?.errors).toEqual([]);
    expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
    expect(mockRunSingleAgent.mock.calls[0][MODEL_ARG_INDEX]).toBe("skill-override-model");
    const task = mockRunSingleAgent.mock.calls[0][TASK_ARG_INDEX] as string;
    const environment = mockRunSingleAgent.mock.calls[0][OWNER_ENV_ARG_INDEX] as NodeJS.ProcessEnv;
    const invocation = JSON.parse(environment.PENNY_ARTIFACT_INVOCATION_JSON as string);
    expect(task).toContain('slot "upstream-0"');
    expect(task).toContain(invocation.grants[0].artifact.artifact_id);
    expect(task).not.toContain("exact predecessor bytes");
    expect(invocation.caller.consumer_ref).toBe("state:s1");
    expect(invocation.grants[0].artifact).not.toHaveProperty("created_at");
    expect(environment.PENNY_ARTIFACT_CURSOR_HMAC_KEY).toBeTruthy();
  });

  it("parallel agents: forwards per-task model as modelOverride via --model arg", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        // 1st orchestrate.py call is `recover` (auto-recovery); no pending run.
        { action: "status", state_id: "s0", session_id: "sess1" },
        {
          action: "invoke_agents_parallel",
          state_id: "s1",
          session_id: "sess1",
          tasks: [
            { agent: "echo", task_summary: "task1", model: "parallel-model-a" },
            { agent: "echo", task_summary: "task2" },
          ],
          __with_input_artifact: true,
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
    const toolResult = await registeredTool.execute(
      "tool-1",
      { skill_name: "test-skill", goal: "test goal" },
      undefined,
      undefined,
      ctx
    );

    expect(toolResult.details?.errors).toEqual([]);
    expect(mockRunSingleAgent).toHaveBeenCalledTimes(2);
    expect(mockRunSingleAgent.mock.calls[0][MODEL_ARG_INDEX]).toBe("parallel-model-a");
    expect(mockRunSingleAgent.mock.calls[1][MODEL_ARG_INDEX]).toBeUndefined();
    for (const call of mockRunSingleAgent.mock.calls) {
      const task = call[TASK_ARG_INDEX] as string;
      const environment = call[OWNER_ENV_ARG_INDEX] as NodeJS.ProcessEnv;
      const invocation = JSON.parse(environment.PENNY_ARTIFACT_INVOCATION_JSON as string);
      expect(task).toContain(invocation.grants[0].artifact.artifact_id);
      expect(invocation.caller.consumer_ref).toBe("state:s1");
      expect(invocation.grants).toHaveLength(1);
    }
    expect(
      (mockRunSingleAgent.mock.calls[0][OWNER_ENV_ARG_INDEX] as NodeJS.ProcessEnv)
        .PENNY_ARTIFACT_CURSOR_HMAC_KEY
    ).not.toBe(
      (mockRunSingleAgent.mock.calls[1][OWNER_ENV_ARG_INDEX] as NodeJS.ProcessEnv)
        .PENNY_ARTIFACT_CURSOR_HMAC_KEY
    );
    expect(mockPersistArtifactOutput).toHaveBeenCalledTimes(2);
    expect(mockParseSummaryFromOutput).toHaveBeenCalledTimes(2);
    expect(Math.max(...mockPersistArtifactOutput.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...mockParseSummaryFromOutput.mock.invocationCallOrder)
    );

    const stepCall = mockSpawn.mock.calls.find((call) => {
      const args = call[1] as string[];
      return args[0]?.includes("orchestrate.py") && args[1] === "step";
    });
    expect(stepCall).toBeTruthy();
    const stepArgs = stepCall?.[1] as string[];
    const entries = JSON.parse(stepArgs[stepArgs.indexOf("--result") + 1]);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry: Record<string, unknown>) => entry.branch_id)).toEqual([
      "branch-1",
      "branch-2",
    ]);
    for (const entry of entries) {
      expect(entry.protocol_version).toBe(2);
      expect(entry.phase).toBe("s1");
      expect(entry.producer).toBe("agent:echo");
      expect(entry.output_artifact_ref.branch_id).toBe(entry.branch_id);
      expect(entry.execution_receipt).toEqual(entry.receipts[0]);
      expect(JSON.parse(entry.execution_receipt.output_artifact_ref)).toEqual(
        entry.output_artifact_ref
      );
      expect(entry.trusted_invocation.agent_identity).toBe("agent:echo");
    }
  });

  it("parallel SkillStep.model is the fallback when the orchestrator omits a model", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state_id: "s0", session_id: "sess-step" },
        {
          action: "invoke_agent",
          state_id: "s1",
          session_id: "sess-step",
          run_id: "run-step",
          agent: "echo",
          task_summary: "do something",
        },
        {
          action: "complete",
          state_id: "complete",
          session_id: "sess-step",
          result: { met: true },
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
      "tool-step-model",
      {
        skills: [
          {
            skill_name: "test-skill",
            goal: "test goal",
            model: "caller-step-model",
          },
        ],
      },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
    expect(mockRunSingleAgent.mock.calls[0][MODEL_ARG_INDEX]).toBe("caller-step-model");
  });

  it("orchestrator model takes precedence over chain SkillStep.model", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state_id: "s0", session_id: "sess-chain" },
        {
          action: "invoke_agent",
          state_id: "s1",
          session_id: "sess-chain",
          run_id: "run-chain",
          agent: "echo",
          task_summary: "do something",
          model: "orchestrator-model",
        },
        {
          action: "complete",
          state_id: "complete",
          session_id: "sess-chain",
          result: { met: true },
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
      "tool-chain-model",
      {
        chain: [
          {
            skill_name: "test-skill",
            goal: "test goal",
            model: "caller-chain-model",
          },
        ],
      },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
    expect(mockRunSingleAgent.mock.calls[0][MODEL_ARG_INDEX]).toBe("orchestrator-model");
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
