import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArtifactStore,
  canonicalJson,
  initializePennyState,
  resolvePennyRuntimeState,
  type ArtifactRef,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluationPopulationSha256,
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
  type PairedEvaluationPlanV1,
} from "../../evaluation-contracts.js";
import {
  DETERMINISTIC_GRADING_DEFINITION,
  DIRECT_DEMETRI_BASELINE_REGISTRATION,
  GenericEvaluationTrialExecutor,
  SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
  SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION,
  executeFrozenPairedEvaluation,
  freezePairedEvaluation,
  runPairedEvaluation,
  syntheticEvaluationImplementationBinding,
  syntheticEvaluationRuntimeFunctions,
  syntheticKnownDeltaModelClientFactory,
  type EvaluationTrialExecutorV1,
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

function population() {
  return validateEvaluationPopulation(fixture("synthetic-known-delta.population.v1.json"));
}

function plan() {
  return validatePairedEvaluationPlan(fixture("synthetic-known-delta.plan.v1.json"));
}

function sandbox(): { readonly env: NodeJS.ProcessEnv; readonly root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "penny-known-delta-e2e-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return { env, root };
}

function implementation() {
  const runtimeFunctions = syntheticEvaluationRuntimeFunctions();
  return {
    implementationBinding: syntheticEvaluationImplementationBinding({
      projectRoot: PROJECT_ROOT,
      population: population(),
      plan: plan(),
      runtimeFunctions,
    }),
    runtimeFunctions,
  };
}

function genericExecutor(
  env: NodeJS.ProcessEnv,
  options: { readonly reverseDelta?: boolean } = {}
): GenericEvaluationTrialExecutor {
  return new GenericEvaluationTrialExecutor({
    projectRoot: PROJECT_ROOT,
    env,
    baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
    candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
    modelClientFactory: syntheticKnownDeltaModelClientFactory(options),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("P6 offline synthetic known-delta E2E", () => {
  it("passes the predeclared +0.5 gate and re-reads one immutable result artifact", async () => {
    const { env } = sandbox();
    const run = await runPairedEvaluation({
      population: population(),
      plan: plan(),
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(),
      executor: genericExecutor(env),
    });

    expect(run.result.aggregate_deltas.primary_delta).toBe(0.5);
    expect(run.result.disposition).toBe("CANDIDATE");
    expect(run.result.policy_outcomes.all_passed).toBe(true);
    expect(run.result_artifact_ref).toMatchObject({
      kind: "evaluation-result",
      content_schema: {
        schema_id: "penny.paired-evaluation-result.v1",
        schema_version: 1,
      },
      version: 1,
    });
    const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
    using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    expect(artifacts.readById(run.result_artifact_ref.artifact_id).toString("utf8")).toBe(
      canonicalJson(run.result)
    );
  });

  it("persists a parser-incompatible result without admission or promotion authority", async () => {
    const { env } = sandbox();
    const graders = new Map(DETERMINISTIC_GRADING_DEFINITION.implementations.graders);
    const alphaImplementation = graders.get("synthetic-alpha");
    if (alphaImplementation === undefined) {
      throw new Error("synthetic alpha grader implementation is absent");
    }
    graders.set("synthetic-alpha", {
      ...alphaImplementation,
      grade: () => {
        throw new Error("injected grader/parser incompatibility");
      },
    });
    const gradingDefinition = {
      descriptor: DETERMINISTIC_GRADING_DEFINITION.descriptor,
      implementations: {
        semantic_normalizers: DETERMINISTIC_GRADING_DEFINITION.implementations.semantic_normalizers,
        graders,
      },
    };
    const run = await runPairedEvaluation({
      population: population(),
      plan: plan(),
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(),
      executor: genericExecutor(env),
      gradingDefinition,
    });

    expect(run.result.disposition).toBe("INVALID_EVALUATION");
    expect(run.result.invalid_evaluation).toMatchObject({
      stage: "registration_preflight",
      code: "EVALUATION_REGISTRATION_INCOMPATIBLE",
    });
    expect(run.result.policy_outcomes.all_passed).toBe(false);
    expect(Object.keys(run.result)).not.toEqual(
      expect.arrayContaining(["admission", "promotion", "enablement"])
    );
    const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
    using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    expect(artifacts.read(run.result_artifact_ref).toString("utf8")).toBe(
      canonicalJson(run.result)
    );
  });

  it("re-reads and forwards each population-bound exact input ID through both paired trials", async () => {
    const { env } = sandbox();
    const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
    let exactInputRef: ArtifactRef;
    {
      using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
        projectId: state.projectId,
      });
      exactInputRef = artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: "evaluation-exact-input-fixture",
          phase: "fixture",
          branch_id: null,
          kind: "evaluation-input",
          operation_id: "evaluation-exact-input-fixture",
          version: 1,
          producer: "host:test",
          media_type: "application/json",
          content_schema: { schema_id: "penny.evaluation-input.v1", schema_version: 1 },
          parent_ref: null,
          upstream_refs: [],
        },
        content: canonicalJson({ schema_version: 1, value: "exact" }),
      });
    }
    const originalPopulation = population();
    const exactInputPopulation = validateEvaluationPopulation({
      ...originalPopulation,
      tasks: originalPopulation.tasks.map((task, index) =>
        index === 0 ? { ...task, exact_input_artifact_ids: [exactInputRef.artifact_id] } : task
      ),
    });
    const exactInputPlan = validatePairedEvaluationPlan({
      ...plan(),
      population: {
        population_id: exactInputPopulation.population_id,
        revision: exactInputPopulation.revision,
        sha256: evaluationPopulationSha256(exactInputPopulation),
      },
    });
    const run = await runPairedEvaluation({
      population: exactInputPopulation,
      plan: exactInputPlan,
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(),
      executor: genericExecutor(env),
    });
    const exactTaskId = exactInputPopulation.tasks[0]?.task_id;
    if (exactTaskId === undefined) throw new Error("exact-input task is absent");
    using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    const pairedOutputRefs = run.result.trials
      .filter((trial) => trial.task_id === exactTaskId)
      .flatMap((trial) => trial.output_refs);
    expect(pairedOutputRefs).toHaveLength(2);
    for (const outputRef of pairedOutputRefs) {
      expect(artifacts.metadata(outputRef).upstream_refs.map((ref) => ref.artifact_id)).toContain(
        exactInputRef.artifact_id
      );
    }
  });

  it("turns a reversed delta into deterministic NO_BUILD", async () => {
    const { env } = sandbox();
    const run = await runPairedEvaluation({
      population: population(),
      plan: plan(),
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(),
      executor: genericExecutor(env, { reverseDelta: true }),
    });
    expect(run.result.aggregate_deltas.primary_delta).toBe(-0.5);
    expect(run.result.aggregate_deltas.negative_transfer_rate).toBe(0.5);
    expect(run.result.policy_outcomes.material_effect).toBe(false);
    expect(run.result.policy_outcomes.negative_transfer).toBe(false);
    expect(run.result.disposition).toBe("NO_BUILD");
  });

  it("accounts for one deleted candidate pair as comparative undercoverage", async () => {
    const { env } = sandbox();
    const delegate = genericExecutor(env);
    let omitted = false;
    const executor: EvaluationTrialExecutorV1 = {
      execute: async (input) => {
        if (!omitted && input.entry.variant === "candidate") {
          omitted = true;
          return undefined;
        }
        return delegate.execute(input);
      },
    };
    const run = await runPairedEvaluation({
      population: population(),
      plan: plan(),
      projectRoot: PROJECT_ROOT,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(),
      executor,
    });
    expect(run.result.trial_accounting.missing).toBe(1);
    expect(run.result.complete_pair_coverage.incomplete_pairs).toBe(1);
    expect(run.result.policy_outcomes.complete_pairing).toBe(false);
    expect(run.result.comparison_validity.invalid_reasons).toEqual([
      "COMPLETE_PAIR_COVERAGE_BELOW_FLOOR",
    ]);
    expect(run.result.disposition).toBe("INVALID_EVALUATION");
  });

  it("refuses frozen-input drift and classifies registration drift before any trial", async () => {
    const originalPopulation = population();
    const originalPlan = plan();
    const freeze = freezePairedEvaluation({
      population: originalPopulation,
      plan: originalPlan,
      projectRoot: PROJECT_ROOT,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      ...implementation(),
    });
    let executions = 0;
    const executor: EvaluationTrialExecutorV1 = {
      execute: async () => {
        executions += 1;
        return undefined;
      },
    };

    const thresholdDrift: PairedEvaluationPlanV1 = {
      ...originalPlan,
      material_effect_threshold: 0.75,
    };
    const populationDrift = {
      ...originalPopulation,
      tasks: originalPopulation.tasks.map((task, index) =>
        index === 0 ? { ...task, goal: `${task.goal} changed after freeze` } : task
      ),
    };
    const driftedCandidate: PlaybookRegistrationV1 = {
      ...SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION,
      contract: {
        ...SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.contract,
        objective: `${SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.contract.objective} drift`,
      },
    };
    const driftedRegistry: PlaybookRegistryV1 = new Map([
      [driftedCandidate.name, driftedCandidate],
    ]);

    await expect(
      executeFrozenPairedEvaluation({
        frozen: freeze,
        population: originalPopulation,
        plan: thresholdDrift,
        projectRoot: PROJECT_ROOT,
        env: sandbox().env,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        ...implementation(),
        executor,
      })
    ).rejects.toThrow();
    await expect(
      executeFrozenPairedEvaluation({
        frozen: freeze,
        population: populationDrift,
        plan: originalPlan,
        projectRoot: PROJECT_ROOT,
        env: sandbox().env,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        ...implementation(),
        executor,
      })
    ).rejects.toThrow();
    const registrationDrift = await executeFrozenPairedEvaluation({
      frozen: freeze,
      population: originalPopulation,
      plan: originalPlan,
      projectRoot: PROJECT_ROOT,
      env: sandbox().env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: driftedRegistry,
      ...implementation(),
      executor,
    });
    expect(registrationDrift.result.disposition).toBe("INVALID_EVALUATION");
    expect(registrationDrift.result.invalid_evaluation).toMatchObject({
      stage: "registration_preflight",
      code: "EVALUATION_REGISTRATION_INCOMPATIBLE",
    });
    expect(executions).toBe(0);
  });

  it("refuses a held-out population declared in development/tuning contamination groups", () => {
    const populationValue = population();
    expect(() =>
      freezePairedEvaluation({
        population: populationValue,
        plan: plan(),
        projectRoot: PROJECT_ROOT,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        ...implementation(),
        forbiddenContaminationGroups: [populationValue.contamination_group],
      })
    ).toThrow(/contamination/u);
  });
});
