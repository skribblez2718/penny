import { ScaHypothesesSchema } from "../dist/sca/ordinary-contracts.js";
/** Production service composition, real Pi SDK and serialized adapter; offline HTTP responses only. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Model,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { OrchestrationService } from "../dist/service.js";
import { SCA_REQUIRED_MODEL } from "../dist/sca/ordinary-model-guard.js";
import {
  createScaModelSessionRuntime,
  loadScaModelHost,
  parseScaModelDisclosureConfig,
  ScaModelDisclosureConfigSchema,
  type ScaModelDisclosureConfig,
} from "../dist/sca/ordinary-model-runtime.js";
import type { AgentInvocation, PiAgentClientOptions } from "../dist/model-client.js";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describeScaSourceSnapshotV1 } from "../dist/sca/ordinary-source.js";
import { validateScaRequestV1 } from "../dist/skill-contracts/sca-request.js";
import {
  environment,
  roots,
  PROJECT_ROOT,
  start,
  fixtureAdapters,
  ScriptedScaClient,
} from "./helpers/sca-local-workflow.js";

import { createPrivateSessionResourceLoader } from "../dist/model-client.js";
import { AdvancedScriptedClient } from "./helpers/sca-advanced-workflow.js";
import { configuredOfflineFixture } from "./helpers/sca-configured-offline.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { SCA_LIVE_LIMITS } from "../smoke/sca-ordinary-deepseek-fixture.js";
import { ScaAdvancedPrivateSchema } from "../dist/sca/ordinary-advanced-host.js";
import { validateContract } from "../dist/contracts.js";
import { writeFileSync } from "node:fs";
import path from "node:path";

const model: Model<"openai-completions"> = {
  id: SCA_REQUIRED_MODEL.model,
  provider: SCA_REQUIRED_MODEL.provider,
  name: "Offline production composition",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 8192,
};
let currentInvocation: AgentInvocation | undefined;
let capturedRuntime: PiAgentClientOptions["sessionRuntime"];
vi.mock("../dist/model-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dist/model-client.js")>();
  return {
    ...actual,
    PiAgentClient: class extends actual.PiAgentClient {
      constructor(options: PiAgentClientOptions = {}) {
        capturedRuntime = options.sessionRuntime;
        super({ ...options, resolveModel: () => model }); // Substitute identity resolution, not guard/composition.
      }
      override runAgent(invocation: AgentInvocation) {
        currentInvocation = invocation;
        return super.runAgent(invocation);
      }
    },
  };
});
// Configure only this session's offline provider; retain the actual SDK, serializer and guard.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    async createAgentSession(options: Parameters<typeof actual.createAgentSession>[0]) {
      if (
        options?.model?.provider !== model.provider ||
        options.model.id !== model.id ||
        options.model.baseUrl !== model.baseUrl
      )
        throw new Error("Unexpected offline SDK model");
      const result = await actual.createAgentSession(options);
      result.session.modelRuntime.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        apiKey: "synthetic-offline-sca-not-a-credential",
        models: [model],
      });
      return result;
    },
  };
});
const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  currentInvocation = undefined;
  capturedRuntime = undefined;
});
function configFor(runId: string): ScaModelDisclosureConfig {
  const request = start(runId);
  return {
    schema_version: 1,
    scope: {
      project_root: PROJECT_ROOT,
      run_id: runId,
      source_root: request.constraints.source_root,
      source_snapshot_sha256: describeScaSourceSnapshotV1({
        source_root: request.constraints.source_root,
        scope: request.constraints.scope,
      }).source_snapshot_sha256,
      purpose: request.goal,
    },
    destination: `${model.baseUrl}/chat/completions`,
    disclose_full_transcript: true,
    limits: {
      calls: 20,
      callsPerSession: 4,
      routingRepairSessions: 1,
      inputBytesPerCall: 250000,

      outputTokensPerCall: 6144,
      totalOutputTokens: 122880,
      totalOutputBytes: 1048576,
      inactivityMs: 30000,
    },
  };
}
function response(text: string): Response {
  const chunks = [
    {
      id: "offline",
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "offline",
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    },
  ];
  return new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } }
  );
}
function toolResponse(id: string, args: unknown): Response {
  const delta = {
    id: "reader",
    model: "deepseek-v4.1-flash",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: {
                name: "artifact_read",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const end = {
    id: "reader",
    model: "deepseek-v4.1-flash",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  return new Response(
    `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } }
  );
}
// Use the service-owned installed exact reader, including in policy-refusal fixtures.

describe("ordinary default service model disclosure composition", () => {
  it("requires exact consent and inactivity policy without inventing optional count/output limits", () => {
    environment();
    const config = configFor("operator-policy");
    const noCountPolicy = { ...config, limits: { inactivityMs: 30000 } };
    expect(parseScaModelDisclosureConfig(noCountPolicy)).toEqual(noCountPolicy);
    for (const limits of [
      {},
      { inactivityMs: 0 },
      { inactivityMs: 30000, calls: 0 },
      { inactivityMs: 30000, callsPerSession: -1 },
      { inactivityMs: 30000, routingRepairSessions: Infinity },
      { inactivityMs: 30000, totalOutputTokens: "512" },
      { inactivityMs: 30000, unknown: 1 },
    ])
      expect(() => parseScaModelDisclosureConfig({ ...config, limits })).toThrow();
    expect(() =>
      parseScaModelDisclosureConfig({ ...noCountPolicy, disclose_full_transcript: false })
    ).toThrow();
  });
  it.each([undefined, 1, 8000000])(
    "normalizes env and embedded host input identically without rewriting legacy %s",
    (legacy) => {
      environment();
      const config = configFor("legacy-host");
      const host = {
        ...config,
        limits: { ...config.limits, ...(legacy === undefined ? {} : { totalInputTokens: legacy }) },
      };
      const root = mkdtempSync(path.join(tmpdir(), "sca-host-input-"));
      roots.push(root);
      const file = path.join(root, "host.json"),
        bytes = canonicalJson(host);
      writeFileSync(file, bytes);
      const parsed = parseScaModelDisclosureConfig(host);
      expect(parsed).toEqual(config);
      expect(parsed.limits).not.toHaveProperty("totalInputTokens");
      expect(loadScaModelHost({ PENNY_SCA_ORDINARY_MODEL_CONFIG: file })?.config).toEqual(parsed);
      expect(readFileSync(file, "utf8")).toBe(bytes);
      expect(() =>
        validateContract(ScaModelDisclosureConfigSchema, parsed, "Canonical current config")
      ).not.toThrow();
      const runtime = createScaModelSessionRuntime({
        projectRoot: PROJECT_ROOT,
        host: { config: host },
        requestForRun: () => undefined,
      });
      expect(runtime.settingsManager.getCompactionEnabled()).toBe(true);
      for (const limits of [
        { ...host.limits, unknown: 1 },
        { ...host.limits, totalInputTokens: 0 },
        { ...host.limits, totalInputTokens: "1" },
        { ...host.limits, calls: Infinity },
        { ...host.limits, outputTokensPerCall: -1 },
      ])
        expect(() => parseScaModelDisclosureConfig({ ...host, limits })).toThrow();
      expect(() => parseScaModelDisclosureConfig({ ...host, unknown: true })).toThrow();
    }
  );

  it.each(["unconfigured", "purpose", "snapshot", "run", "source", "project"] as const)(
    "denies %s consent before any HTTP request and keeps terminal recovery closed",
    async (mode) => {
      const env = environment(),
        runId = `model-${mode}`,
        config = configFor(runId);
      if (mode === "purpose") config.scope.purpose += " changed";
      if (mode === "snapshot") config.scope.source_snapshot_sha256 = "0".repeat(64);
      if (mode === "run") config.scope.run_id += "-other";
      if (mode === "source") config.scope.source_root += "/other";
      if (mode === "project") config.scope.project_root += "/other";
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("must not delegate"));
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        playbookName: "sca",
        env,
        hostOperationAdapters: fixtureAdapters("noalert"),
        ...(mode === "unconfigured" ? {} : { scaModel: { config } }),
      });
      const terminal = await service.execute(start(runId));
      expect(terminal.action).toBe("cancelled");
      expect(capturedRuntime).toBeDefined();
      expect(network).not.toHaveBeenCalled();
      expect(
        await service.execute({
          schema_version: 2,
          action: "recover",
          identity: start(runId).identity,
        })
      ).toEqual(terminal);
      expect(network).not.toHaveBeenCalled();
      expect(
        service.checkpointer
          .loadRunById(runId)
          ?.selectedArtifacts.some((r) => r.kind === "model-dispatch-guard")
      ).toBe(false);
    }
  );
  it.each([undefined, 1, 8000000])(
    "finishes ten real SDK serialized calls across attachments with legacy input limit %s ignored",
    async (legacy) => {
      const env = environment(),
        runId = "model-default-configured",
        base = configFor(runId),
        config = {
          ...base,
          limits: { ...base.limits, ...(legacy === undefined ? {} : { totalInputTokens: legacy }) },
        },
        fixture = new ScriptedScaClient("noalert");
      const admissions: unknown[] = [];
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (currentInvocation === undefined) throw new Error("Missing SDK invocation");
        // Script the content only; never invoke the fixture's model-boundary hooks twice.
        return response(
          `SUMMARY:${JSON.stringify({ ...object(fixture.output(currentInvocation)), confidence: "PROBABLE" })}`
        );
      });
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        playbookName: "sca",
        env,
        hostOperationAdapters: fixtureAdapters("noalert"),
        scaModel: {
          config,
          admit(value) {
            admissions.push(value);
          },
        },
      });
      fixture.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action).toBe("complete");
      expect(network).toHaveBeenCalledTimes(10);
      const requestBytes = await Promise.all(
        network.mock.calls.map(async ([request]) => {
          if (!(request instanceof Request)) throw new Error("Missing real serialized request");
          return Buffer.byteLength(await request.clone().text()) + 4096;
        })
      );
      expect(requestBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(1);
      expect(admissions).toHaveLength(20); // Full normalized context and exact HTTP JSON each call.
      for (const call of network.mock.calls) {
        const request = call[0];
        if (!(request instanceof Request)) throw new Error("No serialized SDK request");
        expect(request.url).toBe(config.destination);
        const body: unknown = await request.clone().json();
        expect(body).toMatchObject({
          model: SCA_REQUIRED_MODEL.model,
          max_tokens: config.limits.outputTokensPerCall,
        });
      }
    },
    120000
  );
  it.each([false, true])(
    "registers the real default exact reader and guards host-observed SDK errors (malformed first=%s)",
    async (malformedFirst) => {
      const env = environment(),
        runId = `model-default-artifact-reader-${malformedFirst}`,
        config = configFor(runId),
        fixture = new ScriptedScaClient("noalert");
      let readId: string | undefined;
      let errorRequested = false;
      let errorObserved = false;
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
        if (currentInvocation === undefined || !(request instanceof Request))
          throw new Error("Missing default SDK request");
        const body: unknown = await request.clone().json();
        if (malformedFirst && !errorRequested) {
          errorRequested = true;
          return toolResponse("invalid-read", {
            artifact_id: currentInvocation.inputArtifacts[0]?.artifact_id,
          });
        }
        if (malformedFirst && readId === undefined) {
          expect(JSON.stringify(body)).toContain("Validation failed for tool");
          expect(JSON.stringify(body)).toContain("invalid-read");
          errorObserved = true;
        }
        if (readId === undefined) {
          const ref = currentInvocation.inputArtifacts[0];
          if (ref === undefined) throw new Error("Missing actual input");
          readId = ref.artifact_id;
          return toolResponse("read-current", { artifact: readId });
        }
        if (currentInvocation.stateId === "selecting_scanner_dependency_leads") {
          const messages = object(body).messages;
          if (!Array.isArray(messages)) throw new Error("Missing SDK messages");
          expect(messages.some((message: unknown) => object(message).role === "tool")).toBe(true);
          expect(JSON.stringify(body)).toContain(readId);
          expect(JSON.stringify(body)).toContain("artifact_read");
          expect(JSON.stringify(body)).toContain("sca-preparation-result");
        }
        return response(
          `SUMMARY:${JSON.stringify({ ...object(fixture.output(currentInvocation)), confidence: "PROBABLE" })}`
        );
      });
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        playbookName: "sca",
        env,
        hostOperationAdapters: fixtureAdapters("noalert"),
        scaModel: { config },
      });
      fixture.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action, JSON.stringify(terminal)).toBe("complete");
      expect(network).toHaveBeenCalledTimes(malformedFirst ? 12 : 11);
      expect(errorObserved).toBe(malformedFirst);
      expect(readId).toMatch(/^art_[a-f0-9]{64}$/u);
      expect(capturedRuntime?.noAmbientExtensions).toBe(true);
    },
    120000
  );
  it.each([10, 11])(
    "keeps semantic revisions on the default guarded path within an exact %s-call host budget",
    async (maxCalls) => {
      class OneBadQuote extends ScriptedScaClient {
        private rejected = false;
        override output(invocation: AgentInvocation): unknown {
          const good = super.output(invocation);
          if (invocation.stateId !== "forming_hypotheses" || this.rejected) return good;
          this.rejected = true;
          const value = validateContract(ScaHypothesesSchema, good, "Exact quote fixture"),
            p = value.hypotheses[0]?.support[0];
          if (p === undefined) throw new Error("Missing hypothesis quote");
          p.exact_quote += " ";
          return value;
        }
      }
      const env = environment(),
        runId = `model-semantic-revision-${maxCalls}`,
        configured = configFor(runId),
        config = { ...configured, limits: { ...configured.limits, calls: maxCalls } },
        fixture = new OneBadQuote("noalert");
      const visits: AgentInvocation[] = [];
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
        if (currentInvocation === undefined || !(request instanceof Request))
          throw new Error("Missing guarded request");
        if (currentInvocation.stateId === "forming_hypotheses") visits.push(currentInvocation);
        return response(
          `SUMMARY:${JSON.stringify({ ...object(fixture.output(currentInvocation)), confidence: "PROBABLE" })}`
        );
      });
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "sca",
        hostOperationAdapters: fixtureAdapters("noalert"),
        scaModel: { config },
      });
      fixture.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action, JSON.stringify(terminal)).toBe(
        maxCalls === 11 ? "complete" : "cancelled"
      );
      expect(network).toHaveBeenCalledTimes(maxCalls);
      expect(visits).toHaveLength(2);
      const first = visits[0],
        second = visits[1];
      if (first === undefined || second === undefined) throw new Error("Missing guarded revision");
      expect(second.registration?.required_model).toEqual(first.registration?.required_model);
      expect(second.task).toContain("SAME-STAGE semantic revision");
      expect(second.inputArtifacts.slice(0, first.inputArtifacts.length)).toEqual(
        first.inputArtifacts
      );
      expect(second.inputArtifacts.at(-1)?.kind).toBe("sca-semantic-diagnostic");
      expect(capturedRuntime?.noAmbientExtensions).toBe(true);
      expect(second.guardModelDispatch).toBeTypeOf("function");
      if (maxCalls === 10) {
        const product = service.checkpointer
          .loadRunById(runId)
          ?.selectedArtifacts.find((x) => x.kind === "semantic-core");
        if (product === undefined) throw new Error("Missing budget-limited partial report");
        expect(
          object(JSON.parse(service.artifacts.readById(product.artifact_id).toString("utf8")))
            .status
        ).toBe("INCOMPLETE");
        expect(
          await service.execute({
            schema_version: 2,
            action: "recover",
            identity: start(runId).identity,
          })
        ).toEqual(terminal);
        expect(network).toHaveBeenCalledTimes(10);
      }
    },
    120000
  );
  it("composes both normal env configs: default real SDK guard plus installed native empirical runner", async () => {
    const env = environment(),
      offline = configuredOfflineFixture(),
      runId = "model-native-configured",
      config = configFor(runId),
      fixture = new AdvancedScriptedClient(false);
    const modelConfig = path.join(offline.root, "model-host.json"),
      offlineConfig = path.join(offline.root, "offline-host.json");
    writeFileSync(modelConfig, canonicalJson(config), { mode: 0o600 });
    writeFileSync(offlineConfig, canonicalJson(offline.runnerConfig), { mode: 0o600 });
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (currentInvocation === undefined) throw new Error("Missing SDK invocation");
      return response(
        `SUMMARY:${JSON.stringify({ ...object(fixture.output(currentInvocation)), confidence: "PROBABLE" })}`
      );
    });
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      playbookName: "sca",
      env: {
        ...env,
        PENNY_SCA_ORDINARY_MODEL_CONFIG: modelConfig,
        PENNY_SCA_ORDINARY_OFFLINE_CONFIG: offlineConfig,
      },
      hostOperationAdapters: fixtureAdapters("noalert"),
    });
    fixture.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
    const request = start(runId);
    const terminal = await service.execute({
      ...request,
      constraints: {
        ...request.constraints,
        execution_mode: "propose_stronger_evidence",
        advanced: { ...offline.advanced, application_tests: [] },
      },
    });
    expect(terminal.action).toBe("incomplete");
    expect(network).toHaveBeenCalledTimes(10);
    const calls = service.checkpointer.hostOperationCallsForRun(runId);
    expect(calls.map((r) => r.operation_kind)).toEqual([
      "sca.preparation.v1",
      "sca.evidence.v1",
      "sca.validation.v1",
      "sca.promotion.v1",
      "sca.rescan.v1",
    ]);
    expect(calls.every((r) => r.lifecycle === "consumed")).toBe(true);
    const ref = calls.find((r) => r.operation_kind === "sca.validation.v1")?.operation_result_ref;
    if (ref === undefined || ref === null)
      throw new Error("Missing exact native validation result");
    const saved = validateContract(
      ScaAdvancedPrivateSchema,
      JSON.parse(service.artifacts.readById(ref.artifact_id).toString("utf8")),
      "Native validation"
    );
    expect(saved.validation?.result.status).toBe("validated");
    expect(saved.validation?.receipts).toHaveLength(20);
    expect(saved.validation?.request.offline_validation).toEqual(
      offline.advanced.learning[0]?.offline_validation
    );
  }, 120000);
  it("does not attach SCA model settings to a non-SCA service", () => {
    const env = environment();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "research",
    });
    expect(service.engine.registration.name).toBe("research");
    expect(capturedRuntime).toBeUndefined();
  });
  it.each(["private", "foreign-context", "foreign-wire", "non-json", "forged-error"] as const)(
    "denies %s review disclosure with zero HTTP independently of native operation registration",
    async (mode) => {
      environment(); // Provision the source fixture before binding its exact snapshot.
      const runId = `review-disclosure-${mode}`;
      const configured = configFor(runId);
      const config = { ...configured, limits: SCA_LIVE_LIMITS };
      const caller = validateScaRequestV1({
        purpose: start(runId).goal,
        ...start(runId).constraints,
        source_snapshot_sha256: config.scope.source_snapshot_sha256,
      });
      const bytes = Buffer.from('{"schema_version":1,"results":[],"gaps":[]}');
      const ref: ArtifactRef = {
        schema_version: 2,
        artifact_id: `art_${"a".repeat(64)}`,
        run_id: runId,
        phase: "gathering_evidence",
        branch_id: null,
        kind: "sca-evidence-result",
        operation_id: "offline-evidence",
        version: 1,
        producer: "host:sca-ordinary",
        media_type: "application/json",
        byte_length: bytes.length,
        content_digest: sha256(bytes),
        store_ref: `artifact://sha256/${sha256(bytes)}`,
      };
      const envelope = {
        schema_version: 2,
        ok: true,
        type: "artifact_read",
        artifact_ref: ref,
        phase: ref.phase,
        kind: ref.kind,
        producer: ref.producer,
        media_type: ref.media_type,
        total_bytes: bytes.length,
        requested_range: { start: 0, end: bytes.length },
        returned_range: { start: 0, end: bytes.length },
        returned_bytes: bytes.length,
        content_digest: ref.content_digest,
        content: bytes.toString("utf8"),
        truncated: false,
        next_range: null,
      };
      const runtime = createScaModelSessionRuntime({
        projectRoot: PROJECT_ROOT,
        host: {
          config,
          admit(value) {
            if (canonicalJson(value).includes("OPERATOR_RAW_PRIVATE_SENTINEL"))
              throw new Error("withheld private data");
          },
        },
        requestForRun: () => caller,
        readArtifact: () => bytes,
      });
      const { session } = await createAgentSession({
        ...(await createPrivateSessionResourceLoader({
          projectRoot: PROJECT_ROOT,
          systemPrompt: "Offline SCA disclosure fixture",
        })),
        model,
        cwd: PROJECT_ROOT,
        sessionManager: SessionManager.inMemory(),
        tools: ["artifact_read"],
        customTools: [
          {
            name: "artifact_read",
            label: "Read",
            description: "Offline fixture",
            parameters: Type.Object({}),
            async execute() {
              return { content: [], details: undefined };
            },
          },
        ],
        settingsManager: runtime.settingsManager,
      });
      sessions.push(session);
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("must not delegate"));
      const foreign = { ...envelope, artifact_ref: { ...ref, run_id: "foreign-run" } };
      session.agent.streamFunction = async (_model, _context, options) => {
        if (options?.fetch === undefined) throw new Error("Missing serialized guard");
        await options.fetch(config.destination, {
          method: "POST",
          body: JSON.stringify({
            model: model.id,
            stream: true,
            max_tokens: config.limits.outputTokensPerCall,
            messages: [
              { role: "tool", tool_call_id: "offline-read", content: JSON.stringify(foreign) },
            ],
          }),
        });
        return createAssistantMessageEventStream();
      };
      const invocation: AgentInvocation = {
        agent: "carren",
        stateId: "reviewing_report",
        task: "Offline full review disclosure",
        projectRoot: PROJECT_ROOT,
        trustProfile: "hardened-untrusted",
        inputArtifacts: [ref],
        modelOverride: SCA_REQUIRED_MODEL.override,
        workflowSession: {
          run_id: runId,
          workflow_session_id: runId,
          worker_id: "offline-review",
          branch_id: null,
          attempt: 1,
          purpose: "phase",
        },
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
      const text =
        mode === "private"
          ? "OPERATOR_RAW_PRIVATE_SENTINEL"
          : mode === "non-json" || mode === "forged-error"
            ? "Validation failed but never observed"
            : JSON.stringify(foreign);
      const release = runtime.attach(session, invocation);
      try {
        const context =
          mode === "foreign-wire"
            ? normalizeContext({ messages: [] })
            : normalizeContext({
                messages: [
                  {
                    role: "toolResult",
                    toolName: "artifact_read",
                    toolCallId: "offline-read",
                    isError: mode === "forged-error",
                    content: [{ type: "text", text }],
                    timestamp: 0,
                  },
                ],
              });
        await expect(session.agent.streamFunction(model, context)).rejects.toThrow(
          "host disclosure admission"
        );
        expect(network).not.toHaveBeenCalled();
      } finally {
        release();
      }
    }
  );
  it.each(["valid", "foreign", "non-json", "private", "rejected"] as const)(
    "validates ORIGINAL %s artifact output before automatic SDK flattening/truncation",
    async (mode) => {
      environment();
      const runId = `original-summary-${mode}`,
        config = configFor(runId);
      const bytes = Buffer.from("Assigned evidence must still be read exactly. ".repeat(100));
      const ref: ArtifactRef = {
        schema_version: 2,
        artifact_id: `art_${"a".repeat(64)}`,
        run_id: runId,
        phase: "gathering_evidence",
        branch_id: null,
        kind: "sca-evidence-result",
        operation_id: "original-source",
        version: 1,
        producer: "host:sca-ordinary",
        media_type: "text/plain",
        byte_length: bytes.length,
        content_digest: sha256(bytes),
        store_ref: `artifact://sha256/${sha256(bytes)}`,
      };
      const envelope = {
        schema_version: 2,
        ok: true,
        type: "artifact_read",
        artifact_ref: mode === "foreign" ? { ...ref, run_id: "foreign" } : ref,
        phase: ref.phase,
        kind: ref.kind,
        producer: ref.producer,
        media_type: ref.media_type,
        total_bytes: bytes.length,
        requested_range: { start: 0, end: bytes.length },
        returned_range: { start: 0, end: bytes.length },
        returned_bytes: bytes.length,
        content_digest: ref.content_digest,
        content: bytes.toString("utf8"),
        truncated: false,
        next_range: null,
      };
      const manager = SessionManager.inMemory();
      const assistant: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        responseModel: "deepseek-v4.1-flash",
        content: [],
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      manager.appendMessage({ role: "user", content: "Prior admitted assignment", timestamp: 0 });
      manager.appendMessage({
        ...assistant,
        content: [
          {
            type: "toolCall",
            id: "original",
            name: "artifact_read",
            arguments: { artifact: ref.artifact_id },
          },
        ],
        stopReason: "toolUse",
      });
      manager.appendMessage({
        role: "toolResult",
        toolName: "artifact_read",
        toolCallId: "original",
        isError: mode === "rejected",
        content: [
          {
            type: "text",
            text:
              mode === "non-json"
                ? "Non-JSON tool text"
                : mode === "private"
                  ? "x".repeat(2500) + "RAW_PRIVATE_BYTES"
                  : JSON.stringify(envelope),
          },
        ],
        timestamp: 0,
      });
      manager.appendMessage({
        ...assistant,
        content: [{ type: "text", text: "Finished old turn" }],
        usage: { ...assistant.usage, input: 131000, totalTokens: 131000 },
      });
      const caller = validateScaRequestV1({
        purpose: start(runId).goal,
        ...start(runId).constraints,
        source_snapshot_sha256: config.scope.source_snapshot_sha256,
      });
      const runtime = createScaModelSessionRuntime({
        projectRoot: PROJECT_ROOT,
        host: { config },
        requestForRun: () => caller,
        readArtifact: () => bytes,
      });
      runtime.settingsManager.applyOverrides({
        compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 0 },
      });
      const { session } = await createAgentSession({
        ...(await createPrivateSessionResourceLoader({
          projectRoot: PROJECT_ROOT,
          systemPrompt: "Offline original-source fixture",
        })),
        settingsManager: runtime.settingsManager,
        model,
        cwd: PROJECT_ROOT,
        sessionManager: manager,
        tools: ["artifact_read"],
        customTools: [
          {
            name: "artifact_read",
            label: "Read",
            description: "Unreached exact reader",
            parameters: Type.Object({}),
            async execute() {
              throw new Error("Unrequested tool execution");
            },
          },
        ],
      });
      sessions.push(session);
      let summaryCalls = 0;
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
        if (!(request instanceof Request)) throw new Error("Missing SDK HTTP request");
        if (session.isCompacting) {
          summaryCalls++;
          const body = object(await request.clone().json());
          expect(JSON.stringify(body)).toContain("Assigned evidence");
          expect(JSON.stringify(body)).not.toContain('"role":"tool"');
          return response(
            "Prior approved summary plaintext, not proof of complete artifact reading."
          );
        }
        return response("FINAL CORRECT OUTPUT");
      });
      const attached: AgentInvocation = {
        agent: "carren",
        stateId: "reviewing_report",
        task: "Offline original artifact source",
        projectRoot: PROJECT_ROOT,
        trustProfile: "hardened-untrusted",
        inputArtifacts: [ref],
        modelOverride: SCA_REQUIRED_MODEL.override,
        workflowSession: {
          run_id: runId,
          workflow_session_id: runId,
          worker_id: "original",
          branch_id: null,
          attempt: 1,
          purpose: "phase",
        },
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
      const release = runtime.attach(session, attached);
      await session.prompt("Continue under the same exact scope");
      if (mode === "valid") {
        expect(summaryCalls).toBeGreaterThan(0);
        expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
        expect(session.getLastAssistantText()).toBe("FINAL CORRECT OUTPUT");
        release();
      } else {
        expect(summaryCalls).toBe(0);
        expect(network).not.toHaveBeenCalled();
        expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
        expect(release).toThrow(
          mode === "rejected"
            ? "rejected tool output in compaction source"
            : "host disclosure admission"
        );
      }
    }
  );
  it("checks a later FULL artifact tool-result transcript before provider delegation", async () => {
    const env = environment();
    const runId = "model-full-transcript",
      config = configFor(runId);
    const caller = validateScaRequestV1({
      purpose: start(runId).goal,
      ...start(runId).constraints,
      source_snapshot_sha256: config.scope.source_snapshot_sha256,
    });
    using owner = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "sca",
      modelClient: new ScriptedScaClient(),
    });
    owner.handle(start(runId));
    const exactRef = owner.checkpointer
      .loadRunById(runId)
      ?.selectedArtifacts.find((r) => r.kind === "sca-source-corpus");
    if (exactRef === undefined) throw new Error("Missing exact source input artifact");
    const runtime = createScaModelSessionRuntime({
      projectRoot: PROJECT_ROOT,
      readArtifact: (ref) => owner.artifacts.readById(ref.artifact_id),
      host: {
        config,
        admit(value) {
          if (JSON.stringify(value).includes("HOST_PRIVATE_SENTINEL"))
            throw new Error("Private input must not be disclosed");
        },
      },
      requestForRun: () => caller,
    });
    const { session } = await createAgentSession({
      ...(await createPrivateSessionResourceLoader({
        projectRoot: PROJECT_ROOT,
        systemPrompt: "Offline SCA disclosure fixture",
      })),
      model,
      cwd: PROJECT_ROOT,
      sessionManager: SessionManager.inMemory(),
      tools: ["artifact_read"],
      customTools: [
        {
          name: "artifact_read",
          label: "Read",
          description: "Fixture",
          parameters: Type.Object({}),
          async execute() {
            return { content: [], details: undefined };
          },
        },
      ],
      settingsManager: runtime.settingsManager,
    });
    sessions.push(session);
    let delegated = 0;
    let serializedToolOutput: unknown;
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("must not delegate altered tool bytes"));
    session.agent.streamFunction = async (_model, _context, options) => {
      delegated++;
      if (serializedToolOutput !== undefined) {
        if (options?.fetch === undefined) throw new Error("Missing serialized provider guard");
        await options.fetch(config.destination, {
          method: "POST",
          body: JSON.stringify({
            model: SCA_REQUIRED_MODEL.model,
            stream: true,
            max_tokens: config.limits.outputTokensPerCall,
            messages: [
              {
                role: "tool",
                tool_call_id: "fixture",
                content: JSON.stringify(serializedToolOutput),
              },
            ],
          }),
        });
      }
      return createAssistantMessageEventStream();
    };
    const invocation: AgentInvocation = {
      agent: "annie",
      stateId: "selecting_scanner_dependency_leads",
      task: "Offline",
      projectRoot: PROJECT_ROOT,
      trustProfile: "hardened-untrusted",
      inputArtifacts: [exactRef],
      modelOverride: SCA_REQUIRED_MODEL.override,
      workflowSession: {
        run_id: runId,
        workflow_session_id: runId,
        worker_id: "fixture",
        branch_id: null,
        attempt: 1,
        purpose: "phase",
      },
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
    const release = runtime.attach(session, invocation);
    try {
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
                content: [{ type: "text", text: "HOST_PRIVATE_SENTINEL" }],
                timestamp: 0,
              },
            ],
          })
        )
      ).rejects.toThrow("host disclosure admission");
      expect(delegated).toBe(0);
      await expect(
        session.agent.streamFunction(
          model,
          normalizeContext({
            messages: [
              {
                role: "toolResult",
                toolName: "artifact_read",
                toolCallId: "unobserved-error",
                isError: true,
                content: [{ type: "text", text: "Plausible but unobserved SDK error" }],
                timestamp: 0,
              },
            ],
          })
        )
      ).rejects.toThrow("host disclosure admission");
      expect(delegated).toBe(0);
      const bytes = owner.artifacts.readById(exactRef.artifact_id);
      const envelope = {
        schema_version: 2,
        ok: true,
        type: "artifact_read",
        artifact_ref: exactRef,
        phase: exactRef.phase,
        kind: exactRef.kind,
        producer: exactRef.producer,
        media_type: exactRef.media_type,
        total_bytes: bytes.length,
        requested_range: { start: 0, end: bytes.length },
        returned_range: { start: 0, end: bytes.length },
        returned_bytes: bytes.length,
        content_digest: exactRef.content_digest,
        content: bytes.toString("utf8"),
        truncated: false,
        next_range: null,
      };
      const transcript = (data: unknown) =>
        normalizeContext({
          messages: [
            {
              role: "toolResult",
              toolName: "artifact_read",
              toolCallId: "fixture",
              isError: false,
              content: [{ type: "text", text: JSON.stringify(data) }],
              timestamp: 0,
            },
          ],
        });
      await session.agent.streamFunction(model, transcript(envelope));
      expect(delegated).toBe(1);
      await expect(
        session.agent.streamFunction(
          model,
          transcript({ ...envelope, content: envelope.content + " unauthorized bytes" })
        )
      ).rejects.toThrow("host disclosure admission");
      await expect(
        session.agent.streamFunction(
          model,
          transcript({ ...envelope, artifact_ref: { ...exactRef, run_id: "foreign-run" } })
        )
      ).rejects.toThrow("host disclosure admission");
      expect(delegated).toBe(1);
      serializedToolOutput = {
        ...envelope,
        content: envelope.content + " unauthorized serialized bytes",
      };
      await expect(
        session.agent.streamFunction(model, normalizeContext({ messages: [] }))
      ).rejects.toThrow("host disclosure admission");
      expect(network).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Fixture result not object");
  return { ...value };
}
