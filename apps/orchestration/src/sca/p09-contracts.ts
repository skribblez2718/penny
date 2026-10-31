import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";

/**
 * Inactive SCA P09 "obligation and coverage reconciliation" candidate contracts.
 *
 * P09 consumes the recorded P08 disposition result (or an explicit non-reconcilable checkpoint)
 * plus the caller-supplied P01 obligation ledger, and produces exhaustively accounted
 * reconciliation state: a closed reconciliation ledger, a derived readiness gate, an
 * eligible-only non-authorizing P10 handoff, and durable non-positive terminal accounting.
 *
 * The phase is host automation: it makes zero model calls, zero tool calls, no provider dispatch,
 * and declares no host operation. These schemas are deliberately absent from every active
 * registry.
 */
export const SCA_P09_PHASE_ID = "SCA-P09" as const;
export const SCA_P09_ADMITTING_STATE = "sca_p09_admitting" as const;
export const SCA_P09_RECONCILING_STATE = "sca_p09_reconciling" as const;
export const SCA_P09_FINAL_STATE = "sca_p09_finalizing" as const;
export const SCA_P09_CANCELLED_STATE = "sca_p09_cancelled" as const;

export const SCA_P09_ADMISSION_SCHEMA = "penny.sca-p09-admission.v1" as const;
export const SCA_P09_COVERAGE_INPUT_SCHEMA = "penny.sca-p09-coverage-input.v1" as const;
export const SCA_P09_CHECKPOINT_SCHEMA = "penny.sca-p09-checkpoint.v1" as const;
export const SCA_P09_REASSESSMENT_SCHEMA = "penny.sca-p09-reassessment.v1" as const;
export const SCA_P09_RECONCILIATION_LEDGER_SCHEMA =
  "penny.sca-p09-reconciliation-ledger.v1" as const;
export const SCA_P09_GATE_SCHEMA = "penny.sca-p09-gate.v1" as const;
export const SCA_P09_TO_P10_TRANSITION_SCHEMA = "penny.sca-p09-to-p10-transition.v1" as const;
export const SCA_P09_TERMINAL_SCHEMA = "penny.sca-p09-terminal.v1" as const;

/** The two reconciled lanes. `blocked_invalid` assigns no lane; `cancelled` is terminal-only. */
export const SCA_P09_ASSIGNED_LANES = ["accepted_progression", "incomplete_closeout"] as const;
export type ScaP09AssignedLaneV1 = (typeof SCA_P09_ASSIGNED_LANES)[number];
export type ScaP09LaneV1 = ScaP09AssignedLaneV1 | "blocked_invalid";
export type ScaP09TerminalStatusV1 = ScaP09LaneV1 | "cancelled";

/**
 * Closed reconciliation universe item kinds. P01 obligations and P06 evidence obligations are
 * distinct kinds; candidates/surfaces come from the coverage input.
 */
export const SCA_P09_ITEM_KINDS = Object.freeze([
  "p01_obligation",
  "p06_obligation",
  "action",
  "hypothesis",
  "candidate",
  "surface",
] as const);
export type ScaP09ItemKindV1 = (typeof SCA_P09_ITEM_KINDS)[number];

export const SCA_P09_COVERAGE_SURFACE_KINDS = Object.freeze([
  "normalized_candidate",
  "graph_candidate",
  "p04_selected_candidate",
  "omitted_surface",
  "excluded_surface",
  "unsupported_surface",
  "failed_surface",
  "denied_surface",
  "truncated_surface",
] as const);
export type ScaP09CoverageSurfaceKindV1 = (typeof SCA_P09_COVERAGE_SURFACE_KINDS)[number];

export const SCA_P09_COVERAGE_STATES = Object.freeze([
  "covered",
  "excluded",
  "unsupported",
  "failed",
  "denied",
  "truncated",
  "omitted",
] as const);
export type ScaP09CoverageStateV1 = (typeof SCA_P09_COVERAGE_STATES)[number];

/** The coverage state a surface kind is allowed to carry. */
const COVERAGE_STATE_BY_SURFACE_KIND: Readonly<
  Record<ScaP09CoverageSurfaceKindV1, readonly ScaP09CoverageStateV1[]>
> = Object.freeze({
  normalized_candidate: ["covered", "excluded", "unsupported", "failed", "denied", "truncated"],
  graph_candidate: ["covered", "excluded", "unsupported", "failed", "denied", "truncated"],
  p04_selected_candidate: ["covered", "excluded", "unsupported", "failed", "denied", "truncated"],
  omitted_surface: ["omitted"],
  excluded_surface: ["excluded"],
  unsupported_surface: ["unsupported"],
  failed_surface: ["failed"],
  denied_surface: ["denied"],
  truncated_surface: ["truncated"],
});

export function scaP09CoverageStatesForSurfaceKind(
  kind: ScaP09CoverageSurfaceKindV1
): readonly ScaP09CoverageStateV1[] {
  return COVERAGE_STATE_BY_SURFACE_KIND[kind];
}

/** Candidate surface kinds: the P02/P03/P04 surfaces whose coverage must be proven complete. */
export const SCA_P09_CANDIDATE_SURFACE_KINDS = Object.freeze([
  "normalized_candidate",
  "graph_candidate",
  "p04_selected_candidate",
] as const);

/**
 * Closed binding from a coverage surface kind to the exact phase, artifact kinds, and content
 * schemas an admitted `primary_ref` must carry (`SCA-P09` R5, E6). A coverage entry can never
 * certify a candidate from a substitute artifact (for example a gate record).
 */
export const SCA_P09_COVERAGE_EVIDENCE_BY_SURFACE = Object.freeze({
  normalized_candidate: {
    phase_id: "SCA-P02",
    kinds: Object.freeze(["sca-p02-persisted-evidence"]),
    schema_ids: Object.freeze(["penny.sca-p02-persisted-evidence.v1"]),
  },
  graph_candidate: {
    phase_id: "SCA-P03",
    kinds: Object.freeze(["sca-p03-graph-candidate-packet"]),
    schema_ids: Object.freeze([
      "penny.sca-p03-graph-candidate-packet.v1",
      "penny.sca-p03-graph-candidate-packet.v2",
    ]),
  },
  p04_selected_candidate: {
    phase_id: "SCA-P04",
    kinds: Object.freeze(["sca-p04-selection-dossier"]),
    schema_ids: Object.freeze(["penny.sca-p04-selection-dossier.v1"]),
  },
  omitted_surface: {
    phase_id: "SCA-P04",
    kinds: Object.freeze(["sca-p04-omission-dossier"]),
    schema_ids: Object.freeze(["penny.sca-p04-omission-dossier.v1"]),
  },
  excluded_surface: {
    phase_id: "SCA-P04",
    kinds: Object.freeze(["sca-p04-coverage-dossier"]),
    schema_ids: Object.freeze(["penny.sca-p04-coverage-dossier.v1"]),
  },
  unsupported_surface: {
    phase_id: "SCA-P04",
    kinds: Object.freeze(["sca-p04-coverage-dossier"]),
    schema_ids: Object.freeze(["penny.sca-p04-coverage-dossier.v1"]),
  },
  failed_surface: {
    phase_id: "SCA-P04",
    kinds: Object.freeze(["sca-p04-coverage-dossier"]),
    schema_ids: Object.freeze(["penny.sca-p04-coverage-dossier.v1"]),
  },
  denied_surface: {
    phase_id: "SCA-P04",
    kinds: Object.freeze(["sca-p04-coverage-dossier"]),
    schema_ids: Object.freeze(["penny.sca-p04-coverage-dossier.v1"]),
  },
  truncated_surface: {
    phase_id: "SCA-P04",
    kinds: Object.freeze(["sca-p04-coverage-dossier"]),
    schema_ids: Object.freeze(["penny.sca-p04-coverage-dossier.v1"]),
  },
} as const);

export function scaP09CoverageEvidenceForSurfaceKind(
  kind: ScaP09CoverageSurfaceKindV1
): (typeof SCA_P09_COVERAGE_EVIDENCE_BY_SURFACE)[ScaP09CoverageSurfaceKindV1] {
  return SCA_P09_COVERAGE_EVIDENCE_BY_SURFACE[kind];
}

