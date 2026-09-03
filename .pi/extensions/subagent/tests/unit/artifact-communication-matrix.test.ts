import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactStore,
  initializePennyState,
  resolvePennyRuntimeState,
} from "@penny/orchestration/source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestExtensionApi,
  createTestToolInfos,
  isRecord,
} from "../../../../lib/tests/test-narrowers.js";
import {
  persistArtifactOutput,
  readArtifactById,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../../../artifacts/owner-client.js";
import {
  executeArtifactRead,
  loadArtifactRuntimeConfig,
} from "../../../artifacts/artifact-runtime.js";
import { discoverAgents } from "../../agents.js";
import type { ObservedPiMessage, SingleResult, SubagentDetails } from "../../agent-runner.js";

type RunSingleAgent = typeof import("../../agent-runner.js").runSingleAgent;
type WorkerBehavior = (input: {
  readonly agent: string;
  readonly task: string;
  readonly step: number | undefined;
}) => Promise<string>;

interface RegisteredSubagentTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: {
      readonly cwd: string;
      readonly hasUI: boolean;
      readonly sessionManager: { getSessionId(): string };
    }
  ): Promise<{
    readonly isError?: boolean;
    readonly content: Array<{ type: string; text: string }>;
    readonly details: SubagentDetails;
  }>;
}

let workerBehavior: WorkerBehavior = async () => "unconfigured worker";
const mockRunSingleAgent = vi.fn<RunSingleAgent>(async (...args) => {
  const agent = args[2];
  const task = args[3];
  const step = args[5];
  const output = await workerBehavior({ agent, task, step });
  return singleResult(agent, task, step, output);
});

vi.mock("../../agent-runner.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../agent-runner.js")>("../../agent-runner.js");
  return { ...actual, runSingleAgent: mockRunSingleAgent };
});

vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[], _options?: Record<string, unknown>) => ({
    anyOf: values.map((value) => ({ type: "string", const: value })),
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getMarkdownTheme: () => ({}),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    addChild() {}
  },
  Markdown: class {},
  Spacer: class {},
  Text: class {},
}));

const roots: string[] = [];
const previousStateRoot = process.env.PENNY_STATE_ROOT;
let projectRoot = "";
let stateRoot = "";
let registeredTool: RegisteredSubagentTool | undefined;

function singleResult(
  agent: string,
  task: string,
  step: number | undefined,
  output: string
): SingleResult {
  const split = Math.floor(output.length / 2);
  const message: ObservedPiMessage = {
    role: "assistant",
    content: [
      { type: "text", text: output.slice(0, split) },
      { type: "thinking", thinking: "not part of exact output" },
      { type: "text", text: output.slice(split) },
    ],
    stopReason: "stop",
  };
  return {
    agent,
    agentSource: "project",
    task,
    exitCode: 0,
    messages: [message],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 1,
    },
    ...(step === undefined ? {} : { step }),
  };
}

function isRegisteredSubagentTool(value: unknown): value is RegisteredSubagentTool {
  return isRecord(value) && value.name === "subagent" && typeof value.execute === "function";
}

function providerPi() {
  const names = [
    ...new Set(discoverAgents(process.cwd(), "project").agents.flatMap((agent) => agent.tools)),
  ];
  return createTestExtensionApi({
    getAllTools: () => createTestToolInfos(names),
    onRegisterTool(definition) {
      if (!isRegisteredSubagentTool(definition)) {
        throw new Error("subagent tool was not registered with its production execute path");
      }
      registeredTool = definition;
    },
  });
}

function subagentTool(): RegisteredSubagentTool {
  if (registeredTool === undefined) throw new Error("subagent tool is absent");
  return registeredTool;
}

function context() {
  return {
    cwd: projectRoot,
    hasUI: false,
    sessionManager: { getSessionId: () => "matrix-parent-session" },
  };
}

function metadata(input: {
  readonly runId: string;
  readonly operationId: string;
  readonly producer?: string;
  readonly upstreamRefs?: readonly ArtifactRef[];
}): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: input.runId,
    phase: "terminal",
    branch_id: null,
    kind: "agent-output",
    operation_id: input.operationId,
    version: 1,
    producer: input.producer ?? "agent:fixture",
    media_type: "text/plain; charset=utf-8",
    parent_ref: null,
    upstream_refs: [...(input.upstreamRefs ?? [])],
  };
}

async function persist(input: {
  readonly runId: string;
  readonly operationId: string;
  readonly content: string;
}): Promise<ArtifactRef> {
  return persistArtifactOutput({
    metadata: metadata(input),
    output: input.content,
    cwd: projectRoot,
    env: process.env,
  });
}

function artifactIds(text: string): string[] {
  return [...new Set(text.match(/art_[a-f0-9]{64}/gu) ?? [])];
}

