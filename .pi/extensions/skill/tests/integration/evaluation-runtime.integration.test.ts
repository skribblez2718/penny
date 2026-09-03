import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

interface SessionCapture {
  readonly requested: readonly string[];
  readonly active: readonly string[];
  prompt?: string;
}

const providerHarness = vi.hoisted(() => ({
  captures: [] as SessionCapture[],
  candidateSessions: new WeakSet<object>(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn(async (...args: Parameters<typeof actual.createAgentSession>) => {
      const created = await actual.createAgentSession(...args);
      const capture: SessionCapture = {
        requested: [...(args[0]?.tools ?? [])],
        active: [...created.session.getActiveToolNames()],
      };
      providerHarness.captures.push(capture);
      vi.spyOn(created.session, "prompt").mockImplementation(async (prompt) => {
        capture.prompt = prompt;
        const taskId = prompt.match(/"task_id":"([^"]+)"/u)?.[1];
        if (taskId === undefined) throw new Error("provider stub task ID is absent");
        const expected: Readonly<Record<string, string>> = {
          "synthetic-task-alpha": "alpha",
          "synthetic-task-beta": "beta",
          "synthetic-task-gamma-protected": "gamma",
          "synthetic-task-delta-negative-trigger": "delta",
          "synthetic-readiness-calibration": "alpha",
          "synthetic-readiness-calibration-two": "beta",
        };
        const answer = expected[taskId];
        if (answer === undefined) throw new Error(`provider stub task '${taskId}' is unknown`);
        const candidate =
          args[0]?.sessionManager !== undefined &&
          providerHarness.candidateSessions.has(args[0].sessionManager);
        const deltaTask = taskId === "synthetic-task-alpha" || taskId === "synthetic-task-beta";
        const selectedAnswer = deltaTask && !candidate ? `wrong-${answer}` : answer;
        const text = `${JSON.stringify({
          answer: selectedAnswer,
          schema_version: 1,
          task_id: taskId,
          trigger_predicted: taskId !== "synthetic-task-delta-negative-trigger",
        })}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`;
        const message = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text }],
          api: "anthropic-messages",
          provider: "offline-synthetic",
          model: "known-delta-v1",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        created.session.messages.push(message);
        args[0]?.sessionManager?.appendMessage(message);
      });
      return created;
    }),
  };
});

import { registerTool } from "../../../../lib/pi-tool-registration.js";
import {
  ArtifactStore,
  CANDIDATE_PLAYBOOK_REGISTRY,
  LivenessExhaustedError,
  PiAgentClient,
  canonicalJson,
  initializePennyState,
  resolvePennyRuntimeState,
  validateContract,
  type AgentCompletion,
  type AgentInvocation,
  type PiAgentClientOptions,
} from "@penny/orchestration/source";

import { discoverSkillsFromDirectory } from "../../skill-discovery.js";
import {
  pairedEvaluationPlanSha256,
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
} from "../../evaluation-contracts.js";
import {
  ArtifactEvaluationTrialJournal,
  DETERMINISTIC_GRADING_DEFINITION,
  DIRECT_DEMETRI_BASELINE_REGISTRATION,
  GenericEvaluationTrialExecutor,
  RealTopologyEvaluationReadinessPreflight,
  SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
  SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
  executeFrozenPairedEvaluation,
  evaluationImplementationBindingSha256,
  evaluationReadinessCalibrationCohortSha256,
  evaluationReadinessResultId,
  freezePairedEvaluation,
  validateEvaluationReadinessResult,
  syntheticEvaluationImplementationBinding,
  syntheticEvaluationRuntimeFunctions,
  type EvaluationCommonWireValidatorV1,
  type EvaluationModelClientFactoryV1,
  type EvaluationRuntimeBindingV1,
  type EvaluationRuntimeMeasurementV1,
  type MeasuredEvaluationModelClientV1,
} from "../../evaluation-runner.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const roots: string[] = [];

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, "evals", "fixtures", name), "utf8"));
}

const SyntheticReadinessWireSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    task_id: Type.String({ minLength: 1 }),
    answer: Type.String({ minLength: 1 }),
    trigger_predicted: Type.Boolean(),
  },
  { additionalProperties: false }
);

function validateSyntheticReadinessWire(
  input: Parameters<EvaluationCommonWireValidatorV1>[0]
): void {
  const parsed: unknown = JSON.parse(input.wire_bytes);
  const wire = validateContract(
    SyntheticReadinessWireSchema,
    parsed,
    "synthetic readiness common wire"
  );
  if (canonicalJson(wire) !== input.wire_bytes) {
    throw new Error("synthetic readiness common wire is invalid");
  }
}

function implementation(
  planValue: unknown,
  populationValue: unknown = fixture("synthetic-known-delta.population.v1.json")
) {
  const runtimeFunctions = syntheticEvaluationRuntimeFunctions();
  return {
    implementationBinding: syntheticEvaluationImplementationBinding({
      projectRoot: PROJECT_ROOT,
      population: populationValue,
      plan: planValue,
      runtimeFunctions,
    }),
    runtimeFunctions,
  };
}

function stateFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const candidate = path.join(directory, name);
      const stats = lstatSync(candidate);
      if (stats.isDirectory()) visit(candidate);
      else if (stats.isFile()) files.push(candidate);
    }
  };
  visit(root);
  return files;
}