/**
 * Exact-ref binding predicate: an artifact ref's own metadata names the declared surface's phase,
 * kind, and content schema. Admission additionally re-reads the exact bytes, but this closed
 * predicate is what makes a coverage declaration a typed reference rather than a bare claim.
 */
export function scaP09EvidenceRefMatchesBinding(
  ref: ArtifactRef,
  binding: {
    readonly phase_id: string;
    readonly kinds: readonly string[];
    readonly schema_ids: readonly string[];
  }
): boolean {
  return (
    ref.phase === binding.phase_id &&
    binding.kinds.includes(ref.kind) &&
    ref.content_schema !== undefined &&
    binding.schema_ids.includes(ref.content_schema.schema_id)
  );
}

/**
 * Stable identity of one coverage entry (`SCA-P09` R5/E6), derived from the surface kind plus the
 * exact primary ref and its content digest. It is never caller-selected, so one exact artifact can
 * never be declared to cover two candidate identities: two entries naming the same
 * `(surface_kind, primary_ref)` collide on this identity and are rejected before reconciliation.
 */
export function scaP09CoverageEntryIdentity(input: {
  readonly surface_kind: ScaP09CoverageSurfaceKindV1;
  readonly primary_ref: ArtifactRef;
}): string {
  return `p09cov_${sha256(
    canonicalJson({
      surface_kind: input.surface_kind,
      artifact_id: input.primary_ref.artifact_id,
      content_digest: input.primary_ref.content_digest,
    })
  )}`;
}

/**
 * Full declared P02/P03/P04 coverage scope: coverage is only complete when the input declares the
 * P02 candidate set, the P03 candidate set, the P04 selected candidate set, and the P04 omission
 * dossier. A one-entry or P02-only manifest therefore never certifies complete coverage.
 */
export const SCA_P09_REQUIRED_COVERAGE_SURFACES = Object.freeze([
  "normalized_candidate",
  "graph_candidate",
  "p04_selected_candidate",
  "omitted_surface",
] as const);

/**
 * A closed, exact obligation-resolution contract (`SCA-P09` R3/R6/R10). Each entry binds one due
 * P01 obligation revision to exact admitted evidence, so a `status: pending` ledger entry can never
 * be counted as resolution evidence. Non-due (future P10–P12/downstream) obligations are never
 * admissible here: they stay explicitly pending downstream.
 */
export const SCA_P09_OBLIGATION_RESOLUTION_SCHEMA =
  "penny.sca-p09-obligation-resolution.v1" as const;

export const SCA_P09_OBLIGATION_RESOLUTION_KINDS = Object.freeze([
  "phase_acceptance",
  "phase_output",
  "boundary_evidence",
  "milestone_record",
] as const);
export type ScaP09ObligationResolutionKindV1 = (typeof SCA_P09_OBLIGATION_RESOLUTION_KINDS)[number];

export const SCA_P09_OBLIGATION_RESOLUTION_KIND_BY_SCOPE: Readonly<
  Record<string, ScaP09ObligationResolutionKindV1>
> = Object.freeze({
  phase: "phase_acceptance",
  "phase-output": "phase_output",
  "report-output": "phase_output",
  milestone: "milestone_record",
  boundary: "boundary_evidence",
  exploratory: "phase_output",
});

/**
 * Closed exact evidence kinds admissible for each obligation resolution kind. Membership is exact:
 * a resolution may only cite artifacts whose `kind` appears in the applicable list.
 */
export const SCA_P09_RESOLUTION_EVIDENCE_KINDS: Readonly<
  Record<ScaP09ObligationResolutionKindV1, readonly string[]>
> = Object.freeze({
  phase_acceptance: Object.freeze([
    "sca-p01-candidate-gate",
    "sca-p02-gate",
    "sca-p03-gate",
    "sca-p04-gate",
    "sca-p05-gate",
    "sca-p06-gate",
    "sca-p07-terminal",
    "sca-p08-gate",
  ]),
  phase_output: Object.freeze([
    "sca-p02-persisted-evidence",
    "sca-p02-coverage-matrix",
    "sca-p03-graph-manifest",
    "sca-p03-baseline-query-page",
    "sca-p03-graph-candidate-packet",
    "sca-p04-specialist-dossier",
    "sca-p04-selection-dossier",
    "sca-p04-omission-dossier",
    "sca-p04-coverage-dossier",
    "sca-p05-hypothesis-revision",
    "sca-p05-traceability",
    "sca-p06-successor-ledger",
    "sca-p06-evidence-manifest",
    "sca-p07-evidence-ledger",
    "sca-p08-disposition-revision",
  ]),
  boundary_evidence: Object.freeze([
    "sca-p01-candidate-gate",
    "sca-p03-production-qualification-record",
    "sca-p04-gate",
    "sca-p07-execution-authority",
    "sca-p05-disclosure-scope",
    "sca-p06-disclosure-scope",
    "sca-p08-disclosure-scope",
  ]),
  milestone_record: Object.freeze(["sca-p02-coverage-matrix", "sca-m1-record"]),
});

export function scaP09ResolutionEvidenceKinds(
  kind: ScaP09ObligationResolutionKindV1
): readonly string[] {
  return SCA_P09_RESOLUTION_EVIDENCE_KINDS[kind];
}

/** The gate/terminal artifact kind that constitutes each phase's acceptance record. */
export const SCA_P09_PHASE_ACCEPTANCE_KIND: Readonly<Record<string, string>> = Object.freeze({
  "SCA-P01": "sca-p01-candidate-gate",
  "SCA-P02": "sca-p02-gate",
  "SCA-P03": "sca-p03-gate",
  "SCA-P04": "sca-p04-gate",
  "SCA-P05": "sca-p05-gate",
  "SCA-P06": "sca-p06-gate",
  "SCA-P07": "sca-p07-terminal",
  "SCA-P08": "sca-p08-gate",
});

/** Mandatory output artifact kinds admissible for each phase's `phase-output` obligations. */
export const SCA_P09_PHASE_OUTPUT_KINDS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "SCA-P02": Object.freeze(["sca-p02-persisted-evidence", "sca-p02-coverage-matrix"]),
    "SCA-P03": Object.freeze([
      "sca-p03-graph-manifest",
      "sca-p03-baseline-query-page",
      "sca-p03-graph-candidate-packet",
    ]),
    "SCA-P04": Object.freeze([
      "sca-p04-specialist-dossier",
      "sca-p04-selection-dossier",
      "sca-p04-omission-dossier",
      "sca-p04-coverage-dossier",
    ]),
    "SCA-P05": Object.freeze(["sca-p05-hypothesis-revision", "sca-p05-traceability"]),
    "SCA-P06": Object.freeze(["sca-p06-successor-ledger", "sca-p06-evidence-manifest"]),
    "SCA-P07": Object.freeze(["sca-p07-evidence-ledger"]),
    "SCA-P08": Object.freeze(["sca-p08-disposition-revision"]),
  });

/**
 * A boundary obligation binds to one exact admissible typed evidence kind; a boundary resolution may
 * not cite any other kind. Phase-acceptance obligations additionally bind to the exact admitted
 * lineage acceptance record when the admitted lineage carries one.
 */
export const SCA_P09_BOUNDARY_EVIDENCE_KIND_BY_OBLIGATION: Readonly<Record<string, string>> =
  Object.freeze({
    "SCA-OBL-BOUNDARY-ARTIFACT-INTEGRITY": "sca-p01-candidate-gate",
    "SCA-OBL-BOUNDARY-MODEL-IDENTITY": "sca-p04-gate",
    "SCA-OBL-BOUNDARY-MODEL-DISCLOSURE": "sca-p06-disclosure-scope",
    "SCA-OBL-BOUNDARY-EXECUTION-AUTHORITY": "sca-p07-execution-authority",
    "SCA-OBL-BOUNDARY-RELEASE-AUTHORITY": "sca-p07-execution-authority",
    "SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY": "sca-p04-gate",
    "SCA-OBL-BOUNDARY-INDEPENDENT-REVIEW": "sca-p03-production-qualification-record",
  });

const SCA_P09_EVIDENCE_SCHEMA_IDS_OVERRIDES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "sca-p03-graph-candidate-packet": Object.freeze([
      "penny.sca-p03-graph-candidate-packet.v1",
      "penny.sca-p03-graph-candidate-packet.v2",
    ]),
  });

