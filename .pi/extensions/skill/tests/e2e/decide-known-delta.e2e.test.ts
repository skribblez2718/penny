import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArtifactStore,
  CANDIDATE_PLAYBOOK_REGISTRY,
  DECIDE_CANDIDATE_REGISTRATION,
  PLAYBOOK_REGISTRY,
  OrchestrationService,
  canonicalJson,
  evaluateDecideLatestReviewedDecisionDod,
  initializePennyState,
  resolvePennyRuntimeState,
  sha256,
  validateDecision,
  validateDirective,
  type AgentCompletion,
  type AgentInvocation,
  type DecisionDraftV2,
  type SkillContract,
} from "@penny/orchestration/source";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
  type EvaluationMutationMeasurementV1,
  type PairedEvaluationScheduleEntryV1,
} from "../../evaluation-contracts.js";
import {
  DECIDE_EVALUATION_ABLATION_REGISTRY,
  DECIDE_EVALUATION_CANDIDATE_REGISTRY,
  DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
  DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION,
  createDecisionEvaluationGradingDefinition,
  decisionGraderDescriptor,
  parseDecisionGradingWire,
} from "../../decide-evaluation.js";
import { preflightLocalLiveArtifactRead } from "../../evaluation-local-live.js";
import {
  GenericEvaluationTrialExecutor,
  createEvaluationImplementationBinding,
  directBaselineDefinition,
  evaluationGradingDefinitionSha256,
  evaluationImplementationBindingSha256,
  freezePairedEvaluation,
  runPairedEvaluation,
  type DeterministicGraderImplementationV1,
  type EvaluationModelClientFactoryV1,
  type EvaluationRuntimeBindingV1,
  type EvaluationRuntimeMeasurementV1,
  type EvaluationTrialObservationV1,
  type MeasuredEvaluationModelClientV1,
} from "../../evaluation-runner.js";
import { validateSemanticComposition } from "../../../../../apps/orchestration/src/composition.js";
import { decisionDraft } from "../../../../../apps/orchestration/tests/fixtures/decision-fixtures.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const roots: string[] = [];
const GRADER_CASE_ID = "decide-development-selection-grader";
const MUTATION_IDS = [
  "coverage",
  "feasibility",
  "ranking",
  "reference_integrity",
  "sensitivity",
  "unresolved_handling",
  "request_binding",
  "execution_flag",
] as const;

function population() {
  return validateEvaluationPopulation(
    JSON.parse(
      readFileSync(
        path.join(PROJECT_ROOT, "evals", "fixtures", "decide-development.population.v1.json"),
        "utf8"
      )
    )
  );
}

const DECISION_GRADER: DeterministicGraderImplementationV1 = {
  grader_id: "penny.decide-development-exact-selection-grader.v1",
  grader_version: 1,
  implementation_sha256: sha256("penny.decide-development-exact-selection-grader.v1:decision-v2:1"),
  grade: (wireBytes) => {
    const wire = parseDecisionGradingWire(wireBytes);
    const selected =
      wire.outcome === "selected" &&
      wire.recommendation.kind === "selection" &&
      wire.recommendation.alternative_ids.length === 1 &&
      wire.recommendation.alternative_ids[0] === "alt_a";
    return {
      task_score: selected ? 1 : 0,
      trigger_predicted: wire.outcome !== "not_applicable",
      protected_capability_score: selected ? 1 : 0,
    };
  },
};

function gradingDefinition() {
  return createDecisionEvaluationGradingDefinition([
    {
      descriptor: decisionGraderDescriptor({
        graderCaseId: GRADER_CASE_ID,
        graderId: DECISION_GRADER.grader_id,
        protectedCapability: true,
        oracle: { expected_outcome: "selected", expected_alternative_id: "alt_a" },
      }),
      implementation: DECISION_GRADER,
    },
  ]);
}

function plan() {
  return validatePairedEvaluationPlan(
    JSON.parse(
      readFileSync(
        path.join(PROJECT_ROOT, "evals", "fixtures", "decide-evaluator-preparation.plan.v1.json"),
        "utf8"
      )
    )
  );
}

function baselineDraft(): DecisionDraftV2 {
  const draft = decisionDraft("selected");
  return {
    ...draft,
    rationale_report: "The direct baseline chooses the feasible but non-oracle alternative.",
    recommendation: { kind: "selection", alternative_ids: ["alt_b"] },
  };
}

