import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { initializePennyState } from "@penny/orchestration/source";
import { afterEach, describe, expect, it, vi } from "vitest";

import artifactExtension from "../../../artifacts/index.js";
import {
  persistArtifactOutput as persistSkillArtifactOutput,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../../../skill/artifact-client.js";
import { discoverAgents } from "../../../subagent/agents.js";
import type {
  ObservedPiMessage,
  SingleResult,
  SubagentDetails,
} from "../../../subagent/agent-runner.js";
import {
  directAgentOutputMetadata,
  directChainOutputMetadata,
  persistDirectChainOutput,
} from "../../../subagent/chain-artifacts.js";
import {
  createTestExtensionApi,
  createTestToolInfos,
  isRecord,
  parseJson,
  requireArray,
  requireArrayElement,
  requireRecord,
  requireString,
} from "../../../../lib/tests/test-narrowers.js";
import compactionExtension, { parseResumeRefs } from "../../index.js";
import type { SessionMessage } from "../../pi-messages.js";
import { createMockCompactionPi, type CompactionEvent } from "../fixtures/compaction-pi.js";

interface ArtifactReadRange {
  start: number;
  end?: number;
}

interface RegisteredArtifactReadTool {
  name: string;
  execute(
    toolCallId: string,
    params: { artifact: string; range?: ArtifactReadRange },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string }
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

interface RegisteredSubagentTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: {
      cwd: string;
      hasUI: boolean;
      sessionManager: { getSessionId(): string };
    }
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    details: SubagentDetails;
    isError?: boolean;
  }>;
}

interface HandoffRecord {
  artifactId: string;
  digest: string;
  producingTool: string;
  branchOrStep: string;
  creationOrder: number;
}

interface CompleteArtifactRead {
  bytes: Buffer;
  pageCount: number;
}

interface DownstreamRunnerInput {
  defaultCwd: string;
  agent: string;
  task: string;
  step: number | undefined;
  ownerEnvironment: NodeJS.ProcessEnv | undefined;
}

type RunSingleAgent = typeof import("../../../subagent/agent-runner.js").runSingleAgent;
type DownstreamRunnerBehavior = (input: DownstreamRunnerInput) => Promise<SingleResult>;

let downstreamRunnerBehavior: DownstreamRunnerBehavior | undefined;
const mockRunSingleAgent = vi.fn<RunSingleAgent>(async (...args) => {
  const behavior = downstreamRunnerBehavior;
  if (behavior === undefined) throw new Error("downstream runner behavior was not configured");
  return behavior({
    defaultCwd: args[0],
    agent: args[2],
    task: args[3],
    step: args[5],
    ownerEnvironment: args[12],
  });
});

vi.mock("../../../subagent/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../../subagent/agent-runner.js")>(
    "../../../subagent/agent-runner.js"
  );
  return { ...actual, runSingleAgent: mockRunSingleAgent };
});

function isRegisteredArtifactReadTool(value: unknown): value is RegisteredArtifactReadTool {
  return isRecord(value) && value.name === "artifact_read" && typeof value.execute === "function";
}

function isRegisteredSubagentTool(value: unknown): value is RegisteredSubagentTool {
  return isRecord(value) && value.name === "subagent" && typeof value.execute === "function";
}

function requireInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(message);
  return value;
}

function successfulSingleResult(input: {
  agent: string;
  task: string;
  step: number | undefined;
  output: string;
}): SingleResult {
  const message: ObservedPiMessage = {
    role: "assistant",
    content: [{ type: "text", text: input.output }],
    stopReason: "stop",
  };
  return {
    agent: input.agent,
    agentSource: "project",
    task: input.task,
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
    ...(input.step === undefined ? {} : { step: input.step }),
  };
}

function artifactIds(text: string): string[] {
  return [...new Set(text.match(/art_[a-f0-9]{64}/gu) ?? [])];
}

