import { describe, expect, it } from "vitest";

import {
  StrategyDraftValidationError,
  canonicalJson,
  canonicalizePlanRequest,
  parseStrategyDraft,
  planRequestItemIds,
  planRequestSha256,
  projectStrategyDraft,
  sealStrategy,
  sha256,
  stablePlanId,
  validateCanonicalStrategyBytes,
  validatePlanRequest,
  validateStrategy,
  validateStrategyCore,
  validateStrategyDraft,
  type PlanRequestConstraintsV1,
  type StrategyCoreV1,
  type StrategyDraftV1,
} from "../src/index.js";

const ARTIFACT_A = `art_${"a".repeat(64)}`;
const ARTIFACT_B = `art_${"b".repeat(64)}`;
const ARTIFACT_C = `art_${"c".repeat(64)}`;
const REQUEST_ARTIFACT = `art_${"c".repeat(64)}`;
const DRAFT_ARTIFACT = `art_${"d".repeat(64)}`;

function constraints(): PlanRequestConstraintsV1 {
  return {
    schema_version: 1,
    desired_outcomes: ["A safe migration is ready.", "Rollback remains possible."],
    current_state: {
      status: "provided",
      facts: ["The old service is active.", "A staging environment exists."],
    },
    hard_constraints: ["Do not interrupt production."],
    non_goals: ["Do not redesign unrelated services."],
    known_uncertainties: [{ statement: "Peak traffic timing is uncertain.", material: true }],
    prior_decisions: [
      {
        statement: "Use the existing deployment platform.",
        binding_effect: "The strategy must remain on that platform.",
      },
    ],
  };
}

function request(inputIds: readonly string[] = []) {
  return canonicalizePlanRequest({
    goal: "Form a migration strategy without executing it.",
    constraints: constraints(),
    exactInputArtifactIds: inputIds,
  });
}

function coverage(inputCount = 0) {
  return {
    current_state_fact_indexes: [1, 0],
    input_artifact_slots: Array.from({ length: inputCount }, (_, index) => inputCount - index - 1),
    hard_constraint_indexes: [0],
    non_goal_indexes: [0],
    uncertainty_indexes: [0],
    prior_decision_indexes: [0],
    blocked_desired_outcome_indexes: [],
  };
}

function readyCore(inputCount = 0): StrategyCoreV1 {
  return {
    schema_version: 1,
    disposition: "ready",
    applicability_reason: "The goal is planning work with sufficient supplied context.",
    outcomes: [
      {
        statement: "Migration readiness is established.",
        desired_outcome_indexes: [0],
        success_signal: "The migration readiness criteria are demonstrably met.",
      },
      {
        statement: "Rollback remains viable.",
        desired_outcome_indexes: [1],
        success_signal: "A validated rollback path remains available.",
      },
    ],
    dependencies: [{ from_outcome_index: 0, to_outcome_index: 1, kind: "informational" }],
    request_coverage: coverage(inputCount),
    blockers: [],
    confidence: "PROBABLE",
  };
}

function outcomeAt(core: StrategyCoreV1, index: number): StrategyCoreV1["outcomes"][number] {
  const outcome = core.outcomes[index];
  if (outcome === undefined) throw new Error(`strategy outcome ${index} is absent`);
  return outcome;
}

function blockedCore(inputCount = 0): StrategyCoreV1 {
  const ready = readyCore(inputCount);
  return {
    ...ready,
    disposition: "blocked",
    outcomes: [outcomeAt(ready, 0)],
    dependencies: [],
    request_coverage: {
      ...coverage(inputCount),
      blocked_desired_outcome_indexes: [1],
    },
    blockers: ["Rollback validation cannot proceed without the missing access."],
    confidence: "POSSIBLE",
  };
}

