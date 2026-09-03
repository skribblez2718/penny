import { Type, type Static } from "typebox";

import {
  DecisionCoreV2Schema,
  DecisionDraftV2Schema,
  DecisionRequestV1Schema,
  PlanRequestV1Schema,
  StrategyDraftV1Schema,
  StrategySemanticProjectionV1Schema,
  canonicalJson,
  validateContract,
} from "@penny/orchestration/source";

export const DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3 = [
  "alternatives_against_hard_constraints",
  "feasible_survivor_disposition_justification",
  "common_dimension_comparison_no_invented_preferences",
  "evidence_and_uncertainty_fidelity",
  "decision_sensitivity_and_flip_conditions",
  "disposition_internal_consistency",
] as const;

export const PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2 = [
  "current_state_to_outcomes",
  "constraints_non_goals_prior_decisions",
  "assumptions_and_risk",
  "meaningful_dependencies",
  "no_manufactured_taskification",
  "uncertainty_and_contingencies",
  "tradeoffs_and_decision_points",
  "disposition_internal_consistency",
] as const;

export type DecisionSemanticReviewClauseIdV3 =
  (typeof DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3)[number];
export type PlanSemanticReviewClauseIdV2 = (typeof PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2)[number];

export const DECISION_SEMANTIC_REVIEW_CLAUSE_CRITERIA_V3: Readonly<
  Record<DecisionSemanticReviewClauseIdV3, string>
> = Object.freeze({
  alternatives_against_hard_constraints:
    "Every supplied alternative is substantively assessed against every hard constraint.",
  feasible_survivor_disposition_justification:
    "Only feasible survivors are selected or ranked, and the selected, ranked, no-feasible-option, unresolved, or not-applicable disposition is substantively justified.",
  common_dimension_comparison_no_invented_preferences:
    "Every feasible survivor is compared on every applicable common objective or preference dimension without invented weights or preferences.",
  evidence_and_uncertainty_fidelity:
    "Supplied evidence and material uncertainty are represented faithfully without invented support.",
  decision_sensitivity_and_flip_conditions:
    "Decision-changing sensitivity and flip conditions are stated where applicable.",
  disposition_internal_consistency:
    "Disposition, recommendation or ranking, feasibility, blockers, unresolved items, and confidence are substantively mutually consistent.",
});

export const PLAN_SEMANTIC_REVIEW_CLAUSE_CRITERIA_V2: Readonly<
  Record<PlanSemanticReviewClauseIdV2, string>
> = Object.freeze({
  current_state_to_outcomes:
    "Known current state substantively connects to every desired outcome, or blocked correctly identifies why execution-readiness is absent.",
  constraints_non_goals_prior_decisions:
    "Every hard constraint, non-goal, and binding prior decision is respected in the strategy meaning.",
  assumptions_and_risk: "Every material assumption and its risk are stated.",
  meaningful_dependencies:
    "Only causal, temporal, resource, or informational dependencies that actually constrain the strategy are included.",
  no_manufactured_taskification:
    "Strategy prose and outcomes avoid manufactured sequencing and executor-level decomposition.",
  uncertainty_and_contingencies:
    "Material uncertainty has useful contingencies grounded in the permitted basis.",
  tradeoffs_and_decision_points:
    "Relevant trade-offs and decision points preserve implementation freedom.",
  disposition_internal_consistency:
    "Disposition, applicability, blockers, outcome coverage, dependencies, unresolved items, and confidence are substantively mutually consistent.",
});

