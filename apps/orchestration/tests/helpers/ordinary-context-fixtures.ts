import { produceReviewFixture } from "./produce-review-fixture.js";
// Synthetic cognition only: these outputs exercise real host sealing/review/admission owners.
// They do not qualify substantive model context use or live behavior.
import { Type } from "typebox";
import {
  canonicalJson,
  validateContract,
  JsonValueSchema,
  defineRequestConstraints,
  mediaTypeForArtifactKind,
  type AssessmentDraftV2,
  type AssessmentRequestV1,
  type DiagnosisDraftV1,
  type DiagnosisRequestV1,
  type ProduceRequestV1,
  type ProduceArtifactKind,
  type ProducedArtifactDraftV2,
  type ArtifactApproachV1,
  type ArtifactApproachDecisionV1,
  type PlanRequestConstraintsV1,
  type StrategyCoreV2,
  type JsonValue,
} from "../../dist/index.js";
import { decisionRequest, persistedDecisionDraft } from "../fixtures/decision-fixtures.js";
import {
  genericDefinitionRequest,
  genericSpecificationFixture,
  persistedSpecificationDraftV3,
} from "../fixtures/define-fixtures.js";

export interface OrdinaryContextFixture {
  readonly goal: string;
  readonly constraints: Record<string, JsonValue>;
  readonly outputs: readonly string[];
}
function fixture(
  goal: string,
  constraints: unknown,
  outputs: readonly string[]
): OrdinaryContextFixture {
  return {
    goal,
    constraints: validateContract(
      Type.Record(Type.String(), JsonValueSchema),
      constraints,
      "fixture constraints"
    ),
    outputs,
  };
}

function assessFixture(): OrdinaryContextFixture {
  function request(): AssessmentRequestV1 {
    return {
      schema_version: 1,
      assessment_purpose: "Assess the supplied release note.",
      target: [
        { statement: "Maintenance starts Tuesday at 09:00 UTC." },
        { statement: "Thanks for your patience." },
      ],
      criteria: [
        { statement: "States the maintenance time clearly.", importance: "required" },
        { statement: "Uses a courteous tone.", importance: "advisory" },
      ],
      supplied_evidence: [
        { statement: "The note names Tuesday at 09:00 UTC." },
        { statement: "The note thanks its audience." },
      ],
      hard_constraints: [{ statement: "Do not externally verify the schedule." }],
      non_goals: [{ statement: "Do not rewrite or send the note." }],
      known_uncertainties: [{ statement: "The audience was not specified." }],
    };
  }

  function coverage() {
    return {
      assessment_purpose_covered: true as const,
      target_statement_indexes: [0, 1],
      criterion_indexes: [0, 1],
      supplied_evidence_indexes: [0, 1],
      hard_constraint_indexes: [0],
      non_goal_indexes: [0],
      known_uncertainty_indexes: [0],
    };
  }

  function meetsDraft(summary = "The note satisfies both criteria."): AssessmentDraftV2 {
    return {
      schema_version: 2,
      disposition: "meets",
      criterion_outcomes: [
        {
          criterion_index: 0,
          verdict: "met",
          supporting_evidence_indexes: [0],
          contradicting_evidence_indexes: [],
          rationale: "The supplied material states a precise maintenance time.",
        },
        {
          criterion_index: 1,
          verdict: "met",
          supporting_evidence_indexes: [1],
          contradicting_evidence_indexes: [],
          rationale: "The supplied material contains a courteous close.",
        },
      ],
      summary,
      strengths: [
        {
          statement: "The note is precise and courteous.",
          criterion_indexes: [0, 1],
          evidence_indexes: [0, 1],
        },
      ],
      gaps: [],
      improvement_suggestions: [],
      assumptions: [],
      uncertainties: [],
      request_coverage: coverage(),
      confidence: "PROBABLE",
    };
  }

  function persistedDraft(draft: AssessmentDraftV2): string {
    return `ASSESSMENT_DRAFT:${canonicalJson(draft)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`;
  }

  function stageComplete(body: string): string {
    return `${body}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`;
  }

  function veraPass(): string {
    return `Verification report.\nSUMMARY:${JSON.stringify({
      confidence: "CERTAIN",
      verdict: "PASS",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: [
        "The exact current AssessmentV2 satisfies coverage, index, disposition, and lineage checks.",
      ],
      strategy_delta: "Admit only this exact current assessment product.",
    })}`;
  }
  const { assessment_purpose: goal, ...constraints } = request();
  return fixture(goal, constraints, [
    stageComplete("Criteria mapped."),
    persistedDraft(meetsDraft()),
    veraPass(),
  ]);
}