function notApplicableCore(): StrategyCoreV1 {
  return {
    schema_version: 1,
    disposition: "not_applicable",
    applicability_reason: "The request is already achieved and needs no strategy.",
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

function persisted(core: StrategyCoreV1, report = "A bounded strategy report."): string {
  return `${report}\nSTRATEGY_CORE:${JSON.stringify(core)}\nSUMMARY:${JSON.stringify({ complete: true, confidence: core.confidence })}`;
}

function draft(core: StrategyCoreV1, report = "A bounded strategy report."): StrategyDraftV1 {
  return { strategy_report: report, ...core };
}

describe("PlanRequestV1, StrategyDraftV1, and StrategyV1", () => {
  it("derives stable request and item IDs from canonical values and exact sorted inputs", () => {
    const value = request([ARTIFACT_B, ARTIFACT_A]);
    expect(value.input_artifact_ids).toEqual([ARTIFACT_A, ARTIFACT_B]);
    const { request_id: ignored, ...seed } = value;
    void ignored;
    expect(value.request_id).toBe(stablePlanId("plan-request", seed));
    expect(value.request_id).toBe(`plan-request-${sha256(canonicalJson(seed))}`);
    const ids = planRequestItemIds(value);
    expect(ids.desired_outcome_ids[0]).toBe(
      stablePlanId("desired-outcome", value.desired_outcomes[0])
    );
    expect(ids.current_state_fact_ids[0]).toBe(
      stablePlanId(
        "current-state-fact",
        value.current_state.status === "provided" ? value.current_state.facts[0] : ""
      )
    );
    expect(planRequestSha256(value)).toBe(sha256(canonicalJson(value)));
  });

  it("rejects unknown request fields, duplicate members, and more than two exact inputs", () => {
    expect(() =>
      canonicalizePlanRequest({
        goal: "Plan safely.",
        constraints: { ...constraints(), unexpected: true },
        exactInputArtifactIds: [],
      })
    ).toThrow();
    expect(() =>
      canonicalizePlanRequest({
        goal: "Plan safely.",
        constraints: {
          ...constraints(),
          desired_outcomes: ["same", "same"],
        },
        exactInputArtifactIds: [],
      })
    ).toThrow(/unique/u);
    expect(() => request([ARTIFACT_A, ARTIFACT_B, ARTIFACT_C])).toThrow(/at most 2 exact inputs/u);
    const valid = request();
    expect(() => validatePlanRequest({ ...valid, request_id: "plan-request-wrong" })).toThrow(
      /request_id/u
    );
  });

  it.each([
    ["ready", readyCore()] as const,
    ["blocked", blockedCore()] as const,
    ["not_applicable", notApplicableCore()] as const,
  ])("accepts the complete %s semantic disposition", (_name, core) => {
    expect(validateStrategyCore(core, { request: request() })).toEqual(core);
    const parsed = parseStrategyDraft(Buffer.from(persisted(core), "utf8"), {
      request: request(),
    });
    expect(parsed.draft).toEqual(draft(core));
    expect(parsed.summary).toEqual({ complete: true, confidence: core.confidence });
  });

  it("accepts arbitrary JSON key order, legal whitespace, and reordered set arrays", () => {
    const canonicalCore = readyCore(2);
    const flexible: StrategyCoreV1 = {
      confidence: canonicalCore.confidence,
      blockers: canonicalCore.blockers,
      request_coverage: {
        ...canonicalCore.request_coverage,
        current_state_fact_indexes: [0, 1],
        input_artifact_slots: [0, 1],
      },
      dependencies: canonicalCore.dependencies,
      outcomes: canonicalCore.outcomes.map((outcome) => ({
        ...outcome,
        desired_outcome_indexes: [...outcome.desired_outcome_indexes].reverse(),
      })),
      applicability_reason: canonicalCore.applicability_reason,
      disposition: canonicalCore.disposition,
      schema_version: 1,
    };
    const report =
      "Exact report bytes are preserved.\n\nAssumptions and contingencies remain explicit.";
    const output = `${report}\nSTRATEGY_CORE: ${JSON.stringify(flexible, null, 0)} \nSUMMARY: { "complete": true, "confidence": "PROBABLE" }`;
    const parsed = parseStrategyDraft(Buffer.from(output, "utf8"), {
      request: request([ARTIFACT_B, ARTIFACT_A]),
    });
    expect(parsed.draft.strategy_report).toBe(report);
    expect(
      projectStrategyDraft(parsed.draft, { request: request([ARTIFACT_A, ARTIFACT_B]) })
    ).toEqual(
      projectStrategyDraft(draft(canonicalCore, report), {
        request: request([ARTIFACT_A, ARTIFACT_B]),
      })
    );
  });

  it("rejects a stale draft after a material request mutation and admits the matching draft", () => {
    const originalConstraints = constraints();
    const mutatedRequest = canonicalizePlanRequest({
      goal: "Form a migration strategy without executing it.",
      constraints: {
        ...originalConstraints,
        non_goals: [...originalConstraints.non_goals, "Do not change the data retention policy."],
      },
      exactInputArtifactIds: [],
    });
    const stale = draft(readyCore());
    expect(() => validateStrategyDraft(stale, { request: mutatedRequest })).toThrow(
      StrategyDraftValidationError
    );
    const matching: StrategyDraftV1 = {
      ...stale,
      request_coverage: {
        ...stale.request_coverage,
        non_goal_indexes: [0, 1],
      },
    };
    expect(validateStrategyDraft(matching, { request: mutatedRequest })).toEqual(matching);
  });

  it("collects independent semantic defects and rejects graph, disposition, and coverage mutations", () => {
    const malformed: StrategyCoreV1 = {
      ...readyCore(),
      outcomes: [
        { ...outcomeAt(readyCore(), 0), desired_outcome_indexes: [9] },
        outcomeAt(readyCore(), 1),
      ],
      dependencies: [
        { from_outcome_index: 0, to_outcome_index: 1, kind: "causal" },
        { from_outcome_index: 1, to_outcome_index: 0, kind: "causal" },
        { from_outcome_index: 4, to_outcome_index: 0, kind: "temporal" },
      ],
      request_coverage: {
        ...coverage(),
        hard_constraint_indexes: [],
      },
      blockers: ["A blocker is incompatible with ready."],
    };
    try {
      validateStrategyCore(malformed, { request: request() });
      throw new Error("malformed strategy unexpectedly validated");
    } catch (error) {
      expect(error).toBeInstanceOf(StrategyDraftValidationError);
      if (!(error instanceof StrategyDraftValidationError)) throw error;
      expect(error.failureClass).toBe("SEMANTIC_INVALID");
      expect(error.issues.join(" ")).toMatch(/out-of-range/u);
      expect(error.issues.join(" ")).toMatch(/acyclic/u);
      expect(error.issues.join(" ")).toMatch(/blockers/u);
      expect(error.issues.join(" ")).toMatch(/coverage/u);
    }
    expect(() =>
      validateStrategyCore(
        {
          ...blockedCore(),
          request_coverage: {
            ...blockedCore().request_coverage,
            blocked_desired_outcome_indexes: [],
          },
        },
        { request: request() }
      )
    ).toThrow(/blocked desired outcome/u);
    expect(() =>
      validateStrategyCore(
        { ...notApplicableCore(), outcomes: readyCore().outcomes },
        { request: request() }
      )
    ).toThrow(/not_applicable/u);
  });

  it("rejects framing, JSON, schema, confidence, and byte-boundary defects", () => {
    const core = readyCore();
    const vectors = [
      `ordinary prose\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `ordinary prose\nSTRATEGY_CORE:{bad}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `ordinary prose\nSTRATEGY_CORE:${JSON.stringify({ ...core, task_graph: [] })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `ordinary prose\nSTRATEGY_CORE:${JSON.stringify(core)}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`,
      `ordinary prose\r\nSTRATEGY_CORE:${JSON.stringify(core)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `ordinary prose\nSTRATEGY_CORE:${JSON.stringify(core)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}\ntrailing`,
    ];
    for (const value of vectors) {
      expect(() => parseStrategyDraft(Buffer.from(value, "utf8"), { request: request() })).toThrow(
        StrategyDraftValidationError
      );
    }
  });

  it("seals stable semantic IDs while preserving exact lineage and rejects every product tamper", () => {
    const requestValue = request([ARTIFACT_B, ARTIFACT_A]);
    const raw = persisted(readyCore(2), "The exact strategy report is retained.");
    const parsed = parseStrategyDraft(Buffer.from(raw), { request: requestValue });
    const strategy = sealStrategy({
      request: requestValue,
      draft: parsed.draft,
      draftBytes: Buffer.from(raw),
      requestSha256: planRequestSha256(requestValue),
      sourceRequestArtifactId: REQUEST_ARTIFACT,
      sourceDraftArtifactId: DRAFT_ARTIFACT,
      exactInputArtifactIds: [ARTIFACT_B, ARTIFACT_A],
    });
    const alternateLineage = sealStrategy({
      request: requestValue,
      draft: parsed.draft,
      draftBytes: Buffer.from(raw),
      requestSha256: planRequestSha256(requestValue),
      sourceRequestArtifactId: `art_${"e".repeat(64)}`,
      sourceDraftArtifactId: `art_${"f".repeat(64)}`,
      exactInputArtifactIds: [ARTIFACT_A, ARTIFACT_B],
    });
    expect(strategy.strategy_id).toBe(alternateLineage.strategy_id);
    expect(strategy.source_lineage).not.toEqual(alternateLineage.source_lineage);
    expect(strategy.execution_started).toBe(false);
    expect(strategy.strategy_report).toBe("The exact strategy report is retained.");
    expect(validateStrategy(strategy)).toEqual(strategy);
    expect(validateCanonicalStrategyBytes(Buffer.from(canonicalJson(strategy)))).toEqual(strategy);

    const mutations: unknown[] = [
      { ...strategy, strategy_id: stablePlanId("strategy", "drift") },
      { ...strategy, request_sha256: "0".repeat(64) },
      { ...strategy, execution_started: true },
      { ...strategy, task_graph: [] },
      {
        ...strategy,
        outcomes: strategy.outcomes.map((outcome, index) =>
          index === 0
            ? { ...outcome, outcome_id: stablePlanId("strategy-outcome", "drift") }
            : outcome
        ),
      },
      {
        ...strategy,
        source_lineage: { ...strategy.source_lineage, draft_sha256: "0".repeat(64) },
      },
    ];
    for (const mutation of mutations) expect(() => validateStrategy(mutation)).toThrow();
    expect(() =>
      validateCanonicalStrategyBytes(Buffer.from(`${canonicalJson(strategy)}\n`, "utf8"))
    ).toThrow(/canonical/u);
  });
});
