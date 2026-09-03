import {
  canonicalJson,
  type DecisionDraftV2,
  type DecisionRequestV1,
} from "../../src/index.js";

export function decisionRequest(): DecisionRequestV1 {
  return {
    schema_version: 1,
    decision_question: "Which supplied option should be selected?",
    alternatives: [
      {
        alternative_id: "alt_a",
        label: "Option A",
        description: "Feasible lower-cost option.",
      },
      {
        alternative_id: "alt_b",
        label: "Option B",
        description: "Feasible higher-cost option.",
      },
      {
        alternative_id: "alt_c",
        label: "Option C",
        description: "Option that exceeds the hard budget.",
      },
    ],
    hard_constraints: [
      { constraint_id: "constraint_budget", statement: "The option must stay under budget." },
    ],
    objectives: [
      { objective_id: "objective_cost", statement: "Prefer lower validated cost." },
    ],
    preferences: [
      {
        preference_id: "preference_reliability",
        statement: "Prefer stronger reliability when costs are close.",
      },
    ],
    uncertainties: [
      {
        uncertainty_id: "uncertainty_quote",
        statement: "Option B's final quote may fall.",
      },
    ],
    evidence: [
      {
        evidence_id: "evidence_matrix",
        statement: "The supplied matrix establishes feasibility and current cost.",
      },
    ],
  };
}

function feasibility(statuses: readonly [string, "feasible" | "infeasible" | "undetermined"][]) {
  return statuses.map(([alternative_id, status]) => ({ alternative_id, status }));
}

export function decisionDraft(outcome: DecisionDraftV2["outcome"] = "selected"): DecisionDraftV2 {
  const base = {
    rationale_report:
      "The supplied matrix establishes feasibility. Option A has the lower validated cost, while Option B may become preferable if its final quote falls.",
    schema_version: 2 as const,
    applicability_reason: "The caller requests a decision among supplied alternatives.",
    confidence: "PROBABLE" as const,
  };
  if (outcome === "selected") {
    return {
      ...base,
      outcome,
      feasibility: feasibility([
        ["alt_a", "feasible"],
        ["alt_b", "feasible"],
        ["alt_c", "infeasible"],
      ]),
      recommendation: { kind: "selection", alternative_ids: ["alt_a"] },
      comparison_dimension_ids: ["objective_cost", "preference_reliability"],
      basis_ids_used: [
        "evidence_matrix",
        "objective_cost",
        "preference_reliability",
        "uncertainty_quote",
      ],
      sensitivity: [
        {
          basis_ids: ["uncertainty_quote", "objective_cost"],
          resulting_decision_change: "Select alt_b instead of alt_a.",
        },
      ],
      has_blocking_unresolved: false,
    };
  }
  if (outcome === "ranked") {
    return {
      ...base,
      outcome,
      feasibility: feasibility([
        ["alt_a", "feasible"],
        ["alt_b", "feasible"],
        ["alt_c", "infeasible"],
      ]),
      recommendation: { kind: "ranking", alternative_ids: ["alt_a", "alt_b"] },
      comparison_dimension_ids: ["objective_cost", "preference_reliability"],
      basis_ids_used: [
        "evidence_matrix",
        "objective_cost",
        "preference_reliability",
        "uncertainty_quote",
      ],
      sensitivity: [
        {
          basis_ids: ["uncertainty_quote", "objective_cost"],
          resulting_decision_change: "Rank alt_b before alt_a.",
        },
      ],
      has_blocking_unresolved: false,
    };
  }
  if (outcome === "no_feasible_option") {
    return {
      ...base,
      rationale_report: "Every supplied alternative violates the hard budget constraint.",
      outcome,
      feasibility: feasibility([
        ["alt_a", "infeasible"],
        ["alt_b", "infeasible"],
        ["alt_c", "infeasible"],
      ]),
      recommendation: { kind: "none", alternative_ids: [] },
      comparison_dimension_ids: [],
      basis_ids_used: ["constraint_budget", "evidence_matrix"],
      sensitivity: [],
      has_blocking_unresolved: false,
    };
  }
  if (outcome === "unresolved") {
    return {
      ...base,
      rationale_report:
        "Option A is feasible, but Option B's missing final quote blocks a defensible choice under the supplied cost objective.",
      outcome,
      feasibility: feasibility([
        ["alt_a", "feasible"],
        ["alt_b", "undetermined"],
        ["alt_c", "infeasible"],
      ]),
      recommendation: { kind: "none", alternative_ids: [] },
      comparison_dimension_ids: ["objective_cost"],
      basis_ids_used: ["uncertainty_quote", "objective_cost", "evidence_matrix"],
      sensitivity: [],
      has_blocking_unresolved: true,
      blocking_questions: ["What is Option B's final quote?"],
    };
  }
  return {
    ...base,
    rationale_report:
      "This request asks for planning rather than a decision among supplied alternatives.",
    outcome: "not_applicable",
    applicability_reason: "The request is planning work, which belongs to the planning capability.",
    feasibility: [],
    recommendation: { kind: "none", alternative_ids: [] },
    comparison_dimension_ids: [],
    basis_ids_used: [],
    sensitivity: [],
    has_blocking_unresolved: false,
  };
}

export function persistedDecisionDraft(
  outcome: DecisionDraftV2["outcome"] = "selected"
): string {
  const draft = decisionDraft(outcome);
  const { rationale_report: rationaleReport, ...core } = draft;
  return `${rationaleReport}\nDECISION_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`;
}
