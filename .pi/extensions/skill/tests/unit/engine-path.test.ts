/** TypeScript-only skill routing: no Python process is reachable from any mode. */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { memoryExtensionSource } from "@penny/memory-extension";
import {
  PLAYBOOK_REGISTRY,
  encodeCanonicalPng,
  initializePennyState,
  skillContractSha256,
  upgradePennyState,
  type OrchestrationProgressEvent,
} from "@penny/orchestration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { artifactIdFor, type ArtifactRef } from "../../artifact-client.js";
import type { InputArtifactsV2 } from "../../input-artifacts.js";
import * as currentResults from "@penny/orchestration";
import { PlaybookUiOwner } from "../../playbook-ui.js";
import {
  isSkillProgressDetails,
  type SkillResult,
  type SkillToolDetails,
} from "../../skill-utils.js";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord, requireDefined, requireRecord } from "../../../../lib/tests/test-narrowers.js";

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
  ) => Promise<{
    details: SkillResult;
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  }>;
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
  mockReadArtifactOutput,
  mockReadArtifactsById,
  mockServiceOptions,
  mockPersistHandoff,
  mockEvents,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockEvents: vi.fn(() => [{ payload: { agent: "echo" } }]),
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
  mockReadArtifactOutput: vi.fn<(_input: { ref: ArtifactRef }) => Promise<Buffer>>(async () =>
    Buffer.from("exact")
  ),
  mockReadArtifactsById: vi.fn(),
  mockServiceOptions: [] as Array<Record<string, unknown>>,
  mockPersistHandoff: vi.fn<(options: PersistHandoffOptions) => Promise<ArtifactRef>>(),
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("child_process", () => ({ spawn: mockSpawn }));
vi.mock("@penny/orchestration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@penny/orchestration")>()),
  OrchestrationService: class {
    artifacts = { read: mockArtifactRead };
    checkpointer = {
      loadRunById: mockLoadRun,
      events: mockEvents,
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
  readArtifactOutput: mockReadArtifactOutput,
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
    readonly children: unknown[] = [];
    addChild(child: unknown) {
      this.children.push(child);
    }
  },
  Markdown: class {},
  Text: class {
    constructor(readonly text: string) {}
  },
  Spacer: class {},
}));

