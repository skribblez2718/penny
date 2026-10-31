import { describe, expect, it } from "vitest";

import {
  StrategyDraftValidationError,
  canonicalJson,
  canonicalizePlanRequest,
  parseStrategyDraftV2,
  planRequestSha256,
  sealStrategyV2,
  sha256,
  specificationStrategySourceItems,
  strategyDraftV2PromptContract,
  validateCanonicalStrategyV2Bytes,
  validateStrategyV2,
  validateStrategyDraftV2,
  type ArtifactRef,
  type StrategyCoreV2,
  type StrategyDraftV2,
} from "../dist/index.js";
import { genericSpecificationFixture } from "./fixtures/define-fixtures.js";

const SPECIFICATION_ARTIFACT_ID = `art_${"3".repeat(64)}`;
const PLAN_REQUEST_ARTIFACT_ID = `art_${"4".repeat(64)}`;
const PLAN_DRAFT_ARTIFACT_ID = `art_${"5".repeat(64)}`;

function fixture() {
  const definition = genericSpecificationFixture();
  const request = canonicalizePlanRequest({
    goal: "Plan the defined transition without execution.",
    constraints: {
      schema_version: 1,
      desired_outcomes: ["The defined transition is ready for safe planning."],
      current_state: { status: "provided", facts: ["The specification is available."] },
      hard_constraints: ["Do not execute the transition."],
      non_goals: ["Do not redesign unrelated services."],
      known_uncertainties: [],
      prior_decisions: [],
    },
    exactInputArtifactIds: [SPECIFICATION_ARTIFACT_ID],
  });
  const sourceItems = specificationStrategySourceItems(definition.specification);
  const requiredIndexes = sourceItems.flatMap((entry, index) => (entry.required ? [index] : []));
  const core: StrategyCoreV2 = {
    schema_version: 2,
    disposition: "ready",
    applicability_reason: "The ready specification supports a bounded planning strategy.",
    outcomes: [
      {
        statement: "Specification-defined transition readiness is established.",
        desired_outcome_indexes: [0],
        success_signal: "Every mandatory source item is represented and reviewable.",
      },
    ],
    dependencies: [],
    request_coverage: {
      current_state_fact_indexes: [0],
      input_artifact_slots: [0],
      hard_constraint_indexes: [0],
      non_goal_indexes: [0],
      uncertainty_indexes: [],
      prior_decision_indexes: [],
      blocked_desired_outcome_indexes: [],
    },
    blockers: [],
    confidence: "CERTAIN",
    source_item_coverage: requiredIndexes.map((sourceItemIndex) => ({
      source_item_index: sourceItemIndex,
      disposition: "addressed" as const,
      strategy_outcome_indexes: [0],
      rationale:
        "This required specification item is preserved by the transition-readiness outcome.",
    })),
    unsupported_strategy_elements: [],
  };
  const draft: StrategyDraftV2 = {
    strategy_report:
      "The strategy is bounded by the supplied specification. Every mandatory requirement, constraint, non-goal, and binding standard maps to the readiness outcome; no additional scope is introduced.",
    ...core,
  };
  const draftBytes = Buffer.from(
    `${draft.strategy_report}\nSTRATEGY_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`,
    "utf8"
  );
  const strategy = sealStrategyV2({
    request,
    draft,
    draftBytes,
    requestSha256: planRequestSha256(request),
    sourceRequestArtifactId: PLAN_REQUEST_ARTIFACT_ID,
    sourceDraftArtifactId: PLAN_DRAFT_ARTIFACT_ID,
    exactInputArtifactIds: [SPECIFICATION_ARTIFACT_ID],
    specification: definition.specification,
    specificationArtifactId: SPECIFICATION_ARTIFACT_ID,
  });
  const bytes = Buffer.from(canonicalJson(strategy), "utf8");
  const ref: ArtifactRef = {
    schema_version: 2,
    artifact_id: `art_${sha256(bytes)}`,
    run_id: "run-plan-v2-contract",
    phase: "sealing_strategy",
    branch_id: null,
    kind: "strategy",
    operation_id: "sealed-strategy",
    version: 1,
    producer: "host:strategy-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.strategy.v2", schema_version: 2 },
    byte_length: bytes.byteLength,
    content_digest: sha256(bytes),
    store_ref: `artifact://sha256/${sha256(bytes)}`,
  };
  return { ...definition, request, core, draft, draftBytes, strategy, bytes, ref, sourceItems };
}

