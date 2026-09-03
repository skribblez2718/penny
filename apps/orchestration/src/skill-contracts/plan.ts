import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { ArtifactRefSchema, ConfidenceSchema, type ArtifactRef } from "../contracts.js";
import {
  ArtifactIdSchema,
  OpaqueIdSchema,
  Sha256Schema,
  SkillSchemaValidationError,
  TextSchema,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "./common.js";

const MAX_PLAN_INPUTS = 2;
const MAX_STRATEGY_PROSE_BYTES = 65_536;
const MAX_STRATEGY_CORE_LINE_BYTES = 49_152;
const MAX_STRATEGY_SUMMARY_LINE_BYTES = 256;
export const MAX_PERSISTED_STRATEGY_DRAFT_BYTES = 131_072;

const CurrentStateV1Schema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("provided"),
      facts: Type.Array(TextSchema({ maxBytes: 8_192, multiline: true }), {
        minItems: 1,
        maxItems: 64,
      }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      status: Type.Literal("unavailable"),
      reason: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    },
    { additionalProperties: false }
  ),
]);

const KnownUncertaintyV1Schema = Type.Object(
  {
    statement: TextSchema({ maxBytes: 4_096, multiline: true }),
    material: Type.Boolean(),
  },
  { additionalProperties: false }
);

const PriorDecisionV1Schema = Type.Object(
  {
    statement: TextSchema({ maxBytes: 4_096, multiline: true }),
    binding_effect: TextSchema({ maxBytes: 4_096, multiline: true }),
  },
  { additionalProperties: false }
);

const PlanRequestConstraintProperties = {
  schema_version: Type.Literal(1),
  desired_outcomes: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
    minItems: 1,
    maxItems: 24,
  }),
  current_state: CurrentStateV1Schema,
  hard_constraints: Type.Array(TextSchema({ maxBytes: 4_096, multiline: true }), {
    maxItems: 64,
  }),
  non_goals: Type.Array(TextSchema({ maxBytes: 4_096, multiline: true }), {
    maxItems: 32,
  }),
  known_uncertainties: Type.Array(KnownUncertaintyV1Schema, { maxItems: 32 }),
  prior_decisions: Type.Array(PriorDecisionV1Schema, { maxItems: 32 }),
};

export const PlanRequestConstraintsV1Schema = Type.Object(PlanRequestConstraintProperties, {
  additionalProperties: false,
});
export type PlanRequestConstraintsV1 = Readonly<Static<typeof PlanRequestConstraintsV1Schema>>;

export const PlanRequestV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    request_id: OpaqueIdSchema,
    goal: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
    desired_outcomes: PlanRequestConstraintsV1Schema.properties.desired_outcomes,
    current_state: CurrentStateV1Schema,
    hard_constraints: PlanRequestConstraintsV1Schema.properties.hard_constraints,
    non_goals: PlanRequestConstraintsV1Schema.properties.non_goals,
    known_uncertainties: PlanRequestConstraintsV1Schema.properties.known_uncertainties,
    prior_decisions: PlanRequestConstraintsV1Schema.properties.prior_decisions,
    input_artifact_ids: Type.Array(ArtifactIdSchema, {
      maxItems: MAX_PLAN_INPUTS,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type PlanRequestV1 = Readonly<Static<typeof PlanRequestV1Schema>>;

const StrategyDispositionV1Schema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("blocked"),
  Type.Literal("not_applicable"),
]);
const StrategyDependencyKindV1Schema = Type.Union([
  Type.Literal("causal"),
  Type.Literal("temporal"),
  Type.Literal("resource"),
  Type.Literal("informational"),
]);

const StrategyOutcomeCoreV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
    desired_outcome_indexes: Type.Array(Type.Integer({ minimum: 0 }), {
      minItems: 1,
      maxItems: 24,
      uniqueItems: true,
    }),
    success_signal: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
  },
  { additionalProperties: false }
);

const StrategyDependencyCoreV1Schema = Type.Object(
  {
    from_outcome_index: Type.Integer({ minimum: 0 }),
    to_outcome_index: Type.Integer({ minimum: 0 }),
    kind: StrategyDependencyKindV1Schema,
  },
  { additionalProperties: false }
);

const StrategyCoverageCoreV1Schema = Type.Object(
  {
    current_state_fact_indexes: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: 64,
      uniqueItems: true,
    }),
    input_artifact_slots: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: MAX_PLAN_INPUTS,
      uniqueItems: true,
    }),
    hard_constraint_indexes: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: 64,
      uniqueItems: true,
    }),
    non_goal_indexes: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    uncertainty_indexes: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    prior_decision_indexes: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    blocked_desired_outcome_indexes: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: 24,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

const StrategyCoreProperties = {
  schema_version: Type.Literal(1),
  disposition: StrategyDispositionV1Schema,
  applicability_reason: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
  outcomes: Type.Array(StrategyOutcomeCoreV1Schema, { maxItems: 24 }),
  dependencies: Type.Array(StrategyDependencyCoreV1Schema, {
    maxItems: 96,
    uniqueItems: true,
  }),
  request_coverage: StrategyCoverageCoreV1Schema,
  blockers: Type.Array(TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }), {
    maxItems: 16,
    uniqueItems: true,
  }),
  confidence: ConfidenceSchema,
};

export const StrategyCoreV1Schema = Type.Object(StrategyCoreProperties, {
  additionalProperties: false,
});
export type StrategyCoreV1 = Readonly<Static<typeof StrategyCoreV1Schema>>;

export const StrategyDraftV1Schema = Type.Object(
  {
    strategy_report: TextSchema({
      minBytes: 1,
      maxBytes: MAX_STRATEGY_PROSE_BYTES,
      multiline: true,
    }),
    ...StrategyCoreProperties,
  },
  { additionalProperties: false }
);
export type StrategyDraftV1 = Readonly<Static<typeof StrategyDraftV1Schema>>;

export type StrategyDraftFailureClassV1 =
  | "FRAMING_INVALID"
  | "JSON_INVALID"
  | "SCHEMA_INVALID"
  | "SEMANTIC_INVALID";

export class StrategyDraftValidationError extends Error {
  constructor(
    readonly failureClass: StrategyDraftFailureClassV1,
    readonly issues: readonly string[]
  ) {
    super(`${failureClass}: ${issues.join("; ")}`);
    this.name = "StrategyDraftValidationError";
  }
}

export const StrategySealFeedbackV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.strategy-seal-feedback.v1"),
    schema_version: Type.Literal(1),
    attempt: Type.Literal(1),
    rejected_draft_artifact_id: ArtifactIdSchema,
    failure_class: Type.Union([
      Type.Literal("FRAMING_INVALID"),
      Type.Literal("JSON_INVALID"),
      Type.Literal("SCHEMA_INVALID"),
      Type.Literal("SEMANTIC_INVALID"),
    ]),
    issues: Type.Array(TextSchema({ minBytes: 1, maxBytes: 512 }), {
      minItems: 1,
      maxItems: 1_024,
    }),
  },
  { additionalProperties: false }
);
export type StrategySealFeedbackV1 = Readonly<Static<typeof StrategySealFeedbackV1Schema>>;

