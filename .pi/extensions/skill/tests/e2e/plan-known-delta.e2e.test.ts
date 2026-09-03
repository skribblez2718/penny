import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArtifactStore,
  CANDIDATE_PLAYBOOK_REGISTRY,
  PLAN_CANDIDATE_REGISTRATION,
  PLAN_PLAYBOOK_NAME,
  PLAN_SKILL_CONTRACT,
  PLAN_UNSEALED_EVALUATION_NAME,
  PLAYBOOK_REGISTRY,
  ArtifactRefSchema,
  OrchestrationService,
  PlanRequestConstraintsV1Schema,
  PlanRequestV1Schema,
  StrategyCoreV1Schema,
  StrategyDraftV1Schema,
  StrategySealFeedbackV1Schema,
  StrategyV1Schema,
  canonicalJson,
  canonicalizePlanRequest,
  evaluatePlanLatestReviewedStrategyDod,
  initializePennyState,
  parseStrategyDraft,
  projectStrategyDraft,
  resolvePennyRuntimeState,
  sealStrategy,
  sha256,
  validateDirective,
  validatePlanRequest,
  validateStrategy,
  type AgentCompletion,
  type AgentInvocation,
  type StrategyCoreV1,
} from "@penny/orchestration/source";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateGroundedSynthesis } from "../../../../../apps/orchestration/src/skill-contracts/research.js";

import {
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
  type EvaluationMutationMeasurementV1,
  type EvaluationPopulationTaskV1,
  type PairedEvaluationScheduleEntryV1,
} from "../../evaluation-contracts.js";
import { preflightLocalLiveArtifactRead } from "../../evaluation-local-live.js";
import {
  DIRECT_PIPER_PLAN_BASELINE_NAME,
  DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
  PLAN_EVALUATION_ABLATION_REGISTRY,
  PLAN_EVALUATION_CANDIDATE_REGISTRY,
  PLAN_EVALUATION_LIFECYCLE,
  PLAN_KNOWN_DELTA_GRADER_ID,
  PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION,
  PLAN_REQUIRED_IMPLEMENTATION_FILE_PATHS,
  StrategyEvaluationV1Schema,
  assertPlanImplementationFileCoverage,
  createPlanEvaluationGradingDefinition,
  normalizeSealedStrategyOutput,
  normalizeStrategyDraftOutput,
  planGraderDescriptor,
  projectSealedStrategyEvaluation,
  projectStrategyEvaluation,
} from "../../plan-evaluation.js";
import {
  ArtifactEvaluationTrialJournal,
  GenericEvaluationTrialExecutor,
  createEvaluationImplementationBinding,
  directBaselineDefinition,
  evaluationGradingDefinitionSha256,
  evaluationImplementationBindingSha256,
  executeFrozenPairedEvaluation,
  freezePairedEvaluation,
  type EvaluationImplementationFileInputV1,
  type EvaluationModelClientFactoryV1,
  type EvaluationRuntimeBindingV1,
  type EvaluationRuntimeMeasurementV1,
  type EvaluationTrialJournalV1,
  type EvaluationTrialObservationV1,
  type MeasuredEvaluationModelClientV1,
} from "../../evaluation-runner.js";
import {
  executeArtifactRead,
  loadArtifactRuntimeConfig,
} from "../../../artifacts/artifact-runtime.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const roots: string[] = [];
const MUTATION_IDS = [
  "missing_outcome_coverage",
  "out_of_range_request_index",
  "dangling_dependency_endpoint",
  "dependency_cycle",
  "ready_with_blocker",
  "blocked_without_blocked_outcome",
  "not_applicable_with_outcomes",
  "omitted_request_coverage",
  "confidence_drift",
  "request_digest_drift",
  "draft_lineage_digest_drift",
  "stable_id_drift",
  "execution_started_true",
  "unknown_execution_taskification_field",
] as const;

const PLAN_ORACLE_MARKER_PREFIX = "SKRIBBLE_PLAN_ORACLE_7F3A9D";

function oracleMarker(task: EvaluationPopulationTaskV1): string {
  return `${PLAN_ORACLE_MARKER_PREFIX}_${task.task_id}`;
}

function population() {
  return validateEvaluationPopulation(
    JSON.parse(
      readFileSync(
        path.join(PROJECT_ROOT, "evals", "fixtures", "plan-development.population.v1.json"),
        "utf8"
      )
    )
  );
}

function plan() {
  return validatePairedEvaluationPlan(
    JSON.parse(
      readFileSync(
        path.join(PROJECT_ROOT, "evals", "fixtures", "plan-evaluator-preparation.plan.v1.json"),
        "utf8"
      )
    )
  );
}

function mutationCohort(): unknown {
  return JSON.parse(
    readFileSync(
      path.join(
        PROJECT_ROOT,
        "apps",
        "orchestration",
        "tests",
        "fixtures",
        "plan-mutations.v1.json"
      ),
      "utf8"
    )
  );
}

function mutationCohortSha256(): string {
  return sha256(canonicalJson(mutationCohort()));
}

function groundedSynthesisContent(): string {
  const fixture: unknown = JSON.parse(
    readFileSync(
      path.join(
        PROJECT_ROOT,
        "apps",
        "orchestration",
        "tests",
        "fixtures",
        "skills",
        "research",
        "positive-vectors.json"
      ),
      "utf8"
    )
  );
  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error("GroundedSynthesis control fixture is malformed");
  }
  if (!("grounded_synthesis" in fixture)) {
    throw new Error("GroundedSynthesis control fixture is absent");
  }
  return canonicalJson(validateGroundedSynthesis(fixture.grounded_synthesis));
}

function taskRequest(task: EvaluationPopulationTaskV1) {
  return canonicalizePlanRequest({
    goal: task.goal,
    constraints: task.constraints,
    exactInputArtifactIds: task.exact_input_artifact_ids,
  });
}

function correctCore(task: EvaluationPopulationTaskV1): StrategyCoreV1 {
  const request = taskRequest(task);
  const desired = request.desired_outcomes;
  if (!task.trigger_expected) {
    return {
      schema_version: 1,
      disposition: "not_applicable",
      applicability_reason: "The request states that no further strategy is applicable.",
      outcomes: [],
      dependencies: [],
      request_coverage: {
        current_state_fact_indexes: [],
        input_artifact_slots: [],
        hard_constraint_indexes: [],
        non_goal_indexes: [],
        uncertainty_indexes: [],
        prior_decision_indexes: [],
        blocked_desired_outcome_indexes: [],
      },
      blockers: [],
      confidence: "CERTAIN",
    };
  }
  return {
    schema_version: 1,
    disposition: "ready",
    applicability_reason: "The request calls for a bounded strategy.",
    outcomes: desired.map((outcome, index) => ({
      statement: `Establish: ${outcome}`,
      desired_outcome_indexes: [index],
      success_signal: `Evidence confirms: ${outcome}`,
    })),
    dependencies: [],
    request_coverage: {
      current_state_fact_indexes:
        request.current_state.status === "provided"
          ? request.current_state.facts.map((_, index) => index)
          : [],
      input_artifact_slots: request.input_artifact_ids.map((_, index) => index),
      hard_constraint_indexes: request.hard_constraints.map((_, index) => index),
      non_goal_indexes: request.non_goals.map((_, index) => index),
      uncertainty_indexes: request.known_uncertainties.map((_, index) => index),
      prior_decision_indexes: request.prior_decisions.map((_, index) => index),
      blocked_desired_outcome_indexes: [],
    },
    blockers: [],
    confidence: "PROBABLE",
  };
}

