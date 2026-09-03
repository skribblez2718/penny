/** TypeScript-only skill routing: no Python process is reachable from any mode. */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANDIDATE_PLAYBOOK_REGISTRY,
  initializePennyState,
  skillContractSha256,
  type OrchestrationProgressEvent,
} from "@penny/orchestration/source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactRef } from "../../artifact-client.js";
import type { InputArtifactsV2 } from "../../input-artifacts.js";
import {
  isSkillProgressDetails,
  type SkillResult,
  type SkillToolDetails,
} from "../../skill-utils.js";
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
  identity: { run_id: string; playbook: string };
  input_artifacts?: InputArtifactsV2;
}

interface ProgressUpdate {
  content: Array<{ type: string; text: string }>;
  details: SkillToolDetails | undefined;
}

interface RegisteredSkillTool {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ProgressUpdate) => void) | undefined,
    context: unknown
  ) => Promise<{ details: SkillResult }>;
  renderResult?: (
    result: ProgressUpdate,
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: unknown
  ) => unknown;
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
  mockTypeScriptExecute:
    vi.fn<
      (
        request: EngineExecuteRequest,
        signal?: AbortSignal,
        onProgress?: (event: OrchestrationProgressEvent) => void
      ) => Promise<unknown>
    >(),
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
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    withFileMutationQueue: vi.fn((_path: string, operation: () => unknown) => operation()),
  };
});
vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    addChild() {}
  },
  Markdown: class {},
  Text: class {
    constructor(readonly text: string) {}
  },
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

function renderTheme(): Record<string, unknown> {
  return { fg: (_color: string, text: string) => text };
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

function cancelled(runId: string) {
  const partial = artifactRef(runId, "researching");
  return {
    schema_version: 2,
    action: "cancelled",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: runId,
      playbook: "research",
      engine_owner: "typescript",
    },
    state_id: "researching",
    status: "cancelled",
    met: false,
    result: {
      met: false,
      output_artifact_ref: partial,
      best_partial_artifact_refs: [partial],
    },
    artifacts: [partial],
    unresolved: ["cancelled by caller"],
  };
}