/** Exact content schema ids admissible for one typed phase-evidence kind. */
export function scaP09EvidenceSchemaIds(kind: string): readonly string[] {
  return SCA_P09_EVIDENCE_SCHEMA_IDS_OVERRIDES[kind] ?? [`penny.${kind}.v1`];
}

/** Closed binding for an explicitly admitted typed phase-evidence source (`SCA-P09` R3/R6/R10). */
export interface ScaP09PhaseEvidenceBindingV1 {
  readonly phase_id: string;
  readonly schema_ids: readonly string[];
  readonly semantics: "gate" | "terminal" | "output";
}

function buildScaP09PhaseEvidenceBindings(): Record<string, ScaP09PhaseEvidenceBindingV1> {
  const bindings: Record<string, ScaP09PhaseEvidenceBindingV1> = {};
  for (const [phase, kind] of Object.entries(SCA_P09_PHASE_ACCEPTANCE_KIND)) {
    bindings[kind] = {
      phase_id: phase,
      schema_ids: scaP09EvidenceSchemaIds(kind),
      semantics: kind === "sca-p07-terminal" ? "terminal" : "gate",
    };
  }
  for (const [phase, kinds] of Object.entries(SCA_P09_PHASE_OUTPUT_KINDS)) {
    for (const kind of kinds) {
      bindings[kind] = {
        phase_id: phase,
        schema_ids: scaP09EvidenceSchemaIds(kind),
        semantics: "output",
      };
    }
  }
  bindings["sca-p03-production-qualification-record"] = {
    phase_id: "SCA-P03",
    schema_ids: scaP09EvidenceSchemaIds("sca-p03-production-qualification-record"),
    semantics: "output",
  };
  bindings["sca-p06-disclosure-scope"] = {
    phase_id: "SCA-P06",
    schema_ids: scaP09EvidenceSchemaIds("sca-p06-disclosure-scope"),
    semantics: "output",
  };
  bindings["sca-p08-disclosure-scope"] = {
    phase_id: "SCA-P08",
    schema_ids: scaP09EvidenceSchemaIds("sca-p08-disclosure-scope"),
    semantics: "output",
  };
  bindings["sca-p07-execution-authority"] = {
    phase_id: "SCA-P07",
    schema_ids: scaP09EvidenceSchemaIds("sca-p07-execution-authority"),
    semantics: "output",
  };
  bindings["sca-m1-record"] = {
    phase_id: "M1",
    schema_ids: scaP09EvidenceSchemaIds("sca-m1-record"),
    semantics: "output",
  };
  return bindings;
}

/** Every phase gate/terminal/output kind admissible as an explicitly admitted typed source. */
export const SCA_P09_PHASE_EVIDENCE_BINDINGS: Readonly<
  Record<string, ScaP09PhaseEvidenceBindingV1>
> = Object.freeze(buildScaP09PhaseEvidenceBindings());

export function scaP09PhaseEvidenceBinding(kind: string): ScaP09PhaseEvidenceBindingV1 | null {
  return SCA_P09_PHASE_EVIDENCE_BINDINGS[kind] ?? null;
}

/** Closed expected evidence predicate for one due obligation. */
export interface ScaP09ExpectedResolutionEvidenceV1 {
  readonly resolution_kind: ScaP09ObligationResolutionKindV1;
  readonly phase_id: string | null;
  readonly kinds: readonly string[];
  readonly schema_ids: readonly string[];
}

/**
 * Derives the closed expected role/kind/schema predicate for one obligation revision. A resolution
 * is adequate only when every cited artifact matches this predicate, so an arbitrary allowlisted
 * same-phase artifact is never sufficient.
 */
export function scaP09ExpectedResolutionEvidence(derivation: {
  readonly obligation_id: string;
  readonly scope: string;
  readonly semantic_phase_id: string | null;
}): ScaP09ExpectedResolutionEvidenceV1 | null {
  const resolutionKind = SCA_P09_OBLIGATION_RESOLUTION_KIND_BY_SCOPE[derivation.scope];
  if (resolutionKind === undefined) return null;
  const phase = derivation.semantic_phase_id;
  if (derivation.scope === "phase") {
    const kind = phase === null ? undefined : SCA_P09_PHASE_ACCEPTANCE_KIND[phase];
    if (kind === undefined) return null;
    return {
      resolution_kind: resolutionKind,
      phase_id: phase,
      kinds: [kind],
      schema_ids: scaP09EvidenceSchemaIds(kind),
    };
  }
  if (derivation.scope === "phase-output" || derivation.scope === "report-output") {
    const kinds = phase === null ? undefined : SCA_P09_PHASE_OUTPUT_KINDS[phase];
    if (kinds === undefined || kinds.length === 0) return null;
    return {
      resolution_kind: resolutionKind,
      phase_id: phase,
      kinds,
      schema_ids: [...new Set(kinds.flatMap((kind) => scaP09EvidenceSchemaIds(kind)))],
    };
  }
  if (derivation.scope === "milestone") {
    const kinds = ["sca-m1-record", "sca-p02-coverage-matrix"] as const;
    return {
      resolution_kind: resolutionKind,
      phase_id: "M1",
      kinds,
      schema_ids: [...new Set(kinds.flatMap((kind) => scaP09EvidenceSchemaIds(kind)))],
    };
  }
  if (derivation.scope === "boundary") {
    const kind = SCA_P09_BOUNDARY_EVIDENCE_KIND_BY_OBLIGATION[derivation.obligation_id];
    if (kind === undefined) return null;
    return {
      resolution_kind: resolutionKind,
      phase_id: null,
      kinds: [kind],
      schema_ids: scaP09EvidenceSchemaIds(kind),
    };
  }
  return null;
}

/**
 * Whether a coverage input declares the full P02/P03/P04 scope. Absence or a partial manifest is
 * never complete coverage, so the unreachable coverage obligations stay checkpointed.
 */
export function scaP09CoverageScopeComplete(coverage: ScaP09CoverageInputV1 | null): boolean {
  if (coverage === null) return false;
  const seenRefIds = new Set<string>();
  for (const surface of SCA_P09_REQUIRED_COVERAGE_SURFACES) {
    const binding = SCA_P09_COVERAGE_EVIDENCE_BY_SURFACE[surface];
    const entries = coverage.entries.filter((entry) => entry.surface_kind === surface);
    if (entries.length === 0) return false;
    // Each required surface must be backed by a distinct exact P02/P03/P04 record of the bound
    // phase/kind/schema: a mere surface-kind declaration never certifies full-scope completeness.
    for (const entry of entries) {
      if (!scaP09EvidenceRefMatchesBinding(entry.primary_ref, binding)) return false;
      if (seenRefIds.has(entry.primary_ref.artifact_id)) return false;
      seenRefIds.add(entry.primary_ref.artifact_id);
    }
  }
  return true;
}

/**
 * Exact coverage completeness (`SCA-P09` R5/E6): an absent or partial manifest is never complete,
 * and every candidate surface class must be honestly `covered`.
 */
export function scaP09CoverageComplete(coverage: ScaP09CoverageInputV1 | null): boolean {
  if (coverage === null || !scaP09CoverageScopeComplete(coverage)) return false;
  const candidateKinds = new Set<string>(SCA_P09_CANDIDATE_SURFACE_KINDS);
  return coverage.entries
    .filter((entry) => candidateKinds.has(entry.surface_kind))
    .every((entry) => entry.coverage_state === "covered");
}

export const SCA_P09_ELIGIBILITIES = ["eligible", "ineligible", "non_finding"] as const;
export type ScaP09EligibilityV1 = (typeof SCA_P09_ELIGIBILITIES)[number];

export const SCA_P09_OBLIGATION_CLASSES = [
  "required-result",
  "attempt-and-report",
  "optional",
] as const;
export type ScaP09ObligationClassV1 = (typeof SCA_P09_OBLIGATION_CLASSES)[number];

/** The strongest applicable class wins: required-result > attempt-and-report > optional. */
export function scaP09ObligationClassPrecedence(value: ScaP09ObligationClassV1): number {
  if (value === "required-result") return 3;
  if (value === "attempt-and-report") return 2;
  return 1;
}