function baselineCore(task: EvaluationPopulationTaskV1): StrategyCoreV1 {
  const correct = correctCore(task);
  if (!new Set(["plan-software-ready", "plan-software-not-applicable"]).has(task.task_id)) {
    return correct;
  }
  return task.trigger_expected
    ? {
        ...correct,
        disposition: "not_applicable",
        applicability_reason: "The direct baseline incorrectly declines the strategy request.",
        outcomes: [],
        dependencies: [],
        request_coverage: {
          current_state_fact_indexes: [],
          input_artifact_slots: [],
          hard_constraint_indexes: [],
          non_goal_indexes: [],
          uncertainty_indexes: [],
          prior_decision_indexes: [],
          blocked_desired_outcome_indexes: [],
        },
        blockers: [],
      }
    : {
        ...correct,
        disposition: "ready",
        applicability_reason: "The direct baseline incorrectly creates a strategy.",
        outcomes: taskRequest(task).desired_outcomes.map((outcome, index) => ({
          statement: `Incorrectly establish: ${outcome}`,
          desired_outcome_indexes: [index],
          success_signal: `Incorrect evidence for: ${outcome}`,
        })),
        request_coverage: {
          current_state_fact_indexes: [],
          input_artifact_slots: [],
          hard_constraint_indexes: [],
          non_goal_indexes: [],
          uncertainty_indexes: [],
          prior_decision_indexes: [],
          blocked_desired_outcome_indexes: [],
        },
        blockers: [],
      };
}

function persistedCore(core: unknown, summaryConfidence?: string): string {
  const confidence =
    summaryConfidence ??
    (typeof core === "object" && core !== null && "confidence" in core
      ? String(core.confidence)
      : "UNCERTAIN");
  return `A bounded no-execution strategy report.\nSTRATEGY_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"${confidence}","complete":true}`;
}

function routingSummary(details: Record<string, unknown>): string {
  return `Provider-free routing report.\nSUMMARY:${JSON.stringify({ confidence: "PROBABLE", ...details })}`;
}

function orientationPass(): string {
  return routingSummary({
    orientation_complete: true,
    gap_kind: "none",
    repair_owner: "none",
    findings: ["The exact request is oriented for strategy authorship."],
    strategy_delta: "Proceed with the bounded strategy assessment.",
  });
}

function veraPass(): string {
  return routingSummary({
    verdict: "PASS",
    gap_kind: "none",
    repair_owner: "none",
    findings: [],
    evidence: ["The exact latest StrategyV1 satisfies the request and lineage."],
    strategy_delta: "Advance to independent quality critique.",
  });
}

function carrenApprove(): string {
  return routingSummary({
    verdict: "APPROVE",
    gap_kind: "none",
    repair_owner: "none",
    findings: [],
    evidence: ["The Vera-passed strategy is coherent and strategy-useful."],
    strategy_delta: "Approve the exact latest product.",
  });
}

function flexiblePersistedCore(core: StrategyCoreV1): string {
  const reordered = {
    confidence: core.confidence,
    blockers: [...core.blockers].reverse(),
    request_coverage: {
      prior_decision_indexes: [...core.request_coverage.prior_decision_indexes].reverse(),
      uncertainty_indexes: [...core.request_coverage.uncertainty_indexes].reverse(),
      non_goal_indexes: [...core.request_coverage.non_goal_indexes].reverse(),
      hard_constraint_indexes: [...core.request_coverage.hard_constraint_indexes].reverse(),
      input_artifact_slots: [...core.request_coverage.input_artifact_slots].reverse(),
      current_state_fact_indexes: [...core.request_coverage.current_state_fact_indexes].reverse(),
      blocked_desired_outcome_indexes: [
        ...core.request_coverage.blocked_desired_outcome_indexes,
      ].reverse(),
    },
    dependencies: [...core.dependencies].reverse(),
    outcomes: core.outcomes.map((outcome) => ({
      success_signal: outcome.success_signal,
      desired_outcome_indexes: [...outcome.desired_outcome_indexes].reverse(),
      statement: outcome.statement,
    })),
    applicability_reason: core.applicability_reason,
    disposition: core.disposition,
    schema_version: 1,
  };
  const flexibleJson = JSON.stringify(reordered).replaceAll('":', '" : ').replaceAll(",", ", ");
  return `A bounded no-execution strategy report.\nSTRATEGY_CORE:${flexibleJson}\nSUMMARY:{"confidence":"${core.confidence}","complete":true}`;
}

function expectedWire(task: EvaluationPopulationTaskV1): string {
  const request = taskRequest(task);
  const draft = {
    ...correctCore(task),
    strategy_report: "A bounded no-execution strategy report.",
  };
  return canonicalJson(projectStrategyEvaluation(draft, request));
}

function gradingDefinition(markerSuffix = "") {
  return createPlanEvaluationGradingDefinition({
    purpose: "harness_self_test",
    graders: population().tasks.map((task) => ({
      descriptor: planGraderDescriptor({
        graderCaseId: task.grader_case_id,
        graderId: PLAN_KNOWN_DELTA_GRADER_ID,
        protectedCapability: true,
        oracle: {
          expected_wire_sha256: sha256(expectedWire(task)),
          oracle_marker: `${oracleMarker(task)}${markerSuffix}`,
        },
      }),
      implementation: PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION,
    })),
  });
}

interface ProviderFreePlanProbe {
  client_constructions: number;
  tool_calls: number;
  network_calls: number;
  readonly trial_starts: Map<string, number>;
  readonly invocations: AgentInvocation[];
}

function providerFreePlanProbe(): ProviderFreePlanProbe {
  return {
    client_constructions: 0,
    tool_calls: 0,
    network_calls: 0,
    trial_starts: new Map(),
    invocations: [],
  };
}

class PlanKnownDeltaClient implements MeasuredEvaluationModelClientV1 {
  readonly runtime_binding: EvaluationRuntimeBindingV1;
  private invoked = false;

  constructor(
    runtimeBinding: EvaluationRuntimeBindingV1,
    private readonly variantName: string,
    private readonly task: EvaluationPopulationTaskV1,
    private readonly scriptedOutput?: string,
    private readonly probe?: ProviderFreePlanProbe
  ) {
    this.runtime_binding = runtimeBinding;
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invoked = true;
    this.probe?.invocations.push(invocation);
    if (this.variantName === DIRECT_PIPER_PLAN_BASELINE_NAME) {
      if (invocation.agent !== "piper" || invocation.stateId !== "strategizing") {
        throw new Error("Plan baseline invoked the wrong cognitive phase");
      }
      return { text: this.scriptedOutput ?? persistedCore(baselineCore(this.task)) };
    }
    if (this.variantName === PLAN_UNSEALED_EVALUATION_NAME) {
      if (invocation.agent !== "piper" || invocation.stateId !== "strategizing") {
        throw new Error("Plan unsealed ablation invoked the wrong cognitive phase");
      }
      return { text: this.scriptedOutput ?? persistedCore(correctCore(this.task)) };
    }
    if (this.variantName !== PLAN_PLAYBOOK_NAME) {
      throw new Error(`unknown Plan evaluation variant '${this.variantName}'`);
    }
    if (invocation.stateId === "orienting_strategy" && invocation.agent === "piper") {
      return { text: orientationPass() };
    }
    if (invocation.stateId === "strategizing" && invocation.agent === "piper") {
      return { text: this.scriptedOutput ?? persistedCore(correctCore(this.task)) };
    }
    if (invocation.stateId === "verifying_strategy" && invocation.agent === "vera") {
      return { text: veraPass() };
    }
    if (invocation.stateId === "critiquing_strategy" && invocation.agent === "carren") {
      return { text: carrenApprove() };
    }
    throw new Error("Plan evaluation invoked an unexpected cognitive phase");
  }