function declaredDemetriTools(): string[] {
  const document = readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", "demetri.md"), "utf8");
  const frontmatter = document.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
  const line = frontmatter.split(/\r?\n/u).find((candidate) => candidate.startsWith("tools:"));
  if (line === undefined) throw new Error("Demetri tools are absent");
  return line
    .slice("tools:".length)
    .split(",")
    .map((name) => name.trim());
}

function unavailableMemoryExtension(names: readonly string[]): InlineExtension {
  return (pi) => {
    for (const name of names) {
      registerTool(pi, {
        name,
        label: name,
        description: "Deterministic unavailable optional-memory evaluation fixture",
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute() {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: { code: "MEMPALACE_UNAVAILABLE", retryable: true },
                }),
              },
            ],
            details: {},
          };
        },
      });
    }
  };
}

class ProviderStubMeasuredClient implements MeasuredEvaluationModelClientV1 {
  readonly invocations: AgentInvocation[] = [];
  private readonly client: PiAgentClient;

  constructor(
    readonly runtime_binding: EvaluationRuntimeBindingV1,
    workerExtensions: readonly InlineExtension[],
    variant: "baseline" | "candidate",
    catalogSessions?: { readonly projectId: string; readonly root: string }
  ) {
    const fixtureModel = {
      id: runtime_binding.model,
      name: `Offline paired-evaluation provider stub ${variant}`,
      api: "openai-completions",
      provider: runtime_binding.provider,
      baseUrl: "http://127.0.0.1:1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 4_096,
    } satisfies Awaited<ReturnType<NonNullable<PiAgentClientOptions["resolveModel"]>>>;
    this.client = new PiAgentClient({
      resolveModel: () => fixtureModel,
      workerExtensions,
      ...(catalogSessions === undefined
        ? {
            testOnlySessionManagerFactory: (invocation: AgentInvocation) => {
              const manager = SessionManager.inMemory(invocation.projectRoot);
              if (variant === "candidate") providerHarness.candidateSessions.add(manager);
              return manager;
            },
          }
        : { catalogSessions }),
    });
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    return this.client.runAgent(invocation);
  }

  measurement(_runId: string): EvaluationRuntimeMeasurementV1 {
    const candidate =
      this.invocations.at(-1)?.registration.workflow_name === SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME;
    return {
      cost_microusd: candidate ? 110 : 100,
      latency_ms: candidate ? 11 : 10,
    };
  }
}

