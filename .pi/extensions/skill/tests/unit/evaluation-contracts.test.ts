import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_PLAYBOOK_REGISTRY,
  RunContext,
  canonicalJson,
  sha256,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

import {
  assertFrozenEvaluationInputs,
  evaluationPopulationSha256,
  freezePairedEvaluationContracts,
  materializePairedEvaluationSchedule,
  pairedEvaluationPlanSha256,
  pairedEvaluationResultId,
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
  validatePairedEvaluationResult,
  type PairedEvaluationPlanV1,
  type PairedEvaluationResultV1,
  type PairedEvaluationScheduleEntryV1,
} from "../../evaluation-contracts.js";
import {
  DETERMINISTIC_GRADING_DEFINITION,
  DIRECT_DEMETRI_BASELINE_REGISTRATION,
  SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
  createDirectAgentBaselineRegistration,
  directBaselineDefinition,
  evaluateTrialObservations,
  evaluationGradingDefinitionSha256,
  freezePairedEvaluation,
  knownDeltaCandidateContractSha256,
  syntheticEvaluationImplementationBinding,
  syntheticEvaluationRuntimeFunctions,
  type EvaluationTrialObservationV1,
} from "../../evaluation-runner.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, "evals", "fixtures", name), "utf8"));
}

function population() {
  return validateEvaluationPopulation(fixture("synthetic-known-delta.population.v1.json"));
}

function plan() {
  return validatePairedEvaluationPlan(fixture("synthetic-known-delta.plan.v1.json"));
}

