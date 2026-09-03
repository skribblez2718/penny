import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";

import { setGlobalLogTransport } from "../../../../lib/logger/logger.js";
import {
  createTestExtensionApi,
  isRecord,
  requireFunction,
  requireString,
} from "../../../../lib/tests/test-narrowers.js";

type OrchestrationModule = typeof import("@penny/orchestration/source");
type AdmitOperationStartInput = Parameters<OrchestrationModule["admitOperationStart"]>[0];
type CompleteOperationStartInput = Parameters<OrchestrationModule["completeOperationStart"]>[0];
type CheckpointDirectOperationInput = Parameters<
  OrchestrationModule["checkpointDirectOperationResult"]
>[0];
type BuildHostContextInput = Parameters<OrchestrationModule["buildKbHostInvocationContext"]>[0];
type ReplayRunInput = Parameters<OrchestrationModule["replayableResultFromRun"]>[0];
type RunContextCreateInput = Parameters<OrchestrationModule["RunContext"]["create"]>[0];
type ProfileGrantStore = InstanceType<OrchestrationModule["KbSessionProfileGrantStore"]>;
type ConsumeProfileGrantInput = Parameters<ProfileGrantStore["consume"]>[0];
type RequireKbRun = Parameters<OrchestrationModule["requireKbRunAccess"]>[0];
type RequireKbRunExpected = Parameters<OrchestrationModule["requireKbRunAccess"]>[1];
type ExtensionEventHandler = (...args: unknown[]) => unknown;

interface RecoveryRequest {
  action: string;
  identity: { run_id: string; session_id: string };
}

interface MutableDurableRun {
  identity: { run_id: string; session_id: string; playbook: "knowledge-base" };
  constraints: { action: string; kb_profile_id: string };
  playbookData: Record<string, unknown>;
  stateId: string;
  status: string;
  met: boolean;
  terminalDirective: null;
}

const capturedLogs: string[] = [];
setGlobalLogTransport((entry) => capturedLogs.push(entry));