export const SCA_P09_REASSESSMENT_TRIGGER_CODES = Object.freeze([
  "new_evidence",
  "invalidated_evidence",
  "changed_snapshot",
  "scope_change",
  "resolved_coverage",
] as const);
export type ScaP09ReassessmentTriggerCodeV1 = (typeof SCA_P09_REASSESSMENT_TRIGGER_CODES)[number];

/**
 * Downstream products P09 does not produce and therefore must name as missing when learning or
 * reporting are unavailable. The accounting is durable and non-positive.
 */
export const SCA_P09_MISSING_DOWNSTREAM_ARTIFACTS = Object.freeze([
  "penny.sca-p10-rule-learning-outcome.v1",
  "penny.sca-p11-reconciliation.v1",
  "penny.sca-p11-report.v1",
] as const);
export const SCA_P09_DOWNSTREAM_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-OUTPUT-P10-RULE-LEARNING",
  "SCA-OBL-P10-ACCEPTANCE",
  "SCA-OBL-REPORT-RECONCILIATION",
] as const);

/**
 * Coverage obligations that are not reachable from the recorded P08 lineage. When no coverage
 * input is supplied, the P02/P03 candidate sets and the P04 selection/omission dossiers cannot be
 * reconciled, so these exact obligations are recorded as unresolved blockers with P09 checkpoints.
 */
export const SCA_P09_UNREACHABLE_COVERAGE_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-OUTPUT-NORMALIZED-CANDIDATES",
  "SCA-OBL-OUTPUT-BASELINE-GRAPH-QUERIES",
  "SCA-OBL-OUTPUT-P04-SELECTION-DOSSIER",
  "SCA-OBL-OUTPUT-P04-OMISSION-DOSSIER",
  "SCA-OBL-P03-ACCEPTANCE",
  "SCA-OBL-P04-ACCEPTANCE",
] as const);

const NonEmptyTextSchema = Type.String({ minLength: 1, maxLength: 16_384 });
const BlockerCodeSchema = Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" });
const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);
const ItemIdSchema = Type.String({ pattern: "^p09item_[a-f0-9]{64}$" });

const ItemKindSchema = Type.Union([
  Type.Literal("p01_obligation"),
  Type.Literal("p06_obligation"),
  Type.Literal("action"),
  Type.Literal("hypothesis"),
  Type.Literal("candidate"),
  Type.Literal("surface"),
]);
const ObligationClassSchema = Type.Union([
  Type.Literal("required-result"),
  Type.Literal("attempt-and-report"),
  Type.Literal("optional"),
]);
const EligibilitySchema = Type.Union([
  Type.Literal("eligible"),
  Type.Literal("ineligible"),
  Type.Literal("non_finding"),
]);
const CoverageStateSchema = Type.Union([
  Type.Literal("covered"),
  Type.Literal("excluded"),
  Type.Literal("unsupported"),
  Type.Literal("failed"),
  Type.Literal("denied"),
  Type.Literal("truncated"),
  Type.Literal("omitted"),
]);
const CoverageSurfaceKindSchema = Type.Union([
  Type.Literal("normalized_candidate"),
  Type.Literal("graph_candidate"),
  Type.Literal("p04_selected_candidate"),
  Type.Literal("omitted_surface"),
  Type.Literal("excluded_surface"),
  Type.Literal("unsupported_surface"),
  Type.Literal("failed_surface"),
  Type.Literal("denied_surface"),
  Type.Literal("truncated_surface"),
]);
const AssignedLaneSchema = Type.Union([
  Type.Literal("accepted_progression"),
  Type.Literal("incomplete_closeout"),
]);
const DispositionSchema = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("rejected-with-evidence"),
  Type.Literal("inconclusive"),
  Type.Literal("deferred"),
  Type.Literal("duplicate-of"),
  Type.Literal("out-of-scope"),
]);
const ReassessmentTriggerSchema = Type.Union([
  Type.Literal("new_evidence"),
  Type.Literal("invalidated_evidence"),
  Type.Literal("changed_snapshot"),
  Type.Literal("scope_change"),
  Type.Literal("resolved_coverage"),
]);

/** Stable identity of one reconciliation universe item. It is derived, never caller-selected. */
export function scaP09ItemId(input: {
  readonly item_kind: ScaP09ItemKindV1;
  readonly identity: string;
}): string {
  return `p09item_${sha256(canonicalJson({ item_kind: input.item_kind, identity: input.identity }))}`;
}

export const ScaP09CoverageEntryV1Schema = Type.Object(
  {
    identity: OpaqueIdSchema,
    surface_kind: CoverageSurfaceKindSchema,
    primary_ref: ArtifactRefSchema,
    coverage_state: CoverageStateSchema,
    reason: Type.Union([NonEmptyTextSchema, Type.Null()]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 16 }),
  },
  { additionalProperties: false }
);
export type ScaP09CoverageEntryV1 = Readonly<Static<typeof ScaP09CoverageEntryV1Schema>>;

export const ScaP09CoverageInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P09_COVERAGE_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P09_PHASE_ID),
    run_id: OpaqueIdSchema,
    entries: Type.Array(ScaP09CoverageEntryV1Schema, { minItems: 1, maxItems: 10_000 }),
    coverage_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P09_COVERAGE_INPUT_SCHEMA }
);
export type ScaP09CoverageInputV1 = Readonly<Static<typeof ScaP09CoverageInputV1Schema>>;

/**
 * A host-issued P09 checkpoint. It records one item that cannot be discharged by an admitted
 * disposition — the honest form of "known but unresolved" (`SCA-P09`, `SCA-C05`).
 */
export const ScaP09CheckpointV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P09_CHECKPOINT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P09_PHASE_ID),
    run_id: OpaqueIdSchema,
    item_id: ItemIdSchema,
    item_kind: ItemKindSchema,
    identity: OpaqueIdSchema,
    reason_code: BlockerCodeSchema,
    primary_ref: ArtifactRefSchema,
    missing_evidence_need: NonEmptyTextSchema,
    reopen_condition: NonEmptyTextSchema,
    checkpoint_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P09_CHECKPOINT_SCHEMA }
);
export type ScaP09CheckpointV1 = Readonly<Static<typeof ScaP09CheckpointV1Schema>>;

/**
 * Host-issued reassessment stimulus. It names the exact prior P09 ledger it versions, the
 * `SCA-D02` trigger codes, the exact stimulus refs, and the exact prior evidence that was
 * invalidated. Invalidated evidence must name evidence the prior ledger relied on and must not
 * survive as current support.
 */
export const ScaP09ReassessmentV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P09_REASSESSMENT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P09_PHASE_ID),
    run_id: OpaqueIdSchema,
    prior_p09_ledger_ref: ArtifactRefSchema,
    prior_p09_ledger_sha256: Sha256Schema,
    trigger_codes: Type.Array(ReassessmentTriggerSchema, { minItems: 1, maxItems: 5 }),
    stimulus_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
    invalidated_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1024 }),
    reassessment_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P09_REASSESSMENT_SCHEMA }
);
export type ScaP09ReassessmentV1 = Readonly<Static<typeof ScaP09ReassessmentV1Schema>>;

const ResolutionKindSchema = Type.Union([
  Type.Literal("phase_acceptance"),
  Type.Literal("phase_output"),
  Type.Literal("boundary_evidence"),
  Type.Literal("milestone_record"),
]);

const ScaP09ObligationResolutionEntryV1Schema = Type.Object(
  {
    obligation_id: Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" }),
    obligation_entry_sha256: Sha256Schema,
    resolution_kind: ResolutionKindSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false }
);
export type ScaP09ObligationResolutionEntryV1 = Readonly<
  Static<typeof ScaP09ObligationResolutionEntryV1Schema>
>;

/**
 * Host-issued exact obligation-resolution input. Every entry binds one due P01 obligation revision
 * to exact admitted evidence; the admission path re-verifies obligation existence, due-at-P09-entry
 * membership, class, scope, and evidence kind/phase adequacy.
 */