afterEach(() => {
  providerHarness.captures.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("P6 real generic paired evaluation runtime", () => {
  it("executes baseline and candidate through registry, service, worker, Pi ingress, liveness, artifacts, and exact Demetri YAML tools", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-evaluation-runtime-"));
    roots.push(temporary);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(temporary, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    initializePennyState(PROJECT_ROOT, { env });
    const declared = declaredDemetriTools();
    const memoryTools = declared.filter((name) => name.startsWith("memory_"));
    const clients: ProviderStubMeasuredClient[] = [];
    const ordering: string[] = [];
    const factory: EvaluationModelClientFactoryV1 = Object.assign(
      ({ plan, entry }: Parameters<EvaluationModelClientFactoryV1>[0]) => {
        ordering.push("client");
        const client = new ProviderStubMeasuredClient(
          plan.runtime_binding,
          [unavailableMemoryExtension(memoryTools)],
          entry.variant === "baseline" ? "baseline" : "candidate"
        );
        clients.push(client);
        return client;
      },
      {
        preflight: async () => {
          ordering.push("preflight");
        },
      }
    );
    const executor = new GenericEvaluationTrialExecutor({
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      modelClientFactory: factory,
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));

    const population = fixture("synthetic-known-delta.population.v1.json");
    const plan = fixture("synthetic-known-delta.plan.v1.json");
    const frozen = freezePairedEvaluation({
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(plan),
    });
    const authorizationRefusal = await executeFrozenPairedEvaluation({
      frozen,
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(plan),
      executor,
      semanticReviewCoordinator: {
        preflight: async () => {
          throw new Error("operator authorization absent");
        },
        review: async () => {
          throw new Error("review must not run without authorization");
        },
      },
    });
    expect(authorizationRefusal.result).toMatchObject({
      disposition: "INVALID_EVALUATION",
      invalid_evaluation: {
        stage: "semantic_review",
        code: "SEMANTIC_REVIEW_AUTHORIZATION_FAILED",
      },
      semantic_qualification: {
        status: "INVALID_EVALUATION",
        provider_calls: 0,
      },
    });
    expect(authorizationRefusal.execution_accounting.newly_started_trials).toBe(0);
    expect(ordering).toEqual([]);
    expect(clients).toHaveLength(0);

    using journal = new ArtifactEvaluationTrialJournal({
      projectRoot: PROJECT_ROOT,
      env,
      frozen,
    });
    const run = await executeFrozenPairedEvaluation({
      frozen,
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(plan),
      executor,
      trialJournal: journal,
      maxConcurrency: 2,
    });

    expect(run.result.disposition).toBe("CANDIDATE");
    expect(ordering[0]).toBe("preflight");
    expect(ordering.indexOf("client")).toBeGreaterThan(ordering.indexOf("preflight"));
    expect(run.result.aggregate_deltas.primary_delta).toBe(0.5);
    expect(run.result.trial_accounting).toMatchObject({ scheduled: 8, complete: 8 });
    expect(run.execution_accounting).toEqual({
      newly_started_trials: 8,
      newly_recorded_terminals: 8,
      retained_journal_observations: 0,
      outstanding_schedule_entries: 0,
      loopback_provider_calls: 0,
    });
    expect(run.semantic_qualification).toEqual({
      status: "NOT_QUALIFIED",
      reason_code: "SEMANTIC_REVIEW_NOT_CONFIGURED",
      provider_calls: 0,
      trial_qualifications: [],
    });
    expect(run.result.complete_pair_coverage.coverage).toBe(1);
    expect(run.result_artifact_ref).toMatchObject({
      kind: "evaluation-result",
      content_schema: {
        schema_id: "penny.paired-evaluation-result.v1",
        schema_version: 1,
      },
    });
    expect(clients).toHaveLength(8);
    const invocations = clients.flatMap((client) => client.invocations);
    expect(invocations).toHaveLength(8);
    expect(new Set(invocations.map((invocation) => invocation.registration.workflow_name))).toEqual(
      new Set(["evaluation-direct-demetri", "synthetic-known-delta-candidate"])
    );
    expect(
      invocations.every(
        (invocation) =>
          invocation.livenessBudget?.preset === "offline-paired-evaluation-v2" &&
          invocation.livenessBudget.external_requests.effective_remaining === 0
      )
    ).toBe(true);
    expect(providerHarness.captures).toHaveLength(8);
    for (const capture of providerHarness.captures) {
      expect(capture.requested).toEqual(declared);
      expect([...capture.active].sort()).toEqual([...declared].sort());
      expect(capture.prompt).toContain("# Direct Demetri Paired Evaluation");
      expect(capture.prompt).toContain("HOST-ENFORCED LIVENESS BUDGET:");
    }
    expect(network).not.toHaveBeenCalled();
    const clientCount = clients.length;
    const resumed = await executeFrozenPairedEvaluation({
      frozen,
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(plan),
      executor: {
        async execute() {
          throw new Error("resumed evaluation must not re-execute an immutable trial");
        },
      },
      trialJournal: journal,
      maxConcurrency: 2,
    });
    expect(resumed.result.result_id).toBe(run.result.result_id);
    expect(resumed.execution_accounting).toEqual({
      newly_started_trials: 0,
      newly_recorded_terminals: 0,
      retained_journal_observations: 8,
      outstanding_schedule_entries: 0,
      loopback_provider_calls: 0,
    });
    expect(resumed.semantic_qualification.provider_calls).toBe(0);
    expect(resumed.semantic_qualification.status).toBe("NOT_QUALIFIED");
    expect(clients).toHaveLength(clientCount);
    expect(frozen.schedule.every((entry) => journal.load(entry).recorded)).toBe(true);
    expect(DIRECT_DEMETRI_BASELINE_REGISTRATION.ingress).toBe("skill");
    expect([...CANDIDATE_PLAYBOOK_REGISTRY.keys()]).toEqual([
      "assess",
      "decide",
      "diagnose",
      "plan",
      "produce",
    ]);
    const discovered = discoverSkillsFromDirectory(path.join(PROJECT_ROOT, ".pi", "skills"));
    expect(discovered.map((skill) => skill.name)).not.toContain(
      SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME
    );

    const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
    using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    const reread = artifacts.readById(run.result_artifact_ref.artifact_id).toString("utf8");
    expect(reread).toBe(canonicalJson(run.result));
  }, 120_000);

  it("runs non-scoring real-topology readiness for every arm before held-out trial 1", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-evaluation-readiness-"));
    roots.push(temporary);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(temporary, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    initializePennyState(PROJECT_ROOT, { env });
    const population = validateEvaluationPopulation(
      fixture("synthetic-known-delta.population.v1.json")
    );
    const basePlan = validatePairedEvaluationPlan(fixture("synthetic-known-delta.plan.v1.json"));
    const oracleMarker = "READINESS_ORACLE_SENTINEL_7E47A9";
    const readinessCohort = {
      schema_version: 1,
      split: "calibration",
      cohort_id: "synthetic-readiness-cohort",
      revision: 1,
      scoring: "non_scoring",
      tasks: [
        {
          schema_version: 1,
          split: "calibration",
          task_id: "synthetic-readiness-calibration",
          goal: "Return the first calibration answer through the registered output topology.",
          constraints: { task_id: "synthetic-readiness-calibration" },
          exact_input_artifact_ids: [],
          host_only_oracle_markers: [oracleMarker],
        },
        {
          schema_version: 1,
          split: "calibration",
          task_id: "synthetic-readiness-calibration-two",
          goal: "Return the second calibration answer through the registered output topology.",
          constraints: { task_id: "synthetic-readiness-calibration-two" },
          exact_input_artifact_ids: [],
          host_only_oracle_markers: ["READINESS_ORACLE_SENTINEL_18C2F0"],
        },
      ],
    };
    const provisionalPlan = validatePairedEvaluationPlan({
      ...basePlan,
      implementation_binding_sha256: "0".repeat(64),
      comparison_validity_policy: {
        ...basePlan.comparison_validity_policy,
        readiness_preflight: {
          ...basePlan.comparison_validity_policy.readiness_preflight,
          required: true,
          calibration_cohort_sha256: evaluationReadinessCalibrationCohortSha256(readinessCohort),
          repetitions: 1,
          baseline_normalized_completion_floor: 1,
          candidate_normalized_completion_floor: 1,
          required_comparator_normalized_completion_floors: [],
        },
      },
    });
    const declared = declaredDemetriTools();
    const memoryTools = declared.filter((name) => name.startsWith("memory_"));
    const startedTaskIds: string[] = [];
    const clients: ProviderStubMeasuredClient[] = [];
    let commonWireChecks = 0;
    const validateReadinessCommonWire: EvaluationCommonWireValidatorV1 = (input) => {
      commonWireChecks += 1;
      validateSyntheticReadinessWire(input);
    };
    const modelClientFactory: EvaluationModelClientFactoryV1 = ({ entry, plan }) => {
      startedTaskIds.push(entry.task_id);
      const client = new ProviderStubMeasuredClient(
        plan.runtime_binding,
        [unavailableMemoryExtension(memoryTools)],
        entry.variant === "baseline" ? "baseline" : "candidate"
      );
      clients.push(client);
      return client;
    };
    const runtimeFunctions = [
      {
        role: "artifact_preflight" as const,
        owner: "offline-readiness",
        implementation: GenericEvaluationTrialExecutor.prototype.preflight,
      },
      {
        role: "model_client_factory" as const,
        owner: "offline-readiness",
        implementation: modelClientFactory,
      },
      {
        role: "model_preflight" as const,
        owner: "offline-readiness",
        implementation: GenericEvaluationTrialExecutor.prototype.preflight,
      },
      {
        role: "readiness_preflight" as const,
        owner: "offline-readiness",
        implementation: RealTopologyEvaluationReadinessPreflight.prototype.preflight,
      },
      {
        role: "readiness_common_wire_validator" as const,
        owner: "offline-readiness",
        implementation: validateReadinessCommonWire,
      },
      {
        role: "trial_executor_execute" as const,
        owner: "offline-readiness",
        implementation: GenericEvaluationTrialExecutor.prototype.execute,
      },
      {
        role: "trial_executor_preflight" as const,
        owner: "offline-readiness",
        implementation: GenericEvaluationTrialExecutor.prototype.preflight,
      },
    ];
    const implementationBinding = syntheticEvaluationImplementationBinding({
      projectRoot: PROJECT_ROOT,
      population,
      plan: provisionalPlan,
      runtimeFunctions,
    });
    const plan = validatePairedEvaluationPlan({
      ...provisionalPlan,
      implementation_binding_sha256: evaluationImplementationBindingSha256(implementationBinding),
    });
    const frozen = freezePairedEvaluation({
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      implementationBinding,
      runtimeFunctions,
    });
    const executor = new GenericEvaluationTrialExecutor({
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      modelClientFactory,
    });
    const readinessPreflight = new RealTopologyEvaluationReadinessPreflight({
      projectRoot: PROJECT_ROOT,
      env,
      calibrationCohort: readinessCohort,
      executor,
      validateCommonWire: validateReadinessCommonWire,
    });
    const run = await executeFrozenPairedEvaluation({
      frozen,
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      executor,
      readinessPreflight,
      implementationBinding,
      runtimeFunctions,
    });

    expect(startedTaskIds.slice(0, 4)).toEqual([
      "synthetic-readiness-calibration",
      "synthetic-readiness-calibration",
      "synthetic-readiness-calibration-two",
      "synthetic-readiness-calibration-two",
    ]);
    expect(startedTaskIds.slice(4)).not.toContain("synthetic-readiness-calibration");
    expect(clients.slice(0, 4).flatMap((client) => client.invocations)).toHaveLength(4);
    expect(
      clients
        .slice(0, 4)
        .flatMap((client) => client.invocations)
        .every((invocation) => !canonicalJson(invocation).includes(oracleMarker))
    ).toBe(true);
    expect(run.result.invalid_evaluation).toBeUndefined();
    const clientCountBeforeReadinessResume = clients.length;
    const resumedReadiness = await readinessPreflight.run({
      frozen,
      population,
      plan,
      gradingDefinition: DETERMINISTIC_GRADING_DEFINITION,
    });
    const resumedReadinessClients = clients.slice(clientCountBeforeReadinessResume);
    expect(resumedReadinessClients).toHaveLength(4);
    expect(resumedReadinessClients.flatMap((client) => client.invocations)).toHaveLength(0);
    expect(commonWireChecks).toBe(8);
    expect(resumedReadiness.result).toMatchObject({
      plan_id: frozen.plan_id,
      plan_sha256: frozen.plan_sha256,
      schedule_sha256: frozen.schedule_sha256,
      implementation_binding_sha256: frozen.implementation_binding_sha256,
      passed: true,
      execution_accounting: {
        newly_started_trials: 0,
        resumed_existing_runs: 4,
        adopted_existing_outputs: 4,
        loopback_provider_calls: 0,
      },
      common_wire_validation: {
        attempted_trials: 4,
        passed_trials: 4,
        failed_trials: 0,
        all_passed: true,
      },
    });
    expect(resumedReadiness.result.trials).toHaveLength(4);
    expect(resumedReadiness.result.failures).toEqual([]);
    expect(resumedReadiness.result.arms.every((arm) => arm.normalized_completion_rate === 1)).toBe(
      true
    );
    expect(resumedReadiness.result.complete_all_arm_pairs).toMatchObject({
      scheduled_pairs: 2,
      complete_pairs: 2,
      coverage: 1,
      passed: true,
    });
    const readinessState = resolvePennyRuntimeState(PROJECT_ROOT, { env });
    using readinessArtifacts = ArtifactStore.openExisting(readinessState.paths.artifacts.root, {
      projectId: readinessState.projectId,
    });
    expect(
      readinessArtifacts.readById(resumedReadiness.result_artifact_ref.artifact_id).toString("utf8")
    ).toBe(canonicalJson(resumedReadiness.result));
    const { readiness_result_id: _readinessResultId, ...tamperedReadinessBody } =
      resumedReadiness.result;
    expect(() =>
      validateEvaluationReadinessResult(
        {
          ...tamperedReadinessBody,
          passed: false,
          readiness_result_id: evaluationReadinessResultId({
            ...tamperedReadinessBody,
            passed: false,
          }),
        },
        plan
      )
    ).toThrow(/pass\/fail projection/u);
    expect(() =>
      validateEvaluationReadinessResult(
        {
          ...resumedReadiness.result,
          unbound_field: true,
        },
        plan
      )
    ).toThrow();

    let eightyFloorPlan: ReturnType<typeof validatePairedEvaluationPlan> | undefined;
    let eightyFloorBody: Omit<typeof resumedReadiness.result, "readiness_result_id"> | undefined;
    for (const policy of [
      { armFloor: 0.9, pairFloor: 0.8 },
      { armFloor: 0.95, pairFloor: 0.9 },
      { armFloor: 1, pairFloor: 1 },
    ]) {
      const floorPlan = validatePairedEvaluationPlan({
        ...plan,
        comparison_validity_policy: {
          ...plan.comparison_validity_policy,
          nonzero_candidate_complete_pair_coverage_floor: policy.pairFloor,
          readiness_preflight: {
            ...plan.comparison_validity_policy.readiness_preflight,
            baseline_normalized_completion_floor: policy.armFloor,
            candidate_normalized_completion_floor: policy.armFloor,
            complete_all_arm_pair_floor: policy.pairFloor,
          },
        },
      });
      const floorBody = {
        ...tamperedReadinessBody,
        plan_sha256: pairedEvaluationPlanSha256(floorPlan),
        arms: tamperedReadinessBody.arms.map((arm) => ({
          ...arm,
          frozen_floor: policy.armFloor,
        })),
        complete_all_arm_pairs: {
          ...tamperedReadinessBody.complete_all_arm_pairs,
          frozen_floor: policy.pairFloor,
        },
      };
      const floorResult = validateEvaluationReadinessResult(
        {
          ...floorBody,
          readiness_result_id: evaluationReadinessResultId(floorBody),
        },
        floorPlan
      );
      expect(floorResult.complete_all_arm_pairs.frozen_floor).toBe(policy.pairFloor);
      if (policy.pairFloor === 0.8) {
        eightyFloorPlan = floorPlan;
        eightyFloorBody = floorBody;
      }
    }
    if (eightyFloorPlan === undefined || eightyFloorBody === undefined) {
      throw new Error("0.80 readiness floor fixture was not constructed");
    }
    const driftedFloorBody = {
      ...eightyFloorBody,
      complete_all_arm_pairs: {
        ...eightyFloorBody.complete_all_arm_pairs,
        frozen_floor: 0.9,
      },
    };
    expect(() =>
      validateEvaluationReadinessResult(
        {
          ...driftedFloorBody,
          readiness_result_id: evaluationReadinessResultId(driftedFloorBody),
        },
        eightyFloorPlan
      )
    ).toThrow(/pair floor does not match its frozen plan/u);
    const incoherentPassBody = {
      ...eightyFloorBody,
      passed: false,
      complete_all_arm_pairs: {
        ...eightyFloorBody.complete_all_arm_pairs,
        passed: false,
      },
    };
    expect(() =>
      validateEvaluationReadinessResult(
        {
          ...incoherentPassBody,
          readiness_result_id: evaluationReadinessResultId(incoherentPassBody),
        },
        eightyFloorPlan
      )
    ).toThrow(/all-arm pair coverage is inconsistent/u);

    const clientsBeforeDrift = clients.length;
    const driftedReadiness = new RealTopologyEvaluationReadinessPreflight({
      projectRoot: PROJECT_ROOT,
      env,
      calibrationCohort: {
        ...readinessCohort,
        revision: readinessCohort.revision + 1,
      },
      executor,
      validateCommonWire: validateReadinessCommonWire,
    });
    await expect(
      driftedReadiness.preflight({
        frozen,
        population,
        plan,
        gradingDefinition: DETERMINISTIC_GRADING_DEFINITION,
      })
    ).rejects.toMatchObject({
      stage: "readiness_preflight",
      code: "READINESS_PREFLIGHT_FAILED",
      trialId: null,
    });
    expect(clients).toHaveLength(clientsBeforeDrift);

    const floorFailingReadiness = new RealTopologyEvaluationReadinessPreflight({
      projectRoot: PROJECT_ROOT,
      env,
      calibrationCohort: readinessCohort,
      executor: {
        preflight: async () => undefined,
        execute: async ({ entry }) => ({
          trial_id: entry.trial_id,
          terminal_status: "error" as const,
          failure_code: "MODEL_EXECUTION_ERROR" as const,
          cost_microusd: 0,
          latency_ms: 0,
          started_new_trial: false,
          loopback_provider_calls: 0,
        }),
      },
      validateCommonWire: validateReadinessCommonWire,
    });
    await expect(
      floorFailingReadiness.preflight({
        frozen,
        population,
        plan,
        gradingDefinition: DETERMINISTIC_GRADING_DEFINITION,
      })
    ).rejects.toMatchObject({
      stage: "readiness_preflight",
      code: "READINESS_PREFLIGHT_FAILED",
      trialId: null,
    });
    expect(clients).toHaveLength(clientsBeforeDrift);

    expect(run.execution_accounting.newly_started_trials).toBe(frozen.schedule.length);
    expect(run.result.trials).toHaveLength(frozen.schedule.length);
    expect(run.result.disposition).toBe("CANDIDATE");
  }, 120_000);

  it("keeps distinctive host-only oracle markers out of baseline invocation, opening, sessions, and artifacts", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-evaluation-oracle-isolation-"));
    roots.push(temporary);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(temporary, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    initializePennyState(PROJECT_ROOT, { env });
    const populationValue = fixture("synthetic-known-delta.population.v1.json");
    const planValue = fixture("synthetic-known-delta.plan.v1.json");
    const population = validateEvaluationPopulation(populationValue);
    const plan = validatePairedEvaluationPlan(planValue);
    const frozen = freezePairedEvaluation({
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(planValue),
    });
    const entry = frozen.schedule.find((candidate) => candidate.variant === "baseline");
    if (entry === undefined) throw new Error("oracle-isolation baseline entry is absent");
    const originalTask = population.tasks.find((candidate) => candidate.task_id === entry.task_id);
    if (originalTask === undefined) throw new Error("oracle-isolation task is absent");
    const markers = [
      "SKRIBBLE_ORACLE_CASE_7F3A9D",
      "SKRIBBLE_EXPECTED_ANSWER_91C4E2",
      "SKRIBBLE_EXPECTED_OUTCOME_B8D20F",
      "SKRIBBLE_PROTECTED_FLAG_44A6CE",
      "SKRIBBLE_THRESHOLD_0D91B7",
      "SKRIBBLE_MUTATION_ORACLE_6E2AF8",
      "SKRIBBLE_GRADER_DESCRIPTOR_C3F509",
    ] as const;
    const hostOnlyGradingData = {
      grader_case_id: markers[0],
      trigger_expected: originalTask.trigger_expected,
      expected_answer: markers[1],
      expected_outcome: markers[2],
      protected_flag: markers[3],
      thresholds: markers[4],
      mutation_oracle: markers[5],
      grader_descriptor: markers[6],
    };
    expect(canonicalJson(hostOnlyGradingData)).toContain(markers[6]);
    const task = { ...originalTask, grader_case_id: hostOnlyGradingData.grader_case_id };
    const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
    const memoryTools = declaredDemetriTools().filter((name) => name.startsWith("memory_"));
    const client = new ProviderStubMeasuredClient(
      plan.runtime_binding,
      [unavailableMemoryExtension(memoryTools)],
      "baseline",
      { projectId: state.projectId, root: state.paths.subagentSessions }
    );
    const executor = new GenericEvaluationTrialExecutor({
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      modelClientFactory: () => client,
    });

    const observation = await executor.execute({ entry, task, plan, frozen });
    expect(observation).toMatchObject({ terminal_status: "complete", started_new_trial: true });
    expect(client.invocations).toHaveLength(1);
    const invocation = client.invocations[0];
    if (invocation === undefined) throw new Error("oracle-isolation invocation is absent");
    const taskValue: unknown = JSON.parse(invocation.task);
    expect(taskValue).toEqual({
      schema_version: 1,
      task_id: task.task_id,
      goal: task.goal,
      constraints: task.constraints,
    });
    const capture = providerHarness.captures[0];
    if (capture?.prompt === undefined) throw new Error("oracle-isolation opening is absent");
    const forbiddenFields = [
      "grader_case_id",
      "trigger_expected",
      "expected_answer",
      "expected_outcome",
      "protected_flag",
      "material_effect_threshold",
      "mutation_oracle",
      "grader_descriptor",
    ];
    const invocationSurface = canonicalJson({
      task: invocation.task,
      input_artifacts: invocation.inputArtifacts,
      model_override: invocation.modelOverride,
      registration: invocation.registration,
      workflow_session: invocation.workflowSession,
    });
    for (const field of forbiddenFields) {
      expect(invocation.task).not.toContain(field);
      expect(capture.prompt).not.toContain(field);
    }
    for (const marker of markers) {
      expect(invocationSurface).not.toContain(marker);
      expect(capture.prompt).not.toContain(marker);
      expect(observation.output_bytes).not.toContain(marker);
    }

    const persistedModelPaths = stateFiles(state.paths.root).filter(
      (file) => file.includes(`${path.sep}objects${path.sep}`) || file.endsWith(".jsonl")
    );
    expect(persistedModelPaths.some((file) => file.endsWith(".jsonl"))).toBe(true);
    for (const file of persistedModelPaths) {
      const bytes = readFileSync(file);
      const text = bytes.toString("utf8");
      for (const field of forbiddenFields) expect(text).not.toContain(field);
      for (const marker of markers) expect(text).not.toContain(marker);
    }
    for (const file of stateFiles(state.paths.root)) {
      const bytes = readFileSync(file);
      for (const marker of markers) {
        expect(bytes.includes(Buffer.from(marker, "utf8"))).toBe(false);
      }
    }
  }, 120_000);

  it.each([
    "grader_case_id",
    "trigger_expected",
    "expected_answer",
    "expected_outcome",
    "protected_flag",
    "material_effect_threshold",
    "mutation_oracle",
    "grader_descriptor",
  ])(
    "rejects nested host-only oracle field '%s' before baseline model or persistence",
    async (field) => {
      const temporary = mkdtempSync(path.join(tmpdir(), "penny-evaluation-oracle-negative-"));
      roots.push(temporary);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PENNY_STATE_ROOT: path.join(temporary, "state"),
        PI_OBSERVABILITY_AUTO_START: "false",
        PI_OBSERVABILITY_ENABLED: "false",
      };
      initializePennyState(PROJECT_ROOT, { env });
      const populationValue = fixture("synthetic-known-delta.population.v1.json");
      const planValue = fixture("synthetic-known-delta.plan.v1.json");
      const population = validateEvaluationPopulation(populationValue);
      const plan = validatePairedEvaluationPlan(planValue);
      const frozen = freezePairedEvaluation({
        population,
        plan,
        projectRoot: PROJECT_ROOT,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        ...implementation(planValue),
      });
      const entry = frozen.schedule.find((candidate) => candidate.variant === "baseline");
      if (entry === undefined) throw new Error("negative oracle baseline entry is absent");
      const originalTask = population.tasks.find(
        (candidate) => candidate.task_id === entry.task_id
      );
      if (originalTask === undefined) throw new Error("negative oracle task is absent");
      const marker = `SKRIBBLE_FORBIDDEN_${field.toUpperCase()}_D41E7C`;
      const task = {
        ...originalTask,
        constraints: { ...originalTask.constraints, nested_oracle_probe: { [field]: marker } },
      };
      let modelInvocations = 0;
      const executor = new GenericEvaluationTrialExecutor({
        projectRoot: PROJECT_ROOT,
        env,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        modelClientFactory: () => ({
          runtime_binding: plan.runtime_binding,
          async runAgent() {
            modelInvocations += 1;
            return { text: "unreachable" };
          },
          measurement() {
            return { cost_microusd: 0, latency_ms: 0 };
          },
        }),
      });

      await expect(executor.execute({ entry, task, plan, frozen })).rejects.toThrow(
        /host-only grading data/u
      );
      expect(modelInvocations).toBe(0);
      expect(providerHarness.captures).toHaveLength(0);
      const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
      for (const file of stateFiles(state.paths.root)) {
        expect(readFileSync(file).includes(Buffer.from(marker, "utf8"))).toBe(false);
      }
    }
  );

  it("resumes only missing immutable journals after an abrupt mid-schedule interruption", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-evaluation-resume-"));
    roots.push(temporary);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(temporary, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    initializePennyState(PROJECT_ROOT, { env });
    const memoryTools = declaredDemetriTools().filter((name) => name.startsWith("memory_"));
    const factory: EvaluationModelClientFactoryV1 = ({ plan, entry }) =>
      new ProviderStubMeasuredClient(
        plan.runtime_binding,
        [unavailableMemoryExtension(memoryTools)],
        entry.variant === "baseline" ? "baseline" : "candidate"
      );
    const executor = new GenericEvaluationTrialExecutor({
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      modelClientFactory: factory,
    });
    const population = fixture("synthetic-known-delta.population.v1.json");
    const plan = fixture("synthetic-known-delta.plan.v1.json");
    const frozen = freezePairedEvaluation({
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(plan),
    });
    using journal = new ArtifactEvaluationTrialJournal({
      projectRoot: PROJECT_ROOT,
      env,
      frozen,
    });
    let attempted = 0;
    await expect(
      executeFrozenPairedEvaluation({
        frozen,
        population,
        plan,
        projectRoot: PROJECT_ROOT,
        env,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        ...implementation(plan),
        executor: {
          preflight: (preflightInput) => executor.preflight(preflightInput),
          async execute(executeInput) {
            attempted += 1;
            if (attempted === 4) throw new Error("simulated abrupt process interruption");
            return executor.execute(executeInput);
          },
        },
        trialJournal: journal,
        maxConcurrency: 1,
      })
    ).rejects.toThrow("simulated abrupt process interruption");

    const retainedBeforeResume = frozen.schedule.map((entry) => journal.load(entry));
    expect(retainedBeforeResume.filter((entry) => entry.recorded)).toHaveLength(3);
    const retainedBytes = retainedBeforeResume
      .slice(0, 3)
      .map((entry) => canonicalJson(entry.recorded ? entry.observation : null));
    const resumedTrialIds: string[] = [];
    const resumed = await executeFrozenPairedEvaluation({
      frozen,
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(plan),
      executor: {
        preflight: (preflightInput) => executor.preflight(preflightInput),
        async execute(executeInput) {
          resumedTrialIds.push(executeInput.entry.trial_id);
          return executor.execute(executeInput);
        },
      },
      trialJournal: journal,
      maxConcurrency: 1,
    });

    expect(resumed.execution_accounting).toEqual({
      newly_started_trials: 5,
      newly_recorded_terminals: 5,
      retained_journal_observations: 3,
      outstanding_schedule_entries: 0,
      loopback_provider_calls: 0,
    });
    expect(resumedTrialIds).toEqual(frozen.schedule.slice(3).map((entry) => entry.trial_id));
    expect(
      frozen.schedule.slice(0, 3).map((entry) => {
        const loaded = journal.load(entry);
        return canonicalJson(loaded.recorded ? loaded.observation : null);
      })
    ).toEqual(retainedBytes);
    expect(frozen.schedule.every((entry) => journal.load(entry).recorded)).toBe(true);
  }, 120_000);

  it("terminalizes the parameterized direct baseline on liveness with a closed diagnostic code", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-evaluation-direct-liveness-"));
    roots.push(temporary);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(temporary, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    initializePennyState(PROJECT_ROOT, { env });
    const populationValue = fixture("synthetic-known-delta.population.v1.json");
    const planValue = fixture("synthetic-known-delta.plan.v1.json");
    const frozen = freezePairedEvaluation({
      population: populationValue,
      plan: planValue,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(planValue),
    });
    const population = validateEvaluationPopulation(populationValue);
    const plan = validatePairedEvaluationPlan(planValue);
    const entry = frozen.schedule.find((candidate) => candidate.variant === "baseline");
    if (entry === undefined) throw new Error("baseline schedule entry is absent");
    const task = population.tasks.find((candidate) => candidate.task_id === entry.task_id);
    if (task === undefined) throw new Error("baseline task is absent");
    const executor = new GenericEvaluationTrialExecutor({
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      modelClientFactory: () => ({
        runtime_binding: plan.runtime_binding,
        async runAgent() {
          throw new LivenessExhaustedError("worker_wall_clock_exhausted");
        },
        measurement() {
          return { cost_microusd: 0, latency_ms: 1 };
        },
      }),
    });
    await expect(executor.execute({ entry, task, plan, frozen })).resolves.toMatchObject({
      terminal_status: "error",
      failure_code: "WORKER_WALL_CLOCK_EXHAUSTED",
      started_new_trial: true,
    });
  });

  it("aborts unknown host exceptions without writing an immutable failure observation", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-evaluation-interruption-"));
    roots.push(temporary);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(temporary, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    initializePennyState(PROJECT_ROOT, { env });
    const population = fixture("synthetic-known-delta.population.v1.json");
    const plan = fixture("synthetic-known-delta.plan.v1.json");
    const frozen = freezePairedEvaluation({
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(plan),
    });
    using journal = new ArtifactEvaluationTrialJournal({
      projectRoot: PROJECT_ROOT,
      env,
      frozen,
    });
    await expect(
      executeFrozenPairedEvaluation({
        frozen,
        population,
        plan,
        projectRoot: PROJECT_ROOT,
        env,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        ...implementation(plan),
        executor: {
          async execute() {
            throw new Error("injected unknown host interruption");
          },
        },
        trialJournal: journal,
        maxConcurrency: 1,
      })
    ).rejects.toThrow(/unknown host interruption/u);
    const first = frozen.schedule[0];
    if (first === undefined) throw new Error("frozen schedule is empty");
    expect(journal.load(first)).toEqual({ recorded: false });
  });

  it("persists INVALID_EVALUATION and creates no client or Pi session when preflight fails", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-evaluation-preflight-failure-"));
    roots.push(temporary);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(temporary, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    initializePennyState(PROJECT_ROOT, { env });
    const population = fixture("synthetic-known-delta.population.v1.json");
    const plan = fixture("synthetic-known-delta.plan.v1.json");
    const frozen = freezePairedEvaluation({
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(plan),
    });
    let clientCalls = 0;
    const factory: EvaluationModelClientFactoryV1 = Object.assign(
      (_input: Parameters<EvaluationModelClientFactoryV1>[0]) => {
        clientCalls += 1;
        throw new Error("client creation must remain unreachable");
      },
      {
        preflight: async () => {
          throw new Error("injected artifact_read incompatibility");
        },
      }
    );
    const executor = new GenericEvaluationTrialExecutor({
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      modelClientFactory: factory,
    });
    const executeSpy = vi.spyOn(executor, "execute");
    const run = await executeFrozenPairedEvaluation({
      frozen,
      population,
      plan,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(plan),
      executor,
    });

    expect(run.result.disposition).toBe("INVALID_EVALUATION");
    expect(run.result.invalid_evaluation).toEqual({
      stage: "artifact_read_preflight",
      code: "LOCAL_LIVE_ARTIFACT_READ_PREFLIGHT_FAILED",
      trial_id: null,
    });
    expect(run.result.policy_outcomes.all_passed).toBe(false);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(clientCalls).toBe(0);
    expect(providerHarness.captures).toHaveLength(0);
    const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
    using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    expect(artifacts.read(run.result_artifact_ref).toString("utf8")).toBe(
      canonicalJson(run.result)
    );
  });
});