export const StrategyProductIntegrityV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.strategy-product-integrity.v1"),
    schema_version: Type.Literal(1),
    integrity_id: Sha256Schema,
    status: Type.Literal("PASS"),
    request_ref: ArtifactRefSchema,
    orientation_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
    imported_input_refs: Type.Array(ArtifactRefSchema, { maxItems: MAX_PLAN_INPUTS }),
    draft_ref: ArtifactRefSchema,
    strategy_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    quality_receipt_ref: ArtifactRefSchema,
    execution_receipt_ids: Type.Array(OpaqueIdSchema, {
      minItems: 4,
      maxItems: 68,
      uniqueItems: true,
    }),
    checks: Type.Array(
      Type.Union([
        Type.Literal("canonical_strategy"),
        Type.Literal("exact_lineage"),
        Type.Literal("signed_worker_evidence"),
        Type.Literal("latest_validity_receipt"),
        Type.Literal("latest_quality_receipt"),
        Type.Literal("no_execution"),
      ]),
      { minItems: 6, maxItems: 6, uniqueItems: true }
    ),
    execution_started: Type.Literal(false),
    execution_authorized: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type StrategyProductIntegrityV1 = Readonly<Static<typeof StrategyProductIntegrityV1Schema>>;

export const StrategyProductEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.strategy-product-envelope.v1"),
    schema_version: Type.Literal(1),
    envelope_id: Sha256Schema,
    run_id: OpaqueIdSchema,
    status: Type.Literal("complete"),
    strategy_ref: ArtifactRefSchema,
    request_ref: ArtifactRefSchema,
    orientation_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
    imported_input_refs: Type.Array(ArtifactRefSchema, { maxItems: MAX_PLAN_INPUTS }),
    draft_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    quality_receipt_ref: ArtifactRefSchema,
    integrity_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type StrategyProductEnvelopeV1 = Readonly<Static<typeof StrategyProductEnvelopeV1Schema>>;

const StrategyRoutingSummaryV1Schema = Type.Object(
  {
    confidence: ConfidenceSchema,
    complete: Type.Literal(true),
  },
  { additionalProperties: false }
);
export type StrategyRoutingSummaryV1 = Readonly<Static<typeof StrategyRoutingSummaryV1Schema>>;

const StrategyOutcomeV1Schema = Type.Object(
  {
    outcome_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
    desired_outcome_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 24,
      uniqueItems: true,
    }),
    success_signal: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
  },
  { additionalProperties: false }
);

const StrategyDependencyV1Schema = Type.Object(
  {
    from_outcome_id: OpaqueIdSchema,
    to_outcome_id: OpaqueIdSchema,
    kind: StrategyDependencyKindV1Schema,
  },
  { additionalProperties: false }
);