function fakeRef(entry: PairedEvaluationScheduleEntryV1, output: string): ArtifactRef {
  const digest = sha256(output);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(entry.trial_id)}`,
    run_id: entry.trial_id,
    phase: "evaluating",
    branch_id: null,
    kind: "agent-output",
    operation_id: `test:${entry.trial_id}`,
    version: 1,
    producer: "agent:demetri",
    media_type: "text/plain; charset=utf-8",
    content_schema: {
      schema_id: "penny.evaluation-trial-output.v1",
      schema_version: 1,
    },
    byte_length: Buffer.byteLength(output),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

const EXPECTED_ANSWER: Readonly<Record<string, string>> = {
  "synthetic-task-alpha": "alpha",
  "synthetic-task-beta": "beta",
  "synthetic-task-gamma-protected": "gamma",
  "synthetic-task-delta-negative-trigger": "delta",
  "synthetic-task-alpha-second-domain": "alpha",
};

function outputFor(
  entry: PairedEvaluationScheduleEntryV1,
  options: {
    readonly reverse?: boolean;
    readonly protectedRegression?: boolean;
    readonly falsePositiveTrigger?: boolean;
  } = {}
): string {
  const expected = EXPECTED_ANSWER[entry.task_id];
  if (expected === undefined) throw new Error(`missing expected answer for '${entry.task_id}'`);
  const candidate = entry.variant === "candidate";
  const advantaged = options.reverse === true ? !candidate : candidate;
  const deltaTask =
    entry.task_id === "synthetic-task-alpha" || entry.task_id === "synthetic-task-beta";
  const protectedRegression =
    options.protectedRegression === true &&
    candidate &&
    entry.task_id === "synthetic-task-gamma-protected";
  const answer = protectedRegression || (deltaTask && !advantaged) ? `wrong-${expected}` : expected;
  const triggerPredicted =
    options.falsePositiveTrigger === true &&
    candidate &&
    entry.task_id === "synthetic-task-delta-negative-trigger"
      ? true
      : entry.task_id !== "synthetic-task-delta-negative-trigger";
  return `${canonicalJson({
    schema_version: 1,
    task_id: entry.task_id,
    answer,
    trigger_predicted: triggerPredicted,
  })}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`;
}

function fakeMetadata(ref: ArtifactRef): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: ref.run_id,
    phase: ref.phase,
    branch_id: ref.branch_id,
    kind: ref.kind,
    operation_id: ref.operation_id,
    version: ref.version,
    producer: ref.producer,
    media_type: ref.media_type,
    ...(ref.content_schema === undefined ? {} : { content_schema: ref.content_schema }),
    parent_ref: null,
    upstream_refs: [],
  };
}

function observations(
  schedule: readonly PairedEvaluationScheduleEntryV1[],
  options: {
    readonly reverse?: boolean;
    readonly protectedRegression?: boolean;
    readonly falsePositiveTrigger?: boolean;
    readonly candidateCost?: number;
    readonly candidateLatency?: number;
  } = {}
): EvaluationTrialObservationV1[] {
  return schedule.map((entry) => {
    const output = outputFor(entry, options);
    const ref = fakeRef(entry, output);
    return {
      trial_id: entry.trial_id,
      terminal_status: "complete",
      output_ref: ref,
      output_metadata: fakeMetadata(ref),
      output_bytes: output,
      cost_microusd: entry.variant === "candidate" ? (options.candidateCost ?? 110) : 100,
      latency_ms: entry.variant === "candidate" ? (options.candidateLatency ?? 11) : 10,
    };
  });
}

function identifiedResult(
  body: Omit<PairedEvaluationResultV1, "result_id">
): PairedEvaluationResultV1 {
  return { ...body, result_id: pairedEvaluationResultId(body) };
}

function implementation(planValue: unknown = plan(), populationValue: unknown = population()) {
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

function frozen() {
  return freezePairedEvaluation({
    population: population(),
    plan: plan(),
    projectRoot: PROJECT_ROOT,
    baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
    candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
    ...implementation(),
  });
}

describe("P6 closed evaluation contracts and deterministic freeze", () => {
  it("validates exact fixture digests, direct baseline, and a stable complete paired schedule", () => {
    const populationValue = population();
    const planValue = plan();
    const first = freezePairedEvaluationContracts({
      population: populationValue,
      plan: planValue,
    });
    const second = freezePairedEvaluationContracts({
      population: populationValue,
      plan: planValue,
    });

    expect(evaluationPopulationSha256(populationValue)).toBe(planValue.population.sha256);
    expect(pairedEvaluationPlanSha256(planValue)).toBe(first.plan_sha256);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.schedule_sha256).toBe(sha256(canonicalJson(first.schedule)));
    expect(first.schedule).toHaveLength(populationValue.tasks.length * 2);
    expect(new Set(first.schedule.map((entry) => entry.pair_id))).toHaveLength(
      populationValue.tasks.length
    );
    expect(directBaselineDefinition(DIRECT_DEMETRI_BASELINE_REGISTRATION, PROJECT_ROOT)).toEqual(
      planValue.baseline
    );
    expect(knownDeltaCandidateContractSha256()).toBe(planValue.candidate.contract_sha256);
    expect(evaluationGradingDefinitionSha256(DETERMINISTIC_GRADING_DEFINITION)).toBe(
      planValue.grader_registry_sha256
    );
    expect(
      materializePairedEvaluationSchedule({ population: populationValue, plan: planValue })
    ).toEqual(first.schedule);
  });

  it("keeps the direct-baseline source projection closed over non-oracle fields", () => {
    const source = readFileSync(
      path.join(PROJECT_ROOT, ".pi", "extensions", "skill", "evaluation-runner.ts"),
      "utf8"
    );
    const schemaStart = source.indexOf("const DirectBaselineStartConstraintsV1Schema");
    const schemaEnd = source.indexOf("const DIRECT_BASELINE_ORACLE_FIELDS", schemaStart);
    const dispatchStart = source.indexOf("class EvaluationOneStatePlaybook");
    const dispatchEnd = source.indexOf("function evaluationContract", dispatchStart);
    const trialStart = source.indexOf("function trialStartConstraints");
    const trialEnd = source.indexOf("class ExplicitEvaluationModelExecutionFault", trialStart);
    expect([
      schemaStart,
      schemaEnd,
      dispatchStart,
      dispatchEnd,
      trialStart,
      trialEnd,
    ]).not.toContain(-1);
    const directSource = [
      source.slice(schemaStart, schemaEnd),
      source.slice(dispatchStart, dispatchEnd),
      source.slice(trialStart, trialEnd),
    ].join("\n");
    for (const field of [
      "grader_case_id",
      "trigger_expected",
      "expected_answer",
      "expected_outcome",
      "protected_capability",
      "material_effect_threshold",
      "mutation_oracle",
      "grader_descriptor",
    ]) {
      expect(directSource).not.toContain(field);
    }
  });

  it("constructs and defines a direct Piper StrategyDraft baseline without evaluator changes", () => {
    const registration = createDirectAgentBaselineRegistration({
      registrationName: "evaluation-direct-piper-strategy-draft",
      agent: "piper",
      phase: "planning",
      guidance: {
        skill_root: ".pi/skills/research/assets/prompts",
        resolution: "per_agent_phase",
      },
      output: {
        portName: "strategy_draft",
        artifactKind: "strategy-draft",
        schemaId: "penny.strategy-draft.v1",
        schemaVersion: 1,
        mediaType: "application/json",
      },
    });
    const definition = directBaselineDefinition(registration, PROJECT_ROOT);
    expect(definition).toMatchObject({
      registration_name: registration.name,
      agent: "piper",
      phase: "planning",
      guidance: {
        skill_root: ".pi/skills/research/assets/prompts",
        resolution: "per_agent_phase",
        path: ".pi/skills/research/assets/prompts/piper-planning.md",
      },
      output: {
        artifact_kind: "strategy-draft",
        schema_id: "penny.strategy-draft.v1",
        schema_version: 1,
        producer: "agent:piper",
        media_type: "application/json",
      },
    });
    expect(registration.worker.phases.get("planning")?.agent).toBe("piper");
    expect(registration.contract.io.active_output_ports).toEqual([
      expect.objectContaining({
        name: "strategy_draft",
        artifact_kind: "strategy-draft",
        schema_id: "penny.strategy-draft.v1",
        schema_version_required: 1,
      }),
    ]);

    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: `evaltrial_${"1".repeat(64)}`,
        session_id: `evaltrial_${"1".repeat(64)}`,
        playbook: registration.name,
        engine_owner: "typescript",
      },
      goal: "Produce the direct StrategyDraft baseline.",
      constraints: {
        evaluation_plan_id: "piper-strategy-draft-test",
        schedule_sha256: "0".repeat(64),
        task_id: "piper-strategy-draft-test",
        repetition: 1,
        variant: "baseline",
        task_constraints: {},
        model_override: "offline/piper-strategy-draft-test",
      },
      projectRoot: PROJECT_ROOT,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
    });
    const directive = registration.construct({}).initialize(context);
    expect(directive).toMatchObject({
      action: "invoke_agent",
      state_id: "planning",
      agent: "piper",
      output_artifact: {
        phase: "planning",
        kind: "strategy-draft",
        producer: "agent:piper",
        content_schema: {
          schema_id: "penny.strategy-draft.v1",
          schema_version: 1,
        },
      },
    });
    if (directive.action !== "invoke_agent") {
      throw new Error("direct baseline probe did not invoke Piper");
    }
    expect(JSON.parse(directive.task)).toEqual({
      schema_version: 1,
      task_id: "piper-strategy-draft-test",
      goal: "Produce the direct StrategyDraft baseline.",
      constraints: {},
    });
    expect(context.constraints).toEqual({
      evaluation_plan_id: "piper-strategy-draft-test",
      schedule_sha256: "0".repeat(64),
      task_id: "piper-strategy-draft-test",
      repetition: 1,
      variant: "baseline",
      task_constraints: {},
      model_override: "offline/piper-strategy-draft-test",
    });
  });

  it("rejects unknown fields, real-population undercoverage, and declared contamination", () => {
    const populationValue = population();
    const planValue = plan();
    expect(() =>
      validateEvaluationPopulation({ ...populationValue, threshold_after_results: 0.5 })
    ).toThrow();
    expect(() => validatePairedEvaluationPlan({ ...planValue, promotion: true })).toThrow();
    expect(() =>
      validateEvaluationPopulation(
        { ...populationValue, purpose: "candidate_warrant" },
        { forbiddenContaminationGroups: [] }
      )
    ).toThrow(/five unrelated domains/u);
    expect(() =>
      freezePairedEvaluationContracts({
        population: populationValue,
        plan: planValue,
        forbiddenContaminationGroups: [populationValue.contamination_group],
      })
    ).toThrow(/contamination/u);
  });

  it("requires frozen normalized-completion floors for every ablation comparator", () => {
    const comparatorPlan = validatePairedEvaluationPlan(fixture("plan-development.plan.v1.json"));
    expect(comparatorPlan.ablations.map((ablation) => ablation.name)).toEqual(["plan-unsealed"]);
    expect(
      comparatorPlan.comparison_validity_policy.required_comparator_normalized_completion_floors
    ).toEqual([
      {
        comparator_name: "plan-unsealed",
        normalized_completion_floor: 1,
      },
    ]);
    expect(() =>
      validatePairedEvaluationPlan({
        ...comparatorPlan,
        comparison_validity_policy: {
          ...comparatorPlan.comparison_validity_policy,
          required_comparator_normalized_completion_floors: [],
        },
      })
    ).toThrow(/exact ablation parity/u);
    expect(() =>
      validatePairedEvaluationPlan({
        ...comparatorPlan,
        comparison_validity_policy: {
          ...comparatorPlan.comparison_validity_policy,
          required_comparator_normalized_completion_floors: [
            {
              comparator_name: "stale-comparator",
              normalized_completion_floor: 1,
            },
          ],
        },
      })
    ).toThrow(/exact ablation parity/u);
  });

  it("detects threshold and population drift against one pre-freeze binding", () => {
    const populationValue = population();
    const planValue = plan();
    const freeze = frozen();
    const thresholdDrift: PairedEvaluationPlanV1 = {
      ...planValue,
      material_effect_threshold: 0.75,
    };
    const populationDrift = {
      ...populationValue,
      tasks: populationValue.tasks.map((task, index) =>
        index === 0 ? { ...task, goal: `${task.goal} drift` } : task
      ),
    };
    expect(() =>
      assertFrozenEvaluationInputs({
        frozen: freeze,
        population: populationValue,
        plan: thresholdDrift,
      })
    ).toThrow();
    expect(() =>
      assertFrozenEvaluationInputs({ frozen: freeze, population: populationDrift, plan: planValue })
    ).toThrow();
  });

  it("keeps the source decide candidate disabled and dispositions non-authoritative", () => {
    expect([...CANDIDATE_PLAYBOOK_REGISTRY.keys()]).toEqual([
      "assess",
      "decide",
      "diagnose",
      "plan",
      "produce",
    ]);
    const freeze = frozen();
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: plan(),
      observations: observations(freeze.schedule),
    });
    expect(result.disposition).toBe("CANDIDATE");
    expect(Object.keys(result)).not.toEqual(
      expect.arrayContaining(["admission", "promotion", "enablement"])
    );
    expect(() => validatePairedEvaluationResult({ ...result, disposition: "ADMITTED" })).toThrow();
    expect(() =>
      validatePairedEvaluationResult({ ...result, promotion_authority: true })
    ).toThrow();
  });

  it("enforces INVALID_EVALUATION marker and policy invariants", () => {
    const freeze = frozen();
    const historical = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: plan(),
      observations: observations(freeze.schedule),
    });
    expect(validatePairedEvaluationResult(historical)).toEqual(historical);
    const { result_id: _resultId, ...historicalBody } = historical;
    const failedPolicies = {
      comparison_validity: false,
      complete_pairing: false,
      material_effect: false,
      protected_capability: false,
      trigger_precision: false,
      negative_transfer: false,
      cost: false,
      latency: false,
      ablation_non_inferiority: false,
      deterministic_mutation: false,
      all_passed: false,
    };
    const incompatibleComparison = {
      ...historicalBody.comparison_validity,
      status: "COMPARATIVE_UNVERIFIABLE" as const,
      invalid_reasons: ["EVALUATION_INCOMPATIBILITY" as const],
    };
    const invalidWithoutMarker = identifiedResult({
      ...historicalBody,
      comparison_validity: incompatibleComparison,
      policy_outcomes: failedPolicies,
      disposition: "INVALID_EVALUATION",
      disposition_reason: "EVALUATION_INCOMPATIBILITY",
    });
    expect(() => validatePairedEvaluationResult(invalidWithoutMarker)).toThrow(/requires/u);

    const marker = {
      stage: "grader_parser" as const,
      code: "GRADER_PARSER_INCOMPATIBLE",
      trial_id: null,
    };
    const compatibleFailedPolicies = {
      ...failedPolicies,
      ablation_non_inferiority: true,
      deterministic_mutation: true,
    };
    for (const disposition of ["NO_BUILD", "RETIRED", "CANDIDATE"] as const) {
      const markedNonInvalid = identifiedResult({
        ...historicalBody,
        comparison_validity: incompatibleComparison,
        policy_outcomes: compatibleFailedPolicies,
        invalid_evaluation: marker,
        disposition,
        disposition_reason: "EVALUATION_INCOMPATIBILITY",
      });
      expect(() => validatePairedEvaluationResult(markedNonInvalid)).toThrow(/prohibit/u);
    }
    const invalidAllPassed = identifiedResult({
      ...historicalBody,
      comparison_validity: incompatibleComparison,
      invalid_evaluation: marker,
      disposition: "INVALID_EVALUATION",
      disposition_reason: "EVALUATION_INCOMPATIBILITY",
    });
    expect(() => validatePairedEvaluationResult(invalidAllPassed)).toThrow();
  });

  it("uses RETIRED as the only Part B failure disposition", () => {
    const basePopulation = population();
    const realPopulation = validateEvaluationPopulation({
      ...basePopulation,
      purpose: "part_b",
      tasks: [
        ...basePopulation.tasks.map((task, index) => ({
          ...task,
          domain: `unrelated-domain-${index + 1}`,
        })),
        {
          ...basePopulation.tasks[0],
          task_id: "synthetic-task-alpha-second-domain",
          domain: "unrelated-domain-5",
        },
      ],
    });
    const basePlan = plan();
    const provisionalPartBPlan = validatePairedEvaluationPlan({
      ...basePlan,
      purpose: "part_b",
      population: {
        population_id: realPopulation.population_id,
        revision: realPopulation.revision,
        sha256: evaluationPopulationSha256(realPopulation),
      },
      comparison_validity_policy: {
        ...basePlan.comparison_validity_policy,
        readiness_preflight: {
          ...basePlan.comparison_validity_policy.readiness_preflight,
          required: true,
          calibration_cohort_sha256: "0".repeat(64),
          repetitions: 1,
          baseline_normalized_completion_floor: 0.9,
          candidate_normalized_completion_floor: 0.9,
          complete_all_arm_pair_floor: 0.8,
          required_comparator_normalized_completion_floors: [],
        },
      },
      deterministic_disposition_rule: { on_pass: "CANDIDATE", on_fail: "RETIRED" },
    });
    const partBPlan = provisionalPartBPlan;
    const partBFreeze = freezePairedEvaluationContracts({
      population: realPopulation,
      plan: partBPlan,
    });
    const result = evaluateTrialObservations({
      frozen: partBFreeze,
      population: realPopulation,
      plan: partBPlan,
      observations: observations(partBFreeze.schedule, { reverse: true }),
    });
    expect(result.comparison_validity.status).toBe("VALID");
    expect(result.disposition).toBe("RETIRED");
    expect(result.disposition_reason).toBe("FROZEN_POLICY_FAIL");
  });
});

describe("P6 frozen policy evaluation", () => {
  it("keeps a normal valid comparison and its frozen quality decision unchanged", () => {
    const freeze = frozen();
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: plan(),
      observations: observations(freeze.schedule),
    });
    expect(result.aggregate_deltas).toMatchObject({
      baseline_primary_mean: 0.5,
      candidate_primary_mean: 1,
      primary_delta: 0.5,
      candidate_protected_mean: 1,
      candidate_trigger_precision: 1,
      negative_transfer_rate: 0,
      candidate_to_baseline_cost_ratio: 1.1,
      candidate_to_baseline_latency_ratio: 1.1,
    });
    expect(result.policy_outcomes).toEqual({
      comparison_validity: true,
      complete_pairing: true,
      material_effect: true,
      protected_capability: true,
      trigger_precision: true,
      negative_transfer: true,
      cost: true,
      latency: true,
      ablation_non_inferiority: true,
      deterministic_mutation: true,
      all_passed: true,
    });
    expect(result.candidate_completion_reliability).toEqual({
      scheduled_trials: 4,
      normalized_completions: 4,
      incomplete_or_failed_trials: 0,
      coverage: 1,
    });
    expect(result.candidate_failure_taxonomy).toEqual([]);
    expect(result.comparison_validity).toMatchObject({
      status: "VALID",
      invalid_reasons: [],
    });
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.disposition_reason).toBe("FROZEN_POLICY_PASS");
  });

  it("invalidates a baseline-zero candidate-positive apparent comparison", () => {
    const planValue = plan();
    const freeze = freezePairedEvaluationContracts({
      population: population(),
      plan: planValue,
    });
    const failedBaseline = observations(freeze.schedule).map((observation) => {
      const entry = freeze.schedule.find(
        (candidate) => candidate.trial_id === observation.trial_id
      );
      return entry?.variant === "baseline"
        ? {
            trial_id: observation.trial_id,
            terminal_status: "error" as const,
            failure_code: "MODEL_EXECUTION_ERROR" as const,
            cost_microusd: 100,
            latency_ms: 10,
          }
        : observation;
    });
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: planValue,
      observations: failedBaseline,
    });
    expect(result.candidate_completion_reliability.normalized_completions).toBe(4);
    expect(result.comparison_validity).toMatchObject({
      status: "COMPARATIVE_UNVERIFIABLE",
      invalid_reasons: ["BASELINE_NORMALIZED_COMPLETION_BELOW_FLOOR"],
    });
    expect(result.aggregate_deltas.primary_delta).toBe(1);
    expect(result.disposition).toBe("INVALID_EVALUATION");
    expect(result.disposition_reason).toBe("COMPARATIVE_UNVERIFIABLE");
  });

  it("retires a baseline-usable candidate with zero normalized completions", () => {
    const planValue = plan();
    const freeze = freezePairedEvaluationContracts({
      population: population(),
      plan: planValue,
    });
    const failedCandidate = observations(freeze.schedule).map((observation) => {
      const entry = freeze.schedule.find(
        (candidate) => candidate.trial_id === observation.trial_id
      );
      return entry?.variant === "candidate"
        ? {
            trial_id: observation.trial_id,
            terminal_status: "error" as const,
            failure_code: "MODEL_EXECUTION_ERROR" as const,
            cost_microusd: 110,
            latency_ms: 11,
          }
        : observation;
    });
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: planValue,
      observations: failedCandidate,
    });
    expect(result.candidate_completion_reliability).toEqual({
      scheduled_trials: 4,
      normalized_completions: 0,
      incomplete_or_failed_trials: 4,
      coverage: 0,
    });
    expect(result.candidate_failure_taxonomy).toEqual([
      { failure_code: "MODEL_EXECUTION_ERROR", count: 4 },
    ]);
    expect(result.comparison_validity.invalid_reasons).toEqual([
      "CANDIDATE_ZERO_NORMALIZED_COMPLETIONS",
    ]);
    expect(result.disposition).toBe("RETIRED");
    expect(result.disposition_reason).toBe("CANDIDATE_ZERO_NORMALIZED_COMPLETIONS");
  });

  it("invalidates a nonzero-candidate comparison below its frozen pair floor", () => {
    const basePlan = plan();
    const planValue = validatePairedEvaluationPlan({
      ...basePlan,
      comparison_validity_policy: {
        ...basePlan.comparison_validity_policy,
        baseline_normalized_completion_floor: 0.5,
      },
    });
    const freeze = freezePairedEvaluationContracts({
      population: population(),
      plan: planValue,
    });
    let removedBaseline = false;
    const undercovered = observations(freeze.schedule).map((observation) => {
      const entry = freeze.schedule.find(
        (candidate) => candidate.trial_id === observation.trial_id
      );
      if (!removedBaseline && entry?.variant === "baseline") {
        removedBaseline = true;
        return {
          trial_id: observation.trial_id,
          terminal_status: "error" as const,
          failure_code: "MODEL_EXECUTION_ERROR" as const,
          cost_microusd: 100,
          latency_ms: 10,
        };
      }
      return observation;
    });
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: planValue,
      observations: undercovered,
    });
    expect(result.comparison_validity.baseline.passed).toBe(true);
    expect(result.candidate_completion_reliability.normalized_completions).toBe(4);
    expect(result.comparison_validity.complete_pairs).toMatchObject({
      coverage: 0.75,
      frozen_floor: 1,
      passed: false,
    });
    expect(result.comparison_validity.invalid_reasons).toEqual([
      "COMPLETE_PAIR_COVERAGE_BELOW_FLOOR",
    ]);
    expect(result.disposition).toBe("INVALID_EVALUATION");
  });

  it.each([
    ["reversed delta", { reverse: true }, "material_effect"],
    ["protected regression", { protectedRegression: true }, "protected_capability"],
    ["trigger false positive", { falsePositiveTrigger: true }, "trigger_precision"],
    ["cost breach", { candidateCost: 121 }, "cost"],
    ["latency breach", { candidateLatency: 13 }, "latency"],
  ] as const)("returns NO_BUILD for %s", (_name, options, failedPolicy) => {
    const freeze = frozen();
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: plan(),
      observations: observations(freeze.schedule, options),
    });
    expect(result.policy_outcomes[failedPolicy]).toBe(false);
    expect(result.policy_outcomes.all_passed).toBe(false);
    expect(result.disposition).toBe("NO_BUILD");
  });

  it("counts missing, nonterminal, and malformed trials with the frozen failure rule", () => {
    const basePlan = plan();
    const planValue = validatePairedEvaluationPlan({
      ...basePlan,
      comparison_validity_policy: {
        ...basePlan.comparison_validity_policy,
        baseline_normalized_completion_floor: 0,
        nonzero_candidate_complete_pair_coverage_floor: 0,
      },
    });
    const freeze = freezePairedEvaluationContracts({
      population: population(),
      plan: planValue,
    });
    const complete = observations(freeze.schedule);
    const missingId = freeze.schedule.find((entry) => entry.variant === "candidate")?.trial_id;
    if (missingId === undefined) throw new Error("candidate schedule entry is absent");
    const retained = complete.filter((observation) => observation.trial_id !== missingId);
    const nonterminalIndex = retained.findIndex((observation) => {
      const entry = freeze.schedule.find(
        (candidate) => candidate.trial_id === observation.trial_id
      );
      return entry?.variant === "baseline";
    });
    const malformedIndex = retained.findIndex((observation, index) => {
      const entry = freeze.schedule.find(
        (candidate) => candidate.trial_id === observation.trial_id
      );
      return entry?.variant === "candidate" && index !== nonterminalIndex;
    });
    const nonterminal = retained[nonterminalIndex];
    const malformed = retained[malformedIndex];
    if (nonterminal === undefined || malformed === undefined) {
      throw new Error("failure accounting fixtures are absent");
    }
    retained[nonterminalIndex] = {
      trial_id: nonterminal.trial_id,
      terminal_status: "nonterminal",
      cost_microusd: 1,
      latency_ms: 1,
    };
    retained[malformedIndex] = {
      ...malformed,
      output_bytes: 'not-json\nSUMMARY:{"confidence":"CERTAIN","complete":true}',
    };
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: planValue,
      observations: retained,
    });
    expect(result.trial_accounting).toMatchObject({ missing: 1, nonterminal: 1, malformed: 1 });
    expect(result.trials.filter((trial) => trial.failure_rule_applied)).toHaveLength(3);
    expect(
      result.trials
        .filter((trial) => trial.failure_rule_applied)
        .every(
          (trial) =>
            trial.measurement.cost_microusd === 1000 && trial.measurement.latency_ms === 1000
        )
    ).toBe(true);
    expect(result.complete_pair_coverage.coverage).toBeLessThan(1);
    expect(result.policy_outcomes.complete_pairing).toBe(false);
    expect(result.disposition).toBe("NO_BUILD");
  });

  it("counts candidate loss against baseline as negative transfer", () => {
    const freeze = frozen();
    const reversed = observations(freeze.schedule, { reverse: true });
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: plan(),
      observations: reversed,
    });
    expect(result.aggregate_deltas.negative_transfer_rate).toBe(0.5);
    expect(result.policy_outcomes.negative_transfer).toBe(false);
    expect(result.disposition).toBe("NO_BUILD");
  });

  it("supports signed noninferiority, coherent 0.80 pair coverage, absolute/domain/recall floors, null negative transfer, and exact zero cost", () => {
    const base = plan();
    const extended = validatePairedEvaluationPlan({
      ...base,
      repetitions: 2,
      material_effect_threshold: -0.05,
      candidate_scheduled_mean_floor: 0.85,
      trigger_recall_floor: 0.95,
      negative_transfer_ceiling: null,
      domain_quality_policy: {
        candidate_scheduled_mean_floor: 0.8,
        candidate_minus_baseline_paired_mean_floor: -0.1,
      },
      comparison_validity_policy: {
        ...base.comparison_validity_policy,
        baseline_normalized_completion_floor: 0.9,
        candidate_normalized_completion_floor: 0.9,
        nonzero_candidate_complete_pair_coverage_floor: 0.8,
        require_all_scheduled_trials_complete: false,
      },
      cost_latency_policy: {
        ...base.cost_latency_policy,
        require_exact_zero_cost_when_unpriced: true,
      },
    });
    const partB = validatePairedEvaluationPlan({
      ...extended,
      purpose: "part_b",
      comparison_validity_policy: {
        ...extended.comparison_validity_policy,
        readiness_preflight: {
          required: true,
          calibration_split: "calibration",
          scoring: "non_scoring",
          arm_coverage: "every_arm",
          validate_state_root: true,
          validate_output_normalization: true,
          validate_oracle_isolation: true,
          validate_common_wire: true,
          calibration_cohort_sha256: "0".repeat(64),
          repetitions: 1,
          baseline_normalized_completion_floor: 0.9,
          candidate_normalized_completion_floor: 0.9,
          complete_all_arm_pair_floor: 0.8,
          required_comparator_normalized_completion_floors: [],
        },
      },
      deterministic_disposition_rule: { on_pass: "CANDIDATE", on_fail: "RETIRED" },
    });
    expect(partB.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor).toBe(
      0.8
    );
    if (!partB.comparison_validity_policy.readiness_preflight.required) {
      throw new Error("Part B readiness fixture is unexpectedly disabled");
    }
    expect(partB.comparison_validity_policy.readiness_preflight.complete_all_arm_pair_floor).toBe(
      0.8
    );
    expect(() =>
      validatePairedEvaluationPlan({
        ...partB,
        comparison_validity_policy: {
          ...partB.comparison_validity_policy,
          readiness_preflight: {
            ...partB.comparison_validity_policy.readiness_preflight,
            complete_all_arm_pair_floor: 0.79,
          },
        },
      })
    ).toThrow();
    expect(() =>
      validatePairedEvaluationPlan({
        ...partB,
        comparison_validity_policy: {
          ...partB.comparison_validity_policy,
          readiness_preflight: {
            ...partB.comparison_validity_policy.readiness_preflight,
            complete_all_arm_pair_floor: 0.81,
          },
        },
      })
    ).toThrow(/readiness pair floor.*union-bound/u);
    expect(() =>
      validatePairedEvaluationPlan({
        ...partB,
        comparison_validity_policy: {
          ...partB.comparison_validity_policy,
          nonzero_candidate_complete_pair_coverage_floor: 0.81,
        },
      })
    ).toThrow(/comparison-validity pair floor.*union-bound/u);

    const populationValue = population();
    const freeze = freezePairedEvaluationContracts({ population: populationValue, plan: extended });
    const zeroCost = observations(freeze.schedule).map((observation) => ({
      ...observation,
      cost_microusd: 0,
    }));
    const passing = evaluateTrialObservations({
      frozen: freeze,
      population: populationValue,
      plan: extended,
      observations: zeroCost,
    });
    expect(passing.comparison_validity.candidate).toMatchObject({
      coverage: 1,
      frozen_floor: 0.9,
      passed: true,
    });
    expect(passing.aggregate_deltas.candidate_trigger_recall).toBe(1);
    expect(passing.domain_metrics).toHaveLength(1);
    expect(passing.domain_metrics?.every((metric) => metric.candidate_scheduled_mean_passed)).toBe(
      true
    );
    expect(passing.policy_outcomes).toMatchObject({
      candidate_absolute_quality: true,
      trigger_recall: true,
      domain_candidate_quality: true,
      domain_paired_delta: true,
      negative_transfer: true,
      zero_cost_exact: true,
    });

    const omittedCandidate = zeroCost.findIndex((observation) => {
      const entry = freeze.schedule.find(
        (scheduled) => scheduled.trial_id === observation.trial_id
      );
      return entry?.variant === "candidate";
    });
    const incomplete = evaluateTrialObservations({
      frozen: freeze,
      population: populationValue,
      plan: extended,
      observations: zeroCost.filter((_observation, index) => index !== omittedCandidate),
    });
    expect(incomplete.complete_pair_coverage.coverage).toBe(0.875);
    expect(incomplete.comparison_validity.complete_pairs.passed).toBe(true);
    expect(incomplete.comparison_validity.candidate).toMatchObject({
      coverage: 0.875,
      frozen_floor: 0.9,
      passed: false,
    });
    expect(incomplete.comparison_validity.invalid_reasons).toContain(
      "CANDIDATE_NORMALIZED_COMPLETION_BELOW_FLOOR"
    );
  });
});
