import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLAN_CANDIDATE_REGISTRATION,
  canonicalJson,
  sha256,
  skillContractSha256,
  type PlaybookRegistryV1,
} from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

import {
  evaluationPopulationSha256,
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
} from "../../evaluation-contracts.js";
import {
  localLiveModelClientFactory,
  preflightLocalLiveArtifactRead,
  preflightLocalLiveModel,
} from "../../evaluation-local-live.js";
import {
  DIRECT_PIPER_PLAN_BASELINE_NAME,
  DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
  PLAN_EVALUATION_CANDIDATE_REGISTRY,
  createPlanPartBGradingDefinition,
  validatePlanEvaluationCommonWire,
  validatePlanPartBOracleSet,
} from "../../plan-evaluation.js";
import {
  GenericEvaluationTrialExecutor,
  RealTopologyEvaluationReadinessPreflight,
  createEvaluationImplementationBinding,
  directBaselineDefinition,
  evaluationGradingDefinitionSha256,
} from "../../evaluation-runner.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const EMPTY_ABLATION_REGISTRY: PlaybookRegistryV1 = new Map();

function json(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8"));
}

function population() {
  return validateEvaluationPopulation(json("evals/fixtures/plan-part-b.population.v1.json"));
}

function developmentPopulation() {
  return validateEvaluationPopulation(json("evals/fixtures/plan-development.population.v1.json"));
}

function grading() {
  return createPlanPartBGradingDefinition({
    population: population(),
    oracleSet: validatePlanPartBOracleSet(json("evals/fixtures/plan-part-b.oracles.v1.json")),
  });
}

function plan() {
  return validatePairedEvaluationPlan(json("evals/fixtures/plan-part-b.plan.v1.json"));
}

