import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalizeDecisionRequest,
  DECIDE_LIVENESS_POLICY,
  decisionRequestSha256,
  parsePersistedDecisionDraft,
  sealDecisionDraft,
  sha256,
  type ArtifactRef,
  type DecisionDraftV2,
  type OutputArtifactMetadata,
} from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

import {
  DECIDE_EVALUATION_NORMALIZER_DESCRIPTORS,
  DECIDE_SEMANTIC_CLAUSE_IDS,
  DECIDE_SEMANTIC_DOD_MAPPING_V3,
  DECISION_SEMANTIC_V3_FIELD_NAMES,
  DECIDE_SEMANTIC_V3_GRADER_IMPLEMENTATION,
  DECISION_GRADING_WIRE,
  DECISION_SEMANTIC_GRADING_WIRE_V3,
  DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
  DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION,
  DecisionSemanticEvaluationV3Schema,
  DirectDecisionEvaluationCoreV2Schema,
  createDecisionEvaluationGradingDefinition,
  createDecisionSemanticV3GradingDefinition,
  decisionGraderDescriptor,
  decisionSemanticQualificationStatusV3,
  decisionSemanticV3GraderDescriptor,
  gradeDecisionSemanticClausesV3,
  parseDecisionGradingWire,
  parseDecisionSemanticGradingWireV3,
  parseDirectDecisionEvaluationReport,
  projectDecisionEvaluation,
  projectDecisionSemanticEvaluationV3,
  replayDecisionSafeRecoveryDiagnostic,
  validateDecideSemanticReviewOutputV1,
  type DecideSemanticGraderOracleV3,
  type DecisionSafeRecoveryReplayEntryV1,
} from "../../decide-evaluation.js";
import {
  directBaselineDefinition,
  evaluationGradingDefinitionSha256,
  type DeterministicGraderImplementationV1,
} from "../../evaluation-runner.js";
import {
  decisionDraft,
  decisionRequest,
  persistedDecisionDraft,
} from "../../../../../apps/orchestration/tests/fixtures/decision-fixtures.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const GRADER: DeterministicGraderImplementationV1 = {
  grader_id: "penny.decide-unit-grader.v1",
  grader_version: 1,
  implementation_sha256: sha256("penny.decide-unit-grader.v1:implementation:1"),
  grade: () => ({ task_score: 1, trigger_predicted: true, protected_capability_score: null }),
};

function grading(oracle: string, implementation = GRADER) {
  return createDecisionEvaluationGradingDefinition([
    {
      descriptor: decisionGraderDescriptor({
        graderCaseId: "decide-unit-case",
        graderId: implementation.grader_id,
        graderVersion: implementation.grader_version,
        protectedCapability: false,
        oracle: { expected: oracle },
      }),
      implementation,
    },
  ]);
}