const {
  mockResolveProfile,
  mockLoadRun,
  mockFindGate,
  mockExecute,
  mockReserveOperation,
  mockAdmitRun,
  mockAdmitStart,
  mockRequirePolicy,
  mockCreateResumeWorker,
  mockConsumeProfileGrant,
  mockBuildHostContext,
  mockLoadParentGrant,
  mockReplayRun,
  mockServiceOptions,
} = vi.hoisted(() => ({
  mockResolveProfile: vi.fn<(input: unknown) => unknown>(() => {
    throw new Error("host session identity is unavailable");
  }),
  mockLoadRun: vi.fn(),
  mockFindGate: vi.fn(),
  mockExecute: vi.fn<(request: RecoveryRequest, signal?: AbortSignal) => Promise<unknown>>(),
  mockReserveOperation: vi.fn(() => ({
    group: { request_event_group_id: "opg_resume", state: "reserved" },
  })),
  mockAdmitRun: vi.fn(() => ({ policy_sha256: "a".repeat(64), kb_id: "kb_1" })),
  mockAdmitStart: vi.fn((input: AdmitOperationStartInput) => ({
    run_id: input.context.identity.run_id,
    request_sha256: "c".repeat(64),
    transaction_id: "tx_start_mock",
    group: { request_event_group_id: "opg_start_mock", state: "reserved" },
  })),
  mockRequirePolicy: vi.fn(),
  mockCreateResumeWorker: vi.fn(() => ({ close: vi.fn() })),
  mockConsumeProfileGrant: vi.fn((input: ConsumeProfileGrantInput) => ({
    ...input,
    schema_version: 1,
    grant_id: "kpg_mock",
    grant_sha256: "d".repeat(64),
    consumed_at: "2026-08-21T00:00:00.000Z",
  })),
  mockBuildHostContext: vi.fn((input: BuildHostContextInput) => ({
    schema_version: 1,
    session_id: input.sessionId,
    invocation_id: input.invocationId,
    parent_provider: input.parentIdentity.provider,
    parent_model: input.parentIdentity.model,
    parent_locality: "local",
    allowed_kb_profile_ids: [...input.allowedProfileIds],
    ...(input.parentDeliveryGrant === undefined
      ? {}
      : { parent_delivery_grant: input.parentDeliveryGrant }),
  })),
  mockLoadParentGrant: vi.fn(() => undefined),
  mockReplayRun: vi.fn(({ action, run }: ReplayRunInput) => {
    const status =
      run.status === "awaiting_user"
        ? "awaiting_user"
        : run.status === "complete"
          ? "complete"
          : run.status === "incomplete"
            ? run.playbookData?.public_status === "refused"
              ? "refused"
              : "complete"
            : run.status === "running"
              ? "running"
              : "error";
    const reviewArtifacts =
      status === "awaiting_user" && (action === "ingest" || action === "save")
        ? [
            {
              schema_version: 1,
              artifact_id: "artifact_page",
              artifact_kind: "page_draft",
              sha256: "0".repeat(64),
              media_type: "application/json",
              byte_length: 2,
            },
            {
              schema_version: 1,
              artifact_id: "artifact_lint",
              artifact_kind: "lint_report",
              sha256: "0".repeat(64),
              media_type: "application/json",
              byte_length: 2,
            },
            {
              schema_version: 1,
              artifact_id: "artifact_verify",
              artifact_kind: "verification_report",
              sha256: "0".repeat(64),
              media_type: "application/json",
              byte_length: 2,
            },
          ]
        : [];
    return {
      schema_version: 1,
      action,
      run_id: run.identity.run_id,
      status,
      met: status === "complete" ? run.met === true : false,
      ids: [run.identity.run_id],
      counts: {},
      artifacts: reviewArtifacts,
      evidence: [],
      warnings: [],
      unresolved: [],
      next: status === "running" ? "resume" : status === "awaiting_user" ? "review" : "none",
    };
  }),
  mockServiceOptions: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    withFileMutationQueue: vi.fn((_path: string, operation: () => unknown) => operation()),
  };
});
vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {},
  Spacer: class {},
  Text: class {},
}));
vi.mock("@penny/orchestration/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penny/orchestration/source")>();
  class KbRunAccessError extends Error {}
  class StartAdmissionMismatchError extends Error {}
  class PolicyRefusal extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
    }
  }
  return {
    ...actual,
    OrchestrationService: class {
      config = { maxSteps: 40 };
      checkpointer = {
        loadRunById: mockLoadRun,
        operationEventGroupBySource: vi.fn(),
        operationEventGroup: vi.fn(),
      };
      execute = mockExecute;
      constructor(options: unknown) {
        mockServiceOptions(options);
      }
      close() {}
    },
    RunContext: {
      create: vi.fn((input: RunContextCreateInput) => ({
        identity: input.identity,
        constraints: input.constraints,
        playbookData: {},
      })),
    },
    admitOperationStart: mockAdmitStart,
    completeOperationStart: vi.fn((input: CompleteOperationStartInput) => ({
      replay_result: input.result,
    })),
    checkpointDirectOperationResult: vi.fn((input: CheckpointDirectOperationInput) => input.result),
    OperationReceiptStore: class {
      reserve = mockReserveOperation;
      finish() {
        return { replay_result: {} };
      }
      complete(input: { result: unknown }) {
        return { replay_result: input.result };
      }
    },
    canonicalJson: (value: unknown) => JSON.stringify(value),
    sha256: () => "a".repeat(64),
    externalOperationSourceIdentity: () => "b".repeat(64),
    KbWorkerClient: class {},
    createKbWorkerClientForResume: mockCreateResumeWorker,
    admitKbRun: mockAdmitRun,
    resolvePennyProjectState: vi.fn(() => ({
      paths: {
        knowledgeBase: {
          profiles: "/tmp/penny-test-state/kb/profiles.json",
          hostGrants: "/tmp/penny-test-state/kb/host-grants",
        },
      },
    })),
    resolvePennyRuntimeState: vi.fn(() => ({
      paths: {
        knowledgeBase: {
          profiles: "/tmp/penny-test-state/kb/profiles.json",
          hostGrants: "/tmp/penny-test-state/kb/host-grants",
        },
      },
    })),
    resolveGrantedProfile: mockResolveProfile,
    KbSessionProfileGrantStore: class {
      allowedProfiles() {
        return new Set(["kbp_demo"]);
      }
      useForInvocation() {
        return undefined;
      }
      consume = mockConsumeProfileGrant;
      close() {}
    },
    buildKbHostInvocationContext: mockBuildHostContext,
    loadParentDeliveryGrantForHostContext: mockLoadParentGrant,
    readCurrent: vi.fn(() => ({ generation_id: "gen_1" })),
    readPolicy: vi.fn(() => ({ schema_version: 1, kb_id: "kb_1" })),
    readManifest: vi.fn(() => ({ kb_id: "kb_1" })),
    findGateForRun: mockFindGate,
    invalidateCapabilities: vi.fn(),
    KbRunAccessError,
    StartAdmissionMismatchError,
    requireKbRunAccess: vi.fn((run: RequireKbRun, expected: RequireKbRunExpected) => {
      if (
        run === undefined ||
        run.identity?.run_id !== expected.runId ||
        run.identity?.session_id !== expected.sessionId ||
        run.identity?.playbook !== "knowledge-base" ||
        String(run.playbookData?.profile_id ?? "") !== expected.profileId
      ) {
        throw new KbRunAccessError("run unavailable");
      }
      return run;
    }),
    requireKbCurrentParent: vi.fn(),
    requireKbRunIdentityCurrent: vi.fn(),
    requireKbRunPolicyCurrent: mockRequirePolicy,
    replayableResultFromRun: mockReplayRun,
    toReplayableKnowledgeBaseResult: vi.fn((value: unknown) => value),
    verifyAndSettleTerminalStart: vi.fn(),
    RunArtifactStore: class {
      read() {
        throw new Error("no query artifact in registration tests");
      }
      close() {}
    },
    PrivateInputError: class extends Error {},
    KbWorkerPostureError: class extends Error {
      readonly code = "resume_worker_posture_invalid";
    },
    PolicyRefusal,
  };
});