function parseHandoffRecords(bytes: Buffer): HandoffRecord[] {
  const indexBody = requireRecord(
    parseJson(bytes.toString("utf8")),
    "handoff index body is invalid"
  );
  return requireArray(indexBody.records, "handoff index omitted records").map((value, index) => {
    const record = requireRecord(value, `handoff record ${index} is invalid`);
    return {
      artifactId: requireString(record.artifact_id, `handoff record ${index} omitted its ID`),
      digest: requireString(record.digest, `handoff record ${index} omitted its digest`),
      producingTool: requireString(
        record.producing_tool,
        `handoff record ${index} omitted its producing tool`
      ),
      branchOrStep: requireString(
        record.branch_or_step,
        `handoff record ${index} omitted its branch or step`
      ),
      creationOrder: requireInteger(
        record.creation_order,
        `handoff record ${index} omitted its creation order`
      ),
    };
  });
}

function skillTerminalMetadata(): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: "skill-current-session",
    phase: "terminal-output",
    branch_id: null,
    kind: "agent-output",
    operation_id: "skill-operation:current-session-terminal",
    version: 1,
    producer: "skill:research",
    media_type: "text/markdown; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
  };
}

function historicalMetadata(runId: string, operationId: string): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: runId,
    phase: "historical-output",
    branch_id: null,
    kind: "agent-output",
    operation_id: operationId,
    version: 1,
    producer: "agent:historical",
    media_type: "text/plain; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
  };
}

function subagentResult(
  toolCallId: string,
  mode: "single" | "parallel" | "chain",
  refs: readonly ArtifactRef[],
  agents: readonly string[]
): SessionMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: toolCallId,
          name: "subagent",
          arguments: { task: `PG0 V5 labeled ${mode} production result` },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "subagent",
      toolCallId,
      content: [{ type: "text", text: `${mode} completed with exact artifact refs` }],
      details: {
        mode,
        results: refs.map((ref, index) => ({
          agent: agents[index],
          outputArtifactRef: ref,
        })),
        outputArtifactRefs: refs,
        finalOutputArtifactRef: refs.at(-1),
      },
    },
  ];
}

function skillResult(toolCallId: string, ref: ArtifactRef): SessionMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: toolCallId,
          name: "skill",
          arguments: {
            skill_name: "research",
            goal: "PG0 V5 labeled skill production result",
          },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "skill",
      toolCallId,
      content: [{ type: "text", text: "skill completed with an exact terminal artifact ref" }],
      details: {
        success: true,
        session_id: "skill-current-session",
        skill_name: "research",
        state: "complete",
        output_artifact_ref: ref,
      },
    },
  ];
}