async function readViaArtifactTool(artifactId: string): Promise<string> {
  const execution = await executeArtifactRead(loadArtifactRuntimeConfig(projectRoot, process.env), {
    artifact: artifactId,
  });
  expect(execution.code).toBe("OK");
  const first = execution.result.content[0];
  if (first?.type !== "text") throw new Error("artifact_read matrix result has no text");
  const value: unknown = JSON.parse(first.text);
  if (!isRecord(value) || typeof value.content !== "string" || value.truncated !== false) {
    throw new Error("artifact_read matrix result is invalid or truncated");
  }
  return value.content;
}

async function taskInputs(task: string): Promise<{
  readonly ids: readonly string[];
  readonly contents: readonly string[];
}> {
  const ids = artifactIds(task);
  return { ids, contents: await Promise.all(ids.map(readViaArtifactTool)) };
}

function outputRefs(details: SubagentDetails, expectedCount: number): ArtifactRef[] {
  const refs = details.outputArtifactRefs;
  if (refs === undefined) throw new Error("subagent result omitted exact output refs");
  expect(refs).toHaveLength(expectedCount);
  return refs;
}

async function expectExact(ref: ArtifactRef, expected: string): Promise<void> {
  const read = await readArtifactById({
    artifactId: ref.artifact_id,
    projectRoot,
    env: process.env,
  });
  expect(read.ref).toEqual(ref);
  expect(read.content).toEqual(Buffer.from(expected, "utf8"));
}

function artifactMetadata(ref: ArtifactRef) {
  const state = resolvePennyRuntimeState(projectRoot, { env: process.env });
  using store = ArtifactStore.openExisting(state.paths.artifacts.root, {
    projectId: state.projectId,
  });
  return store.metadata(ref);
}

beforeEach(async () => {
  vi.clearAllMocks();
  registeredTool = undefined;
  workerBehavior = async () => "unconfigured worker";
  const sandbox = mkdtempSync(path.join(tmpdir(), "penny-subagent-artifact-matrix-"));
  roots.push(sandbox);
  chmodSync(sandbox, 0o700);
  projectRoot = process.cwd();
  stateRoot = path.join(sandbox, "state");
  process.env.PENNY_STATE_ROOT = stateRoot;
  delete process.env.PENNY_ARTIFACT_ROOT;
  delete process.env.PENNY_ARTIFACT_GRANT_ROOT;
  initializePennyState(projectRoot, { env: process.env });
  const extension = await import("../../index.js");
  extension.default(providerPi());
});

