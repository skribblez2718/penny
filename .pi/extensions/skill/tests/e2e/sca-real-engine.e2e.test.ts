import path from "node:path";
import { describeScaSourceSnapshotV1 } from "../../../../../apps/orchestration/dist/sca/ordinary-source.js";
import { configuredOfflineFixture } from "../../../../../apps/orchestration/tests/helpers/sca-configured-offline.js";
import { canonicalJson } from "../../../../../apps/orchestration/dist/canonical-json.js";
import {
  AdvancedScriptedClient,
  advancedFixture,
} from "../../../../../apps/orchestration/tests/helpers/sca-advanced-workflow.js";
import type { ScaAdvancedHostOptions } from "../../../../../apps/orchestration/dist/sca/ordinary-advanced-host.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { rmSync, writeFileSync } from "node:fs";

import {
  OrchestrationService,
  sha256,
  type AgentInvocation,
  type PiAgentClientOptions,
  type ArtifactRef,
} from "@penny/orchestration";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";
import {
  PROJECT_ROOT,
  ScriptedScaClient,
  environment,
  roots,
  start,
  fixtureAdapters,
  summary,
} from "../../../../../apps/orchestration/tests/helpers/sca-local-workflow.js";
import type { ArtifactReadParams } from "../../../artifacts/types.js";
import type { SkillResult } from "../../skill-utils.js";
import createSkillExtension from "../../index.js";

let activeClient: ScriptedScaClient | undefined;
let useOrdinaryPiClient = false;
let advancedHost: ScaAdvancedHostOptions | undefined;
let useInstalledRuntime = false;
const invocationContext = new AsyncLocalStorage<AgentInvocation>();
interface SessionCapture {
  readonly invocation: AgentInvocation;
  readonly requestedTools: readonly string[];
  readonly activeTools: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly artifactReads: string[];
  readonly artifactFailures: string[];
  artifactContinuations: number;
}
const sessionCaptures: SessionCapture[] = [];
const fixtureModel: Awaited<ReturnType<NonNullable<PiAgentClientOptions["resolveModel"]>>> = {
  id: "deepseek-v4.1-flash:cloud",
  name: "Deterministic SCA provider-boundary fixture",
  provider: "ollama",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131_072,
  maxTokens: 8_192,
};

// Observe only invocation identity and substitute model lookup; service installs its own
// default client, production disclosure guard and exact-reader factory unchanged.
vi.mock("../../../../../apps/orchestration/dist/model-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../apps/orchestration/dist/model-client.js")>();
  return {
    ...actual,
    PiAgentClient: class extends actual.PiAgentClient {
      constructor(options: PiAgentClientOptions = {}) {
        super({ ...options, resolveModel: () => fixtureModel });
      }
      override runAgent(invocation: AgentInvocation) {
        return invocationContext.run(invocation, () => super.runAgent(invocation));
      }
    },
  };
});