export const DecisionSemanticEvaluationV3Schema = Type.Object(
  {
    schema_version: Type.Literal(3),
    rationale_report: DecisionDraftV2Schema.properties.rationale_report,
    outcome: DecisionCoreV2Schema.properties.outcome,
    applicability_reason: DecisionCoreV2Schema.properties.applicability_reason,
    feasibility: DecisionCoreV2Schema.properties.feasibility,
    recommendation: DecisionCoreV2Schema.properties.recommendation,
    comparison_dimension_ids: DecisionCoreV2Schema.properties.comparison_dimension_ids,
    basis_ids_used: DecisionCoreV2Schema.properties.basis_ids_used,
    sensitivity: DecisionCoreV2Schema.properties.sensitivity,
    has_blocking_unresolved: DecisionCoreV2Schema.properties.has_blocking_unresolved,
    blocking_questions: DecisionCoreV2Schema.properties.blocking_questions,
    confidence: DecisionCoreV2Schema.properties.confidence,
  },
  { additionalProperties: false }
);
export type DecisionSemanticEvaluationV3 = Readonly<
  Static<typeof DecisionSemanticEvaluationV3Schema>
>;

export const StrategyEvaluationV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    disposition: StrategySemanticProjectionV1Schema.properties.disposition,
    applicability_reason: StrategySemanticProjectionV1Schema.properties.applicability_reason,
    outcomes: StrategySemanticProjectionV1Schema.properties.outcomes,
    dependencies: StrategySemanticProjectionV1Schema.properties.dependencies,
    request_coverage: StrategySemanticProjectionV1Schema.properties.request_coverage,
    blockers: StrategySemanticProjectionV1Schema.properties.blockers,
    confidence: StrategySemanticProjectionV1Schema.properties.confidence,
    strategy_report: StrategyDraftV1Schema.properties.strategy_report,
  },
  { additionalProperties: false }
);
export type StrategyEvaluationV2 = Readonly<Static<typeof StrategyEvaluationV2Schema>>;

export const PlanSemanticRequestProjectionV1Schema = Type.Object(
  {
    schema_version: PlanRequestV1Schema.properties.schema_version,
    goal: PlanRequestV1Schema.properties.goal,
    desired_outcomes: PlanRequestV1Schema.properties.desired_outcomes,
    current_state: PlanRequestV1Schema.properties.current_state,
    hard_constraints: PlanRequestV1Schema.properties.hard_constraints,
    non_goals: PlanRequestV1Schema.properties.non_goals,
    known_uncertainties: PlanRequestV1Schema.properties.known_uncertainties,
    prior_decisions: PlanRequestV1Schema.properties.prior_decisions,
  },
  { additionalProperties: false }
);
export type PlanSemanticRequestProjectionV1 = Readonly<
  Static<typeof PlanSemanticRequestProjectionV1Schema>
>;

const PlanSemanticRequestCoverageV2Schema = Type.Object(
  {
    current_state_fact_ids:
      StrategySemanticProjectionV1Schema.properties.request_coverage.properties
        .current_state_fact_ids,
    hard_constraint_ids:
      StrategySemanticProjectionV1Schema.properties.request_coverage.properties.hard_constraint_ids,
    non_goal_ids:
      StrategySemanticProjectionV1Schema.properties.request_coverage.properties.non_goal_ids,
    uncertainty_ids:
      StrategySemanticProjectionV1Schema.properties.request_coverage.properties.uncertainty_ids,
    prior_decision_ids:
      StrategySemanticProjectionV1Schema.properties.request_coverage.properties.prior_decision_ids,
    blocked_desired_outcome_ids:
      StrategySemanticProjectionV1Schema.properties.request_coverage.properties
        .blocked_desired_outcome_ids,
  },
  { additionalProperties: false }
);

export const PlanSemanticReviewWireV2Schema = Type.Object(
  {
    ...StrategyEvaluationV2Schema.properties,
    request_coverage: PlanSemanticRequestCoverageV2Schema,
  },
  { additionalProperties: false }
);
export type PlanSemanticReviewWireV2 = Readonly<Static<typeof PlanSemanticReviewWireV2Schema>>;

const DecideFeasibilityExpectationV3Schema = Type.Object(
  {
    alternative_id: Type.String({ minLength: 1, maxLength: 128 }),
    allowed_statuses: Type.Array(
      DecisionCoreV2Schema.properties.feasibility.items.properties.status,
      { minItems: 1, maxItems: 3, uniqueItems: true }
    ),
  },
  { additionalProperties: false }
);