export const ScaP09ObligationResolutionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P09_OBLIGATION_RESOLUTION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P09_PHASE_ID),
    run_id: OpaqueIdSchema,
    entries: Type.Array(ScaP09ObligationResolutionEntryV1Schema, {
      minItems: 1,
      maxItems: 256,
    }),
    resolution_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P09_OBLIGATION_RESOLUTION_SCHEMA }
);
export type ScaP09ObligationResolutionV1 = Readonly<
  Static<typeof ScaP09ObligationResolutionV1Schema>
>;

export const ScaP09AdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P09_ADMISSION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P09_PHASE_ID),
    run_id: OpaqueIdSchema,
    p08_terminal_ref: ArtifactRefSchema,
    p08_transition_ref: NullableArtifactRefSchema,
    p08_evidence_ledger_ref: NullableArtifactRefSchema,
    p08_gate_ref: NullableArtifactRefSchema,
    p08_admission_ref: NullableArtifactRefSchema,
    p08_item_universe_ref: NullableArtifactRefSchema,
    p01_obligation_ledger_ref: ArtifactRefSchema,
    coverage_input_ref: NullableArtifactRefSchema,
    /** Exact, explicitly admitted typed phase-evidence sources (`SCA-P09` R3/R6/R10). */
    phase_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    obligation_resolution_ref: NullableArtifactRefSchema,
    /** True only when an independent resolver attested the current P01 obligation-ledger head. */
    p01_head_attested: Type.Boolean(),
    /** True only when an independent resolver attested the current P07 execution authority. */
    p08_authority_assurance: Type.Union([
      Type.Literal("attested_unchanged"),
      Type.Literal("unattested_chain_revalidated"),
    ]),
    /** True when the recorded P08 admission/universe were re-derived exactly. */
    p08_rederivation_ok: Type.Boolean(),
    p01_fork_safety: Type.Union([
      Type.Literal("attested_unchanged"),
      Type.Literal("unattested_chain_revalidated"),
    ]),
    non_reconcilable: Type.Boolean(),
    non_reconcilable_reason: Type.Union([NonEmptyTextSchema, Type.Null()]),
    item_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    universe_sha256: Sha256Schema,
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P09_ADMISSION_SCHEMA }
);
export type ScaP09AdmissionV1 = Readonly<Static<typeof ScaP09AdmissionV1Schema>>;

export const ScaP09LedgerItemV1Schema = Type.Object(
  {
    item_id: ItemIdSchema,
    item_kind: ItemKindSchema,
    identity: OpaqueIdSchema,
    primary_ref: ArtifactRefSchema,
    p08_disposition: Type.Union([DispositionSchema, Type.Null()]),
    p08_disposition_ref: NullableArtifactRefSchema,
    checkpoint_ref: NullableArtifactRefSchema,
    effective_class: Type.Union([ObligationClassSchema, Type.Null()]),
    precedence: Type.Union([Type.Integer({ minimum: 1, maximum: 3 }), Type.Null()]),
    revision_chain_refs: Type.Array(ArtifactRefSchema, { maxItems: 1024 }),
    coverage_state: Type.Union([CoverageStateSchema, Type.Null()]),
    eligibility: EligibilitySchema,
    /** True for obligations due at P09 entry; false for future downstream obligations. */
    due_at_p09_entry: Type.Boolean(),
    /** True only when exact admitted resolution evidence exists (or an eligible disposition). */
    resolved: Type.Boolean(),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
  },
  { additionalProperties: false }
);
export type ScaP09LedgerItemV1 = Readonly<Static<typeof ScaP09LedgerItemV1Schema>>;

const CountKeySchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 128 }),
    count: Type.Integer({ minimum: 0, maximum: 10_000 }),
  },
  { additionalProperties: false }
);

export const ScaP09ReconciliationLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P09_RECONCILIATION_LEDGER_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P09_PHASE_ID),
    run_id: OpaqueIdSchema,
    admission_ref: ArtifactRefSchema,
    p08_terminal_ref: ArtifactRefSchema,
    p08_transition_ref: NullableArtifactRefSchema,
    p08_evidence_ledger_ref: NullableArtifactRefSchema,
    p08_gate_ref: NullableArtifactRefSchema,
    p08_item_universe_ref: NullableArtifactRefSchema,
    p01_obligation_ledger_ref: ArtifactRefSchema,
    coverage_input_ref: NullableArtifactRefSchema,
    /** Absent when the ledger records a `blocked_invalid` state (no lane is assigned). */
    lane: Type.Optional(AssignedLaneSchema),
    /** Additive reassessment lineage. Absent on the first P09 ledger revision. */
    prior_p09_ledger_ref: Type.Optional(NullableArtifactRefSchema),
    prior_p09_ledger_sha256: Type.Optional(Type.Union([Sha256Schema, Type.Null()])),
    ledger_revision: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    append_only: Type.Optional(Type.Literal(true)),
    items: Type.Array(ScaP09LedgerItemV1Schema, { minItems: 1, maxItems: 10_000 }),
    item_count: Type.Integer({ minimum: 1, maximum: 10_000 }),
    kind_counts: Type.Array(CountKeySchema, { maxItems: 64 }),
    disposition_counts: Type.Array(CountKeySchema, { maxItems: 64 }),
    required_result_total: Type.Integer({ minimum: 0, maximum: 10_000 }),
    required_result_resolved: Type.Integer({ minimum: 0, maximum: 10_000 }),
    /** Exact future P10–P12/downstream required results that stay explicitly pending. */
    downstream_pending_required_result_ids: Type.Array(
      Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" }),
      { maxItems: 256 }
    ),
    unresolved_item_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    eligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    ineligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    exhaustive_accounting: Type.Literal(true),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    ledger_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P09_RECONCILIATION_LEDGER_SCHEMA }
);
export type ScaP09ReconciliationLedgerV1 = Readonly<
  Static<typeof ScaP09ReconciliationLedgerV1Schema>
>;

export const ScaP09GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P09_GATE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P09_PHASE_ID),
    criterion_id: Type.Literal("AC-P09"),
    verdict: Type.Union([
      Type.Literal("pass_ready"),
      Type.Literal("pass_blocked"),
      Type.Literal("blocked_invalid"),
    ]),
    reconciliation_ledger_ref: ArtifactRefSchema,
    p08_terminal_ref: ArtifactRefSchema,
    p08_evidence_ledger_ref: NullableArtifactRefSchema,
    p08_gate_ref: NullableArtifactRefSchema,
    lane: Type.Optional(AssignedLaneSchema),
    exhaustive_accounting: Type.Boolean(),
    immutable_p08_lineage_valid: Type.Boolean(),
    set_equality_valid: Type.Boolean(),
    effective_class_derivation_valid: Type.Boolean(),
    no_underclassification: Type.Boolean(),
    no_post_failure_downgrade: Type.Boolean(),
    no_late_unregistered_action: Type.Boolean(),
    no_conflicting_replay: Type.Boolean(),
    coverage_reconciled: Type.Boolean(),
    append_only_revisions: Type.Boolean(),
    eligible_handoff_only: Type.Boolean(),
    downstream_accounting_present: Type.Boolean(),
    p12_or_release_claims_absent: Type.Boolean(),
    /** Honest surface: false when the supplied P01 head was not independently attested. */
    p01_head_attested: Type.Boolean(),
    /** Honest surface: false when the recorded P08 lineage was only chain-revalidated. */
    p08_authority_attested: Type.Boolean(),
    retained_required_gaps: Type.Boolean(),
    item_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    required_result_total: Type.Integer({ minimum: 0, maximum: 10_000 }),
    required_result_resolved: Type.Integer({ minimum: 0, maximum: 10_000 }),
    required_result_downstream_pending: Type.Integer({ minimum: 0, maximum: 10_000 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P09_GATE_SCHEMA }
);
export type ScaP09GateV1 = Readonly<Static<typeof ScaP09GateV1Schema>>;