function diagnoseFixture(): OrdinaryContextFixture {
  function request(mode: "proposal_only" | "none" = "proposal_only"): DiagnosisRequestV1 {
    return {
      schema_version: 1,
      problem_statement: "Why are reads stale after an update?",
      symptoms: [{ statement: "A read returns the previous value." }],
      supplied_observations: [
        { statement: "The cached path returns the previous value." },
        { statement: "The origin returns the updated value." },
      ],
      environment_facts: [{ statement: "The read path has an expiring cache." }],
      hard_constraints: [{ statement: "Execute no tests and begin no remediation." }],
      non_goals: [{ statement: "Do not recommend a fix." }],
      known_uncertainties: [{ statement: "The invalidation event is unobserved." }],
      permitted_test_boundary: { mode },
    };
  }

  function coverage() {
    return {
      problem_statement_covered: true as const,
      symptom_indexes: [0],
      observation_indexes: [0, 1],
      environment_fact_indexes: [0],
      hard_constraint_indexes: [0],
      non_goal_indexes: [0],
      known_uncertainty_indexes: [0],
      permitted_test_boundary_covered: true as const,
    };
  }

  function hypothesis(id: string, rank: number, status: "supported" | "plausible" | "ruled_out") {
    return {
      hypothesis_id: id,
      rank,
      statement: `${id} explains the symptom.`,
      status,
      symptom_indexes: [0],
      supporting_observation_indexes: status === "supported" ? [0, 1] : [],
      contradicting_observation_indexes: status === "ruled_out" ? [1] : [],
      supporting_environment_fact_indexes: status === "supported" ? [0] : [],
      contradicting_environment_fact_indexes: [],
      hard_constraint_indexes: [0],
      reasoning: `${id} is ${status} from supplied evidence.`,
    };
  }

  function supportedDraft(
    reasoning = "The supplied evidence supports cache staleness."
  ): DiagnosisDraftV1 {
    return {
      schema_version: 1,
      disposition: "supported",
      applicability_reason: "The request asks for a causal diagnosis.",
      hypothesis_set_complete: true,
      hypotheses: [
        hypothesis("hyp_cache", 1, "supported"),
        hypothesis("hyp_origin", 2, "ruled_out"),
      ],
      primary_supported_hypothesis_id: "hyp_cache",
      reasoning,
      uncertainty: [],
      proposed_discriminating_checks: [],
      request_coverage: coverage(),
      confidence: "PROBABLE",
      remediation_started: false,
      tests_executed: false,
    };
  }

  function persistedDraft(draft: DiagnosisDraftV1): string {
    return `DIAGNOSIS_CORE:${canonicalJson(draft)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`;
  }

  function stageComplete(body: string): string {
    return `${body}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`;
  }

  function veraPass(): string {
    return `Verification report.\nSUMMARY:${JSON.stringify({
      confidence: "CERTAIN",
      verdict: "PASS",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["The exact latest DiagnosisV1 and source lineage are valid."],
      strategy_delta: "Admit this exact diagnosis without executing tests or remediation.",
    })}`;
  }
  const { problem_statement: goal, ...constraints } = request();
  return fixture(goal, constraints, [
    stageComplete("Causal decomposition."),
    stageComplete("Competing hypotheses."),
    persistedDraft(supportedDraft()),
    veraPass(),
  ]);
}

