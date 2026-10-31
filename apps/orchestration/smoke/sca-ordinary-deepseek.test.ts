// Match generic production ingress's public-package initialization order.
import "../dist/index.js";
import { randomUUID } from "node:crypto";
import { resolveToolResultBudget } from "../../../.pi/extensions/lib/tool-result-budget.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createTestExtensionApi } from "../../../.pi/lib/tests/pi-test-host.js";
import { createOrdinaryScaRuntime } from "../../sca-service/src/ordinary-runtime.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract, type Directive } from "../dist/contracts.js";
import type { AgentInvocation } from "../dist/model-client.js";
import { describeScaSourceSnapshotV1 } from "../dist/sca/ordinary-source.js";
import { SCA_AGENT_BY_STATE, SCA_PLAYBOOK_REGISTRATION } from "../dist/playbooks/sca.js";
import {
  createScaOrdinaryHostAdapters,
  ScaGraphDataSchema,
  type ScaOrdinaryRuntime,
} from "../dist/sca/ordinary-host.js";
import { ScaPreparationSchema, parseScaReview } from "../dist/sca/ordinary-contracts.js";
import {
  ScaReportProductSchema,
  validateScaReportRepresentations,
} from "../dist/sca/ordinary-report.js";
import {
  OrdinaryScaModelGuard,
  SCA_REQUIRED_MODEL,
  SCA_PROVIDER_RESPONSE_MODEL_IDS,
} from "../dist/sca/ordinary-model-guard.js";
import { OrchestrationService, type OrchestrationServiceOptions } from "../dist/service.js";
import { initializePennyState } from "../dist/state/setup.js";
import {
  atomicBytes,
  atomicJson,
  fixtureProject,
  hasCompleteArtifactRead,
  isRecord,
  readLiveConfig,
  syntheticDisclosure,
  verifyLiveAnalysisInputs,
  SCA_LIVE_LIMITS,
  SCA_ROUTING_REPAIR_SESSION_LIMIT,
  measureLiveReviewClosure,
  assertLiveReviewClosureFits,
  type ScaLiveReviewClosure,
} from "./sca-ordinary-deepseek-fixture.js";

// Only the host-native preparation seam is injected, to reuse exact pinned CPGs.
// Generic ingress, registration, client, reader, sessions and provider stay production.
const embedding = vi.hoisted(
  (): {
    configure?: (options: OrchestrationServiceOptions) => OrchestrationServiceOptions;
    capture?: (service: OrchestrationService) => void;
  } => ({})
);
vi.mock("@penny/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penny/orchestration")>();
  return {
    ...actual,
    OrchestrationService: class extends actual.OrchestrationService {
      constructor(options: OrchestrationServiceOptions) {
        super(embedding.configure?.(options) ?? options);
        embedding.capture?.(this);
      }
    },
  };
});
interface LiveSkillTool {
  readonly name: "skill";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    context: unknown
  ): Promise<{ readonly details: Readonly<Record<string, unknown>> }>;
}
function isSkillEntrypoint(value: unknown): value is {
  default: (api: ReturnType<typeof createTestExtensionApi>) => void;
} {
  return isRecord(value) && typeof value.default === "function";
}
function isSkillTool(value: unknown): value is LiveSkillTool {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}

const ENABLED = process.env.PENNY_SCA_ORDINARY_DEEPSEEK === "1";
const REPOSITORY = path.resolve(import.meta.dirname, "../../..");
const LIMITS = SCA_LIVE_LIMITS;
const PreparationCacheSchema = Type.Object(
  {
    key: Type.String(),
    preparation: ScaPreparationSchema,
    graphs: Type.Array(ScaGraphDataSchema),
  },
  { additionalProperties: false }
);

