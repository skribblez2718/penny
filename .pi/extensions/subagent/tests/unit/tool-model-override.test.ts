/**
 * Subagent Tool Model Override Tests
 *
 * Verifies that the subagent tool forwards model/modelOverride correctly
 * in single, parallel, and chain modes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createTestExtensionApi,
  createTestToolInfos,
  isRecord,
} from "../../../../lib/tests/test-narrowers.js";
import { discoverAgents } from "../../agents.js";

type RunSingleAgent = typeof import("../../agent-runner.js").runSingleAgent;

interface RegisteredToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

interface RegisteredSubagentTool {
  name: string;
  parameters: {
    properties: Record<string, { type?: unknown }>;
  };
  execute: (...args: unknown[]) => Promise<RegisteredToolResult>;
}

const mockPersistDirectChainOutput = vi.fn();
const mockRunSingleAgent = vi.fn<RunSingleAgent>(() =>
  Promise.resolve({
    agent: "echo",
    agentSource: "project" as const,
    task: "test",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  })
);

vi.mock("../../chain-artifacts.js", async () => {
  const actual = await vi.importActual<typeof import("../../chain-artifacts.js")>(
    "../../chain-artifacts.js"
  );
  const owner = await vi.importActual<typeof import("../../../artifacts/owner-client.js")>(
    "../../../artifacts/owner-client.js"
  );
  return {
    ...actual,
    persistDirectChainOutput: mockPersistDirectChainOutput.mockImplementation(
      async ({ metadata, output }: { metadata: unknown; output: string }) =>
        owner.expectedArtifactRef(metadata, output)
    ),
  };
});

vi.mock("../../agent-runner.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../agent-runner.js")>("../../agent-runner.js");
  return {
    ...actual,
    runSingleAgent: mockRunSingleAgent,
  };
});

vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[], _opts?: Record<string, unknown>) => ({
    anyOf: values.map((v: string) => ({ type: "string", const: v })),
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getMarkdownTheme: () => ({}),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class ContainerMock {
    addChild() {}
  },
  Markdown: class MarkdownMock {},
  Spacer: class SpacerMock {},
  Text: class TextMock {
    constructor(_text: string, _x: number, _y: number) {}
  },
}));

let registeredTool: RegisteredSubagentTool | undefined;

function isRegisteredSubagentTool(value: unknown): value is RegisteredSubagentTool {
  if (!isRecord(value)) return false;
  const candidate = value;
  const parameters = candidate["parameters"];
  if (
    candidate["name"] !== "subagent" ||
    typeof candidate["execute"] !== "function" ||
    parameters === null ||
    typeof parameters !== "object" ||
    !("properties" in parameters)
  ) {
    return false;
  }
  return parameters.properties !== null && typeof parameters.properties === "object";
}

function createMockPi() {
  registeredTool = undefined;
  const providerNames = [
    ...new Set(discoverAgents(process.cwd(), "project").agents.flatMap((agent) => agent.tools)),
  ];
  return createTestExtensionApi({
    getAllTools: () => createTestToolInfos(providerNames),
    onRegisterTool(definition) {
      if (!isRegisteredSubagentTool(definition)) {
        throw new Error("subagent registered an invalid tool");
      }
      registeredTool = definition;
    },
  });
}

function subagentTool(): RegisteredSubagentTool {
  if (registeredTool === undefined) throw new Error("subagent tool was not registered");
  return registeredTool;
}

function getModelOverride(callIndex: number): string | undefined {
  return mockRunSingleAgent.mock.calls[callIndex]?.[11];
}

describe("subagent tool model override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("single mode: forwards params.model as modelOverride", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = { cwd: process.cwd(), hasUI: false };
    await subagentTool().execute(
      "tool-1",
      { agent: "echo", task: "hello", model: "single-override" },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
    expect(getModelOverride(0)).toBe("single-override");
  });

  it("parallel mode: forwards per-task model as modelOverride", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = { cwd: process.cwd(), hasUI: false };
    await subagentTool().execute(
      "tool-1",
      {
        tasks: [
          { agent: "echo", task: "hello", model: "parallel-model-a" },
          { agent: "skribble", task: "world" },
        ],
      },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(2);
    expect(getModelOverride(0)).toBe("parallel-model-a");
    expect(getModelOverride(1)).toBeUndefined();
  });

  it("chain mode: forwards per-step model as modelOverride", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = { cwd: process.cwd(), hasUI: false };
    await subagentTool().execute(
      "tool-1",
      {
        chain: [
          { agent: "echo", task: "step1", model: "chain-model" },
          { agent: "piper", task: "step2" },
        ],
      },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(2);
    expect(getModelOverride(0)).toBe("chain-model");
    expect(getModelOverride(1)).toBeUndefined();
  });

  it("backward compatibility: no model means undefined modelOverride", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const ctx = { cwd: process.cwd(), hasUI: false };
    await subagentTool().execute(
      "tool-1",
      { agent: "echo", task: "hello" },
      undefined,
      undefined,
      ctx
    );

    expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
    expect(getModelOverride(0)).toBeUndefined();
  });

  it("does not prompt for project agents when the current project is trusted", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);
    const confirm = vi.fn(() => Promise.resolve(false));

    await subagentTool().execute(
      "tool-trusted",
      {
        agent: "echo",
        task: "hello",
        confirmProjectAgents: true,
      },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        hasUI: true,
        isProjectTrusted: () => true,
        ui: { confirm },
      }
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
  });

  it("prompts before project-agent execution when the current project is untrusted", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);
    const confirm = vi.fn(() => Promise.resolve(false));

    const response = await subagentTool().execute(
      "tool-untrusted",
      { agent: "echo", task: "hello" },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        hasUI: true,
        isProjectTrusted: () => false,
        ui: { confirm },
      }
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(mockRunSingleAgent).not.toHaveBeenCalled();
    expect(response.content[0]?.text).toContain("not approved");
  });

  it("preflights and forwards cross-run input IDs before invoking the worker", async () => {
    const { chmodSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const owner = await import("../../../artifacts/owner-client.js");
    const { initializePennyState } =
      await import("../../../../../apps/orchestration/src/state/index.js");
    const root = mkdtempSync(join(tmpdir(), "penny-subagent-input-"));
    chmodSync(root, 0o700);
    // Artifact storage is isolated under PENNY_STATE_ROOT, but the execution
    // catalog must use Penny's real agent directory. A synthetic cwd would
    // intentionally trip the reload-required catalog-drift guard before the
    // handoff reaches the mocked runner.
    const projectRoot = process.cwd();
    const previousStateRoot = process.env.PENNY_STATE_ROOT;
    const previousArtifactRoot = process.env.PENNY_ARTIFACT_ROOT;
    process.env.PENNY_STATE_ROOT = join(root, "state");
    delete process.env.PENNY_ARTIFACT_ROOT;
    initializePennyState(projectRoot, { env: process.env });
    try {
      const persist = (runId: string, operationId: string) =>
        owner.persistArtifactOutput({
          metadata: {
            schema_version: 2,
            run_id: runId,
            phase: "phase",
            branch_id: null,
            kind: "agent-output",
            operation_id: operationId,
            version: 1,
            producer: "agent:fixture",
            media_type: "text/plain",
            parent_ref: null,
            upstream_refs: [],
          },
          output: runId,
          cwd: projectRoot,
          env: process.env,
        });
      const [first, second] = await Promise.all([
        persist("run-a", "operation-a"),
        persist("run-b", "operation-b"),
      ]);
      const mod = await import("../../index.js");
      const pi = createMockPi();
      mod.default(pi);
      await subagentTool().execute(
        "tool-input",
        {
          agent: "synthia",
          task: "integrate",
          input_artifacts: [first.artifact_id, second.artifact_id],
        },
        undefined,
        undefined,
        { cwd: projectRoot, hasUI: false }
      );
      expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
      const task = mockRunSingleAgent.mock.calls[0]?.[3];
      if (task === undefined) throw new Error("subagent task was not forwarded");
      expect(task).toContain(first.artifact_id);
      expect(task).toContain(second.artifact_id);
    } finally {
      if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
      else process.env.PENNY_STATE_ROOT = previousStateRoot;
      if (previousArtifactRoot === undefined) delete process.env.PENNY_ARTIFACT_ROOT;
      else process.env.PENNY_ARTIFACT_ROOT = previousArtifactRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a communication error when mandatory output persistence fails", async () => {
    mockPersistDirectChainOutput.mockRejectedValueOnce(new Error("manifest write failed"));
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);
    const response = await subagentTool().execute(
      "tool-1",
      { agent: "echo", task: "hello" },
      undefined,
      undefined,
      { cwd: process.cwd(), hasUI: false }
    );
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("communication failed");
    expect(response.content[0].text).toContain("ARTIFACT_PERSIST_FAILED");
  });

  it("schema includes model in SubagentParams", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    const params = subagentTool().parameters;
    expect(params.properties).toHaveProperty("model");
    expect(params.properties.model.type).toBe("string");
  });
});
