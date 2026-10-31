// Exercise the same public package initialization used by generic skill ingress.
import "../dist/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { observeNativeCompactionProgress } from "../../../.pi/lib/compaction-policy.mjs";
import type { AgentSessionProgressActivityV1 } from "../dist/model-client.js";
import { DEFAULT_TOOL_RESULT_BUDGET } from "../../../.pi/extensions/lib/tool-result-budget.js";
import { ArtifactRefSchema } from "../dist/contracts.js";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract, type ArtifactRef } from "../dist/contracts.js";
import { ScaHypothesesSchema, ScaSelectionSchema } from "../dist/sca/ordinary-contracts.js";
import { ScaSemanticDiagnosticSchema } from "../dist/sca/ordinary-semantic.js";
import { ScaReportProductSchema, renderScaOrdinaryMarkdown } from "../dist/sca/ordinary-report.js";
import { SCA_PLAYBOOK_REGISTRATION } from "../dist/playbooks/sca.js";
import { describeScaSourceSnapshotV1 } from "../dist/sca/ordinary-source.js";
import { OrchestrationService } from "../dist/service.js";
import type { ScaModelHostOptions } from "../dist/sca/ordinary-model-runtime.js";
import {
  environment,
  fixtureAdapters,
  roots,
  start,
  ScriptedScaClient,
} from "./helpers/sca-local-workflow.js";
import { buildRoutingRepairGuidance, parsePersistedRoutingSummary } from "../dist/worker.js";
import {
  syntheticDisclosure,
  hasCompleteArtifactRead,
  verifyLiveAnalysisInputs,
  SCA_LIVE_LIMITS,
  SCA_ROUTING_REPAIR_SESSION_LIMIT,
  measureLiveReviewClosure,
  assertLiveReviewClosureFits,
} from "../smoke/sca-ordinary-deepseek-fixture.js";
import { createPrivateSessionResourceLoader, type AgentInvocation } from "../dist/model-client.js";
import {
  OrdinaryScaModelGuard,
  assertOrdinaryScaResponseIdentity,
  SCA_REQUIRED_MODEL,
  type OrdinaryScaDisclosurePolicy,
} from "../dist/sca/ordinary-model-guard.js";

const model: Model<"openai-completions"> = {
  id: SCA_REQUIRED_MODEL.model,
  provider: SCA_REQUIRED_MODEL.provider,
  name: "Offline identity fixture",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 4096,
};
const invocation: AgentInvocation = {
  agent: "annie",
  stateId: "selecting_scanner_dependency_leads",
  task: "Synthetic offline guard check",
  projectRoot: process.cwd(),
  trustProfile: "hardened-untrusted",
  inputArtifacts: [],
  modelOverride: SCA_REQUIRED_MODEL.override,
  registration: {
    playbook_name: "sca",
    workflow_name: "sca",
    guidance: { skill_root: ".pi/skills/sca/assets/prompts", resolution: "per_agent_phase" },
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    required_model: SCA_REQUIRED_MODEL,
    allowed_tools: ["artifact_read"],
  },
};
const policy: OrdinaryScaDisclosurePolicy = {
  destination: "http://127.0.0.1:1/v1/chat/completions",
  limits: {
    calls: 1,
    callsPerSession: 1,
    routingRepairSessions: SCA_ROUTING_REPAIR_SESSION_LIMIT,
    inputBytesPerCall: 50000,
    outputTokensPerCall: 512,
    totalOutputTokens: 512,
    totalOutputBytes: 8192,
    inactivityMs: 1000,
  },
  admit(value) {
    if (JSON.stringify(value).includes("PRIVATE_SENTINEL")) throw new Error("Private bytes denied");
  },
  redactError: (text) => text,
};
function offlineResponse(
  responseModel: string,
  input = 10,
  output = 3,
  text = "Offline fixture"
): Response {
  const chunks = [
    {
      id: "offline",
      model: responseModel,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "offline",
      model: responseModel,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } }
  );
}
function toolCallResponse(): Response {
  const model = "deepseek-v4.1-flash";
  const chunks = [
    {
      id: "read",
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "read",
                type: "function",
                function: { name: "artifact_read", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "read", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } }
  );
}
const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// A complete in-memory model/auth fixture, never an overlay on operator settings.
// It still uses the real provider adapter and the observed fetch boundary below.
async function offlineModelRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider(model.provider, {
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: "offline-fixture-only",
    models: [model],
  });
  expect(runtime.getModels(model.provider)).toEqual([model]);
  expect(await runtime.getAvailable(model.provider)).toEqual([model]);
  return runtime;
}
async function sessionFixture(
  manager = SessionManager.inMemory(),
  extension?: InlineExtension,
  readerError?: string
) {
  const resources = await createPrivateSessionResourceLoader({
    projectRoot: process.cwd(),
    systemPrompt: "Synthetic offline model guard test",
  });
  let resourceLoader = resources.resourceLoader;
  if (extension !== undefined) {
    const agentDir = mkdtempSync(path.join(tmpdir(), "sca-summary-hook-"));
    roots.push(agentDir);
    resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager: resources.settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Offline unadmitted hook fixture",
      extensionFactories: [extension],
    });
    await resourceLoader.reload();
  }
  const { session } = await createAgentSession({
    ...resources,
    resourceLoader,
    model,
    modelRuntime: await offlineModelRuntime(),
    cwd: process.cwd(),
    sessionManager: manager,
    tools: ["artifact_read"],
    customTools: [
      {
        name: "artifact_read",
        label: "Exact read",
        description: "Offline tool declaration",
        parameters: Type.Object({}),
        async execute() {
          if (readerError !== undefined) throw new Error(readerError);
          return { content: [], details: undefined };
        },
      },
    ],
  });
  sessions.push(session);
  return session;
}

// A captured closure is an offline size estimate, not proof that its worker read it.
function checkCapturedReviewClosures(evidence: unknown, read: (ref: ArtifactRef) => Uint8Array) {
  const Count = Type.Integer({ minimum: 0 });
  const captured = validateContract(
    Type.Object({
      invocations: Type.Array(
        Type.Object({
          state: Type.String(),
          workflow_session: Type.Object({ worker_id: Type.String({ minLength: 1 }) }),
          inputs: Type.Array(ArtifactRefSchema, { minItems: 1 }),
        })
      ),
      review_closures: Type.Array(
        Type.Object({
          worker_id: Type.String({ minLength: 1 }),
          openingBytes: Count,
          artifactBytes: Count,
          toolMessagesBytes: Count,
          continuationReads: Count,
          batchedCalls: Count,
          batchedInputTokenUpperBound: Count,
          transcriptReserveBytes: Count,
          completeRequestBytes: Count,
        })
      ),
    }),
    evidence,
    "Captured caller review evidence"
  );
  const reviews = captured.invocations.filter((item) =>
    ["reviewing_report", "verifying_final_product"].includes(item.state)
  );
  expect(reviews.length).toBeGreaterThan(0);
  const workers = reviews.map((item) => item.workflow_session.worker_id);
  expect(new Set(workers).size).toBe(workers.length);
  expect(captured.review_closures.map((item) => item.worker_id).sort()).toEqual(workers.sort());
  for (const review of reviews) {
    const recorded = captured.review_closures.find(
      (item) => item.worker_id === review.workflow_session.worker_id
    );
    if (recorded === undefined) throw new Error("Missing exact worker closure");
    const closure = measureLiveReviewClosure({
      openingBytes: recorded.openingBytes,
      refs: review.inputs,
      read,
      toolBudget: DEFAULT_TOOL_RESULT_BUDGET,
    });
    expect(closure.artifactBytes).toBe(
      review.inputs.reduce((sum, ref) => sum + ref.byte_length, 0)
    );
    expect(recorded).toEqual({ worker_id: review.workflow_session.worker_id, ...closure });
    expect(() => assertLiveReviewClosureFits(closure)).not.toThrow();
  }
}