class DecideKnownDeltaClient implements MeasuredEvaluationModelClientV1 {
  readonly runtime_binding: EvaluationRuntimeBindingV1;
  private invoked = false;

  constructor(
    runtimeBinding: EvaluationRuntimeBindingV1,
    private readonly variantName: string,
    private readonly scriptedOutput?: string
  ) {
    this.runtime_binding = runtimeBinding;
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invoked = true;
    if (invocation.stateId === "analyzing_decision" && invocation.agent === "annie") {
      return {
        text: 'Analysis complete.\nSUMMARY:{"confidence":"PROBABLE","analysis_complete":true,"gap_kind":"none","repair_owner":"none","findings":["All supplied alternatives were mapped."],"strategy_delta":"Proceed to the bounded decision assessment."}',
      };
    }
    if (invocation.stateId === "verifying_decision" && invocation.agent === "vera") {
      return {
        text: 'Validity checks pass.\nSUMMARY:{"confidence":"PROBABLE","verdict":"PASS","gap_kind":"none","repair_owner":"none","findings":[],"evidence":["The exact latest decision satisfies the request."],"strategy_delta":"Advance to quality critique."}',
      };
    }
    if (invocation.stateId === "critiquing_decision" && invocation.agent === "carren") {
      return {
        text: 'Quality review approves.\nSUMMARY:{"confidence":"PROBABLE","verdict":"APPROVE","gap_kind":"none","repair_owner":"none","findings":[],"evidence":["The exact latest decision is balanced and useful."],"strategy_delta":"Approve the exact latest product."}',
      };
    }
    if (invocation.agent !== "demetri" || invocation.stateId !== "deciding") {
      throw new Error("Decide evaluation invoked an unexpected cognitive phase");
    }
    const draft =
      this.variantName === DIRECT_DECIDE_DEMETRI_BASELINE_NAME
        ? baselineDraft()
        : decisionDraft("selected");
    const defaultOutput = persistedDraft(draft);
    return { text: this.scriptedOutput ?? defaultOutput };
  }

  measurement(_runId: string): EvaluationRuntimeMeasurementV1 {
    if (!this.invoked) return { cost_microusd: 0, latency_ms: 0 };
    return this.variantName === DIRECT_DECIDE_DEMETRI_BASELINE_NAME
      ? { cost_microusd: 100, latency_ms: 10 }
      : { cost_microusd: 110, latency_ms: 11 };
  }
}

function modelFactory(): EvaluationModelClientFactoryV1 {
  return ({ entry, plan: frozenPlan }) =>
    new DecideKnownDeltaClient(frozenPlan.runtime_binding, entry.variant_name);
}

