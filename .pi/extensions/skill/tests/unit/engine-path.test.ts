/** TypeScript-only skill routing: no Python process is reachable from any mode. */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializePennyState } from "@penny/orchestration/source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactRef } from "../../artifact-client.js";
import type { InputArtifactsV2 } from "../../input-artifacts.js";
import type { SkillResult } from "../../skill-utils.js";
import {
  createTestExtensionApi,
  isRecord,
  requireDefined,
  requireRecord,
} from "../../../../lib/tests/test-narrowers.js";

type PersistHandoffOptions = Parameters<
  typeof import("../../skill-chain-artifacts.js").persistSkillChainHandoff
>[0];
type SkillChainInputOptions = Parameters<
  typeof import("../../skill-chain-artifacts.js").skillChainInput
>[0];

interface EngineExecuteRequest {
  identity: { run_id: string };
  input_artifacts?: InputArtifactsV2;
}

interface RegisteredSkillTool {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown
  ) => Promise<{ details: SkillResult }>;
}

const {
  mockSpawn,
  mockTypeScriptExecute,
  mockLoadRun,
  mockArtifactRead,
  mockReadArtifactsById,
  mockServiceOptions,
  mockPersistHandoff,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockTypeScriptExecute: vi.fn<(request: EngineExecuteRequest) => Promise<unknown>>(),
  mockLoadRun: vi.fn(() => undefined),
  mockArtifactRead: vi.fn(() => Buffer.from("exact")),
  mockReadArtifactsById: vi.fn(),
  mockServiceOptions: [] as Array<Record<string, unknown>>,
  mockPersistHandoff: vi.fn<(options: PersistHandoffOptions) => Promise<ArtifactRef>>(),
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("child_process", () => ({ spawn: mockSpawn }));
vi.mock("@penny/orchestration/source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@penny/orchestration/source")>()),
  OrchestrationService: class {
    artifacts = { read: mockArtifactRead };
    checkpointer = {
      loadRunById: mockLoadRun,
      events: vi.fn(() => [{ payload: { agent: "echo" } }]),
    };
    execute = mockTypeScriptExecute;
    constructor(options: Record<string, unknown>) {
      mockServiceOptions.push(options);
    }
    close() {}
    [Symbol.dispose]() {
      this.close();
    }
  },
  ArtifactStore: class {},
  loadRuntimeConfig: vi.fn(),
}));
vi.mock("../../artifact-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../artifact-client.js")>()),
  readArtifactOutput: vi.fn(async () => Buffer.from("exact")),
  readArtifactsById: mockReadArtifactsById,
}));
vi.mock("../../skill-chain-artifacts.js", () => ({
  persistSkillChainHandoff: mockPersistHandoff,
  validateSkillChainHandoff: vi.fn(async () => undefined),
  skillChainInput: ({ handoffRef }: SkillChainInputOptions) => ({
    schema_version: 2,
    artifacts: [{ slot: "previous-skill-terminal-output", ref: handoffRef }],
  }),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, operation: () => unknown) => operation()),
  parseFrontmatter: (content: string | Buffer) => {
    const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    const frontmatter: Record<string, string> = {};
    for (const line of match?.[1]?.split("\n") ?? []) {
      const item = line.match(/^(\w+):\s*(.+)$/);
      if (item) frontmatter[item[1]] = item[2].trim();
    }
    return { frontmatter, body: text };
  },
}));
vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    addChild() {}
  },
  Markdown: class {},
  Text: class {},
  Spacer: class {},
}));

let registeredTool: RegisteredSkillTool | undefined;
let testProjectRoot: string;

function isRegisteredSkillTool(value: unknown): value is RegisteredSkillTool {
  if (!isRecord(value)) return false;
  const candidate = value;
  if (candidate["name"] !== "skill" || typeof candidate["execute"] !== "function") return false;
  const parameters = candidate["parameters"];
  return (
    parameters !== null &&
    typeof parameters === "object" &&
    "properties" in parameters &&
    parameters.properties !== null &&
    typeof parameters.properties === "object"
  );
}

function pi() {
  return createTestExtensionApi({
    onRegisterTool(definition) {
      if (isRegisteredSkillTool(definition)) registeredTool = definition;
    },
  });
}

function context(): Record<string, unknown> {
  return {
    cwd: testProjectRoot,
    isProjectTrusted: () => true,
    ui: { theme: { fg: () => "" }, notify: vi.fn() },
  };
}

function skillTool(): RegisteredSkillTool {
  if (registeredTool === undefined) throw new Error("skill tool was not registered");
  return registeredTool;
}