// Create actual SDK sessions. Supply deterministic final provider responses only;
// ordinary PiAgentClient opening/tool checks, session custody and final capture run.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (...args: Parameters<typeof actual.createAgentSession>) => {
      const created = await actual.createAgentSession(...args);
      const invocation = invocationContext.getStore();
      const model = args[0]?.model;
      if (invocation === undefined || model === undefined) {
        throw new Error("ordinary SCA SDK session omitted fixture invocation/model binding");
      }
      const api: unknown = model.api;
      if (api !== "openai-completions") throw new Error("unexpected fixture provider API");
      const capture: SessionCapture = {
        invocation,
        requestedTools: [...(args[0]?.tools ?? [])],
        activeTools: [...created.session.getActiveToolNames()],
        provider: model.provider,
        model: model.id,
        artifactReads: [],
        artifactFailures: [],
        artifactContinuations: 0,
      };
      sessionCaptures.push(capture);
      vi.spyOn(created.session, "prompt").mockImplementation(async () => {
        if (activeClient === undefined) throw new Error("SCA provider response fixture missing");
        const reader = created.session.agent.state.tools.find(
          (tool) => tool.name === "artifact_read"
        );
        if (reader === undefined) throw new Error("actual SDK artifact_read tool missing");
        for (const ref of invocation.inputArtifacts) {
          let request: ArtifactReadParams = { artifact: ref.artifact_id };
          const chunks: string[] = [];
          while (true) {
            const result = await reader.execute(
              `local-sca-read:${ref.artifact_id}`,
              request,
              invocation.signal
            );
            const text = result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
            const payload: unknown = JSON.parse(text);
            if (
              !isRecord(payload) ||
              payload.ok !== true ||
              payload.content_digest !== ref.content_digest ||
              typeof payload.content !== "string" ||
              typeof payload.truncated !== "boolean"
            ) {
              const code =
                isRecord(payload) &&
                isRecord(payload.error) &&
                typeof payload.error.code === "string"
                  ? payload.error.code
                  : "unexpected_artifact_envelope";
              capture.artifactFailures.push(`${ref.kind}:${code}`);
              throw new Error(`actual SDK artifact_read failed for ${ref.kind}:${code}`);
            }
            chunks.push(payload.content);
            if (!payload.truncated) break;
            const next = payload.next_range;
            if (
              !isRecord(next) ||
              typeof next.start !== "number" ||
              typeof next.end !== "number" ||
              !Number.isSafeInteger(next.start) ||
              next.start <= (request.range?.start ?? 0) ||
              next.start >= ref.byte_length ||
              next.end !== ref.byte_length
            ) {
              throw new Error("actual SDK artifact_read returned a non-progressing continuation");
            }
            request = { artifact: ref.artifact_id, range: { start: next.start, end: next.end } };
            capture.artifactContinuations += 1;
          }
          const complete = Buffer.from(chunks.join(""), "utf8");
          if (complete.length !== ref.byte_length || sha256(complete) !== ref.content_digest) {
            throw new Error(
              "actual SDK artifact_read did not reassemble the exact immutable input"
            );
          }
          capture.artifactReads.push(ref.artifact_id);
        }
        // PiAgentClient already admitted identity and guarded dispatch. Only synthesize text here.
        activeClient.invocations.push(invocation);
        const completion = { text: summary(activeClient.output(invocation)) };
        created.session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: completion.text }],
          api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        });
      });
      return created;
    },
  };
});

// Substitute cognition only. Registration, the skill adapter, engine, runner,
// source parsing, artifact custody, checkpoints and terminal admission are real.
vi.mock("@penny/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penny/orchestration")>();
  return {
    ...actual,
    OrchestrationService: class extends actual.OrchestrationService {
      constructor(options: ConstructorParameters<typeof actual.OrchestrationService>[0]) {
        if (activeClient === undefined) throw new Error("local SCA cognition fixture missing");
        super({
          ...options,
          ...(useOrdinaryPiClient ? {} : { modelClient: activeClient }),
          ...(advancedHost === undefined ? {} : { scaAdvanced: advancedHost }),
          ...(useInstalledRuntime
            ? {}
            : { hostOperationAdapters: fixtureAdapters(activeClient.mode) }),
        });
      }
    },
  };
});

interface SkillTool {
  readonly name: "skill";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown
  ): Promise<{ readonly details: SkillResult }>;
}
function isSkillTool(value: unknown): value is SkillTool {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}