function implementation(planValue: unknown) {
  const grading = gradingDefinition();
  const runtimeFunctions = [
    {
      role: "artifact_preflight" as const,
      owner: "decide-development",
      implementation: preflightLocalLiveArtifactRead,
    },
    {
      role: "model_client_factory" as const,
      owner: "decide-development",
      implementation: modelFactory,
    },
    {
      role: "model_preflight" as const,
      owner: "decide-development",
      implementation: preflightLocalLiveArtifactRead,
    },
    {
      role: "trial_executor_execute" as const,
      owner: "decide-development",
      implementation: GenericEvaluationTrialExecutor.prototype.execute,
    },
    {
      role: "trial_executor_preflight" as const,
      owner: "decide-development",
      implementation: GenericEvaluationTrialExecutor.prototype.preflight,
    },
  ];
  const evaluatedRegistrations = [
    DECIDE_CANDIDATE_REGISTRATION,
    ...DECIDE_EVALUATION_ABLATION_REGISTRY.values(),
  ];
  const candidateFiles = evaluatedRegistrations.flatMap((registration) => {
    const guidance = registration.worker.guidance;
    if (guidance.resolution !== "per_agent_phase") {
      throw new Error(`Decide evaluation registration '${registration.name}' guidance drifted`);
    }
    const phases = [...registration.worker.phases.entries()];
    const agents = [...new Set(phases.map(([, descriptor]) => descriptor.agent))];
    return [
      ...phases.map(([phase, descriptor]) => ({
        role: "registration_guidance" as const,
        owner: registration.name,
        path: path.posix.join(guidance.skill_root, `${descriptor.agent}-${phase}.md`),
      })),
      ...agents.map((agent) => ({
        role: "agent_definition" as const,
        owner: registration.name,
        path: `.pi/agents/${agent}.md`,
      })),
      {
        role: "registration_source" as const,
        owner: registration.name,
        path: "apps/orchestration/src/playbooks/decide.ts",
      },
      {
        role: "contract_source" as const,
        owner: registration.name,
        path: "apps/orchestration/src/skill-contracts/decide.ts",
      },
      {
        role: "playbook_source" as const,
        owner: registration.name,
        path: "apps/orchestration/src/playbooks/decide.ts",
      },
      {
        role: "validator_source" as const,
        owner: registration.name,
        path: "apps/orchestration/src/skill-contracts/decide.ts",
      },
      {
        role: "composition_source" as const,
        owner: registration.name,
        path: "apps/orchestration/src/composition.ts",
      },
    ];
  });
  const normalizerFiles = grading.descriptor.semantic_normalizers.map((descriptor) => ({
    role: "normalizer_source" as const,
    owner: descriptor.registration_name,
    path: ".pi/extensions/skill/decide-evaluation.ts",
  }));
  const graderFiles = grading.descriptor.graders.map((descriptor) => ({
    role: "grader_source" as const,
    owner: descriptor.grader_case_id,
    path: ".pi/extensions/skill/tests/e2e/decide-known-delta.e2e.test.ts",
  }));
  const implementationBinding = createEvaluationImplementationBinding({
    projectRoot: PROJECT_ROOT,
    population: population(),
    plan: planValue,
    baselineRegistration: DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION,
    candidateRegistry: DECIDE_EVALUATION_CANDIDATE_REGISTRY,
    ablationRegistry: DECIDE_EVALUATION_ABLATION_REGISTRY,
    gradingDefinition: grading,
    files: [
      {
        role: "registration_guidance",
        owner: DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
        path: "evals/guidance/decide/demetri-deciding.md",
      },
      {
        role: "agent_definition",
        owner: DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
        path: ".pi/agents/demetri.md",
      },
      {
        role: "registration_source",
        owner: DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
        path: ".pi/extensions/skill/decide-evaluation.ts",
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
        role: "evaluator_source",
        owner: "evaluation-runtime",
        path: "apps/orchestration/src/artifact-store.ts",
      },
      {
        role: "worker_source",
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
        role: "artifact_preflight_source",
        owner: "evaluation-runtime",
        path: ".pi/extensions/artifacts/artifact-runtime.ts",
      },
    ],
    runtimeFunctions,
  });
  return { implementationBinding, runtimeFunctions };
}

