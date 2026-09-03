import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalizePlanRequest,
  parseStrategyDraft,
  planRequestItemIds,
  planRequestSha256,
  projectStrategyDraft,
  sealStrategy,
  sha256,
  type ArtifactRef,
  type OutputArtifactMetadata,
  type PlanRequestConstraintsV1,
  type StrategyCoreV1,
} from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

import {
  DIRECT_PIPER_PLAN_BASELINE_NAME,
  DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
  PLAN_CONTRACT_GRADER_ID,
  PLAN_CONTRACT_GRADER_IMPLEMENTATION,
  PLAN_EVALUATION_NORMALIZER_DESCRIPTORS,
  PLAN_KNOWN_DELTA_GRADER_ID,
  PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION,
  PLAN_SEMANTIC_CLAUSE_IDS,
  PLAN_SEMANTIC_DOD_MAPPING_V2,
  PLAN_SEMANTIC_V2_FIELD_NAMES,
  PLAN_SEMANTIC_V2_GRADER_IMPLEMENTATION,
  STRATEGY_GRADING_WIRE,
  STRATEGY_SEMANTIC_GRADING_WIRE_V2,
  StrategyEvaluationV2Schema,
  createPlanEvaluationGradingDefinition,
  createPlanSemanticV2GradingDefinition,
  gradePlanSemanticClausesV2,
  parseDirectStrategyDraft,
  parseStrategyGradingWire,
  parseStrategySemanticGradingWireV2,
  planGraderDescriptor,
  planSemanticQualificationStatusV2,
  planSemanticV2GraderDescriptor,
  projectStrategyEvaluation,
  projectStrategyEvaluationV2,
  validatePlanSemanticReviewOutputV1,
  type PlanSemanticGraderOracleV2,
} from "../../plan-evaluation.js";
import {
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

function constraints(): PlanRequestConstraintsV1 {
  return {
    schema_version: 1,
    desired_outcomes: ["The transition is ready.", "Rollback remains possible."],
    current_state: { status: "provided", facts: ["The old system is active."] },
    hard_constraints: ["No execution is allowed."],
    non_goals: ["No executor tasks."],
    known_uncertainties: [{ statement: "The transition window may move.", material: true }],
    prior_decisions: [
      { statement: "Keep the platform.", binding_effect: "No platform migration." },
    ],
  };
}

function request() {
  return canonicalizePlanRequest({
    goal: "Form a transition strategy.",
    constraints: constraints(),
    exactInputArtifactIds: [],
  });
}

function core(): StrategyCoreV1 {
  return {
    schema_version: 1,
    disposition: "ready",
    applicability_reason: "The request calls for strategy.",
    outcomes: [
      {
        statement: "Transition readiness is established.",
        desired_outcome_indexes: [0],
        success_signal: "Readiness evidence is complete.",
      },
      {
        statement: "Rollback viability is retained.",
        desired_outcome_indexes: [1],
        success_signal: "Rollback evidence is complete.",
      },
    ],
    dependencies: [{ from_outcome_index: 0, to_outcome_index: 1, kind: "informational" }],
    request_coverage: {
      current_state_fact_indexes: [0],
      input_artifact_slots: [],
      hard_constraint_indexes: [0],
      non_goal_indexes: [0],
      uncertainty_indexes: [0],
      prior_decision_indexes: [0],
      blocked_desired_outcome_indexes: [],
    },
    blockers: [],
    confidence: "PROBABLE",
  };
}

function persistedWithReport(report: string, value: StrategyCoreV1 = core()): string {
  return `${report}\nSTRATEGY_CORE:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
}

function persisted(value: StrategyCoreV1 = core()): string {
  return persistedWithReport("A complete strategy report.", value);
}

function outputRef(content: string, registrationName: string): ArtifactRef {
  const digest = sha256(content);
  return {
    schema_version: 2,
    artifact_id: `art_${"a".repeat(64)}`,
    run_id: "plan-evaluation-unit",
    phase: registrationName === "plan" ? "sealing_strategy" : "strategizing",
    branch_id: null,
    kind: registrationName === "plan" ? "strategy" : "strategy-draft",
    operation_id: "plan-evaluation-output",
    version: 1,
    producer: registrationName === "plan" ? "host:strategy-sealer" : "agent:piper",
    media_type: registrationName === "plan" ? "application/json" : "text/plain; charset=utf-8",
    content_schema: {
      schema_id: registrationName === "plan" ? "penny.strategy.v1" : "penny.strategy-draft.v1",
      schema_version: 1,
    },
    byte_length: Buffer.byteLength(content),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function outputMetadata(ref: ArtifactRef): OutputArtifactMetadata {
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

function task() {
  return {
    task_id: "plan-unit-task",
    domain: "unit",
    trigger_expected: true,
    goal: request().goal,
    constraints: constraints(),
    exact_input_artifact_ids: [],
    grader_case_id: "plan-unit-grader",
  };
}

function semanticV2Oracle(
  wire: ReturnType<typeof projectStrategyEvaluationV2>
): PlanSemanticGraderOracleV2 {
  const itemIds = planRequestItemIds(request());
  return {
    schema_version: 2,
    task_id: task().task_id,
    structured_expectations: {
      allowed_dispositions: [wire.disposition],
      expected_desired_outcome_ids: [...itemIds.desired_outcome_ids],
      expected_current_state_fact_ids: [...itemIds.current_state_fact_ids],
      expected_hard_constraint_ids: [...itemIds.hard_constraint_ids],
      expected_non_goal_ids: [...itemIds.non_goal_ids],
      expected_uncertainty_ids: [...itemIds.uncertainty_ids],
      expected_prior_decision_ids: [...itemIds.prior_decision_ids],
      expected_blocked_desired_outcome_ids: [...wire.request_coverage.blocked_desired_outcome_ids],
      expected_dependency_relations: [...wire.dependencies],
      expected_blocker_presence: wire.blockers.length === 0 ? "none" : "nonempty",
      allowed_confidence: [wire.confidence],
    },
    clauses: PLAN_SEMANTIC_CLAUSE_IDS.map((clause_id) => ({
      clause_id,
      applicability: "applicable",
      semantic_review: "independent_semantic_judge_required",
      oracle_refs: [`oracle:${clause_id}`],
      evidence_refs: [`evidence:${clause_id}`],
    })),
    oracle_marker: "PLAN_SEMANTIC_ORACLE_V2:UNIT",
  };
}

describe("Plan direct baseline, common wire, and deterministic graders", () => {
  it("constructs the direct Piper strategizing baseline without production registration", () => {
    expect(
      directBaselineDefinition(DIRECT_PIPER_PLAN_BASELINE_REGISTRATION, PROJECT_ROOT)
    ).toMatchObject({
      registration_name: DIRECT_PIPER_PLAN_BASELINE_NAME,
      agent: "piper",
      phase: "strategizing",
      guidance: {
        skill_root: "evals/guidance/plan",
        resolution: "per_agent_phase",
        path: "evals/guidance/plan/piper-strategizing.md",
      },
      output: {
        artifact_kind: "strategy-draft",
        schema_id: "penny.strategy-draft.v1",
        schema_version: 1,
        producer: "agent:piper",
      },
    });
  });

  it("binds direct, sealed, and unsealed outputs to one minimal Strategy wire", () => {
    expect(
      PLAN_EVALUATION_NORMALIZER_DESCRIPTORS.map((descriptor) => ({
        registration: descriptor.registration_name,
        source: descriptor.source_output,
        target: descriptor.target_wire,
      }))
    ).toEqual([
      {
        registration: DIRECT_PIPER_PLAN_BASELINE_NAME,
        source: {
          artifact_kind: "strategy-draft",
          schema_id: "penny.strategy-draft.v1",
          schema_version: 1,
        },
        target: STRATEGY_GRADING_WIRE,
      },
      {
        registration: "plan",
        source: { artifact_kind: "strategy", schema_id: "penny.strategy.v1", schema_version: 1 },
        target: STRATEGY_GRADING_WIRE,
      },
      {
        registration: "plan-unsealed",
        source: {
          artifact_kind: "strategy-draft",
          schema_id: "penny.strategy-draft.v1",
          schema_version: 1,
        },
        target: STRATEGY_GRADING_WIRE,
      },
    ]);
  });

  it("normalizes semantically identical direct, unsealed, and sealed products byte-identically", () => {
    const requestValue = request();
    const raw = persisted();
    const parsed = parseStrategyDraft(Buffer.from(raw), { request: requestValue });
    const expected = canonicalJson(projectStrategyEvaluation(parsed.draft, requestValue));
    expect(parseDirectStrategyDraft(raw, { request: requestValue })).toEqual(
      projectStrategyDraft(parsed.draft, { request: requestValue })
    );
    const sealed = sealStrategy({
      request: requestValue,
      draft: parsed.draft,
      draftBytes: Buffer.from(raw),
      requestSha256: planRequestSha256(requestValue),
      sourceRequestArtifactId: `art_${"b".repeat(64)}`,
      sourceDraftArtifactId: `art_${"c".repeat(64)}`,
      exactInputArtifactIds: [],
    });
    const definition = createPlanEvaluationGradingDefinition({
      purpose: "harness_self_test",
      graders: [
        {
          descriptor: planGraderDescriptor({
            graderCaseId: task().grader_case_id,
            graderId: PLAN_KNOWN_DELTA_GRADER_ID,
            protectedCapability: false,
            oracle: { expected_wire_sha256: sha256(expected), oracle_marker: "UNIT_ORACLE" },
          }),
          implementation: PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION,
        },
      ],
    });
    for (const [registrationName, content] of [
      [DIRECT_PIPER_PLAN_BASELINE_NAME, raw],
      ["plan-unsealed", raw],
      ["plan", canonicalJson(sealed)],
    ] as const) {
      const descriptor = definition.descriptor.semantic_normalizers.find(
        (candidate) => candidate.registration_name === registrationName
      );
      const implementation = definition.implementations.semantic_normalizers.get(registrationName);
      if (descriptor === undefined || implementation === undefined) {
        throw new Error(`normalizer '${registrationName}' is absent`);
      }
      const ref = outputRef(content, registrationName);
      expect(
        implementation.normalize({
          descriptor,
          wire: STRATEGY_GRADING_WIRE,
          output_ref: ref,
          output_metadata: outputMetadata(ref),
          output_bytes: content,
          task: task(),
        })
      ).toEqual({ status: "normalized", wire_bytes: expected });
    }
  });

  it("exposes closed normalization failures and canonical-only grading bytes", () => {
    const definition = createPlanEvaluationGradingDefinition({
      purpose: "harness_self_test",
      graders: [
        {
          descriptor: planGraderDescriptor({
            graderCaseId: task().grader_case_id,
            graderId: PLAN_KNOWN_DELTA_GRADER_ID,
            protectedCapability: false,
            oracle: { expected_wire_sha256: "0".repeat(64), oracle_marker: "UNIT_ORACLE" },
          }),
          implementation: PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION,
        },
      ],
    });
    const descriptor = definition.descriptor.semantic_normalizers.find(
      (candidate) => candidate.registration_name === DIRECT_PIPER_PLAN_BASELINE_NAME
    );
    const implementation = definition.implementations.semantic_normalizers.get(
      DIRECT_PIPER_PLAN_BASELINE_NAME
    );
    if (descriptor === undefined || implementation === undefined)
      throw new Error("normalizer absent");
    const ref = outputRef("ordinary prose", DIRECT_PIPER_PLAN_BASELINE_NAME);
    expect(
      implementation.normalize({
        descriptor,
        wire: STRATEGY_GRADING_WIRE,
        output_ref: ref,
        output_metadata: outputMetadata(ref),
        output_bytes: "ordinary prose",
        task: task(),
      })
    ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_FRAMING_INVALID" });
    const wire = canonicalJson(
      projectStrategyDraft(
        parseStrategyDraft(Buffer.from(persisted()), { request: request() }).draft,
        { request: request() }
      )
    );
    expect(parseStrategyGradingWire(wire).disposition).toBe("ready");
    expect(() => parseStrategyGradingWire(`${wire}\n`)).toThrow(/canonical/u);
  });

  it("grades frozen disposition, desired coverage, dependency, blockers, and no-execution", () => {
    const requestValue = request();
    const wire = canonicalJson(
      projectStrategyDraft(
        parseStrategyDraft(Buffer.from(persisted()), { request: requestValue }).draft,
        {
          request: requestValue,
        }
      )
    );
    const descriptor = planGraderDescriptor({
      graderCaseId: "plan-contract-case",
      graderId: PLAN_CONTRACT_GRADER_ID,
      protectedCapability: true,
      oracle: {
        expected_disposition: "ready",
        expected_desired_outcome_ids: [...planRequestItemIds(requestValue).desired_outcome_ids],
        expected_dependency_kinds: ["informational"],
        expected_blockers: [],
        oracle_marker: "CONTRACT_ORACLE",
      },
    });
    expect(PLAN_CONTRACT_GRADER_IMPLEMENTATION.grade(wire, task(), descriptor)).toEqual({
      task_score: 1,
      trigger_predicted: true,
      protected_capability_score: 1,
    });
    expect(
      PLAN_CONTRACT_GRADER_IMPLEMENTATION.grade(wire, task(), {
        ...descriptor,
        oracle: {
          expected_disposition: "blocked",
          expected_desired_outcome_ids: [...planRequestItemIds(requestValue).desired_outcome_ids],
          expected_dependency_kinds: ["informational"],
          expected_blockers: [],
          oracle_marker: "CONTRACT_ORACLE",
        },
      }).task_score
    ).toBe(0);
  });

  it("derives trigger prediction only from the normalized disposition and rejects oracle trigger fields", () => {
    const readyWire = canonicalJson(
      projectStrategyDraft(
        parseStrategyDraft(Buffer.from(persisted()), { request: request() }).draft,
        { request: request() }
      )
    );
    const notApplicableCore: StrategyCoreV1 = {
      schema_version: 1,
      disposition: "not_applicable",
      applicability_reason: "No further planning applies.",
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
    const notApplicableRaw = persisted(notApplicableCore);
    const notApplicableWire = canonicalJson(
      projectStrategyDraft(
        parseStrategyDraft(Buffer.from(notApplicableRaw), { request: request() }).draft,
        { request: request() }
      )
    );
    const descriptor = (wire: string) =>
      planGraderDescriptor({
        graderCaseId: "wire-only-trigger-case",
        graderId: PLAN_KNOWN_DELTA_GRADER_ID,
        protectedCapability: false,
        oracle: {
          expected_wire_sha256: sha256(wire),
          oracle_marker: "DISTINCTIVE_HOST_ONLY_PLAN_ORACLE",
        },
      });
    expect(
      PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION.grade(readyWire, task(), descriptor(readyWire))
        .trigger_predicted
    ).toBe(true);
    expect(
      PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION.grade(
        notApplicableWire,
        task(),
        descriptor(notApplicableWire)
      ).trigger_predicted
    ).toBe(false);
    expect(
      PLAN_CONTRACT_GRADER_IMPLEMENTATION.grade(
        notApplicableWire,
        task(),
        planGraderDescriptor({
          graderCaseId: "contract-wire-only-trigger-case",
          graderId: PLAN_CONTRACT_GRADER_ID,
          protectedCapability: true,
          oracle: {
            expected_disposition: "not_applicable",
            expected_desired_outcome_ids: [],
            expected_dependency_kinds: [],
            expected_blockers: [],
            oracle_marker: "DISTINCTIVE_HOST_ONLY_PLAN_ORACLE",
          },
        })
      ).trigger_predicted
    ).toBe(false);
    expect(() =>
      PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION.grade(readyWire, task(), {
        ...descriptor(readyWire),
        oracle: {
          expected_wire_sha256: sha256(readyWire),
          oracle_marker: "DISTINCTIVE_HOST_ONLY_PLAN_ORACLE",
          trigger_predicted: false,
        },
      })
    ).toThrow(/oracle/u);
  });

  it("restricts the closed expected-wire grader to harness_self_test", () => {
    const binding = {
      descriptor: planGraderDescriptor({
        graderCaseId: "known-delta-case",
        graderId: PLAN_KNOWN_DELTA_GRADER_ID,
        protectedCapability: false,
        oracle: { expected_wire_sha256: "0".repeat(64), oracle_marker: "UNIT_ORACLE" },
      }),
      implementation: PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION,
    };
    expect(() =>
      createPlanEvaluationGradingDefinition({ purpose: "candidate_warrant", graders: [binding] })
    ).toThrow(/restricted/u);
    expect(() =>
      createPlanEvaluationGradingDefinition({ purpose: "part_b", graders: [binding] })
    ).toThrow(/restricted/u);
    expect(() =>
      createPlanEvaluationGradingDefinition({ purpose: "harness_self_test", graders: [binding] })
    ).not.toThrow();
  });

  it("binds oracle and executable implementation drift in the grading digest", () => {
    const make = (digest: string) =>
      createPlanEvaluationGradingDefinition({
        purpose: "harness_self_test",
        graders: [
          {
            descriptor: planGraderDescriptor({
              graderCaseId: "digest-case",
              graderId: PLAN_KNOWN_DELTA_GRADER_ID,
              protectedCapability: false,
              oracle: { expected_wire_sha256: digest, oracle_marker: "DIGEST_ORACLE" },
            }),
            implementation: PLAN_KNOWN_DELTA_GRADER_IMPLEMENTATION,
          },
        ],
      });
    expect(evaluationGradingDefinitionSha256(make("0".repeat(64)))).not.toBe(
      evaluationGradingDefinitionSha256(make("1".repeat(64)))
    );
  });

  it("maps every §9.4 clause to the grader and back in canonical order", () => {
    expect(PLAN_SEMANTIC_DOD_MAPPING_V2.map((entry) => entry.clause_id)).toEqual(
      PLAN_SEMANTIC_CLAUSE_IDS
    );
    expect(PLAN_SEMANTIC_DOD_MAPPING_V2.map((entry) => entry.plan_clause)).toEqual([
      "§9.4.1",
      "§9.4.2",
      "§9.4.3",
      "§9.4.4",
      "§9.4.5",
      "§9.4.6",
      "§9.4.7",
      "§9.4.8",
    ]);
    expect(new Set(PLAN_SEMANTIC_DOD_MAPPING_V2.map((entry) => entry.clause_id))).toEqual(
      new Set(PLAN_SEMANTIC_CLAUSE_IDS)
    );
    expect(
      PLAN_SEMANTIC_DOD_MAPPING_V2.every(
        (entry) =>
          entry.grader_owner === "plan_semantic_clause_grader_v2" &&
          entry.substantive_review === "independent_semantic_judge_required"
      )
    ).toBe(true);
  });

  it("normalizes meaning-preserving report rewordings symmetrically and keeps every substantive clause UNVERIFIABLE", () => {
    const requestValue = request();
    const reports = [
      "The strategy keeps the transition reversible while establishing readiness.",
      "Readiness is established without giving up the ability to roll back.",
      "The approach preserves a return path as it prepares the transition.",
    ] as const;
    const rawByArm = reports.map((report) => persistedWithReport(report));
    const drafts = rawByArm.map(
      (raw) => parseStrategyDraft(Buffer.from(raw), { request: requestValue }).draft
    );
    const sealed = sealStrategy({
      request: requestValue,
      draft: drafts[2],
      draftBytes: Buffer.from(rawByArm[2]),
      requestSha256: planRequestSha256(requestValue),
      sourceRequestArtifactId: `art_${"b".repeat(64)}`,
      sourceDraftArtifactId: `art_${"c".repeat(64)}`,
      exactInputArtifactIds: [],
    });
    const oracle = semanticV2Oracle(projectStrategyEvaluationV2(drafts[0], requestValue));
    const descriptor = planSemanticV2GraderDescriptor({
      graderCaseId: task().grader_case_id,
      protectedCapability: true,
      oracle,
    });
    const definition = createPlanSemanticV2GradingDefinition({
      graders: [{ descriptor, implementation: PLAN_SEMANTIC_V2_GRADER_IMPLEMENTATION }],
    });
    expect(definition.descriptor.wire).toEqual(STRATEGY_SEMANTIC_GRADING_WIRE_V2);
    const normalizedWires: string[] = [];
    for (const [registrationName, content] of [
      [DIRECT_PIPER_PLAN_BASELINE_NAME, rawByArm[0]],
      ["plan-unsealed", rawByArm[1]],
      ["plan", canonicalJson(sealed)],
    ] as const) {
      const normalizerDescriptor = definition.descriptor.semantic_normalizers.find(
        (candidate) => candidate.registration_name === registrationName
      );
      const implementation = definition.implementations.semantic_normalizers.get(registrationName);
      if (normalizerDescriptor === undefined || implementation === undefined) {
        throw new Error(`semantic V2 normalizer '${registrationName}' is absent`);
      }
      const ref = outputRef(content, registrationName);
      const normalized = implementation.normalize({
        descriptor: normalizerDescriptor,
        wire: STRATEGY_SEMANTIC_GRADING_WIRE_V2,
        output_ref: ref,
        output_metadata: outputMetadata(ref),
        output_bytes: content,
        task: task(),
      });
      if (normalized.status !== "normalized") {
        throw new Error(`semantic V2 normalizer '${registrationName}' rejected valid output`);
      }
      normalizedWires.push(normalized.wire_bytes);
    }
    expect(
      normalizedWires.map(
        (wireBytes) => parseStrategySemanticGradingWireV2(wireBytes).strategy_report
      )
    ).toEqual(reports);
    const grades = normalizedWires.map((wireBytes) =>
      gradePlanSemanticClausesV2(wireBytes, task(), descriptor)
    );
    expect(grades[1]).toEqual(grades[0]);
    expect(grades[2]).toEqual(grades[0]);
    expect(grades[0]).toMatchObject({
      task_score: 0,
      trigger_predicted: true,
      protected_capability_score: 0,
    });
    expect(grades[0].clause_results).toHaveLength(PLAN_SEMANTIC_CLAUSE_IDS.length);
    expect(grades[0].clause_results.every((clause) => clause.outcome === "UNVERIFIABLE")).toBe(
      true
    );
  });

  it("keeps known-good, known-bad, and applicability-boundary cases BLOCKED and NOT_QUALIFIED without semantic review", () => {
    const requestValue = request();
    const draft = parseStrategyDraft(Buffer.from(persisted()), { request: requestValue }).draft;
    const goodWire = projectStrategyEvaluationV2(draft, requestValue);
    const baseOracle = semanticV2Oracle(goodWire);
    const descriptor = planSemanticV2GraderDescriptor({
      graderCaseId: task().grader_case_id,
      protectedCapability: true,
      oracle: baseOracle,
    });
    const good = planSemanticQualificationStatusV2({
      wireBytes: canonicalJson(goodWire),
      task: task(),
      descriptor,
    });
    expect(good).toMatchObject({
      task_disposition: "BLOCKED",
      qualification_status: "NOT_QUALIFIED",
      aggregate_success: false,
      reason_code: "INDEPENDENT_SEMANTIC_REVIEW_ABSENT",
    });
    expect(good.clause_results.every((clause) => clause.outcome === "UNVERIFIABLE")).toBe(true);

    const badWire = { ...goodWire, disposition: "blocked" as const };
    const bad = planSemanticQualificationStatusV2({
      wireBytes: canonicalJson(badWire),
      task: task(),
      descriptor,
    });
    expect(bad).toMatchObject({
      task_disposition: "BLOCKED",
      qualification_status: "NOT_QUALIFIED",
      reason_code: "INDEPENDENT_SEMANTIC_REVIEW_ABSENT",
    });
    expect(bad.clause_results.some((clause) => clause.outcome === "FAIL")).toBe(true);

    const boundaryOracle: PlanSemanticGraderOracleV2 = {
      ...baseOracle,
      clauses: baseOracle.clauses.map((clause, index) =>
        index === 0
          ? { ...clause, applicability: "not_applicable", semantic_review: "not_applicable" }
          : clause
      ),
    };
    const boundary = planSemanticQualificationStatusV2({
      wireBytes: canonicalJson(goodWire),
      task: task(),
      descriptor: planSemanticV2GraderDescriptor({
        graderCaseId: task().grader_case_id,
        protectedCapability: false,
        oracle: boundaryOracle,
      }),
    });
    expect(boundary).toMatchObject({
      task_disposition: "BLOCKED",
      qualification_status: "NOT_QUALIFIED",
      reason_code: "INDEPENDENT_SEMANTIC_REVIEW_ABSENT",
    });
    expect(boundary.clause_results[0]).toMatchObject({ outcome: "UNVERIFIABLE" });
  });

  it("bounds every per-clause reason/ref and provides a separately authorized semantic-review contract", () => {
    const requestValue = request();
    const draft = parseStrategyDraft(Buffer.from(persisted()), { request: requestValue }).draft;
    const wire = projectStrategyEvaluationV2(draft, requestValue);
    const wireBytes = canonicalJson(wire);
    const oracle = semanticV2Oracle(wire);
    const descriptor = planSemanticV2GraderDescriptor({
      graderCaseId: task().grader_case_id,
      protectedCapability: true,
      oracle,
    });
    const structural = gradePlanSemanticClausesV2(wireBytes, task(), descriptor);
    expect(
      structural.clause_results.every(
        (clause) =>
          clause.reason.length > 0 &&
          clause.reason.length <= 1024 &&
          clause.oracle_refs.length > 0 &&
          clause.oracle_refs.length <= 16 &&
          clause.evidence_refs.length > 0 &&
          clause.evidence_refs.length <= 32
      )
    ).toBe(true);
    const syntheticFutureReview = {
      schema_version: 1,
      skill: "plan",
      task_id: task().task_id,
      semantic_wire_sha256: sha256(wireBytes),
      oracle_sha256: sha256(canonicalJson(oracle)),
      reviewer_role: "independently_authorized_semantic_judge",
      judge_authorization_ref: "authorization:future-independent-review",
      clause_results: oracle.clauses.map((clause) => ({
        clause_id: clause.clause_id,
        outcome: "PASS",
        reason: "The independently reviewed clause passes against the cited task evidence.",
        oracle_refs: [clause.oracle_refs[0]],
        evidence_refs: [clause.evidence_refs[0]],
      })),
    };
    expect(validatePlanSemanticReviewOutputV1(syntheticFutureReview)).toBeDefined();
    expect(
      planSemanticQualificationStatusV2({
        wireBytes,
        task: task(),
        descriptor,
      })
    ).toMatchObject({
      task_disposition: "BLOCKED",
      qualification_status: "NOT_QUALIFIED",
      reason_code: "INDEPENDENT_SEMANTIC_REVIEW_ABSENT",
    });
    expect(() =>
      validatePlanSemanticReviewOutputV1({
        ...syntheticFutureReview,
        clause_results: syntheticFutureReview.clause_results.map((clause, index) =>
          index === 0 ? { ...clause, reason: "x".repeat(1025) } : clause
        ),
      })
    ).toThrow();
  });

  it("guards the semantic wire and grader against metadata, taskification fields, oracle markers, and prose proxies", () => {
    const requestValue = request();
    const draft = parseStrategyDraft(Buffer.from(persisted()), { request: requestValue }).draft;
    const wire = projectStrategyEvaluationV2(draft, requestValue);
    expect(Object.keys(StrategyEvaluationV2Schema.properties).sort()).toEqual([
      ...PLAN_SEMANTIC_V2_FIELD_NAMES,
    ]);
    const forbiddenFields = [
      "arm",
      "artifact_id",
      "cost_microusd",
      "execution_started",
      "latency_ms",
      "normalizer_id",
      "oracle_marker",
      "package_name",
      "provenance",
      "receipt_id",
      "registration_name",
      "run_id",
      "state_visits",
      "task_graph",
      "terminal_status",
      "tool_calls",
    ] as const;
    for (const field of forbiddenFields) {
      expect(() =>
        parseStrategySemanticGradingWireV2(canonicalJson({ ...wire, [field]: "forbidden" }))
      ).toThrow();
    }
    const descriptor = planSemanticV2GraderDescriptor({
      graderCaseId: task().grader_case_id,
      protectedCapability: false,
      oracle: semanticV2Oracle(wire),
    });
    const ordinary = gradePlanSemanticClausesV2(canonicalJson(wire), task(), descriptor);
    expect(() =>
      gradePlanSemanticClausesV2(canonicalJson(wire), task(), {
        ...descriptor,
        oracle: { ...semanticV2Oracle(wire), oracle_marker: "INVALID_MARKER" },
      })
    ).toThrow(/oracle/u);
    expect(
      gradePlanSemanticClausesV2(
        canonicalJson({
          ...wire,
          strategy_report:
            "Equivalent wording preserves the strategy while avoiding executor-level decomposition.",
        }),
        { ...task(), domain: "candidate:receipt:latency:artifact" },
        descriptor
      )
    ).toEqual(ordinary);

    const source = readFileSync(
      path.join(PROJECT_ROOT, ".pi", "extensions", "skill", "plan-evaluation.ts"),
      "utf8"
    );
    const projectionSource = readFileSync(
      path.join(PROJECT_ROOT, ".pi", "extensions", "skill", "evaluation-semantic-projections.ts"),
      "utf8"
    );
    expect(`${source}\n${projectionSource}`).not.toMatch(
      /required_report_terms|forbidden_report_terms|accepted_projection_sha256/u
    );
    const schemaStart = projectionSource.indexOf("export const StrategyEvaluationV2Schema");
    const projectionEnd = projectionSource.indexOf(
      "export const PlanSemanticRequestProjectionV1Schema",
      schemaStart
    );
    expect(schemaStart).toBeGreaterThan(-1);
    expect(projectionEnd).toBeGreaterThan(schemaStart);
    expect(projectionSource.slice(schemaStart, projectionEnd)).not.toMatch(
      /execution_started|artifact_id|receipt_id|registration_name|run_id|latency_ms|cost_microusd/u
    );
  });
});