const originalEnvironment = new Map(
  [
    "PROJECT_ROOT",
    "PENNY_STATE_ROOT",
    "PENNY_ORCHESTRATION_MAX_ITERATIONS",
    "PI_OBSERVABILITY_ENABLED",
    "PI_OBSERVABILITY_AUTO_START",
    "PENNY_TOOL_RESULT_MAX_BYTES",
    "PENNY_SCA_ORDINARY_OFFLINE_CONFIG",
    "PENNY_SCA_ORDINARY_APPLICATION_CONFIG",
    "PENNY_SCA_ORDINARY_MODEL_CONFIG",
  ].map((name) => [name, process.env[name]])
);
afterEach(() => {
  activeClient = undefined;
  advancedHost = undefined;
  useOrdinaryPiClient = false;
  useInstalledRuntime = false;
  sessionCaptures.length = 0;
  vi.restoreAllMocks();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(
  runId: string,
  client = new ScriptedScaClient(),
  ordinaryPi = false,
  installedRuntime = false,
  advancedResult?: "completed" | "unknown" | "configured_offline"
) {
  activeClient = client;
  useOrdinaryPiClient = ordinaryPi;
  useInstalledRuntime = installedRuntime;
  // These negative-path fixtures deliberately supply an evaluator policy; production
  // omission is not a request for the former implicit three-attempt allowance.
  const env: NodeJS.ProcessEnv = { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" };
  const offline = advancedResult === "configured_offline" ? configuredOfflineFixture() : undefined;
  const advanced =
    offline ??
    (advancedResult === undefined || advancedResult === "configured_offline"
      ? undefined
      : advancedFixture(advancedResult, false, false));
  advancedHost = offline === undefined ? advanced?.host : undefined;
  if (offline !== undefined) {
    offline.advanced.application_tests = [];
    const file = `${offline.root}/normal-offline-host.json`;
    writeFileSync(file, canonicalJson(offline.runnerConfig), { mode: 0o600 });
    process.env.PENNY_SCA_ORDINARY_OFFLINE_CONFIG = file;
  }
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  process.env.PENNY_STATE_ROOT = env.PENNY_STATE_ROOT;
  process.env.PENNY_ORCHESTRATION_MAX_ITERATIONS = env.PENNY_ORCHESTRATION_MAX_ITERATIONS;
  process.env.PI_OBSERVABILITY_ENABLED = "false";
  process.env.PI_OBSERVABILITY_AUTO_START = "false";
  if (ordinaryPi) {
    const request = start(runId);
    const file = path.join(env.PENNY_STATE_ROOT ?? "", "generic-model-consent.json");
    const config = {
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
      destination: `${fixtureModel.baseUrl}/chat/completions`,
      disclose_full_transcript: true,
      limits: {
        calls: 96,
        callsPerSession: 24,
        routingRepairSessions: 2,
        inputBytesPerCall: 500000,
        outputTokensPerCall: 6144,
        totalOutputTokens: 589824,
        totalOutputBytes: 2359296,
        inactivityMs: 30000,
      },
    };
    writeFileSync(file, canonicalJson(config), { mode: 0o600 });
    process.env.PENNY_SCA_ORDINARY_MODEL_CONFIG = file;
    env.PENNY_SCA_ORDINARY_MODEL_CONFIG = file;
  }
  const owner = new OrchestrationService({
    projectRoot: PROJECT_ROOT,
    env,
    playbookName: "sca",
    ...(advancedHost === undefined ? {} : { scaAdvanced: advancedHost }),
    ...(installedRuntime ? {} : { hostOperationAdapters: fixtureAdapters(client.mode) }),
  });
  client.bindArtifactReader((id) => owner.artifacts.readById(id).toString("utf8"));
  let tool: SkillTool | undefined;
  createSkillExtension(
    createTestExtensionApi({
      onRegisterTool(value) {
        if (isSkillTool(value)) tool = value;
      },
    })
  );
  if (tool === undefined) throw new Error("real skill entrypoint not registered");
  const request = start(runId);
  const params = {
    skill_name: "sca",
    session_id: runId,
    goal: request.goal,
    constraints: {
      ...request.constraints,
      ...(advanced === undefined
        ? {}
        : { execution_mode: "propose_stronger_evidence", advanced: advanced.advanced }),
    },
  };
  const context = {
    cwd: PROJECT_ROOT,
    isProjectTrusted: () => true,
    ui: { theme: { fg: (_color: string, text: string) => text }, notify: () => undefined },
  };
  return { owner, client, tool, params, context, advanced };
}
function selected(owner: OrchestrationService, runId: string, kind: string): ArtifactRef {
  const ref = owner.checkpointer
    .loadRunById(runId)
    ?.selectedArtifacts.find((item) => item.kind === kind);
  if (ref === undefined) throw new Error(`real SCA run omitted ${kind}`);
  return ref;
}

// Real skill→registry→service→runner→host owner→artifacts/checkpoints, with offline
// scanner/graph observations and provider answers. This does not attest native tools or live cognition.
describe("SCA ordinary skill-entrypoint end-to-end", () => {
  it("runs generic advanced operands through actual installed learning/process modules and default host config", async () => {
    const runId = "generic-default-offline";
    const h = harness(runId, new AdvancedScriptedClient(false), false, true, "configured_offline");
    using _owner = h.owner;
    const result = await h.tool.execute(
      "generic-default-offline",
      h.params,
      undefined,
      undefined,
      h.context
    );
    expect(result.details.state).toBe("incomplete");
    const product: unknown = JSON.parse(
      h.owner.artifacts
        .readById(selected(h.owner, runId, "semantic-core").artifact_id)
        .toString("utf8")
    );
    expect(product).toMatchObject({
      reproduction: "NOT RUN",
      target_executed: false,
      advanced: {
        operations: [
          { stage: "validation", status: "validated" },
          { stage: "promotion", status: "promoted" },
          { stage: "rescan", status: "completed" },
        ],
      },
    });
    expect(
      h.owner.checkpointer.hostOperationCallsForRun(runId).every((r) => r.lifecycle === "consumed")
    ).toBe(true);
    const replay = await h.tool.execute(
      "generic-default-offline-recover",
      h.params,
      undefined,
      undefined,
      h.context
    );
    expect(replay.details.state).toBe("incomplete");
  }, 120000);

  it.each([true, false])(
    "generic default installed application module preserves explicit container consent=%s (unavailable runtime, no Docker launch)",
    async (containerConsent) => {
      const runId = `generic-container-${containerConsent}`;
      const h = harness(runId, new AdvancedScriptedClient(true, false), true, false, "completed");
      using _owner = h.owner;
      advancedHost = undefined; // Generic invocation must use only the normal host env config.
      const applications = h.advanced?.advanced.application_tests;
      const vm = applications?.[0];
      if (vm === undefined) throw new Error("Missing caller application");
      if (containerConsent) {
        if (!("vm_timeout_seconds" in vm.resources) || !("vm_timeout_seconds" in vm.maxima))
          throw new Error("Expected V1 fixture");
        const { vm_timeout_seconds, ...r } = vm.resources,
          { vm_timeout_seconds: maximum, ...m } = vm.maxima;
        applications?.splice(0, 1, {
          ...vm,
          isolation: "container",
          profile: "docker-local-no-network-v1",
          resources: { ...r, operation_timeout_seconds: vm_timeout_seconds },
          maxima: { ...m, operation_timeout_seconds: maximum },
        });
      }
      const file = path.join(h.owner.config.stateRoot, "generic-application-host.json");
      writeFileSync(
        file,
        canonicalJson({
          schema_id: "penny.sca-ordinary-application-container-config.v1",
          schema_version: 1,
          kind: "docker",
          isolation: "container",
          profile: "docker-local-no-network-v1",
          workspace_parent: h.owner.config.stateRoot,
          docker: {
            path: path.join(h.owner.config.stateRoot, "not-installed-docker"),
            sha256: "0".repeat(64),
            size_bytes: 1,
          },
          daemon_socket: path.join(h.owner.config.stateRoot, "no-daemon.sock"),
          images: { php: null, node: null },
        }),
        { mode: 0o600 }
      );
      process.env.PENNY_SCA_ORDINARY_APPLICATION_CONFIG = file;
      const output = await h.tool.execute(
        "default-container-module",
        h.params,
        undefined,
        undefined,
        h.context
      );
      expect(output.details.state).toBe("incomplete");
      const plan = selected(h.owner, runId, "sca-execution-plan"),
        policy = selected(h.owner, runId, "sca-execution-policy");
      for (const ref of [plan, policy])
        expect(ref.content_schema?.schema_version).toBe(containerConsent ? 2 : 1);
      const operands: unknown = JSON.parse(
        h.owner.artifacts.readById(policy.artifact_id).toString("utf8")
      );
      expect(operands).toMatchObject({
        schema_version: containerConsent ? 2 : 1,
        isolation: containerConsent ? "container" : "vm",
        profile: containerConsent ? "docker-local-no-network-v1" : "qemu-kvm-nicless-v1",
        allowed_plan_sha256: [plan.content_digest],
      });
      const record = h.owner.checkpointer
        .hostOperationCallsForRun(runId)
        .find((x) => x.operation_kind === "sca.application.v1");
      expect(record?.lifecycle).toBe("consumed");
      const ref = record?.operation_result_ref;
      if (ref === undefined || ref === null) throw new Error("Missing actual native result");
      const raw: unknown = JSON.parse(h.owner.artifacts.readById(ref.artifact_id).toString("utf8"));
      expect(raw).toMatchObject({
        native: {
          status: containerConsent ? "unsupported" : "denied",
          reason: containerConsent ? "not_configured" : "policy_denied",
          execution: "NOT RUN",
          acceptance: "not_submitted",
          cleanup: "not_needed",
        },
      });
      if (containerConsent)
        expect(raw).toMatchObject({
          native: {
            isolation: "CONTAINER",
            evidence_scope:
              "untrusted_container_observation_not_vulnerability_or_isolation_attestation",
          },
        });
      expect(
        sessionCaptures.every(
          (x) =>
            x.requestedTools.join() === "artifact_read" &&
            x.activeTools.join() === "artifact_read" &&
            x.artifactFailures.length === 0
        )
      ).toBe(true);
      expect(
        await h.tool.execute("default-container-recover", h.params, undefined, undefined, h.context)
      ).toMatchObject({ details: { state: "incomplete" } });
      expect(
        h.owner.checkpointer
          .hostOperationCallsForRun(runId)
          .filter((x) => x.operation_kind === "sca.application.v1")
      ).toHaveLength(1);
    }
  );

  it.each(["completed", "unknown"] as const)(
    "generic ingress binds advanced caller inputs to the actual run (%s; scripted VM observation)",
    async (result) => {
      const runId = `generic-advanced-${result}`;
      const h = harness(runId, new AdvancedScriptedClient(true, false), false, false, result);
      using _owner = h.owner;
      const output = await h.tool.execute(
        "advanced-generic",
        h.params,
        undefined,
        undefined,
        h.context
      );
      expect(output.details.state).toBe(result === "completed" ? "complete" : "incomplete");
      expect(h.advanced?.counts().applications).toBe(1);
      const product: unknown = JSON.parse(
        h.owner.artifacts
          .readById(selected(h.owner, runId, "semantic-core").artifact_id)
          .toString("utf8")
      );
      expect(product).toMatchObject({
        reproduction: result === "completed" ? "RUN" : "UNKNOWN",
        target_executed: result === "completed" ? true : null,
      });
      const operations = h.owner.checkpointer.hostOperationCallsForRun(runId);
      expect(
        operations.some(
          (x) => x.operation_kind === "sca.application.v1" && x.lifecycle === "consumed"
        )
      ).toBe(true);
      const replay = await h.tool.execute(
        "advanced-recover",
        h.params,
        undefined,
        undefined,
        h.context
      );
      expect(replay.details.state).toBe(output.details.state);
      expect(h.advanced?.counts().applications).toBe(1);
    }
  );

  it.each([
    { name: "task-selected tools", constraints: { allowed_tools: ["bash"] } },
    { name: "unregistered model", constraints: { model: "sol" } },
    { name: "target execution", constraints: { execution_mode: "execute_target" } },
    { name: "retired activation", constraints: { activation_ref: "not-an-ordinary-input" } },
    { name: "escaping scope", constraints: { scope: { include: ["../escape"], exclude: [] } } },
  ])("refuses $name before creating a run or invoking cognition", async ({ constraints }) => {
    const runId = "sca-ordinary-invalid-request";
    const { owner, client, tool, params, context } = harness(runId);
    using _owner = owner;
    // Generic ingress propagates typed admission errors (as for the other skills);
    // invalid requests must not become ordinary negative-terminal runs.
    await expect(
      tool.execute(
        "ordinary-invalid",
        { ...params, constraints: { ...params.constraints, ...constraints } },
        undefined,
        undefined,
        context
      )
    ).rejects.toMatchObject({ name: "ScaRequestError", code: "invalid_request" });
    expect(client.invocations).toEqual([]);
    expect(owner.checkpointer.loadRunById(runId)).toBeUndefined();
  });

  it("executes the complete registered path and returns all representations without a release prerequisite", async () => {
    const runId = "sca-ordinary-entrypoint-complete";
    const { owner, client, tool, params, context } = harness(runId);
    using _owner = owner;
    const initial = await tool.execute("ordinary-start", params, undefined, undefined, context);
    expect(initial.details.success).toBe(true);
    expect(initial.details.state).toBe("complete");
    expect(initial.details.requires_approval).toBe(false);
    expect(initial.details.errors).toEqual([]);
    expect(client.invocations.map((item) => item.stateId)).toEqual([
      "selecting_scanner_dependency_leads",
      "selecting_underdetected_no_alert_surfaces",
      "forming_hypotheses",
      "challenging_hypotheses",
      "selecting_evidence_actions",
      "adjudicating_evidence",
      "assessing_learning",
      "materializing_report",
      "reviewing_report",
      "verifying_final_product",
    ]);
    expect(
      client.invocations.every((item) => item.modelOverride === "ollama/deepseek-v4.1-flash:cloud")
    ).toBe(true);
    const report = selected(owner, runId, "semantic-core");
    expect(initial.details.output_artifact_ref?.artifact_id).toBe(report.artifact_id);
    const reportBytes = owner.artifacts.readById(report.artifact_id);
    expect(JSON.parse(reportBytes.toString("utf8"))).toMatchObject({
      schema_id: "penny.sca-report.v3",
      status: "COMPLETE",
      reproduction: "NOT RUN",
      target_executed: false,
    });
    for (const kind of [
      "sca-report-markdown",
      "sca-report-sarif",
      "sca-report-validation",
      "sca-output-manifest",
    ])
      expect(selected(owner, runId, kind).byte_length).toBeGreaterThan(0);
    expect(owner.checkpointer.completionAdmission(runId)).toBeDefined();
  });

  it("keeps useful reports and explicit non-positive status when material tools are unavailable", async () => {
    const runId = "sca-ordinary-entrypoint-missing";
    const { owner, client, tool, params, context } = harness(
      runId,
      new ScriptedScaClient("missing")
    );
    using _owner = owner;
    const result = await tool.execute("ordinary-missing", params, undefined, undefined, context);
    expect(result.details.success).toBe(false);
    expect(result.details.state).toBe("incomplete");
    expect(result.details.requires_approval).toBe(false);
    expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
    expect(
      JSON.parse(
        owner.artifacts
          .readById(selected(owner, runId, "semantic-core").artifact_id)
          .toString("utf8")
      )
    ).toMatchObject({ status: "INCOMPLETE" });
  });

  it("loads the built service runtime through ordinary ingress and real SDK sessions without analyzer injection", async () => {
    const runId = "sca-ordinary-installed-runtime";
    const { owner, tool, params, context } = harness(
      runId,
      new ScriptedScaClient("noalert"),
      true,
      true
    );
    using _owner = owner;
    const result = await tool.execute("ordinary-installed", params, undefined, undefined, context);
    expect(result.details.success).toBe(false);
    expect(result.details.state).toBe("incomplete");
    expect(result.details.requires_approval).toBe(false);
    const preparation: unknown = JSON.parse(
      owner.artifacts
        .readById(selected(owner, runId, "sca-preparation-result").artifact_id)
        .toString("utf8")
    );
    if (!isRecord(preparation) || !Array.isArray(preparation.capabilities)) {
      throw new Error("installed runtime preparation capabilities missing");
    }
    expect(preparation.capabilities).toContainEqual(
      expect.objectContaining({
        id: "dependencies",
        status: "completed",
        version: "dependency-inventory-v2",
      })
    );
    for (const id of ["semgrep", "gitleaks", "graph_php", "graph_javascript_typescript"]) {
      expect(preparation.capabilities).toContainEqual(
        expect.objectContaining({ id, status: "unavailable" })
      );
    }
    expect(sessionCaptures).toHaveLength(10);
    expect(sessionCaptures.every((capture) => capture.artifactFailures.length === 0)).toBe(true);
    expect(
      sessionCaptures.every(
        (capture) =>
          capture.requestedTools.join() === "artifact_read" &&
          capture.activeTools.join() === "artifact_read"
      )
    ).toBe(true);
  });

  it("uses actual SDK sessions, registered DeepSeek identity and artifact_read-only exact inputs", async () => {
    const runId = "sca-ordinary-real-sdk";
    const { owner, tool, params, context } = harness(runId, new ScriptedScaClient("noalert"), true);
    using _owner = owner;
    process.env.PENNY_TOOL_RESULT_MAX_BYTES = "4096";
    const result = await tool.execute("ordinary-sdk", params, undefined, undefined, context);
    expect(result.details.success).toBe(true);
    expect(sessionCaptures).toHaveLength(10);
    for (const capture of sessionCaptures) {
      expect(capture.provider).toBe("ollama");
      expect(capture.model).toBe("deepseek-v4.1-flash:cloud");
      expect(capture.requestedTools).toEqual(["artifact_read"]);
      expect(capture.activeTools).toEqual(["artifact_read"]);
      expect(capture.artifactFailures).toEqual([]);
      expect(capture.artifactReads).toEqual(
        capture.invocation.inputArtifacts.map((ref) => ref.artifact_id)
      );
      expect(
        capture.invocation.inputArtifacts.some((ref) => ref.kind === "sca-source-corpus")
      ).toBe(false);
    }
    expect(
      sessionCaptures.reduce((sum, capture) => sum + capture.artifactContinuations, 0)
    ).toBeGreaterThan(0);
  });
});