export const DecideStructuredExpectationsV3Schema = Type.Object(
  {
    allowed_outcomes: Type.Array(DecisionCoreV2Schema.properties.outcome, {
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
    }),
    expected_alternative_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 24,
      uniqueItems: true,
    }),
    expected_hard_constraint_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    expected_feasibility: Type.Array(DecideFeasibilityExpectationV3Schema, {
      maxItems: 24,
      uniqueItems: true,
    }),
    accepted_recommendations: Type.Array(DecisionCoreV2Schema.properties.recommendation, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    accepted_comparison_dimension_id_sets: Type.Array(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 32,
        uniqueItems: true,
      }),
      { minItems: 1, maxItems: 16, uniqueItems: true }
    ),
    required_basis_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      maxItems: 256,
      uniqueItems: true,
    }),
    allowed_basis_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      maxItems: 256,
      uniqueItems: true,
    }),
    required_sensitivity_basis_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      maxItems: 64,
      uniqueItems: true,
    }),
    expected_blocking_unresolved: Type.Boolean(),
    expected_blocking_question_presence: Type.Union([
      Type.Literal("none"),
      Type.Literal("nonempty"),
    ]),
    allowed_confidence: Type.Array(DecisionCoreV2Schema.properties.confidence, {
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type DecideStructuredExpectationsV3 = Readonly<
  Static<typeof DecideStructuredExpectationsV3Schema>
>;

export const PlanStructuredExpectationsV2Schema = Type.Object(
  {
    allowed_dispositions: Type.Array(StrategySemanticProjectionV1Schema.properties.disposition, {
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
    }),
    expected_desired_outcome_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 24,
      uniqueItems: true,
    }),
    expected_current_state_fact_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 64,
      uniqueItems: true,
    }),
    expected_hard_constraint_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 64,
      uniqueItems: true,
    }),
    expected_non_goal_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    expected_uncertainty_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    expected_prior_decision_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    expected_blocked_desired_outcome_ids: Type.Array(
      Type.String({ minLength: 1, maxLength: 128 }),
      { maxItems: 24, uniqueItems: true }
    ),
    expected_dependency_relations: Type.Array(
      StrategySemanticProjectionV1Schema.properties.dependencies.items,
      { maxItems: 96, uniqueItems: true }
    ),
    expected_blocker_presence: Type.Union([Type.Literal("none"), Type.Literal("nonempty")]),
    allowed_confidence: Type.Array(StrategySemanticProjectionV1Schema.properties.confidence, {
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type PlanStructuredExpectationsV2 = Readonly<
  Static<typeof PlanStructuredExpectationsV2Schema>
>;

const ApplicabilitySchema = Type.Union([
  Type.Literal("applicable"),
  Type.Literal("not_applicable"),
]);
const DecisionClauseProjectionV3Schema = Type.Object(
  {
    clause_id: Type.Union([
      Type.Literal("alternatives_against_hard_constraints"),
      Type.Literal("feasible_survivor_disposition_justification"),
      Type.Literal("common_dimension_comparison_no_invented_preferences"),
      Type.Literal("evidence_and_uncertainty_fidelity"),
      Type.Literal("decision_sensitivity_and_flip_conditions"),
      Type.Literal("disposition_internal_consistency"),
    ]),
    applicability: ApplicabilitySchema,
  },
  { additionalProperties: false }
);
const PlanClauseProjectionV2Schema = Type.Object(
  {
    clause_id: Type.Union([
      Type.Literal("current_state_to_outcomes"),
      Type.Literal("constraints_non_goals_prior_decisions"),
      Type.Literal("assumptions_and_risk"),
      Type.Literal("meaningful_dependencies"),
      Type.Literal("no_manufactured_taskification"),
      Type.Literal("uncertainty_and_contingencies"),
      Type.Literal("tradeoffs_and_decision_points"),
      Type.Literal("disposition_internal_consistency"),
    ]),
    applicability: ApplicabilitySchema,
  },
  { additionalProperties: false }
);

export const SemanticOracleDerivationAttestationV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    derivation_method: Type.Literal("host_derived_from_permitted_request_basis"),
    sealing_control: Type.Literal("oracle_projection_sealed_before_trial_output_review"),
  },
  { additionalProperties: false }
);
export type SemanticOracleDerivationAttestationV1 = Readonly<
  Static<typeof SemanticOracleDerivationAttestationV1Schema>
