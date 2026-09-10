import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { validateContract } from "../contracts.js";
import { Sha256Schema } from "./common.js";

/**
 * Effect categories governed by the Assess and Produce worker policy.
 * Host artifact persistence is deliberately not one of these categories.
 */
export const EFFECT_CATEGORIES = [
  "external_action",
  "filesystem_write",
  "test_execution",
  "task_change",
] as const;

export const ASSESS_EFFECT_PHASES = [
  "analyzing_assessment",
  "authoring_assessment",
  "verifying_assessment",
] as const;

export const PRODUCE_EFFECT_PHASES = [
  "exploring_artifact_approaches",
  "selecting_artifact_approach",
  "materializing_artifact",
  "critiquing_artifact",
  "verifying_artifact",
] as const;

export const EFFECT_WORKER_BY_PHASE: Readonly<Record<string, string>> = Object.freeze({
  analyzing_assessment: "annie",
  authoring_assessment: "carren",
  verifying_assessment: "vera",
  exploring_artifact_approaches: "ida",
  selecting_artifact_approach: "demetri",
  materializing_artifact: "skribble",
  critiquing_artifact: "carren",
  verifying_artifact: "vera",
});

export type EffectCategoryV1 = (typeof EFFECT_CATEGORIES)[number];
export type EffectAssuranceV1 = "unknown" | "bounded_no_violation" | "policy_violation";

export const UNKNOWN_EFFECT_LIMITATION =
  "Effect status is unknown for one or more policy-required categories; completion does not establish full confinement.";
export const BOUNDED_EFFECT_NOTICE =
  "Effect evidence is bounded to the declared worker/run/phase scope and does not establish full filesystem or process confinement.";
export const EFFECT_POLICY_VIOLATION_LIMITATION =
  "Observed worker/task effects violated an effect-absence policy; positive completion is blocked.";

const EffectCategorySchema = Type.Union([
  Type.Literal("external_action"),
  Type.Literal("filesystem_write"),
  Type.Literal("test_execution"),
  Type.Literal("task_change"),
]);

export const EffectScopeV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 512 }),
    subject: Type.Literal("worker_and_task_effects"),
    workers: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    phases: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    host_artifact_writes: Type.Literal("excluded"),
  },
  { additionalProperties: false }
);
export type EffectScopeV1 = Readonly<Static<typeof EffectScopeV1Schema>>;

export const EffectEvidenceRefV1Schema = Type.Object(
  {
    evidence_id: Type.String({ minLength: 1, maxLength: 1024 }),
    evidence_sha256: Sha256Schema,
    media_type: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false }
);
export type EffectEvidenceRefV1 = Readonly<Static<typeof EffectEvidenceRefV1Schema>>;