function emitEngineProgress(
  request: EngineExecuteRequest,
  onProgress?: (event: OrchestrationProgressEvent) => void
): void {
  const runId = request.identity.run_id;
  const worker = {
    state_id: "researching",
    agent: "echo",
    attempt: 1,
    branch_id: null,
    execution_purpose: "phase" as const,
  };
  onProgress?.({
    event: "phase_started",
    run_id: runId,
    playbook: "research",
    state_id: "researching",
    workers: [worker],
  });
  onProgress?.({
    event: "worker_completed",
    run_id: runId,
    playbook: "research",
    state_id: "researching",
    worker,
    completed_workers: 1,
    total_workers: 1,
  });
  onProgress?.({
    event: "boundary_reached",
    run_id: runId,
    playbook: "research",
    action: "complete",
  });
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
  mockTypeScriptExecute.mockImplementation(async (request, _signal, onProgress) => {
    emitEngineProgress(request, onProgress);
    return complete(request.identity.run_id, true);
  });
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

  it("routes every registered candidate through the skill tool with its exact registration", async () => {
    const extension = await import("../../index.js");
    for (const registration of CANDIDATE_PLAYBOOK_REGISTRY.values()) {
      registeredTool = undefined;
      extension.default(pi(), {
        skillIngressResolver: ({ name }) =>
          name === registration.name
            ? {
                ok: true,
                registration,
                release_status: "candidate",
                contract_sha256: skillContractSha256(registration.contract),
              }
            : { ok: false, code: "SKILL_NOT_REGISTERED", message: "unexpected test skill" },
      });
      const response = await skillTool().execute(
        `candidate-${registration.name}`,
        {
          skill_name: registration.name,
          goal: `Exercise the ${registration.name} candidate entrypoint.`,
          session_id: `candidate-${registration.name}`,
        },
        undefined,
        undefined,
        context()
      );
      expect(response.details).toMatchObject({
        success: true,
        session_id: `candidate-${registration.name}`,
        skill_name: registration.name,
      });
      expect(mockServiceOptions.at(-1)?.playbookRegistration).toBe(registration);
      expect(mockTypeScriptExecute.mock.calls.at(-1)?.[0].identity.playbook).toBe(
        registration.name
      );
    }
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(CANDIDATE_PLAYBOOK_REGISTRY.size);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("forwards shared runner progress as structured, renderable partial results", async () => {
    const updates: ProgressUpdate[] = [];
    await skillTool().execute(
      "progress",
      { skill_name: "research", goal: "show truthful progress", session_id: "progress-ts" },
      undefined,
      (update) => updates.push(update),
      context()
    );

    expect(updates.every((update) => isSkillProgressDetails(update.details))).toBe(true);
    expect(updates.map((update) => update.content[0]?.text)).toEqual([
      "Preparing research",
      "research — researching with echo",
      "research — echo finished researching (1/1)",
      "research — engine complete; checking output",
    ]);
    expect(mockTypeScriptExecute.mock.calls[0]?.[2]).toEqual(expect.any(Function));

    const render = requireDefined(skillTool().renderResult, "skill renderer was not registered");
    const rendered = requireRecord(
      render(
        requireDefined(updates[1], "structured progress update was not emitted"),
        { expanded: false, isPartial: true },
        renderTheme(),
        {}
      ),
      "structured progress renderer did not return a component"
    );
    expect(rendered.text).toContain("Running · research — researching with echo");
    const terminalProgress = requireRecord(
      render(
        requireDefined(updates.at(-1), "terminal progress update was not emitted"),
        { expanded: false, isPartial: true },
        renderTheme(),
        {}
      ),
      "terminal progress renderer did not return a component"
    );
    expect(terminalProgress.text).toBe("Finalizing · research — engine complete; checking output");

    const textOnly = requireRecord(
      render(
        { content: [{ type: "text", text: "Still running a phase" }], details: undefined },
        { expanded: false, isPartial: true },
        renderTheme(),
        {}
      ),
      "text-only progress renderer did not return a component"
    );
    expect(textOnly.text).toBe("Still running a phase");
    expect(textOnly.text).not.toBe("No result");
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

  it("returns the durable cancelled result when cancellation settles execution", async () => {
    const controller = new AbortController();
    mockTypeScriptExecute.mockImplementation(async (request) => {
      controller.abort("settled cancellation");
      return cancelled(request.identity.run_id);
    });

    const response = await skillTool().execute(
      "cancelled",
      {
        skill_name: "research",
        goal: "return the durable cancellation",
        session_id: "cancelled-ts",
      },
      controller.signal,
      undefined,
      context()
    );
    const partial = artifactRef("cancelled-ts", "researching");
    expect(response.details).toMatchObject({
      success: false,
      session_id: "cancelled-ts",
      state: "cancelled",
      errors: ["cancelled by caller"],
      output_artifact_ref: partial,
      best_partial_artifact_refs: [partial],
    });
    expect(response.details.result).toEqual(cancelled("cancelled-ts").result);
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(1);
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

  it("runs parallel skills through independent TypeScript services with aggregate progress", async () => {
    const updates: ProgressUpdate[] = [];
    const response = await skillTool().execute(
      "parallel",
      {
        skills: [
          { skill_name: "research", goal: "first", session_id: "parallel-one" },
          { skill_name: "research", goal: "second", session_id: "parallel-two" },
        ],
      },
      undefined,
      (update) => updates.push(update),
      context()
    );
    expect(response.details).toMatchObject({ success: true, mode: "parallel" });
    expect(
      updates.some(
        (update) =>
          isSkillProgressDetails(update.details) &&
          update.details.mode === "parallel" &&
          update.details.state_id === "researching" &&
          update.details.skills_total === 2
      )
    ).toBe(true);
    expect(updates.every((update) => update.details !== undefined)).toBe(true);
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(2);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("runs a two-step chain through TypeScript and seeds the exact target-run handoff", async () => {
    mockTypeScriptExecute.mockImplementation(async (request, _signal, onProgress) => {
      emitEngineProgress(request, onProgress);
      return complete(request.identity.run_id, true);
    });
    mockPersistHandoff.mockImplementation(async (options) =>
      artifactRef(options.targetRunId, "chain_input")
    );
    const updates: ProgressUpdate[] = [];
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
      (update) => updates.push(update),
      context()
    );
    expect(response.details).toMatchObject({ success: true, mode: "chain" });
    expect(
      updates.some(
        (update) =>
          isSkillProgressDetails(update.details) &&
          update.details.mode === "chain" &&
          update.details.state_id === "researching" &&
          update.details.chain_step === 0
      )
    ).toBe(true);
    expect(updates.every((update) => update.details !== undefined)).toBe(true);
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

  it("surfaces resumed child phases through resume-mode progress", async () => {
    mockTypeScriptExecute.mockImplementationOnce(async (request) =>
      cancelled(request.identity.run_id)
    );
    const failed = await skillTool().execute(
      "resume-setup",
      {
        chain: [{ skill_name: "research", goal: "fail then resume", session_id: "resume-step" }],
      },
      undefined,
      undefined,
      context()
    );
    const chainSessionId = requireDefined(
      failed.details.chain_session_id,
      "failed chain omitted its resume ID"
    );
    const updates: ProgressUpdate[] = [];

    const resumed = await skillTool().execute(
      "resume",
      { resume_chain: chainSessionId },
      undefined,
      (update) => updates.push(update),
      context()
    );

    expect(resumed.details).toMatchObject({ success: true, mode: "chain" });
    expect(
      updates.some(
        (update) =>
          isSkillProgressDetails(update.details) &&
          update.details.mode === "resume" &&
          update.details.stage === "resuming"
      )
    ).toBe(true);
    expect(
      updates.some(
        (update) =>
          isSkillProgressDetails(update.details) &&
          update.details.mode === "resume" &&
          update.details.state_id === "researching"
      )
    ).toBe(true);
    expect(updates.every((update) => update.details !== undefined)).toBe(true);
  });

  it("stops a generic chain failure with exact refs and no retry-approval questionnaire", async () => {
    mockTypeScriptExecute.mockImplementationOnce(async (request) =>
      cancelled(request.identity.run_id)
    );
    const response = await skillTool().execute(
      "chain-failure",
      {
        chain: [
          { skill_name: "research", goal: "fail honestly", session_id: "chain-failure-step" },
          { skill_name: "research", goal: "must not run", session_id: "chain-never-runs" },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(response.details).toMatchObject({
      success: false,
      state: "failed",
      requires_approval: false,
      resumable: true,
      chain_error_step: 0,
    });
    expect(response.details.escalation).toBeUndefined();
    expect(response.details.output_artifact_ref).toEqual(
      artifactRef("chain-failure-step", "researching")
    );
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(1);
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
    expect(response.details).toMatchObject({
      refusal_code: "SKILL_NOT_REGISTERED",
    });
    expect(response.details.errors[0]).toMatch(/^SKILL_NOT_REGISTERED:/u);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
