import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  sha256,
  skillContractSha256,
  type ArtifactRef,
  type OutputArtifactMetadata,
  type PlaybookRegistrationV1,
} from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

import {
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
  type EvaluationPopulationTaskV1,
  type PairedEvaluationScheduleEntryV1,
} from "../../evaluation-contracts.js";
import {
  DETERMINISTIC_GRADING_DEFINITION,
  DIRECT_DEMETRI_BASELINE_NAME,
  DIRECT_DEMETRI_BASELINE_REGISTRATION,
  SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
  SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
  SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION,
  evaluateTrialObservations,
  evaluationGradingDefinitionSha256,
  freezePairedEvaluation,
  syntheticEvaluationImplementationBinding,
  syntheticEvaluationRuntimeFunctions,
  type DeterministicGraderImplementationV1,
  type EvaluationGradingDefinitionV1,
  type EvaluationSemanticNormalizerDescriptorV1,
  type EvaluationSemanticNormalizerImplementationV1,
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

function answerForTask(taskId: string): string {
  if (taskId.includes("alpha")) return "alpha";
  if (taskId.includes("beta")) return "beta";
  if (taskId.includes("gamma")) return "gamma";
  if (taskId.includes("delta")) return "delta";
  throw new Error(`grading test has no answer for '${taskId}'`);
}

function gradingWire(task: EvaluationPopulationTaskV1, answer: string): string {
  return canonicalJson({
    schema_version: 1,
    task_id: task.task_id,
    answer,
    trigger_predicted: !task.task_id.includes("negative-trigger"),
  });
}

function descriptor(registrationName: string): EvaluationSemanticNormalizerDescriptorV1 {
  const value = DETERMINISTIC_GRADING_DEFINITION.descriptor.semantic_normalizers.find(
    (candidate) => candidate.registration_name === registrationName
  );
  if (value === undefined) {
    throw new Error(`default normalizer descriptor '${registrationName}' is absent`);
  }
  return value;
}

function normalizerImplementation(
  registrationName: string,
  normalize: EvaluationSemanticNormalizerImplementationV1["normalize"]
): EvaluationSemanticNormalizerImplementationV1 {
  const implementation =
    DETERMINISTIC_GRADING_DEFINITION.implementations.semantic_normalizers.get(registrationName);
  if (implementation === undefined) {
    throw new Error(`default normalizer implementation '${registrationName}' is absent`);
  }
  return { ...implementation, normalize };
}

function graderImplementation(
  graderCaseId: string,
  grade: DeterministicGraderImplementationV1["grade"]
): DeterministicGraderImplementationV1 {
  const implementation = DETERMINISTIC_GRADING_DEFINITION.implementations.graders.get(graderCaseId);
  if (implementation === undefined) {
    throw new Error(`default grader implementation '${graderCaseId}' is absent`);
  }
  return { ...implementation, grade };
}

function gradingDefinition(
  input: {
    readonly normalizerDescriptors?: EvaluationSemanticNormalizerDescriptorV1[];
    readonly normalizers?: ReadonlyMap<string, EvaluationSemanticNormalizerImplementationV1>;
    readonly graders?: ReadonlyMap<string, DeterministicGraderImplementationV1>;
  } = {}
): EvaluationGradingDefinitionV1 {
  return {
    descriptor: {
      ...DETERMINISTIC_GRADING_DEFINITION.descriptor,
      semantic_normalizers:
        input.normalizerDescriptors ??
        DETERMINISTIC_GRADING_DEFINITION.descriptor.semantic_normalizers,
    },
    implementations: {
      semantic_normalizers:
        input.normalizers ?? DETERMINISTIC_GRADING_DEFINITION.implementations.semantic_normalizers,
      graders: input.graders ?? DETERMINISTIC_GRADING_DEFINITION.implementations.graders,
    },
  };
}

function fakeRef(
  entry: PairedEvaluationScheduleEntryV1,
  outputBytes: string,
  source: EvaluationSemanticNormalizerDescriptorV1["source_output"] = descriptor(entry.variant_name)
    .source_output
): ArtifactRef {
  const digest = sha256(outputBytes);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(entry.trial_id)}`,
    run_id: entry.trial_id,
    phase: "evaluating",
    branch_id: null,
    kind: source.artifact_kind,
    operation_id: `test:${entry.trial_id}`,
    version: 1,
    producer: "agent:demetri",
    media_type: "application/json",
    content_schema: { schema_id: source.schema_id, schema_version: source.schema_version },
    byte_length: Buffer.byteLength(outputBytes),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
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
  output: (entry: PairedEvaluationScheduleEntryV1) => string
): EvaluationTrialObservationV1[] {
  return schedule.map((entry) => {
    const outputBytes = output(entry);
    const ref = fakeRef(entry, outputBytes);
    return {
      trial_id: entry.trial_id,
      terminal_status: "complete",
      output_ref: ref,
      output_metadata: fakeMetadata(ref),
      output_bytes: outputBytes,
      cost_microusd: entry.variant === "candidate" ? 110 : 100,
      latency_ms: entry.variant === "candidate" ? 11 : 10,
    };
  });
}

function implementation(
  planValue: unknown = plan(),
  gradingDefinition: EvaluationGradingDefinitionV1 = DETERMINISTIC_GRADING_DEFINITION,
  populationValue: unknown = population()
) {
  const runtimeFunctions = syntheticEvaluationRuntimeFunctions();
  return {
    implementationBinding: syntheticEvaluationImplementationBinding({
      projectRoot: PROJECT_ROOT,
      population: populationValue,
      plan: planValue,
      gradingDefinition,
      runtimeFunctions,
    }),
    runtimeFunctions,
  };
}

function frozen(
  input: {
    readonly population?: ReturnType<typeof population>;
    readonly plan?: ReturnType<typeof plan>;
    readonly gradingDefinition?: EvaluationGradingDefinitionV1;
  } = {}
) {
  const planValue = input.plan ?? plan();
  const populationValue = input.population ?? population();
  return freezePairedEvaluation({
    population: populationValue,
    plan: planValue,
    projectRoot: PROJECT_ROOT,
    baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
    candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
    ...(input.gradingDefinition === undefined
      ? {}
      : { gradingDefinition: input.gradingDefinition }),
    ...implementation(planValue, DETERMINISTIC_GRADING_DEFINITION, populationValue),
  });
}

function successfulOutput(entry: PairedEvaluationScheduleEntryV1): string {
  return `${gradingWire(
    {
      task_id: entry.task_id,
      domain: "test",
      trigger_expected: !entry.task_id.includes("negative-trigger"),
      goal: "test",
      constraints: {},
      exact_input_artifact_ids: [],
      grader_case_id: "test",
    },
    answerForTask(entry.task_id)
  )}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`;
}

describe("P6 complete deterministic grading definition", () => {
  it("recomputes the digest and rejects source-descriptor drift despite an unchanged plan digest", () => {
    const changedSchemaId = "penny.changed-candidate-output.v1";
    const changedCandidate: PlaybookRegistrationV1 = {
      ...SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION,
      contract: {
        ...SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.contract,
        io: {
          ...SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.contract.io,
          active_output_ports:
            SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.contract.io.active_output_ports.map(
              (port) => ({ ...port, schema_id: changedSchemaId })
            ),
        },
      },
    };
    const changedPlan = validatePairedEvaluationPlan({
      ...plan(),
      candidate: {
        name: changedCandidate.name,
        contract_sha256: skillContractSha256(changedCandidate.contract),
      },
    });
    const changedDescriptors = DETERMINISTIC_GRADING_DEFINITION.descriptor.semantic_normalizers.map(
      (normalizer) =>
        normalizer.registration_name === SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME
          ? {
              ...normalizer,
              source_output: { ...normalizer.source_output, schema_id: changedSchemaId },
            }
          : normalizer
    );
    const changedDefinition = gradingDefinition({
      normalizerDescriptors: changedDescriptors,
    });

    expect(evaluationGradingDefinitionSha256(changedDefinition)).not.toBe(
      changedPlan.grader_registry_sha256
    );
    expect(() =>
      freezePairedEvaluation({
        population: population(),
        plan: changedPlan,
        projectRoot: PROJECT_ROOT,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: new Map([[changedCandidate.name, changedCandidate]]),
        gradingDefinition: changedDefinition,
        ...implementation(),
      })
    ).toThrow(/EVALUATION_REGISTRATION_INCOMPATIBLE/u);
  });

  it("enforces exact normalizer and grader descriptor/implementation key parity", () => {
    const missingNormalizer = new Map(
      DETERMINISTIC_GRADING_DEFINITION.implementations.semantic_normalizers
    );
    missingNormalizer.delete(SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME);
    expect(() =>
      frozen({ gradingDefinition: gradingDefinition({ normalizers: missingNormalizer }) })
    ).toThrow(/EVALUATION_REGISTRATION_INCOMPATIBLE/u);

    const extraNormalizer = new Map(
      DETERMINISTIC_GRADING_DEFINITION.implementations.semantic_normalizers
    );
    extraNormalizer.set(
      "unscheduled-normalizer",
      normalizerImplementation(DIRECT_DEMETRI_BASELINE_NAME, () => ({
        status: "invalid_output",
        failure_code: "MALFORMED_TRIAL_OUTPUT",
      }))
    );
    expect(() =>
      frozen({ gradingDefinition: gradingDefinition({ normalizers: extraNormalizer }) })
    ).toThrow(/EVALUATION_REGISTRATION_INCOMPATIBLE/u);

    const mismatchedNormalizer = new Map(
      DETERMINISTIC_GRADING_DEFINITION.implementations.semantic_normalizers
    );
    const candidateImplementation = mismatchedNormalizer.get(SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME);
    if (candidateImplementation === undefined) {
      throw new Error("default candidate normalizer implementation is absent");
    }
    mismatchedNormalizer.set(SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME, {
      ...candidateImplementation,
      normalizer_version: candidateImplementation.normalizer_version + 1,
    });
    expect(() =>
      frozen({
        gradingDefinition: gradingDefinition({ normalizers: mismatchedNormalizer }),
      })
    ).toThrow(/EVALUATION_REGISTRATION_INCOMPATIBLE/u);

    const missingGrader = new Map(DETERMINISTIC_GRADING_DEFINITION.implementations.graders);
    missingGrader.delete("synthetic-alpha");
    expect(() =>
      frozen({ gradingDefinition: gradingDefinition({ graders: missingGrader }) })
    ).toThrow(/EVALUATION_REGISTRATION_INCOMPATIBLE/u);
  });

  it("grades only common wire bytes produced by registration-keyed implementations", () => {
    const normalizers = new Map(
      DETERMINISTIC_GRADING_DEFINITION.implementations.semantic_normalizers
    );
    normalizers.set(
      DIRECT_DEMETRI_BASELINE_NAME,
      normalizerImplementation(DIRECT_DEMETRI_BASELINE_NAME, ({ task }) => {
        const expected = answerForTask(task.task_id);
        const deltaTask = task.task_id.includes("alpha") || task.task_id.includes("beta");
        return {
          status: "normalized",
          wire_bytes: gradingWire(task, deltaTask ? `wrong-${expected}` : expected),
        };
      })
    );
    normalizers.set(
      SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      normalizerImplementation(SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME, ({ task }) => ({
        status: "normalized",
        wire_bytes: gradingWire(task, answerForTask(task.task_id)),
      }))
    );
    const definition = gradingDefinition({ normalizers });
    const freeze = frozen();
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: plan(),
      gradingDefinition: definition,
      observations: observations(freeze.schedule, (entry) =>
        entry.variant === "baseline"
          ? "direct baseline prose, not grader JSON"
          : "typed candidate product, not grader JSON"
      ),
    });
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.aggregate_deltas.primary_delta).toBe(0.5);
  });

  it("reports reliability and invalidates incomplete nonzero-candidate pair coverage", () => {
    const frozenValue = frozen();
    let removed = false;
    const incomplete = observations(frozenValue.schedule, successfulOutput).map((observation) => {
      const entry = frozenValue.schedule.find(
        (candidate) => candidate.trial_id === observation.trial_id
      );
      if (!removed && entry?.variant === "candidate") {
        removed = true;
        const { output_ref: _outputRef, output_bytes: _outputBytes, ...failed } = observation;
        return {
          ...failed,
          terminal_status: "error" as const,
          failure_code: "MODEL_EXECUTION_ERROR" as const,
        };
      }
      return observation;
    });

    const result = evaluateTrialObservations({
      frozen: frozenValue,
      population: population(),
      plan: plan(),
      observations: incomplete,
    });

    expect(result.disposition).toBe("INVALID_EVALUATION");
    expect(result.disposition_reason).toBe("COMPARATIVE_UNVERIFIABLE");
    expect(result.invalid_evaluation).toEqual({
      stage: "comparison_validity",
      code: "COMPARATIVE_UNVERIFIABLE",
      trial_id: null,
    });
    expect(result.candidate_completion_reliability).toEqual({
      scheduled_trials: 4,
      normalized_completions: 3,
      incomplete_or_failed_trials: 1,
      coverage: 0.75,
    });
    expect(result.comparison_validity).toMatchObject({
      status: "COMPARATIVE_UNVERIFIABLE",
      complete_pairs: {
        scheduled_pairs: 4,
        complete_pairs: 3,
        incomplete_pairs: 1,
        coverage: 0.75,
        frozen_floor: 1,
        passed: false,
      },
      invalid_reasons: ["COMPLETE_PAIR_COVERAGE_BELOW_FLOOR"],
    });
  });

  it("keeps explicit invalid_output as an ordinary malformed trial failure", () => {
    const normalizers = new Map(
      DETERMINISTIC_GRADING_DEFINITION.implementations.semantic_normalizers
    );
    normalizers.set(
      SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      normalizerImplementation(SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME, () => ({
        status: "invalid_output",
        failure_code: "MALFORMED_TRIAL_OUTPUT",
      }))
    );
    const definition = gradingDefinition({ normalizers });
    const freeze = frozen();
    const result = evaluateTrialObservations({
      frozen: freeze,
      population: population(),
      plan: plan(),
      gradingDefinition: definition,
      observations: observations(freeze.schedule, successfulOutput),
    });
    expect(result.disposition).toBe("RETIRED");
    expect(result.disposition_reason).toBe("CANDIDATE_ZERO_NORMALIZED_COMPLETIONS");
    expect(result.invalid_evaluation).toBeUndefined();
    expect(
      result.trials.filter(
        (trial) => trial.variant === "candidate" && trial.terminal_status === "malformed"
      )
    ).toHaveLength(population().tasks.length);
  });

  it("classifies thrown normalizers and grader parsers as INVALID_EVALUATION, never RETIRED", () => {
    const populationValue = population();
    const planValue = plan();
    const normalizers = new Map(
      DETERMINISTIC_GRADING_DEFINITION.implementations.semantic_normalizers
    );
    normalizers.set(
      SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      normalizerImplementation(SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME, () => {
        throw new Error("injected normalizer implementation incompatibility");
      })
    );
    const normalizerDefinition = gradingDefinition({ normalizers });
    const partBFreeze = frozen({
      population: populationValue,
      plan: planValue,
    });
    const normalizationResult = evaluateTrialObservations({
      frozen: partBFreeze,
      population: populationValue,
      plan: planValue,
      gradingDefinition: normalizerDefinition,
      observations: observations(partBFreeze.schedule, successfulOutput),
    });
    expect(normalizationResult.disposition).toBe("INVALID_EVALUATION");
    expect(normalizationResult.invalid_evaluation).toMatchObject({
      stage: "semantic_normalization",
      code: "SEMANTIC_NORMALIZER_INCOMPATIBLE",
    });

    const graders = new Map(DETERMINISTIC_GRADING_DEFINITION.implementations.graders);
    graders.set(
      "synthetic-alpha",
      graderImplementation("synthetic-alpha", () => {
        throw new Error("injected grader parser incompatibility");
      })
    );
    const graderDefinition = gradingDefinition({ graders });
    const defaultFreeze = frozen();
    const parserResult = evaluateTrialObservations({
      frozen: defaultFreeze,
      population: population(),
      plan: plan(),
      gradingDefinition: graderDefinition,
      observations: observations(defaultFreeze.schedule, successfulOutput),
    });
    expect(parserResult.disposition).toBe("INVALID_EVALUATION");
    expect(parserResult.invalid_evaluation).toMatchObject({
      stage: "grader_parser",
      code: "GRADER_PARSER_INCOMPATIBLE",
    });
  });
});