export const EffectCategoryEvidenceV1Schema = Type.Object(
  {
    category: EffectCategorySchema,
    policy: Type.Object(
      {
        requires_absence: Type.Literal(true),
        scope: EffectScopeV1Schema,
      },
      { additionalProperties: false }
    ),
    observation: Type.Object(
      {
        status: Type.Union([Type.Literal("unknown"), Type.Literal("observed")]),
        scope: Type.Union([EffectScopeV1Schema, Type.Null()]),
        coverage: Type.Union([
          Type.Literal("none"),
          Type.Literal("partial"),
          Type.Literal("complete"),
        ]),
        result: Type.Union([
          Type.Literal("unknown"),
          Type.Literal("no_event"),
          Type.Literal("violation"),
        ]),
        evidence_refs: Type.Array(EffectEvidenceRefV1Schema, {
          maxItems: 64,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false }
    ),
    prevention: Type.Object(
      {
        status: Type.Union([Type.Literal("unknown"), Type.Literal("enforced")]),
        control_id: Type.Union([Type.String({ minLength: 1, maxLength: 1024 }), Type.Null()]),
        scope: Type.Union([EffectScopeV1Schema, Type.Null()]),
        evidence_refs: Type.Array(EffectEvidenceRefV1Schema, {
          maxItems: 64,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type EffectCategoryEvidenceV1 = Readonly<Static<typeof EffectCategoryEvidenceV1Schema>>;

export const EffectEvidenceGraphV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.effect-evidence.v1"),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 512 }),
    host_artifact_writes: Type.Object(
      {
        classification: Type.Literal("host_control_plane_artifact_persistence"),
        included_in_worker_effect_assurance: Type.Literal(false),
      },
      { additionalProperties: false }
    ),
    categories: Type.Array(EffectCategoryEvidenceV1Schema, {
      minItems: 4,
      maxItems: 4,
      uniqueItems: true,
    }),
    assurance: Type.Union([
      Type.Literal("unknown"),
      Type.Literal("bounded_no_violation"),
      Type.Literal("policy_violation"),
    ]),
    limitations: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
      maxItems: 1,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type EffectEvidenceGraphV1 = Readonly<Static<typeof EffectEvidenceGraphV1Schema>>;

export interface EffectEvidenceRequestV1 {
  readonly schema_id: "penny.effect-evidence-request.v1";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly workers: readonly string[];
  readonly phases: readonly string[];
  readonly categories: readonly EffectCategoryV1[];
  readonly subject: "worker_and_task_effects";
  readonly host_artifact_writes: "excluded";
}

/**
 * Trusted host seam for an immutable effect-trace snapshot. Absence means unknown.
 * Implementations must be deterministic for an exact request; invalid evidence degrades to unknown.
 */
export interface EffectEvidenceProviderV1 {
  collect(request: EffectEvidenceRequestV1): unknown;
}

function workersForPhases(phases: readonly string[]): string[] {
  const workers: string[] = [];
  for (const phase of phases) {
    const worker = EFFECT_WORKER_BY_PHASE[phase];
    if (worker === undefined) throw new Error(`unknown effect-policy phase '${phase}'`);
    if (!workers.includes(worker)) workers.push(worker);
  }
  return workers;
}

function scope(runId: string, phases: readonly string[]): EffectScopeV1 {
  return {
    schema_version: 1,
    run_id: runId,
    subject: "worker_and_task_effects",
    workers: workersForPhases(phases),
    phases: [...phases],
    host_artifact_writes: "excluded",
  };
}

function sameScope(left: EffectScopeV1, right: EffectScopeV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function expectedAssurance(graph: EffectEvidenceGraphV1): EffectAssuranceV1 {
  if (graph.categories.some((entry) => entry.observation.result === "violation")) {
    return "policy_violation";
  }
  const everyCategoryBounded = graph.categories.every((entry) => {
    const observedNoEvent =
      entry.observation.status === "observed" &&
      entry.observation.coverage === "complete" &&
      entry.observation.result === "no_event" &&
      entry.observation.scope !== null &&
      sameScope(entry.observation.scope, entry.policy.scope);
    const prevented =
      entry.prevention.status === "enforced" &&
      entry.prevention.scope !== null &&
      sameScope(entry.prevention.scope, entry.policy.scope);
    return observedNoEvent || prevented;
  });
  return everyCategoryBounded ? "bounded_no_violation" : "unknown";
}

function expectedLimitations(assurance: EffectAssuranceV1): readonly string[] {
  switch (assurance) {
    case "unknown":
      return [UNKNOWN_EFFECT_LIMITATION];
    case "policy_violation":
      return [EFFECT_POLICY_VIOLATION_LIMITATION];
    case "bounded_no_violation":
      return [];
  }
}

function assertScopeShape(value: EffectScopeV1, label: string): void {
  if (new Set(value.phases).size !== value.phases.length) {
    throw new Error(`${label} phases must be unique`);
  }
  if (
    new Set(value.workers).size !== value.workers.length ||
    canonicalJson(value.workers) !== canonicalJson(workersForPhases(value.phases))
  ) {
    throw new Error(`${label} workers must be the canonical workers for its phases`);
  }
}

export function validateEffectEvidenceGraph(
  value: unknown,
  expected?: { readonly runId: string; readonly phases: readonly string[] }
): EffectEvidenceGraphV1 {
  const graph = validateContract(EffectEvidenceGraphV1Schema, value, "EffectEvidenceGraphV1");
  const categoryOrder = graph.categories.map((entry) => entry.category);
  if (canonicalJson(categoryOrder) !== canonicalJson(EFFECT_CATEGORIES)) {
    throw new Error("EffectEvidenceGraphV1 categories must be complete and canonical");
  }
  const policyScope = scope(graph.run_id, graph.categories[0]?.policy.scope.phases ?? []);
  for (const entry of graph.categories) {
    assertScopeShape(entry.policy.scope, `EffectEvidenceGraphV1 ${entry.category} policy scope`);
    if (
      entry.policy.scope.run_id !== graph.run_id ||
      entry.policy.scope.subject !== "worker_and_task_effects" ||
      entry.policy.scope.host_artifact_writes !== "excluded"
    ) {
      throw new Error(`EffectEvidenceGraphV1 ${entry.category} policy scope disagrees`);
    }
    if (!sameScope(entry.policy.scope, policyScope)) {
      throw new Error("EffectEvidenceGraphV1 category policy scopes must be identical");
    }
    if (entry.observation.status === "unknown") {
      if (
        entry.observation.scope !== null ||
        entry.observation.coverage !== "none" ||
        entry.observation.result !== "unknown" ||
        entry.observation.evidence_refs.length !== 0
      ) {
        throw new Error(
          `EffectEvidenceGraphV1 ${entry.category} unknown observation must carry no invented evidence`
        );
      }
    } else {
      if (
        entry.observation.scope === null ||
        entry.observation.coverage === "none" ||
        entry.observation.result === "unknown" ||
        entry.observation.evidence_refs.length === 0
      ) {
        throw new Error(
          `EffectEvidenceGraphV1 ${entry.category} observed result requires scope, coverage, result, and evidence refs`
        );
      }
      assertScopeShape(
        entry.observation.scope,
        `EffectEvidenceGraphV1 ${entry.category} observation scope`
      );
      if (
        entry.observation.scope.run_id !== graph.run_id ||
        entry.observation.scope.subject !== "worker_and_task_effects" ||
        entry.observation.scope.host_artifact_writes !== "excluded"
      ) {
        throw new Error(`EffectEvidenceGraphV1 ${entry.category} observation scope disagrees`);
      }
      if (
        entry.observation.scope.phases.some(
          (phase) => !entry.policy.scope.phases.includes(phase)
        ) ||
        entry.observation.scope.workers.some(
          (worker) => !entry.policy.scope.workers.includes(worker)
        )
      ) {
        throw new Error(
          `EffectEvidenceGraphV1 ${entry.category} observation exceeds policy phase scope`
        );
      }
      if (
        new Set(entry.observation.evidence_refs.map((ref) => ref.evidence_id)).size !==
        entry.observation.evidence_refs.length
      ) {
        throw new Error(`EffectEvidenceGraphV1 ${entry.category} observation refs must be unique`);
      }
      if (
        entry.observation.coverage === "complete" &&
        !sameScope(entry.observation.scope, entry.policy.scope)
      ) {
        throw new Error(
          `EffectEvidenceGraphV1 ${entry.category} complete observation must match policy scope`
        );
      }
    }
    if (entry.prevention.status === "unknown") {
      if (
        entry.prevention.control_id !== null ||
        entry.prevention.scope !== null ||
        entry.prevention.evidence_refs.length !== 0
      ) {
        throw new Error(
          `EffectEvidenceGraphV1 ${entry.category} unknown prevention must carry no invented control evidence`
        );
      }
    } else {
      if (
        entry.prevention.control_id === null ||
        entry.prevention.scope === null ||
        entry.prevention.evidence_refs.length === 0
      ) {
        throw new Error(
          `EffectEvidenceGraphV1 ${entry.category} enforced prevention requires a control, scope, and evidence refs`
        );
      }
      assertScopeShape(
        entry.prevention.scope,
        `EffectEvidenceGraphV1 ${entry.category} prevention scope`
      );
      if (
        entry.prevention.scope.run_id !== graph.run_id ||
        entry.prevention.scope.subject !== "worker_and_task_effects" ||
        entry.prevention.scope.host_artifact_writes !== "excluded"
      ) {
        throw new Error(`EffectEvidenceGraphV1 ${entry.category} prevention scope disagrees`);
      }
      if (
        entry.prevention.scope.phases.some((phase) => !entry.policy.scope.phases.includes(phase)) ||
        entry.prevention.scope.workers.some(
          (worker) => !entry.policy.scope.workers.includes(worker)
        )
      ) {
        throw new Error(
          `EffectEvidenceGraphV1 ${entry.category} prevention exceeds policy phase scope`
        );
      }
      if (
        new Set(entry.prevention.evidence_refs.map((ref) => ref.evidence_id)).size !==
        entry.prevention.evidence_refs.length
      ) {
        throw new Error(`EffectEvidenceGraphV1 ${entry.category} prevention refs must be unique`);
      }
    }
  }
  if (expected !== undefined) {
    const exact = scope(expected.runId, expected.phases);
    if (graph.run_id !== expected.runId || !sameScope(policyScope, exact)) {
      throw new Error("EffectEvidenceGraphV1 does not match the expected run/phase policy scope");
    }
  }
  const assurance = expectedAssurance(graph);
  if (
    graph.assurance !== assurance ||
    canonicalJson(graph.limitations) !== canonicalJson(expectedLimitations(assurance))
  ) {
    throw new Error("EffectEvidenceGraphV1 assurance or limitations are not derived from evidence");
  }
  return graph;
}

export function unknownEffectEvidenceGraph(input: {
  readonly runId: string;
  readonly phases: readonly string[];
}): EffectEvidenceGraphV1 {
  const policyScope = scope(input.runId, input.phases);
  return validateEffectEvidenceGraph(
    {
      schema_id: "penny.effect-evidence.v1",
      schema_version: 1,
      run_id: input.runId,
      host_artifact_writes: {
        classification: "host_control_plane_artifact_persistence",
        included_in_worker_effect_assurance: false,
      },
      categories: EFFECT_CATEGORIES.map((category) => ({
        category,
        policy: { requires_absence: true, scope: policyScope },
        observation: {
          status: "unknown",
          scope: null,
          coverage: "none",
          result: "unknown",
          evidence_refs: [],
        },
        prevention: {
          status: "unknown",
          control_id: null,
          scope: null,
          evidence_refs: [],
        },
      })),
      assurance: "unknown",
      limitations: [UNKNOWN_EFFECT_LIMITATION],
    },
    input
  );
}

export function collectEffectEvidence(input: {
  readonly runId: string;
  readonly phases: readonly string[];
  readonly provider?: EffectEvidenceProviderV1;
}): EffectEvidenceGraphV1 {
  if (input.provider === undefined) return unknownEffectEvidenceGraph(input);
  try {
    return validateEffectEvidenceGraph(
      input.provider.collect({
        schema_id: "penny.effect-evidence-request.v1",
        schema_version: 1,
        run_id: input.runId,
        workers: workersForPhases(input.phases),
        phases: [...input.phases],
        categories: EFFECT_CATEGORIES,
        subject: "worker_and_task_effects",
        host_artifact_writes: "excluded",
      }),
      input
    );
  } catch {
    // Unavailable or malformed telemetry can never be upgraded into proof of no effects.
    return unknownEffectEvidenceGraph(input);
  }
}

export function effectEvidenceSha256(value: unknown): string {
  return sha256(canonicalJson(validateEffectEvidenceGraph(value)));
}

/** Compatibility interpretation for historical literal-false contracts. */
export function legacyUnverifiedEffectEvidence(input: {
  readonly runId: string;
  readonly phases: readonly string[];
}): {
  readonly interpretation: "legacy_unverified_assertion";
  readonly effect_evidence: EffectEvidenceGraphV1;
} {
  return {
    interpretation: "legacy_unverified_assertion",
    effect_evidence: unknownEffectEvidenceGraph(input),
  };
}