function persistedDraft(draft: DecisionDraftV2): string {
  const { rationale_report: rationaleReport, ...core } = draft;
  return `${rationaleReport}\nDECISION_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`;
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
      cohort: "decide-mutations-v1",
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

function decisionConsumerContract(): SkillContract {
  const contract = structuredClone(DECIDE_CANDIDATE_REGISTRATION.contract);
  contract.io.input_ports = [
    {
      schema_version: 1,
      name: "prior_decision",
      direction: "input",
      transport: "artifact",
      schema_id: "penny.decision.v2",
      schema_version_required: 2,
      artifact_kind: "semantic-core",
      source: "prior_skill",
      min_items: 1,
      max_items: 1,
      semantic_product: true,
    },
  ];
  return contract;
}

interface ProductMutationEvidenceV1 {
  readonly mutation_id: "request_binding" | "execution_flag";
  readonly completion_predicate_passed: boolean;
  readonly composition_admitted: boolean;
}

function productMutationEvidence(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly planValue: ReturnType<typeof plan>;
  readonly control: EvaluationTrialObservationV1;
}): readonly ProductMutationEvidenceV1[] {
  if (
    input.control.terminal_status !== "complete" ||
    input.control.output_ref?.kind !== "semantic-core" ||
    input.control.output_ref.content_schema?.schema_id !== "penny.decision.v2" ||
    input.control.output_bytes === undefined
  ) {
    throw new Error("valid mutation control did not produce a sealed DecisionV2 terminal");
  }
  using service = new OrchestrationService({
    projectRoot: PROJECT_ROOT,
    env: input.env,
    modelClient: new DecideKnownDeltaClient(input.planValue.runtime_binding, "decide"),
    playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
  });
  const sourceRef = input.control.output_ref;
  const sourceDecision = validateDecision(JSON.parse(input.control.output_bytes));
  const mutations = [
    {
      mutation_id: "request_binding" as const,
      product: { ...sourceDecision, request_sha256: "0".repeat(64) },
    },
    {
      mutation_id: "execution_flag" as const,
      product: { ...sourceDecision, execution_started: true },
    },
  ];
  return mutations.map((mutation) => {
    const mutatedRef = service.artifacts.persist({
      metadata: {
        ...service.artifacts.metadata(sourceRef),
        operation_id: `decide-product-mutation:${mutation.mutation_id}`,
        version: 1,
        parent_ref: null,
      },
      content: canonicalJson(mutation.product),
    });
    let compositionAdmitted = true;
    try {
      validateSemanticComposition({
        contract: decisionConsumerContract(),
        inputArtifacts: {
          schema_version: 2,
          artifacts: [{ slot: "previous-skill-terminal-output", ref: mutatedRef }],
        },
        artifactReader: service.artifacts,
      });
    } catch {
      compositionAdmitted = false;
    }

    const context = service.checkpointer.loadRunById(input.control.trial_id);
    if (context === undefined || context.terminalDirective?.action !== "complete") {
      throw new Error("valid mutation control checkpoint is not complete");
    }
    const selectedIndex = context.selectedArtifacts.findIndex(
      (artifact) => artifact.artifact_id === sourceRef.artifact_id
    );
    if (selectedIndex < 0) throw new Error("valid mutation control product is not selected");
    context.selectedArtifacts.splice(selectedIndex, 1, mutatedRef);
    const terminal = validateDirective({
      ...context.terminalDirective,
      result: { ...context.terminalDirective.result, output_artifact_ref: mutatedRef },
      artifacts: context.terminalDirective.artifacts.map((artifact) =>
        artifact.artifact_id === sourceRef.artifact_id ? mutatedRef : artifact
      ),
    });
    if (terminal.action !== "complete") {
      throw new Error("mutated completion candidate lost its terminal shape");
    }
    const completion = evaluateDecideLatestReviewedDecisionDod({
      checkpointer: service.checkpointer,
      context,
      terminal,
      originState: "critiquing_decision",
      latestProduct: {
        selector: "terminal_artifact",
        schema_id: "penny.decision.v2",
        product_schema_version: 2,
        product_id: mutatedRef.artifact_id,
        sha256: mutatedRef.content_digest,
      },
      artifactReader: service.artifacts,
      projectRoot: PROJECT_ROOT,
    });
    return {
      mutation_id: mutation.mutation_id,
      completion_predicate_passed: completion.passed,
      composition_admitted: compositionAdmitted,
    };
  });
}

interface DraftMutationEvidenceV1 {
  readonly mutation_id: (typeof MUTATION_IDS)[number];
  readonly candidate: EvaluationTrialObservationV1;
  readonly ablation: EvaluationTrialObservationV1;
  readonly raw_draft: string;
}