describe("ordinary SCA model/disclosure fence (offline, real SDK sessions)", () => {
  it("does not invent call, turn, output or aggregate allowances when operator policy omits them", async () => {
    const session = await sessionFixture();
    let requests = 0;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      requests += 1;
      return requests < 26
        ? toolCallResponse()
        : offlineResponse("deepseek-v4.1-flash", 10, 3, "Complete beyond old cohort constants");
    });
    const guard = new OrdinaryScaModelGuard({
      ...policy,
      limits: { inactivityMs: 1000 },
    });
    const release = guard.attach(session, invocation);
    try {
      await session.prompt("Continue the admitted offline work, then finish.");
      expect(session.getLastAssistantText()).toBe("Complete beyond old cohort constants");
      expect(network).toHaveBeenCalledTimes(26);
      expect(guard.requests).toHaveLength(26);
      expect(guard.responses).toHaveLength(26);
      expect(guard.denials).toEqual([]);
    } finally {
      release();
    }
  });

  it("refuses an explicit aggregate output policy without a serialized per-request ceiling", async () => {
    const session = await sessionFixture();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not delegate"));
    session.agent.streamFunction = async (_model, _context, options) => {
      if (options?.fetch === undefined) throw new Error("Missing request guard");
      await options.fetch(policy.destination, {
        method: "POST",
        body: JSON.stringify({ model: model.id, stream: true, messages: [] }),
      });
      return createAssistantMessageEventStream();
    };
    const guard = new OrdinaryScaModelGuard({
      ...policy,
      limits: { inactivityMs: 1000, totalOutputTokens: 512 },
    });
    const release = guard.attach(session, invocation);
    try {
      await expect(
        session.agent.streamFunction(model, normalizeContext({ messages: [] }))
      ).rejects.toThrow("aggregate output policy requires a serialized per-request ceiling");
      expect(network).not.toHaveBeenCalled();
      expect(guard.requests).toEqual([]);
    } finally {
      release();
    }
  });
  it.each(["threshold", "overflow"] as const)(
    "runs actual SDK automatic %s compaction, persists its entry, then continues tools and final output",
    async (reason) => {
      const root = mkdtempSync(path.join(tmpdir(), "sca-auto-compaction-"));
      roots.push(root);
      const session = await sessionFixture(SessionManager.create(process.cwd(), root));
      session.settingsManager.applyOverrides({
        compaction: {
          enabled: true,
          reserveTokens: reason === "threshold" ? 65500 : 512,
          keepRecentTokens: 0,
        },
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      });
      const events: string[] = [];
      session.subscribe((event) => {
        if (event.type === "compaction_start" || event.type === "compaction_end")
          events.push(`${event.type}:${event.reason}`);
      });
      let ordinaryCalls = 0;
      let summaryCalls = 0;
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (session.isCompacting) {
          summaryCalls++;
          return offlineResponse(
            "deepseek-v4.1-flash",
            10,
            3,
            "Approved prior work; continue exact reads."
          );
        }
        ordinaryCalls++;
        if (reason === "overflow" && ordinaryCalls === 2)
          return new Response(
            JSON.stringify({ error: { message: "prompt too long; exceeded max context length" } }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        if (ordinaryCalls === 1)
          return offlineResponse("deepseek-v4.1-flash", reason === "threshold" ? 200 : 10);
        if (ordinaryCalls === (reason === "overflow" ? 3 : 2)) return toolCallResponse();
        return offlineResponse("deepseek-v4.1-flash", 10, 3, "FINAL CORRECT OUTPUT");
      });
      const guard = new OrdinaryScaModelGuard({
        ...policy,
        limits: { ...policy.limits, calls: 10, callsPerSession: 10, totalOutputTokens: 5120 },
      });
      const release = guard.attach(session, invocation);
      try {
        await session.prompt("Remember this admitted offline context.");
        await session.prompt("Continue with artifact_read, then finish.");
        expect(session.getLastAssistantText()).toBe("FINAL CORRECT OUTPUT");
        expect(events).toContain(`compaction_start:${reason}`);
        expect(events).toContain(`compaction_end:${reason}`);
        const entries = session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "compaction");
        expect(entries.length).toBeGreaterThan(0);
        const file = session.sessionManager.getSessionFile();
        if (file === undefined) throw new Error("Missing persisted SDK session");
        expect(
          SessionManager.open(file, root)
            .getEntries()
            .filter((entry) => entry.type === "compaction")
        ).toEqual(entries);
        expect(
          entries.every(
            (entry) =>
              entry.fromHook !== true &&
              entry.summary.includes("Approved prior work") &&
              (entry.usage?.output ?? 0) > 0
          ),
          JSON.stringify(entries)
        ).toBe(true);
        expect(entries.reduce((sum, entry) => sum + (entry.usage?.output ?? 0), 0)).toBe(
          summaryCalls * 3
        );
        expect(
          session.sessionManager
            .getEntries()
            .some((entry) => entry.type === "message" && entry.message.role === "toolResult")
        ).toBe(true);
        expect(guard.requests.length).toBe(network.mock.calls.length);
        expect(guard.responses.length).toBe(network.mock.calls.length);
        expect(guard.denials).toEqual([]);
      } finally {
        release();
      }
    }
  );
  it.each(["identity", "bytes", "tokens", "calls", "reserved", "request"] as const)(
    "denies automatic summary %s without persisting unsafe compaction",
    async (mode) => {
      const session = await sessionFixture();
      session.settingsManager.applyOverrides({
        compaction: { enabled: true, reserveTokens: 65500, keepRecentTokens: 0 },
      });
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (!session.isCompacting) return offlineResponse("deepseek-v4.1-flash", 200);
        return offlineResponse(
          mode === "identity" ? "unadmitted-fallback" : "deepseek-v4.1-flash",
          10,
          mode === "tokens" ? 513 : 3,
          mode === "bytes" ? "x".repeat(1000) : "Unsafe summary"
        );
      });
      const guard = new OrdinaryScaModelGuard({
        ...policy,
        limits: {
          ...policy.limits,
          calls: mode === "calls" ? 1 : 3,
          callsPerSession: 3,
          totalOutputTokens: mode === "reserved" ? 512 : 1536,
          totalOutputBytes: mode === "bytes" ? 100 : 8192,
          inputBytesPerCall: mode === "request" ? 1000 : 50000,
        },
      });
      const release = guard.attach(session, invocation);
      await session.prompt("Offline threshold context");
      expect(
        session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")
      ).toHaveLength(0);
      expect(guard.denials.length).toBeGreaterThan(0);
      expect(network.mock.calls.length).toBe(
        ["calls", "reserved", "request"].includes(mode) ? 1 : 2
      );
      if (["identity", "bytes", "tokens"].includes(mode)) expect(release).toThrow();
      else release();
    }
  );
  it("preserves shared result/iterator semantics with one response and no doubled output charge", async () => {
    const session = await sessionFixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      offlineResponse("deepseek-v4.1-flash")
    );
    const guard = new OrdinaryScaModelGuard({
      ...policy,
      limits: { ...policy.limits, totalOutputBytes: Buffer.byteLength("Offline fixture") },
    });
    const release = guard.attach(session, invocation);
    try {
      const stream = await session.agent.streamFunction(
        model,
        normalizeContext({ messages: [{ role: "user", content: "Offline", timestamp: 0 }] })
      );
      const result = await stream.result();
      const events = [];
      for await (const event of stream) events.push(event);
      expect(await stream.result()).toBe(result);
      expect(events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(guard.responses).toHaveLength(1);
      expect(guard.denials).toEqual([]);
    } finally {
      release();
    }
  });
  it.each(["sdk", "invocation"] as const)(
    "combines the %s summary abort signal with the guard signal",
    async (mode) => {
      const session = await sessionFixture();
      session.settingsManager.applyOverrides({
        compaction: { enabled: true, reserveTokens: 65500, keepRecentTokens: 0 },
      });
      const cancel = new AbortController();
      let summarySignal: AbortSignal | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        if (!session.isCompacting) return offlineResponse("deepseek-v4.1-flash", 200);
        const signal = init?.signal;
        if (signal === undefined || signal === null)
          throw new Error("Missing combined summary signal");
        summarySignal = signal;
        const pending = new Promise<Response>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        );
        if (mode === "sdk") session.abortCompaction();
        else cancel.abort(new Error("Invocation cancelled"));
        return pending;
      });
      const guard = new OrdinaryScaModelGuard({
        ...policy,
        limits: { ...policy.limits, calls: 3, callsPerSession: 3, totalOutputTokens: 1536 },
      });
      const release = guard.attach(session, { ...invocation, signal: cancel.signal });
      await session.prompt("Offline threshold cancellation");
      expect(summarySignal?.aborted).toBe(true);
      expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
        false
      );
      release();
    }
  );
  it("renews inactivity from actual summary deltas beyond the inactivity interval", async () => {
    const session = await sessionFixture();
    session.settingsManager.applyOverrides({
      compaction: { enabled: true, reserveTokens: 65500, keepRecentTokens: 0 },
    });
    let summaryElapsed = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (!session.isCompacting) return offlineResponse("deepseek-v4.1-flash", 200);
      const began = Date.now();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 8; i++) {
            await new Promise((resolve) => setTimeout(resolve, 15));
            controller.enqueue(
              Buffer.from(
                `data: ${JSON.stringify({ id: "slow", model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: { role: "assistant", content: "summary " }, finish_reason: null }] })}\n\n`
              )
            );
          }
          controller.enqueue(
            Buffer.from(
              `data: ${JSON.stringify({ id: "slow", model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`
            )
          );
          summaryElapsed += Date.now() - began;
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });
    const guard = new OrdinaryScaModelGuard({
      ...policy,
      limits: {
        ...policy.limits,
        calls: 3,
        callsPerSession: 3,
        totalOutputTokens: 1536,
        inactivityMs: 60,
      },
    });
    const release = guard.attach(session, invocation);
    const activity: AgentSessionProgressActivityV1[] = [];
    const releaseProgress = observeNativeCompactionProgress(session, (progress) =>
      activity.push(progress)
    );
    try {
      await session.prompt("Offline threshold streaming");
      expect(summaryElapsed).toBeGreaterThan(60);
      expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
        true
      );
      expect(guard.denials).toEqual([]);
      expect(activity).toHaveLength(8);
      expect(
        activity.every(
          (event) => event.activity_class === "assistant_text_delta" && event.observed_units > 0
        )
      ).toBe(true);
      expect(guard.responses).toHaveLength(2);
    } finally {
      releaseProgress();
      release();
    }
  });
  it("refuses an explicitly loaded alternate summary hook before any model call", async () => {
    let customCalls = 0;
    const session = await sessionFixture(SessionManager.inMemory(), {
      name: "unadmitted-custom-summary",
      factory(pi) {
        pi.on("session_before_compact", () => {
          customCalls++;
          return {
            compaction: {
              summary: "Unadmitted alternate-model output",
              firstKeptEntryId: "none",
              tokensBefore: 0,
            },
          };
        });
      },
    });
    expect(session.extensionRunner.hasHandlers("session_before_compact")).toBe(true);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not delegate"));
    const guard = new OrdinaryScaModelGuard(policy);
    expect(() => guard.attach(session, invocation)).toThrow(
      "custom summarization hooks are not admitted"
    );
    expect(network).not.toHaveBeenCalled();
    expect(customCalls).toBe(0);
  });
  it("admits a public SDK end(result) stream exactly once without requiring iterator consumption", async () => {
    const session = await sessionFixture();
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      stream.end({
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        responseModel: "deepseek-v4.1-flash",
        content: [{ type: "text", text: "Exact result" }],
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      return stream;
    };
    const guard = new OrdinaryScaModelGuard({
      ...policy,
      limits: { ...policy.limits, totalOutputBytes: Buffer.byteLength("Exact result") },
    });
    const release = guard.attach(session, invocation);
    try {
      const stream = await session.agent.streamFunction(model, normalizeContext({ messages: [] }));
      expect((await stream.result()).content).toEqual([{ type: "text", text: "Exact result" }]);
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events).toEqual([]);
      expect(guard.responses).toHaveLength(1);
      expect(guard.denials).toEqual([]);
    } finally {
      release();
    }
  });
  it("refuses even host-observed rejected reader text before automatic summary flattening", async () => {
    const session = await sessionFixture(
      SessionManager.inMemory(),
      undefined,
      "x".repeat(2500) + "sensitive-raw-error"
    );
    session.settingsManager.applyOverrides({
      compaction: { enabled: true, reserveTokens: 65500, keepRecentTokens: 0 },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    });
    let observedError = false;
    session.subscribe((event) => {
      if (
        event.type === "tool_execution_end" &&
        event.toolName === "artifact_read" &&
        event.isError
      )
        observedError = true;
    });
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (session.isCompacting)
        throw new Error("Rejected output must not reach summarization HTTP");
      return toolCallResponse();
    });
    const guard = new OrdinaryScaModelGuard({
      ...policy,
      limits: { ...policy.limits, calls: 3, callsPerSession: 3, totalOutputTokens: 1536 },
    });
    const release = guard.attach(session, invocation);
    await session.prompt("Read exactly once");
    expect(observedError).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
    expect(
      guard.denials.some((reason) => reason.includes("rejected tool output in compaction source"))
    ).toBe(true);
    expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
      false
    );
    expect(release).toThrow("rejected tool output in compaction source");
  });
  it("keeps every SCA prompt complete, schema-based and terminal without conflicting role reports", () => {
    const worker = SCA_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("ordinary catalog required");
    expect(worker.phases.size).toBe(10);
    for (const [state, phase] of worker.phases) {
      const prompt = readFileSync(
        path.resolve(
          import.meta.dirname,
          `../../../.pi/skills/sca/assets/prompts/${phase.agent}-${state}.md`
        ),
        "utf8"
      );
      expect(prompt).toContain("Return the complete stage artifact as one compact JSON object");
      expect(prompt).toContain("These are the only two output lines");
      if (state === "reviewing_report" || state === "verifying_final_product") {
        expect(prompt).toContain(
          "Put review judgments only in the existing checks and actionable `issues`"
        );
        expect(prompt).toContain("Only the final SUMMARY adds transport `confidence`");
        expect(prompt).toContain("Do not add `confidence` to the stage object");
      } else {
        expect(prompt).toContain("Put all semantic reasoning");
        expect(prompt).toContain(
          "The footer `confidence` field satisfies the role confidence contract"
        );
      }
      expect(prompt).toContain("NOTHING may follow the final SUMMARY line");
      if (state === "reviewing_report" || state === "verifying_final_product") {
        const declared = prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1];
        if (declared === undefined) throw new Error("Closed review schema absent");
        const documented: unknown = JSON.parse(declared);
        const registered: unknown = JSON.parse(JSON.stringify(phase.schema));
        expect(documented).toEqual(registered);
      } else {
        const summary = prompt.trimEnd().split("\n").at(-1);
        if (summary === undefined) throw new Error("prompt example absent");
        expect(parsePersistedRoutingSummary(summary)).toBeDefined();
        expect(parsePersistedRoutingSummary(`${summary}\nConfidence is PROBABLE.`)).toBeUndefined();
      }
    }
  });
  it("discloses exact owner-bound semantic diagnostics and rejected attempts, never unrelated raw cognition", async () => {
    class OneBadQuote extends ScriptedScaClient {
      private rejected = false;
      override output(input: AgentInvocation): unknown {
        const good = super.output(input);
        if (input.stateId !== "forming_hypotheses" || this.rejected) return good;
        this.rejected = true;
        const value = validateContract(ScaHypothesesSchema, good, "Live disclosure mutant");
        const pointer = value.hypotheses[0]?.support[0];
        if (pointer === undefined) throw new Error("Missing quote fixture");
        pointer.exact_quote += " ";
        return value;
      }
    }
    const env = environment();
    const original = start("live-semantic-disclosure");
    const privateExecutable = path.join(tmpdir(), "private-analyzer");
    const privateQuery = path.join(tmpdir(), "private-query.sc");
    const caller = {
      ...original,
      goal: "Assess the caller-selected negative control, not hypothetical consumers.",
      constraints: {
        ...original.constraints,
        analysis_tools: {
          graph: {
            joern: { executable: privateExecutable, sha256: sha256("offline"), version: "test" },
            queries: [{ id: "offline-query", script_path: privateQuery, sha256: sha256("query") }],
          },
        },
      },
    };
    const client = new OneBadQuote();
    using owner = new OrchestrationService({
      projectRoot: caller.project_root,
      env,
      playbookName: "sca",
      modelClient: client,
      hostOperationAdapters: fixtureAdapters(),
    });
    client.bindArtifactReader((id) => owner.artifacts.readById(id).toString("utf8"));
    expect((await owner.execute(caller)).action).toBe("complete");
    expect(new Set(client.invocations.map((input) => input.stateId)).size).toBe(10);
    for (const input of client.invocations) {
      expect(input.task).toContain(
        canonicalJson({
          purpose: caller.goal,
          scope: caller.constraints.scope,
          execution_mode: caller.constraints.execution_mode,
          graph_query_ids: ["offline-query"],
        })
      );
      expect(input.task).not.toContain(privateExecutable);
      expect(input.task).not.toContain(privateQuery);
      expect(input.task).not.toContain(caller.constraints.source_root);
    }
    const revised = client.invocations.find((input) =>
      input.inputArtifacts.some((ref) => ref.kind === "sca-semantic-diagnostic")
    );
    const ref = revised?.inputArtifacts.find((item) => item.kind === "sca-semantic-diagnostic");
    if (revised === undefined || ref === undefined) throw new Error("Missing revision fixture");
    const diagnostic = validateContract(
      ScaSemanticDiagnosticSchema,
      JSON.parse(owner.artifacts.readById(ref.artifact_id).toString("utf8")),
      "Exact live diagnostic"
    );
    const disclosure = syntheticDisclosure({
      root: caller.project_root,
      repository: path.resolve(caller.project_root, "unused-repository"),
      store: owner.artifacts,
    });
    const toolResult = (artifact: ArtifactRef) => {
      const bytes = owner.artifacts.readById(artifact.artifact_id);
      return {
        role: "toolResult",
        content: [
          {
            type: "text",
            text: canonicalJson({
              ok: true,
              artifact_ref: artifact,
              content: bytes.toString("utf8"),
              content_digest: artifact.content_digest,
              returned_range: { start: 0, end: bytes.length },
            }),
          },
        ],
      };
    };
    expect(() => disclosure.admit(toolResult(ref), revised)).not.toThrow();
    expect(hasCompleteArtifactRead(disclosure.reads, revised, ref)).toBe(true);
    disclosure.admit(toolResult(ref), revised);
    disclosure.admit({ messages: [toolResult(ref)] }, revised);
    expect(disclosure.reads).toHaveLength(1); // Revalidation is not another tool execution.
    const originalBytes = owner.artifacts.readById(ref.artifact_id);
    const envelope = {
      ok: true,
      artifact_ref: ref,
      content: originalBytes.toString("utf8"),
      content_digest: ref.content_digest,
      returned_range: { start: 0, end: originalBytes.length },
    };
    for (const mutant of [
      { ...envelope, content: undefined }, // Metadata alone is not a read.
      { ...envelope, content: "x".repeat(originalBytes.length) }, // Equal length is not exact bytes.
      { ...envelope, content: originalBytes.subarray(1).toString("utf8") },
      { ...envelope, artifact_ref: { ...ref, byte_length: ref.byte_length + 1 } },
      { ...envelope, artifact_ref: { ...ref, artifact_id: `art_${"f".repeat(64)}` } },
    ]) {
      expect(() =>
        disclosure.admit({ role: "toolResult", content: canonicalJson(mutant) }, revised)
      ).toThrow();
      expect(disclosure.reads).toHaveLength(1);
    }
    const emptyRead = {
      role: "toolResult",
      content: [
        {
          type: "text",
          text: canonicalJson({
            ok: true,
            artifact_ref: ref,
            content: "",
            content_digest: ref.content_digest,
            returned_range: { start: 0, end: 0 },
          }),
        },
      ],
    };
    expect(() => disclosure.admit(emptyRead, revised)).not.toThrow();
    expect(hasCompleteArtifactRead(disclosure.reads.slice(-1), revised, ref)).toBe(false);
    const read = disclosure.reads[0];
    if (read === undefined) throw new Error("Missing exact-read receipt");
    expect(hasCompleteArtifactRead([{ ...read, start: 1 }], revised, ref)).toBe(false);
    expect(hasCompleteArtifactRead([{ ...read, end: read.end - 1 }], revised, ref)).toBe(false);
    expect(hasCompleteArtifactRead([{ ...read, worker_id: "other-worker" }], revised, ref)).toBe(
      false
    );
    const toolError = {
      content: [
        {
          type: "text",
          text: 'Validation failed for tool "artifact_read": missing artifact argument',
        },
      ],
      isError: true,
    };
    const errorMessage = { role: "toolResult", toolCallId: "bad-read", ...toolError };
    expect(() => disclosure.admit(errorMessage, revised)).toThrow();
    disclosure.observeToolError("bad-read", toolError, revised);
    expect(() => disclosure.admit(errorMessage, revised)).not.toThrow();
    expect(() =>
      disclosure.admit(
        { role: "tool", tool_call_id: "bad-read", content: toolError.content[0]?.text },
        revised
      )
    ).not.toThrow();
    expect(() =>
      disclosure.admit({ ...errorMessage, toolCallId: "another-call" }, revised)
    ).toThrow();
    expect(() =>
      disclosure.admit(errorMessage, { ...revised, stateId: "reviewing_report" })
    ).toThrow();
    const unapprovedPrivateError = {
      content: [{ type: "text", text: "/home/another-operator/private-tool-config" }],
    };
    disclosure.observeToolError("private-error", unapprovedPrivateError, revised);
    expect(() =>
      disclosure.admit(
        { role: "toolResult", toolCallId: "private-error", ...unapprovedPrivateError },
        revised
      )
    ).toThrow();
    const rejected = toolResult(diagnostic.rejected_artifact);
    expect(() => disclosure.admit(rejected, revised)).not.toThrow();
    expect(() =>
      disclosure.admit(rejected, { ...revised, inputArtifacts: [diagnostic.rejected_artifact] })
    ).toThrow("non-admitted artifact");
    expect(() =>
      disclosure.admit(rejected, { ...revised, stateId: "challenging_hypotheses" })
    ).toThrow("non-admitted artifact");
    expect(() =>
      disclosure.admit(rejected, { ...revised, inputArtifacts: [...revised.inputArtifacts, ref] })
    ).toThrow("non-admitted artifact");
    expect(() => disclosure.admit({ secret: "/home/not-the-fixture/private" }, revised)).toThrow(
      "non-fixture host path"
    );
  });
  it("retains stage-time gaps with provenance and references grouped rationales without duplication", async () => {
    const gap = "Selected callee body is pending exact source materialization at selection time.";
    class StageTimeGap extends ScriptedScaClient {
      override output(input: AgentInvocation): unknown {
        const good = super.output(input);
        if (input.stateId !== "selecting_scanner_dependency_leads") return good;
        const value = validateContract(ScaSelectionSchema, good, "Stage-time gap fixture");
        value.gaps.push(gap);
        return value;
      }
    }
    const env = environment();
    const caller = start("retained-stage-time-gaps");
    const client = new StageTimeGap();
    using owner = new OrchestrationService({
      projectRoot: caller.project_root,
      env,
      playbookName: "sca",
      modelClient: client,
      hostOperationAdapters: fixtureAdapters(),
    });
    client.bindArtifactReader((id) => owner.artifacts.readById(id).toString("utf8"));
    expect((await owner.execute(caller)).action).toBe("incomplete");
    const ref = owner.checkpointer
      .loadRunById(caller.identity.run_id)
      ?.selectedArtifacts.find((item) => item.kind === "semantic-core");
    if (ref === undefined) throw new Error("Missing retained-gap product");
    const report = validateContract(
      ScaReportProductSchema,
      JSON.parse(owner.artifacts.readById(ref.artifact_id).toString("utf8")),
      "Retained-gap report"
    );
    const record = `Recorded at selecting_scanner_dependency_leads: ${gap}`;
    expect(report.status).toBe("INCOMPLETE");
    expect(report.gaps.filter((item) => item === record)).toHaveLength(1);
    expect(report.selections[0]?.gaps).toContain(gap);
    const markdown = renderScaOrdinaryMarkdown(report);
    expect(markdown).toContain(`- Limitation record: ${record}`);
    expect(markdown).toContain("not asserted to be current missing evidence");
    expect(markdown).not.toContain(`INCOMPLETE — missing: ${gap}`);
    for (const candidate of report.candidates) {
      const lead = report.preparation.leads.find((item) => item.id === candidate.id);
      if (lead === undefined) throw new Error("Missing candidate lead identity");
      expect(candidate.note).toBe(
        `${lead.title} — see selection rationale: ${candidate.selection_ids.join(", ")}.`
      );
      for (const id of candidate.selection_ids)
        expect(
          report.selections.flatMap((item) => item.selections).some((item) => item.id === id)
        ).toBe(true);
    }
    expect(markdown.match(/Inspect exact caller-bounded initiation and effect/gu)).toHaveLength(2);
    expect(markdown).toContain("Scope filters (as supplied by caller)");
    expect(markdown).toContain("Empty filters do not add files beyond this snapshot.");
    expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
  });
  it("rechecks actual selected native bytes before cache reuse, not just declared pins", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ordinary-cache-pin-"));
    try {
      const executable = path.join(root, "analyzer");
      const script = path.join(root, "query.sc");
      writeFileSync(executable, "synthetic analyzer bytes");
      writeFileSync(script, "synthetic query bytes");
      const tools = {
        graph: {
          joern: { executable, sha256: sha256(readFileSync(executable)), version: "fixture" },
          queries: [{ id: "call", script_path: script, sha256: sha256(readFileSync(script)) }],
        },
      };
      expect(verifyLiveAnalysisInputs(tools)).toHaveLength(2);
      writeFileSync(`${script}.changed`, "drifted query");
      renameSync(`${script}.changed`, script);
      expect(() => verifyLiveAnalysisInputs(tools)).toThrow("bytes drifted");
      writeFileSync(script, "synthetic query bytes");
      writeFileSync(executable, "drifted executable");
      expect(() => verifyLiveAnalysisInputs(tools)).toThrow("bytes drifted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([undefined, SCA_ROUTING_REPAIR_SESSION_LIMIT])(
    "admits only owner-correlated routing repairs with actual session policy %s",
    async (limit) => {
      const session = await sessionFixture();
      const { routingRepairSessions: testPolicy, ...limits } = policy.limits;
      void testPolicy;
      const guard = new OrdinaryScaModelGuard({
        ...policy,
        limits: { ...limits, ...(limit === undefined ? {} : { routingRepairSessions: limit }) },
      });
      expect(() =>
        guard.attach(session, { ...invocation, executionPurpose: "routing_repair" })
      ).toThrow("exact owner source/guidance correlation");
      const repair: AgentInvocation = {
        ...invocation,
        executionPurpose: "routing_repair",
        workflowSession: {
          run_id: "offline",
          workflow_session_id: "offline",
          branch_id: null,
          attempt: 2,
          worker_id: "offline-repair",
          purpose: "routing_repair",
        },
        routingRepairGuidance: buildRoutingRepairGuidance(
          SCA_PLAYBOOK_REGISTRATION,
          invocation.stateId
        ),
        inputArtifacts: [
          {
            schema_version: 2,
            artifact_id: `art_${"0".repeat(64)}`,
            run_id: "offline",
            phase: invocation.stateId,
            branch_id: null,
            kind: "agent-output",
            operation_id: "offline-source",
            version: 1,
            producer: `agent:${invocation.agent}`,
            media_type: "text/plain; charset=utf-8",
            byte_length: 1,
            content_digest: "0".repeat(64),
            store_ref: `artifact://sha256/${"0".repeat(64)}`,
          },
        ],
      };
      for (let index = 0; index < (limit ?? 7); index += 1) {
        const release = guard.attach(session, repair);
        release();
      }
      if (limit !== undefined)
        expect(() => guard.attach(session, repair)).toThrow("routing repair session cap");
      else {
        const release = guard.attach(session, repair);
        release();
        expect(guard.denials).not.toContain("routing repair session cap");
      }
      expect(guard.requests).toEqual([]);
    }
  );
  it.each([
    "missing",
    "wrong-scope",
    "whole-transcript-denial",
    "serialized-payload-denial",
  ] as const)(
    "attaches the production guard on the default service client (%s; no provider delegation)",
    async (mode) => {
      // Own the whole offline catalog: the resolver uses getModels/getAvailable,
      // not getModel alone. Never read or activate an operator-configured provider.
      // Session construction, disclosure attachment and HTTP serialization stay real.
      const metadata = await offlineModelRuntime();
      vi.spyOn(ModelRuntime, "create").mockResolvedValue(metadata);
      const env = { ...environment(), PENNY_SCA_ORDINARY_MODEL_CONFIG: undefined };
      const request = start(`production-guard-${mode}`);
      const checkedTranscripts: unknown[] = [];
      const snapshot = describeScaSourceSnapshotV1({
        source_root: request.constraints.source_root,
        scope: request.constraints.scope,
      });
      const host: ScaModelHostOptions = {
        config: {
          schema_version: 1,
          scope: {
            project_root: request.project_root,
            run_id: mode === "wrong-scope" ? "other-run" : request.identity.run_id,
            source_root: request.constraints.source_root,
            source_snapshot_sha256: snapshot.source_snapshot_sha256,
            purpose: request.goal,
          },
          destination: policy.destination,
          disclose_full_transcript: true,
          limits: policy.limits,
        },
        admit(value) {
          expect(value).toHaveProperty("messages");
          expect(JSON.stringify(value)).toContain("selecting_scanner_dependency_leads");
          checkedTranscripts.push(value);
          if (
            mode === "serialized-payload-denial" &&
            !JSON.stringify(value).includes('"stream":true')
          )
            return;
          throw new Error("PRIVATE_SENTINEL must not be copied to diagnostics");
        },
      };
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("must not delegate"));
      using service = new OrchestrationService({
        projectRoot: request.project_root,
        env,
        playbookName: "sca",
        ...(mode === "missing" ? {} : { scaModel: host }),
        hostOperationAdapters: fixtureAdapters("noalert"),
        enableChildWorkflows: false,
        // SCA owns the installed exact reader; do not inject a second artifact_read provider.
      });
      const terminal = await service.execute(request);
      expect(["incomplete", "cancelled"]).toContain(terminal.action);
      if (terminal.action !== "incomplete" && terminal.action !== "cancelled")
        throw new Error("Production policy refusal was not a durable negative terminal");
      expect(terminal.met).toBe(false);
      expect(network).not.toHaveBeenCalled();
      expect(checkedTranscripts).toHaveLength(
        mode === "whole-transcript-denial" ? 1 : mode === "serialized-payload-denial" ? 2 : 0
      );
      if (mode === "whole-transcript-denial" || mode === "serialized-payload-denial") {
        const context = checkedTranscripts[0];
        expect(context).toHaveProperty("messages", expect.any(Array));
        expect(context).not.toHaveProperty("stream");
      }
      if (mode === "serialized-payload-denial") {
        const payload = validateContract(
          Type.Object(
            {
              model: Type.Literal(SCA_REQUIRED_MODEL.model),
              stream: Type.Literal(true),
              max_tokens: Type.Integer({ minimum: 1 }),
              messages: Type.Array(Type.Unknown(), { minItems: 1 }),
              tools: Type.Array(
                Type.Object(
                  {
                    function: Type.Object({ name: Type.String() }, { additionalProperties: true }),
                  },
                  { additionalProperties: true }
                )
              ),
            },
            { additionalProperties: true }
          ),
          checkedTranscripts[1],
          "Serialized SCA denial fixture"
        );
        expect(payload.max_tokens).toBe(policy.limits.outputTokensPerCall);
        expect(payload.tools.map((tool) => tool.function.name)).toEqual(["artifact_read"]);
      }
      expect(JSON.stringify(terminal)).not.toContain("PRIVATE_SENTINEL");
      const countBeforeRecovery = checkedTranscripts.length;
      const replay = await service.execute({
        schema_version: 2,
        action: "recover",
        identity: request.identity,
      });
      expect(replay).toEqual(terminal);
      expect(checkedTranscripts).toHaveLength(countBeforeRecovery);
      expect(network).not.toHaveBeenCalled();
    }
  );
  it("recognizes the observed Ollama concrete identity but no fallback or other model", () => {
    expect(() =>
      assertOrdinaryScaResponseIdentity({
        provider: "ollama",
        model: SCA_REQUIRED_MODEL.model,
        responseModel: "deepseek-v4.1-flash",
      })
    ).not.toThrow();
    expect(() =>
      assertOrdinaryScaResponseIdentity({
        provider: "ollama",
        model: SCA_REQUIRED_MODEL.model,
        responseModel: "gpt-fallback",
      })
    ).toThrow();
    expect(() =>
      assertOrdinaryScaResponseIdentity({ provider: "openai", model: SCA_REQUIRED_MODEL.model })
    ).toThrow();
    expect(() =>
      assertOrdinaryScaResponseIdentity({ provider: "ollama", model: SCA_REQUIRED_MODEL.model })
    ).toThrow("response model mismatch");
  });
  it("serializes the real SDK's supported Ollama max_tokens ceiling", async () => {
    const session = await sessionFixture();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => offlineResponse("deepseek-v4.1-flash"));
    const guard = new OrdinaryScaModelGuard(policy);
    const release = guard.attach(session, invocation);
    session.setThinkingLevel("off");
    try {
      await session.prompt("Harmless offline serialization check");
      expect(network).toHaveBeenCalledTimes(1);
      const request = network.mock.calls[0]?.[0];
      expect(request).toBeInstanceOf(Request);
      if (!(request instanceof Request)) throw new Error("SDK did not delegate an exact request");
      const body: unknown = await request.clone().json();
      expect(body).toMatchObject({
        model: SCA_REQUIRED_MODEL.model,
        max_tokens: 512,
        reasoning_effort: "none",
      });
      expect(body).not.toHaveProperty("max_completion_tokens");
      expect(guard.denials).toEqual([]);
      expect(guard.responses[0]).toMatchObject({ responseModel: "deepseek-v4.1-flash", output: 3 });
    } finally {
      release();
    }
  });
  it("rejects an unadmitted concrete identity even on the final response", async () => {
    const session = await sessionFixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      offlineResponse("unadmitted-fallback")
    );
    const guard = new OrdinaryScaModelGuard(policy);
    const release = guard.attach(session, invocation);
    await session.prompt("Harmless offline final-identity check");
    expect(guard.denials).toContain("SCA observed provider response model mismatch");
    expect(release).toThrow("response model mismatch");
  });
  it("refuses absent registration identity before provider delegation", async () => {
    const session = await sessionFixture();
    const guard = new OrdinaryScaModelGuard(policy);
    expect(() =>
      guard.attach(session, {
        ...invocation,
        registration: {
          ...invocation.registration,
          playbook_name: "sca",
          workflow_name: "sca",
          guidance: { skill_root: "fixture", resolution: "per_agent_phase" },
          result_transport: "persisted_summary",
          opening_policy: "registration_guidance_task_artifacts",
          model_policy: "directive_override_or_runtime_default",
          required_model: { ...SCA_REQUIRED_MODEL, model: "wrong" },
        },
      })
    ).toThrow();
    expect(guard.requests).toEqual([]);
  });
  it("checks later artifact tool results, not merely the serialized opening", async () => {
    const session = await sessionFixture();
    let delegated = 0;
    session.agent.streamFunction = () => {
      delegated += 1;
      return createAssistantMessageEventStream();
    };
    const guard = new OrdinaryScaModelGuard(policy);
    const release = guard.attach(session, invocation);
    try {
      await session.agent.streamFunction(
        model,
        normalizeContext({
          messages: [{ role: "user", content: "Harmless opening", timestamp: 0 }],
        })
      );
      expect(delegated).toBe(1);
      await expect(
        session.agent.streamFunction(
          model,
          normalizeContext({
            messages: [
              {
                role: "toolResult",
                toolName: "artifact_read",
                toolCallId: "fixture",
                isError: false,
                content: [{ type: "text", text: "PRIVATE_SENTINEL" }],
                timestamp: 0,
              },
            ],
          })
        )
      ).rejects.toThrow("Private bytes denied");
      expect(delegated).toBe(1);
      expect(guard.requests).toEqual([]);
    } finally {
      release();
    }
  });
  it("counts actual HTTP attempts and enforces cap before a second delegate", async () => {
    const session = await sessionFixture();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Offline intentional transport failure"));
    session.agent.streamFunction = async (_model, _context, options) => {
      expect(_model.compat).toMatchObject({ maxTokensField: "max_tokens" });
      expect(options?.maxRetries).toBe(0);
      expect(options?.maxTokens).toBe(512);
      if (options?.fetch === undefined)
        throw new Error("guard omitted actual fetch instrumentation");
      await options.fetch(policy.destination, {
        method: "POST",
        body: JSON.stringify({ model: model.id, stream: true, max_tokens: 512, messages: [] }),
      });
      return createAssistantMessageEventStream();
    };
    const guard = new OrdinaryScaModelGuard(policy);
    const release = guard.attach(session, invocation);
    try {
      await expect(
        session.agent.streamFunction(model, normalizeContext({ messages: [] }))
      ).rejects.toThrow("Offline intentional transport failure");
      await expect(
        session.agent.streamFunction(model, normalizeContext({ messages: [] }))
      ).rejects.toThrow("actual HTTP call cap");
      expect(network).toHaveBeenCalledTimes(1);
      expect(guard.requests).toHaveLength(1);
    } finally {
      release();
    }
  });
  it("fits complete escaped review closure and rejects over-cap closure without tail cuts", () => {
    const bytes = Buffer.from('"\\\\\n—source and counterevidence"'.repeat(1_500));
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${"a".repeat(64)}`,
      run_id: "offline-review",
      phase: "rendering_report",
      branch_id: null,
      kind: "semantic-core",
      operation_id: "fixture",
      version: 1,
      producer: "host:sca-ordinary",
      media_type: "application/json",
      byte_length: bytes.length,
      content_digest: sha256(bytes),
      store_ref: `artifact://sha256/${sha256(bytes)}`,
    };
    const closure = measureLiveReviewClosure({
      openingBytes: 65_536,
      refs: [ref],
      read: () => bytes,
      toolBudget: DEFAULT_TOOL_RESULT_BUDGET,
    });
    expect(closure.artifactBytes).toBe(bytes.length);
    expect(closure.continuationReads).toBeGreaterThan(1);
    expect(closure.toolMessagesBytes).toBeGreaterThan(bytes.length);
    expect(() => assertLiveReviewClosureFits(closure)).not.toThrow();
    expect(() =>
      assertLiveReviewClosureFits({
        ...closure,
        completeRequestBytes: SCA_LIVE_LIMITS.inputBytesPerCall + 1,
      })
    ).toThrow("complete review closure");
    expect(() =>
      measureLiveReviewClosure({
        openingBytes: 1,
        refs: [ref],
        read: () => Buffer.from("different source"),
        toolBudget: DEFAULT_TOOL_RESULT_BUDGET,
      })
    ).toThrow("artifact bytes drift");
  });
  it.each([1, 3, 4])(
    "checks all %i recorded worker closures, not an assumed review count",
    (count) => {
      const bytes = Buffer.from("identical evidence under distinct assigned identities");
      const refs: ArtifactRef[] = ["a", "b"].map((id) => ({
        schema_version: 2,
        artifact_id: `art_${id.repeat(64)}`,
        run_id: "offline-closure",
        phase: "rendering_report",
        branch_id: null,
        kind: "semantic-core",
        operation_id: id,
        version: 1,
        producer: "host:sca-ordinary",
        media_type: "application/json",
        byte_length: bytes.length,
        content_digest: sha256(bytes),
        store_ref: `artifact://sha256/${sha256(bytes)}`,
      }));
      const invocations = Array.from({ length: count }, (_, i) => ({
        state: "reviewing_report",
        workflow_session: { worker_id: `worker-${i}` },
        inputs: refs,
      }));
      const review_closures = invocations.map((item) => ({
        worker_id: item.workflow_session.worker_id,
        ...measureLiveReviewClosure({
          openingBytes: 65_536,
          refs: item.inputs,
          read: () => bytes,
          toolBudget: DEFAULT_TOOL_RESULT_BUDGET,
        }),
      }));
      const captured = { invocations, review_closures };
      const read = vi.fn(() => bytes);
      checkCapturedReviewClosures(captured, read);
      expect(read).toHaveBeenCalledTimes(count * refs.length);
      for (const recorded of review_closures) expect(recorded.artifactBytes).toBe(bytes.length * 2);
      const first = review_closures[0];
      if (first === undefined) throw new Error("Missing closure fixture");
      for (const altered of [
        review_closures.slice(1),
        [...review_closures, first],
        review_closures.map((item, i) =>
          i === 0 ? { ...item, worker_id: "unexpected-worker" } : item
        ),
        review_closures.map((item, i) =>
          i === 0 ? { ...item, artifactBytes: item.artifactBytes - 1 } : item
        ),
        review_closures.map((item, i) =>
          i === 0 ? { ...item, continuationReads: item.continuationReads + 1 } : item
        ),
      ])
        expect(() =>
          checkCapturedReviewClosures({ invocations, review_closures: altered }, read)
        ).toThrow();
      expect(() =>
        checkCapturedReviewClosures({ invocations: [], review_closures: [] }, read)
      ).toThrow();
      expect(() => checkCapturedReviewClosures(captured, () => bytes.subarray(1))).toThrow(
        "bytes drift"
      );
      expect(() => checkCapturedReviewClosures(captured, () => Buffer.alloc(bytes.length))).toThrow(
        "bytes drift"
      );
      expect(() =>
        checkCapturedReviewClosures(
          {
            ...captured,
            invocations: invocations.map((item) => ({ ...item, inputs: item.inputs.slice(1) })),
          },
          read
        )
      ).toThrow();
    }
  );
  it.skipIf(process.env.PENNY_SCA_REVIEW_EVIDENCE_REPORT === undefined)(
    "fits every original caller-supplied recorded review closure offline (not actual worker read coverage)",
    () => {
      const file = process.env.PENNY_SCA_REVIEW_EVIDENCE_REPORT;
      if (file === undefined || !path.isAbsolute(file))
        throw new Error("Exact evidence path required");
      const evidence: unknown = JSON.parse(readFileSync(file, "utf8"));
      checkCapturedReviewClosures(evidence, (ref) =>
        readFileSync(path.join(path.dirname(file), "exact-artifacts", `${ref.artifact_id}.bin`))
      );
    }
  );
  it.each(["request", "output", "calls"] as const)(
    "keeps %s budget exhaustion at zero HTTP with the reallocated live limits",
    async (mode) => {
      const session = await sessionFixture();
      const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("offline"));
      const body = JSON.stringify({
        model: model.id,
        stream: true,
        max_tokens: SCA_LIVE_LIMITS.outputTokensPerCall,
        messages: [{ role: "user", content: "complete evidence" }],
      });
      const bytes = Buffer.byteLength(body);
      const limits = {
        ...SCA_LIVE_LIMITS,
        ...(mode === "calls" ? { calls: 1 } : {}),
        ...(mode === "request" ? { inputBytesPerCall: bytes - 1 } : {}),
        ...(mode === "output"
          ? { totalOutputTokens: SCA_LIVE_LIMITS.outputTokensPerCall - 1 }
          : {}),
      };
      session.agent.streamFunction = async (_model, _context, options) => {
        if (options?.fetch === undefined) throw new Error("Missing pre-provider fence");
        await options.fetch(policy.destination, { method: "POST", body });
        return createAssistantMessageEventStream();
      };
      const guard = new OrdinaryScaModelGuard({ ...policy, limits });
      const release = guard.attach(session, invocation);
      try {
        if (mode === "calls") {
          await session.agent.streamFunction(model, normalizeContext({ messages: [] }));
          expect(network).toHaveBeenCalledTimes(1);
          network.mockClear();
        }
        await expect(
          session.agent.streamFunction(model, normalizeContext({ messages: [] }))
        ).rejects.toThrow(
          mode === "request"
            ? "per-request input byte cap"
            : mode === "output"
              ? "total reserved output tokens"
              : "actual HTTP call cap"
        );
        expect(network).not.toHaveBeenCalled();
      } finally {
        release();
      }
    }
  );
  it("preserves remaining live limits and records input bytes observationally", async () => {
    expect(SCA_LIVE_LIMITS).toMatchObject({
      calls: 96,
      callsPerSession: 24,
      inputBytesPerCall: 512_000,
      outputTokensPerCall: 6144,
      totalOutputTokens: 589824,
      totalOutputBytes: 2359296,
    });
    expect(SCA_LIVE_LIMITS.calls * SCA_LIVE_LIMITS.outputTokensPerCall).toBe(
      SCA_LIVE_LIMITS.totalOutputTokens
    );
    const session = await sessionFixture();
    const body = JSON.stringify({
      model: model.id,
      stream: true,
      max_tokens: 6144,
      messages: [{ role: "user", content: "x".repeat(300_000) }],
    });
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("offline"));
    session.agent.streamFunction = async (_model, _context, options) => {
      if (options?.fetch === undefined) throw new Error("Missing serialized guard");
      await options.fetch(policy.destination, { method: "POST", body });
      return createAssistantMessageEventStream();
    };
    const guard = new OrdinaryScaModelGuard({ ...policy, limits: SCA_LIVE_LIMITS });
    const release = guard.attach(session, invocation);
    try {
      await session.agent.streamFunction(model, normalizeContext({ messages: [] }));
      expect(network).toHaveBeenCalledTimes(1);
      expect(guard.requests[0]?.inputBytes).toBe(Buffer.byteLength(body));
      expect(guard.requests[0]?.inputTokenUpperBound).toBe(Buffer.byteLength(body) + 4096);
    } finally {
      release();
    }
  });
  it("rejects altered serialized identity/output caps before network", async () => {
    const session = await sessionFixture();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not delegate"));
    session.agent.streamFunction = async (_model, _context, options) => {
      if (options?.fetch === undefined) throw new Error("fetch guard absent");
      await options.fetch(policy.destination, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-fallback", stream: true, max_tokens: 2048 }),
      });
      return createAssistantMessageEventStream();
    };
    const guard = new OrdinaryScaModelGuard(policy);
    const release = guard.attach(session, invocation);
    try {
      await expect(
        session.agent.streamFunction(model, normalizeContext({ messages: [] }))
      ).rejects.toThrow("serialized provider identity");
      expect(network).not.toHaveBeenCalled();
      expect(guard.requests).toEqual([]);
    } finally {
      release();
    }
  });
});