const StrategyCoverageV1Schema = Type.Object(
  {
    current_state_fact_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
    input_artifact_ids: Type.Array(ArtifactIdSchema, {
      maxItems: MAX_PLAN_INPUTS,
      uniqueItems: true,
    }),
    hard_constraint_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
    non_goal_ids: Type.Array(OpaqueIdSchema, { maxItems: 32, uniqueItems: true }),
    uncertainty_ids: Type.Array(OpaqueIdSchema, { maxItems: 32, uniqueItems: true }),
    prior_decision_ids: Type.Array(OpaqueIdSchema, { maxItems: 32, uniqueItems: true }),
    blocked_desired_outcome_ids: Type.Array(OpaqueIdSchema, {
      maxItems: 24,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

const StrategySemanticProperties = {
  disposition: StrategyDispositionV1Schema,
  applicability_reason: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
  outcomes: Type.Array(StrategyOutcomeV1Schema, { maxItems: 24 }),
  dependencies: Type.Array(StrategyDependencyV1Schema, { maxItems: 96, uniqueItems: true }),
  request_coverage: StrategyCoverageV1Schema,
  blockers: Type.Array(TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }), {
    maxItems: 16,
    uniqueItems: true,
  }),
  confidence: ConfidenceSchema,
};

export const StrategySemanticProjectionV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    ...StrategySemanticProperties,
    execution_started: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type StrategySemanticProjectionV1 = Readonly<
  Static<typeof StrategySemanticProjectionV1Schema>
>;

const StrategySourceLineagePreimageV1Schema = Type.Object(
  {
    request_artifact_id: ArtifactIdSchema,
    draft_artifact_id: ArtifactIdSchema,
    draft_sha256: Sha256Schema,
    input_artifact_ids: Type.Array(ArtifactIdSchema, {
      maxItems: MAX_PLAN_INPUTS,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type StrategySourceLineagePreimageV1 = Readonly<
  Static<typeof StrategySourceLineagePreimageV1Schema>
>;

export const StrategySourceLineageV1Schema = Type.Object(
  {
    ...StrategySourceLineagePreimageV1Schema.properties,
    lineage_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const StrategyV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    strategy_id: OpaqueIdSchema,
    strategy_report: TextSchema({
      minBytes: 1,
      maxBytes: MAX_STRATEGY_PROSE_BYTES,
      multiline: true,
    }),
    ...StrategySemanticProperties,
    request: PlanRequestV1Schema,
    request_sha256: Sha256Schema,
    source_lineage: StrategySourceLineageV1Schema,
    execution_started: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type StrategyV1 = Readonly<Static<typeof StrategyV1Schema>>;

function sanitizedIssues(issues: readonly string[]): readonly string[] {
  return [
    ...new Set(
      issues.map((issue) =>
        issue.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\0", " ").trim().slice(0, 512)
      )
    ),
  ]
    .filter((issue) => issue.length > 0)
    .slice(0, 1_024);
}

function collectIssue(issues: string[], action: () => void): void {
  try {
    action();
  } catch (error) {
    if (error instanceof SkillSchemaValidationError) issues.push(...error.issues);
    else if (error instanceof Error) issues.push(error.message);
    else issues.push("validation failed");
  }
}

function validateBoundedText(value: string, label: string, maxBytes: number, minBytes = 0): void {
  assertText(value, label, {
    minBytes,
    maxBytes,
    multiline: true,
    ...(minBytes > 0 ? { trimmedNonEmpty: true } : {}),
  });
}

function assertCanonicalUnique<T>(values: readonly T[], label: string): void {
  assertUnique(
    values.map((value) => canonicalJson(value)),
    label
  );
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return (
    canonicalJson([...left].sort((a, b) => a - b)) ===
    canonicalJson([...right].sort((a, b) => a - b))
  );
}

export function stablePlanId(namespace: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(namespace)) {
    throw new Error("stable Plan ID namespace is malformed");
  }
  return `${namespace}-${sha256(canonicalJson(value))}`;
}

function planRequestSeed(input: {
  readonly goal: string;
  readonly constraints: PlanRequestConstraintsV1;
  readonly inputArtifactIds: readonly string[];
}): Omit<PlanRequestV1, "request_id"> {
  return {
    schema_version: 1,
    goal: input.goal,
    desired_outcomes: input.constraints.desired_outcomes,
    current_state: input.constraints.current_state,
    hard_constraints: input.constraints.hard_constraints,
    non_goals: input.constraints.non_goals,
    known_uncertainties: input.constraints.known_uncertainties,
    prior_decisions: input.constraints.prior_decisions,
    input_artifact_ids: sortedStrings(input.inputArtifactIds),
  };
}

function validatePlanRequestContent(request: PlanRequestV1): void {
  const issues: string[] = [];
  collectIssue(issues, () => validateBoundedText(request.goal, "PlanRequestV1.goal", 16_384, 1));
  for (const value of request.desired_outcomes) {
    collectIssue(issues, () =>
      validateBoundedText(value, "PlanRequestV1 desired outcome", 4_096, 1)
    );
  }
  if (request.current_state.status === "provided") {
    const facts = request.current_state.facts;
    for (const value of facts) {
      collectIssue(issues, () =>
        validateBoundedText(value, "PlanRequestV1 current-state fact", 8_192)
      );
    }
    collectIssue(issues, () => assertCanonicalUnique(facts, "PlanRequestV1 current-state facts"));
  } else {
    const reason = request.current_state.reason;
    collectIssue(issues, () =>
      validateBoundedText(reason, "PlanRequestV1 unavailable reason", 4_096, 1)
    );
  }
  for (const value of [...request.hard_constraints, ...request.non_goals]) {
    collectIssue(issues, () =>
      validateBoundedText(value, "PlanRequestV1 constraint context", 4_096)
    );
  }
  for (const value of request.known_uncertainties) {
    collectIssue(issues, () =>
      validateBoundedText(value.statement, "PlanRequestV1 uncertainty", 4_096)
    );
  }
  for (const value of request.prior_decisions) {
    collectIssue(issues, () =>
      validateBoundedText(value.statement, "PlanRequestV1 prior decision", 4_096)
    );
    collectIssue(issues, () =>
      validateBoundedText(value.binding_effect, "PlanRequestV1 prior binding effect", 4_096)
    );
  }
  collectIssue(issues, () =>
    assertCanonicalUnique(request.desired_outcomes, "PlanRequestV1 desired outcomes")
  );
  collectIssue(issues, () =>
    assertCanonicalUnique(request.hard_constraints, "PlanRequestV1 hard constraints")
  );
  collectIssue(issues, () => assertCanonicalUnique(request.non_goals, "PlanRequestV1 non-goals"));
  collectIssue(issues, () =>
    assertCanonicalUnique(request.known_uncertainties, "PlanRequestV1 known uncertainties")
  );
  collectIssue(issues, () =>
    assertCanonicalUnique(request.prior_decisions, "PlanRequestV1 prior decisions")
  );
  collectIssue(issues, () => assertUnique(request.input_artifact_ids, "PlanRequestV1 input IDs"));
  if (
    canonicalJson(request.input_artifact_ids) !==
    canonicalJson(sortedStrings(request.input_artifact_ids))
  ) {
    issues.push("PlanRequestV1 input artifact IDs must be lexicographically sorted");
  }
  const { request_id: ignoredRequestId, ...seed } = request;
  void ignoredRequestId;
  if (request.request_id !== stablePlanId("plan-request", seed)) {
    issues.push("PlanRequestV1 request_id does not match its canonical request seed");
  }
  const safe = sanitizedIssues(issues);
  if (safe.length > 0) throw new SkillSchemaValidationError("PlanRequestV1", safe);
}

export function validatePlanRequest(value: unknown): PlanRequestV1 {
  const request = validateSkillSchema(PlanRequestV1Schema, value, "PlanRequestV1");
  validatePlanRequestContent(request);
  return request;
}

export function canonicalizePlanRequest(input: {
  readonly goal: string;
  readonly constraints: unknown;
  readonly exactInputArtifactIds: readonly string[];
}): PlanRequestV1 {
  validateBoundedText(input.goal, "PlanRequestV1 admitted goal", 16_384, 1);
  const constraints = validateSkillSchema(
    PlanRequestConstraintsV1Schema,
    input.constraints,
    "PlanRequestConstraintsV1"
  );
  if (input.exactInputArtifactIds.length > MAX_PLAN_INPUTS) {
    throw new SkillSchemaValidationError("PlanRequestV1", [
      `at most ${MAX_PLAN_INPUTS} exact inputs are permitted`,
    ]);
  }
  const seed = planRequestSeed({
    goal: input.goal,
    constraints,
    inputArtifactIds: input.exactInputArtifactIds,
  });
  return validatePlanRequest({
    ...seed,
    request_id: stablePlanId("plan-request", seed),
  });
}

export function planRequestConstraints(value: unknown): PlanRequestConstraintsV1 {
  const request = validatePlanRequest(value);
  return {
    schema_version: 1,
    desired_outcomes: request.desired_outcomes,
    current_state: request.current_state,
    hard_constraints: request.hard_constraints,
    non_goals: request.non_goals,
    known_uncertainties: request.known_uncertainties,
    prior_decisions: request.prior_decisions,
  };
}

export function planRequestSha256(value: unknown): string {
  return sha256(canonicalJson(validatePlanRequest(value)));
}

export interface PlanRequestItemIdsV1 {
  readonly desired_outcome_ids: readonly string[];
  readonly current_state_fact_ids: readonly string[];
  readonly hard_constraint_ids: readonly string[];
  readonly non_goal_ids: readonly string[];
  readonly uncertainty_ids: readonly string[];
  readonly prior_decision_ids: readonly string[];
}

export function planRequestItemIds(value: unknown): PlanRequestItemIdsV1 {
  const request = validatePlanRequest(value);
  return {
    desired_outcome_ids: request.desired_outcomes.map((item) =>
      stablePlanId("desired-outcome", item)
    ),
    current_state_fact_ids:
      request.current_state.status === "provided"
        ? request.current_state.facts.map((item) => stablePlanId("current-state-fact", item))
        : [],
    hard_constraint_ids: request.hard_constraints.map((item) =>
      stablePlanId("hard-constraint", item)
    ),
    non_goal_ids: request.non_goals.map((item) => stablePlanId("non-goal", item)),
    uncertainty_ids: request.known_uncertainties.map((item) => stablePlanId("uncertainty", item)),
    prior_decision_ids: request.prior_decisions.map((item) => stablePlanId("prior-decision", item)),
  };
}

function validateCoreShape(value: unknown): StrategyCoreV1 {
  const core = validateSkillSchema(StrategyCoreV1Schema, value, "StrategyCoreV1");
  const issues: string[] = [];
  collectIssue(issues, () =>
    validateBoundedText(core.applicability_reason, "StrategyCoreV1 applicability reason", 4_096, 1)
  );
  for (const outcome of core.outcomes) {
    collectIssue(issues, () =>
      validateBoundedText(outcome.statement, "StrategyCoreV1 outcome statement", 512, 1)
    );
    collectIssue(issues, () =>
      validateBoundedText(outcome.success_signal, "StrategyCoreV1 success signal", 512, 1)
    );
    collectIssue(issues, () =>
      assertUnique(
        outcome.desired_outcome_indexes.map(String),
        "StrategyCoreV1 desired-outcome indexes"
      )
    );
  }
  for (const blocker of core.blockers) {
    collectIssue(issues, () => validateBoundedText(blocker, "StrategyCoreV1 blocker", 512, 1));
  }
  collectIssue(issues, () =>
    assertCanonicalUnique(core.dependencies, "StrategyCoreV1 dependencies")
  );
  collectIssue(issues, () => assertCanonicalUnique(core.blockers, "StrategyCoreV1 blockers"));
  const safe = sanitizedIssues(issues);
  if (safe.length > 0) throw new SkillSchemaValidationError("StrategyCoreV1", safe);
  return core;
}

function indexesInRange(
  issues: string[],
  values: readonly number[],
  length: number,
  label: string
): void {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0 || value >= length)) {
    issues.push(`${label} contains an out-of-range index`);
  }
  if (new Set(values).size !== values.length) issues.push(`${label} contains a duplicate index`);
}

function graphHasCycle(
  outcomeCount: number,
  dependencies: StrategyCoreV1["dependencies"]
): boolean {
  const outgoing = Array.from({ length: outcomeCount }, () => new Set<number>());
  for (const dependency of dependencies) {
    if (
      dependency.from_outcome_index >= 0 &&
      dependency.from_outcome_index < outcomeCount &&
      dependency.to_outcome_index >= 0 &&
      dependency.to_outcome_index < outcomeCount
    ) {
      outgoing[dependency.from_outcome_index]?.add(dependency.to_outcome_index);
    }
  }
  const state = new Array<number>(outcomeCount).fill(0);
  const visit = (index: number): boolean => {
    if (state[index] === 1) return true;
    if (state[index] === 2) return false;
    state[index] = 1;
    for (const next of outgoing[index] ?? []) {
      if (visit(next)) return true;
    }
    state[index] = 2;
    return false;
  };
  return range(outcomeCount).some((index) => visit(index));
}

function expectedCoverageLengths(request: PlanRequestV1) {
  return {
    current: request.current_state.status === "provided" ? request.current_state.facts.length : 0,
    inputs: request.input_artifact_ids.length,
    hard: request.hard_constraints.length,
    nonGoals: request.non_goals.length,
    uncertainties: request.known_uncertainties.length,
    prior: request.prior_decisions.length,
    desired: request.desired_outcomes.length,
  };
}

function strategySemanticIssues(core: StrategyCoreV1, request: PlanRequestV1): readonly string[] {
  const issues: string[] = [];
  const lengths = expectedCoverageLengths(request);
  for (const outcome of core.outcomes) {
    indexesInRange(
      issues,
      outcome.desired_outcome_indexes,
      lengths.desired,
      "outcomes[].desired_outcome_indexes"
    );
  }
  for (const dependency of core.dependencies) {
    indexesInRange(
      issues,
      [dependency.from_outcome_index, dependency.to_outcome_index],
      core.outcomes.length,
      "dependency endpoints"
    );
    if (dependency.from_outcome_index === dependency.to_outcome_index) {
      issues.push("dependency self-edges are forbidden");
    }
  }
  if (graphHasCycle(core.outcomes.length, core.dependencies)) {
    issues.push("strategy dependency graph must be acyclic");
  }
  const coverage = core.request_coverage;
  const coverageFields = [
    [coverage.current_state_fact_indexes, lengths.current, "current-state coverage"],
    [coverage.input_artifact_slots, lengths.inputs, "input-artifact coverage"],
    [coverage.hard_constraint_indexes, lengths.hard, "hard-constraint coverage"],
    [coverage.non_goal_indexes, lengths.nonGoals, "non-goal coverage"],
    [coverage.uncertainty_indexes, lengths.uncertainties, "uncertainty coverage"],
    [coverage.prior_decision_indexes, lengths.prior, "prior-decision coverage"],
    [coverage.blocked_desired_outcome_indexes, lengths.desired, "blocked desired-outcome coverage"],
  ] as const;
  for (const [values, length, label] of coverageFields) {
    indexesInRange(issues, values, length, label);
  }
  const linked = core.outcomes.flatMap((outcome) => outcome.desired_outcome_indexes);
  const exactCoverage =
    sameNumbers(coverage.current_state_fact_indexes, range(lengths.current)) &&
    sameNumbers(coverage.input_artifact_slots, range(lengths.inputs)) &&
    sameNumbers(coverage.hard_constraint_indexes, range(lengths.hard)) &&
    sameNumbers(coverage.non_goal_indexes, range(lengths.nonGoals)) &&
    sameNumbers(coverage.uncertainty_indexes, range(lengths.uncertainties)) &&
    sameNumbers(coverage.prior_decision_indexes, range(lengths.prior));

  if (core.disposition === "ready") {
    if (core.outcomes.length === 0) issues.push("ready strategy requires at least one outcome");
    if (!sameNumbers(linked, range(lengths.desired))) {
      issues.push("ready strategy outcomes must cover every desired outcome");
    }
    if (core.blockers.length !== 0) issues.push("ready strategy cannot contain blockers");
    if (coverage.blocked_desired_outcome_indexes.length !== 0) {
      issues.push("ready strategy cannot block desired outcomes");
    }
    if (!exactCoverage) issues.push("ready strategy request coverage must be exact");
  } else if (core.disposition === "blocked") {
    if (core.blockers.length === 0) issues.push("blocked strategy requires at least one blocker");
    if (coverage.blocked_desired_outcome_indexes.length === 0) {
      issues.push("blocked strategy requires at least one blocked desired outcome");
    }
    if (
      !sameNumbers([...linked, ...coverage.blocked_desired_outcome_indexes], range(lengths.desired))
    ) {
      issues.push("blocked strategy linked and blocked outcomes must cover every desired outcome");
    }
    if (!exactCoverage) issues.push("blocked strategy request coverage must be exact");
  } else if (
    core.outcomes.length !== 0 ||
    core.dependencies.length !== 0 ||
    core.blockers.length !== 0 ||
    coverage.current_state_fact_indexes.length !== 0 ||
    coverage.input_artifact_slots.length !== 0 ||
    coverage.hard_constraint_indexes.length !== 0 ||
    coverage.non_goal_indexes.length !== 0 ||
    coverage.uncertainty_indexes.length !== 0 ||
    coverage.prior_decision_indexes.length !== 0 ||
    coverage.blocked_desired_outcome_indexes.length !== 0
  ) {
    issues.push(
      "not_applicable strategy must contain no outcomes, dependencies, blockers, or coverage claims"
    );
  }
  const projectedOutcomeSeeds = core.outcomes.map((outcome) => ({
    statement: outcome.statement,
    desired_outcome_indexes: [...outcome.desired_outcome_indexes].sort((a, b) => a - b),
    success_signal: outcome.success_signal,
  }));
  if (
    new Set(projectedOutcomeSeeds.map((seed) => canonicalJson(seed))).size !== core.outcomes.length
  ) {
    issues.push("strategy outcomes must be semantically unique");
  }
  return sanitizedIssues(issues);
}

export function validateStrategyCore(
  value: unknown,
  input: { readonly request: unknown }
): StrategyCoreV1 {
  const request = validatePlanRequest(input.request);
  let core: StrategyCoreV1;
  try {
    core = validateCoreShape(value);
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? error.issues
        : [error instanceof Error ? error.message : "closed schema validation failed"];
    throw new StrategyDraftValidationError("SCHEMA_INVALID", sanitizedIssues(issues));
  }
  const issues = strategySemanticIssues(core, request);
  if (issues.length > 0) throw new StrategyDraftValidationError("SEMANTIC_INVALID", issues);
  return core;
}

function coreFromDraft(draft: StrategyDraftV1): StrategyCoreV1 {
  return {
    schema_version: draft.schema_version,
    disposition: draft.disposition,
    applicability_reason: draft.applicability_reason,
    outcomes: draft.outcomes,
    dependencies: draft.dependencies,
    request_coverage: draft.request_coverage,
    blockers: draft.blockers,
    confidence: draft.confidence,
  };
}

function validateDraftShape(value: unknown): StrategyDraftV1 {
  const draft = validateSkillSchema(StrategyDraftV1Schema, value, "StrategyDraftV1");
  const issues: string[] = [];
  collectIssue(issues, () =>
    validateBoundedText(
      draft.strategy_report,
      "StrategyDraftV1 strategy report",
      MAX_STRATEGY_PROSE_BYTES,
      1
    )
  );
  collectIssue(issues, () => validateCoreShape(coreFromDraft(draft)));
  const safe = sanitizedIssues(issues);
  if (safe.length > 0) throw new SkillSchemaValidationError("StrategyDraftV1", safe);
  return draft;
}

export function validateStrategyDraft(
  value: unknown,
  input: { readonly request: unknown }
): StrategyDraftV1 {
  const request = validatePlanRequest(input.request);
  let draft: StrategyDraftV1;
  try {
    draft = validateDraftShape(value);
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? error.issues
        : [error instanceof Error ? error.message : "closed schema validation failed"];
    throw new StrategyDraftValidationError("SCHEMA_INVALID", sanitizedIssues(issues));
  }
  const semantic = strategySemanticIssues(coreFromDraft(draft), request);
  if (semantic.length > 0) throw new StrategyDraftValidationError("SEMANTIC_INVALID", semantic);
  return draft;
}

function draftFailure(
  failureClass: StrategyDraftFailureClassV1,
  issues: string | readonly string[]
): StrategyDraftValidationError {
  return new StrategyDraftValidationError(
    failureClass,
    sanitizedIssues(typeof issues === "string" ? [issues] : issues)
  );
}

function countLineStartMarker(value: string, marker: string): number {
  return value.split("\n").filter((line) => line.startsWith(marker)).length;
}

export function parsePersistedStrategyRoutingSummary(
  value: string
): StrategyRoutingSummaryV1 | undefined {
  if (
    Buffer.byteLength(value, "utf8") > MAX_STRATEGY_SUMMARY_LINE_BYTES ||
    !value.startsWith("SUMMARY:")
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice("SUMMARY:".length));
  } catch {
    return undefined;
  }
  try {
    return validateSkillSchema(
      StrategyRoutingSummaryV1Schema,
      parsed,
      "StrategyDraftV1 routing summary"
    );
  } catch {
    return undefined;
  }
}

export function parseStrategyDraft(
  bytes: Uint8Array,
  input: { readonly request: unknown }
): { readonly draft: StrategyDraftV1; readonly summary: StrategyRoutingSummaryV1 } {
  const body = Buffer.from(bytes);
  if (body.byteLength === 0 || body.byteLength > MAX_PERSISTED_STRATEGY_DRAFT_BYTES) {
    throw draftFailure(
      "FRAMING_INVALID",
      `StrategyDraftV1 output must be 1..${MAX_PERSISTED_STRATEGY_DRAFT_BYTES} bytes`
    );
  }
  const framingIssues: string[] = [];
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    framingIssues.push("StrategyDraftV1 output forbids BOM");
  }
  if (body.includes(0)) framingIssues.push("StrategyDraftV1 output forbids NUL");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw draftFailure("FRAMING_INVALID", "StrategyDraftV1 output is not strict UTF-8");
  }
  if (text.includes("\ufeff")) framingIssues.push("StrategyDraftV1 output forbids BOM");
  if (text.includes("\r")) framingIssues.push("StrategyDraftV1 output forbids CR");
  if (text.includes("```")) framingIssues.push("StrategyDraftV1 output forbids code fences");
  const framed = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (framed.endsWith("\n")) framingIssues.push("StrategyDraftV1 permits at most one trailing LF");
  if (countLineStartMarker(framed, "STRATEGY_CORE:") !== 1) {
    framingIssues.push("StrategyDraftV1 requires exactly one line-start STRATEGY_CORE marker");
  }
  if (countLineStartMarker(framed, "SUMMARY:") !== 1) {
    framingIssues.push("StrategyDraftV1 requires exactly one line-start SUMMARY marker");
  }
  const lines = framed.split("\n");
  const nonemptyIndexes = lines.flatMap((line, index) => (line.length === 0 ? [] : [index]));
  const coreIndex = nonemptyIndexes.at(-2);
  const summaryIndex = nonemptyIndexes.at(-1);
  const coreLine = coreIndex === undefined ? "" : (lines[coreIndex] ?? "");
  const summaryLine = summaryIndex === undefined ? "" : (lines[summaryIndex] ?? "");
  if (!coreLine.startsWith("STRATEGY_CORE:") || !summaryLine.startsWith("SUMMARY:")) {
    framingIssues.push("STRATEGY_CORE and SUMMARY must be the final two nonempty lines");
  }
  if (
    Buffer.byteLength(coreLine, "utf8") > MAX_STRATEGY_CORE_LINE_BYTES ||
    coreLine.slice("STRATEGY_CORE:".length).includes("\n")
  ) {
    framingIssues.push(`STRATEGY_CORE line must be at most ${MAX_STRATEGY_CORE_LINE_BYTES} bytes`);
  }
  if (Buffer.byteLength(summaryLine, "utf8") > MAX_STRATEGY_SUMMARY_LINE_BYTES) {
    framingIssues.push(`SUMMARY line must be at most ${MAX_STRATEGY_SUMMARY_LINE_BYTES} bytes`);
  }
  const summary = parsePersistedStrategyRoutingSummary(summaryLine);
  if (summary === undefined) framingIssues.push("StrategyDraftV1 SUMMARY is invalid");
  let strategyReport = "";
  if (coreIndex !== undefined) {
    const prefixLines = lines.slice(0, coreIndex);
    strategyReport = prefixLines.join("\n");
  }
  const reportBytes = Buffer.byteLength(strategyReport, "utf8");
  if (
    reportBytes < 1 ||
    reportBytes > MAX_STRATEGY_PROSE_BYTES ||
    strategyReport.trim().length === 0
  ) {
    framingIssues.push(
      `strategy prose must be nonempty and at most ${MAX_STRATEGY_PROSE_BYTES} UTF-8 bytes`
    );
  }
  if (framingIssues.length > 0 || summary === undefined) {
    throw draftFailure("FRAMING_INVALID", framingIssues);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(coreLine.slice("STRATEGY_CORE:".length));
  } catch {
    throw draftFailure("JSON_INVALID", "StrategyDraftV1 STRATEGY_CORE footer is not JSON");
  }
  let draft: StrategyDraftV1;
  try {
    const core = validateCoreShape(parsed);
    draft = validateDraftShape({ strategy_report: strategyReport, ...core });
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? error.issues
        : [error instanceof Error ? error.message : "closed schema validation failed"];
    throw draftFailure("SCHEMA_INVALID", issues);
  }
  const semanticIssues = [
    ...strategySemanticIssues(coreFromDraft(draft), validatePlanRequest(input.request)),
    ...(draft.confidence === summary.confidence
      ? []
      : ["StrategyDraftV1 footer and SUMMARY confidence must match"]),
  ];
  if (semanticIssues.length > 0) throw draftFailure("SEMANTIC_INVALID", semanticIssues);
  return { draft, summary };
}

function mappedValues<T>(indexes: readonly number[], values: readonly T[], label: string): T[] {
  return indexes.map((index) => {
    const value = values[index];
    if (value === undefined) throw new Error(`${label} index ${index} is out of range`);
    return value;
  });
}

export function projectStrategyDraft(
  value: unknown,
  input: { readonly request: unknown }
): StrategySemanticProjectionV1 {
  const request = validatePlanRequest(input.request);
  const draft = validateStrategyDraft(value, { request });
  const itemIds = planRequestItemIds(request);
  const outcomeEntries = draft.outcomes.map((outcome) => {
    const seed = {
      statement: outcome.statement,
      desired_outcome_ids: sortedStrings(
        mappedValues(
          outcome.desired_outcome_indexes,
          itemIds.desired_outcome_ids,
          "desired outcome"
        )
      ),
      success_signal: outcome.success_signal,
    };
    return { outcome_id: stablePlanId("strategy-outcome", seed), ...seed };
  });
  const outcomeIds = outcomeEntries.map((outcome) => outcome.outcome_id);
  const outcomes = [...outcomeEntries].sort((left, right) =>
    left.outcome_id.localeCompare(right.outcome_id)
  );
  const dependencies = draft.dependencies
    .map((dependency) => ({
      from_outcome_id: mappedValues(
        [dependency.from_outcome_index],
        outcomeIds,
        "dependency from outcome"
      )[0],
      to_outcome_id: mappedValues(
        [dependency.to_outcome_index],
        outcomeIds,
        "dependency to outcome"
      )[0],
      kind: dependency.kind,
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (
    dependencies.some(
      (dependency) =>
        dependency.from_outcome_id === undefined || dependency.to_outcome_id === undefined
    )
  ) {
    throw new Error("strategy dependency projection failed");
  }
  return validateSkillSchema(
    StrategySemanticProjectionV1Schema,
    {
      schema_version: 1,
      disposition: draft.disposition,
      applicability_reason: draft.applicability_reason,
      outcomes,
      dependencies,
      request_coverage: {
        current_state_fact_ids: sortedStrings(
          mappedValues(
            draft.request_coverage.current_state_fact_indexes,
            itemIds.current_state_fact_ids,
            "current-state fact"
          )
        ),
        input_artifact_ids: sortedStrings(
          mappedValues(
            draft.request_coverage.input_artifact_slots,
            request.input_artifact_ids,
            "input artifact"
          )
        ),
        hard_constraint_ids: sortedStrings(
          mappedValues(
            draft.request_coverage.hard_constraint_indexes,
            itemIds.hard_constraint_ids,
            "hard constraint"
          )
        ),
        non_goal_ids: sortedStrings(
          mappedValues(draft.request_coverage.non_goal_indexes, itemIds.non_goal_ids, "non-goal")
        ),
        uncertainty_ids: sortedStrings(
          mappedValues(
            draft.request_coverage.uncertainty_indexes,
            itemIds.uncertainty_ids,
            "uncertainty"
          )
        ),
        prior_decision_ids: sortedStrings(
          mappedValues(
            draft.request_coverage.prior_decision_indexes,
            itemIds.prior_decision_ids,
            "prior decision"
          )
        ),
        blocked_desired_outcome_ids: sortedStrings(
          mappedValues(
            draft.request_coverage.blocked_desired_outcome_indexes,
            itemIds.desired_outcome_ids,
            "blocked desired outcome"
          )
        ),
      },
      blockers: sortedStrings(draft.blockers),
      confidence: draft.confidence,
      execution_started: false,
    },
    "Strategy semantic projection"
  );
}

export function strategySourceLineageSha256(value: unknown): string {
  return sha256(
    canonicalJson(
      validateSkillSchema(
        StrategySourceLineagePreimageV1Schema,
        value,
        "StrategyV1 source lineage preimage"
      )
    )
  );
}

function strategyIdSeed(input: {
  readonly projection: StrategySemanticProjectionV1;
  readonly requestSha256: string;
  readonly strategyReport: string;
}): unknown {
  return {
    semantic_product: input.projection,
    request_sha256: input.requestSha256,
    strategy_report_sha256: sha256(Buffer.from(input.strategyReport, "utf8")),
  };
}

function semanticProjectionFromStrategy(strategy: StrategyV1): StrategySemanticProjectionV1 {
  return validateSkillSchema(
    StrategySemanticProjectionV1Schema,
    {
      schema_version: 1,
      disposition: strategy.disposition,
      applicability_reason: strategy.applicability_reason,
      outcomes: strategy.outcomes,
      dependencies: strategy.dependencies,
      request_coverage: strategy.request_coverage,
      blockers: strategy.blockers,
      confidence: strategy.confidence,
      execution_started: strategy.execution_started,
    },
    "StrategyV1 semantic projection"
  );
}

function coreFromStrategy(strategy: StrategyV1, request: PlanRequestV1): StrategyCoreV1 {
  const itemIds = planRequestItemIds(request);
  const outcomeIndex = new Map(
    strategy.outcomes.map((outcome, index) => [outcome.outcome_id, index])
  );
  const indexValues = (
    ids: readonly string[],
    values: readonly string[],
    label: string
  ): number[] =>
    ids.map((id) => {
      const index = values.indexOf(id);
      if (index < 0) throw new Error(`${label} contains an unknown stable ID`);
      return index;
    });
  return {
    schema_version: 1,
    disposition: strategy.disposition,
    applicability_reason: strategy.applicability_reason,
    outcomes: strategy.outcomes.map((outcome) => {
      const expectedId = stablePlanId("strategy-outcome", {
        statement: outcome.statement,
        desired_outcome_ids: outcome.desired_outcome_ids,
        success_signal: outcome.success_signal,
      });
      if (outcome.outcome_id !== expectedId)
        throw new Error("StrategyV1 outcome stable ID drifted");
      return {
        statement: outcome.statement,
        desired_outcome_indexes: indexValues(
          outcome.desired_outcome_ids,
          itemIds.desired_outcome_ids,
          "StrategyV1 desired outcomes"
        ),
        success_signal: outcome.success_signal,
      };
    }),
    dependencies: strategy.dependencies.map((dependency) => {
      const from = outcomeIndex.get(dependency.from_outcome_id);
      const to = outcomeIndex.get(dependency.to_outcome_id);
      if (from === undefined || to === undefined)
        throw new Error("StrategyV1 dependency endpoint is unknown");
      return { from_outcome_index: from, to_outcome_index: to, kind: dependency.kind };
    }),
    request_coverage: {
      current_state_fact_indexes: indexValues(
        strategy.request_coverage.current_state_fact_ids,
        itemIds.current_state_fact_ids,
        "StrategyV1 current-state coverage"
      ),
      input_artifact_slots: indexValues(
        strategy.request_coverage.input_artifact_ids,
        request.input_artifact_ids,
        "StrategyV1 input coverage"
      ),
      hard_constraint_indexes: indexValues(
        strategy.request_coverage.hard_constraint_ids,
        itemIds.hard_constraint_ids,
        "StrategyV1 hard-constraint coverage"
      ),
      non_goal_indexes: indexValues(
        strategy.request_coverage.non_goal_ids,
        itemIds.non_goal_ids,
        "StrategyV1 non-goal coverage"
      ),
      uncertainty_indexes: indexValues(
        strategy.request_coverage.uncertainty_ids,
        itemIds.uncertainty_ids,
        "StrategyV1 uncertainty coverage"
      ),
      prior_decision_indexes: indexValues(
        strategy.request_coverage.prior_decision_ids,
        itemIds.prior_decision_ids,
        "StrategyV1 prior-decision coverage"
      ),
      blocked_desired_outcome_indexes: indexValues(
        strategy.request_coverage.blocked_desired_outcome_ids,
        itemIds.desired_outcome_ids,
        "StrategyV1 blocked desired outcomes"
      ),
    },
    blockers: strategy.blockers,
    confidence: strategy.confidence,
  };
}

function assertSorted(values: readonly string[], label: string): void {
  if (canonicalJson(values) !== canonicalJson(sortedStrings(values))) {
    throw new Error(`${label} is not in canonical order`);
  }
}

export function validateStrategy(value: unknown): StrategyV1 {
  const strategy = validateSkillSchema(StrategyV1Schema, value, "StrategyV1");
  const request = validatePlanRequest(strategy.request);
  validateBoundedText(
    strategy.strategy_report,
    "StrategyV1 strategy report",
    MAX_STRATEGY_PROSE_BYTES,
    1
  );
  if (strategy.request_sha256 !== planRequestSha256(request)) {
    throw new Error("StrategyV1 request digest drifted");
  }
  const lineagePreimage: StrategySourceLineagePreimageV1 = {
    request_artifact_id: strategy.source_lineage.request_artifact_id,
    draft_artifact_id: strategy.source_lineage.draft_artifact_id,
    draft_sha256: strategy.source_lineage.draft_sha256,
    input_artifact_ids: strategy.source_lineage.input_artifact_ids,
  };
  assertUnique(
    [
      lineagePreimage.request_artifact_id,
      lineagePreimage.draft_artifact_id,
      ...lineagePreimage.input_artifact_ids,
    ],
    "StrategyV1 lineage artifact IDs"
  );
  assertSorted(lineagePreimage.input_artifact_ids, "StrategyV1 lineage input artifact IDs");
  if (
    canonicalJson(lineagePreimage.input_artifact_ids) !== canonicalJson(request.input_artifact_ids)
  ) {
    throw new Error("StrategyV1 lineage inputs drifted from the request");
  }
  if (strategy.source_lineage.lineage_sha256 !== strategySourceLineageSha256(lineagePreimage)) {
    throw new Error("StrategyV1 lineage digest drifted");
  }
  assertSorted(
    strategy.outcomes.map((outcome) => outcome.outcome_id),
    "StrategyV1 outcomes"
  );
  assertSorted(strategy.blockers, "StrategyV1 blockers");
  for (const outcome of strategy.outcomes) {
    assertSorted(outcome.desired_outcome_ids, "StrategyV1 outcome desired IDs");
  }
  for (const [values, label] of [
    [strategy.request_coverage.current_state_fact_ids, "current-state coverage"],
    [strategy.request_coverage.input_artifact_ids, "input coverage"],
    [strategy.request_coverage.hard_constraint_ids, "hard-constraint coverage"],
    [strategy.request_coverage.non_goal_ids, "non-goal coverage"],
    [strategy.request_coverage.uncertainty_ids, "uncertainty coverage"],
    [strategy.request_coverage.prior_decision_ids, "prior-decision coverage"],
    [strategy.request_coverage.blocked_desired_outcome_ids, "blocked desired outcomes"],
  ] as const) {
    assertSorted(values, `StrategyV1 ${label}`);
  }
  const sortedDependencies = [...strategy.dependencies].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right))
  );
  if (canonicalJson(sortedDependencies) !== canonicalJson(strategy.dependencies)) {
    throw new Error("StrategyV1 dependencies are not in canonical order");
  }
  validateStrategyCore(coreFromStrategy(strategy, request), { request });
  const projection = semanticProjectionFromStrategy(strategy);
  const expectedStrategyId = stablePlanId(
    "strategy",
    strategyIdSeed({
      projection,
      requestSha256: strategy.request_sha256,
      strategyReport: strategy.strategy_report,
    })
  );
  if (strategy.strategy_id !== expectedStrategyId)
    throw new Error("StrategyV1 strategy_id drifted");
  return strategy;
}

export function sealStrategy(input: {
  readonly request: unknown;
  readonly draft: unknown;
  readonly draftBytes: Uint8Array;
  readonly requestSha256: string;
  readonly sourceRequestArtifactId: string;
  readonly sourceDraftArtifactId: string;
  readonly exactInputArtifactIds: readonly string[];
}): StrategyV1 {
  const request = validatePlanRequest(input.request);
  const requestSha256 = planRequestSha256(request);
  if (input.requestSha256 !== requestSha256) throw new Error("StrategyV1 request binding is stale");
  const inputArtifactIds = sortedStrings(input.exactInputArtifactIds);
  if (canonicalJson(inputArtifactIds) !== canonicalJson(request.input_artifact_ids)) {
    throw new Error("StrategyV1 exact inputs drifted from the request");
  }
  const parsed = parseStrategyDraft(input.draftBytes, { request });
  const draft = validateStrategyDraft(input.draft, { request });
  if (canonicalJson(parsed.draft) !== canonicalJson(draft)) {
    throw new Error("StrategyV1 source draft bytes and parsed draft disagree");
  }
  const projection = projectStrategyDraft(draft, { request });
  const sourceLineage: StrategySourceLineagePreimageV1 = validateSkillSchema(
    StrategySourceLineagePreimageV1Schema,
    {
      request_artifact_id: input.sourceRequestArtifactId,
      draft_artifact_id: input.sourceDraftArtifactId,
      draft_sha256: sha256(Buffer.from(input.draftBytes)),
      input_artifact_ids: inputArtifactIds,
    },
    "StrategyV1 source lineage"
  );
  return validateStrategy({
    schema_version: 1,
    strategy_id: stablePlanId(
      "strategy",
      strategyIdSeed({
        projection,
        requestSha256,
        strategyReport: draft.strategy_report,
      })
    ),
    strategy_report: draft.strategy_report,
    disposition: projection.disposition,
    applicability_reason: projection.applicability_reason,
    outcomes: projection.outcomes,
    dependencies: projection.dependencies,
    request_coverage: projection.request_coverage,
    blockers: projection.blockers,
    confidence: projection.confidence,
    request,
    request_sha256: requestSha256,
    source_lineage: {
      ...sourceLineage,
      lineage_sha256: strategySourceLineageSha256(sourceLineage),
    },
    execution_started: false,
  });
}

export function assertStrategyLineage(input: {
  readonly strategy: unknown;
  readonly request: unknown;
  readonly draft: unknown;
  readonly draftBytes: Uint8Array;
  readonly requestArtifactId: string;
  readonly draftArtifactId: string;
  readonly exactInputArtifactIds: readonly string[];
}): StrategyV1 {
  const request = validatePlanRequest(input.request);
  const expected = sealStrategy({
    request,
    draft: input.draft,
    draftBytes: input.draftBytes,
    requestSha256: planRequestSha256(request),
    sourceRequestArtifactId: input.requestArtifactId,
    sourceDraftArtifactId: input.draftArtifactId,
    exactInputArtifactIds: input.exactInputArtifactIds,
  });
  const strategy = validateStrategy(input.strategy);
  if (canonicalJson(strategy) !== canonicalJson(expected)) {
    throw new Error("StrategyV1 request, draft, or host-sealed lineage diverged");
  }
  return strategy;
}

export function validateCanonicalStrategyBytes(bytes: Uint8Array, ref?: ArtifactRef): StrategyV1 {
  const body = Buffer.from(bytes);
  if (
    ref !== undefined &&
    (ref.kind !== "strategy" ||
      ref.content_schema?.schema_id !== "penny.strategy.v1" ||
      ref.content_schema.schema_version !== 1 ||
      ref.byte_length !== body.byteLength ||
      ref.content_digest !== sha256(body) ||
      ref.store_ref !== `artifact://sha256/${ref.content_digest}`)
  ) {
    throw new Error("StrategyV1 artifact ref is stale or has the wrong semantic identity");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("StrategyV1 artifact is not JSON");
  }
  const strategy = validateStrategy(parsed);
  if (canonicalJson(strategy) !== body.toString("utf8")) {
    throw new Error("StrategyV1 artifact bytes are not canonical JSON");
  }
  return strategy;
}

export function validateStrategySealFeedback(value: unknown): StrategySealFeedbackV1 {
  const feedback = validateSkillSchema(
    StrategySealFeedbackV1Schema,
    value,
    "StrategySealFeedbackV1"
  );
  for (const issue of feedback.issues) {
    validateBoundedText(issue, "StrategySealFeedbackV1 issue", 512, 1);
  }
  return feedback;
}

export function strategyProductIntegrityId(
  value: Omit<StrategyProductIntegrityV1, "integrity_id">
): string {
  return sha256(canonicalJson(value));
}

export function validateStrategyProductIntegrity(value: unknown): StrategyProductIntegrityV1 {
  const integrity = validateSkillSchema(
    StrategyProductIntegrityV1Schema,
    value,
    "StrategyProductIntegrityV1"
  );
  const expectedChecks = [
    "canonical_strategy",
    "exact_lineage",
    "signed_worker_evidence",
    "latest_validity_receipt",
    "latest_quality_receipt",
    "no_execution",
  ];
  if (canonicalJson(integrity.checks) !== canonicalJson(expectedChecks)) {
    throw new Error("StrategyProductIntegrityV1 checks are incomplete or reordered");
  }
  const refs = [
    integrity.request_ref,
    integrity.orientation_ref,
    integrity.admission_ref,
    ...integrity.evidence_refs,
    ...integrity.imported_input_refs,
    integrity.draft_ref,
    integrity.strategy_ref,
    integrity.vera_report_ref,
    integrity.carren_report_ref,
    integrity.validity_receipt_ref,
    integrity.quality_receipt_ref,
  ];
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "StrategyProductIntegrityV1 artifact refs"
  );
  if (
    integrity.request_ref.kind !== "plan-request" ||
    integrity.orientation_ref.phase !== "orienting_strategy" ||
    integrity.admission_ref.kind !== "evidence-admission" ||
    integrity.admission_ref.phase !== "strategy_evidence_gate" ||
    integrity.draft_ref.kind !== "strategy-draft" ||
    integrity.strategy_ref.kind !== "strategy" ||
    integrity.vera_report_ref.phase !== "verifying_strategy" ||
    integrity.carren_report_ref.phase !== "critiquing_strategy" ||
    integrity.validity_receipt_ref.kind !== "review-receipt" ||
    integrity.quality_receipt_ref.kind !== "review-receipt"
  ) {
    throw new Error("StrategyProductIntegrityV1 artifact roles disagree");
  }
  const { integrity_id: integrityId, ...body } = integrity;
  if (integrityId !== strategyProductIntegrityId(body)) {
    throw new Error("StrategyProductIntegrityV1 integrity_id is invalid");
  }
  return integrity;
}

export function strategyProductEnvelopeId(
  value: Omit<StrategyProductEnvelopeV1, "envelope_id">
): string {
  return sha256(canonicalJson(value));
}

export function validateStrategyProductEnvelope(value: unknown): StrategyProductEnvelopeV1 {
  const envelope = validateSkillSchema(
    StrategyProductEnvelopeV1Schema,
    value,
    "StrategyProductEnvelopeV1"
  );
  const refs = [
    envelope.request_ref,
    envelope.orientation_ref,
    envelope.admission_ref,
    ...envelope.evidence_refs,
    ...envelope.imported_input_refs,
    envelope.draft_ref,
    envelope.strategy_ref,
    envelope.vera_report_ref,
    envelope.carren_report_ref,
    envelope.validity_receipt_ref,
    envelope.quality_receipt_ref,
    envelope.integrity_ref,
  ];
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "StrategyProductEnvelopeV1 artifact refs"
  );
  if (
    envelope.request_ref.kind !== "plan-request" ||
    envelope.orientation_ref.phase !== "orienting_strategy" ||
    envelope.admission_ref.kind !== "evidence-admission" ||
    envelope.admission_ref.phase !== "strategy_evidence_gate" ||
    envelope.draft_ref.kind !== "strategy-draft" ||
    envelope.strategy_ref.kind !== "strategy" ||
    envelope.vera_report_ref.phase !== "verifying_strategy" ||
    envelope.carren_report_ref.phase !== "critiquing_strategy" ||
    envelope.validity_receipt_ref.kind !== "review-receipt" ||
    envelope.quality_receipt_ref.kind !== "review-receipt" ||
    envelope.integrity_ref.kind !== "strategy-product-integrity"
  ) {
    throw new Error("StrategyProductEnvelopeV1 artifact roles disagree");
  }
  const { envelope_id: envelopeId, ...body } = envelope;
  if (envelopeId !== strategyProductEnvelopeId(body)) {
    throw new Error("StrategyProductEnvelopeV1 envelope_id is invalid");
  }
  return envelope;
}

