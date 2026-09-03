import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalizePlanRequest,
  initializePennyState,
  JsonValueSchema,
  parseStrategyDraft,
  planRequestItemIds,
  resolvePennyRuntimeState,
  sha256,
  strictParseJson,
  validateContract,
  type JsonValue,
  type PlanRequestConstraintsV1,
  type StrategyCoreV1,
} from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";

import {
  DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3,
  PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2,
  createDecisionSemanticOracleProjectionV3,
  createDecisionSemanticTrialProjectionV3,
} from "../../evaluation-semantic-projections.js";
import {
  PreauthorizedIndependentSemanticReviewExecutorV1,
  Q4_ORACLE_REVIEW_CLAUSE_IDS,
  SEMANTIC_REVIEW_IMPLEMENTATION_SHA256,
  SEMANTIC_REVIEW_JUDGE_DEFINITION_SHA256,
  SEMANTIC_REVIEW_SYSTEM_PROMPT_V1,
  SEMANTIC_REVIEW_TOOL_NAME,
  SemanticReviewProviderCompletionUnknownError,
  assertSemanticReviewEvidenceBinding,
  buildEvaluationLiveCalibrationAuthorizationManifestV1,
  buildSemanticOracleReviewPacketV1,
  buildSemanticTrialReviewPacketV1,
  createSemanticReviewSessionSpec,
  evaluationLiveCalibrationAuthorizationManifestSha256,
  semanticReviewOutputSchemaSha256,
  semanticReviewPacketSchemaSha256,
  validateEvaluationLiveCalibrationAuthorizationManifest,
  validateSemanticReviewOutputV1,
  validateSemanticReviewPacketV1,
  type EvaluationLiveCalibrationApprovalReceiptV1,
  type EvaluationLiveCalibrationAuthorizationManifestV1,
  type EvaluationOperatorApprovalVerifierV1,
  type PiSemanticReviewResolvedModelV1,
  type PiSemanticReviewTestTransportV1,
  type SemanticReviewJournalPhaseV1,
  type SemanticReviewOutputV1,
  type SemanticReviewPacketV1,
  type SemanticTrialReviewPacketV1,
} from "../../evaluation-semantic-review.js";
import {
  PLAN_SEMANTIC_CLAUSE_IDS,
  buildPlanSemanticOracleReviewPacketV2,
  buildPlanSemanticTrialReviewPacketV2,
  planSemanticQualificationStatusV2,
  planSemanticV2GraderDescriptor,
  projectStrategyEvaluationV2,
  type PlanSemanticGraderOracleV2,
} from "../../plan-evaluation.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const roots: string[] = [];

const DERIVATION_ATTESTATION = {
  schema_version: 1,
  derivation_method: "host_derived_from_permitted_request_basis",
  sealing_control: "oracle_projection_sealed_before_trial_output_review",
} as const;
const CONTAMINATION_ATTESTATION = {
  schema_version: 1,
  isolation_control: "host_only_oracle_projection_without_arm_mapping",
  contamination_result: "no_trial_output_or_identity_material",
} as const;