export const ScaP09ToP10TransitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P09_TO_P10_TRANSITION_SCHEMA),
    schema_version: Type.Literal(1),
    source_phase_id: Type.Literal(SCA_P09_PHASE_ID),
    target_phase_id: Type.Literal("SCA-P10"),
    handoff_kind: Type.Literal("reconciled_eligible_evidence_only"),
    qualification_scope: Type.Literal("reconciliation_gate_only_not_p10_learning"),
    phase_gate_passed: Type.Literal(false),
    p10_rule_learning_authorized_by_this_transition: Type.Literal(false),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    campaign_completion_claimed: Type.Literal(false),
    p08_terminal_ref: ArtifactRefSchema,
    p08_transition_ref: NullableArtifactRefSchema,
    p08_evidence_ledger_ref: NullableArtifactRefSchema,
    p09_reconciliation_ledger_ref: ArtifactRefSchema,
    lane: AssignedLaneSchema,
    eligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    ineligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    unresolved_item_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    required_gaps_retained: Type.Literal(true),
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P09_TO_P10_TRANSITION_SCHEMA }
);
export type ScaP09ToP10TransitionV1 = Readonly<Static<typeof ScaP09ToP10TransitionV1Schema>>;

export const ScaP09TerminalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P09_TERMINAL_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P09_PHASE_ID),
    status: Type.Union([
      Type.Literal("accepted_progression"),
      Type.Literal("incomplete_closeout"),
      Type.Literal("blocked_invalid"),
      Type.Literal("cancelled"),
    ]),
    reconciliation_ledger_ref: NullableArtifactRefSchema,
    gate_ref: NullableArtifactRefSchema,
    p10_transition_ref: NullableArtifactRefSchema,
    p10_handoff_ready: Type.Boolean(),
    lane: Type.Optional(AssignedLaneSchema),
    item_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    kind_counts: Type.Array(CountKeySchema, { maxItems: 64 }),
    disposition_counts: Type.Array(CountKeySchema, { maxItems: 64 }),
    required_result_total: Type.Integer({ minimum: 0, maximum: 10_000 }),
    required_result_resolved: Type.Integer({ minimum: 0, maximum: 10_000 }),
    eligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    ineligible_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    missing_downstream_artifacts: Type.Array(NonEmptyTextSchema, { maxItems: 32 }),
    required_downstream_obligation_ids: Type.Array(
      Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" }),
      { maxItems: 32 }
    ),
    selected_artifact_refs: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    phase_gate_passed: Type.Literal(false),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    nonterminal_campaign: Type.Literal(true),
    p12_release_authorized: Type.Literal(false),
    report_or_release_adjudication_performed: Type.Literal(false),
    terminal_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P09_TERMINAL_SCHEMA }
);
export type ScaP09TerminalV1 = Readonly<Static<typeof ScaP09TerminalV1Schema>>;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function selfDigest<T extends Readonly<Record<string, unknown>>>(
  value: T,
  field: keyof T,
  label: string
): void {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  if (value[field] !== sha256(canonicalJson(body))) {
    throw new Error(`${label} self digest mismatch`);
  }
}
function assertSortedUnique(values: readonly string[], label: string): void {
  if (!same(values, [...new Set(values)].sort())) {
    throw new Error(`${label} must be unique and lexicographically sorted`);
  }
}

export function withP09Digest<T extends Readonly<Record<string, unknown>>, K extends string>(
  value: T,
  field: K
): T & Readonly<Record<K, string>> {
  return { ...value, [field]: sha256(canonicalJson(value)) } as T & Readonly<Record<K, string>>;
}

/** Deterministic digest over the ordered `(item_kind, identity)` universe vector. */
export function scaP09UniverseSha256(
  items: readonly {
    readonly item_kind: ScaP09ItemKindV1;
    readonly identity: string;
  }[]
): string {
  return sha256(
    canonicalJson(
      [...items]
        .map((item) => ({ item_kind: item.item_kind, identity: item.identity }))
        .sort((left, right) =>
          left.item_kind === right.item_kind
            ? left.identity < right.identity
              ? -1
              : left.identity > right.identity
                ? 1
                : 0
            : left.item_kind < right.item_kind
              ? -1
              : 1
        )
    )
  );
}

export function isScaP09AssignedLane(value: string): value is ScaP09AssignedLaneV1 {
  return (SCA_P09_ASSIGNED_LANES as readonly string[]).includes(value);
}

/** Blocker codes that force the `blocked_invalid` lane rather than incomplete closeout. */
const INVALID_BLOCKER_PREFIXES = Object.freeze([
  "p09_set_equality_violation",
  "p09_unaccounted_item",
  "p09_rederivation_mismatch",
  "p09_universe_mismatch",
  "p09_underclassification",
  "p09_post_failure_downgrade",
  "p09_late_unregistered_action",
  "p09_conflicting_replay",
  "p09_effective_class_invalid",
  "p09_admission_ref_invalid",
  "p09_admission_ref_mismatch",
  "p09_revision_chain_invalid",
  "p09_cited_evidence_invalid",
  "p09_count_mismatch",
  "p09_ledger_validation_failed",
  "p09_obligation_resolution_invalid",
  "p09_coverage_binding_invalid",
] as const);

export function isScaP09InvalidBlocker(code: string): boolean {
  return INVALID_BLOCKER_PREFIXES.some(
    (prefix) => code === prefix || code.startsWith(`${prefix}::`) || code.startsWith(`${prefix}_`)
  );
}

export function validateScaP09CoverageInputV1(value: unknown): ScaP09CoverageInputV1 {
  const parsed = validateContract(ScaP09CoverageInputV1Schema, value, "SCA P09 coverage input");
  assertSortedUnique(
    parsed.entries.map((entry) => entry.identity),
    "SCA P09 coverage input identities"
  );
  const candidateKinds = new Set<string>(SCA_P09_CANDIDATE_SURFACE_KINDS);
  const candidateRefIds = new Set<string>();
  for (const entry of parsed.entries) {
    if (entry.identity !== scaP09CoverageEntryIdentity(entry)) {
      throw new Error(
        "SCA P09 coverage entry identity is not derived from its surface kind and exact primary ref"
      );
    }
    if (!scaP09CoverageStatesForSurfaceKind(entry.surface_kind).includes(entry.coverage_state)) {
      throw new Error("SCA P09 coverage entry state is not admissible for its surface kind");
    }
    assertSortedUnique(entry.blocker_codes, "SCA P09 coverage entry blocker codes");
    if (entry.coverage_state === "covered" && entry.reason !== null) {
      throw new Error("SCA P09 covered entry cannot carry a gap reason");
    }
    if (entry.coverage_state !== "covered" && entry.reason === null) {
      throw new Error("SCA P09 uncovered entry must name its coverage reason");
    }
    if (candidateKinds.has(entry.surface_kind)) {
      if (candidateRefIds.has(entry.primary_ref.artifact_id)) {
        throw new Error("SCA P09 coverage input lets one artifact cover two candidate identities");
      }
      candidateRefIds.add(entry.primary_ref.artifact_id);
    }
  }
  selfDigest(parsed, "coverage_sha256", "SCA P09 coverage input");
  return parsed;
}

export function validateScaP09CheckpointV1(value: unknown): ScaP09CheckpointV1 {
  const parsed = validateContract(ScaP09CheckpointV1Schema, value, "SCA P09 checkpoint");
  if (parsed.item_id !== scaP09ItemId({ item_kind: parsed.item_kind, identity: parsed.identity })) {
    throw new Error("SCA P09 checkpoint item identity mismatch");
  }
  selfDigest(parsed, "checkpoint_sha256", "SCA P09 checkpoint");
  return parsed;
}

export function validateScaP09ReassessmentV1(value: unknown): ScaP09ReassessmentV1 {
  const parsed = validateContract(ScaP09ReassessmentV1Schema, value, "SCA P09 reassessment");
  if (parsed.prior_p09_ledger_sha256 !== parsed.prior_p09_ledger_ref.content_digest) {
    throw new Error("SCA P09 reassessment prior-ledger digest binding mismatch");
  }
  assertSortedUnique(parsed.trigger_codes, "SCA P09 reassessment trigger codes");
  assertSortedUnique(
    parsed.stimulus_refs.map((ref) => ref.artifact_id),
    "SCA P09 reassessment stimulus refs"
  );
  assertSortedUnique(
    parsed.invalidated_evidence_refs.map((ref) => ref.artifact_id),
    "SCA P09 reassessment invalidated evidence refs"
  );
  const invalidated = parsed.trigger_codes.includes("invalidated_evidence");
  if (invalidated !== parsed.invalidated_evidence_refs.length > 0) {
    throw new Error("SCA P09 reassessment invalidated evidence/trigger mismatch");
  }
  selfDigest(parsed, "reassessment_sha256", "SCA P09 reassessment");
  return parsed;
}