export function strategyDraftPromptContract(): string {
  return canonicalJson({
    schema: StrategyCoreV1Schema,
    transport: {
      encoding: "strict UTF-8",
      maximum_output_bytes: MAX_PERSISTED_STRATEGY_DRAFT_BYTES,
      strategy_prose_bytes: { minimum: 1, maximum: MAX_STRATEGY_PROSE_BYTES },
      strategy_core_line_maximum_bytes: MAX_STRATEGY_CORE_LINE_BYTES,
      summary_line_maximum_bytes: MAX_STRATEGY_SUMMARY_LINE_BYTES,
      framing:
        "bounded strategy prose, STRATEGY_CORE:<single-line JSON>, then final SUMMARY; footer and summary are the final two nonempty lines",
      forbidden: ["BOM", "NUL", "CR", "code fences", "duplicate markers", "trailing content"],
      json_key_order_significant: false,
      insignificant_json_whitespace_significant: false,
    },
    prose_coverage: [
      "goal and current state",
      "outcomes",
      "meaningful dependencies",
      "assumptions with risks",
      "information gaps",
      "constraints and non-goals",
      "contingencies",
      "trade-offs",
      "disposition",
    ],
    ids: "model emits indexes only; host assigns every stable ID",
    execution: "forbidden; host product always sets execution_started:false",
    summary: { schema: StrategyRoutingSummaryV1Schema, confidence_must_equal_core: true },
  });
}