interface RegisteredTool {
  name: string;
  description: string;
  parameters: Parameters<typeof Value.Check>[0];
  execute: (...args: unknown[]) => Promise<{ details?: unknown }>;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  return object(object(schema)["properties"]);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  capturedLogs.length = 0;
  mockResolveProfile.mockReset().mockImplementation(() => {
    throw new Error("host session identity is unavailable");
  });
  mockLoadRun.mockReset();
  mockFindGate.mockReset();
  mockExecute.mockReset();
  mockReserveOperation.mockClear();
  mockAdmitRun.mockClear();
  mockAdmitStart.mockClear();
  mockRequirePolicy.mockReset();
  mockCreateResumeWorker.mockClear();
  mockConsumeProfileGrant.mockClear();
  mockBuildHostContext.mockClear();
  mockLoadParentGrant.mockClear();
  mockReplayRun.mockClear();
  mockServiceOptions.mockClear();
});

afterAll(() => setGlobalLogTransport(undefined));

function assertPrivateMarkersAbsent(
  label: string,
  value: unknown,
  markers: readonly string[]
): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const [index, marker] of markers.entries()) {
    if (text.includes(marker)) {
      throw new Error(`raw privacy sentinel ${index} escaped into ${label}`);
    }
  }
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    value.parameters !== undefined &&
    typeof value.execute === "function"
  );
}

async function loadTools(
  sessionId?: string,
  handlers: Map<string, ExtensionEventHandler> = new Map()
): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = [];
  const extension = (await import("../../index.js")).default;
  extension(
    createTestExtensionApi({
      onRegisterTool(tool) {
        if (!isRegisteredTool(tool)) throw new Error("skill registered an invalid tool");
        tools.push(tool);
      },
      onEvent(event, handler) {
        const registeredHandler = requireFunction(
          handler,
          `skill registered an invalid ${event} handler`
        );
        handlers.set(event, registeredHandler);
        if (event === "session_start" && sessionId !== undefined) {
          void registeredHandler(
            {},
            {
              sessionManager: { getSessionId: () => sessionId },
              model: { provider: "ollama", id: "qwen3.8:latest" },
            }
          );
        }
      },
    })
  );
  return tools;
}