let registeredTool: RegisteredSkillTool | undefined;
let testProjectRoot: string;
let orchestrationDatabase: string;

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
  vi.restoreAllMocks();
  vi.clearAllMocks();
  registeredTool = undefined;
  mockServiceOptions.length = 0;
  mockLoadRun.mockReturnValue(undefined);
  mockEvents.mockReturnValue([{ payload: { agent: "echo" } }]);
  mockReadArtifactOutput.mockImplementation(async () => Buffer.from("exact"));
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
  orchestrationDatabase = initializePennyState(testProjectRoot, {
    env: process.env,
  }).paths.orchestration.database;
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
  it.each([false, true])(
    "publishes exact single/parallel/chain clarification continuations, native=%s",
    async (native) => {
      if (native)
        vi.spyOn(PlaybookUiOwner.prototype, "prepare").mockResolvedValue({
          capability: "fixture-native-capability",
          text: "Native fixture",
          dispose() {},
        });
      mockTypeScriptExecute.mockImplementation(async (request) => ({
        schema_version: 2,
        action: "await_user",
        identity: {
          schema_version: 2,
          run_id: `engine-run-${request.identity.run_id}`,
          session_id: request.identity.run_id,
          playbook: "research",
          engine_owner: "typescript",
        },
        state_id: "awaiting_clarification",
        gate_id: "exact-gate",
        challenge: "exact-challenge",
        questions: [{ id: "scope", prompt: "Which scope?" }],
      }));
      const ctx = { ...context(), hasUI: true, mode: "tui" };
      const single = await skillTool().execute(
        "single-wait",
        {
          skill_name: "research",
          goal: "clarify",
          session_id: "single-wait",
        },
        undefined,
        undefined,
        ctx
      );
      const parallel = await skillTool().execute(
        "parallel-wait",
        {
          skills: [{ skill_name: "research", goal: "clarify", session_id: "parallel-wait" }],
        },
        undefined,
        undefined,
        ctx
      );
      const chain = await skillTool().execute(
        "chain-wait",
        {
          chain: [{ skill_name: "research", goal: "clarify", session_id: "chain-wait" }],
        },
        undefined,
        undefined,
        ctx
      );
      for (const [result, session] of [
        [single.details, "single-wait"],
        [parallel.details.parallel_results?.[0], "parallel-wait"],
        [chain.details, "chain-wait"],
      ] as const) {
        expect(result?.continuation).toEqual({
          kind: "clarification",
          gate_id: "exact-gate",
          challenge: "exact-challenge",
          resume_invocation: {
            skill_name: "research",
            session_id: session,
            goal: "clarify",
            constraints: {},
          },
          identity: {
            schema_version: 2,
            run_id: `engine-run-${session}`,
            session_id: session,
            playbook: "research",
            engine_owner: "typescript",
          },
        });
        expect(result?.escalation?.trustedTransportCapability).toBe(
          native ? "fixture-native-capability" : undefined
        );
      }
      expect(chain.details.chain_results).toEqual([]);
      for (const result of [single, parallel, chain])
        expect(currentResults.parseCurrentSkillResult(result.details)).toEqual(result.details);
    }
  );

  it("validates early mode/limit errors through the same public parser", async () => {
    const parser = vi.spyOn(currentResults, "parseCurrentSkillResult");
    for (const params of [
      {},
      { skills: Array.from({ length: 4 }, () => ({ skill_name: "research", goal: "limit" })) },
      { chain: Array.from({ length: 11 }, () => ({ skill_name: "research", goal: "limit" })) },
      { resume_chain: "missing-chain" },
      { skill_name: "not-registered", goal: "refuse" },
    ]) {
      parser.mockClear();
      const result = await skillTool().execute("early", params, undefined, undefined, context());
      expect(result.details.success).toBe(false);
      expect(parser).toHaveBeenCalledWith(result.details);
    }
    expect(mockTypeScriptExecute).not.toHaveBeenCalled();
  });

  it("rejects malformed terminal details instead of returning a permissive result", async () => {
    mockTypeScriptExecute.mockResolvedValue({
      ...complete("malformed", true),
      result: { bad: true },
    });
    await expect(
      skillTool().execute(
        "malformed",
        {
          skill_name: "research",
          goal: "reject",
          session_id: "malformed",
        },
        undefined,
        undefined,
        context()
      )
    ).rejects.toThrow();
    expect(mockReadArtifactOutput).not.toHaveBeenCalled();
  });

  it("keeps long invocation histories but rejects over-capacity single and aggregate results", async () => {
    const events = Array.from({ length: 300 }, () => ({ payload: { agent: "echo" } }));
    mockEvents.mockReturnValue(events);
    const long = {
      ...complete("long-history", true),
      unresolved: Array.from({ length: 300 }, () => "bounded issue"),
    };
    mockTypeScriptExecute.mockResolvedValue(long);
    const result = await skillTool().execute(
      "long",
      {
        skill_name: "research",
        goal: "long history",
        session_id: "long-history",
      },
      undefined,
      undefined,
      context()
    );
    expect(result.details.errors).toHaveLength(events.length);
    expect(result.details.agents_invoked).toHaveLength(events.length);
    mockTypeScriptExecute.mockResolvedValue({ ...long, unresolved: ["x".repeat(32_769)] });
    await expect(
      skillTool().execute(
        "oversized-single",
        {
          skill_name: "research",
          goal: "oversized",
          session_id: "long-history",
        },
        undefined,
        undefined,
        context()
      )
    ).rejects.toThrow();
    mockTypeScriptExecute.mockResolvedValue({
      ...long,
      unresolved: Array.from({ length: 48 }, () => "x".repeat(32_768)),
    });
    await expect(
      skillTool().execute(
        "oversized-aggregate",
        {
          skills: [
            { skill_name: "research", goal: "one" },
            { skill_name: "research", goal: "two" },
          ],
        },
        undefined,
        undefined,
        context()
      )
    ).rejects.toThrow("invalid current skill result");
  });

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

  it("presents a verified terminal PNG as metadata plus exact image content", async () => {
    const bytes = Buffer.from(
      encodeCanonicalPng({
        width: 1,
        height: 1,
        rgba: Uint8Array.from([15, 25, 35, 255]),
      })
    );
    const baseRef = artifactRef("terminal-image", "complete");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const imageRef: ArtifactRef = {
      ...baseRef,
      media_type: "image/png",
      byte_length: bytes.length,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    };
    mockTypeScriptExecute.mockResolvedValue({
      ...complete("terminal-image", false),
      result: { met: true, output_artifact_ref: imageRef },
      artifacts: [imageRef],
    });
    mockReadArtifactOutput.mockResolvedValue(bytes);

    const response = await skillTool().execute(
      "terminal-image",
      { skill_name: "research", goal: "return an image", session_id: "terminal-image" },
      undefined,
      undefined,
      context()
    );
    expect(response.content).toHaveLength(2);
    expect(response.content[0]).toMatchObject({ type: "text" });
    expect(response.content[1]).toEqual({
      type: "image",
      data: bytes.toString("base64"),
      mimeType: "image/png",
    });
    const metadataText = response.content[0]?.text;
    if (metadataText === undefined) throw new Error("terminal image metadata is absent");
    expect(JSON.parse(metadataText)).toMatchObject({
      type: "skill_image_output",
      artifact_ref: { artifact_id: imageRef.artifact_id },
      content_digest: digest,
      image: { width: 1, height: 1 },
    });
    expect(metadataText).not.toContain(bytes.toString("base64"));
    expect(response.details).toMatchObject({ success: true, output_artifact_ref: imageRef });
  });

  it("returns a structured stale-state failure before dispatch", async () => {
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (sqlite === undefined) throw new Error("node:sqlite unavailable");
    using stale = new sqlite.DatabaseSync(orchestrationDatabase);
    stale.exec(
      "DROP TABLE host_operation_calls; DROP TABLE child_workflow_calls; PRAGMA user_version=10;"
    );

    const response = await skillTool().execute(
      "stale-state",
      { skill_name: "research", goal: "must not dispatch", session_id: "stale-state" },
      undefined,
      undefined,
      context()
    );

    expect(response.details).toMatchObject({
      success: false,
      state: "error",
      errors: [expect.stringContaining("STATE_SCHEMA_INCOMPATIBLE")],
      state_failure: {
        code: "STATE_SCHEMA_INCOMPATIBLE",
        details: {
          component: "orchestration",
          actualSchemaVersion: 10,
          requiredSchemaVersion: 13,
          upgradeSupported: true,
          recoveryAction: "penny-state-upgrade",
        },
      },
    });
    expect(mockTypeScriptExecute).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("routes every generic registered skill through the upgraded shared state", async () => {
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (sqlite === undefined) throw new Error("node:sqlite unavailable");
    {
      using stale = new sqlite.DatabaseSync(orchestrationDatabase);
      stale.exec(
        "DROP TABLE host_operation_calls; DROP TABLE child_workflow_calls; PRAGMA user_version=10;"
      );
    }
    const backupDirectory = join(dirname(testProjectRoot), "backups");
    mkdirSync(backupDirectory, { mode: 0o700 });
    await upgradePennyState({
      projectRoot: testProjectRoot,
      backupDirectory,
      rootOptions: { env: process.env },
    });

    const extension = await import("../../index.js");
    const genericRegistrations = [...PLAYBOOK_REGISTRY.values()].filter(
      (registration) => registration.ingress === "skill"
    );
    for (const registration of genericRegistrations) {
      registeredTool = undefined;
      extension.default(pi(), {
        skillIngressResolver: ({ name }) =>
          name === registration.name
            ? {
                ok: true,
                registration,
                contract_sha256: skillContractSha256(registration.contract),
              }
            : { ok: false, code: "SKILL_NOT_REGISTERED", message: "unexpected test skill" },
      });
      const response = await skillTool().execute(
        `registered-${registration.name}`,
        {
          skill_name: registration.name,
          goal: `Exercise the ${registration.name} registered entrypoint.`,
          session_id: `registered-${registration.name}`,
        },
        undefined,
        undefined,
        context()
      );
      expect(response.details).toMatchObject({
        success: true,
        session_id: `registered-${registration.name}`,
        skill_name: registration.name,
      });
      expect(mockServiceOptions.at(-1)?.playbookName).toBe(registration.name);
      expect(mockServiceOptions.at(-1)?.workerExtensionReplacements).toMatchObject([
        {
          source: memoryExtensionSource,
          extension: {
            name: "memory-worker-read",
            hidden: true,
          },
        },
      ]);
      expect(mockServiceOptions.at(-1)).not.toHaveProperty("workerExtensions");
      expect(mockTypeScriptExecute.mock.calls.at(-1)?.[0].identity.playbook).toBe(
        registration.name
      );
    }
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(genericRegistrations.length);
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

  it("forwards bounded host-operation progress without treating it as a worker boundary", async () => {
    mockTypeScriptExecute.mockImplementationOnce(async (request, _signal, onProgress) => {
      onProgress?.({
        event: "host_operation_progress",
        run_id: request.identity.run_id,
        playbook: "research",
        state_id: "host_operation_fixture",
        operation_id: "fixture-operation",
        operation_kind: "fixture-kind",
        progress: {
          schema_version: 1,
          sequence: 1,
          observed_at: "2026-09-16T00:00:00.000Z",
          progress_class: "poll",
          completed_units: 2,
          total_units: 5,
          detail_code: "fixture-progress",
        },
      });
      return complete(request.identity.run_id, true);
    });
    const updates: ProgressUpdate[] = [];

    await skillTool().execute(
      "host-progress",
      { skill_name: "research", goal: "show host progress", session_id: "host-progress-ts" },
      undefined,
      (update) => updates.push(update),
      context()
    );

    expect(
      updates.some(
        (update) =>
          isSkillProgressDetails(update.details) &&
          update.details.stage === "host_operation_progress" &&
          update.content[0]?.text === "research — host_operation_fixture fixture-kind: poll (2/5)"
      )
    ).toBe(true);
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

  it("projects exhausted feedback separately from the best partial, without promoting failure", async () => {
    const partial = artifactRef("exhausted-ts", "authoring");
    const feedback = artifactRef("exhausted-ts", "verifying");
    const terminal = {
      ...cancelled("exhausted-ts"),
      action: "incomplete",
      status: "incomplete",
      result: {
        met: false,
        output_artifact_ref: partial,
        best_partial_artifact_refs: [partial],
        repair_diagnostics: {
          origin_state: "verifying",
          feedback_kind: "product_gap",
          budget: { used: 2, limit: 2 },
          feedback_report_refs: [feedback],
        },
      },
      unresolved: ["repair budget exhausted at verifying:product_gap"],
    };
    mockTypeScriptExecute.mockResolvedValue(terminal);
    const response = await skillTool().execute(
      "exhausted",
      { skill_name: "research", goal: "review", session_id: "exhausted-ts" },
      undefined,
      undefined,
      {
        ...context(),
        ui: { theme: { fg: (_color: string, text: string) => text }, notify: vi.fn() },
      }
    );
    expect(response.details).toMatchObject({
      success: false,
      state: "incomplete",
      output_artifact_ref: partial,
      best_partial_artifact_refs: [partial],
      repair_diagnostics: { feedback_report_refs: [feedback] },
    });
    expect(response.details.result).toEqual(terminal.result);
    expect(response.content[0]?.text).toContain(feedback.artifact_id);
    expect(response.content[0]?.text).toContain(
      `artifact_read({"artifact":"${feedback.artifact_id}"})`
    );
    expect(response.content[0]?.text).toContain("Repair diagnostics");
    expect(response.content[0]?.text).toContain(
      `Exact output artifact (best partial (acceptance not established)): ${partial.artifact_id}`
    );
  });

  it("projects exact seal evidence in single, parallel, chain and failed-chain resume without reading bodies", async () => {
    const projectionFor = (runId: string) => {
      const draft = { ...artifactRef(runId, "authoring"), kind: "specification-draft" };
      draft.artifact_id = artifactIdFor(draft);
      const diagnostic = { ...artifactRef(runId, "sealing"), kind: "seal-diagnostic" };
      diagnostic.artifact_id = artifactIdFor(diagnostic);
      return {
        latest_diagnostic_ref: diagnostic,
        rejected_draft_ref: draft,
        epoch_anchor_ref: null,
        corrections_used: 1,
        correction_limit: 1,
        disposition: "exhausted",
      };
    };
    mockTypeScriptExecute.mockImplementation(async (request) => {
      const projection = projectionFor(request.identity.run_id);
      return {
        ...cancelled(request.identity.run_id),
        action: "incomplete",
        status: "incomplete",
        result: {
          met: false,
          output_artifact_ref: projection.rejected_draft_ref,
          best_partial_artifact_refs: [projection.rejected_draft_ref],
          output_kind: "rejected_draft_best_partial",
          seal_diagnostics: projection,
        },
        unresolved: [],
      };
    });
    const uiContext = {
      ...context(),
      ui: { theme: { fg: (_color: string, text: string) => text }, notify: vi.fn() },
    };
    const single = await skillTool().execute(
      "single-seal",
      { skill_name: "research", goal: "seal", session_id: "single-seal" },
      undefined,
      undefined,
      uiContext
    );
    const parallel = await skillTool().execute(
      "parallel-seal",
      {
        skills: [
          { skill_name: "research", goal: "seal", session_id: "parallel-seal-one" },
          { skill_name: "research", goal: "seal", session_id: "parallel-seal-two" },
        ],
      },
      undefined,
      undefined,
      uiContext
    );
    const chain = await skillTool().execute(
      "chain-seal",
      {
        chain: [
          { skill_name: "research", goal: "seal", session_id: "chain-seal-one" },
          { skill_name: "research", goal: "must not run", session_id: "chain-seal-two" },
        ],
      },
      undefined,
      undefined,
      uiContext
    );
    const resume = await skillTool().execute(
      "resume-seal",
      { resume_chain: chain.details.chain_session_id },
      undefined,
      undefined,
      uiContext
    );
    for (const [response, runId] of [
      [single, "single-seal"],
      [parallel, "parallel-seal-one"],
      [chain, "chain-seal-one"],
      [resume, "chain-seal-one"],
    ] as const) {
      expect(response.details.success).toBe(false);
      expect(response.content[0]?.text).toContain(
        projectionFor(runId).latest_diagnostic_ref.artifact_id
      );
      expect(response.content[0]?.text).toContain("rejected draft — not an accepted product");
      expect(response.content[0]?.text).not.toContain("Exact output artifact: ");
    }
    expect(parallel.content[0]?.text).toContain(
      projectionFor("parallel-seal-two").latest_diagnostic_ref.artifact_id
    );
    expect(chain.details.output_artifact_ref).toEqual(
      projectionFor("chain-seal-one").rejected_draft_ref
    );
    expect(chain.details.chain_results?.[0]?.seal_diagnostics).toMatchObject(
      projectionFor("chain-seal-one")
    );
    const render = requireDefined(skillTool().renderResult, "skill renderer was not registered");
    for (const [response, id] of [
      [parallel, "parallel-seal-one"],
      [chain, "chain-seal-one"],
    ] as const) {
      const expanded = render(
        {
          content: [{ type: "text", text: response.content[0]?.text ?? "" }],
          details: response.details,
        },
        { expanded: true, isPartial: false },
        renderTheme(),
        {}
      );
      expect(JSON.stringify(expanded)).toContain(
        projectionFor(id).latest_diagnostic_ref.artifact_id
      );
    }
    expect(mockTypeScriptExecute.mock.calls.map(([request]) => request.identity.run_id)).toEqual([
      "single-seal",
      "parallel-seal-one",
      "parallel-seal-two",
      "chain-seal-one",
      "chain-seal-one",
    ]);
    expect(mockReadArtifactOutput).toHaveBeenCalledTimes(5);
    expect(
      mockReadArtifactOutput.mock.calls.every(([input]) => input.ref.kind === "specification-draft")
    ).toBe(true);
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
    expect(serviceOptions.modelOverride).toBe("qwen3.827b:latest");
    expect(serviceEnv.PENNY_RESEARCH_DEFAULT_MODEL).toBe(before);
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
    const feedback = artifactRef("chain-failure-step", "verifying");
    mockTypeScriptExecute.mockImplementationOnce(async (request) => ({
      ...cancelled(request.identity.run_id),
      action: "incomplete",
      status: "incomplete",
      result: {
        ...cancelled(request.identity.run_id).result,
        repair_diagnostics: {
          origin_state: "verifying",
          feedback_kind: "product_gap",
          budget: { used: 1, limit: 1 },
          feedback_report_refs: [feedback],
        },
      },
    }));
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
    expect(response.details.chain_results?.[0]?.repair_diagnostics?.feedback_report_refs).toEqual([
      feedback,
    ]);
    expect(response.content[0]?.text).toContain(feedback.artifact_id);
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