>;

export const SemanticOracleContaminationAttestationV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    isolation_control: Type.Literal("host_only_oracle_projection_without_arm_mapping"),
    contamination_result: Type.Literal("no_trial_output_or_identity_material"),
  },
  { additionalProperties: false }
);
export type SemanticOracleContaminationAttestationV1 = Readonly<
  Static<typeof SemanticOracleContaminationAttestationV1Schema>
>;

export interface SemanticProjectionClauseV1 {
  readonly clause_id: string;
  readonly criterion: string;
  readonly applicability: "applicable" | "not_applicable";
}

export interface ValidatedSemanticTrialProjectionDataV1 {
  readonly skill: "decide" | "plan";
  readonly request_projection_kind:
    | "decision_request_permitted_basis_v1"
    | "plan_request_permitted_basis_v1";
  readonly request_content: string;
  readonly wire_projection_kind: "decision_semantic_wire_v3" | "plan_semantic_wire_v2";
  readonly wire_content: string;
  readonly oracle_projection_kind:
    | "decision_closed_oracle_projection_v3"
    | "plan_closed_oracle_projection_v2";
  readonly oracle_fact_content: string;
  readonly accepted_equivalence_content: string;
  readonly clauses: readonly SemanticProjectionClauseV1[];
}

export interface ValidatedSemanticOracleProjectionDataV1 {
  readonly skill: "decide" | "plan";
  readonly request_projection_kind:
    | "decision_request_permitted_basis_v1"
    | "plan_request_permitted_basis_v1";
  readonly request_content: string;
  readonly oracle_projection_kind:
    | "decision_closed_oracle_projection_v3"
    | "plan_closed_oracle_projection_v2";
  readonly oracle_fact_content: string;
  readonly accepted_equivalence_content: string;
  readonly derivation_attestation_content: string;
  readonly contamination_attestation_content: string;
}

const VALIDATED_TRIAL_PROJECTION_TOKEN = Symbol("validated-semantic-trial-projection");
const VALIDATED_ORACLE_PROJECTION_TOKEN = Symbol("validated-semantic-oracle-projection");
const issuedTrialProjections = new WeakSet<object>();
const issuedOracleProjections = new WeakSet<object>();

export class ValidatedSemanticTrialProjectionV1 {
  constructor(
    token: symbol,
    readonly data: ValidatedSemanticTrialProjectionDataV1
  ) {
    if (token !== VALIDATED_TRIAL_PROJECTION_TOKEN) {
      throw new Error("validated semantic trial projections are task-factory-created only");
    }
    issuedTrialProjections.add(this);
  }
}

export class ValidatedSemanticOracleProjectionV1 {
  constructor(
    token: symbol,
    readonly data: ValidatedSemanticOracleProjectionDataV1
  ) {
    if (token !== VALIDATED_ORACLE_PROJECTION_TOKEN) {
      throw new Error("validated semantic oracle projections are task-factory-created only");
    }
    issuedOracleProjections.add(this);
  }
}

function assertCanonicalClauseProjection(input: {
  readonly actual: readonly { readonly clause_id: string }[];
  readonly expected: readonly string[];
  readonly label: string;
}): void {
  if (
    canonicalJson(input.actual.map((clause) => clause.clause_id)) !== canonicalJson(input.expected)
  ) {
    throw new Error(`${input.label} must contain every canonical clause exactly once in order`);
  }
}

function decisionAcceptedEquivalences(expectations: DecideStructuredExpectationsV3) {
  return {
    accepted_recommendations: expectations.accepted_recommendations,
    accepted_comparison_dimension_id_sets: expectations.accepted_comparison_dimension_id_sets,
  };
}