function produceFixture(): OrdinaryContextFixture {
  function request(
    kind: ProduceArtifactKind = "markdown",
    outputName = "greeting.md"
  ): ProduceRequestV1 {
    return {
      schema_version: 1,
      purpose_statement: "Create a concise greeting artifact from the supplied statement.",
      output_name: outputName,
      artifact_kind: kind,
      specification: [{ statement: "Include one greeting and identify its supplied status." }],
      source_material: [{ statement: "Hello, world.", source_label: "caller statement" }],
      acceptance_criteria: [{ statement: "The exact greeting appears once." }],
      hard_constraints: [{ statement: "Do not claim the statement was independently verified." }],
      non_goals: [{ statement: "Do not write, execute, or publish the artifact." }],
      known_uncertainties: [{ statement: "No preferred tone beyond concise was supplied." }],
    };
  }

  function approach(label = "direct"): ArtifactApproachV1 {
    return {
      schema_version: 1,
      approaches: [
        {
          approach_id: `${label}_direct`,
          title: "Direct greeting",
          description: "Present the supplied greeting with a short supplied-source note.",
          tradeoffs: ["Concise and exact, with minimal context."],
        },
        {
          approach_id: `${label}_sectioned`,
          title: "Sectioned greeting",
          description: "Use separate greeting and provenance sections.",
          tradeoffs: ["Makes provenance explicit but adds length."],
        },
      ],
      confidence: "PROBABLE",
    };
  }

  function persistedApproach(value = approach()): string {
    return `ARTIFACT_APPROACH:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
  }

  function approachDecision(label = "direct"): ArtifactApproachDecisionV1 {
    return {
      schema_version: 1,
      disposition: "selected",
      approach_assessments: [
        {
          approach_id: `${label}_direct`,
          feasibility: "feasible",
          comparison: "Directly satisfies the concise greeting brief.",
        },
        {
          approach_id: `${label}_sectioned`,
          feasibility: "feasible",
          comparison: "Adds explicit structure but also length.",
        },
      ],
      selected_approach_id: `${label}_direct`,
      rationale: "The direct structure best matches the supplied concise requirement.",
      sensitivity: [
        "A requirement for separate provenance sections would favor the sectioned approach.",
      ],
      blocking_questions: [],
      confidence: "PROBABLE",
    };
  }

  function persistedApproachDecision(value = approachDecision()): string {
    return `ARTIFACT_APPROACH_DECISION:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true,"disposition":"${value.disposition}"}`;
  }

  function coverage(value = request()) {
    return {
      purpose_statement_covered: true as const,
      specification_indexes: value.specification.map((_item, index) => index),
      source_material_indexes: value.source_material.map((_item, index) => index),
      acceptance_criterion_indexes: value.acceptance_criteria.map((_item, index) => index),
      hard_constraint_indexes: value.hard_constraints.map((_item, index) => index),
      non_goal_indexes: value.non_goals.map((_item, index) => index),
      known_uncertainty_indexes: value.known_uncertainties.map((_item, index) => index),
    };
  }

  function draft(
    content = "# Greeting\n\nHello, world.\n\n*Supplied by the caller.*",
    requestValue = request()
  ): ProducedArtifactDraftV2 {
    return {
      schema_version: 2,
      disposition: "produced",
      output_name: requestValue.output_name,
      artifact_kind: requestValue.artifact_kind,
      media_type: mediaTypeForArtifactKind(requestValue.artifact_kind),
      content,
      rationale: "The concise direct structure satisfies the exact greeting brief.",
      assumptions: [],
      uncertainties: ["Tone beyond concise was not specified."],
      request_coverage: coverage(requestValue),
      confidence: "PROBABLE",
    };
  }

  function persistedDraft(value: ProducedArtifactDraftV2): string {
    return `PRODUCED_ARTIFACT_DRAFT:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
  }

  function qualityApprove(): string {
    return produceReviewFixture({
      confidence: "PROBABLE",
      verdict: "APPROVE",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["The current artifact is clear, complete, and fit for the exact brief."],
      strategy_delta: "Preserve this exact current artifact for objective verification.",
    });
  }

  function veraPass(): string {
    return produceReviewFixture({
      confidence: "CERTAIN",
      verdict: "PASS",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: [
        "Host mechanical evidence is exact; semantic coverage and supplied-source qualification match the brief. Unknown effects remain unknown.",
      ],
      strategy_delta: "Admit only this exact current product and review evidence.",
    });
  }
  const { purpose_statement: goal, ...constraints } = request();
  return fixture(goal, constraints, [
    persistedApproach(),
    persistedApproachDecision(),
    persistedDraft(draft()),
    qualityApprove(),
    veraPass(),
  ]);
}