function planConstraints(): PlanRequestConstraintsV1 {
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

function planRequest() {
  return canonicalizePlanRequest({
    goal: "Form a transition strategy.",
    constraints: planConstraints(),
    exactInputArtifactIds: [],
  });
}

function planCore(): StrategyCoreV1 {
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

function planQualificationFixture() {
  const request = planRequest();
  const core = planCore();
  const persisted = `A complete strategy report.\nSTRATEGY_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`;
  const draft = parseStrategyDraft(Buffer.from(persisted), { request }).draft;
  const wire = projectStrategyEvaluationV2(draft, request);
  const itemIds = planRequestItemIds(request);
  const task = {
    task_id: "plan-semantic-review-task",
    domain: "unit",
    trigger_expected: true,
    goal: request.goal,
    constraints: planConstraints(),
    exact_input_artifact_ids: [],
    grader_case_id: "plan-semantic-review-grader",
  };
  const oracle: PlanSemanticGraderOracleV2 = {
    schema_version: 2,
    task_id: task.task_id,
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
      expected_blocker_presence: "none",
      allowed_confidence: [wire.confidence],
    },
    clauses: PLAN_SEMANTIC_CLAUSE_IDS.map((clause_id) => ({
      clause_id,
      applicability: "applicable" as const,
      semantic_review: "independent_semantic_judge_required" as const,
      oracle_refs: [`oracle:${clause_id}`],
      evidence_refs: [`evidence:${clause_id}`],
    })),
    oracle_marker: "PLAN_SEMANTIC_ORACLE_V2:REVIEW_TEST",
  };
  const descriptor = planSemanticV2GraderDescriptor({
    graderCaseId: task.grader_case_id,
    protectedCapability: true,
    oracle,
  });
  return { task, wire, descriptor };
}

function planPackets() {
  const fixture = planQualificationFixture();
  const trial = buildPlanSemanticTrialReviewPacketV2({
    wireBytes: canonicalJson(fixture.wire),
    task: fixture.task,
    descriptor: fixture.descriptor,
  });
  const oracle = buildPlanSemanticOracleReviewPacketV2({
    task: fixture.task,
    descriptor: fixture.descriptor,
    derivationAttestation: DERIVATION_ATTESTATION,
    contaminationAttestation: CONTAMINATION_ATTESTATION,
  });
  return { ...fixture, trial, oracle };
}

function decisionPackets() {
  const request = {
    schema_version: 1,
    decision_question: "Choose a supported option.",
    alternatives: [
      { alternative_id: "option-a", label: "Option A", description: "Use the known option." },
    ],
    hard_constraints: [{ constraint_id: "constraint-a", statement: "Do not invent facts." }],
    objectives: [{ objective_id: "objective-a", statement: "Preserve correctness." }],
    preferences: [],
    uncertainties: [{ uncertainty_id: "uncertainty-a", statement: "Timing is uncertain." }],
    evidence: [{ evidence_id: "evidence-a", statement: "Option A is currently available." }],
  };
  const wire = {
    schema_version: 3,
    rationale_report: "Option A is the only supplied feasible option.",
    outcome: "selected",
    applicability_reason: "A decision is requested.",
    feasibility: [{ alternative_id: "option-a", status: "feasible" }],
    recommendation: { kind: "selection", alternative_ids: ["option-a"] },
    comparison_dimension_ids: ["objective-a"],
    basis_ids_used: ["constraint-a", "objective-a", "evidence-a"],
    sensitivity: [
      {
        basis_ids: ["uncertainty-a"],
        resulting_decision_change: "A material availability change would reopen the choice.",
      },
    ],
    has_blocking_unresolved: false,
    confidence: "PROBABLE",
  };
  const structuredExpectations = {
    allowed_outcomes: ["selected"],
    expected_alternative_ids: ["option-a"],
    expected_hard_constraint_ids: ["constraint-a"],
    expected_feasibility: [{ alternative_id: "option-a", allowed_statuses: ["feasible"] }],
    accepted_recommendations: [{ kind: "selection", alternative_ids: ["option-a"] }],
    accepted_comparison_dimension_id_sets: [["objective-a"]],
    required_basis_ids: ["constraint-a", "objective-a", "evidence-a"],
    allowed_basis_ids: ["constraint-a", "objective-a", "uncertainty-a", "evidence-a"],
    required_sensitivity_basis_ids: ["uncertainty-a"],
    expected_blocking_unresolved: false,
    expected_blocking_question_presence: "none",
    allowed_confidence: ["PROBABLE"],
  };
  const clauses = DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3.map((clause_id) => ({
    clause_id,
    applicability: "applicable" as const,
  }));
  return {
    trial: buildSemanticTrialReviewPacketV1(
      createDecisionSemanticTrialProjectionV3({
        request,
        wire,
        clauses,
        structuredExpectations,
      })
    ),
    oracle: buildSemanticOracleReviewPacketV1(
      createDecisionSemanticOracleProjectionV3({
        request,
        structuredExpectations,
        derivationAttestation: DERIVATION_ATTESTATION,
        contaminationAttestation: CONTAMINATION_ATTESTATION,
      })
    ),
  };
}

function outputFor(
  packet: SemanticReviewPacketV1,
  outcome: "PASS" | "FAIL" | "UNVERIFIABLE" = "PASS"
): SemanticReviewOutputV1 {
  return validateSemanticReviewOutputV1({
    value: {
      schema_version: 1,
      review_kind: packet.review_kind,
      clause_results: packet.clause_criteria.map((criterion) => ({
        clause_id: criterion.clause_id,
        outcome,
        reason: `The packet-local basis supports ${criterion.clause_id}.`,
        oracle_refs: [criterion.oracle_refs[0] ?? "oracle:structured-expectations"],
        evidence_refs: [criterion.evidence_refs[0] ?? "evidence:permitted-request-basis"],
      })),
    },
    packet,
    canonicalClauseIds: packet.clause_criteria.map((criterion) => criterion.clause_id),
  });
}

function judgeModel(overrides: Partial<PiSemanticReviewResolvedModelV1> = {}) {
  return {
    id: "judge-model",
    name: "Semantic Judge Fixture",
    api: "openai-completions",
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
    ...overrides,
  } satisfies PiSemanticReviewResolvedModelV1;
}

class OutputTransport implements PiSemanticReviewTestTransportV1 {
  calls = 0;
  readonly modelOverrides: string[] = [];

  constructor(private readonly outputs: Array<SemanticReviewOutputV1 | string>) {}

  run(input: Parameters<PiSemanticReviewTestTransportV1["run"]>[0]) {
    this.calls += 1;
    this.modelOverrides.push(input.invocation.modelOverride ?? "");
    const output = this.outputs.shift();
    if (output === undefined) throw new Error("semantic-review output queue exhausted");
    return { text: typeof output === "string" ? output : canonicalJson(output) };
  }
}

function setupAuthorization(
  packet: SemanticTrialReviewPacketV1,
  trialClauseIds: readonly string[]
): {
  readonly env: NodeJS.ProcessEnv;
  readonly manifest: EvaluationLiveCalibrationAuthorizationManifestV1;
  readonly approval: EvaluationLiveCalibrationApprovalReceiptV1;
} {
  const root = mkdtempSync(path.join(tmpdir(), "penny-semantic-review-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    PENNY_STATE_ROOT: path.join(root, "state"),
    PENNY_EVALUATION_LOCAL_LIVE: "1",
  };
  initializePennyState(PROJECT_ROOT, { env });
  const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
  const manifest = buildEvaluationLiveCalibrationAuthorizationManifestV1({
    authorization_id: "authorization:test-live-calibration",
    calibration: {
      package_id: "calibration:test-package",
      package_sha256: sha256("calibration-package"),
      schedule_sha256: sha256("calibration-schedule"),
      arms: [
        { arm_id: "ablation", binding_sha256: sha256("ablation") },
        { arm_id: "baseline", binding_sha256: sha256("baseline") },
        { arm_id: "candidate", binding_sha256: sha256("candidate") },
      ],
    },
    execution_binding: {
      provider: "ollama",
      model: "trial-model",
      runtime: "pi",
      thinking_level: "medium",
    },
    judge_binding: {
      provider: "ollama",
      model: "judge-model",
      runtime: "pi",
      thinking_level: "high",
    },
    judge_contract: {
      judge_definition_sha256: SEMANTIC_REVIEW_JUDGE_DEFINITION_SHA256,
      judge_prompt_sha256: sha256(SEMANTIC_REVIEW_SYSTEM_PROMPT_V1),
      trial_packet_schema_sha256: semanticReviewPacketSchemaSha256(
        "trial",
        packet.skill,
        trialClauseIds
      ),
      oracle_packet_schema_sha256: semanticReviewPacketSchemaSha256(
        "oracle",
        packet.skill,
        Q4_ORACLE_REVIEW_CLAUSE_IDS
      ),
      trial_output_schema_sha256: semanticReviewOutputSchemaSha256("trial", trialClauseIds),
      oracle_output_schema_sha256: semanticReviewOutputSchemaSha256(
        "oracle",
        Q4_ORACLE_REVIEW_CLAUSE_IDS
      ),
      implementation_sha256: SEMANTIC_REVIEW_IMPLEMENTATION_SHA256,
    },
    roots: {
      state_root: path.resolve(state.state.root),
      evidence_root: path.resolve(state.paths.artifacts.root),
    },
    limits: {
      repetitions: 3,
      max_concurrency: 1,
      max_calls: 18,
      max_retries: 0,
      max_input_tokens: 100_000,
      max_output_tokens: 10_000,
      max_total_tokens: 110_000,
      max_storage_bytes: 10_000_000,
      max_spend_microusd: 0,
      max_wall_clock_ms: 60_000,
    },
    egress: {
      allowed_origins: ["http://127.0.0.1:11434"],
      credential_scope: "none",
    },
    validity: {
      not_before: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-09-01T02:00:00.000Z",
    },
    nonce: "nonce_test_1234567890",
  });
  const approval: EvaluationLiveCalibrationApprovalReceiptV1 = {
    schema_version: 1,
    approval_id: "approval:test-live-calibration",
    scope: "evaluation_live_calibration",
    manifest_sha256: evaluationLiveCalibrationAuthorizationManifestSha256(manifest),
    owner_id: "owner:test",
    issued_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-01T02:00:00.000Z",
    nonce: manifest.nonce,
    verification_material: "operator-controlled-test-proof",
  };
  return { env, manifest, approval };
}

function verifier(
  options: { readonly reject?: boolean } = {}
): EvaluationOperatorApprovalVerifierV1 {
  return {
    verify: ({ approval }) => {
      if (options.reject === true) throw new Error("owner proof rejected");
      return { owner_id: approval.owner_id, verification_id: "verified:test-owner-proof" };
    },
    admit: ({ exact_journal_present }) => (exact_journal_present ? "resume" : "fresh"),
  };
}

function executor(input: {
  readonly packet: SemanticTrialReviewPacketV1;
  readonly authorization: ReturnType<typeof setupAuthorization>;
  readonly transport: PiSemanticReviewTestTransportV1;
  readonly resolveModel?: (modelId: string) => PiSemanticReviewResolvedModelV1;
  readonly ownerVerifier?: EvaluationOperatorApprovalVerifierV1;
  readonly expectedManifest?: unknown;
}) {
  return new PreauthorizedIndependentSemanticReviewExecutorV1({
    projectRoot: PROJECT_ROOT,
    env: input.authorization.env,
    cliOptIn: true,
    manifest: input.authorization.manifest,
    expectedManifest: input.expectedManifest ?? input.authorization.manifest,
    approval: input.authorization.approval,
    ownerVerifier: input.ownerVerifier ?? verifier(),
    packageJournalPresent: false,
    now: () => new Date("2026-09-01T01:00:00.000Z"),
    resolveModel: input.resolveModel ?? (() => judgeModel()),
    testOnlyTransport: input.transport,
  });
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedJsonValue(content: string): JsonValue {
  return validateContract(JsonValueSchema, strictParseJson(content), "test JSON value");
}

function addRootField(content: string, key: string): string {
  const parsed = parsedJsonValue(content);
  if (!isJsonObject(parsed)) throw new Error("fixture content is not an object");
  return canonicalJson({ ...parsed, [key]: "forbidden" });
}

function addNestedRelationField(content: string, key: string): string {
  const parsed = parsedJsonValue(content);
  if (!isJsonObject(parsed)) throw new Error("fixture content is not an object");
  const relations = parsed.expected_dependency_relations;
  if (!Array.isArray(relations) || relations.length === 0) {
    throw new Error("fixture has no dependency relation array");
  }
  const first = relations[0];
  if (!isJsonObject(first)) throw new Error("fixture dependency relation is not an object");
  return canonicalJson({
    ...parsed,
    expected_dependency_relations: [{ ...first, [key]: "forbidden" }, ...relations.slice(1)],
  });
}

function validatePacket(packet: unknown, source: SemanticReviewPacketV1): void {
  validateSemanticReviewPacketV1({
    value: packet,
    reviewKind: source.review_kind,
    canonicalClauseIds:
      source.review_kind === "oracle"
        ? Q4_ORACLE_REVIEW_CLAUSE_IDS
        : source.skill === "decide"
          ? DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3
          : PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("independent semantic review infrastructure", () => {
  it("constructs only task-specific validated Decide V3 and Plan V2 projections", () => {
    const plan = planPackets();
    const decide = decisionPackets();
    for (const packet of [plan.trial, decide.trial]) {
      expect(Object.keys(packet).sort()).toEqual([
        "clause_criteria",
        "oracle_projection",
        "review_kind",
        "schema_version",
        "semantic_request",
        "semantic_wire",
        "skill",
      ]);
      expect(packet.semantic_request.request).toBe(
        packet.semantic_request.permitted_evidence[0].content
      );
      expect(packet.semantic_wire).toEqual({
        projection_kind:
          packet.skill === "decide" ? "decision_semantic_wire_v3" : "plan_semantic_wire_v2",
        content: packet.semantic_wire.content,
      });
    }
    for (const packet of [plan.oracle, decide.oracle]) {
      expect(packet).not.toHaveProperty("semantic_wire");
      expect(canonicalJson(packet)).not.toContain("trial_id");
      expect(canonicalJson(packet)).not.toContain("arm_id");
    }
    expect(() => {
      Reflect.apply(buildSemanticTrialReviewPacketV1, undefined, [
        { skill: "plan", arbitrary: { caller: "json" } },
      ]);
    }).toThrow(/module-issued validation authority/u);
  });

  it("recursively rejects metadata bypass variants in trial and Q4 packets", () => {
    const { trial, oracle } = planPackets();
    const keyVariants = [
      "arm_id",
      "arm-id",
      "armId",
      "ArmId",
      "aRm-ID",
      "аrmId",
      "trial_id",
      "trial-id",
      "trialId",
      "TrialId",
      "artifactId",
      "receipt-id",
      "registrationName",
      "transport_Info",
      "provenanceData",
      "performanceLatencyMs",
      "modelId",
      "stateId",
    ] as const;
    for (const key of keyVariants) {
      const requestContent = addRootField(oracle.semantic_request.request, key);
      expect(() =>
        validatePacket(
          {
            ...oracle,
            semantic_request: {
              ...oracle.semantic_request,
              request: requestContent,
              permitted_evidence: [
                { ...oracle.semantic_request.permitted_evidence[0], content: requestContent },
              ],
            },
          },
          oracle
        )
      ).toThrow();
      expect(() =>
        validatePacket(
          {
            ...oracle,
            oracle_projection: {
              ...oracle.oracle_projection,
              facts: [
                {
                  ...oracle.oracle_projection.facts[0],
                  content: addNestedRelationField(oracle.oracle_projection.facts[0].content, key),
                },
              ],
            },
          },
          oracle
        )
      ).toThrow();
      expect(() =>
        validatePacket(
          {
            ...oracle,
            oracle_projection: {
              ...oracle.oracle_projection,
              derivation_attestations: [
                {
                  ...oracle.oracle_projection.derivation_attestations[0],
                  content: addRootField(
                    oracle.oracle_projection.derivation_attestations[0].content,
                    key
                  ),
                },
              ],
            },
          },
          oracle
        )
      ).toThrow();
      expect(() =>
        validatePacket({ ...oracle, [key]: { semantic_wire: "candidate" } }, oracle)
      ).toThrow();
      expect(() =>
        validatePacket(
          {
            ...trial,
            semantic_wire: {
              ...trial.semantic_wire,
              content: addRootField(trial.semantic_wire.content, key),
            },
          },
          trial
        )
      ).toThrow();
    }
    const candidateOutputVariants = [
      "candidate_output",
      "candidate-output",
      "candidateOutput",
      "CandidateOutput",
      "cAnDiDaTe-Output",
      "candidateОutput",
      "semantic_wire",
      "semantic-wire",
      "semanticWire",
      "SemanticWire",
    ] as const;
    for (const key of candidateOutputVariants) {
      expect(() => validatePacket({ ...oracle, [key]: { answer: "candidate" } }, oracle)).toThrow();
      expect(() =>
        validatePacket(
          {
            ...oracle,
            oracle_projection: {
              ...oracle.oracle_projection,
              contamination_attestations: [
                {
                  ...oracle.oracle_projection.contamination_attestations[0],
                  content: addRootField(
                    oracle.oracle_projection.contamination_attestations[0].content,
                    key
                  ),
                },
              ],
            },
          },
          oracle
        )
      ).toThrow();
    }
  });

  it("creates a private one-tool terminating session and rejects prose or clause drift", () => {
    const packet = planPackets().trial;
    const session = createSemanticReviewSessionSpec({
      packet,
      canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
      systemPrompt: SEMANTIC_REVIEW_SYSTEM_PROMPT_V1,
    });
    expect(session.noTools).toBe("all");
    expect(session.tools).toEqual([SEMANTIC_REVIEW_TOOL_NAME]);
    expect(session.customTools).toHaveLength(1);
    expect(session.sensitiveOutput).toBe(true);
    expect(session.readResult?.()).toBeUndefined();
    expect(semanticReviewOutputSchemaSha256("trial", PLAN_SEMANTIC_CLAUSE_IDS)).not.toBe(
      semanticReviewOutputSchemaSha256("oracle", Q4_ORACLE_REVIEW_CLAUSE_IDS)
    );
    const oraclePacket = planPackets().oracle;
    expect(() =>
      validateSemanticReviewOutputV1({
        value: {
          schema_version: 1,
          review_kind: "oracle",
          clause_results: [
            {
              clause_id: PLAN_SEMANTIC_CLAUSE_IDS[0],
              outcome: "PASS",
              reason: "A trial result must not satisfy the Q4 output schema.",
              oracle_refs: ["oracle:structured-expectations"],
              evidence_refs: ["evidence:permitted-request-basis"],
            },
          ],
        },
        packet: oraclePacket,
        canonicalClauseIds: Q4_ORACLE_REVIEW_CLAUSE_IDS,
      })
    ).toThrow();
    expect(() =>
      validateSemanticReviewOutputV1({
        value: {
          ...outputFor(packet),
          clause_results: [...outputFor(packet).clause_results].reverse(),
        },
        packet,
        canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
      })
    ).toThrow(/every canonical clause exactly once/u);
    expect(() =>
      validateSemanticReviewOutputV1({
        value: { ...outputFor(packet), prose: "fallback" },
        packet,
        canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
      })
    ).toThrow();
  });

  it("refuses missing authorization before model resolution or transport", async () => {
    const { trial } = planPackets();
    const authorization = setupAuthorization(trial, PLAN_SEMANTIC_CLAUSE_IDS);
    let resolutions = 0;
    const transport = new OutputTransport([outputFor(trial)]);
    const rejected = executor({
      packet: trial,
      authorization,
      transport,
      ownerVerifier: verifier({ reject: true }),
      resolveModel: () => {
        resolutions += 1;
        return judgeModel();
      },
    });
    await expect(rejected.preflight()).rejects.toThrow(/owner proof rejected/u);
    expect(resolutions).toBe(0);
    expect(transport.calls).toBe(0);

    const absentOptIn = new PreauthorizedIndependentSemanticReviewExecutorV1({
      projectRoot: PROJECT_ROOT,
      env: { ...authorization.env, PENNY_EVALUATION_LOCAL_LIVE: "0" },
      cliOptIn: true,
      manifest: authorization.manifest,
      expectedManifest: authorization.manifest,
      approval: authorization.approval,
      ownerVerifier: verifier(),
      packageJournalPresent: false,
      now: () => new Date("2026-09-01T01:00:00.000Z"),
      resolveModel: () => {
        resolutions += 1;
        return judgeModel();
      },
      testOnlyTransport: transport,
    });
    await expect(absentOptIn.preflight()).rejects.toThrow(/explicit caller opt-in/u);
    expect(resolutions).toBe(0);
    expect(transport.calls).toBe(0);
  });

  it("enforces exact provider, model, and egress admission before session transport", async () => {
    const { trial } = planPackets();
    const adversarialModels: ReadonlyArray<{
      readonly label: string;
      readonly resolve: () => PiSemanticReviewResolvedModelV1;
      readonly message: RegExp;
    }> = [
      {
        label: "provider",
        resolve: () => judgeModel({ provider: "other-provider" }),
        message: /provider\/model binding/u,
      },
      {
        label: "model",
        resolve: () => judgeModel({ id: "other-model" }),
        message: /provider\/model binding/u,
      },
      {
        label: "origin",
        resolve: () => judgeModel({ baseUrl: "http://127.0.0.1:9999" }),
        message: /egress origins/u,
      },
      {
        label: "credentials",
        resolve: () => judgeModel({ baseUrl: "http://user:pass@127.0.0.1:11434" }),
        message: /egress origins/u,
      },
      {
        label: "absent",
        resolve: () => {
          throw new Error("model absent from catalog");
        },
        message: /model absent/u,
      },
    ];
    for (const adversarial of adversarialModels) {
      const authorization = setupAuthorization(trial, PLAN_SEMANTIC_CLAUSE_IDS);
      const transport = new OutputTransport([outputFor(trial)]);
      const guarded = executor({
        packet: trial,
        authorization,
        transport,
        resolveModel: adversarial.resolve,
      });
      await guarded.preflight();
      await expect(
        guarded.review({
          packet: trial,
          reviewKind: "trial",
          canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
        })
      ).rejects.toThrow(adversarial.message);
      expect(transport.calls, adversarial.label).toBe(0);
    }
  });

  it("records exact journals, resumes completed/raw work, and refuses unknown completion", async () => {
    const { trial } = planPackets();
    const authorization = setupAuthorization(trial, PLAN_SEMANTIC_CLAUSE_IDS);
    const transport = new OutputTransport([outputFor(trial)]);
    const runner = executor({ packet: trial, authorization, transport });
    await runner.preflight();
    const first = await runner.review({
      packet: trial,
      reviewKind: "trial",
      canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
    });
    expect(first.provider_calls).toBe(1);
    expect(transport.calls).toBe(1);
    expect(transport.modelOverrides).toEqual(["ollama/judge-model"]);
    assertSemanticReviewEvidenceBinding({
      evidence: first.evidence,
      packet: trial,
      reviewKind: "trial",
    });
    const resumed = await runner.review({
      packet: trial,
      reviewKind: "trial",
      canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
    });
    expect(resumed.provider_calls).toBe(0);
    expect(transport.calls).toBe(1);

    const rawFixture = planPackets();
    const rawAuthorization = setupAuthorization(rawFixture.trial, PLAN_SEMANTIC_CLAUSE_IDS);
    const rawTransport = new OutputTransport([outputFor(rawFixture.trial)]);
    const rawRunner = executor({
      packet: rawFixture.trial,
      authorization: rawAuthorization,
      transport: rawTransport,
    });
    await rawRunner.preflight();
    await expect(
      rawRunner.review({
        packet: rawFixture.trial,
        reviewKind: "trial",
        canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
        faultAfterTransition: (phase: SemanticReviewJournalPhaseV1) => {
          if (phase === "raw_output_recorded") throw new Error("injected raw fault");
        },
      })
    ).rejects.toThrow(/injected raw fault/u);
    const resumedRaw = await rawRunner.review({
      packet: rawFixture.trial,
      reviewKind: "trial",
      canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
    });
    expect(resumedRaw.provider_calls).toBe(0);
    expect(rawTransport.calls).toBe(1);

    const invokingFixture = planPackets();
    const invokingAuthorization = setupAuthorization(
      invokingFixture.trial,
      PLAN_SEMANTIC_CLAUSE_IDS
    );
    const invokingTransport = new OutputTransport([outputFor(invokingFixture.trial)]);
    const invokingRunner = executor({
      packet: invokingFixture.trial,
      authorization: invokingAuthorization,
      transport: invokingTransport,
    });
    await invokingRunner.preflight();
    await expect(
      invokingRunner.review({
        packet: invokingFixture.trial,
        reviewKind: "trial",
        canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
        faultAfterTransition: (phase: SemanticReviewJournalPhaseV1) => {
          if (phase === "invoking") throw new Error("injected invoking fault");
        },
      })
    ).rejects.toThrow(/injected invoking fault/u);
    await expect(
      invokingRunner.review({
        packet: invokingFixture.trial,
        reviewKind: "trial",
        canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
      })
    ).rejects.toBeInstanceOf(SemanticReviewProviderCompletionUnknownError);
    expect(invokingTransport.calls).toBe(0);
  });

  it("never reinvokes malformed retained output", async () => {
    const { trial } = planPackets();
    const authorization = setupAuthorization(trial, PLAN_SEMANTIC_CLAUSE_IDS);
    const transport = new OutputTransport(["ordinary assistant prose"]);
    const runner = executor({ packet: trial, authorization, transport });
    await runner.preflight();
    const review = () =>
      runner.review({
        packet: trial,
        reviewKind: "trial" as const,
        canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
      });
    await expect(review()).rejects.toThrow(/not strict JSON/u);
    await expect(review()).rejects.toThrow(/not strict JSON/u);
    expect(transport.calls).toBe(1);
  });

  it("qualifies Plan V2 only with trial review and distinct Q4 review", async () => {
    const fixture = planPackets();
    const structuralFailureWire = { ...fixture.wire, disposition: "blocked" as const };
    const structuralFailurePacket = buildPlanSemanticTrialReviewPacketV2({
      wireBytes: canonicalJson(structuralFailureWire),
      task: fixture.task,
      descriptor: fixture.descriptor,
    });
    const unverifiableWire = {
      ...fixture.wire,
      strategy_report: "A distinct report with insufficient semantic evidence.",
    };
    const unverifiablePacket = buildPlanSemanticTrialReviewPacketV2({
      wireBytes: canonicalJson(unverifiableWire),
      task: fixture.task,
      descriptor: fixture.descriptor,
    });
    const authorization = setupAuthorization(fixture.trial, PLAN_SEMANTIC_CLAUSE_IDS);
    const transport = new OutputTransport([
      outputFor(fixture.oracle),
      outputFor(fixture.trial),
      outputFor(structuralFailurePacket),
      outputFor(unverifiablePacket, "UNVERIFIABLE"),
    ]);
    const runner = executor({ packet: fixture.trial, authorization, transport });
    await runner.preflight();
    const oracleReview = await runner.review({
      packet: fixture.oracle,
      reviewKind: "oracle",
      canonicalClauseIds: Q4_ORACLE_REVIEW_CLAUSE_IDS,
    });
    const trialReview = await runner.review({
      packet: fixture.trial,
      reviewKind: "trial",
      canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
    });
    expect(
      planSemanticQualificationStatusV2({
        wireBytes: canonicalJson(fixture.wire),
        task: fixture.task,
        descriptor: fixture.descriptor,
        semanticReview: trialReview.evidence,
        oracleReview: oracleReview.evidence,
      })
    ).toMatchObject({
      task_disposition: "PASS",
      qualification_status: "QUALIFIED",
      reason_code: "ALL_APPLICABLE_CLAUSES_PASS",
    });
    const structuralReview = await runner.review({
      packet: structuralFailurePacket,
      reviewKind: "trial",
      canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
    });
    expect(
      planSemanticQualificationStatusV2({
        wireBytes: canonicalJson(structuralFailureWire),
        task: fixture.task,
        descriptor: fixture.descriptor,
        semanticReview: structuralReview.evidence,
        oracleReview: oracleReview.evidence,
      })
    ).toMatchObject({ task_disposition: "FAIL", reason_code: "STRUCTURAL_CLAUSE_FAILED" });
    const unverifiableReview = await runner.review({
      packet: unverifiablePacket,
      reviewKind: "trial",
      canonicalClauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
    });
    expect(
      planSemanticQualificationStatusV2({
        wireBytes: canonicalJson(unverifiableWire),
        task: fixture.task,
        descriptor: fixture.descriptor,
        semanticReview: unverifiableReview.evidence,
        oracleReview: oracleReview.evidence,
      })
    ).toMatchObject({
      task_disposition: "BLOCKED",
      reason_code: "SEMANTIC_CLAUSE_UNVERIFIABLE",
    });
  });

  it("rejects stale schedule/arm bindings before model resolution", async () => {
    const { trial } = planPackets();
    const authorization = setupAuthorization(trial, PLAN_SEMANTIC_CLAUSE_IDS);
    const drifted = {
      ...authorization.manifest,
      calibration: {
        ...authorization.manifest.calibration,
        schedule_sha256: sha256("different-schedule"),
      },
    };
    let resolutions = 0;
    const runner = executor({
      packet: trial,
      authorization,
      transport: new OutputTransport([outputFor(trial)]),
      expectedManifest: drifted,
      resolveModel: () => {
        resolutions += 1;
        return judgeModel();
      },
    });
    await expect(runner.preflight()).rejects.toThrow(/stale or digest-drifted/u);
    expect(resolutions).toBe(0);
    expect(() =>
      validateEvaluationLiveCalibrationAuthorizationManifest({
        ...authorization.manifest,
        calibration: {
          ...authorization.manifest.calibration,
          arms: [...authorization.manifest.calibration.arms].reverse(),
        },
      })
    ).toThrow(/canonically sorted/u);
  });

  it("source-guards the local-live authorized Pi path and absence of client bypasses", () => {
    const semanticSource = readFileSync(
      path.join(PROJECT_ROOT, ".pi/extensions/skill/evaluation-semantic-review.ts"),
      "utf8"
    );
    const localLiveSource = readFileSync(
      path.join(PROJECT_ROOT, ".pi/extensions/skill/evaluation-local-live.ts"),
      "utf8"
    );
    expect(semanticSource).toContain("const client = createPiSemanticReviewModelClient({");
    expect(semanticSource).toContain("const piClient = new PiAgentClient({");
    expect(localLiveSource).toContain("createLocalLiveSemanticReviewExecutorV1");
    expect(localLiveSource).toContain("new PreauthorizedIndependentSemanticReviewExecutorV1({");
    expect(semanticSource).not.toMatch(/readonly createModelClient/u);
    expect(semanticSource).not.toMatch(/export async function executeIndependentSemanticReview/u);
    expect(localLiveSource).not.toMatch(/createModelClient/u);
  });
});