function implementation(planValue: unknown) {
  const gradingDefinition = grading();
  const runtimeFunctions = [
    {
      role: "artifact_preflight" as const,
      owner: "plan-part-b",
      implementation: preflightLocalLiveArtifactRead,
    },
    {
      role: "model_client_factory" as const,
      owner: "plan-part-b",
      implementation: localLiveModelClientFactory,
    },
    {
      role: "model_preflight" as const,
      owner: "plan-part-b",
      implementation: preflightLocalLiveModel,
    },
    {
      role: "readiness_preflight" as const,
      owner: "plan-part-b",
      implementation: RealTopologyEvaluationReadinessPreflight.prototype.preflight,
    },
    {
      role: "readiness_common_wire_validator" as const,
      owner: "plan-part-b",
      implementation: validatePlanEvaluationCommonWire,
    },
    {
      role: "trial_executor_execute" as const,
      owner: "plan-part-b",
      implementation: GenericEvaluationTrialExecutor.prototype.execute,
    },
    {
      role: "trial_executor_preflight" as const,
      owner: "plan-part-b",
      implementation: GenericEvaluationTrialExecutor.prototype.preflight,
    },
  ];
  // HISTORICAL_OLD_SKILL_ROOT: immutable Plan Part-B preregistration binding evidence.
  // The retired package-root paths below must remain exact so the frozen plan stays stale.
  const candidateFiles = [
    {
      role: "registration_guidance" as const,
      owner: "plan",
      path: ".pi/skill-candidates/plan/assets/prompts/piper-orienting_strategy.md",
    },
    {
      role: "registration_guidance" as const,
      owner: "plan",
      path: ".pi/skill-candidates/plan/assets/prompts/echo-researching_strategy.md",
    },
    {
      role: "registration_guidance" as const,
      owner: "plan",
      path: ".pi/skill-candidates/plan/assets/prompts/piper-strategizing.md",
    },
    {
      role: "registration_guidance" as const,
      owner: "plan",
      path: ".pi/skill-candidates/plan/assets/prompts/vera-verifying_strategy.md",
    },
    {
      role: "registration_guidance" as const,
      owner: "plan",
      path: ".pi/skill-candidates/plan/assets/prompts/carren-critiquing_strategy.md",
    },
    { role: "agent_definition" as const, owner: "plan", path: ".pi/agents/piper.md" },
    { role: "agent_definition" as const, owner: "plan", path: ".pi/agents/echo.md" },
    { role: "agent_definition" as const, owner: "plan", path: ".pi/agents/vera.md" },
    { role: "agent_definition" as const, owner: "plan", path: ".pi/agents/carren.md" },
    {
      role: "registration_source" as const,
      owner: "plan",
      path: "apps/orchestration/src/playbooks/plan.ts",
    },
    {
      role: "contract_source" as const,
      owner: "plan",
      path: "apps/orchestration/src/skill-contracts/plan.ts",
    },
    {
      role: "playbook_source" as const,
      owner: "plan",
      path: "apps/orchestration/src/playbooks/plan.ts",
    },
    {
      role: "validator_source" as const,
      owner: "plan",
      path: "apps/orchestration/src/skill-contracts/plan.ts",
    },
    {
      role: "composition_source" as const,
      owner: "plan",
      path: "apps/orchestration/src/composition.ts",
    },
    {
      role: "validator_source" as const,
      owner: "plan",
      path: "apps/orchestration/src/skill-contracts/decide.ts",
    },
    {
      role: "validator_source" as const,
      owner: "plan",
      path: "apps/orchestration/src/skill-contracts/research.ts",
    },
    {
      role: "validator_source" as const,
      owner: "plan",
      path: "apps/orchestration/src/skill-contracts/review.ts",
    },
  ];
  const normalizerFiles = gradingDefinition.descriptor.semantic_normalizers.map((descriptor) => ({
    role: "normalizer_source" as const,
    owner: descriptor.registration_name,
    path: ".pi/extensions/skill/plan-evaluation.ts",
  }));
  const graderFiles = gradingDefinition.descriptor.graders.map((descriptor) => ({
    role: "grader_source" as const,
    owner: descriptor.grader_case_id,
    path: ".pi/extensions/skill/plan-evaluation.ts",
  }));
  const implementationBinding = createEvaluationImplementationBinding({
    projectRoot: PROJECT_ROOT,
    population: population(),
    plan: planValue,
    baselineRegistration: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
    candidateRegistry: PLAN_EVALUATION_CANDIDATE_REGISTRY,
    ablationRegistry: EMPTY_ABLATION_REGISTRY,
    gradingDefinition,
    files: [
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

describe("pre-registered Plan Part B product-level evaluation", () => {
  it("pins the exact preserved historical V1 fixture bytes", () => {
    expect(
      sha256(readFileSync(path.join(PROJECT_ROOT, "evals/fixtures/plan-part-b.population.v1.json")))
    ).toBe("1c23b33e99a23fb995f5651b101b28c48506da8426a6b1a544957474e38f8c26");
    expect(
      sha256(readFileSync(path.join(PROJECT_ROOT, "evals/fixtures/plan-part-b.oracles.v1.json")))
    ).toBe("0fa944e9386c66b74853e25f88c576804aece69190987602a63a95bdd039764d");
    expect(
      sha256(readFileSync(path.join(PROJECT_ROOT, "evals/fixtures/plan-part-b.plan.v1.json")))
    ).toBe("9435f466a742ebb2c9edf8feef30c6b126687503412b81669447dc986f5067c9");
  });

  it("freezes ten clean tasks across five domains with no development overlap", () => {
    const partB = population();
    const development = developmentPopulation();
    expect(partB.purpose).toBe("part_b");
    expect(partB.tasks).toHaveLength(10);
    expect(new Set(partB.tasks.map((task) => task.domain)).size).toBe(5);
    expect(partB.split).toBe("held_out");
    expect(new Set(partB.tasks.map((task) => task.task_id))).not.toEqual(
      new Set(development.tasks.map((task) => task.task_id))
    );
    expect(
      partB.tasks.some((task) => development.tasks.some((prior) => prior.goal === task.goal))
    ).toBe(false);
    expect(
      partB.tasks.some((task) => development.tasks.some((prior) => prior.domain === task.domain))
    ).toBe(false);
    expect(plan().population.sha256).toBe(evaluationPopulationSha256(partB));
  });

  it("preserves the historical real-local Plan binding and refuses it against the replacement candidate", () => {
    const planValue = plan();
    const gradingDefinition = grading();
    expect(planValue).toMatchObject({
      purpose: "part_b",
      runtime_binding: {
        provider: "ollama",
        model: "qwen3.8:latest",
        runtime: "local-live-pi-catalog-v1",
        thinking_level: "low",
      },
      deterministic_disposition_rule: { on_pass: "CANDIDATE", on_fail: "RETIRED" },
      mutation_gate: null,
    });
    expect(planValue.baseline).toEqual(
      directBaselineDefinition(DIRECT_PIPER_PLAN_BASELINE_REGISTRATION, PROJECT_ROOT)
    );
    expect(planValue.grader_registry_sha256).toBe(
      evaluationGradingDefinitionSha256(gradingDefinition)
    );
    expect(
      gradingDefinition.descriptor.semantic_normalizers.map((item) => item.registration_name)
    ).toEqual([DIRECT_PIPER_PLAN_BASELINE_NAME, "plan"]);
    expect(planValue.candidate.contract_sha256).not.toBe(
      skillContractSha256(PLAN_CANDIDATE_REGISTRATION.contract)
    );
    expect(planValue.implementation_binding_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => implementation(planValue)).toThrow(
      /candidate registration is unavailable or stale/iu
    );
    expect(planValue).toMatchObject({
      material_effect_threshold: 0,
      protected_capability_floor: 0.8,
      trigger_precision_floor: 0.9,
      negative_transfer_ceiling: 0.1,
      cost_latency_policy: {
        max_candidate_to_baseline_cost_ratio: 1.5,
        max_candidate_to_baseline_latency_ratio: 2,
      },
      deterministic_disposition_rule: { on_fail: "RETIRED" },
    });
  });

  it("keeps grader oracles and evaluation-only truth absent from baseline model requests", () => {
    const task = population().tasks[0];
    const admission = DIRECT_PIPER_PLAN_BASELINE_REGISTRATION.start_admission;
    if (admission === undefined) throw new Error("Plan direct baseline admission is absent");
    const prepared = admission.prepare(
      {
        schema_version: 2,
        action: "start",
        identity: {
          schema_version: 2,
          run_id: "plan-part-b-model-request-isolation",
          session_id: "plan-part-b-model-request-isolation",
          playbook: DIRECT_PIPER_PLAN_BASELINE_NAME,
          engine_owner: "typescript",
        },
        goal: task.goal,
        constraints: {
          evaluation_plan_id: plan().plan_id,
          schedule_sha256: "0".repeat(64),
          task_id: task.task_id,
          repetition: 1,
          variant: "baseline",
          task_constraints: task.constraints,
          model_override: `${plan().runtime_binding.provider}/${plan().runtime_binding.model}`,
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      },
      {}
    );
    const bytes = canonicalJson(prepared);
    expect(bytes).not.toMatch(
      /grader_case_id|trigger_expected|protected_capability|expected_disposition|expected_blocker|oracle/iu
    );
    expect(bytes).toContain(task.goal);
    expect(bytes).toContain("desired_outcomes");
    expect(PLAN_CANDIDATE_REGISTRATION.contract.release_status).toBe("candidate");
  });
});