export function validateScaP09ObligationResolutionV1(value: unknown): ScaP09ObligationResolutionV1 {
  const parsed = validateContract(
    ScaP09ObligationResolutionV1Schema,
    value,
    "SCA P09 obligation resolution"
  );
  assertSortedUnique(
    parsed.entries.map((entry) => entry.obligation_id),
    "SCA P09 obligation resolution obligation ids"
  );
  const seenEvidence = new Set<string>();
  for (const entry of parsed.entries) {
    assertSortedUnique(
      entry.evidence_refs.map((ref) => ref.artifact_id),
      "SCA P09 obligation resolution evidence refs"
    );
    for (const ref of entry.evidence_refs) {
      if (seenEvidence.has(ref.artifact_id)) {
        throw new Error(
          "SCA P09 obligation resolution cites one evidence artifact for more than one obligation"
        );
      }
      seenEvidence.add(ref.artifact_id);
    }
  }
  selfDigest(parsed, "resolution_sha256", "SCA P09 obligation resolution");
  return parsed;
}

export function validateScaP09AdmissionV1(value: unknown): ScaP09AdmissionV1 {
  const parsed = validateContract(ScaP09AdmissionV1Schema, value, "SCA P09 admission");
  assertSortedUnique(
    parsed.phase_evidence_refs.map((ref) => ref.artifact_id),
    "SCA P09 admission phase-evidence refs"
  );
  if (parsed.p01_head_attested !== (parsed.p01_fork_safety === "attested_unchanged")) {
    throw new Error("SCA P09 admission fork-safety attestation mismatch");
  }
  if (parsed.p08_rederivation_ok === parsed.non_reconcilable) {
    throw new Error("SCA P09 admission re-derivation assurance mismatch");
  }
  if (parsed.non_reconcilable !== (parsed.non_reconcilable_reason !== null)) {
    throw new Error("SCA P09 admission non-reconcilable reason mismatch");
  }
  if (parsed.non_reconcilable) {
    if (
      parsed.p08_evidence_ledger_ref !== null ||
      parsed.p08_gate_ref !== null ||
      parsed.p08_admission_ref !== null ||
      parsed.p08_item_universe_ref !== null ||
      parsed.phase_evidence_refs.length !== 0 ||
      parsed.item_count !== 0
    ) {
      throw new Error("SCA P09 non-reconcilable admission cannot bind P08 reconciliation state");
    }
  } else if (
    parsed.p08_evidence_ledger_ref === null ||
    parsed.p08_gate_ref === null ||
    parsed.p08_admission_ref === null ||
    parsed.p08_item_universe_ref === null
  ) {
    throw new Error("SCA P09 reconcilable admission must bind every P08 artifact");
  }
  selfDigest(parsed, "admission_sha256", "SCA P09 admission");
  return parsed;
}