function planAcceptedEquivalences(expectations: PlanStructuredExpectationsV2) {
  return {
    expected_dependency_relations: expectations.expected_dependency_relations,
    allowed_dispositions: expectations.allowed_dispositions,
  };
}

function decisionClauses(value: unknown): readonly SemanticProjectionClauseV1[] {
  const clauses = validateContract(
    Type.Array(DecisionClauseProjectionV3Schema, {
      minItems: DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3.length,
      maxItems: DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3.length,
    }),
    value,
    "Decision semantic review clause projection V3"
  );
  assertCanonicalClauseProjection({
    actual: clauses,
    expected: DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3,
    label: "Decision semantic review clause projection V3",
  });
  return clauses.map((clause) => ({
    clause_id: clause.clause_id,
    criterion: DECISION_SEMANTIC_REVIEW_CLAUSE_CRITERIA_V3[clause.clause_id],
    applicability: clause.applicability,
  }));
}

function planClauses(value: unknown): readonly SemanticProjectionClauseV1[] {
  const clauses = validateContract(
    Type.Array(PlanClauseProjectionV2Schema, {
      minItems: PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2.length,
      maxItems: PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2.length,
    }),
    value,
    "Plan semantic review clause projection V2"
  );
  assertCanonicalClauseProjection({
    actual: clauses,
    expected: PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2,
    label: "Plan semantic review clause projection V2",
  });
  return clauses.map((clause) => ({
    clause_id: clause.clause_id,
    criterion: PLAN_SEMANTIC_REVIEW_CLAUSE_CRITERIA_V2[clause.clause_id],
    applicability: clause.applicability,
  }));
}

export function createDecisionSemanticTrialProjectionV3(input: {
  readonly request: unknown;
  readonly wire: unknown;
  readonly clauses: unknown;
  readonly structuredExpectations: unknown;
}): ValidatedSemanticTrialProjectionV1 {
  const request = validateContract(
    DecisionRequestV1Schema,
    input.request,
    "Decision semantic request projection V1"
  );
  const wire = validateContract(
    DecisionSemanticEvaluationV3Schema,
    input.wire,
    "Decision semantic wire projection V3"
  );
  const expectations = validateContract(
    DecideStructuredExpectationsV3Schema,
    input.structuredExpectations,
    "Decision closed oracle projection V3"
  );
  return new ValidatedSemanticTrialProjectionV1(VALIDATED_TRIAL_PROJECTION_TOKEN, {
    skill: "decide",
    request_projection_kind: "decision_request_permitted_basis_v1",
    request_content: canonicalJson(request),
    wire_projection_kind: "decision_semantic_wire_v3",
    wire_content: canonicalJson(wire),
    oracle_projection_kind: "decision_closed_oracle_projection_v3",
    oracle_fact_content: canonicalJson(expectations),
    accepted_equivalence_content: canonicalJson(decisionAcceptedEquivalences(expectations)),
    clauses: decisionClauses(input.clauses),
  });
}

export function createPlanSemanticTrialProjectionV2(input: {
  readonly request: unknown;
  readonly wire: unknown;
  readonly clauses: unknown;
  readonly structuredExpectations: unknown;
}): ValidatedSemanticTrialProjectionV1 {
  const request = validateContract(
    PlanSemanticRequestProjectionV1Schema,
    input.request,
    "Plan semantic request projection V1"
  );
  const wire = validateContract(
    PlanSemanticReviewWireV2Schema,
    input.wire,
    "Plan semantic wire projection V2"
  );
  const expectations = validateContract(
    PlanStructuredExpectationsV2Schema,
    input.structuredExpectations,
    "Plan closed oracle projection V2"
  );
  return new ValidatedSemanticTrialProjectionV1(VALIDATED_TRIAL_PROJECTION_TOKEN, {
    skill: "plan",
    request_projection_kind: "plan_request_permitted_basis_v1",
    request_content: canonicalJson(request),
    wire_projection_kind: "plan_semantic_wire_v2",
    wire_content: canonicalJson(wire),
    oracle_projection_kind: "plan_closed_oracle_projection_v2",
    oracle_fact_content: canonicalJson(expectations),
    accepted_equivalence_content: canonicalJson(planAcceptedEquivalences(expectations)),
    clauses: planClauses(input.clauses),
  });
}