function artifactRef(runId: string, phase = "report_writing"): ArtifactRef {
  const identity = {
    branch_id: null,
    kind: "agent-output",
    operation_id: `${runId}-${phase}`,
    phase,
    run_id: runId,
    version: 1,
  };
  const digest = "a".repeat(64);
  return {
    schema_version: 2,
    artifact_id: `art_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    run_id: runId,
    phase,
    branch_id: null,
    kind: "agent-output",
    operation_id: identity.operation_id,
    version: 1,
    producer: "agent:skribble",
    media_type: "text/plain; charset=utf-8",
    byte_length: 5,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}
function complete(runId: string, withArtifact = false) {
  return {
    schema_version: 2,
    action: "complete",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: runId,
      playbook: "research",
      engine_owner: "typescript",
    },
    state_id: "report_writing",
    status: "complete",
    met: true,
    result: { met: true, output_artifact_ref: withArtifact ? artifactRef(runId) : null },
    artifacts: [],
    unresolved: [],
  };
}

const temporaryRoots: string[] = [];
beforeEach(async () => {
  vi.clearAllMocks();
  registeredTool = undefined;
  mockServiceOptions.length = 0;
  mockLoadRun.mockReturnValue(undefined);
  mockReadArtifactsById.mockImplementation(async ({ artifactIds }: { artifactIds: string[] }) =>
    artifactIds.map(() => ({
      ref: artifactRef("prior-cross-run", "prior-output"),
      content: Buffer.from("exact"),
    }))
  );
  mockTypeScriptExecute.mockImplementation(async (request) =>
    complete(request.identity.run_id, true)
  );
  const directory = mkdtempSync(join(tmpdir(), "penny-ts-skill-routing-"));
  temporaryRoots.push(directory);
  testProjectRoot = join(directory, "project");
  mkdirSync(testProjectRoot, { mode: 0o700 });
  process.env.PENNY_STATE_ROOT = join(directory, "state");
  delete process.env.PENNY_SKILL_CHAIN_STATE_ROOT;
  delete process.env.PENNY_ARTIFACT_ROOT;
  process.env.PROJECT_ROOT = testProjectRoot;
  initializePennyState(testProjectRoot, { env: process.env });
  const extension = await import("../../index.js");
  extension.default(pi());
});
afterEach(() => {
  delete process.env.PENNY_STATE_ROOT;
  delete process.env.PENNY_SKILL_CHAIN_STATE_ROOT;
  delete process.env.PENNY_ARTIFACT_ROOT;
  delete process.env.PROJECT_ROOT;
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("TypeScript-only skill engine path", () => {
  it("runs single research without an engine selector or Python spawn", async () => {
    const response = await skillTool().execute(
      "single",
      { skill_name: "research", goal: "research safely", session_id: "single-ts" },
      undefined,
      undefined,
      context()
    );
    expect(response.details).toMatchObject({ success: true, session_id: "single-ts" });
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(1);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(skillTool().parameters.properties.engine).toBeUndefined();
  });

  it("preflights and seeds explicit cross-run input artifact IDs", async () => {
    const id = `art_${"7".repeat(64)}`;
    await skillTool().execute(
      "input",
      {
        skill_name: "research",
        goal: "integrate exact prior work",
        session_id: "input-ts",
        input_artifacts: [id],
      },
      undefined,
      undefined,
      context()
    );
    expect(mockReadArtifactsById).toHaveBeenCalledWith({
      artifactIds: [id],
      projectRoot: testProjectRoot,
      env: process.env,
    });
    const start = mockTypeScriptExecute.mock.calls[0]?.[0];
    if (start?.input_artifacts === undefined) throw new Error("engine input artifacts are absent");
    expect(start.input_artifacts.schema_version).toBe(2);
    expect(start.input_artifacts.artifacts[0]?.ref.run_id).toBe("prior-cross-run");
  });

  it("applies a test/caller model override without mutating production process defaults", async () => {
    const before = process.env.PENNY_RESEARCH_DEFAULT_MODEL;
    await skillTool().execute(
      "model",
      {
        skill_name: "research",
        goal: "model test",
        session_id: "model-ts",
        model: "qwen3.827b:latest",
      },
      undefined,
      undefined,
      context()
    );
    const serviceOptions = requireDefined(
      mockServiceOptions[0],
      "service options were not captured"
    );
    const serviceEnv = requireRecord(serviceOptions.env, "service options omitted environment");
    expect(serviceEnv.PENNY_RESEARCH_DEFAULT_MODEL).toBe("qwen3.827b:latest");
    expect(process.env.PENNY_RESEARCH_DEFAULT_MODEL).toBe(before);
  });

  it("runs parallel skills through independent TypeScript services", async () => {
    const response = await skillTool().execute(
      "parallel",
      {
        skills: [
          { skill_name: "research", goal: "first", session_id: "parallel-one" },
          { skill_name: "research", goal: "second", session_id: "parallel-two" },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(response.details).toMatchObject({ success: true, mode: "parallel" });
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(2);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("runs a two-step chain through TypeScript and seeds the exact target-run handoff", async () => {
    mockTypeScriptExecute.mockImplementation(async (request) =>
      complete(request.identity.run_id, true)
    );
    mockPersistHandoff.mockImplementation(async (options) =>
      artifactRef(options.targetRunId, "chain_input")
    );
    const response = await skillTool().execute(
      "chain",
      {
        chain: [
          { skill_name: "research", goal: "first", session_id: "chain-one" },
          {
            skill_name: "research",
            goal: "use {previous}",
            session_id: "chain-two",
          },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(response.details).toMatchObject({ success: true, mode: "chain" });
    const handoffOptions = requireDefined(
      mockPersistHandoff.mock.calls[0]?.[0],
      "chain handoff was not persisted"
    );
    expect(handoffOptions.targetRunId).toBe("chain-two");
    expect(typeof handoffOptions.projectRoot).toBe("string");
    expect(mockArtifactRead).toHaveBeenCalledTimes(1);
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(2);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("refuses an unregistered skill without falling back to Python", async () => {
    const response = await skillTool().execute(
      "unknown",
      { skill_name: "not-registered", goal: "no fallback" },
      undefined,
      undefined,
      context()
    );
    expect(response.details.success).toBe(false);
    expect(response.details.errors).toContain(
      "TypeScript orchestration currently supports the research skill on this tool."
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