  measurement(_runId: string): EvaluationRuntimeMeasurementV1 {
    if (!this.invoked) return { cost_microusd: 0, latency_ms: 0 };
    return this.variantName === DIRECT_PIPER_PLAN_BASELINE_NAME
      ? { cost_microusd: 100, latency_ms: 10 }
      : { cost_microusd: 110, latency_ms: 11 };
  }
}

function modelFactory(probe?: ProviderFreePlanProbe): EvaluationModelClientFactoryV1 {
  const tasks = new Map(population().tasks.map((task) => [task.task_id, task]));
  return ({ entry, plan: frozenPlan }) => {
    const task = tasks.get(entry.task_id);
    if (task === undefined) throw new Error(`Plan task '${entry.task_id}' is absent`);
    if (probe !== undefined) {
      probe.client_constructions += 1;
      probe.trial_starts.set(entry.trial_id, (probe.trial_starts.get(entry.trial_id) ?? 0) + 1);
    }
    return new PlanKnownDeltaClient(
      frozenPlan.runtime_binding,
      entry.variant_name,
      task,
      undefined,
      probe
    );
  };
}

function implementation(planValue: unknown) {
  const grading = gradingDefinition();
  const runtimeFunctions = [
    {
      role: "artifact_preflight" as const,
      owner: "plan-development",
      implementation: preflightLocalLiveArtifactRead,
    },
    {
      role: "model_client_factory" as const,
      owner: "plan-development",
      implementation: modelFactory,
    },
    {
      role: "model_preflight" as const,
      owner: "plan-development",
      implementation: preflightLocalLiveArtifactRead,
    },
    {
      role: "trial_executor_execute" as const,
      owner: "plan-development",
      implementation: GenericEvaluationTrialExecutor.prototype.execute,
    },
    {
      role: "trial_executor_preflight" as const,
      owner: "plan-development",
      implementation: GenericEvaluationTrialExecutor.prototype.preflight,
    },
    {
      role: "mutation_gate" as const,
      owner: "plan-development",
      implementation: mutationMeasurement,
    },
  ];
  const planPhaseFiles = [
    ...[
      "piper-orienting_strategy.md",
      "echo-gathering_strategy_evidence.md",
      "piper-strategizing.md",
      "vera-verifying_strategy.md",
      "carren-critiquing_strategy.md",
    ].map((file) => ({
      role: "registration_guidance" as const,
      owner: "plan",
      path: `.pi/skills/plan/assets/prompts/${file}`,
    })),
    ...["piper", "echo", "vera", "carren"].map((agent) => ({
      role: "agent_definition" as const,
      owner: "plan",
      path: `.pi/agents/${agent}.md`,
    })),
    {
      role: "registration_guidance" as const,
      owner: "plan-unsealed",
      path: ".pi/skills/plan/assets/prompts/piper-strategizing.md",
    },
    {
      role: "agent_definition" as const,
      owner: "plan-unsealed",
      path: ".pi/agents/piper.md",
    },
  ];
  const candidateFiles = [
    ...planPhaseFiles,
    ...["plan", "plan-unsealed"].flatMap((owner) => [
      {
        role: "registration_source" as const,
        owner,
        path: "apps/orchestration/src/playbooks/plan.ts",
      },
      {
        role: "contract_source" as const,
        owner,
        path: "apps/orchestration/src/skill-contracts/plan.ts",
      },
      {
        role: "playbook_source" as const,
        owner,
        path: "apps/orchestration/src/playbooks/plan.ts",
      },
      {
        role: "validator_source" as const,
        owner,
        path: "apps/orchestration/src/skill-contracts/plan.ts",
      },
      {
        role: "composition_source" as const,
        owner,
        path: "apps/orchestration/src/composition.ts",
      },
      {
        role: "contract_source" as const,
        owner,
        path: ".pi/skills/plan/SKILL.md",
      },
      {
        role: "validator_source" as const,
        owner,
        path: "apps/orchestration/src/skill-contracts/common.ts",
      },
      {
        role: "validator_source" as const,
        owner,
        path: "apps/orchestration/src/skill-contracts/decide.ts",
      },
      {
        role: "validator_source" as const,
        owner,
        path: "apps/orchestration/src/skill-contracts/research.ts",
      },
      {
        role: "validator_source" as const,
        owner,
        path: "apps/orchestration/src/skill-contracts/review.ts",
      },
    ]),
  ];
  const normalizerFiles = grading.descriptor.semantic_normalizers.map((descriptor) => ({
    role: "normalizer_source" as const,
    owner: descriptor.registration_name,
    path: ".pi/extensions/skill/plan-evaluation.ts",
  }));
  const graderFiles = grading.descriptor.graders.map((descriptor) => ({
    role: "grader_source" as const,
    owner: descriptor.grader_case_id,
    path: ".pi/extensions/skill/plan-evaluation.ts",
  }));
  const files = [
    {
      role: "registration_guidance",
      owner: DIRECT_PIPER_PLAN_BASELINE_NAME,
      path: "evals/guidance/plan/piper-strategizing.md",
    },
    {
      role: "agent_definition",
      owner: DIRECT_PIPER_PLAN_BASELINE_NAME,
      path: ".pi/agents/piper.md",
    },
    {
      role: "registration_source",
      owner: DIRECT_PIPER_PLAN_BASELINE_NAME,
      path: ".pi/extensions/skill/plan-evaluation.ts",
    },
    ...candidateFiles,
    ...normalizerFiles,
    ...graderFiles,
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-contracts.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-runner.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-semantic-projections.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-semantic-review.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/service.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/engine.ts",
    },
    {
      role: "evaluator_source" as const,
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/artifact-store.ts",
    },
    {
      role: "evaluator_source" as const,
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/contracts.ts",
    },
    {
      role: "evaluator_source" as const,
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/checkpointer.ts",
    },
    {
      role: "evaluator_source" as const,
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/playbooks/playbook.ts",
    },
    {
      role: "evaluator_source" as const,
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/tests/e2e/plan-known-delta.e2e.test.ts",
    },
    {
      role: "worker_source" as const,
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/worker.ts",
    },
    {
      role: "worker_source",
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/model-client.ts",
    },
    {
      role: "artifact_preflight_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-local-live.ts",
    },
    {
      role: "artifact_preflight_source" as const,
      owner: "evaluation-runtime",
      path: ".pi/extensions/artifacts/artifact-runtime.ts",
    },
  ] satisfies readonly EvaluationImplementationFileInputV1[];
  assertPlanImplementationFileCoverage(files);
  const implementationBinding = createEvaluationImplementationBinding({
    projectRoot: PROJECT_ROOT,
    population: population(),
    plan: planValue,
    baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
    candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
    ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
    gradingDefinition: grading,
    files,
    runtimeFunctions,
  });
  return { implementationBinding, runtimeFunctions, files };
}

function mutationEntry(input: {
  readonly mutationId: string;
  readonly variant: "candidate" | "ablation";
  readonly variantName: string;
  readonly bindingSha256: string;
  readonly taskId: string;
  readonly ordinal: number;
}): PairedEvaluationScheduleEntryV1 {
  const identity = sha256(
    canonicalJson({
      cohort: "plan-mutations-v1",
      mutation_id: input.mutationId,
      variant: input.variant,
    })
  );
  return {
    trial_id: `evaltrial_${identity}`,
    pair_id: `evalpair_${sha256(canonicalJson({ mutation_id: input.mutationId }))}`,
    ordinal: input.ordinal,
    task_id: input.taskId,
    repetition: 1,
    variant: input.variant,
    variant_name: input.variantName,
    binding_sha256: input.bindingSha256,
  };
}