function outputRef(content: string): ArtifactRef {
  const digest = sha256(content);
  return {
    schema_version: 2,
    artifact_id: `art_${"a".repeat(64)}`,
    run_id: "decide-unit-trial",
    phase: "deciding",
    branch_id: null,
    kind: "decision-report",
    operation_id: "decide-unit-output",
    version: 1,
    producer: "agent:demetri",
    media_type: "text/plain; charset=utf-8",
    content_schema: {
      schema_id: "penny.direct-decision-evaluation-report.v2",
      schema_version: 2,
    },
    byte_length: Buffer.byteLength(content),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function outputMetadata(
  ref: ArtifactRef,
  upstreamRefs: readonly ArtifactRef[] = []
): OutputArtifactMetadata {
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
    upstream_refs: [...upstreamRefs],
  };
}

function upstreamRef(input: {
  readonly artifactId: string;
  readonly runId?: string;
  readonly kind: string;
  readonly phase: string;
  readonly producer: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
}): ArtifactRef {
  const digest = "0".repeat(64);
  return {
    schema_version: 2,
    artifact_id: input.artifactId,
    run_id: input.runId ?? "decide-unit-trial",
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: `unit-upstream:${input.artifactId}`,
    version: 1,
    producer: input.producer,
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: input.schemaVersion },
    byte_length: 2,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function task(exactInputArtifactIds: readonly string[] = []) {
  const request = decisionRequest();
  const { decision_question: goal, ...constraints } = request;
  return {
    task_id: "decide-unit-task",
    domain: "unit",
    trigger_expected: true,
    goal,
    constraints,
    exact_input_artifact_ids: [...exactInputArtifactIds],
    grader_case_id: "decide-unit-case",
  };
}

function directReport(draft: DecisionDraftV2 = decisionDraft("selected")): string {
  const { rationale_report: rationaleReport, ...core } = draft;
  return `${rationaleReport}\nDECISION_CORE:${JSON.stringify(core)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`;
}

function semanticV3Oracle(
  wire: ReturnType<typeof projectDecisionSemanticEvaluationV3>
): DecideSemanticGraderOracleV3 {
  const request = decisionRequest();
  return {
    schema_version: 3,
    task_id: task().task_id,
    structured_expectations: {
      allowed_outcomes: [wire.outcome],
      expected_alternative_ids: request.alternatives.map((item) => item.alternative_id),
      expected_hard_constraint_ids: request.hard_constraints.map((item) => item.constraint_id),
      expected_feasibility: wire.feasibility.map((entry) => ({
        alternative_id: entry.alternative_id,
        allowed_statuses: [entry.status],
      })),
      accepted_recommendations: [wire.recommendation],
      accepted_comparison_dimension_id_sets: [[...wire.comparison_dimension_ids]],
      required_basis_ids: [...wire.basis_ids_used],
      allowed_basis_ids: [
        ...request.hard_constraints.map((item) => item.constraint_id),
        ...request.objectives.map((item) => item.objective_id),
        ...request.preferences.map((item) => item.preference_id),
        ...request.uncertainties.map((item) => item.uncertainty_id),
        ...request.evidence.map((item) => item.evidence_id),
      ],
      required_sensitivity_basis_ids: [
        ...new Set(wire.sensitivity.flatMap((entry) => entry.basis_ids)),
      ],
      expected_blocking_unresolved: wire.has_blocking_unresolved,
      expected_blocking_question_presence:
        wire.blocking_questions === undefined ? "none" : "nonempty",
      allowed_confidence: [wire.confidence],
    },
    clauses: DECIDE_SEMANTIC_CLAUSE_IDS.map((clause_id) => ({
      clause_id,
      applicability: "applicable",
      semantic_review: "independent_semantic_judge_required",
      oracle_refs: [`oracle:${clause_id}`],
      evidence_refs: [`evidence:${clause_id}`],
    })),
    oracle_marker: "DECIDE_SEMANTIC_ORACLE_V3:UNIT",
  };
}

function uniqueFeasibleSurvivorDraft(): DecisionDraftV2 {
  const selected = decisionDraft("selected");
  return {
    ...selected,
    feasibility: selected.feasibility.map((entry) =>
      entry.alternative_id === "alt_a"
        ? { ...entry, status: "feasible" }
        : { ...entry, status: "infeasible" }
    ),
    comparison_dimension_ids: [],
  };
}

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

describe("minimal direct-Decide comparator and grading definition", () => {
  it("uses the generic direct baseline with Decide's bounded external policy and a distinct V2 report output schema", () => {
    expect(DECIDE_LIVENESS_POLICY).toMatchObject({
      scope: "orchestrated-decide-candidate",
      preset: "bounded-external-orchestrated-v1",
      total_phase_repair_invocations: 24,
      model_turns_per_worker: 12,
      model_turns_per_run: 96,
      tool_calls_per_worker: 24,
      tool_calls_per_run: 160,
      external_calls_per_worker: 8,
      external_calls_per_run: 64,
      worker_wall_clock_ms: 180_000,
      run_wall_clock_ms: 900_000,
      routing_repair: {
        max_invocations_per_state_branch: 1,
        model_turns_per_worker: 4,
        tool_calls_per_worker: 2,
        external_calls_per_worker: 0,
        worker_wall_clock_ms: 120_000,
      },
    });
    expect(
      directBaselineDefinition(DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION, PROJECT_ROOT)
    ).toMatchObject({
      liveness_policy_sha256: sha256(canonicalJson(DECIDE_LIVENESS_POLICY)),
      registration_name: DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
      agent: "demetri",
      phase: "deciding",
      guidance: {
        skill_root: "evals/guidance/decide",
        resolution: "per_agent_phase",
        path: "evals/guidance/decide/demetri-deciding.md",
      },
      output: {
        artifact_kind: "decision-report",
        schema_id: "penny.direct-decision-evaluation-report.v2",
        schema_version: 2,
        producer: "agent:demetri",
      },
    });
  });

  it("binds baseline, sealed candidate, and unsealed ablation to one V2 wire", () => {
    expect(
      DECIDE_EVALUATION_NORMALIZER_DESCRIPTORS.map((descriptor) => ({
        registration: descriptor.registration_name,
        normalizer: `${descriptor.normalizer_id}@${descriptor.normalizer_version}`,
        source: descriptor.source_output,
        target: descriptor.target_wire,
      }))
    ).toEqual([
      {
        registration: "decide",
        normalizer: "penny.sealed-decision-evaluation-normalizer.v7@7",
        source: {
          artifact_kind: "semantic-core",
          schema_id: "penny.decision.v2",
          schema_version: 2,
        },
        target: DECISION_GRADING_WIRE,
      },
      {
        registration: "decide-unsealed",
        normalizer: "penny.decision-draft-evaluation-normalizer.v7@7",
        source: {
          artifact_kind: "decision-draft",
          schema_id: "penny.decision-draft.v2",
          schema_version: 2,
        },
        target: DECISION_GRADING_WIRE,
      },
      {
        registration: DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
        normalizer: "penny.direct-decision-report-normalizer.v8@8",
        source: {
          artifact_kind: "decision-report",
          schema_id: "penny.direct-decision-evaluation-report.v2",
          schema_version: 2,
        },
        target: DECISION_GRADING_WIRE,
      },
    ]);
  });

  it("applies feasible-survivor dimension semantics identically to sealed, unsealed, and direct common-wire normalization", () => {
    const definition = grading("selected-alt-a");
    const normalizers = new Map(
      [...definition.implementations.semantic_normalizers.entries()].map(
        ([registrationName, implementation]) => {
          const descriptor = definition.descriptor.semantic_normalizers.find(
            (candidate) => candidate.registration_name === registrationName
          );
          if (descriptor === undefined) {
            throw new Error(`missing normalizer descriptor for '${registrationName}'`);
          }
          return [registrationName, { descriptor, implementation }] as const;
        }
      )
    );
    const request = decisionRequest();
    const requestArtifactId = `art_${"b".repeat(64)}`;
    const draftArtifactId = `art_${"c".repeat(64)}`;
    const requestRef = upstreamRef({
      artifactId: requestArtifactId,
      kind: "decision-request",
      phase: "intake",
      producer: "host:request-admission",
      schemaId: "penny.decision-request.v1",
      schemaVersion: 1,
    });
    const draftRef = upstreamRef({
      artifactId: draftArtifactId,
      kind: "decision-draft",
      phase: "deciding",
      producer: "agent:demetri",
      schemaId: "penny.decision-draft.v2",
      schemaVersion: 2,
    });
    const uniqueSurvivor = uniqueFeasibleSurvivorDraft();
    const uniqueReport = directReport(uniqueSurvivor);
    const directRef = outputRef(uniqueReport);
    const direct = normalizers.get(DIRECT_DECIDE_DEMETRI_BASELINE_NAME);
    const unsealed = normalizers.get("decide-unsealed");
    const candidate = normalizers.get("decide");
    if (direct === undefined || unsealed === undefined || candidate === undefined) {
      throw new Error("shared Decision semantic normalizer fixtures are incomplete");
    }
    const unsealedRef: ArtifactRef = {
      ...directRef,
      kind: "decision-draft",
      content_schema: { schema_id: "penny.decision-draft.v2", schema_version: 2 },
    };
    const sealedDecision = sealDecisionDraft({
      request,
      draft: uniqueSurvivor,
      requestSha256: decisionRequestSha256(request),
      sourceRequestArtifactId: requestArtifactId,
      sourceDraftArtifactId: draftArtifactId,
      exactInputArtifactIds: [],
    });
    const sealedBytes = canonicalJson(sealedDecision);
    const sealedRef: ArtifactRef = {
      ...outputRef(sealedBytes),
      phase: "sealing_decision",
      kind: "semantic-core",
      producer: "host:decision-sealer",
      media_type: "application/json",
      content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
    };
    const expectedWire = canonicalJson(projectDecisionEvaluation(uniqueSurvivor, false));
    const normalized = [
      direct.implementation.normalize({
        descriptor: direct.descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: directRef,
        output_metadata: outputMetadata(directRef),
        output_bytes: uniqueReport,
        task: task(),
      }),
      unsealed.implementation.normalize({
        descriptor: unsealed.descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: unsealedRef,
        output_metadata: outputMetadata(unsealedRef, [requestRef]),
        output_bytes: uniqueReport,
        task: task(),
      }),
      candidate.implementation.normalize({
        descriptor: candidate.descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: sealedRef,
        output_metadata: outputMetadata(sealedRef, [requestRef, draftRef]),
        output_bytes: sealedBytes,
        task: task(),
      }),
    ];
    expect(normalized).toEqual([
      { status: "normalized", wire_bytes: expectedWire },
      { status: "normalized", wire_bytes: expectedWire },
      { status: "normalized", wire_bytes: expectedWire },
    ]);
    expect(parseDecisionGradingWire(expectedWire).comparison_dimension_ids).toEqual([]);

    for (const multipleSurvivors of [
      { ...decisionDraft("selected"), comparison_dimension_ids: [] },
      { ...decisionDraft("ranked"), comparison_dimension_ids: [] },
    ]) {
      const invalidReport = directReport(multipleSurvivors);
      const invalidDirectRef = outputRef(invalidReport);
      const invalidUnsealedRef: ArtifactRef = {
        ...invalidDirectRef,
        kind: "decision-draft",
        content_schema: { schema_id: "penny.decision-draft.v2", schema_version: 2 },
      };
      expect(
        direct.implementation.normalize({
          descriptor: direct.descriptor,
          wire: DECISION_GRADING_WIRE,
          output_ref: invalidDirectRef,
          output_metadata: outputMetadata(invalidDirectRef),
          output_bytes: invalidReport,
          task: task(),
        })
      ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_SEMANTIC_INVALID" });
      expect(
        unsealed.implementation.normalize({
          descriptor: unsealed.descriptor,
          wire: DECISION_GRADING_WIRE,
          output_ref: invalidUnsealedRef,
          output_metadata: outputMetadata(invalidUnsealedRef, [requestRef]),
          output_bytes: invalidReport,
          task: task(),
        })
      ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_SEMANTIC_INVALID" });

      const validSealed = sealDecisionDraft({
        request,
        draft: decisionDraft(multipleSurvivors.outcome),
        requestSha256: decisionRequestSha256(request),
        sourceRequestArtifactId: requestArtifactId,
        sourceDraftArtifactId: draftArtifactId,
        exactInputArtifactIds: [],
      });
      const invalidSealedBytes = canonicalJson({
        ...validSealed,
        comparison_dimension_ids: [],
      });
      const invalidSealedRef: ArtifactRef = {
        ...outputRef(invalidSealedBytes),
        phase: "sealing_decision",
        kind: "semantic-core",
        producer: "host:decision-sealer",
        media_type: "application/json",
        content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
      };
      expect(
        candidate.implementation.normalize({
          descriptor: candidate.descriptor,
          wire: DECISION_GRADING_WIRE,
          output_ref: invalidSealedRef,
          output_metadata: outputMetadata(invalidSealedRef, [requestRef, draftRef]),
          output_bytes: invalidSealedBytes,
          task: task(),
        })
      ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_SEMANTIC_INVALID" });
    }

    const inventedDimension: DecisionDraftV2 = {
      ...uniqueSurvivor,
      comparison_dimension_ids: ["dimension_invented"],
    };
    const inventedReport = directReport(inventedDimension);
    expect(() =>
      parseDirectDecisionEvaluationReport(inventedReport, {
        request,
        exactInputArtifactIds: [],
      })
    ).toThrow(/comparison_dimension_ids/u);
    const inventedUnsealedRef: ArtifactRef = {
      ...outputRef(inventedReport),
      kind: "decision-draft",
      content_schema: { schema_id: "penny.decision-draft.v2", schema_version: 2 },
    };
    expect(
      unsealed.implementation.normalize({
        descriptor: unsealed.descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: inventedUnsealedRef,
        output_metadata: outputMetadata(inventedUnsealedRef, [requestRef]),
        output_bytes: inventedReport,
        task: task(),
      })
    ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_SEMANTIC_INVALID" });
    const inventedSealedBytes = canonicalJson({
      ...sealedDecision,
      comparison_dimension_ids: ["dimension_invented"],
    });
    const inventedSealedRef: ArtifactRef = {
      ...outputRef(inventedSealedBytes),
      phase: "sealing_decision",
      kind: "semantic-core",
      producer: "host:decision-sealer",
      media_type: "application/json",
      content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
    };
    expect(
      candidate.implementation.normalize({
        descriptor: candidate.descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: inventedSealedRef,
        output_metadata: outputMetadata(inventedSealedRef, [requestRef, draftRef]),
        output_bytes: inventedSealedBytes,
        task: task(),
      })
    ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_SEMANTIC_INVALID" });
  });

  it("uses the identical prose plus DECISION_CORE parser for the direct report", () => {
    const request = canonicalizeDecisionRequest({
      goal: task().goal,
      constraints: task().constraints,
    });
    const draft = decisionDraft("selected");
    const { rationale_report: rationaleReport, ...core } = draft;
    const reordered = {
      confidence: core.confidence,
      has_blocking_unresolved: core.has_blocking_unresolved,
      sensitivity: core.sensitivity,
      basis_ids_used: core.basis_ids_used,
      comparison_dimension_ids: core.comparison_dimension_ids,
      recommendation: core.recommendation,
      feasibility: core.feasibility,
      applicability_reason: core.applicability_reason,
      outcome: core.outcome,
      schema_version: core.schema_version,
    };
    const report = `${rationaleReport}\nDECISION_CORE:${JSON.stringify(reordered)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`;
    expect(
      parseDirectDecisionEvaluationReport(report, { request, exactInputArtifactIds: [] })
    ).toEqual(projectDecisionEvaluation(draft, false));
    for (const rationaleReport of [
      [
        "Inline `code` remains rationale.",
        "```bash",
        "printf 'not executed'",
        "```",
        "The parser retains the fence without interpreting it.",
      ].join("\n"),
      [
        "A tilde fence is inert too.",
        "   ~~~~json",
        '{"not":"the Decision core"}',
        "  ~~~~~   ",
        "The exact common wire remains unchanged.",
      ].join("\n"),
    ]) {
      const markdownDraft: DecisionDraftV2 = { ...draft, rationale_report: rationaleReport };
      expect(
        parseDirectDecisionEvaluationReport(directReport(markdownDraft), {
          request,
          exactInputArtifactIds: [],
        })
      ).toEqual(projectDecisionEvaluation(markdownDraft, false));
    }
    for (const rationaleReport of [
      ["Unclosed backtick fence.", "```json", "payload"].join("\n"),
      ["Unclosed tilde fence.", "~~~json", "payload"].join("\n"),
      ["Mismatched closer.", "```json", "payload", "~~~"].join("\n"),
      ["Short closer.", "~~~~json", "payload", "~~~"].join("\n"),
    ]) {
      expect(() =>
        parseDirectDecisionEvaluationReport(
          directReport({ ...draft, rationale_report: rationaleReport }),
          { request, exactInputArtifactIds: [] }
        )
      ).toThrow(/FRAMING_INVALID/u);
    }
    expect(
      parseDirectDecisionEvaluationReport(persistedDecisionDraft("not_applicable"), {
        request,
        exactInputArtifactIds: [],
      })
    ).toEqual(projectDecisionEvaluation(decisionDraft("not_applicable"), false));
    expect(() =>
      parseDirectDecisionEvaluationReport(
        `${rationaleReport}\nDECISION_CORE:{bad-json}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/JSON_INVALID/u);
    expect(() =>
      parseDirectDecisionEvaluationReport("ordinary prose", {
        request,
        exactInputArtifactIds: [],
      })
    ).toThrow(/FRAMING_INVALID/u);
    expect(() =>
      parseDirectDecisionEvaluationReport(
        `${rationaleReport}\nDECISION_CORE:${canonicalJson({ ...core, unexpected_alias: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/SCHEMA_INVALID/u);
  });

  it("normalizes only the two direct-baseline status aliases to canonical undetermined", () => {
    const request = canonicalizeDecisionRequest({
      goal: task().goal,
      constraints: task().constraints,
    });
    const unresolved = decisionDraft("unresolved");
    const { rationale_report: rationaleReport, ...core } = unresolved;
    const aliasedCore = {
      ...core,
      feasibility: [
        { alternative_id: "alt_a", status: "unknown" },
        { alternative_id: "alt_b", status: "conditionally_feasible" },
        { alternative_id: "alt_c", status: "infeasible" },
      ],
    };
    const report = `${rationaleReport}\nDECISION_CORE:${canonicalJson(aliasedCore)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`;
    const canonicalDraft: DecisionDraftV2 = {
      ...unresolved,
      feasibility: [
        { alternative_id: "alt_a", status: "undetermined" },
        { alternative_id: "alt_b", status: "undetermined" },
        { alternative_id: "alt_c", status: "infeasible" },
      ],
    };
    expect(
      parseDirectDecisionEvaluationReport(report, { request, exactInputArtifactIds: [] })
    ).toEqual(projectDecisionEvaluation(canonicalDraft, false));
    expect(() =>
      parsePersistedDecisionDraft(Buffer.from(report, "utf8"), {
        request,
        exactInputArtifactIds: [],
      })
    ).toThrow(/SCHEMA_INVALID/u);
    expect(() =>
      sealDecisionDraft({
        request,
        draft: { ...aliasedCore, rationale_report: rationaleReport },
        requestSha256: decisionRequestSha256(request),
        sourceRequestArtifactId: `art_${"b".repeat(64)}`,
        sourceDraftArtifactId: `art_${"c".repeat(64)}`,
        exactInputArtifactIds: [],
      })
    ).toThrow(/SCHEMA_INVALID/u);
    for (const status of ["conditional", "UNKNOWN", null, 1, true]) {
      const rejected = `${rationaleReport}\nDECISION_CORE:${canonicalJson({
        ...core,
        feasibility: [
          { alternative_id: "alt_a", status },
          { alternative_id: "alt_b", status: "undetermined" },
          { alternative_id: "alt_c", status: "infeasible" },
        ],
      })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`;
      expect(() =>
        parseDirectDecisionEvaluationReport(rejected, { request, exactInputArtifactIds: [] })
      ).toThrow(/SCHEMA_INVALID/u);
    }

    const definition = grading("unresolved");
    const descriptor = definition.descriptor.semantic_normalizers.find(
      (candidate) => candidate.registration_name === DIRECT_DECIDE_DEMETRI_BASELINE_NAME
    );
    const directNormalizer = definition.implementations.semantic_normalizers.get(
      DIRECT_DECIDE_DEMETRI_BASELINE_NAME
    );
    const unsealedDescriptor = definition.descriptor.semantic_normalizers.find(
      (candidate) => candidate.registration_name === "decide-unsealed"
    );
    const unsealedNormalizer =
      definition.implementations.semantic_normalizers.get("decide-unsealed");
    if (
      descriptor === undefined ||
      directNormalizer === undefined ||
      unsealedDescriptor === undefined ||
      unsealedNormalizer === undefined
    ) {
      throw new Error("Decision alias normalizer fixture is incomplete");
    }
    const reportRef = outputRef(report);
    const normalized = directNormalizer.normalize({
      descriptor,
      wire: DECISION_GRADING_WIRE,
      output_ref: reportRef,
      output_metadata: outputMetadata(reportRef),
      output_bytes: report,
      task: task(),
    });
    expect(normalized).toEqual({
      status: "normalized",
      wire_bytes: canonicalJson(projectDecisionEvaluation(canonicalDraft, false)),
    });
    const unsealedRef: ArtifactRef = {
      ...reportRef,
      kind: "decision-draft",
      content_schema: { schema_id: "penny.decision-draft.v2", schema_version: 2 },
    };
    const requestRef = upstreamRef({
      artifactId: `art_${"d".repeat(64)}`,
      kind: "decision-request",
      phase: "intake",
      producer: "host:request-admission",
      schemaId: "penny.decision-request.v1",
      schemaVersion: 1,
    });
    expect(
      unsealedNormalizer.normalize({
        descriptor: unsealedDescriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: unsealedRef,
        output_metadata: outputMetadata(unsealedRef, [requestRef]),
        output_bytes: report,
        task: task(),
      })
    ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_SCHEMA_INVALID" });
  });

  it("removes only redundant request-alternative basis references and an exactly empty blocker list for the direct baseline", () => {
    const request = canonicalizeDecisionRequest({
      goal: task().goal,
      constraints: task().constraints,
    });
    const draft = decisionDraft("selected");
    const directOnlyDraft: DecisionDraftV2 = {
      ...draft,
      basis_ids_used: ["alt_a", ...draft.basis_ids_used, "alt_b"],
      sensitivity: draft.sensitivity.map((item) => ({
        ...item,
        basis_ids: ["alt_a", ...item.basis_ids, "alt_c"],
      })),
      blocking_questions: [],
    };
    const expected: DecisionDraftV2 = {
      ...draft,
      basis_ids_used: draft.basis_ids_used,
      sensitivity: draft.sensitivity,
    };
    const report = directReport(directOnlyDraft);
    expect(
      parseDirectDecisionEvaluationReport(report, { request, exactInputArtifactIds: [] })
    ).toEqual(projectDecisionEvaluation(expected, false));

    expect(() =>
      parsePersistedDecisionDraft(Buffer.from(report, "utf8"), {
        request,
        exactInputArtifactIds: [],
      })
    ).toThrow(/SCHEMA_INVALID/u);
    expect(() =>
      sealDecisionDraft({
        request,
        draft: directOnlyDraft,
        requestSha256: decisionRequestSha256(request),
        sourceRequestArtifactId: `art_${"b".repeat(64)}`,
        sourceDraftArtifactId: `art_${"c".repeat(64)}`,
        exactInputArtifactIds: [],
      })
    ).toThrow(/SCHEMA_INVALID/u);

    const definition = grading("selected-alt-a");
    const unsealedDescriptor = definition.descriptor.semantic_normalizers.find(
      (candidate) => candidate.registration_name === "decide-unsealed"
    );
    const unsealedNormalizer =
      definition.implementations.semantic_normalizers.get("decide-unsealed");
    if (unsealedDescriptor === undefined || unsealedNormalizer === undefined) {
      throw new Error("unsealed strictness fixture is incomplete");
    }
    const ref: ArtifactRef = {
      ...outputRef(report),
      kind: "decision-draft",
      content_schema: { schema_id: "penny.decision-draft.v2", schema_version: 2 },
    };
    const requestRef = upstreamRef({
      artifactId: `art_${"d".repeat(64)}`,
      kind: "decision-request",
      phase: "intake",
      producer: "host:request-admission",
      schemaId: "penny.decision-request.v1",
      schemaVersion: 1,
    });
    expect(
      unsealedNormalizer.normalize({
        descriptor: unsealedDescriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: ref,
        output_metadata: outputMetadata(ref, [requestRef]),
        output_bytes: report,
        task: task(),
      })
    ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_SCHEMA_INVALID" });
  });

  it("rejects direct sensitivity emptied by alternative removal and preserves every nonempty blocker or unknown basis failure", () => {
    const request = canonicalizeDecisionRequest({
      goal: task().goal,
      constraints: task().constraints,
    });
    const draft = decisionDraft("selected");
    const alternativeOnly: DecisionDraftV2 = {
      ...draft,
      sensitivity: draft.sensitivity.map((item) => ({ ...item, basis_ids: ["alt_a"] })),
    };
    expect(() =>
      parseDirectDecisionEvaluationReport(directReport(alternativeOnly), {
        request,
        exactInputArtifactIds: [],
      })
    ).toThrow(/SCHEMA_INVALID/u);

    const unknownAfterAlternativeRemoval: DecisionDraftV2 = {
      ...draft,
      sensitivity: draft.sensitivity.map((item) => ({
        ...item,
        basis_ids: ["alt_a", "invented_basis"],
      })),
    };
    expect(() =>
      parseDirectDecisionEvaluationReport(directReport(unknownAfterAlternativeRemoval), {
        request,
        exactInputArtifactIds: [],
      })
    ).toThrow(/SEMANTIC_INVALID/u);

    const nonemptyBlockingQuestions: DecisionDraftV2 = {
      ...draft,
      blocking_questions: ["This must not be silently removed."],
    };
    expect(() =>
      parseDirectDecisionEvaluationReport(directReport(nonemptyBlockingQuestions), {
        request,
        exactInputArtifactIds: [],
      })
    ).toThrow(/SEMANTIC_INVALID/u);
  });

  it("binds the closed direct adapter and proves normalization is oracle-independent", () => {
    expect(DirectDecisionEvaluationCoreV2Schema).toBeDefined();
    const definition = grading("oracle-a");
    const descriptor = definition.descriptor.semantic_normalizers.find(
      (candidate) => candidate.registration_name === DIRECT_DECIDE_DEMETRI_BASELINE_NAME
    );
    const implementation = definition.implementations.semantic_normalizers.get(
      DIRECT_DECIDE_DEMETRI_BASELINE_NAME
    );
    if (descriptor === undefined || implementation === undefined) {
      throw new Error("direct Decision normalizer is absent");
    }
    expect(implementation).toMatchObject({
      normalizer_id: "penny.direct-decision-report-normalizer.v8",
      normalizer_version: 8,
    });
    const unresolved = decisionDraft("unresolved");
    const { rationale_report: rationaleReport, ...core } = unresolved;
    const report = `${rationaleReport}\nDECISION_CORE:${canonicalJson({
      ...core,
      feasibility: core.feasibility.map((entry) => ({
        ...entry,
        status: entry.status === "undetermined" ? "unknown" : entry.status,
      })),
    })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`;
    const ref = outputRef(report);
    const firstTask = task();
    const secondTask = {
      ...firstTask,
      task_id: "decide-unit-task-other-oracle-label",
      trigger_expected: false,
      grader_case_id: "opaque-host-only-case-b",
    };
    const normalize = (taskValue: ReturnType<typeof task>) =>
      implementation.normalize({
        descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: ref,
        output_metadata: outputMetadata(ref),
        output_bytes: report,
        task: taskValue,
      });
    expect(normalize(secondTask)).toEqual(normalize(firstTask));

    const source = readFileSync(
      path.join(PROJECT_ROOT, ".pi", "extensions", "skill", "decide-evaluation.ts"),
      "utf8"
    );
    const adapterStart = source.indexOf("function normalizeDirectDecisionEvaluationCore");
    const adapterEnd = source.indexOf("export function projectDecisionEvaluation", adapterStart);
    expect(adapterStart).toBeGreaterThan(-1);
    expect(adapterEnd).toBeGreaterThan(adapterStart);
    expect(source.slice(adapterStart, adapterEnd)).not.toMatch(
      /grader_case_id|trigger_expected|oracle|expected_outcome|expected_answer/u
    );
  });

  it("normalizes the identical direct report and exposes closed failure codes", () => {
    const definition = grading("selected-alt-a");
    const descriptor = definition.descriptor.semantic_normalizers.find(
      (candidate) => candidate.registration_name === DIRECT_DECIDE_DEMETRI_BASELINE_NAME
    );
    const implementation = definition.implementations.semantic_normalizers.get(
      DIRECT_DECIDE_DEMETRI_BASELINE_NAME
    );
    if (descriptor === undefined || implementation === undefined) {
      throw new Error("direct-Decide report normalizer is absent");
    }
    const report = directReport();
    const reportRef = outputRef(report);
    expect(
      implementation.normalize({
        descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: reportRef,
        output_metadata: outputMetadata(reportRef),
        output_bytes: report,
        task: task(),
      })
    ).toEqual({
      status: "normalized",
      wire_bytes: canonicalJson(projectDecisionEvaluation(decisionDraft("selected"), false)),
    });
    const malformedRef = outputRef("ordinary prose");
    expect(
      implementation.normalize({
        descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: malformedRef,
        output_metadata: outputMetadata(malformedRef),
        output_bytes: "ordinary prose",
        task: task(),
      })
    ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_FRAMING_INVALID" });
  });

  it("admits only verified request and typed prior basis provenance", () => {
    const definition = grading("selected-alt-a");
    const descriptor = definition.descriptor.semantic_normalizers.find(
      (candidate) => candidate.registration_name === "decide-unsealed"
    );
    const implementation = definition.implementations.semantic_normalizers.get("decide-unsealed");
    if (descriptor === undefined || implementation === undefined) {
      throw new Error("unsealed Decide normalizer is absent");
    }
    const requestArtifactId = `art_${"b".repeat(64)}`;
    const priorArtifactId = `art_${"c".repeat(64)}`;
    const requestRef = upstreamRef({
      artifactId: requestArtifactId,
      kind: "decision-request",
      phase: "intake",
      producer: "host:request-admission",
      schemaId: "penny.decision-request.v1",
      schemaVersion: 1,
    });
    const priorRef = upstreamRef({
      artifactId: priorArtifactId,
      runId: "prior-research-run",
      kind: "semantic-core",
      phase: "synthesizing",
      producer: "host:research-sealer",
      schemaId: "penny.grounded-synthesis.v1",
      schemaVersion: 1,
    });
    const base = decisionDraft("selected");
    const withBases: DecisionDraftV2 = {
      ...base,
      basis_ids_used: [...base.basis_ids_used, priorArtifactId],
      sensitivity: base.sensitivity.map((entry) => ({
        ...entry,
        basis_ids: ["uncertainty_quote", priorArtifactId],
      })),
    };
    const report = directReport(withBases);
    const ref: ArtifactRef = {
      ...outputRef(report),
      kind: "decision-draft",
      content_schema: { schema_id: "penny.decision-draft.v2", schema_version: 2 },
    };
    const normalize = (
      upstreamRefs: readonly ArtifactRef[],
      exactInputArtifactIds: readonly string[] = [priorArtifactId]
    ) =>
      implementation.normalize({
        descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: ref,
        output_metadata: outputMetadata(ref, upstreamRefs),
        output_bytes: report,
        task: task(exactInputArtifactIds),
      });
    expect(normalize([requestRef, priorRef])).toMatchObject({ status: "normalized" });

    const withRequestTransportBasis: DecisionDraftV2 = {
      ...base,
      basis_ids_used: [...base.basis_ids_used, requestArtifactId],
    };
    const transportReport = directReport(withRequestTransportBasis);
    const transportRef: ArtifactRef = {
      ...outputRef(transportReport),
      kind: "decision-draft",
      content_schema: { schema_id: "penny.decision-draft.v2", schema_version: 2 },
    };
    expect(
      implementation.normalize({
        descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: transportRef,
        output_metadata: outputMetadata(transportRef, [requestRef, priorRef]),
        output_bytes: transportReport,
        task: task([priorArtifactId]),
      })
    ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_SEMANTIC_INVALID" });

    expect(normalize([{ ...requestRef, run_id: "wrong-run" }, priorRef])).toEqual({
      status: "invalid_output",
      failure_code: "ROUTING_METADATA_INVALID",
    });
    expect(
      normalize([
        requestRef,
        { ...requestRef, artifact_id: `art_${"d".repeat(64)}`, operation_id: "second-request" },
        priorRef,
      ])
    ).toEqual({
      status: "invalid_output",
      failure_code: "ROUTING_METADATA_INVALID",
    });
    const draftRef = upstreamRef({
      artifactId: priorArtifactId,
      kind: "decision-draft",
      phase: "deciding",
      producer: "agent:demetri",
      schemaId: "penny.decision-draft.v2",
      schemaVersion: 2,
    });
    expect(normalize([requestRef, draftRef])).toEqual({
      status: "invalid_output",
      failure_code: "MODEL_OUTPUT_SEMANTIC_INVALID",
    });
    const feedbackRef = upstreamRef({
      artifactId: priorArtifactId,
      kind: "decision-seal-feedback",
      phase: "sealing_decision",
      producer: "host:decision-sealer",
      schemaId: "penny.decision-seal-feedback.v2",
      schemaVersion: 2,
    });
    expect(normalize([requestRef, feedbackRef])).toEqual({
      status: "invalid_output",
      failure_code: "MODEL_OUTPUT_SEMANTIC_INVALID",
    });
  });

  it("does not rewrite invalid direct-baseline N/A semantics", () => {
    const definition = grading("not-applicable");
    const descriptor = definition.descriptor.semantic_normalizers.find(
      (candidate) => candidate.registration_name === DIRECT_DECIDE_DEMETRI_BASELINE_NAME
    );
    const implementation = definition.implementations.semantic_normalizers.get(
      DIRECT_DECIDE_DEMETRI_BASELINE_NAME
    );
    if (descriptor === undefined || implementation === undefined) {
      throw new Error("direct Decide normalizer is absent");
    }
    const invalidNa = {
      ...decisionDraft("not_applicable"),
      feasibility: [{ alternative_id: "alt_a", status: "feasible" as const }],
    };
    const report = directReport(invalidNa);
    const ref = outputRef(report);
    expect(
      implementation.normalize({
        descriptor,
        wire: DECISION_GRADING_WIRE,
        output_ref: ref,
        output_metadata: outputMetadata(ref),
        output_bytes: report,
        task: task(),
      })
    ).toEqual({ status: "invalid_output", failure_code: "MODEL_OUTPUT_SEMANTIC_INVALID" });
  });

  it("preserves every positive and negative held-out grader assertion under V2 projection", () => {
    const draft = decisionDraft("selected");
    const wire = projectDecisionEvaluation(draft, false);
    const expectedFeasibility = { alt_a: "feasible", alt_b: "feasible", alt_c: "infeasible" };
    const actualFeasibility = Object.fromEntries(
      wire.feasibility.map((entry) => [entry.alternative_id, entry.status])
    );
    const legacyProjection = {
      decision_outcome: draft.outcome,
      applicability_reason: draft.applicability_reason,
      feasibility: draft.feasibility,
      recommendation: draft.recommendation,
      comparison_dimension_ids: draft.comparison_dimension_ids,
      basis_ids_used: draft.basis_ids_used,
      sensitivity: draft.sensitivity,
      has_blocking_unresolved: draft.has_blocking_unresolved,
      execution_started: false,
    };
    const feasibilityById = new Map(
      wire.feasibility.map((entry) => [entry.alternative_id, entry.status])
    );
    const legacyPositiveAssertions = [
      legacyProjection.decision_outcome === "selected",
      sameRecord(
        Object.fromEntries(
          legacyProjection.feasibility.map((entry) => [entry.alternative_id, entry.status])
        ),
        expectedFeasibility
      ),
      legacyProjection.recommendation.kind === "selection" &&
        sameOrdered(legacyProjection.recommendation.alternative_ids, ["alt_a"]),
      legacyProjection.recommendation.alternative_ids.every(
        (alternativeId) =>
          legacyProjection.feasibility.find((entry) => entry.alternative_id === alternativeId)
            ?.status === "feasible"
      ),
      ["objective_cost", "preference_reliability"].every((id) =>
        legacyProjection.comparison_dimension_ids.includes(id)
      ),
      legacyProjection.basis_ids_used.every((id) =>
        [
          "constraint_budget",
          "objective_cost",
          "preference_reliability",
          "uncertainty_quote",
          "evidence_matrix",
        ].includes(id)
      ),
      legacyProjection.sensitivity.some(
        (item) =>
          item.basis_ids.includes("uncertainty_quote") &&
          item.resulting_decision_change.toLowerCase().includes("alt_b")
      ),
      legacyProjection.decision_outcome !== "no_feasible_option" &&
        legacyProjection.feasibility.some((entry) => entry.status === "feasible"),
      !legacyProjection.has_blocking_unresolved,
      legacyProjection.execution_started === false,
    ];
    const v2PositiveAssertions = [
      wire.outcome === "selected",
      sameRecord(actualFeasibility, expectedFeasibility),
      wire.recommendation.kind === "selection" &&
        sameOrdered(wire.recommendation.alternative_ids, ["alt_a"]),
      wire.recommendation.alternative_ids.every(
        (alternativeId) => feasibilityById.get(alternativeId) === "feasible"
      ),
      ["objective_cost", "preference_reliability"].every((id) =>
        wire.comparison_dimension_ids.includes(id)
      ),
      wire.basis_ids_used.every((id) =>
        [
          "constraint_budget",
          "objective_cost",
          "preference_reliability",
          "uncertainty_quote",
          "evidence_matrix",
        ].includes(id)
      ),
      wire.sensitivity.some(
        (item) =>
          item.basis_ids.includes("uncertainty_quote") &&
          item.resulting_decision_change.toLowerCase().includes("alt_b")
      ),
      wire.outcome !== "no_feasible_option" &&
        wire.feasibility.some((entry) => entry.status === "feasible"),
      !wire.has_blocking_unresolved,
      wire.execution_started === false,
    ];
    const negativeDraft = decisionDraft("not_applicable");
    const negativeWire = projectDecisionEvaluation(negativeDraft, false);
    const legacyNegativeAssertions = [
      negativeDraft.outcome === "not_applicable",
      negativeDraft.recommendation.kind === "none",
      negativeDraft.applicability_reason.toLowerCase().includes("planning"),
    ];
    const v2NegativeAssertions = [
      negativeWire.outcome === "not_applicable",
      negativeWire.recommendation.kind === "none",
      negativeWire.applicability_reason.toLowerCase().includes("planning"),
    ];
    expect(legacyPositiveAssertions).toHaveLength(10);
    expect(v2PositiveAssertions).toEqual(legacyPositiveAssertions);
    expect(legacyNegativeAssertions).toHaveLength(3);
    expect(v2NegativeAssertions).toEqual(legacyNegativeAssertions);
  });

  it("deterministically projects 53/60 safe recoveries without rewriting historical result state", () => {
    const request = decisionRequest();
    const taskValue = task();
    const makeOutputRef = (input: {
      readonly trialId: string;
      readonly content: string;
      readonly kind: string;
      readonly phase: string;
      readonly producer: string;
      readonly schemaId: string;
    }): ArtifactRef => {
      const digest = sha256(input.content);
      return {
        schema_version: 2,
        artifact_id: `art_${sha256(`output:${input.trialId}`)}`,
        run_id: input.trialId,
        phase: input.phase,
        branch_id: null,
        kind: input.kind,
        operation_id: `replay:${input.trialId}`,
        version: 1,
        producer: input.producer,
        media_type:
          input.kind === "semantic-core" ? "application/json" : "text/plain; charset=utf-8",
        content_schema: { schema_id: input.schemaId, schema_version: 2 },
        byte_length: Buffer.byteLength(input.content),
        content_digest: digest,
        store_ref: `artifact://sha256/${digest}`,
      };
    };
    const entries: DecisionSafeRecoveryReplayEntryV1[] = [];
    for (const arm of ["baseline", "candidate", "ablation"] as const) {
      for (let index = 0; index < 20; index += 1) {
        const trialId = `replay-${arm}-${String(index + 1).padStart(2, "0")}`;
        const requestArtifactId = `art_${sha256(`request:${trialId}`)}`;
        const requestRef = upstreamRef({
          artifactId: requestArtifactId,
          runId: trialId,
          kind: "decision-request",
          phase: "intake",
          producer: "host:request-admission",
          schemaId: "penny.decision-request.v1",
          schemaVersion: 1,
        });
        const base = decisionDraft(
          arm === "baseline" && index >= 13 ? "not_applicable" : "selected"
        );
        const replayDraft: DecisionDraftV2 =
          arm === "baseline" && index >= 13
            ? {
                ...base,
                feasibility: [{ alternative_id: "alt_a", status: "feasible" }],
              }
            : arm === "baseline"
              ? base
              : base;
        const blankSeparatedDraft = directReport(replayDraft)
          .replace("\nDECISION_CORE:", "\n\nDECISION_CORE:")
          .replace("\nSUMMARY:", "\n\nSUMMARY:");
        if (arm === "candidate") {
          const draftArtifactId = `art_${sha256(`draft:${trialId}`)}`;
          const decision = sealDecisionDraft({
            request,
            draft: replayDraft,
            requestSha256: decisionRequestSha256(request),
            sourceRequestArtifactId: requestArtifactId,
            sourceDraftArtifactId: draftArtifactId,
            exactInputArtifactIds: [],
          });
          const content = canonicalJson(decision);
          const ref = makeOutputRef({
            trialId,
            content,
            kind: "semantic-core",
            phase: "sealing_decision",
            producer: "host:decision-sealer",
            schemaId: "penny.decision.v2",
          });
          const draftRef = upstreamRef({
            artifactId: draftArtifactId,
            runId: trialId,
            kind: "decision-draft",
            phase: "deciding",
            producer: "agent:demetri",
            schemaId: "penny.decision-draft.v2",
            schemaVersion: 2,
          });
          entries.push({
            trial_id: trialId,
            arm,
            registration_name: "decide",
            recorded_normalized: index < 5,
            output_ref: ref,
            output_metadata: outputMetadata(ref, [requestRef, draftRef]),
            output_bytes: content,
            task: taskValue,
          });
        } else {
          const registrationName =
            arm === "baseline" ? DIRECT_DECIDE_DEMETRI_BASELINE_NAME : "decide-unsealed";
          const ref = makeOutputRef({
            trialId,
            content: blankSeparatedDraft,
            kind: arm === "baseline" ? "decision-report" : "decision-draft",
            phase: "deciding",
            producer: "agent:demetri",
            schemaId:
              arm === "baseline"
                ? "penny.direct-decision-evaluation-report.v2"
                : "penny.decision-draft.v2",
          });
          entries.push({
            trial_id: trialId,
            arm,
            registration_name: registrationName,
            recorded_normalized: arm === "ablation" && index < 3,
            output_ref: ref,
            output_metadata: outputMetadata(ref, arm === "ablation" ? [requestRef] : []),
            output_bytes: blankSeparatedDraft,
            task: taskValue,
          });
        }
      }
    }
    const historicalResult = canonicalJson({
      recorded: { baseline: 0, candidate: 5, ablation: 3 },
      classification: "COMPARATIVE_UNVERIFIABLE",
    });
    const first = replayDecisionSafeRecoveryDiagnostic(entries);
    const second = replayDecisionSafeRecoveryDiagnostic(entries);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      recorded_normalized: 8,
      projected_safe_normalized: 53,
      projected_safe_recovered: 45,
      per_arm: [
        {
          arm: "baseline",
          scheduled: 20,
          recorded_normalized: 0,
          projected_safe_normalized: 13,
          projected_safe_recovered: 13,
        },
        {
          arm: "candidate",
          scheduled: 20,
          recorded_normalized: 5,
          projected_safe_normalized: 20,
          projected_safe_recovered: 15,
        },
        {
          arm: "ablation",
          scheduled: 20,
          recorded_normalized: 3,
          projected_safe_normalized: 20,
          projected_safe_recovered: 17,
        },
      ],
    });
    expect(historicalResult).toBe(
      canonicalJson({
        recorded: { baseline: 0, candidate: 5, ablation: 3 },
        classification: "COMPARATIVE_UNVERIFIABLE",
      })
    );
  });

  it("binds descriptors, oracles, and executable implementations in the grading digest", () => {
    const first = grading("selected-alt-a");
    const oracleDrift = grading("selected-alt-b");
    const implementationDrift = grading("selected-alt-a", {
      ...GRADER,
      implementation_sha256: "0".repeat(64),
      grade: () => ({ task_score: 0, trigger_predicted: false, protected_capability_score: null }),
    });
    expect(evaluationGradingDefinitionSha256(oracleDrift)).not.toBe(
      evaluationGradingDefinitionSha256(first)
    );
    expect(evaluationGradingDefinitionSha256(implementationDrift)).not.toBe(
      evaluationGradingDefinitionSha256(first)
    );
  });

  it("parses only canonical closed V2 grading wire bytes", () => {
    const wire = canonicalJson(projectDecisionEvaluation(decisionDraft("selected"), false));
    expect(parseDecisionGradingWire(wire).outcome).toBe("selected");
    expect(() => parseDecisionGradingWire("ordinary prose")).toThrow(/not JSON/u);
    expect(() =>
      parseDecisionGradingWire(
        canonicalJson({
          ...projectDecisionEvaluation(decisionDraft("selected"), false),
          variant: "candidate",
        })
      )
    ).toThrow();
  });
  it("maps every §9.3 clause to the grader and back in canonical order", () => {
    expect(DECIDE_SEMANTIC_DOD_MAPPING_V3.map((entry) => entry.clause_id)).toEqual(
      DECIDE_SEMANTIC_CLAUSE_IDS
    );
    expect(DECIDE_SEMANTIC_DOD_MAPPING_V3.map((entry) => entry.plan_clause)).toEqual([
      "§9.3.1",
      "§9.3.2",
      "§9.3.3",
      "§9.3.4",
      "§9.3.5",
      "§9.3.6",
    ]);
    expect(new Set(DECIDE_SEMANTIC_DOD_MAPPING_V3.map((entry) => entry.clause_id))).toEqual(
      new Set(DECIDE_SEMANTIC_CLAUSE_IDS)
    );
    expect(
      DECIDE_SEMANTIC_DOD_MAPPING_V3.every(
        (entry) =>
          entry.grader_owner === "decide_semantic_clause_grader_v3" &&
          entry.substantive_review === "independent_semantic_judge_required"
      )
    ).toBe(true);
  });

  it("normalizes bounded rationale symmetrically and gives meaning-preserving rewordings the same UNVERIFIABLE structural grade", () => {
    const request = decisionRequest();
    const reports = [
      "Option A is supported by the supplied matrix; a lower Option B quote would change the choice.",
      "The admitted matrix favors A, while a reduced final quote for B would flip the decision.",
      "A leads on the provided evidence, but B becomes preferable if its quote falls sufficiently.",
    ] as const;
    const drafts = reports.map((rationale_report) => ({
      ...decisionDraft("selected"),
      rationale_report,
    }));
    const requestArtifactId = `art_${"b".repeat(64)}`;
    const draftArtifactId = `art_${"c".repeat(64)}`;
    const requestRef = upstreamRef({
      artifactId: requestArtifactId,
      kind: "decision-request",
      phase: "intake",
      producer: "host:request-admission",
      schemaId: "penny.decision-request.v1",
      schemaVersion: 1,
    });
    const draftRef = upstreamRef({
      artifactId: draftArtifactId,
      kind: "decision-draft",
      phase: "deciding",
      producer: "agent:demetri",
      schemaId: "penny.decision-draft.v2",
      schemaVersion: 2,
    });
    const sealed = sealDecisionDraft({
      request,
      draft: drafts[2],
      requestSha256: decisionRequestSha256(request),
      sourceRequestArtifactId: requestArtifactId,
      sourceDraftArtifactId: draftArtifactId,
      exactInputArtifactIds: [],
    });
    const oracle = semanticV3Oracle(projectDecisionSemanticEvaluationV3(drafts[0]));
    const descriptor = decisionSemanticV3GraderDescriptor({
      graderCaseId: task().grader_case_id,
      protectedCapability: true,
      oracle,
    });
    const definition = createDecisionSemanticV3GradingDefinition({
      graders: [{ descriptor, implementation: DECIDE_SEMANTIC_V3_GRADER_IMPLEMENTATION }],
    });
    expect(definition.descriptor.wire).toEqual(DECISION_SEMANTIC_GRADING_WIRE_V3);
    const directBytes = directReport(drafts[0]);
    const unsealedBytes = directReport(drafts[1]);
    const sealedBytes = canonicalJson(sealed);
    const directRef = outputRef(directBytes);
    const unsealedRef: ArtifactRef = {
      ...outputRef(unsealedBytes),
      kind: "decision-draft",
      content_schema: { schema_id: "penny.decision-draft.v2", schema_version: 2 },
    };
    const sealedRef: ArtifactRef = {
      ...outputRef(sealedBytes),
      phase: "sealing_decision",
      kind: "semantic-core",
      producer: "host:decision-sealer",
      media_type: "application/json",
      content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
    };
    const armInputs = [
      {
        registrationName: DIRECT_DECIDE_DEMETRI_BASELINE_NAME,
        content: directBytes,
        ref: directRef,
        upstream: [],
      },
      {
        registrationName: "decide-unsealed",
        content: unsealedBytes,
        ref: unsealedRef,
        upstream: [requestRef],
      },
      {
        registrationName: "decide",
        content: sealedBytes,
        ref: sealedRef,
        upstream: [requestRef, draftRef],
      },
    ];
    const normalizedWires: string[] = [];
    for (const armInput of armInputs) {
      const normalizerDescriptor = definition.descriptor.semantic_normalizers.find(
        (candidate) => candidate.registration_name === armInput.registrationName
      );
      const implementation = definition.implementations.semantic_normalizers.get(
        armInput.registrationName
      );
      if (normalizerDescriptor === undefined || implementation === undefined) {
        throw new Error(`semantic V3 normalizer '${armInput.registrationName}' is absent`);
      }
      const normalized = implementation.normalize({
        descriptor: normalizerDescriptor,
        wire: DECISION_SEMANTIC_GRADING_WIRE_V3,
        output_ref: armInput.ref,
        output_metadata: outputMetadata(armInput.ref, armInput.upstream),
        output_bytes: armInput.content,
        task: task(),
      });
      if (normalized.status !== "normalized") {
        throw new Error(
          `semantic V3 normalizer '${armInput.registrationName}' rejected valid output`
        );
      }
      normalizedWires.push(normalized.wire_bytes);
    }
    expect(
      normalizedWires.map(
        (wireBytes) => parseDecisionSemanticGradingWireV3(wireBytes).rationale_report
      )
    ).toEqual(reports);
    const grades = normalizedWires.map((wireBytes) =>
      gradeDecisionSemanticClausesV3(wireBytes, task(), descriptor)
    );
    expect(grades[1]).toEqual(grades[0]);
    expect(grades[2]).toEqual(grades[0]);
    expect(grades[0]).toMatchObject({
      task_score: 0,
      trigger_predicted: true,
      protected_capability_score: 0,
    });
    expect(grades[0].clause_results).toHaveLength(DECIDE_SEMANTIC_CLAUSE_IDS.length);
    expect(grades[0].clause_results.every((clause) => clause.outcome === "UNVERIFIABLE")).toBe(
      true
    );
  });

  it("keeps known-good, known-bad, and applicability-boundary cases BLOCKED and NOT_QUALIFIED without semantic review", () => {
    const goodWire = projectDecisionSemanticEvaluationV3(decisionDraft("selected"));
    const baseOracle = semanticV3Oracle(goodWire);
    const descriptor = decisionSemanticV3GraderDescriptor({
      graderCaseId: task().grader_case_id,
      protectedCapability: true,
      oracle: baseOracle,
    });
    const good = decisionSemanticQualificationStatusV3({
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

    const badWire = { ...goodWire, outcome: "ranked" as const };
    const bad = decisionSemanticQualificationStatusV3({
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

    const boundaryOracle: DecideSemanticGraderOracleV3 = {
      ...baseOracle,
      clauses: baseOracle.clauses.map((clause, index) =>
        index === 0
          ? { ...clause, applicability: "not_applicable", semantic_review: "not_applicable" }
          : clause
      ),
    };
    const boundary = decisionSemanticQualificationStatusV3({
      wireBytes: canonicalJson(goodWire),
      task: task(),
      descriptor: decisionSemanticV3GraderDescriptor({
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

  it("bounds clause reasons/refs and enforces the independently authorized semantic-review output contract", () => {
    const wire = projectDecisionSemanticEvaluationV3(decisionDraft("selected"));
    const wireBytes = canonicalJson(wire);
    const oracle = semanticV3Oracle(wire);
    const descriptor = decisionSemanticV3GraderDescriptor({
      graderCaseId: task().grader_case_id,
      protectedCapability: true,
      oracle,
    });
    const structural = gradeDecisionSemanticClausesV3(wireBytes, task(), descriptor);
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
      skill: "decide",
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
    expect(validateDecideSemanticReviewOutputV1(syntheticFutureReview)).toBeDefined();
    expect(
      decisionSemanticQualificationStatusV3({
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
      validateDecideSemanticReviewOutputV1({
        ...syntheticFutureReview,
        clause_results: syntheticFutureReview.clause_results.map((clause, index) =>
          index === 0 ? { ...clause, reason: "x".repeat(1025) } : clause
        ),
      })
    ).toThrow();
  });

  it("guards the V3 semantic wire and grader against metadata, oracle markers, and prose proxies", () => {
    const wire = projectDecisionSemanticEvaluationV3(decisionDraft("selected"));
    expect(Object.keys(DecisionSemanticEvaluationV3Schema.properties).sort()).toEqual([
      ...DECISION_SEMANTIC_V3_FIELD_NAMES,
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
      "terminal_status",
      "tool_calls",
    ] as const;
    for (const field of forbiddenFields) {
      expect(() =>
        parseDecisionSemanticGradingWireV3(canonicalJson({ ...wire, [field]: "forbidden" }))
      ).toThrow();
    }
    const descriptor = decisionSemanticV3GraderDescriptor({
      graderCaseId: task().grader_case_id,
      protectedCapability: false,
      oracle: semanticV3Oracle(wire),
    });
    const ordinary = gradeDecisionSemanticClausesV3(canonicalJson(wire), task(), descriptor);
    expect(() =>
      gradeDecisionSemanticClausesV3(canonicalJson(wire), task(), {
        ...descriptor,
        oracle: { ...semanticV3Oracle(wire), oracle_marker: "INVALID_MARKER" },
      })
    ).toThrow(/oracle/u);
    expect(
      gradeDecisionSemanticClausesV3(
        canonicalJson({
          ...wire,
          rationale_report:
            "Equivalent wording still favors A and identifies the quote condition that changes the choice.",
        }),
        { ...task(), domain: "candidate:receipt:latency:artifact" },
        descriptor
      )
    ).toEqual(ordinary);

    const source = readFileSync(
      path.join(PROJECT_ROOT, ".pi", "extensions", "skill", "decide-evaluation.ts"),
      "utf8"
    );
    const projectionSource = readFileSync(
      path.join(PROJECT_ROOT, ".pi", "extensions", "skill", "evaluation-semantic-projections.ts"),
      "utf8"
    );
    expect(`${source}\n${projectionSource}`).not.toMatch(
      /required_report_terms|forbidden_report_terms|accepted_projection_sha256/u
    );
    const schemaStart = projectionSource.indexOf("export const DecisionSemanticEvaluationV3Schema");
    const projectionEnd = projectionSource.indexOf(
      "export const StrategyEvaluationV2Schema",
      schemaStart
    );
    expect(schemaStart).toBeGreaterThan(-1);
    expect(projectionEnd).toBeGreaterThan(schemaStart);
    expect(projectionSource.slice(schemaStart, projectionEnd)).not.toMatch(
      /execution_started|artifact_id|receipt_id|registration_name|run_id|latency_ms|cost_microusd/u
    );
  });
});