describe("StrategyDraftV2 and StrategyV2 specification composition", () => {
  it("projects exact outcome and specification traceability rules into the model contract", () => {
    const contract = strategyDraftV2PromptContract();
    expect(contract).toContain(
      "each index exactly once across outcomes with an empty blocked list"
    );
    expect(contract).toContain("objectives and acceptance_criteria");
    expect(contract).toContain("source coverage or one derived-need rationale, never both");
    expect(contract).toContain("at most once in unsupported_strategy_elements");
  });

  it("seals complete forward and backward traceability to the exact SpecificationV1", () => {
    const value = fixture();
    expect(
      parseStrategyDraftV2(value.draftBytes, {
        request: value.request,
        specification: value.specification,
        specificationArtifactId: SPECIFICATION_ARTIFACT_ID,
      }).draft
    ).toEqual(value.draft);
    const strategy = validateCanonicalStrategyV2Bytes(value.bytes, value.ref, {
      specification: value.specification,
      specificationArtifactId: SPECIFICATION_ARTIFACT_ID,
      strictSourceValidation: true,
    });
    expect(strategy.schema_version).toBe(2);
    expect(strategy.source_item_coverage).toHaveLength(
      value.sourceItems.filter((entry) => entry.required).length
    );
    expect(new Set(strategy.source_item_coverage.map((entry) => entry.source_artifact_id))).toEqual(
      new Set([SPECIFICATION_ARTIFACT_ID])
    );
    expect(strategy.unsupported_strategy_elements).toEqual([]);
    expect(strategy.execution_started).toBe(false);
  });

  it("rejects missing mandatory coverage, fabricated standalone coverage, and uncovered strategy scope", () => {
    const value = fixture();
    const missing = {
      ...value.draft,
      source_item_coverage: value.draft.source_item_coverage.slice(1),
    };
    expect(() =>
      validateStrategyDraftV2(missing, {
        request: value.request,
        specification: value.specification,
        specificationArtifactId: SPECIFICATION_ARTIFACT_ID,
      })
    ).toThrow(StrategyDraftValidationError);

    const uncovered = {
      ...value.draft,
      source_item_coverage: value.draft.source_item_coverage.map((entry) => ({
        ...entry,
        strategy_outcome_indexes: [],
        disposition: "not_applicable" as const,
      })),
    };
    expect(() =>
      validateStrategyDraftV2(uncovered, {
        request: value.request,
        specification: value.specification,
        specificationArtifactId: SPECIFICATION_ARTIFACT_ID,
      })
    ).toThrow(/lacks source coverage or derived-need rationale/u);

    const doubleTraced = {
      ...value.draft,
      unsupported_strategy_elements: [
        {
          strategy_outcome_index: 0,
          statement: "A redundant derived traceability claim.",
          rationale: "This outcome already has source coverage and cannot use both bases.",
        },
      ],
    };
    expect(() =>
      validateStrategyDraftV2(doubleTraced, {
        request: value.request,
        specification: value.specification,
        specificationArtifactId: SPECIFICATION_ARTIFACT_ID,
      })
    ).toThrow(/cannot have both source coverage and a derived-need rationale/u);

    const standaloneRequest = canonicalizePlanRequest({
      goal: value.request.goal,
      constraints: {
        schema_version: 1,
        desired_outcomes: value.request.desired_outcomes,
        current_state: value.request.current_state,
        hard_constraints: value.request.hard_constraints,
        non_goals: value.request.non_goals,
        known_uncertainties: value.request.known_uncertainties,
        prior_decisions: value.request.prior_decisions,
      },
      exactInputArtifactIds: [],
    });
    const fabricatedStandalone = {
      ...value.draft,
      request_coverage: { ...value.draft.request_coverage, input_artifact_slots: [] },
    };
    expect(() =>
      validateStrategyDraftV2(fabricatedStandalone, { request: standaloneRequest })
    ).toThrow(/standalone StrategyDraftV2 cannot fabricate source item coverage/u);
  });

  it("rejects product tampering, wrong source identity, and a stale specification binding", () => {
    const value = fixture();
    const wrongSource = structuredClone(value.strategy);
    const firstCoverage = wrongSource.source_item_coverage[0];
    if (firstCoverage === undefined) throw new Error("V2 fixture has no source coverage");
    firstCoverage.source_artifact_id = `art_${"9".repeat(64)}`;
    expect(() =>
      validateStrategyV2(wrongSource, {
        specification: value.specification,
        specificationArtifactId: SPECIFICATION_ARTIFACT_ID,
        strictSourceValidation: true,
      })
    ).toThrow();

    expect(() =>
      sealStrategyV2({
        request: value.request,
        draft: value.draft,
        draftBytes: value.draftBytes,
        requestSha256: planRequestSha256(value.request),
        sourceRequestArtifactId: PLAN_REQUEST_ARTIFACT_ID,
        sourceDraftArtifactId: PLAN_DRAFT_ARTIFACT_ID,
        exactInputArtifactIds: [SPECIFICATION_ARTIFACT_ID],
        specification: value.specification,
        specificationArtifactId: `art_${"8".repeat(64)}`,
      })
    ).toThrow(/exact admitted source artifact/u);

    const noncanonical = Buffer.from(`${canonicalJson(value.strategy)}\n`, "utf8");
    expect(() => validateCanonicalStrategyV2Bytes(noncanonical)).toThrow(/not canonical JSON/u);
  });
});