function productMutationEvidence(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly planValue: ReturnType<typeof plan>;
  readonly control: EvaluationTrialObservationV1;
}) {
  if (
    input.control.terminal_status !== "complete" ||
    input.control.output_ref?.kind !== "strategy" ||
    input.control.output_ref.content_schema?.schema_id !== "penny.strategy.v1" ||
    input.control.output_bytes === undefined
  ) {
    throw new Error("valid Plan mutation control did not produce a sealed StrategyV1");
  }
  const task = population().tasks[0];
  using service = new OrchestrationService({
    projectRoot: PROJECT_ROOT,
    env: input.env,
    modelClient: new PlanKnownDeltaClient(input.planValue.runtime_binding, "plan", task),
    playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
  });
  const sourceRef = input.control.output_ref;
  const sourceStrategy = validateStrategy(JSON.parse(input.control.output_bytes));
  const mutations: readonly { readonly mutation_id: string; readonly product: unknown }[] = [
    {
      mutation_id: "request_digest_drift",
      product: { ...sourceStrategy, request_sha256: "0".repeat(64) },
    },
    {
      mutation_id: "draft_lineage_digest_drift",
      product: {
        ...sourceStrategy,
        source_lineage: { ...sourceStrategy.source_lineage, draft_sha256: "0".repeat(64) },
      },
    },
    {
      mutation_id: "stable_id_drift",
      product: { ...sourceStrategy, strategy_id: `strategy-${"0".repeat(64)}` },
    },
    {
      mutation_id: "execution_started_true",
      product: { ...sourceStrategy, execution_started: true },
    },
    {
      mutation_id: "unknown_execution_taskification_field",
      product: {
        ...sourceStrategy,
        execution_state: "started",
        taskification: { tasks: [] },
      },
    },
  ];
  return mutations.map((mutation) => {
    let canonicalValidationPassed = true;
    try {
      validateStrategy(mutation.product);
    } catch {
      canonicalValidationPassed = false;
    }
    const mutatedRef = service.artifacts.persist({
      metadata: {
        ...service.artifacts.metadata(sourceRef),
        operation_id: `plan-product-mutation:${mutation.mutation_id}`,
        version: 1,
        parent_ref: null,
      },
      content: canonicalJson(mutation.product),
    });
    const context = service.checkpointer.loadRunById(input.control.trial_id);
    if (context === undefined || context.terminalDirective?.action !== "complete") {
      throw new Error("valid Plan mutation control checkpoint is not complete");
    }
    const selectedIndex = context.selectedArtifacts.findIndex(
      (artifact) => artifact.artifact_id === sourceRef.artifact_id
    );
    if (selectedIndex < 0) throw new Error("valid Plan mutation control product is not selected");
    context.selectedArtifacts.splice(selectedIndex, 1, mutatedRef);
    const terminal = validateDirective({
      ...context.terminalDirective,
      result: { ...context.terminalDirective.result, output_artifact_ref: mutatedRef },
      artifacts: context.terminalDirective.artifacts.map((artifact) =>
        artifact.artifact_id === sourceRef.artifact_id ? mutatedRef : artifact
      ),
    });
    if (terminal.action !== "complete") throw new Error("mutated terminal shape was lost");
    const completion = evaluatePlanLatestReviewedStrategyDod({
      checkpointer: service.checkpointer,
      context,
      terminal,
      originState: "critiquing_strategy",
      latestProduct: {
        selector: "terminal_artifact",
        schema_id: "penny.strategy.v1",
        product_schema_version: 1,
        product_id: mutatedRef.artifact_id,
        sha256: mutatedRef.content_digest,
      },
      artifactReader: service.artifacts,
      projectRoot: PROJECT_ROOT,
    });
    return {
      mutation_id: mutation.mutation_id,
      canonical_validation_passed: canonicalValidationPassed,
      completion_predicate_passed: completion.passed,
    };
  });
}