export function validateScaP09LedgerItemV1(value: unknown): ScaP09LedgerItemV1 {
  const parsed = validateContract(ScaP09LedgerItemV1Schema, value, "SCA P09 ledger item");
  if (parsed.item_id !== scaP09ItemId({ item_kind: parsed.item_kind, identity: parsed.identity })) {
    throw new Error("SCA P09 ledger item identity mismatch");
  }
  const obligation = parsed.item_kind === "p01_obligation" || parsed.item_kind === "p06_obligation";
  if (obligation) {
    if (
      parsed.effective_class === null ||
      parsed.precedence === null ||
      parsed.revision_chain_refs.length === 0 ||
      parsed.precedence !== scaP09ObligationClassPrecedence(parsed.effective_class)
    ) {
      throw new Error("SCA P09 obligation ledger item class derivation is invalid");
    }
  } else if (
    parsed.effective_class !== null ||
    parsed.precedence !== null ||
    parsed.revision_chain_refs.length !== 0
  ) {
    throw new Error("SCA P09 non-obligation ledger item cannot carry a class derivation");
  }
  const coverage = parsed.item_kind === "candidate" || parsed.item_kind === "surface";
  if (coverage !== (parsed.coverage_state !== null)) {
    throw new Error("SCA P09 coverage ledger item state binding mismatch");
  }
  if (parsed.blocker_codes.includes("p09_required_result_unresolved") && parsed.resolved) {
    throw new Error(
      "SCA P09 ledger item claims resolution while its required result is unresolved"
    );
  }
  const requiredDue =
    parsed.due_at_p09_entry &&
    (parsed.item_kind === "p06_obligation" ||
      (parsed.item_kind === "p01_obligation" && parsed.effective_class === "required-result"));
  if (
    requiredDue &&
    parsed.resolved !== !parsed.blocker_codes.includes("p09_required_result_unresolved")
  ) {
    throw new Error("SCA P09 ledger item required-result resolution accounting is inconsistent");
  }
  if (!obligation && (parsed.effective_class !== null || parsed.precedence !== null)) {
    throw new Error("SCA P09 non-obligation ledger item cannot carry a class derivation");
  }
  if ((parsed.p08_disposition === null) !== (parsed.p08_disposition_ref === null)) {
    throw new Error("SCA P09 ledger item disposition/ref binding mismatch");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P09 ledger item blocker codes");
  if (
    parsed.p08_disposition_ref === null &&
    parsed.checkpoint_ref === null &&
    parsed.coverage_state === null &&
    parsed.blocker_codes.length === 0 &&
    !(obligation && parsed.revision_chain_refs.length > 0)
  ) {
    throw new Error("SCA P09 ledger item is not accounted by disposition, checkpoint, or blocker");
  }
  return parsed;
}

function countBy(values: readonly string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

export function validateScaP09ReconciliationLedgerV1(value: unknown): ScaP09ReconciliationLedgerV1 {
  const parsed = validateContract(
    ScaP09ReconciliationLedgerV1Schema,
    value,
    "SCA P09 reconciliation ledger"
  );
  if (parsed.items.length !== parsed.item_count) {
    throw new Error("SCA P09 reconciliation ledger item count mismatch");
  }
  for (const item of parsed.items) validateScaP09LedgerItemV1(item);
  assertSortedUnique(
    parsed.items.map((item) => item.item_id),
    "SCA P09 reconciliation ledger item ids"
  );
  const kindCounts = countBy(parsed.items.map((item) => item.item_kind));
  if (!same(parsed.kind_counts, kindCounts)) {
    throw new Error("SCA P09 reconciliation ledger per-kind accounting is not exhaustive");
  }
  const dispositionCounts = countBy(
    parsed.items
      .map((item) => item.p08_disposition)
      .filter((value): value is NonNullable<typeof value> => value !== null)
  );
  if (!same(parsed.disposition_counts, dispositionCounts)) {
    throw new Error("SCA P09 reconciliation ledger per-disposition accounting is not exhaustive");
  }
  if (parsed.required_result_resolved > parsed.required_result_total) {
    throw new Error("SCA P09 reconciliation ledger resolved required results exceed the total");
  }
  const dueRequired = parsed.items.filter(
    (item) =>
      item.due_at_p09_entry &&
      (item.item_kind === "p06_obligation" ||
        (item.item_kind === "p01_obligation" && item.effective_class === "required-result"))
  );
  if (parsed.required_result_total !== dueRequired.length) {
    throw new Error("SCA P09 reconciliation ledger required-result total is not derived");
  }
  if (parsed.required_result_resolved !== dueRequired.filter((item) => item.resolved).length) {
    throw new Error("SCA P09 reconciliation ledger required-result resolutions are not derived");
  }
  const downstreamIds = parsed.items
    .filter(
      (item) =>
        item.item_kind === "p01_obligation" &&
        !item.due_at_p09_entry &&
        item.effective_class === "required-result"
    )
    .map((item) => item.identity)
    .sort();
  const declaredDownstream = [...parsed.downstream_pending_required_result_ids].sort();
  if (!same(declaredDownstream, downstreamIds)) {
    throw new Error("SCA P09 reconciliation ledger downstream obligations are not exhaustive");
  }
  assertSortedUnique(
    parsed.downstream_pending_required_result_ids,
    "SCA P09 reconciliation ledger downstream obligations"
  );
  assertSortedUnique(
    parsed.eligible_refs.map((ref) => ref.artifact_id),
    "SCA P09 reconciliation ledger eligible refs"
  );
  assertSortedUnique(
    parsed.ineligible_refs.map((ref) => ref.artifact_id),
    "SCA P09 reconciliation ledger ineligible refs"
  );
  assertSortedUnique(
    parsed.unresolved_item_refs.map((ref) => ref.artifact_id),
    "SCA P09 reconciliation ledger unresolved refs"
  );
  const unresolvedBindings = [
    ...new Set(
      parsed.items
        .filter((item) => item.blocker_codes.length > 0)
        .map((item) => item.p08_disposition_ref ?? item.checkpoint_ref ?? item.primary_ref)
        .map((ref) => ref.artifact_id)
    ),
  ].sort();
  if (
    !same(
      parsed.unresolved_item_refs.map((ref) => ref.artifact_id),
      unresolvedBindings
    )
  ) {
    throw new Error("SCA P09 reconciliation ledger unresolved refs disagree with its items");
  }
  if (parsed.lane === undefined && parsed.blocker_codes.length === 0) {
    throw new Error("SCA P09 reconciliation ledger without a lane must record its blockers");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P09 reconciliation ledger blocker codes");
  const revision = parsed.ledger_revision ?? 1;
  const priorRef = parsed.prior_p09_ledger_ref ?? null;
  const priorSha = parsed.prior_p09_ledger_sha256 ?? null;
  if ((priorRef === null) !== (priorSha === null)) {
    throw new Error("SCA P09 reconciliation ledger prior-ledger ref/digest mismatch");
  }
  if (priorRef !== null && priorSha !== priorRef.content_digest) {
    throw new Error("SCA P09 reconciliation ledger prior-ledger digest binding mismatch");
  }
  if ((priorRef !== null) !== revision > 1) {
    throw new Error("SCA P09 reconciliation ledger revision/prior-ledger mismatch");
  }
  if (parsed.append_only !== undefined && parsed.append_only !== true) {
    throw new Error("SCA P09 reconciliation ledger must be append-only");
  }
  selfDigest(parsed, "ledger_sha256", "SCA P09 reconciliation ledger");
  return parsed;
}

export function validateScaP09GateV1(value: unknown): ScaP09GateV1 {
  const parsed = validateContract(ScaP09GateV1Schema, value, "SCA P09 gate");
  if (
    parsed.verdict === "pass_ready" &&
    (parsed.blocker_codes.length !== 0 ||
      parsed.retained_required_gaps ||
      parsed.lane !== "accepted_progression" ||
      parsed.required_result_total <= 0 ||
      parsed.required_result_resolved !== parsed.required_result_total ||
      !parsed.exhaustive_accounting ||
      !parsed.immutable_p08_lineage_valid ||
      !parsed.set_equality_valid ||
      !parsed.effective_class_derivation_valid ||
      !parsed.no_underclassification ||
      !parsed.no_post_failure_downgrade ||
      !parsed.no_late_unregistered_action ||
      !parsed.no_conflicting_replay ||
      !parsed.coverage_reconciled ||
      !parsed.append_only_revisions ||
      !parsed.eligible_handoff_only ||
      !parsed.downstream_accounting_present ||
      !parsed.p12_or_release_claims_absent)
  ) {
    throw new Error("SCA P09 pass_ready gate claims an unmet condition");
  }
  if (parsed.verdict === "pass_blocked" && parsed.lane !== "incomplete_closeout") {
    throw new Error("SCA P09 pass_blocked gate must record the incomplete-closeout lane");
  }
  if (parsed.verdict === "blocked_invalid" && parsed.lane !== undefined) {
    throw new Error("SCA P09 blocked_invalid gate cannot assign a lane");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P09 gate blocker codes");
  selfDigest(parsed, "gate_sha256", "SCA P09 gate");
  return parsed;
}

export function validateScaP09ToP10TransitionV1(value: unknown): ScaP09ToP10TransitionV1 {
  const parsed = validateContract(
    ScaP09ToP10TransitionV1Schema,
    value,
    "SCA P09 successor handoff"
  );
  assertSortedUnique(
    parsed.eligible_refs.map((ref) => ref.artifact_id),
    "SCA P09 handoff eligible refs"
  );
  assertSortedUnique(
    parsed.ineligible_refs.map((ref) => ref.artifact_id),
    "SCA P09 handoff ineligible refs"
  );
  assertSortedUnique(
    parsed.unresolved_item_refs.map((ref) => ref.artifact_id),
    "SCA P09 handoff unresolved refs"
  );
  const eligibleIds = new Set(parsed.eligible_refs.map((ref) => ref.artifact_id));
  for (const ref of parsed.ineligible_refs) {
    if (eligibleIds.has(ref.artifact_id)) {
      throw new Error("SCA P09 handoff makes unresolved evidence eligible");
    }
  }
  selfDigest(parsed, "transition_sha256", "SCA P09 successor handoff");
  return parsed;
}

export function validateScaP09TerminalV1(value: unknown): ScaP09TerminalV1 {
  const parsed = validateContract(ScaP09TerminalV1Schema, value, "SCA P09 terminal");
  assertSortedUnique(parsed.blocker_codes, "SCA P09 terminal blocker codes");
  assertSortedUnique(
    parsed.eligible_refs.map((ref) => ref.artifact_id),
    "SCA P09 terminal eligible refs"
  );
  assertSortedUnique(
    parsed.ineligible_refs.map((ref) => ref.artifact_id),
    "SCA P09 terminal ineligible refs"
  );
  assertSortedUnique(
    parsed.missing_downstream_artifacts,
    "SCA P09 terminal missing downstream artifacts"
  );
  assertSortedUnique(
    parsed.required_downstream_obligation_ids,
    "SCA P09 terminal required downstream obligations"
  );
  if ((parsed.p10_transition_ref !== null) !== parsed.p10_handoff_ready) {
    throw new Error("SCA P09 terminal handoff readiness disagrees with its transition ref");
  }
  const reconciled =
    parsed.status === "accepted_progression" || parsed.status === "incomplete_closeout";
  if (parsed.status === "accepted_progression") {
    if (
      parsed.reconciliation_ledger_ref === null ||
      parsed.gate_ref === null ||
      parsed.p10_transition_ref === null ||
      parsed.lane !== "accepted_progression"
    ) {
      throw new Error("SCA P09 accepted progression requires ledger, gate, and P10 handoff");
    }
  }
  if (parsed.status === "incomplete_closeout") {
    // A reconciled incomplete closeout carries the full non-positive accounting; an admitted
    // non-reconcilable P08 checkpoint (`SCA-P09` R10) emits durable terminal accounting only.
    const full =
      parsed.reconciliation_ledger_ref !== null &&
      parsed.gate_ref !== null &&
      parsed.p10_transition_ref !== null &&
      parsed.lane === "incomplete_closeout";
    const checkpointOnly =
      parsed.reconciliation_ledger_ref === null &&
      parsed.gate_ref === null &&
      parsed.p10_transition_ref === null &&
      parsed.lane === undefined;
    if (!full && !checkpointOnly) {
      throw new Error("SCA P09 incomplete closeout terminal shape is invalid");
    }
  }
  if (reconciled && parsed.status === "accepted_progression" && parsed.p10_handoff_ready !== true) {
    throw new Error("SCA P09 accepted progression must be handoff-ready");
  }
  if (parsed.status === "blocked_invalid") {
    if (
      parsed.reconciliation_ledger_ref === null ||
      parsed.gate_ref === null ||
      parsed.p10_transition_ref !== null ||
      parsed.lane !== undefined
    ) {
      throw new Error("SCA P09 blocked_invalid terminal shape is invalid");
    }
  }
  if (parsed.status === "cancelled") {
    if (
      parsed.reconciliation_ledger_ref !== null ||
      parsed.gate_ref !== null ||
      parsed.p10_transition_ref !== null ||
      parsed.lane !== undefined
    ) {
      throw new Error("SCA P09 cancelled terminal cannot carry reconciliation or handoff state");
    }
  }
  selfDigest(parsed, "terminal_sha256", "SCA P09 terminal");
  return parsed;
}