function compactionEvent(input: {
  messages: SessionMessage[];
  previousSummary?: string;
  repeated?: boolean;
}): CompactionEvent {
  return {
    preparation: {
      firstKeptEntryId: input.repeated ? "keep-after-second" : "keep-after-first",
      tokensBefore: 20_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      previousSummary: input.previousSummary,
      messagesToSummarize: input.messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
    },
    branchEntries: [
      { type: "session", sessionId: "pg0-v5-current-session" },
      ...(input.repeated ? [{ type: "compaction", firstKeptEntryId: "keep-after-first" }] : []),
    ],
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

async function registerArtifactReadTool(): Promise<RegisteredArtifactReadTool> {
  let registered: unknown;
  artifactExtension(
    createTestExtensionApi({
      onRegisterTool(tool) {
        registered = tool;
      },
    })
  );
  if (!isRegisteredArtifactReadTool(registered)) {
    throw new Error("artifact extension did not register artifact_read");
  }
  return registered;
}

async function registerSubagentTool(): Promise<{
  tool: RegisteredSubagentTool;
  piDirectory: string;
}> {
  const discovery = discoverAgents(process.cwd(), "project");
  if (discovery.projectAgentsDir === null) {
    throw new Error("production agent catalog was not discovered");
  }
  const providerNames = [...new Set(discovery.agents.flatMap((agent) => agent.tools))];
  const subagentExtension = await import("../../../subagent/index.js");
  let registered: unknown;
  subagentExtension.default(
    createTestExtensionApi({
      getAllTools: () => createTestToolInfos(providerNames),
      onRegisterTool(tool) {
        registered = tool;
      },
    })
  );
  if (!isRegisteredSubagentTool(registered)) {
    throw new Error("subagent extension did not register its production tool");
  }
  return { tool: registered, piDirectory: dirname(discovery.projectAgentsDir) };
}

async function readArtifactPage(
  tool: RegisteredArtifactReadTool,
  projectRoot: string,
  artifact: string,
  range?: ArtifactReadRange
): Promise<Record<string, unknown>> {
  const result = await tool.execute(
    `read-${range?.start ?? 0}`,
    { artifact, ...(range ? { range } : {}) },
    undefined,
    undefined,
    { cwd: projectRoot }
  );
  expect(result.isError).not.toBe(true);
  const content = requireArrayElement(result.content, 0, "artifact_read returned no content");
  return requireRecord(parseJson(content.text), "artifact_read returned a non-object body");
}

async function readArtifactFully(
  tool: RegisteredArtifactReadTool,
  projectRoot: string,
  artifact: string
): Promise<CompleteArtifactRead> {
  const chunks: Buffer[] = [];
  let nextRange: ArtifactReadRange | undefined;
  let pageCount = 0;
  do {
    const page = await readArtifactPage(tool, projectRoot, artifact, nextRange);
    expect(page.ok).toBe(true);
    chunks.push(Buffer.from(requireString(page.content, "artifact page omitted bytes"), "utf8"));
    pageCount += 1;
    if (page.next_range === null) {
      nextRange = undefined;
    } else {
      const next = requireRecord(page.next_range, "artifact page next_range is invalid");
      nextRange = {
        start: requireInteger(next.start, "artifact page next_range.start is invalid"),
        end: requireInteger(next.end, "artifact page next_range.end is invalid"),
      };
    }
    if (pageCount > 100) throw new Error("artifact_read continuation did not terminate");
  } while (nextRange !== undefined);
  return { bytes: Buffer.concat(chunks), pageCount };
}

const temporaryRoots: string[] = [];

afterEach(() => {
  downstreamRunnerBehavior = undefined;
  mockRunSingleAgent.mockClear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PG0 V5 current-session compaction recovery", () => {
  it("preserves the labeled production matrix through repeated compaction and downstream exact reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "penny-pg0-v5-compaction-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    vi.stubEnv("PENNY_STATE_ROOT", join(root, "state"));
    vi.stubEnv("PENNY_ARTIFACT_ROOT", "");
    vi.stubEnv("PENNY_TOOL_RESULT_MAX_BYTES", "512");
    vi.stubEnv("PENNY_TOOL_RESULT_MAX_CHARACTERS", "512");
    vi.stubEnv("PENNY_TOOL_RESULT_MAX_TOKENS", "512");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    );
    initializePennyState(projectRoot, { env: process.env });

    const singleBytes = Buffer.from("PG0-V5 labeled single output\n", "utf8");
    const parallelOneBytes = Buffer.from("PG0-V5 labeled parallel branch one\n", "utf8");
    const parallelTwoBytes = Buffer.from("PG0-V5 labeled parallel branch two\n", "utf8");
    const chainOneBytes = Buffer.from(
      `PG0-V5 labeled chain step one\n${"exact🙂漢字-line\n".repeat(4_000)}END-CHAIN-ONE\n`,
      "utf8"
    );
    const chainTwoBytes = Buffer.from("PG0-V5 labeled chain step two\n", "utf8");
    const skillBytes = Buffer.from("PG0-V5 labeled skill terminal output\n", "utf8");

    const single = await persistDirectChainOutput({
      metadata: directAgentOutputMetadata({
        runId: "subagent-single:pg0-v5-current-session",
        index: 0,
        agent: "annie",
      }),
      output: singleBytes.toString("utf8"),
      cwd: projectRoot,
      env: process.env,
    });
    const parallelOne = await persistDirectChainOutput({
      metadata: directAgentOutputMetadata({
        runId: "subagent-parallel:pg0-v5-current-session",
        index: 0,
        agent: "echo",
      }),
      output: parallelOneBytes.toString("utf8"),
      cwd: projectRoot,
      env: process.env,
    });
    const parallelTwo = await persistDirectChainOutput({
      metadata: directAgentOutputMetadata({
        runId: "subagent-parallel:pg0-v5-current-session",
        index: 1,
        agent: "vera",
      }),
      output: parallelTwoBytes.toString("utf8"),
      cwd: projectRoot,
      env: process.env,
    });
    const chainOne = await persistDirectChainOutput({
      metadata: directChainOutputMetadata({
        runId: "subagent-chain:pg0-v5-current-session",
        stepIndex: 0,
        agent: "echo",
      }),
      output: chainOneBytes.toString("utf8"),
      cwd: projectRoot,
      env: process.env,
    });
    const chainTwo = await persistDirectChainOutput({
      metadata: directChainOutputMetadata({
        runId: "subagent-chain:pg0-v5-current-session",
        stepIndex: 1,
        agent: "vera",
        upstreamRefs: [chainOne],
      }),
      output: chainTwoBytes.toString("utf8"),
      cwd: projectRoot,
      env: process.env,
    });
    const skill = await persistSkillArtifactOutput({
      metadata: skillTerminalMetadata(),
      output: skillBytes,
      cwd: projectRoot,
      env: process.env,
    });

    const oldSession = await persistSkillArtifactOutput({
      metadata: historicalMetadata(
        "subagent-single:old-session",
        "historical-operation:old-session"
      ),
      output: "old session artifact must not survive current-session compaction",
      cwd: projectRoot,
      env: process.env,
    });
    const globalHistory = await persistSkillArtifactOutput({
      metadata: historicalMetadata("global-history", "historical-operation:global"),
      output: "unreferenced global artifact must not be discovered",
      cwd: projectRoot,
      env: process.env,
    });

    const labelsById = new Map([
      [single.artifact_id, "single"],
      [parallelOne.artifact_id, "parallel-1"],
      [parallelTwo.artifact_id, "parallel-2"],
      [chainOne.artifact_id, "chain-1"],
      [chainTwo.artifact_id, "chain-2"],
      [skill.artifact_id, "skill"],
    ]);
    const messages: SessionMessage[] = [
      {
        role: "user",
        content: `Current PG0 V5 session. Historical names and IDs are non-authoritative: ${oldSession.artifact_id} ${globalHistory.artifact_id}`,
      },
      ...subagentResult("call-single", "single", [single], ["annie"]),
      ...subagentResult("call-parallel", "parallel", [parallelOne, parallelTwo], ["echo", "vera"]),
      ...subagentResult("call-chain", "chain", [chainOne, chainTwo], ["echo", "vera"]),
      ...skillResult("call-skill", skill),
    ];

    const compaction = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(compaction.api);
    const first = await compaction.emitRequired(compactionEvent({ messages }));
    expect(first.compaction.details.compaction_seq).toBe(0);
    const firstRefs = parseResumeRefs(first.compaction.summary).refs;
    expect(firstRefs).toHaveLength(1);
    const firstIndexRef = requireRecord(
      requireArrayElement(firstRefs, 0, "first compaction emitted no handoff index"),
      "first compaction ref is invalid"
    );
    expect(firstIndexRef.type).toBe("artifact");
    const handoffIndexId = requireString(
      firstIndexRef.artifact_id,
      "first compaction omitted its handoff-index ID"
    );
    expect(
      first.compaction.details.artifact_refs.find((ref) => ref.artifact_id === handoffIndexId)?.kind
    ).toBe("handoff-index");

    const second = await compaction.emitRequired(
      compactionEvent({ messages: [], previousSummary: first.compaction.summary, repeated: true })
    );
    expect(second.compaction.details.compaction_seq).toBe(1);
    expect(parseResumeRefs(second.compaction.summary).refs).toEqual(firstRefs);

    vi.stubEnv("PENNY_TOOL_RESULT_MAX_BYTES", "");
    vi.stubEnv("PENNY_TOOL_RESULT_MAX_CHARACTERS", "");
    vi.stubEnv("PENNY_TOOL_RESULT_MAX_TOKENS", "");

    const downstreamSessionId = "pg0-v5-fresh-downstream-session";
    let downstreamRecovery:
      | {
          inputArtifactIds: string[];
          indexPageCount: number;
          records: HandoffRecord[];
          selectedArtifactId: string;
          selectedPageCount: number;
          bytes: Buffer;
        }
      | undefined;
    downstreamRunnerBehavior = async (input) => {
      expect(input.defaultCwd).toBe(projectRoot);
      expect(input.agent).toBe("synthia");
      expect(input.step).toBeUndefined();
      expect(input.ownerEnvironment?.PENNY_SUBAGENT_PARENT_SESSION_ID).toBe(downstreamSessionId);

      const inputArtifactIds = artifactIds(input.task);
      expect(inputArtifactIds).toEqual([handoffIndexId]);
      const suppliedIndexId = inputArtifactIds[0];
      if (suppliedIndexId === undefined) {
        throw new Error("downstream task omitted its recovered handoff-index ID");
      }
      const downstreamArtifactRead = await registerArtifactReadTool();
      const recoveredIndex = await readArtifactFully(
        downstreamArtifactRead,
        projectRoot,
        suppliedIndexId
      );
      const records = parseHandoffRecords(recoveredIndex.bytes);
      const selected = records.find((record) => record.branchOrStep === "chain-step-0001");
      if (selected === undefined) {
        throw new Error("downstream handoff-index read omitted the labeled first chain step");
      }
      const recoveredArtifact = await readArtifactFully(
        downstreamArtifactRead,
        projectRoot,
        selected.artifactId
      );
      downstreamRecovery = {
        inputArtifactIds,
        indexPageCount: recoveredIndex.pageCount,
        records,
        selectedArtifactId: selected.artifactId,
        selectedPageCount: recoveredArtifact.pageCount,
        bytes: recoveredArtifact.bytes,
      };
      return successfulSingleResult({
        agent: input.agent,
        task: input.task,
        step: input.step,
        output: `Recovered ${recoveredArtifact.bytes.length} exact bytes from ${selected.artifactId} through artifact_read.`,
      });
    };

    const registeredSubagent = await registerSubagentTool();
    vi.stubEnv("PI_DIRECTORY", registeredSubagent.piDirectory);
    const downstream = await registeredSubagent.tool.execute(
      "pg0-v5-downstream-recovery",
      {
        agent: "synthia",
        task: "Read the supplied handoff index, select chain-step-0001, and recover its exact bytes with artifact_read.",
        input_artifacts: [handoffIndexId],
      },
      undefined,
      undefined,
      {
        cwd: projectRoot,
        hasUI: false,
        sessionManager: { getSessionId: () => downstreamSessionId },
      }
    );
    expect(downstream.isError).not.toBe(true);
    expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
    expect(downstream.details.mode).toBe("single");
    expect(downstream.details.artifactRunId).toMatch(/^subagent-single:/u);
    expect(downstream.details.artifactRunId).not.toBe("subagent-single:pg0-v5-current-session");
    expect(downstream.details.outputArtifactRefs).toHaveLength(1);

    const recovery = downstreamRecovery;
    if (recovery === undefined) throw new Error("fresh downstream runner did not recover bytes");
    const records = recovery.records;
    expect(recovery.inputArtifactIds).toEqual([handoffIndexId]);
    expect(recovery.indexPageCount).toBeGreaterThan(0);
    expect(records.map((record) => labelsById.get(record.artifactId)).sort()).toEqual([
      "chain-1",
      "chain-2",
      "parallel-1",
      "parallel-2",
      "single",
      "skill",
    ]);
    expect(records.map((record) => record.creationOrder)).toEqual(
      records.map((_record, index) => index)
    );
    expect(new Set(records.map((record) => `${record.artifactId}@${record.digest}`))).toEqual(
      new Set(
        [single, parallelOne, parallelTwo, chainOne, chainTwo, skill].map(
          (ref) => `${ref.artifact_id}@${ref.content_digest}`
        )
      )
    );
    expect(records.some((record) => record.artifactId === oldSession.artifact_id)).toBe(false);
    expect(records.some((record) => record.artifactId === globalHistory.artifact_id)).toBe(false);
    expect(records.find((record) => record.artifactId === skill.artifact_id)?.producingTool).toBe(
      "skill"
    );
    expect(
      records
        .filter((record) => record.artifactId !== skill.artifact_id)
        .every((record) => record.producingTool === "subagent-or-skill-stage")
    ).toBe(true);
    expect(labelsById.get(recovery.selectedArtifactId)).toBe("chain-1");
    expect(recovery.selectedPageCount).toBeGreaterThan(1);
    expect(recovery.bytes.equals(chainOneBytes)).toBe(true);
  });
});