async function mutationMeasurement(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly planValue: ReturnType<typeof plan>;
  readonly frozen: ReturnType<typeof freezePairedEvaluation>;
  readonly task: EvaluationPopulationTaskV1;
}): Promise<{
  readonly measurement: EvaluationMutationMeasurementV1;
  readonly draft_evidence: readonly {
    readonly mutation_id: string;
    readonly candidate: EvaluationTrialObservationV1;
    readonly ablation: EvaluationTrialObservationV1;
    readonly raw_draft: string;
  }[];
  readonly product_evidence: readonly {
    readonly mutation_id: string;
    readonly canonical_validation_passed: boolean;
    readonly completion_predicate_passed: boolean;
  }[];
  readonly control_evidence: {
    readonly candidate: EvaluationTrialObservationV1;
    readonly ablation: EvaluationTrialObservationV1;
    readonly semantic_projection_matches: boolean;
  };
}> {
  const valid = correctCore(input.task);
  if (valid.disposition !== "ready") throw new Error("Plan mutation task must be ready");
  const firstOutcome = valid.outcomes[0];
  const secondOutcome = valid.outcomes[1];
  if (firstOutcome === undefined || secondOutcome === undefined) {
    throw new Error("Plan mutation task requires two valid outcomes");
  }
  const draftMutations: readonly { readonly mutation_id: string; readonly raw: string }[] = [
    {
      mutation_id: "missing_outcome_coverage",
      raw: persistedCore({ ...valid, outcomes: [firstOutcome], dependencies: [] }),
    },
    {
      mutation_id: "out_of_range_request_index",
      raw: persistedCore({
        ...valid,
        request_coverage: { ...valid.request_coverage, hard_constraint_indexes: [99] },
      }),
    },
    {
      mutation_id: "dangling_dependency_endpoint",
      raw: persistedCore({
        ...valid,
        dependencies: [{ from_outcome_index: 0, to_outcome_index: 99, kind: "causal" }],
      }),
    },
    {
      mutation_id: "dependency_cycle",
      raw: persistedCore({
        ...valid,
        dependencies: [
          { from_outcome_index: 0, to_outcome_index: 1, kind: "causal" },
          { from_outcome_index: 1, to_outcome_index: 0, kind: "causal" },
        ],
      }),
    },
    {
      mutation_id: "ready_with_blocker",
      raw: persistedCore({ ...valid, blockers: ["Unexpected blocker."] }),
    },
    {
      mutation_id: "blocked_without_blocked_outcome",
      raw: persistedCore({
        ...valid,
        disposition: "blocked",
        blockers: ["A material blocker exists."],
        request_coverage: { ...valid.request_coverage, blocked_desired_outcome_indexes: [] },
      }),
    },
    {
      mutation_id: "not_applicable_with_outcomes",
      raw: persistedCore({ ...valid, disposition: "not_applicable" }),
    },
    {
      mutation_id: "omitted_request_coverage",
      raw: persistedCore({
        ...valid,
        request_coverage: {
          ...valid.request_coverage,
          current_state_fact_indexes: [],
          input_artifact_slots: [],
          hard_constraint_indexes: [],
          non_goal_indexes: [],
          uncertainty_indexes: [],
          prior_decision_indexes: [],
        },
      }),
    },
    {
      mutation_id: "confidence_drift",
      raw: persistedCore(valid, valid.confidence === "CERTAIN" ? "PROBABLE" : "CERTAIN"),
    },
    {
      mutation_id: "unknown_execution_taskification_field",
      raw: persistedCore({ ...valid, execution_started: true, task_graph: [] }),
    },
  ];
  const ablation = input.planValue.ablations.find(
    (candidate) => candidate.name === "plan-unsealed"
  );
  if (ablation === undefined) throw new Error("frozen Plan ablation binding is absent");
  const outputs = new Map<string, string>();
  const entries = draftMutations.map((mutation, index) => {
    const candidate = mutationEntry({
      mutationId: mutation.mutation_id,
      variant: "candidate",
      variantName: input.planValue.candidate.name,
      bindingSha256: input.planValue.candidate.contract_sha256,
      taskId: input.task.task_id,
      ordinal: index * 2,
    });
    const unsealed = mutationEntry({
      mutationId: mutation.mutation_id,
      variant: "ablation",
      variantName: ablation.name,
      bindingSha256: ablation.contract_sha256,
      taskId: input.task.task_id,
      ordinal: index * 2 + 1,
    });
    outputs.set(candidate.trial_id, mutation.raw);
    outputs.set(unsealed.trial_id, mutation.raw);
    return { mutation_id: mutation.mutation_id, candidate, unsealed, raw: mutation.raw };
  });
  const candidateControlEntry = mutationEntry({
    mutationId: "flexible-format-valid-control-candidate",
    variant: "candidate",
    variantName: input.planValue.candidate.name,
    bindingSha256: input.planValue.candidate.contract_sha256,
    taskId: input.task.task_id,
    ordinal: draftMutations.length * 2,
  });
  const ablationControlEntry = mutationEntry({
    mutationId: "flexible-format-valid-control-ablation",
    variant: "ablation",
    variantName: ablation.name,
    bindingSha256: ablation.contract_sha256,
    taskId: input.task.task_id,
    ordinal: draftMutations.length * 2 + 1,
  });
  const flexibleControl = flexiblePersistedCore(valid);
  outputs.set(candidateControlEntry.trial_id, flexibleControl);
  outputs.set(ablationControlEntry.trial_id, flexibleControl);
  const scriptedFactory: EvaluationModelClientFactoryV1 = ({ entry, plan: frozenPlan }) => {
    const output = outputs.get(entry.trial_id);
    if (output === undefined) throw new Error(`Plan mutation output '${entry.trial_id}' is absent`);
    return new PlanKnownDeltaClient(
      frozenPlan.runtime_binding,
      entry.variant_name,
      input.task,
      output
    );
  };
  const executor = new GenericEvaluationTrialExecutor({
    projectRoot: PROJECT_ROOT,
    env: input.env,
    baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
    candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
    ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
    modelClientFactory: scriptedFactory,
  });
  const draftEvidence = [];
  let fullEscapes = 0;
  let unsealedEscapes = 0;
  for (const entry of entries) {
    const candidate = await executor.execute({
      entry: entry.candidate,
      task: input.task,
      plan: input.planValue,
      frozen: input.frozen,
    });
    const unsealed = await executor.execute({
      entry: entry.unsealed,
      task: input.task,
      plan: input.planValue,
      frozen: input.frozen,
    });
    if (candidate.terminal_status === "complete") fullEscapes += 1;
    if (unsealed.terminal_status === "complete" && unsealed.output_bytes === entry.raw) {
      unsealedEscapes += 1;
    }
    draftEvidence.push({
      mutation_id: entry.mutation_id,
      candidate,
      ablation: unsealed,
      raw_draft: entry.raw,
    });
  }
  const candidateControl = await executor.execute({
    entry: candidateControlEntry,
    task: input.task,
    plan: input.planValue,
    frozen: input.frozen,
  });
  const ablationControl = await executor.execute({
    entry: ablationControlEntry,
    task: input.task,
    plan: input.planValue,
    frozen: input.frozen,
  });
  if (
    candidateControl.terminal_status !== "complete" ||
    candidateControl.output_bytes === undefined ||
    ablationControl.terminal_status !== "complete" ||
    ablationControl.output_bytes === undefined
  ) {
    throw new Error(
      `flexible-format Plan controls did not complete through both real paths: candidate=${canonicalJson(candidateControl)} ablation=${canonicalJson(ablationControl)}`
    );
  }
  const candidateProjection = projectSealedStrategyEvaluation(
    validateStrategy(JSON.parse(candidateControl.output_bytes))
  );
  const controlRequest = taskRequest(input.task);
  const ablationProjection = projectStrategyEvaluation(
    parseStrategyDraft(Buffer.from(ablationControl.output_bytes), { request: controlRequest })
      .draft,
    controlRequest
  );
  const semanticProjectionMatches =
    canonicalJson(candidateProjection) === canonicalJson(ablationProjection) &&
    canonicalJson(candidateProjection) === expectedWire(input.task);
  const productEvidence = productMutationEvidence({
    env: input.env,
    planValue: input.planValue,
    control: candidateControl,
  });
  fullEscapes += productEvidence.filter(
    (evidence) => evidence.canonical_validation_passed || evidence.completion_predicate_passed
  ).length;
  const exercisedMutationIds = new Set([
    ...draftEvidence.map((evidence) => evidence.mutation_id),
    ...productEvidence.map((evidence) => evidence.mutation_id),
  ]);
  if (
    MUTATION_IDS.some((mutationId) => !exercisedMutationIds.has(mutationId)) ||
    exercisedMutationIds.size !== MUTATION_IDS.length
  ) {
    throw new Error("Plan mutation execution does not exactly cover the frozen cohort");
  }
  return {
    measurement: {
      cohort_sha256: mutationCohortSha256(),
      mutation_count: MUTATION_IDS.length,
      full_sealer_escaped_invalid_count: fullEscapes,
      ablation_escaped_invalid_count: unsealedEscapes,
    },
    draft_evidence: draftEvidence,
    product_evidence: productEvidence,
    control_evidence: {
      candidate: candidateControl,
      ablation: ablationControl,
      semantic_projection_matches: semanticProjectionMatches,
    },
  };
}