function planFixture(): OrdinaryContextFixture {
  function constraints(): PlanRequestConstraintsV1 {
    return {
      schema_version: 1,
      desired_outcomes: ["A safe transition is ready.", "Rollback remains possible."],
      current_state: { status: "provided", facts: ["The current system is active."] },
      hard_constraints: ["Do not execute the transition."],
      non_goals: ["Do not create executor tasks."],
      known_uncertainties: [{ statement: "The transition window may move.", material: true }],
      prior_decisions: [
        { statement: "Retain the current platform.", binding_effect: "No platform migration." },
      ],
    };
  }

  function core(disposition: "ready" | "blocked" | "not_applicable" = "ready"): StrategyCoreV2 {
    const emptyCoverage = {
      current_state_fact_indexes: [],
      input_artifact_slots: [],
      hard_constraint_indexes: [],
      non_goal_indexes: [],
      uncertainty_indexes: [],
      prior_decision_indexes: [],
      blocked_desired_outcome_indexes: [],
    };
    if (disposition === "not_applicable") {
      return {
        schema_version: 2,
        disposition,
        applicability_reason: "No planning work applies to the already achieved goal.",
        outcomes: [],
        dependencies: [],
        request_coverage: emptyCoverage,
        blockers: [],
        confidence: "CERTAIN",
        source_item_coverage: [],
        unsupported_strategy_elements: [],
      };
    }
    const ready: StrategyCoreV2 = {
      schema_version: 2,
      disposition,
      applicability_reason: "The supplied request requires a bounded strategy.",
      outcomes: [
        {
          statement: "Transition readiness is established.",
          desired_outcome_indexes: [0],
          success_signal: "Readiness evidence is complete.",
        },
        {
          statement: "Rollback viability is retained.",
          desired_outcome_indexes: [1],
          success_signal: "Rollback evidence remains valid.",
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
      source_item_coverage: [],
      unsupported_strategy_elements: [],
    };
    if (disposition === "ready") return ready;
    const firstOutcome = ready.outcomes[0];
    if (firstOutcome === undefined) throw new Error("ready strategy first outcome is absent");
    return {
      ...ready,
      disposition: "blocked",
      outcomes: [firstOutcome],
      dependencies: [],
      request_coverage: { ...ready.request_coverage, blocked_desired_outcome_indexes: [1] },
      blockers: ["Rollback access is unavailable."],
      confidence: "POSSIBLE",
    };
  }

  function persistedStrategy(value: StrategyCoreV2): string {
    return `The strategy covers outcomes, dependencies, assumptions, risks, information gaps, constraints, non-goals, contingencies, trade-offs, and disposition.\nSTRATEGY_CORE:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
  }

  function summary(details: Record<string, JsonValue>): string {
    return `Report body.\nSUMMARY:${JSON.stringify({ confidence: "PROBABLE", ...details })}`;
  }

  function orientationPass(
    label = "Goal, current state, constraints, and dependencies mapped."
  ): string {
    return summary({
      orientation_complete: true,
      gap_kind: "none",
      repair_owner: "none",
      findings: [label],
      strategy_delta: "Proceed with bounded strategy authorship.",
    });
  }

  function veraPass(): string {
    return summary({
      verdict: "PASS",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["Exact latest StrategyV2 satisfies request and lineage checks."],
      strategy_delta: "Advance the exact product to quality critique.",
    });
  }

  function carrenApprove(minor = false): string {
    return summary({
      verdict: "APPROVE",
      gap_kind: "none",
      repair_owner: "none",
      findings: minor ? [{ severity: "minor", message: "One phrase could be shorter." }] : [],
      evidence: ["The Vera-passed strategy is coherent and strategy-useful."],
      strategy_delta: "Approve the exact latest product.",
    });
  }
  return fixture("Plan a safe transition.", constraints(), [
    orientationPass(),
    persistedStrategy(core()),
    veraPass(),
    carrenApprove(),
  ]);
}

function defineFixture(): OrdinaryContextFixture {
  function orientation(
    route: "author" | "clarify" | "evidence" = "author",
    questions: readonly string[] = ["Which audience is authoritative for acceptance?"]
  ): string {
    return [
      "The request uses the generic profile and preserves the no-execution boundary.",
      `SUMMARY:${JSON.stringify({
        confidence: "CERTAIN",
        orientation_complete: true,
        gap_kind: "none",
        repair_owner: "none",
        selected_profile_id: "generic",
        profile_selection_basis: "The caller explicitly selected the generic profile.",
        route,
        route_reason:
          route === "author"
            ? "The supplied intent is complete enough to author."
            : route === "clarify"
              ? "The caller must resolve the authoritative audience."
              : "One externally resolvable fact needs bounded inspection.",
        clarification_questions: route === "clarify" ? [...questions] : [],
        evidence_questions: route === "evidence" ? ["Which exact standard applies?"] : [],
        findings: [],
        specification_delta: "No prior specification is being revised.",
      })}`,
    ].join("\n");
  }

  function veraPass(): string {
    return [
      "The sealed specification satisfies the request and the closed contract.",
      `SUMMARY:${JSON.stringify({
        confidence: "CERTAIN",
        verdict: "PASS",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["Exact request, frame, draft, product, and source coverage agree."],
        specification_delta: "No repair is required.",
      })}`,
    ].join("\n");
  }

  function carrenApprove(): string {
    return [
      "The specification is coherent, usable, and appropriately bounded.",
      `SUMMARY:${JSON.stringify({
        confidence: "CERTAIN",
        verdict: "APPROVE",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["The Vera-passed product remains clear and planning-ready."],
        specification_delta: "No revision is required.",
      })}`,
    ].join("\n");
  }
  const request = genericDefinitionRequest();
  return fixture(request.goal, defineRequestConstraints(request), [
    orientation(),
    Buffer.from(persistedSpecificationDraftV3(genericSpecificationFixture().draft)).toString(
      "utf8"
    ),
    veraPass(),
    carrenApprove(),
  ]);
}

export function ordinaryContextFixture(name: string): OrdinaryContextFixture {
  switch (name) {
    case "assess":
      return assessFixture();
    case "diagnose":
      return diagnoseFixture();
    case "define":
      return defineFixture();
    case "plan":
      return planFixture();
    case "produce":
      return produceFixture();
    case "research":
      return fixture("Inspect the synthetic source.", { mode: "quick" }, []);
    case "decide": {
      const { decision_question: goal, ...constraints } = decisionRequest();
      const review = (verdict: string) =>
        `Report.\nSUMMARY:${canonicalJson({ confidence: "PROBABLE", verdict, gap_kind: "none", repair_owner: "none", findings: [], evidence: ["Exact current product checked by scripted cognition."], strategy_delta: "Proceed." })}`;
      return fixture(goal, constraints, [
        `Analysis.\nSUMMARY:${canonicalJson({ confidence: "PROBABLE", analysis_complete: true, gap_kind: "none", repair_owner: "none", findings: [], strategy_delta: "Author." })}`,
        persistedDecisionDraft("selected"),
        review("PASS"),
        review("APPROVE"),
      ]);
    }
    default:
      throw new Error(`Unknown ordinary fixture ${name}`);
  }
}