describe("knowledge_base registration and closed authority surface", () => {
  it("registers exactly one typed knowledge_base alongside skill", async () => {
    const tools = await loadTools();
    expect(tools.filter((tool) => tool.name === "knowledge_base")).toHaveLength(1);
    expect(tools.filter((tool) => tool.name === "skill")).toHaveLength(1);
    const kb = tools.find((tool) => tool.name === "knowledge_base");
    const skill = tools.find((tool) => tool.name === "skill");
    const { KnowledgeBaseRequestSchema } = await import("@penny/orchestration/source");
    expect(kb?.parameters).toBe(KnowledgeBaseRequestSchema);
    expect(skill?.description).toContain("<available_skills>");
    expect(skill?.description).not.toContain("Available skills:");
    const properties = schemaProperties(skill?.parameters);
    expect(properties).toHaveProperty("input_artifacts");
    expect(schemaProperties(object(properties["skills"])["items"])).toHaveProperty(
      "input_artifacts"
    );
    expect(schemaProperties(object(properties["chain"])["items"])).toHaveProperty(
      "input_artifacts"
    );
    expect(object(properties["input_artifacts"])["maxItems"]).toBeUndefined();
  });

  it("wires the native skill instruction replacement into prompt assembly", async () => {
    const handlers = new Map<string, ExtensionEventHandler>();
    await loadTools(undefined, handlers);
    const beforeAgentStart = handlers.get("before_agent_start");
    expect(beforeAgentStart).toBeDefined();
    if (beforeAgentStart === undefined) {
      throw new Error("before_agent_start handler was not registered");
    }

    const result = object(
      beforeAgentStart({
        systemPrompt:
          "Use the read tool to load a skill's file when the task matches its description.",
      })
    );
    const systemPrompt = requireString(result.systemPrompt, "prompt hook omitted systemPrompt");
    expect(systemPrompt).toContain("invoke its registered entrypoint");
    expect(systemPrompt).not.toContain("Use the read tool to load");
  });

  it("accepts the eight closed request variants and rejects authority-shaped extras", async () => {
    const kb = (await loadTools()).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");
    const profile = { schema_version: 1, kb_profile_id: "kbp_demo" };
    const valid = [
      { ...profile, action: "init", create: true, title: "Demo" },
      { ...profile, action: "ingest", source_capability_ids: ["cap_1"] },
      { ...profile, action: "query", query: "what changed?", page_ids: [], source_ids: [] },
      { ...profile, action: "save", query_run_id: "run_1", page_kind: "synthesis", title: "T" },
      { ...profile, action: "lint", mode: "deterministic" },
      {
        ...profile,
        action: "promote",
        page_revisions: [{ page_id: "page_1", revision_id: "rev_1" }],
        canonical_target_capability_ids: ["target_1"],
      },
      { ...profile, action: "status", run_id: "run_1" },
      { ...profile, action: "resume", run_id: "run_1" },
    ];
    for (const request of valid)
      expect(Value.Check(kb.parameters, request), request.action).toBe(true);
    expect(Value.Check(kb.parameters, { ...valid[2], root: "/private" })).toBe(false);
    expect(Value.Check(kb.parameters, { ...valid[5], decision: "approve" })).toBe(false);
    expect(Value.Check(kb.parameters, { ...profile, action: "resume" })).toBe(false);
    expect(
      Value.Check(kb.parameters, { ...profile, action: "query", query: "q", model: "x" })
    ).toBe(false);
    expect(
      Value.Check(kb.parameters, { ...profile, action: "query", query: "q", page_ids: ["a..b"] })
    ).toBe(false);
  });

  it("stamps engine starts with the authenticated Pi session identity", async () => {
    const sessionId = "sess_owner";
    mockResolveProfile.mockReturnValue({
      resolvedRoot: "/tmp/private-kb",
      profile: { kb_profile_id: "kbp_demo", allow_create: false },
    });
    mockExecute.mockResolvedValue({ action: "await_user" });
    mockFindGate.mockReturnValue({ status: "awaiting", artifacts: [] });
    mockLoadRun.mockImplementation((runId: string) => ({
      identity: { run_id: runId, session_id: sessionId, playbook: "knowledge-base" },
      status: "awaiting_user",
      met: false,
      playbookData: { profile_id: "kbp_demo", phases: {} },
    }));
    const kb = (await loadTools(sessionId)).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");
    const controller = new AbortController();
    const result = await kb.execute(
      "call_ingest",
      {
        schema_version: 1,
        action: "ingest",
        kb_profile_id: "kbp_demo",
        source_capability_ids: ["cap_1"],
      },
      controller.signal,
      undefined,
      { cwd: "/tmp/project" }
    );
    expect(result.details).toMatchObject({ status: "awaiting_user" });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0]?.[0]).toMatchObject({
      identity: { session_id: sessionId, playbook: "knowledge-base" },
    });
    expect(mockExecute.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(mockConsumeProfileGrant).toHaveBeenCalledWith({
      session_id: sessionId,
      invocation_id: "call_ingest",
      kb_profile_id: "kbp_demo",
      action: "ingest",
      request_sha256: "a".repeat(64),
      policy_sha256: "a".repeat(64),
    });
    expect(mockBuildHostContext).toHaveBeenCalledTimes(1);
    const builtInput = mockBuildHostContext.mock.calls[0]?.[0];
    if (builtInput === undefined) throw new Error("KB host context input was not captured");
    expect(builtInput.sessionId).toBe(sessionId);
    expect(builtInput.invocationId).toBe("call_ingest");
    expect(builtInput.parentIdentity).toEqual({ provider: "ollama", model: "qwen3.8:latest" });
    expect(builtInput.allowedProfileIds).toEqual(["kbp_demo"]);
    expect(builtInput.request).toMatchObject({ action: "ingest", kb_profile_id: "kbp_demo" });
    expect("root" in builtInput).toBe(false);
    expect("path" in builtInput).toBe(false);
    expect("parent_locality" in builtInput).toBe(false);
  });

  it("binds status and resume to the exact run, active session, and profile", async () => {
    const sessionId = "sess_owner";
    mockResolveProfile.mockReturnValue({
      resolvedRoot: "/tmp/private-kb",
      profile: { kb_profile_id: "kbp_demo", allow_create: false },
    });
    mockLoadRun.mockReturnValue({
      identity: { run_id: "run_exact", session_id: sessionId, playbook: "knowledge-base" },
      playbookData: { profile_id: "kbp_demo" },
      status: "awaiting_user",
      met: false,
    });
    mockFindGate.mockReturnValue({
      run_id: "run_exact",
      status: "awaiting",
      artifacts: [{ artifact_id: "art_1", artifact_kind: "page_draft" }],
    });
    const kb = (await loadTools(sessionId)).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");
    const context = { cwd: "/tmp/project" };
    const status = await kb.execute(
      "call_status",
      { schema_version: 1, action: "status", kb_profile_id: "kbp_demo", run_id: "run_exact" },
      undefined,
      undefined,
      context
    );
    expect(status.details).toMatchObject({
      run_id: "run_exact",
      status: "awaiting_user",
      next: "review",
    });
    expect(mockReserveOperation).not.toHaveBeenCalled();
    const resume = await kb.execute(
      "call_resume",
      { schema_version: 1, action: "resume", kb_profile_id: "kbp_demo", run_id: "run_exact" },
      undefined,
      undefined,
      context
    );
    expect(resume.details).toMatchObject({
      run_id: "run_exact",
      status: "awaiting_user",
      next: "review",
    });
    expect(mockReserveOperation).toHaveBeenCalledTimes(1);
    expect(mockFindGate).toHaveBeenCalledWith("/tmp/private-kb", "run_exact");

    mockLoadRun.mockReturnValue({
      identity: { run_id: "run_exact", session_id: "sess_other", playbook: "knowledge-base" },
      playbookData: { profile_id: "kbp_demo" },
      status: "awaiting_user",
      met: false,
    });
    const refused = await kb.execute(
      "call_cross_session",
      { schema_version: 1, action: "resume", kb_profile_id: "kbp_demo", run_id: "run_exact" },
      undefined,
      undefined,
      context
    );
    expect(refused.details).toMatchObject({
      status: "refused",
      warnings: ["run_not_available_for_session_profile"],
    });
    expect(mockReserveOperation).toHaveBeenCalledTimes(1);

    mockLoadRun.mockReturnValue({
      identity: { run_id: "run_exact", session_id: sessionId, playbook: "knowledge-base" },
      playbookData: { profile_id: "kbp_demo" },
      status: "running",
      met: false,
    });
    const { PolicyRefusal } = await import("@penny/orchestration/source");
    const policyError = new PolicyRefusal("policy_changed", "policy changed");
    mockRequirePolicy.mockImplementationOnce(() => {
      throw policyError;
    });
    const policyRefused = await kb.execute(
      "call_policy_refused",
      { schema_version: 1, action: "resume", kb_profile_id: "kbp_demo", run_id: "run_exact" },
      undefined,
      undefined,
      context
    );
    expect(policyRefused.details).toMatchObject({
      status: "refused",
      warnings: ["policy_changed"],
    });
    expect(mockReserveOperation).toHaveBeenCalledTimes(1);
  });

  it("recovers each running KB worker posture through the engine and maps the next boundary", async () => {
    const sessionId = "sess_owner";
    mockResolveProfile.mockReturnValue({
      resolvedRoot: "/tmp/private-kb",
      profile: { kb_profile_id: "kbp_demo", allow_create: false },
    });
    mockFindGate.mockReturnValue({
      status: "awaiting",
      artifacts: [{ artifact_id: "art_review", artifact_kind: "page_draft" }],
    });
    const kb = (await loadTools(sessionId)).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");

    const outcomes = [
      { action: "ingest", status: "awaiting_user", met: false, expected: "awaiting_user" },
      { action: "query", status: "incomplete", met: false, expected: "error" },
      { action: "save", status: "complete", met: true, expected: "complete" },
      { action: "promote", status: "error", met: false, expected: "error" },
    ] as const;
    for (const outcome of outcomes) {
      const runId = `run_${outcome.action}_recover`;
      const durable: MutableDurableRun = {
        identity: { run_id: runId, session_id: sessionId, playbook: "knowledge-base" },
        constraints: { action: outcome.action, kb_profile_id: "kbp_demo" },
        playbookData: {
          action: outcome.action,
          profile_id: "kbp_demo",
          kb_id: "kb_1",
          admitted_policy_sha256: "a".repeat(64),
          ...(outcome.action === "query" ? { public_status: "complete" } : {}),
        },
        stateId: outcome.action === "query" ? "query" : "compose",
        status: "running",
        met: false,
        terminalDirective: null,
      };
      mockLoadRun.mockImplementation(() => durable);
      mockExecute.mockImplementationOnce(async (request) => {
        expect(request).toMatchObject({
          action: "recover",
          identity: { run_id: runId, session_id: sessionId },
        });
        durable.status = outcome.status;
        durable.met = outcome.met;
        return { action: outcome.status === "awaiting_user" ? "await_user" : outcome.status };
      });

      const result = await kb.execute(
        `call_${outcome.action}_recover`,
        { schema_version: 1, action: "resume", kb_profile_id: "kbp_demo", run_id: runId },
        undefined,
        undefined,
        { cwd: "/tmp/project" }
      );
      expect(result.details).toMatchObject({
        action: "resume",
        run_id: runId,
        status: outcome.expected,
        met: outcome.expected === "complete" ? outcome.met : false,
        next: outcome.expected === "awaiting_user" ? "review" : "none",
        ...(outcome.action === "query"
          ? { artifacts: [], warnings: ["required_query_answer_corrupt"] }
          : {}),
      });
      expect(mockCreateResumeWorker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectRoot: path.resolve(process.env.PROJECT_ROOT || "/tmp/project"),
          kbRoot: "/tmp/private-kb",
          run: durable,
        })
      );
      const serviceOptions: unknown = mockServiceOptions.mock.calls.at(-1)?.[0];
      if (!isRecord(serviceOptions))
        throw new Error("orchestration service options were not captured");
      expect(serviceOptions.playbookName).toBe("knowledge-base");
      expect(isRecord(serviceOptions.modelClient)).toBe(true);
    }
    expect(mockCreateResumeWorker).toHaveBeenCalledTimes(outcomes.length);
    expect(mockReserveOperation).toHaveBeenCalledTimes(outcomes.length);
  });

  it("does not admit or receipt a policy-refused start", async () => {
    const sessionId = "sess_owner";
    mockResolveProfile.mockReturnValue({
      resolvedRoot: "/tmp/private-kb",
      profile: { kb_profile_id: "kbp_demo", allow_create: false },
    });
    mockAdmitRun.mockImplementationOnce(() => {
      throw new Error("policy denied");
    });
    const kb = (await loadTools(sessionId)).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");
    const result = await kb.execute(
      "call_ingest_policy_refused",
      {
        schema_version: 1,
        action: "ingest",
        kb_profile_id: "kbp_demo",
        source_capability_ids: ["cap_1"],
      },
      undefined,
      undefined,
      { cwd: "/tmp/project" }
    );
    expect(result.details).toMatchObject({
      status: "refused",
      warnings: ["ingest_admission_refused"],
    });
    expect(mockAdmitStart).not.toHaveBeenCalled();
  });

  it("keeps raw source/claim/page/query/report/patch bytes out of adapter logs, failures, and details", async () => {
    const markers = ["SOURCE", "CLAIM", "PAGE", "QUERY", "REPORT", "PATCH"].map((kind, index) =>
      ["RAW", kind, "SENTINEL", "ADAPTER", String(index), String(Date.now())].join("_")
    );
    const sessionId = "sess_privacy_adapter";
    const kb = (await loadTools(sessionId)).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");

    mockResolveProfile.mockImplementationOnce(() => {
      throw new Error(markers.join("|"));
    });
    const profileFailure = await kb.execute(
      "call_privacy_profile_failure",
      { schema_version: 1, action: "status", kb_profile_id: "kbp_demo", run_id: "run_1" },
      undefined,
      undefined,
      { cwd: "/tmp/project" }
    );

    mockResolveProfile.mockReturnValue({
      resolvedRoot: "/tmp/private-kb",
      profile: { kb_profile_id: "kbp_demo", allow_create: false },
    });
    mockExecute.mockRejectedValueOnce(new Error(markers.join("|")));
    const workflowFailure = await kb.execute(
      "call_privacy_ingest_failure",
      {
        schema_version: 1,
        action: "ingest",
        kb_profile_id: "kbp_demo",
        source_capability_ids: ["cap_safe"],
      },
      undefined,
      undefined,
      { cwd: "/tmp/project" }
    );

    assertPrivateMarkersAbsent("profile failure tool result", profileFailure, markers);
    assertPrivateMarkersAbsent("workflow failure tool result", workflowFailure, markers);
    assertPrivateMarkersAbsent("adapter structured log transport", capturedLogs, markers);
    expect(profileFailure.details).toMatchObject({ warnings: ["profile_not_authorized"] });
    expect(workflowFailure.details).toMatchObject({ warnings: ["ingest_run_failed"] });
  });

  it("fails closed before filesystem access when no authenticated session grant exists", async () => {
    const kb = (await loadTools()).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");
    const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-kb-tool-"));
    roots.push(projectRoot);
    const prior = process.env.PROJECT_ROOT;
    delete process.env.PROJECT_ROOT;
    try {
      const result = await kb.execute(
        "call_1",
        { schema_version: 1, action: "status", kb_profile_id: "kbp_demo", run_id: "run_1" },
        undefined,
        undefined,
        { cwd: projectRoot }
      );
      expect(result.details).toMatchObject({
        status: "refused",
        warnings: ["profile_not_authorized"],
      });
    } finally {
      if (prior === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = prior;
    }
  });
});