(ENABLED ? describe : describe.skip)("opt-in REAL ordinary SCA DeepSeek", () => {
  it("runs generic skill ingress, pinned native preparation, real cognition, default reader and exact independently reviewed reports", async () => {
    const configPath = process.env.PENNY_SCA_ORDINARY_LIVE_CONFIG;
    if (!configPath)
      throw new Error(
        "PENNY_SCA_ORDINARY_LIVE_CONFIG must name exact destination and caller-bound analysis_tools"
      );
    const live = readLiveConfig(configPath);
    const root =
      process.env.PENNY_SCA_ORDINARY_LIVE_ROOT ??
      mkdtempSync(path.join(tmpdir(), "penny-sca-ordinary-deepseek-"));
    if (!path.isAbsolute(root) || !root.startsWith(`${tmpdir()}/`))
      throw new Error("Live fixture/evidence root must be a caller-bound temporary directory");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const fixture = fixtureProject(root, REPOSITORY);
    const runId = `sca-live-${randomUUID()}`;
    const attemptRoot = path.join(root, runId);
    mkdirSync(attemptRoot, { mode: 0o700 });
    const loadedSourceHashes = [
      "apps/orchestration/src/playbooks/sca.ts",
      "apps/orchestration/src/sca/ordinary-semantic.ts",
      "apps/orchestration/src/sca/ordinary-model-guard.ts",
      "apps/orchestration/src/sca/ordinary-model-runtime.ts",
      "apps/orchestration/src/model-client.ts",
      "apps/orchestration/src/service.ts",
      "apps/orchestration/src/engine.ts",
      "apps/orchestration/src/sca/ordinary-contracts.ts",
      "apps/orchestration/src/sca/ordinary-artifacts.ts",
      "apps/orchestration/src/sca/ordinary-report.ts",
      "apps/orchestration/src/sca/ordinary-host.ts",
      "apps/orchestration/smoke/sca-ordinary-deepseek.test.ts",
      "apps/orchestration/smoke/sca-ordinary-deepseek-fixture.ts",
      "apps/orchestration/dist/artifact-worker.js",
      "apps/sca-service/src/ordinary-runtime.ts",
      ".pi/extensions/skill/index.ts",
      ...Object.entries(SCA_AGENT_BY_STATE).map(
        ([state, agent]) => `.pi/skills/sca/assets/prompts/${agent}-${state}.md`
      ),
      ...[...new Set(Object.values(SCA_AGENT_BY_STATE))].map((agent) => `.pi/agents/${agent}.md`),
      ".pi/SYSTEM.md",
    ].map((file) => {
      const bytes = readFileSync(path.join(REPOSITORY, file));
      return { path: file, byte_length: bytes.length, sha256: sha256(bytes) };
    });
    atomicJson(path.join(attemptRoot, "loaded-source-hashes.json"), loadedSourceHashes);
    const prior = new Map(
      [
        "PROJECT_ROOT",
        "PENNY_STATE_ROOT",
        "PI_PACKAGE_DIR",
        "PI_OBSERVABILITY_ENABLED",
        "PI_OBSERVABILITY_AUTO_START",
        "PENNY_ORCHESTRATION_MAX_STEPS",
        "PENNY_SCA_ORDINARY_MODEL_CONFIG",
      ].map((key) => [key, process.env[key]])
    );
    process.env.PROJECT_ROOT = fixture.project;
    process.env.PENNY_STATE_ROOT = path.join(root, "state");
    process.env.PI_PACKAGE_DIR = path.join(fixture.project, "package");
    const env = {
      ...process.env,
      PI_OBSERVABILITY_ENABLED: "false",
      PI_OBSERVABILITY_AUTO_START: "false",
      PENNY_ORCHESTRATION_MAX_STEPS: "64",
    };
    process.env.PI_OBSERVABILITY_ENABLED = "false";
    process.env.PI_OBSERVABILITY_AUTO_START = "false";
    process.env.PENNY_ORCHESTRATION_MAX_STEPS = "64";
    initializePennyState(fixture.project, { env });
    const worker = SCA_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent")
      throw new Error("Ordinary SCA catalog registration missing");
    for (const phase of worker.phases.values())
      expect(phase.required_model).toEqual(SCA_REQUIRED_MODEL);
    const invocations: AgentInvocation[] = [];
    let service: OrchestrationService | undefined;
    let guard: OrdinaryScaModelGuard | undefined;
    let disclosure: ReturnType<typeof syntheticDisclosure> | undefined;
    const disclosureFailures: string[] = [];
    const reviewClosures = new Map<string, ScaLiveReviewClosure>();
    const toolBudget = resolveToolResultBudget(env);
    const toolEvents: unknown[] = [];
    const compactionEvents: {
      state: string;
      type: string;
      reason: string;
      aborted?: boolean;
      succeeded?: boolean;
    }[] = [];
    const compactionEnabledSessions: { state: string; enabled: boolean }[] = [];
    let nativeCount = 0;
    let cachedPreparation = false;
    let preparationBindings: ReturnType<typeof verifyLiveAnalysisInputs> = [];
    const native = createOrdinaryScaRuntime({
      async recordProcess(value) {
        nativeCount += 1;
        atomicJson(path.join(attemptRoot, `private-process-${nativeCount}.json`), value);
      },
      async recordDeterministic(value) {
        atomicJson(path.join(attemptRoot, `private-${value.kind}.json`), value);
      },
    });
    const runtime: ScaOrdinaryRuntime = {
      async prepare(input) {
        // Reuse never trusts merely declared hashes: re-read each exact caller pin.
        preparationBindings = verifyLiveAnalysisInputs(input.request.tools);
        const key = sha256(
          canonicalJson({ corpus: sha256(input.corpus), tools: input.request.tools })
        );
        const file = live.preparation_cache?.path ?? path.join(root, `preparation-${key}.json`);
        if (
          live.preparation_cache !== undefined &&
          (!path.isAbsolute(file) || sha256(readFileSync(file)) !== live.preparation_cache.sha256)
        )
          throw new Error("Caller preparation cache digest/path drift");
        if (existsSync(file)) {
          const value: unknown = JSON.parse(readFileSync(file, "utf8"));
          const cached = validateContract(
            PreparationCacheSchema,
            value,
            "Exact source/config-bound native cache"
          );
          if (
            cached.key !== key ||
            cached.preparation.source_snapshot_sha256 !== input.request.source_snapshot_sha256 ||
            cached.graphs.some(
              (graph) =>
                graph.source_snapshot_sha256 !== input.request.source_snapshot_sha256 ||
                sha256(Buffer.from(graph.bytes_base64, "base64")) !== graph.graph_sha256
            )
          )
            throw new Error("Native preparation cache source/graph drift");
          cachedPreparation = true;
          return cached;
        }
        const result = await native.prepare(input);
        atomicJson(
          file,
          validateContract(PreparationCacheSchema, { key, ...result }, "Native preparation cache")
        );
        return result;
      },
      gather: (input) => native.gather(input),
    };
    const goal =
      "Assess only the newly generated harmless PHP/JS/TS fixture. No target execution, credentials, publishing, rule promotion or safety certification. Distinguish a function named sink returning data from a real interpreter effect. Preserve unavailable advisory coverage as INCOMPLETE. Keep investigation bounded to these three tiny files and return compact schema-valid results.";
    const snapshot = describeScaSourceSnapshotV1({
      source_root: fixture.source,
      scope: { include: [], exclude: [] },
    });
    // Observe, never substitute, the production-installed guard. No session.prompt,
    // stream, HTTP response, provider output or model metadata is mocked.
    const attach = OrdinaryScaModelGuard.prototype.attach;
    const observeGuard = (instance: OrdinaryScaModelGuard) => {
      guard = instance;
    };
    const attachment = vi
      .spyOn(OrdinaryScaModelGuard.prototype, "attach")
      .mockImplementation(function (this: OrdinaryScaModelGuard, session, invocation) {
        observeGuard(this);
        invocations.push(invocation);
        compactionEnabledSessions.push({
          state: invocation.stateId,
          enabled: session.autoCompactionEnabled,
        });
        session.subscribe((event) => {
          if (event.type === "compaction_start" || event.type === "compaction_end")
            compactionEvents.push({
              state: invocation.stateId,
              type: event.type,
              reason: event.reason,
              ...(event.type === "compaction_end"
                ? { aborted: event.aborted, succeeded: event.result !== undefined }
                : {}),
            });
          if (event.type === "tool_execution_end") {
            const result: unknown = event.result;
            if (event.toolName === "artifact_read" && event.isError)
              disclosure?.observeToolError(event.toolCallId, result, invocation);
            toolEvents.push({
              state: invocation.stateId,
              purpose: invocation.executionPurpose ?? "phase",
              tool: event.toolName,
              is_error: event.isError,
              result,
            });
          }
        });
        return attach.call(this, session, invocation);
      });
    let terminal: Directive | undefined;
    let skillResult: Readonly<Record<string, unknown>> | undefined;
    const execute = OrchestrationService.prototype.execute;
    const execution = vi
      .spyOn(OrchestrationService.prototype, "execute")
      .mockImplementation(async function (this: OrchestrationService, ...args) {
        const result = await execute.call(this, ...args);
        terminal = result;
        return result;
      });
    let selectedKinds: string[] = [];
    let failure: string | null = null;
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort(new Error("Operator cancelled live SCA cohort"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      embedding.configure = (options) => ({
        ...options,
        scaModel: {
          config: {
            schema_version: 1,
            scope: {
              project_root: fixture.project,
              run_id: runId,
              source_root: fixture.source,
              source_snapshot_sha256: snapshot.source_snapshot_sha256,
              purpose: goal,
            },
            destination: live.destination,
            disclose_full_transcript: true,
            limits: LIMITS,
          },
          admit(value, invocation) {
            if (disclosure === undefined) throw new Error("Live disclosure fence unbound");
            try {
              disclosure.admit(value, invocation);
              // Before the FIRST review HTTP delegation, prove the expected complete
              // read-once closure fits. Never repair a size failure by cutting a tail.
              if (
                isRecord(value) &&
                value.stream === true &&
                ["reviewing_report", "verifying_final_product"].includes(invocation.stateId)
              ) {
                const workerId = invocation.workflowSession?.worker_id;
                if (workerId === undefined || service === undefined)
                  throw new Error("Review closure lacks exact worker/store binding");
                if (!reviewClosures.has(workerId)) {
                  const closure = measureLiveReviewClosure({
                    openingBytes: Buffer.byteLength(canonicalJson(value)),
                    refs: invocation.inputArtifacts,
                    read: (ref) => {
                      if (service === undefined) throw new Error("Review store unavailable");
                      return service.artifacts.readById(ref.artifact_id);
                    },
                    toolBudget,
                  });
                  reviewClosures.set(workerId, closure);
                }
                const closure = reviewClosures.get(workerId);
                if (closure === undefined) throw new Error("Review closure unavailable");
                assertLiveReviewClosureFits(closure);
              }
            } catch (error) {
              disclosureFailures.push(
                disclosure.redactError(error instanceof Error ? error.message : "admission failed")
              );
              throw error;
            }
          },
        },
        hostOperationAdapters: createScaOrdinaryHostAdapters(runtime),
      });
      embedding.capture = (owner) => {
        service = owner;
        disclosure = syntheticDisclosure({ root, repository: REPOSITORY, store: owner.artifacts });
      };
      let tool: LiveSkillTool | undefined;
      // The extension owns a separate strict program, checked independently.
      const skillModule: unknown = await import(
        new URL("../../../.pi/extensions/skill/index.ts", import.meta.url).href
      );
      if (!isSkillEntrypoint(skillModule)) throw new Error("Generic skill module invalid");
      skillModule.default(
        createTestExtensionApi({
          onRegisterTool(value) {
            if (isSkillTool(value)) tool = value;
          },
        })
      );
      if (tool === undefined) throw new Error("Production generic skill entrypoint not registered");
      const result = await tool.execute(
        runId,
        {
          skill_name: "sca",
          session_id: runId,
          goal,
          constraints: {
            schema_version: 1,
            source_root: fixture.source,
            scope: { include: [], exclude: [] },
            execution_mode: "static_only",
            advanced: { application_tests: [], learning: [], promotions: [], rescans: [] },
            model: "deepseek-flash",
            analysis_tools: live.analysis_tools,
          },
        },
        cancellation.signal,
        (update) => {
          if (isRecord(update) && isRecord(update.details))
            console.log(
              `ordinary-live progress ${String(update.details.state_id ?? update.details.stage)}`
            );
        },
        {
          cwd: fixture.project,
          isProjectTrusted: () => false,
          ui: { theme: { fg: (_color: string, text: string) => text }, notify: () => undefined },
        }
      );
      skillResult = result.details;
    } catch (error) {
      failure =
        disclosure?.redactError(error instanceof Error ? error.message : String(error)) ??
        "Live setup failed before disclosure policy binding";
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      // The generic entrypoint disposes its own service normally. Reopen only for
      // exact evidence reads, never replay/execute/recover another provider call.
      if (service !== undefined) {
        service = new OrchestrationService({
          projectRoot: fixture.project,
          env,
          playbookName: "sca",
        });
      }
      const context = service?.checkpointer.loadRunById(runId);
      const refs = context?.selectedArtifacts ?? [];
      selectedKinds = refs.map((ref) => ref.kind);
      const products: { kind: string; artifact_id: string; sha256: string; file: string }[] = [];
      if (service !== undefined) {
        for (const ref of refs) {
          if (
            [
              "semantic-core",
              "sca-report-markdown",
              "sca-report-sarif",
              "sca-report-validation",
              "sca-output-manifest",
              "sca-preparation-result",
              "sca-reconciliation",
            ].includes(ref.kind)
          ) {
            const suffix = ref.kind === "sca-report-markdown" ? "md" : "json";
            const name = `${ref.kind}-${ref.version}.${suffix}`;
            const bytes = service.artifacts.readById(ref.artifact_id);
            if (sha256(bytes) !== ref.content_digest) failure = "Live final product hash mismatch";
            atomicBytes(path.join(attemptRoot, name), bytes);
            products.push({
              kind: ref.kind,
              artifact_id: ref.artifact_id,
              sha256: ref.content_digest,
              file: name,
            });
          }
        }
      }
      const lineage = [
        ...new Map(
          [...refs, ...invocations.flatMap((item) => item.inputArtifacts)].map((ref) => [
            ref.artifact_id,
            ref,
          ])
        ).values(),
      ];
      if (service !== undefined) {
        for (const ref of lineage) {
          const bytes = service.artifacts.readById(ref.artifact_id);
          if (sha256(bytes) !== ref.content_digest || bytes.length !== ref.byte_length)
            failure = "Live lineage exact-byte mismatch";
          else
            atomicBytes(path.join(attemptRoot, "exact-artifacts", `${ref.artifact_id}.bin`), bytes);
        }
      }
      const sourceHashes = fixture.hashes.map((item) => ({
        ...item,
        final_sha256: sha256(readFileSync(path.join(fixture.source, item.path))),
      }));
      atomicJson(path.join(attemptRoot, "report.json"), {
        schema_version: 1,
        run_id: runId,
        status: terminal?.action ?? "ERROR",
        failure,
        entrypoint:
          "registered skill tool -> ordinary OrchestrationService/registry/engine/runner/host/artifacts -> default PiAgentClient/createAgentSession/session.prompt",
        skill_extension_entrypoint: "registered skill.execute (real provider; default reader)",
        skill_result: skillResult ?? null,
        preparation_cache: live.preparation_cache ?? null,
        production_guard_attachment:
          "default OrchestrationService PiAgentClient + scaModel host consent; observe-only attachment spy",
        production_registration:
          "unmodified SCA_PLAYBOOK_REGISTRATION; required_model checked on all phases",
        native_process_count: nativeCount,
        cached_preparation: cachedPreparation,
        source_hashes: sourceHashes,
        loaded_source_hashes: loadedSourceHashes,
        exact_lineage: lineage,
        accepted_stages: Object.keys(SCA_AGENT_BY_STATE).filter((state) =>
          selectedKinds.includes(`sca-${state.replaceAll("_", "-")}`)
        ),
        invocations: invocations.map((item) => ({
          state: item.stateId,
          agent: item.agent,
          workflow_session: item.workflowSession ?? null,
          purpose: item.executionPurpose ?? "phase",
          task_sha256: sha256(item.task),
          inputs: item.inputArtifacts,
          required_model: item.registration?.required_model ?? null,
        })),
        phases: invocations.map((item) => item.stateId),
        limits: LIMITS,
        review_closures: [...reviewClosures].map(([worker_id, closure]) => ({
          worker_id,
          ...closure,
        })),
        routing_repair_sessions_limit: SCA_ROUTING_REPAIR_SESSION_LIMIT,
        repairs_admitted: invocations.filter((item) => item.executionPurpose === "routing_repair")
          .length,
        invocation_purposes: invocations.map((item) => ({
          state: item.stateId,
          purpose: item.executionPurpose ?? "phase",
        })),
        preparation_bindings: preparationBindings,
        sdk_retry: false,
        compaction: true,
        compaction_enabled_sessions: compactionEnabledSessions,
        compaction_events: compactionEvents,
        cache_warming: false,
        advanced_operands: "empty; application execution, promotion and rescan not admitted",
        thinking_level: "off",
        actual_provider_request_count: guard?.requests.length ?? 0,
        budget_observed: {
          input_token_upper_bound:
            guard?.requests.reduce((sum, item) => sum + item.inputTokenUpperBound, 0) ?? 0,
          output_tokens_reserved:
            guard?.requests.reduce((sum, item) => {
              if (item.maxOutputTokens === null)
                throw new Error("Explicit live cohort lacks its serialized output ceiling");
              return sum + item.maxOutputTokens;
            }, 0) ?? 0,
          provider_reported_input_tokens:
            guard?.responses.reduce((sum, item) => sum + item.input, 0) ?? 0,
          provider_reported_output_tokens:
            guard?.responses.reduce((sum, item) => sum + item.output, 0) ?? 0,
        },
        requests: guard?.requests ?? [],
        responses: guard?.responses ?? [],
        denials: guard?.denials ?? [],
        disclosure_failures: disclosureFailures,
        tool_events: toolEvents,
        artifact_reads: disclosure?.reads ?? [],
        artifacts: refs,
        products,
        terminal: terminal ?? null,
        events: service?.checkpointer.events(runId) ?? [],
      });
      console.log(`ORDINARY_DEEPSEEK_REPORT=${path.join(attemptRoot, "report.json")}`);
      service?.close();
      attachment.mockRestore();
      execution.mockRestore();
      delete embedding.configure;
      delete embedding.capture;
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(failure).toBeNull();
    expect(skillResult?.state).toBe(terminal?.action);
    if (live.preparation_cache !== undefined) {
      expect(cachedPreparation).toBe(true);
      expect(nativeCount).toBe(0);
    }
    expect(compactionEnabledSessions.length).toBeGreaterThan(0);
    expect(compactionEnabledSessions.every((item) => item.enabled)).toBe(true);
    expect(guard?.denials).toEqual([]);
    expect(guard?.requests.length).toBeGreaterThan(0);
    expect(guard?.requests.length).toBeLessThanOrEqual(LIMITS.calls);
    expect(
      guard?.responses.every(
        (item) =>
          item.error === null &&
          item.provider === SCA_REQUIRED_MODEL.provider &&
          item.model === SCA_REQUIRED_MODEL.model &&
          item.responseModel !== null &&
          SCA_PROVIDER_RESPONSE_MODEL_IDS.includes(item.responseModel)
      )
    ).toBe(true);
    // Repairs may repeat a state but cannot substitute for any of the ten accepted stages.
    const ordinaryStates = invocations
      .filter((item) => item.executionPurpose !== "routing_repair")
      .map((item) => item.stateId);
    expect([...new Set(ordinaryStates)]).toEqual(Object.keys(SCA_AGENT_BY_STATE));
    expect(
      invocations.filter((item) => item.executionPurpose === "routing_repair").length
    ).toBeLessThanOrEqual(SCA_ROUTING_REPAIR_SESSION_LIMIT);
    expect(["complete", "incomplete"]).toContain(terminal?.action);
    for (const state of Object.keys(SCA_AGENT_BY_STATE))
      expect(selectedKinds).toContain(`sca-${state.replaceAll("_", "-")}`);
    for (const kind of [
      "semantic-core",
      "sca-report-markdown",
      "sca-report-sarif",
      "sca-report-validation",
      "sca-output-manifest",
    ])
      expect(selectedKinds).toContain(kind);
    for (const source of fixture.hashes)
      expect(sha256(readFileSync(path.join(fixture.source, source.path)))).toBe(source.sha256);
    if (terminal?.action !== "complete" && terminal?.action !== "incomplete")
      throw new Error("Live workflow did not return a terminal report");
    const coreRef = terminal.artifacts?.find((ref) => ref.kind === "semantic-core");
    if (coreRef === undefined) throw new Error("Live terminal has no semantic report");
    const core = validateContract(
      ScaReportProductSchema,
      JSON.parse(
        readFileSync(path.join(attemptRoot, `semantic-core-${coreRef.version}.json`), "utf8")
      ),
      "Live captured semantic report"
    );
    const markdownRef = terminal.artifacts?.find((ref) => ref.kind === "sca-report-markdown");
    const sarifRef = terminal.artifacts?.find((ref) => ref.kind === "sca-report-sarif");
    if (markdownRef === undefined || sarifRef === undefined)
      throw new Error("Live terminal is missing an exact report representation");
    const markdown = readFileSync(
      path.join(attemptRoot, `sca-report-markdown-${markdownRef.version}.md`),
      "utf8"
    );
    const sarif: unknown = JSON.parse(
      readFileSync(path.join(attemptRoot, `sca-report-sarif-${sarifRef.version}.json`), "utf8")
    );
    expect(validateScaReportRepresentations(core, markdown, sarif)).toEqual([]);
    for (const state of ["reviewing_report", "verifying_final_product"]) {
      const invocation = invocations.filter((item) => item.stateId === state).at(-1);
      const ref = terminal.artifacts?.find(
        (item) => item.kind === `sca-${state.replaceAll("_", "-")}`
      );
      // Reviews may be manifest-bound rather than terminal-selected.
      const persisted: unknown = JSON.parse(
        readFileSync(path.join(attemptRoot, "report.json"), "utf8")
      );
      if (!isRecord(persisted) || !Array.isArray(persisted.artifacts))
        throw new Error("Missing final review refs");
      const selected: unknown = persisted.artifacts.find(
        (item: unknown) => isRecord(item) && item.kind === `sca-${state.replaceAll("_", "-")}`
      );
      const reviewId = ref?.artifact_id ?? (isRecord(selected) ? selected.artifact_id : undefined);
      if (typeof reviewId !== "string" || invocation === undefined)
        throw new Error("Missing accepted independent review");
      const review = parseScaReview(
        JSON.parse(
          readFileSync(path.join(attemptRoot, "exact-artifacts", `${reviewId}.bin`), "utf8")
        )
      );
      if (disclosure === undefined) throw new Error("Missing live exact-read receipts");
      for (const input of invocation.inputArtifacts)
        expect(
          hasCompleteArtifactRead(disclosure.reads, invocation, input),
          `${state} must read every byte of its own ${input.kind} input`
        ).toBe(true);
      expect(review.report_artifact_id).toBe(coreRef.artifact_id);
      expect(review.report_sha256).toBe(coreRef.content_digest);
      expect(review.verdict).toBe("PASS");
      for (const input of invocation.inputArtifacts.filter((item) =>
        ["sca-evidence-result", "sca-focused-sources", "sca-advanced-summary"].includes(item.kind)
      ))
        expect(review.checked_evidence_ids).toContain(input.artifact_id);
      expect(
        review.checked_evidence_ids.every((id) =>
          invocation.inputArtifacts.some((item) => item.artifact_id === id)
        )
      ).toBe(true);
    }
    expect(core.target_executed).toBe(false);
    expect(core.reproduction).toBe("NOT RUN");
    expect(core.findings.some((finding) => finding.status === "Confirmed — code verified")).toBe(
      false
    );
  }, 0);
});