function validatedAttestations(input: {
  readonly derivationAttestation: unknown;
  readonly contaminationAttestation: unknown;
}): {
  readonly derivation: string;
  readonly contamination: string;
} {
  const derivation = validateContract(
    SemanticOracleDerivationAttestationV1Schema,
    input.derivationAttestation,
    "semantic oracle derivation attestation V1"
  );
  const contamination = validateContract(
    SemanticOracleContaminationAttestationV1Schema,
    input.contaminationAttestation,
    "semantic oracle contamination attestation V1"
  );
  return {
    derivation: canonicalJson(derivation),
    contamination: canonicalJson(contamination),
  };
}

export function createDecisionSemanticOracleProjectionV3(input: {
  readonly request: unknown;
  readonly structuredExpectations: unknown;
  readonly derivationAttestation: unknown;
  readonly contaminationAttestation: unknown;
}): ValidatedSemanticOracleProjectionV1 {
  const request = validateContract(
    DecisionRequestV1Schema,
    input.request,
    "Decision semantic request projection V1"
  );
  const expectations = validateContract(
    DecideStructuredExpectationsV3Schema,
    input.structuredExpectations,
    "Decision closed oracle projection V3"
  );
  const attestations = validatedAttestations(input);
  return new ValidatedSemanticOracleProjectionV1(VALIDATED_ORACLE_PROJECTION_TOKEN, {
    skill: "decide",
    request_projection_kind: "decision_request_permitted_basis_v1",
    request_content: canonicalJson(request),
    oracle_projection_kind: "decision_closed_oracle_projection_v3",
    oracle_fact_content: canonicalJson(expectations),
    accepted_equivalence_content: canonicalJson(decisionAcceptedEquivalences(expectations)),
    derivation_attestation_content: attestations.derivation,
    contamination_attestation_content: attestations.contamination,
  });
}

export function createPlanSemanticOracleProjectionV2(input: {
  readonly request: unknown;
  readonly structuredExpectations: unknown;
  readonly derivationAttestation: unknown;
  readonly contaminationAttestation: unknown;
}): ValidatedSemanticOracleProjectionV1 {
  const request = validateContract(
    PlanSemanticRequestProjectionV1Schema,
    input.request,
    "Plan semantic request projection V1"
  );
  const expectations = validateContract(
    PlanStructuredExpectationsV2Schema,
    input.structuredExpectations,
    "Plan closed oracle projection V2"
  );
  const attestations = validatedAttestations(input);
  return new ValidatedSemanticOracleProjectionV1(VALIDATED_ORACLE_PROJECTION_TOKEN, {
    skill: "plan",
    request_projection_kind: "plan_request_permitted_basis_v1",
    request_content: canonicalJson(request),
    oracle_projection_kind: "plan_closed_oracle_projection_v2",
    oracle_fact_content: canonicalJson(expectations),
    accepted_equivalence_content: canonicalJson(planAcceptedEquivalences(expectations)),
    derivation_attestation_content: attestations.derivation,
    contamination_attestation_content: attestations.contamination,
  });
}

export function readValidatedSemanticTrialProjection(
  projection: ValidatedSemanticTrialProjectionV1
): ValidatedSemanticTrialProjectionDataV1 {
  if (!issuedTrialProjections.has(projection)) {
    throw new Error("semantic trial projection does not carry module-issued validation authority");
  }
  return projection.data;
}

export function readValidatedSemanticOracleProjection(
  projection: ValidatedSemanticOracleProjectionV1
): ValidatedSemanticOracleProjectionDataV1 {
  if (!issuedOracleProjections.has(projection)) {
    throw new Error("semantic oracle projection does not carry module-issued validation authority");
  }
  return projection.data;
}