async function mutationMeasurement(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly planValue: ReturnType<typeof plan>;
  readonly frozen: ReturnType<typeof freezePairedEvaluation>;
  readonly task: ReturnType<typeof population>["tasks"][number];
}): Promise<{
  readonly measurement: EvaluationMutationMeasurementV1;
  readonly draft_evidence: readonly DraftMutationEvidenceV1[];
  readonly product_evidence: readonly ProductMutationEvidenceV1[];
  readonly ablation_applicable_mutation_count: number;
}> {
  const selected = decisionDraft("selected");
  const ranked = decisionDraft("ranked");
  const draftMutations: readonly {
    readonly mutation_id: DraftMutationEvidenceV1["mutation_id"];
    readonly draft: DecisionDraftV2;
  }[] = [
    {
      mutation_id: "coverage",
      draft: { ...selected, feasibility: selected.feasibility.slice(0, 2) },
    },
    {
      mutation_id: "feasibility",
      draft: {
        ...selected,
        feasibility: selected.feasibility.map((entry) =>
          entry.alternative_id === "alt_a" ? { ...entry, status: "infeasible" } : entry
        ),
      },
    },
    {
      mutation_id: "ranking",
      draft: {
        ...ranked,
        recommendation: { kind: "ranking", alternative_ids: ["alt_a"] },
      },
    },
    {
      mutation_id: "reference_integrity",
      draft: {
        ...selected,
        sensitivity: selected.sensitivity.map((entry) => ({
          ...entry,
          basis_ids: ["invented_preference"],
        })),
      },
    },
    { mutation_id: "sensitivity", draft: { ...selected, sensitivity: [] } },
    {
      mutation_id: "unresolved_handling",
      draft: {
        ...selected,
        has_blocking_unresolved: true,
        blocking_questions: ["Provide the blocking fact."],
      },
    },
  ];
  const ablation = input.planValue.ablations.find(
    (candidate) => candidate.name === "decide-unsealed"
  );
  if (ablation === undefined) throw new Error("frozen Decide ablation binding is absent");
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
    const raw = persistedDraft(mutation.draft);
    outputs.set(candidate.trial_id, raw);
    outputs.set(unsealed.trial_id, raw);
    return { mutation_id: mutation.mutation_id, candidate, unsealed, raw };
  });
  const controlEntry = mutationEntry({
    mutationId: "valid-product-control",
    variant: "candidate",
    variantName: input.planValue.candidate.name,
    bindingSha256: input.planValue.candidate.contract_sha256,
    taskId: input.task.task_id,
    ordinal: draftMutations.length * 2,
  });
  outputs.set(controlEntry.trial_id, persistedDraft(selected));
  const scriptedFactory: EvaluationModelClientFactoryV1 = ({ entry, plan: frozenPlan }) => {
    const output = outputs.get(entry.trial_id);
    if (output === undefined) throw new Error(`mutation output '${entry.trial_id}' is absent`);
    return new DecideKnownDeltaClient(frozenPlan.runtime_binding, entry.variant_name, output);
  };
  const executor = new GenericEvaluationTrialExecutor({
    projectRoot: PROJECT_ROOT,
    env: input.env,
    baselineRegistration: DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION,
    candidateRegistry: DECIDE_EVALUATION_CANDIDATE_REGISTRY,
    ablationRegistry: DECIDE_EVALUATION_ABLATION_REGISTRY,
    modelClientFactory: scriptedFactory,
  });
  const draftEvidence: DraftMutationEvidenceV1[] = [];
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
  const control = await executor.execute({
    entry: controlEntry,
    task: input.task,
    plan: input.planValue,
    frozen: input.frozen,
  });
  const productEvidence = productMutationEvidence({
    env: input.env,
    planValue: input.planValue,
    control,
  });
  fullEscapes += productEvidence.filter(
    (evidence) => evidence.completion_predicate_passed || evidence.composition_admitted
  ).length;
  return {
    measurement: {
      cohort_sha256: sha256(canonicalJson(MUTATION_IDS)),
      mutation_count: MUTATION_IDS.length,
      full_sealer_escaped_invalid_count: fullEscapes,
      ablation_escaped_invalid_count: unsealedEscapes,
    },
    draft_evidence: draftEvidence,
    product_evidence: productEvidence,
    ablation_applicable_mutation_count: draftMutations.length,
  };
}

function sandbox(): { readonly env: NodeJS.ProcessEnv; readonly root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "penny-decide-known-delta-"));
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