afterEach(() => {
  if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = previousStateRoot;
  delete process.env.PENNY_ARTIFACT_ROOT;
  delete process.env.PENNY_ARTIFACT_GRANT_ROOT;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("subagent production artifact communication matrix", () => {
  it("persists a single result and performs cross-run multi-source Synthia fan-in byte-for-byte", async () => {
    const singleBytes = "single🙂\nfirstsecond";
    workerBehavior = async () => singleBytes;
    const single = await subagentTool().execute(
      "matrix-single",
      { agent: "echo", task: "produce exact single bytes" },
      undefined,
      undefined,
      context()
    );
    expect(single.isError).not.toBe(true);
    const singleRef = outputRefs(single.details, 1)[0];
    if (singleRef === undefined) throw new Error("single output ref is absent");
    await expectExact(singleRef, singleBytes);

    const firstContent = "prior-A🙂\nbytes";
    const secondContent = "prior-B漢\u0000tail";
    const [first, second] = await Promise.all([
      persist({ runId: "cross-run-a", operationId: "cross-operation-a", content: firstContent }),
      persist({ runId: "cross-run-b", operationId: "cross-operation-b", content: secondContent }),
    ]);
    const synthesized = `SYNTHIA-FAN-IN\n${firstContent}\n---\n${secondContent}`;
    workerBehavior = async ({ agent, task }) => {
      expect(agent).toBe("synthia");
      const input = await taskInputs(task);
      expect(input.ids).toEqual([first.artifact_id, second.artifact_id]);
      expect(input.contents).toEqual([firstContent, secondContent]);
      return synthesized;
    };
    const fanIn = await subagentTool().execute(
      "matrix-cross-run-fan-in",
      {
        agent: "synthia",
        task: "synthesize the two exact prior runs",
        input_artifacts: [first.artifact_id, second.artifact_id],
      },
      undefined,
      undefined,
      context()
    );
    expect(fanIn.isError).not.toBe(true);
    const fanInRef = outputRefs(fanIn.details, 1)[0];
    if (fanInRef === undefined) throw new Error("fan-in output ref is absent");
    await expectExact(fanInRef, synthesized);
    expect(artifactMetadata(fanInRef).upstream_refs).toEqual([first, second]);
  });

  it("carries the previous chain output plus each explicit step input byte-for-byte", async () => {
    const firstSeedContent = "chain seed A🙂";
    const secondSeedContent = "chain seed B漢";
    const [firstSeed, secondSeed] = await Promise.all([
      persist({
        runId: "chain-seed-a",
        operationId: "chain-seed-operation-a",
        content: firstSeedContent,
      }),
      persist({
        runId: "chain-seed-b",
        operationId: "chain-seed-operation-b",
        content: secondSeedContent,
      }),
    ]);
    const firstOutput = `CHAIN-ONE\n${firstSeedContent}`;
    const secondOutput = `CHAIN-TWO\n${firstOutput}\n${secondSeedContent}`;
    workerBehavior = async ({ step, task }) => {
      const input = await taskInputs(task);
      if (step === 1) {
        expect(input.ids).toEqual([firstSeed.artifact_id]);
        expect(input.contents).toEqual([firstSeedContent]);
        return firstOutput;
      }
      if (step === 2) {
        expect(input.ids).toHaveLength(2);
        expect(input.ids[1]).toBe(secondSeed.artifact_id);
        expect(input.contents).toEqual([firstOutput, secondSeedContent]);
        return secondOutput;
      }
      throw new Error(`unexpected chain step '${String(step)}'`);
    };

    const chain = await subagentTool().execute(
      "matrix-chain",
      {
        chain: [
          {
            agent: "echo",
            task: "produce step one",
            input_artifacts: [firstSeed.artifact_id],
          },
          {
            agent: "piper",
            task: "use {previous} with the explicit second seed",
            input_artifacts: [secondSeed.artifact_id],
          },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(chain.isError).not.toBe(true);
    const refs = outputRefs(chain.details, 2);
    const firstRef = refs[0];
    const secondRef = refs[1];
    if (firstRef === undefined || secondRef === undefined) {
      throw new Error("chain output refs are incomplete");
    }
    await expectExact(firstRef, firstOutput);
    await expectExact(secondRef, secondOutput);
    expect(artifactMetadata(firstRef).upstream_refs).toEqual([firstSeed]);
    expect(artifactMetadata(secondRef).upstream_refs).toEqual([firstRef, secondSeed]);
  });

  it("persists parallel branches and supplies both exact outputs to a downstream consumer", async () => {
    const leftSeedContent = "parallel-left-seed🙂";
    const rightSeedContent = "parallel-right-seed漢";
    const [leftSeed, rightSeed] = await Promise.all([
      persist({
        runId: "parallel-seed-left",
        operationId: "parallel-seed-operation-left",
        content: leftSeedContent,
      }),
      persist({
        runId: "parallel-seed-right",
        operationId: "parallel-seed-operation-right",
        content: rightSeedContent,
      }),
    ]);
    const expectedByAgent = new Map([
      ["echo", `PARALLEL-ECHO\n${leftSeedContent}`],
      ["vera", `PARALLEL-VERA\n${rightSeedContent}`],
    ]);
    workerBehavior = async ({ agent, task }) => {
      const input = await taskInputs(task);
      expect(input.contents).toHaveLength(1);
      const expected = expectedByAgent.get(agent);
      if (expected === undefined) throw new Error(`unexpected parallel agent '${agent}'`);
      expect(expected).toContain(input.contents[0]);
      return expected;
    };
    const parallel = await subagentTool().execute(
      "matrix-parallel",
      {
        tasks: [
          {
            agent: "echo",
            task: "left branch",
            input_artifacts: [leftSeed.artifact_id],
          },
          {
            agent: "vera",
            task: "right branch",
            input_artifacts: [rightSeed.artifact_id],
          },
        ],
        maxConcurrency: 2,
      },
      undefined,
      undefined,
      context()
    );
    expect(parallel.isError).not.toBe(true);
    const parallelRefs = outputRefs(parallel.details, 2);
    const leftRef = parallelRefs[0];
    const rightRef = parallelRefs[1];
    if (leftRef === undefined || rightRef === undefined) {
      throw new Error("parallel output refs are incomplete");
    }
    const leftOutput = expectedByAgent.get("echo");
    const rightOutput = expectedByAgent.get("vera");
    if (leftOutput === undefined || rightOutput === undefined) {
      throw new Error("parallel expected output fixture is incomplete");
    }
    await expectExact(leftRef, leftOutput);
    await expectExact(rightRef, rightOutput);
    expect(artifactMetadata(leftRef).upstream_refs).toEqual([leftSeed]);
    expect(artifactMetadata(rightRef).upstream_refs).toEqual([rightSeed]);

    const downstreamOutput = `DOWNSTREAM\n${leftOutput}\n---\n${rightOutput}`;
    workerBehavior = async ({ agent, task }) => {
      expect(agent).toBe("synthia");
      const input = await taskInputs(task);
      expect(input.ids).toEqual([leftRef.artifact_id, rightRef.artifact_id]);
      expect(input.contents).toEqual([leftOutput, rightOutput]);
      return downstreamOutput;
    };
    const downstream = await subagentTool().execute(
      "matrix-parallel-downstream",
      {
        agent: "synthia",
        task: "consume both exact parallel outputs",
        input_artifacts: [leftRef.artifact_id, rightRef.artifact_id],
      },
      undefined,
      undefined,
      context()
    );
    expect(downstream.isError).not.toBe(true);
    const downstreamRef = outputRefs(downstream.details, 1)[0];
    if (downstreamRef === undefined) throw new Error("downstream output ref is absent");
    await expectExact(downstreamRef, downstreamOutput);
    expect(artifactMetadata(downstreamRef).upstream_refs).toEqual([leftRef, rightRef]);
  });
});