function sandbox(): { readonly env: NodeJS.ProcessEnv; readonly root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "penny-plan-known-delta-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "isolated-state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return { env, root };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function journalBytes(
  artifacts: ArtifactStore,
  frozen: ReturnType<typeof freezePairedEvaluation>,
  entry: PairedEvaluationScheduleEntryV1
): string | undefined {
  const ref = artifacts.refFor(
    entry.trial_id,
    "evaluation",
    null,
    "evaluation-trial-observation",
    `paired-evaluation-observation:${frozen.schedule_sha256}:${entry.trial_id}`,
    1
  );
  return ref === null ? undefined : artifacts.readById(ref.artifact_id).toString("utf8");
}

describe("provider-free Plan known-delta and mutation E2E", () => {
  it("proves the 60-trial harness-only PREPARED_NOT_MEASURED control and every containment gate", async () => {
    const { env, root } = sandbox();
    const populationValue = population();
    const planValue = plan();
    const grading = gradingDefinition();
    expect(PLAN_EVALUATION_LIFECYCLE).toBe("PREPARED_NOT_MEASURED");
    expect(populationValue.tasks).toHaveLength(10);
    expect(new Set(populationValue.tasks.map((task) => task.domain)).size).toBe(5);
    expect(planValue.repetitions).toBe(2);
    expect(mutationCohort()).toMatchObject({
      schema_version: 1,
      mutations: MUTATION_IDS.map((mutationId) => ({ mutation_id: mutationId })),
      valid_controls: [
        {
          reordered_json_keys: true,
          legal_insignificant_whitespace: true,
          reordered_set_arrays: true,
        },
      ],
    });
    expect(planValue.grader_registry_sha256).toBe(evaluationGradingDefinitionSha256(grading));
    expect(planValue.baseline).toEqual(
      directBaselineDefinition(DIRECT_PIPER_PLAN_BASELINE_REGISTRATION, PROJECT_ROOT)
    );

    const boundImplementation = implementation(planValue);
    expect(evaluationImplementationBindingSha256(boundImplementation.implementationBinding)).toBe(
      planValue.implementation_binding_sha256
    );
    const repeatedImplementation = implementation(planValue);
    expect(
      repeatedImplementation.implementationBinding.registrations.map((registration) => ({
        registration_name: registration.registration_name,
        construct_probe_sha256: registration.construct_probe_sha256,
      }))
    ).toEqual(
      boundImplementation.implementationBinding.registrations.map((registration) => ({
        registration_name: registration.registration_name,
        construct_probe_sha256: registration.construct_probe_sha256,
      }))
    );
    expect(
      evaluationImplementationBindingSha256(repeatedImplementation.implementationBinding)
    ).toBe(evaluationImplementationBindingSha256(boundImplementation.implementationBinding));
    const boundPaths = new Set(
      boundImplementation.implementationBinding.files.map((file) => file.path)
    );
    expect([...PLAN_REQUIRED_IMPLEMENTATION_FILE_PATHS].every((file) => boundPaths.has(file))).toBe(
      true
    );
    for (const requiredPath of PLAN_REQUIRED_IMPLEMENTATION_FILE_PATHS) {
      expect(() =>
        assertPlanImplementationFileCoverage(
          boundImplementation.files.filter((file) => file.path !== requiredPath)
        )
      ).toThrow(requiredPath);
    }
    expect(
      boundImplementation.implementationBinding.registrations.map((registration) => ({
        name: registration.registration_name,
        start: registration.start_admission !== null,
        liveness: registration.liveness.resolve.name,
        construct: registration.construct.name,
        construct_probe: registration.construct_probe_sha256.length,
        phases: registration.worker.phases.length,
      }))
    ).toEqual([
      {
        name: DIRECT_PIPER_PLAN_BASELINE_NAME,
        start: true,
        liveness: "resolve",
        construct: "construct",
        construct_probe: 64,
        phases: 1,
      },
      {
        name: "plan",
        start: true,
        liveness: "resolve",
        construct: "construct",
        construct_probe: 64,
        phases: 5,
      },
      {
        name: "plan-unsealed",
        start: true,
        liveness: "resolve",
        construct: "construct",
        construct_probe: 64,
        phases: 1,
      },
    ]);
    expect(
      boundImplementation.implementationBinding.runtime_functions.map((entry) => entry.role).sort()
    ).toEqual([
      "artifact_preflight",
      "model_client_factory",
      "model_preflight",
      "mutation_gate",
      "trial_executor_execute",
      "trial_executor_preflight",
    ]);
    expect(
      boundImplementation.implementationBinding.grading.semantic_normalizers.map(
        (entry) => entry.registration_name
      )
    ).toEqual([DIRECT_PIPER_PLAN_BASELINE_NAME, "plan", "plan-unsealed"]);
    expect(boundImplementation.implementationBinding.grading.graders).toHaveLength(10);

    const materialFunctions = [
      PLAN_CANDIDATE_REGISTRATION.construct,
      DIRECT_PIPER_PLAN_BASELINE_REGISTRATION.construct,
      PLAN_CANDIDATE_REGISTRATION.start_admission?.prepare,
      PLAN_CANDIDATE_REGISTRATION.liveness.resolve,
      evaluatePlanLatestReviewedStrategyDod,
      validatePlanRequest,
      parseStrategyDraft,
      projectStrategyDraft,
      sealStrategy,
      validateStrategy,
      normalizeStrategyDraftOutput,
      normalizeSealedStrategyOutput,
      PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION.grade,
      GenericEvaluationTrialExecutor.prototype.preflight,
      GenericEvaluationTrialExecutor.prototype.execute,
      modelFactory,
      preflightLocalLiveArtifactRead,
      mutationMeasurement,
    ];
    expect(
      materialFunctions.every((implementationValue) => typeof implementationValue === "function")
    ).toBe(true);
    for (const schema of [
      PlanRequestConstraintsV1Schema,
      PlanRequestV1Schema,
      StrategyCoreV1Schema,
      StrategyDraftV1Schema,
      StrategySealFeedbackV1Schema,
      StrategyV1Schema,
      StrategyEvaluationV1Schema,
      ArtifactRefSchema,
    ]) {
      expect(sha256(canonicalJson(schema))).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(PLAN_SKILL_CONTRACT.io.active_output_ports).toEqual([
      expect.objectContaining({
        name: "strategy",
        schema_id: "penny.strategy.v1",
        schema_version_required: 1,
      }),
    ]);

    const frozen = freezePairedEvaluation({
      population: populationValue,
      plan: planValue,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
      candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
      implementationBinding: boundImplementation.implementationBinding,
      runtimeFunctions: boundImplementation.runtimeFunctions,
      ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
      gradingDefinition: grading,
    });
    expect(frozen.schedule).toHaveLength(60);
    expect(frozen.schedule.filter((entry) => entry.variant === "candidate")).toHaveLength(20);
    expect(frozen.schedule.filter((entry) => entry.variant === "baseline")).toHaveLength(20);
    expect(frozen.schedule.filter((entry) => entry.variant === "ablation")).toHaveLength(20);

    const decoyRoot = path.join(root, "decoy-state");
    initializePennyState(PROJECT_ROOT, { env: { PENNY_STATE_ROOT: decoyRoot } });
    const targetState = resolvePennyRuntimeState(PROJECT_ROOT, { env });
    const decoyState = resolvePennyRuntimeState(PROJECT_ROOT, {
      env: { PENNY_STATE_ROOT: decoyRoot },
    });
    const groundedContent = groundedSynthesisContent();
    const groundedMetadata = {
      schema_version: 2 as const,
      run_id: "plan-cross-root-preflight",
      phase: "sealing_core",
      branch_id: null,
      kind: "semantic-core",
      operation_id: "plan-cross-root-grounded-synthesis",
      version: 1,
      parent_ref: null,
      producer: "host:research-core",
      media_type: "application/json",
      content_schema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 },
      upstream_refs: [],
    };
    using targetArtifacts = ArtifactStore.openExisting(targetState.paths.artifacts.root, {
      projectId: targetState.projectId,
    });
    using decoyArtifacts = ArtifactStore.openExisting(decoyState.paths.artifacts.root, {
      projectId: decoyState.projectId,
    });
    const targetGrounded = targetArtifacts.persist({
      metadata: groundedMetadata,
      content: groundedContent,
    });
    const decoyGrounded = decoyArtifacts.persist({
      metadata: groundedMetadata,
      content: groundedContent,
    });
    expect(decoyGrounded.artifact_id).toBe(targetGrounded.artifact_id);
    expect(decoyArtifacts.read(decoyGrounded).toString("utf8")).toBe(
      targetArtifacts.read(targetGrounded).toString("utf8")
    );
    expect(populationValue.tasks[0]?.exact_input_artifact_ids).toEqual([
      targetGrounded.artifact_id,
    ]);
    expect(validateGroundedSynthesis(JSON.parse(groundedContent))).toBeDefined();
    const groundedRead = await executeArtifactRead(loadArtifactRuntimeConfig(PROJECT_ROOT, env), {
      artifact: targetGrounded.artifact_id,
    });
    expect(groundedRead.code).toBe("OK");
    const groundedReadText = groundedRead.result.content[0];
    if (groundedReadText?.type !== "text") {
      throw new Error("Grounded preflight read returned no text");
    }
    expect(JSON.parse(groundedReadText.text)).toMatchObject({
      artifact_ref: { artifact_id: targetGrounded.artifact_id },
      content: groundedContent,
    });

    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network forbidden");
    });
    const standardProbe = providerFreePlanProbe();
    const wrongProcessEnv: NodeJS.ProcessEnv = { PENNY_STATE_ROOT: decoyRoot };
    await expect(
      preflightLocalLiveArtifactRead({
        projectRoot: PROJECT_ROOT,
        env,
        processEnv: wrongProcessEnv,
        frozen,
      })
    ).rejects.toMatchObject({ code: "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE" });
    expect(standardProbe.client_constructions).toBe(0);
    expect(network).not.toHaveBeenCalled();
    const targetProcessEnv: NodeJS.ProcessEnv = {};
    await preflightLocalLiveArtifactRead({
      projectRoot: PROJECT_ROOT,
      env,
      processEnv: targetProcessEnv,
      frozen,
    });
    expect(targetProcessEnv.PENNY_STATE_ROOT).toBe(env.PENNY_STATE_ROOT);

    const mutationRun = await mutationMeasurement({
      env,
      planValue,
      frozen,
      task: populationValue.tasks[0],
    });
    expect(mutationRun.measurement).toMatchObject({
      mutation_count: 14,
      full_sealer_escaped_invalid_count: 0,
      ablation_escaped_invalid_count: 0,
    });
    expect(
      mutationRun.draft_evidence.every(
        (evidence) =>
          evidence.candidate.terminal_status === "error" &&
          evidence.candidate.output_ref?.kind === "strategy-draft" &&
          evidence.ablation.terminal_status === "error" &&
          evidence.ablation.output_ref?.kind === "strategy-draft" &&
          evidence.candidate.output_ref.content_digest === sha256(evidence.raw_draft) &&
          evidence.ablation.output_ref.content_digest === sha256(evidence.raw_draft)
      )
    ).toBe(true);
    expect(
      mutationRun.product_evidence.every(
        (evidence) => !evidence.canonical_validation_passed && !evidence.completion_predicate_passed
      )
    ).toBe(true);
    expect(mutationRun.control_evidence).toMatchObject({
      candidate: { terminal_status: "complete", output_ref: { kind: "strategy" } },
      ablation: { terminal_status: "complete", output_ref: { kind: "strategy-draft" } },
      semantic_projection_matches: true,
    });

    const executor = new GenericEvaluationTrialExecutor({
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
      candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
      ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
      modelClientFactory: modelFactory(standardProbe),
    });
    using journal = new ArtifactEvaluationTrialJournal({
      projectRoot: PROJECT_ROOT,
      env,
      frozen,
    });
    let interruptedDispatches = 0;
    const interruptingExecutor = {
      async preflight(input: Parameters<GenericEvaluationTrialExecutor["preflight"]>[0]) {
        await executor.preflight(input);
      },
      async execute(input: Parameters<GenericEvaluationTrialExecutor["execute"]>[0]) {
        interruptedDispatches += 1;
        if (interruptedDispatches === 4) {
          throw new Error("unknown host interruption after three immutable journals");
        }
        return executor.execute(input);
      },
    };
    await expect(
      executeFrozenPairedEvaluation({
        frozen,
        population: populationValue,
        plan: planValue,
        projectRoot: PROJECT_ROOT,
        env,
        baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
        candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
        ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
        executor: interruptingExecutor,
        gradingDefinition: grading,
        implementationBinding: boundImplementation.implementationBinding,
        runtimeFunctions: boundImplementation.runtimeFunctions,
        trialJournal: journal,
        maxConcurrency: 1,
      })
    ).rejects.toThrow(/unknown host interruption/u);
    expect(interruptedDispatches).toBe(4);
    const retainedEntries = frozen.schedule.slice(0, 3);
    const absentEntry = frozen.schedule[3];
    if (absentEntry === undefined) throw new Error("interrupted schedule entry is absent");
    expect(retainedEntries.every((entry) => journal.load(entry).recorded)).toBe(true);
    expect(journal.load(absentEntry).recorded).toBe(false);
    const retainedBytes = retainedEntries.map((entry) => {
      const bytes = journalBytes(targetArtifacts, frozen, entry);
      if (bytes === undefined) throw new Error(`retained journal '${entry.trial_id}' is absent`);
      return bytes;
    });

    let driftJournalLoads = 0;
    let driftPreflights = 0;
    let driftExecutions = 0;
    const noReuseJournal: EvaluationTrialJournalV1 = {
      load(entry) {
        driftJournalLoads += 1;
        return journal.load(entry);
      },
      record(entry, observation) {
        return journal.record(entry, observation);
      },
    };
    const noReuseExecutor = {
      async preflight() {
        driftPreflights += 1;
      },
      async execute() {
        driftExecutions += 1;
        throw new Error("drifted evaluation must not construct or execute a client");
      },
    };
    const driftedPopulation = {
      ...populationValue,
      tasks: populationValue.tasks.map((task, index) =>
        index === 0 ? { ...task, goal: `${task.goal} DRIFT` } : task
      ),
    };
    await expect(
      executeFrozenPairedEvaluation({
        frozen,
        population: driftedPopulation,
        plan: planValue,
        projectRoot: PROJECT_ROOT,
        env,
        baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
        candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
        ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
        executor: noReuseExecutor,
        gradingDefinition: grading,
        implementationBinding: boundImplementation.implementationBinding,
        runtimeFunctions: boundImplementation.runtimeFunctions,
        trialJournal: noReuseJournal,
      })
    ).rejects.toThrow();
    await expect(
      executeFrozenPairedEvaluation({
        frozen,
        population: populationValue,
        plan: { ...planValue, pair_order_seed: `${planValue.pair_order_seed}-drift` },
        projectRoot: PROJECT_ROOT,
        env,
        baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
        candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
        ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
        executor: noReuseExecutor,
        gradingDefinition: grading,
        implementationBinding: boundImplementation.implementationBinding,
        runtimeFunctions: boundImplementation.runtimeFunctions,
        trialJournal: noReuseJournal,
      })
    ).rejects.toThrow();
    const gradingRejection = await executeFrozenPairedEvaluation({
      frozen,
      population: populationValue,
      plan: planValue,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
      candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
      ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
      executor: noReuseExecutor,
      gradingDefinition: gradingDefinition("_DRIFT"),
      implementationBinding: boundImplementation.implementationBinding,
      runtimeFunctions: boundImplementation.runtimeFunctions,
      trialJournal: noReuseJournal,
    });
    expect(gradingRejection.result).toMatchObject({
      disposition: "INVALID_EVALUATION",
      invalid_evaluation: { stage: "registration_preflight" },
    });
    const registrationDrift = {
      ...PLAN_CANDIDATE_REGISTRATION,
      contract: {
        ...PLAN_CANDIDATE_REGISTRATION.contract,
        objective: `${PLAN_CANDIDATE_REGISTRATION.contract.objective} Drift.`,
      },
    };
    const registrationRejection = await executeFrozenPairedEvaluation({
      frozen,
      population: populationValue,
      plan: planValue,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
      candidateRegistry: new Map([["plan", registrationDrift]]),
      ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
      executor: noReuseExecutor,
      gradingDefinition: grading,
      implementationBinding: boundImplementation.implementationBinding,
      runtimeFunctions: boundImplementation.runtimeFunctions,
      trialJournal: noReuseJournal,
    });
    expect(registrationRejection.result).toMatchObject({
      disposition: "INVALID_EVALUATION",
      invalid_evaluation: { stage: "registration_preflight" },
    });
    const firstBoundFile = boundImplementation.implementationBinding.files[0];
    if (firstBoundFile === undefined) throw new Error("Plan implementation binding is empty");
    const implementationDrift = {
      ...boundImplementation.implementationBinding,
      files: boundImplementation.implementationBinding.files.map((file, index) =>
        index === 0 ? { ...file, sha256: "0".repeat(64) } : file
      ),
    };
    const implementationRejection = await executeFrozenPairedEvaluation({
      frozen,
      population: populationValue,
      plan: planValue,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
      candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
      ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
      executor: noReuseExecutor,
      gradingDefinition: grading,
      implementationBinding: implementationDrift,
      runtimeFunctions: boundImplementation.runtimeFunctions,
      trialJournal: noReuseJournal,
    });
    expect(implementationRejection.result).toMatchObject({
      disposition: "INVALID_EVALUATION",
      invalid_evaluation: { stage: "registration_preflight" },
    });
    expect(firstBoundFile.sha256).not.toBe("0".repeat(64));
    expect({ driftJournalLoads, driftPreflights, driftExecutions }).toEqual({
      driftJournalLoads: 0,
      driftPreflights: 0,
      driftExecutions: 0,
    });
    expect(retainedEntries.map((entry) => journalBytes(targetArtifacts, frozen, entry))).toEqual(
      retainedBytes
    );

    const resumed = await executeFrozenPairedEvaluation({
      frozen,
      population: populationValue,
      plan: planValue,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
      candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
      ablationRegistry: PLAN_EVALUATION_ABLATION_REGISTRY,
      executor,
      gradingDefinition: grading,
      implementationBinding: boundImplementation.implementationBinding,
      runtimeFunctions: boundImplementation.runtimeFunctions,
      trialJournal: journal,
      maxConcurrency: 1,
    });
    expect(resumed.execution_accounting).toEqual({
      newly_started_trials: 57,
      newly_recorded_terminals: 57,
      retained_journal_observations: 3,
      outstanding_schedule_entries: 0,
      loopback_provider_calls: 0,
    });
    expect(standardProbe.trial_starts.get(absentEntry.trial_id)).toBe(1);
    expect([...standardProbe.trial_starts.values()].every((count) => count === 1)).toBe(true);
    expect(standardProbe.client_constructions).toBe(60);
    expect(standardProbe.invocations).toHaveLength(120);
    expect(standardProbe.tool_calls).toBe(0);
    expect(standardProbe.network_calls).toBe(0);
    expect(
      standardProbe.invocations.every((invocation) => {
        if (invocation.livenessBudget?.external_requests.effective_remaining !== 8) return false;
        return (
          (invocation.stateId === "orienting_strategy" && invocation.agent === "piper") ||
          (invocation.stateId === "strategizing" && invocation.agent === "piper") ||
          (invocation.stateId === "verifying_strategy" && invocation.agent === "vera") ||
          (invocation.stateId === "critiquing_strategy" && invocation.agent === "carren")
        );
      })
    ).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(retainedEntries.map((entry) => journalBytes(targetArtifacts, frozen, entry))).toEqual(
      retainedBytes
    );

    expect(resumed.result.disposition).toBe("CANDIDATE");
    expect(PLAN_EVALUATION_LIFECYCLE).toBe("PREPARED_NOT_MEASURED");
    expect(resumed.result.aggregate_deltas).toMatchObject({
      baseline_primary_mean: 0.8,
      candidate_primary_mean: 1,
      primary_delta: 0.2,
      candidate_protected_mean: 1,
      candidate_trigger_precision: 1,
      negative_transfer_rate: 0,
      candidate_to_baseline_cost_ratio: 1.1,
      candidate_to_baseline_latency_ratio: 1.1,
    });
    expect(resumed.result.ablation_metrics).toEqual([
      {
        ablation_name: "plan-unsealed",
        ablation_primary_mean: 1,
        candidate_minus_ablation_primary_delta: 0,
        frozen_floor: 0,
        passed: true,
      },
    ]);
    expect(resumed.result.mutation_gate).toBeNull();
    expect(resumed.result.trial_accounting).toMatchObject({ scheduled: 60, complete: 60 });
    expect(resumed.result.trials.filter((trial) => trial.variant === "candidate")).toHaveLength(20);
    expect(resumed.result.trials.filter((trial) => trial.variant === "baseline")).toHaveLength(20);
    expect(resumed.result.trials.filter((trial) => trial.variant === "ablation")).toHaveLength(20);
    expect(PLAYBOOK_REGISTRY.has("plan")).toBe(false);
    expect([...CANDIDATE_PLAYBOOK_REGISTRY.keys()]).toEqual([
      "assess",
      "decide",
      "diagnose",
      "plan",
      "produce",
    ]);

    const markers = populationValue.tasks.map(oracleMarker);
    const modelVisibleSurfaces = standardProbe.invocations.flatMap((invocation) => [
      invocation.task,
      canonicalJson({
        input_artifacts: invocation.inputArtifacts,
        registration: invocation.registration,
        workflow_session: invocation.workflowSession,
        liveness_budget: invocation.livenessBudget,
      }),
      ...invocation.inputArtifacts.map((ref) =>
        targetArtifacts.readById(ref.artifact_id).toString("utf8")
      ),
    ]);
    using persistedStateInspector = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new PlanKnownDeltaClient(
        planValue.runtime_binding,
        "plan",
        populationValue.tasks[0]
      ),
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    expect(
      standardProbe.invocations.filter((invocation) => invocation.workflowSession !== undefined)
    ).toHaveLength(120);
    for (const trial of resumed.result.trials) {
      const context = persistedStateInspector.checkpointer.loadRunById(trial.trial_id);
      if (context === undefined) throw new Error(`persisted trial '${trial.trial_id}' is absent`);
      modelVisibleSurfaces.push(canonicalJson(context));
      for (const ref of [...trial.output_refs, ...context.selectedArtifacts]) {
        modelVisibleSurfaces.push(targetArtifacts.readById(ref.artifact_id).toString("utf8"));
      }
    }
    for (const marker of markers) {
      expect(modelVisibleSurfaces.every((surface) => !surface.includes(marker))).toBe(true);
      expect(canonicalJson(resumed.result)).not.toContain(marker);
    }

    const candidateTrial = resumed.result.trials.find((trial) => trial.variant === "candidate");
    const candidateRef = candidateTrial?.output_refs[0];
    if (candidateRef === undefined) throw new Error("candidate StrategyV1 ref is absent");
    expect(candidateRef).toMatchObject({
      kind: "strategy",
      content_schema: { schema_id: "penny.strategy.v1", schema_version: 1 },
    });
    expect(
      targetArtifacts
        .metadata(candidateRef)
        .upstream_refs.some((ref) => ref.kind === "plan-request")
    ).toBe(true);
    expect(targetArtifacts.read(resumed.result_artifact_ref).toString("utf8")).toBe(
      canonicalJson(resumed.result)
    );
    expect(resumed.frozen).toEqual(frozen);
  }, 240_000);
});