describe("provider-free Decide known-delta and mutation E2E", () => {
  it("normalizes baseline/candidate/unsealed descriptors and verifies draft validation plus product mutation containment", async () => {
    const { env, root } = sandbox();
    const populationValue = population();
    const planValue = plan();
    const grading = gradingDefinition();
    expect(planValue.grader_registry_sha256).toBe(evaluationGradingDefinitionSha256(grading));
    expect(planValue.baseline).toEqual(
      directBaselineDefinition(DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION, PROJECT_ROOT)
    );

    const boundImplementation = implementation(planValue);
    expect(evaluationImplementationBindingSha256(boundImplementation.implementationBinding)).toBe(
      planValue.implementation_binding_sha256
    );
    const frozen = freezePairedEvaluation({
      population: populationValue,
      plan: planValue,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: DECIDE_EVALUATION_CANDIDATE_REGISTRY,
      ...boundImplementation,
      ablationRegistry: DECIDE_EVALUATION_ABLATION_REGISTRY,
      gradingDefinition: grading,
    });
    const decoyRoot = path.join(root, "decoy-state");
    initializePennyState(PROJECT_ROOT, { env: { PENNY_STATE_ROOT: decoyRoot } });
    const processEnv: NodeJS.ProcessEnv = {};
    await preflightLocalLiveArtifactRead({
      projectRoot: PROJECT_ROOT,
      env,
      processEnv,
      frozen,
    });
    expect(processEnv.PENNY_STATE_ROOT).toBe(env.PENNY_STATE_ROOT);
    processEnv.PENNY_STATE_ROOT = decoyRoot;
    await expect(
      preflightLocalLiveArtifactRead({
        projectRoot: PROJECT_ROOT,
        env,
        processEnv,
        frozen,
      })
    ).rejects.toMatchObject({ code: "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE" });

    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const mutationRun = await mutationMeasurement({
      env,
      planValue,
      frozen,
      task: populationValue.tasks[0],
    });
    expect(mutationRun.measurement).toMatchObject({
      mutation_count: 8,
      full_sealer_escaped_invalid_count: 0,
      ablation_escaped_invalid_count: 0,
    });
    expect(mutationRun.ablation_applicable_mutation_count).toBe(6);
    expect(
      mutationRun.draft_evidence.map((evidence) => ({
        mutation_id: evidence.mutation_id,
        candidate_terminal: evidence.candidate.terminal_status,
        candidate_product_kind: evidence.candidate.output_ref?.kind,
        ablation_terminal: evidence.ablation.terminal_status,
        ablation_product_kind: evidence.ablation.output_ref?.kind,
        ablation_raw_draft_observed: evidence.ablation.output_bytes === evidence.raw_draft,
      }))
    ).toEqual(
      MUTATION_IDS.slice(0, 6).map((mutationId) => ({
        mutation_id: mutationId,
        candidate_terminal: "error",
        candidate_product_kind: "decision-draft",
        ablation_terminal: "error",
        ablation_product_kind: "decision-draft",
        ablation_raw_draft_observed: false,
      }))
    );
    expect(mutationRun.product_evidence).toEqual([
      {
        mutation_id: "request_binding",
        completion_predicate_passed: false,
        composition_admitted: false,
      },
      {
        mutation_id: "execution_flag",
        completion_predicate_passed: false,
        composition_admitted: false,
      },
    ]);

    const executor = new GenericEvaluationTrialExecutor({
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: DECIDE_EVALUATION_CANDIDATE_REGISTRY,
      ablationRegistry: DECIDE_EVALUATION_ABLATION_REGISTRY,
      modelClientFactory: modelFactory(),
    });
    const run = await runPairedEvaluation({
      population: populationValue,
      plan: planValue,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: DECIDE_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(planValue),
      ablationRegistry: DECIDE_EVALUATION_ABLATION_REGISTRY,
      executor,
      gradingDefinition: grading,
    });

    expect(network).not.toHaveBeenCalled();
    expect(run.result.disposition).toBe("CANDIDATE");
    expect(run.result.aggregate_deltas).toMatchObject({
      baseline_primary_mean: 0,
      candidate_primary_mean: 1,
      primary_delta: 1,
      candidate_protected_mean: 1,
      candidate_trigger_precision: 1,
      negative_transfer_rate: 0,
      candidate_to_baseline_cost_ratio: 1.1,
      candidate_to_baseline_latency_ratio: 1.1,
    });
    expect(run.result.ablation_metrics).toEqual([
      {
        ablation_name: "decide-unsealed",
        ablation_primary_mean: 1,
        candidate_minus_ablation_primary_delta: 0,
        frozen_floor: 0,
        passed: true,
      },
    ]);
    expect(run.result.mutation_gate).toBeNull();
    expect(run.result.trial_accounting).toMatchObject({ scheduled: 3, complete: 3 });
    expect(PLAYBOOK_REGISTRY.has("decide")).toBe(false);
    expect([...CANDIDATE_PLAYBOOK_REGISTRY.keys()]).toEqual([
      "assess",
      "decide",
      "diagnose",
      "plan",
      "produce",
    ]);

    const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
    using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    const candidateTrial = run.result.trials.find((trial) => trial.variant === "candidate");
    const candidateRef = candidateTrial?.output_refs[0];
    if (candidateRef === undefined) throw new Error("candidate DecisionV2 ref is absent");
    expect(candidateRef).toMatchObject({
      kind: "semantic-core",
      content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
    });
    expect(
      artifacts.metadata(candidateRef).upstream_refs.some((ref) => ref.kind === "decision-request")
    ).toBe(true);
    expect(artifacts.read(run.result_artifact_ref).toString("utf8")).toBe(
      canonicalJson(run.result)
    );
    expect(run.frozen).toEqual(frozen);
  }, 120_000);
});
