import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract } from "../contracts.js";
import type { RequiredModelIdentityV1 } from "../required-model.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";

/**
 * Inactive SCA P11 "reporting, semantic review, and bounded repair" candidate contracts.
 *
 * P11 consumes the recorded P10 learning result plus the complete reconciled record universe,
 * produces the exact accepted report set (Markdown, JSON, SARIF) from one accepted
 * finding/disposition projection, performs deterministic validation and separate evidence-aware
 * semantic review, routes actionable defects through bounded repair that re-enters both checks, and
 * emits a derived gate, a non-authorizing P12 handoff, and durable non-positive terminal accounting.
 *
 * The candidate playbook and every schema here are deliberately absent from the active phase and
 * playbook registries and from the public `sca` skill. The one shared wiring the inactive candidate
 * does carry is its provider-opening guard adapter, which the shared worker and opening-guard
 * resolution import exactly as they do for the other inactive candidates; it is inert without a
 * registration and installs nothing. P11 runs no scanner, adapter, graph query, target execution, or
 * independent verification: it consumes already-dispositioned upstream outputs and never
 * re-dispositions, re-learns, adjudicates release, or mutates upstream artifacts. It always emits a
 * non-positive terminal.
 */
export const SCA_P11_PHASE_ID = "SCA-P11" as const;
export const SCA_P11_CANDIDATE_PLAYBOOK_NAME = "sca-p11-candidate" as const;

export const SCA_P11_ADMITTING_STATE = "sca_p11_admitting" as const;
export const SCA_P11_RECONCILING_STATE = "sca_p11_reconciling" as const;
export const SCA_P11_RENDERING_STATE = "sca_p11_rendering" as const;
export const SCA_P11_SCORING_STATE = "sca_p11_scoring" as const;
export const SCA_P11_REVIEWING_STATE = "sca_p11_reviewing" as const;
export const SCA_P11_REPAIRING_STATE = "sca_p11_repairing" as const;
export const SCA_P11_VALIDATING_STATE = "sca_p11_validating" as const;
export const SCA_P11_FINALIZING_STATE = "sca_p11_finalizing" as const;
export const SCA_P11_CANCELLED_STATE = "sca_p11_cancelled" as const;

/** Deterministic (non-cognitive) host states versus the DeepSeek review/repair states. */
export const SCA_P11_HOST_STATES = Object.freeze([
  SCA_P11_ADMITTING_STATE,
  SCA_P11_RECONCILING_STATE,
  SCA_P11_RENDERING_STATE,
  SCA_P11_SCORING_STATE,
  SCA_P11_VALIDATING_STATE,
  SCA_P11_FINALIZING_STATE,
  SCA_P11_CANCELLED_STATE,
]);

export const SCA_P11_REVIEWER_ROLE = "report_semantic_reviewer" as const;
export const SCA_P11_REVIEWER_AGENT = "vera" as const;
/**
 * Host-owned reviewer/repairer identity and execution lineage. The P11 semantic-review and bounded
 * repair records bind these exact values — the producer of the pinned reviewer registration's worker
 * output and the pinned reviewer agent itself — so that a downstream phase (P12) derives the
 * semantic-reviewer separation from the immutable P11 artifacts rather than trusting any verifier's
 * self-declaration. Both are recorded even in provider-free runs where no worker output artifact is
 * captured, because they are fixed by the current reviewer registration.
 */
export const SCA_P11_REVIEWER_IDENTITY_ID = `agent:${SCA_P11_REVIEWER_AGENT}` as const;
export const SCA_P11_REVIEWER_LINEAGE_ID = SCA_P11_REVIEWER_AGENT;

/** Pinned DeepSeek identity for the bounded review/repair calls (no fallback, no default change). */
export const SCA_P11_REQUIRED_MODEL: RequiredModelIdentityV1 = Object.freeze({
  schema_version: 1,
  alias: "deepseek-flash",
  provider: "ollama",
  model: "deepseek-v4.1-flash:cloud",
  override: "ollama/deepseek-v4.1-flash:cloud",
});
/** The cognitive phase declares an empty tool subset; review/repair receive exact artifacts only. */
export const SCA_P11_REQUIRED_TOOL_SUBSET = Object.freeze([] as const);
export const SCA_P11_PROVIDER_OPENING_GUARD = "sca_p11_payload_disclosure_v1" as const;

export const SCA_P11_REVIEW_CALL_ID = "sca-p11-semantic-review" as const;
export const SCA_P11_REVIEW_PURPOSE = "p11_report_semantic_review" as const;
export const SCA_P11_REPAIR_CALL_ID = "sca-p11-bounded-repair" as const;
export const SCA_P11_REPAIR_PURPOSE = "p11_report_bounded_repair" as const;

/** Exact P01-catalog obligations P11 is responsible for. Never silently dropped or downgraded. */
export const SCA_P11_ACCEPTANCE_OBLIGATION_ID = "SCA-OBL-P11-ACCEPTANCE" as const;
export const SCA_P11_REPORT_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-REPORT-MARKDOWN",
  "SCA-OBL-REPORT-STRUCTURED-JSON",
  "SCA-OBL-REPORT-SARIF",
  "SCA-OBL-REPORT-RECONCILIATION",
  "SCA-OBL-REPORT-CVSS-V4",
  "SCA-OBL-REPORT-CHECKSUM-MANIFEST",
  "SCA-OBL-REPORT-EPS-OBLIGATION-LEDGER",
  "SCA-OBL-REPORT-VALIDATION-RECORDS",
] as const);
export const SCA_P11_REQUIRED_OBLIGATION_IDS = Object.freeze(
  [SCA_P11_ACCEPTANCE_OBLIGATION_ID, ...SCA_P11_REPORT_OBLIGATION_IDS].sort()
);

/** Downstream products P11 does not produce and must name as missing. The accounting is durable. */
export const SCA_P11_MISSING_DOWNSTREAM_ARTIFACTS = Object.freeze([
  "penny.sca-p12-release-record.v1",
] as const);
export const SCA_P11_DOWNSTREAM_OBLIGATION_IDS = Object.freeze(["SCA-OBL-P12-ACCEPTANCE"] as const);

/** P10 terminal lanes. The first two are reportable; the last two are non-reportable checkpoints. */
export const SCA_P11_LANES = ["accepted_progression", "incomplete_closeout"] as const;
export type ScaP11LaneV1 = (typeof SCA_P11_LANES)[number];
export const SCA_P11_NON_REPORTABLE_LANES = ["blocked_invalid", "cancelled"] as const;

/** Internal P08 dispositions P11 projects; never a new disposition. */
export const SCA_P11_INTERNAL_DISPOSITIONS = Object.freeze([
  "confirmed",
  "rejected-with-evidence",
  "inconclusive",
  "deferred",
  "duplicate-of",
  "out-of-scope",
] as const);
export type ScaP11InternalDispositionV1 = (typeof SCA_P11_INTERNAL_DISPOSITIONS)[number];

/** The exact seven report statuses and their deterministic internal-disposition mapping. */
export const SCA_P11_REPORT_STATUSES = Object.freeze([
  "Confirmed — PoC verified",
  "Confirmed — code verified",
  "Probable",
  "Theoretical",
  "Remediated",
  "Partially remediated",
  "False positive",
] as const);
export type ScaP11ReportStatusV1 = (typeof SCA_P11_REPORT_STATUSES)[number];

/**
 * Deterministic internal-disposition -> report-status mapping. Only a `confirmed` disposition is
 * presented as a reportable finding; every other internal disposition is retained in the
 * reconciliation output with no report status (never invented as exploitable).
 */
export function scaP11ReportStatusForDisposition(
  disposition: ScaP11InternalDispositionV1
): ScaP11ReportStatusV1 | null {
  switch (disposition) {
    case "confirmed":
      return "Confirmed — code verified";
    case "rejected-with-evidence":
      return "False positive";
    case "inconclusive":
      // Probable: an inconclusive disposition is a reportable record whose evidence is
      // consistent but not yet code-verified (report standard §4/§6).
      return "Probable";
    case "deferred":
      // Theoretical: a deferred record is reportable only as a theoretical exposure until the
      // deferred evidence is established.
      return "Theoretical";
    case "duplicate-of":
    case "out-of-scope":
      return null;
    default:
      return null;
  }
}

/**
 * The exact report statuses P11 can derive from the closed internal-disposition vocabulary. The
 * statuses `Confirmed — PoC verified`, `Remediated`, and `Partially remediated` have no internal
 * disposition source and are deliberately unsupported: a finding is never invented into them.
 */
export const SCA_P11_SUPPORTED_REPORT_STATUSES = Object.freeze([
  "Confirmed — code verified",
  "Probable",
  "Theoretical",
  "False positive",
] as const satisfies readonly ScaP11ReportStatusV1[]);
export const SCA_P11_UNSUPPORTED_REPORT_STATUSES = Object.freeze([
  "Confirmed — PoC verified",
  "Remediated",
  "Partially remediated",
] as const satisfies readonly ScaP11ReportStatusV1[]);

/** Reported severity tokens (the exact title/metadata vocabulary). */
export const SCA_P11_SEVERITY_TOKENS = Object.freeze([
  "Critical",
  "High",
  "Medium",
  "Low",
  "None",
  "Informational",
  "Unscored",
  "Not applicable",
] as const);
export type ScaP11SeverityTokenV1 = (typeof SCA_P11_SEVERITY_TOKENS)[number];

/** CVSS nomenclature; `T`/`E` are included when a Threat/Environmental metric is explicitly set. */
export const SCA_P11_NOMENCLATURES = Object.freeze([
  "CVSS-B",
  "CVSS-BT",
  "CVSS-BE",
  "CVSS-BTE",
] as const);
export type ScaP11NomenclatureV1 = (typeof SCA_P11_NOMENCLATURES)[number];

/** Exception shapes: scored, valid 0.0 None, Informational, Unscored-incomplete, dismissed. */
export const SCA_P11_EXCEPTION_SHAPES = Object.freeze([
  "scored",
  "none_zero",
  "informational",
  "unscored_incomplete",
  "dismissed_non_vulnerability",
] as const);
export type ScaP11ExceptionShapeV1 = (typeof SCA_P11_EXCEPTION_SHAPES)[number];

export function scaP11SeverityTokenForScore(score: number): ScaP11SeverityTokenV1 {
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    throw new Error("SCA P11 CVSS score is outside 0.0..10.0");
  }
  if (score === 0) return "None";
  if (score < 4) return "Low";
  if (score < 7) return "Medium";
  if (score < 9) return "High";
  return "Critical";
}

/** The eleven mandatory Base metrics in the exact required order. */
export const SCA_P11_BASE_METRICS = Object.freeze([
  "AV",
  "AC",
  "AT",
  "PR",
  "UI",
  "VC",
  "VI",
  "VA",
  "SC",
  "SI",
  "SA",
] as const);
export type ScaP11BaseMetricV1 = (typeof SCA_P11_BASE_METRICS)[number];

export const SCA_P11_SEMANTIC_VERDICTS = Object.freeze([
  "supported",
  "refuted",
  "insufficient",
] as const);
export type ScaP11SemanticVerdictV1 = (typeof SCA_P11_SEMANTIC_VERDICTS)[number];

export const SCA_P11_OPEN_ITEM_DISPOSITIONS = Object.freeze([
  "repaired",
  "retained-incomplete",
  "dismissed-with-evidence",
] as const);
export type ScaP11OpenItemDispositionV1 = (typeof SCA_P11_OPEN_ITEM_DISPOSITIONS)[number];

export const SCA_P11_ADDENDUM_KINDS = Object.freeze([
  "later_campaign_fact",
  "later_disposition_revision",
  "separate_rescan_outcome",
] as const);
export type ScaP11AddendumKindV1 = (typeof SCA_P11_ADDENDUM_KINDS)[number];

export const SCA_P11_REASSESSMENT_TRIGGER_CODES = Object.freeze([
  "new_evidence",
  "invalidated_evidence",
  "changed_snapshot",
  "changed_rule_release",
  "scope_change",
] as const);
export type ScaP11ReassessmentTriggerCodeV1 = (typeof SCA_P11_REASSESSMENT_TRIGGER_CODES)[number];

export const SCA_P11_CHECKSUM_SCHEMA = "penny.sca-p11-checksum-manifest.v1" as const;
export const SCA_P11_CANDIDATE_START_SCHEMA = "penny.sca-p11-candidate-start.v1" as const;
export const SCA_P11_ADMISSION_SCHEMA = "penny.sca-p11-admission.v1" as const;
export const SCA_P11_DISCLOSURE_SCOPE_SCHEMA = "penny.sca-p11-disclosure-scope.v1" as const;
export const SCA_P11_DISCLOSURE_ADMISSION_SCHEMA = "penny.sca-p11-disclosure-admission.v1" as const;
export const SCA_P11_COGNITIVE_PAYLOAD_SCHEMA = "penny.sca-p11-cognitive-payload.v1" as const;
export const SCA_P11_SEMANTIC_REVIEW_SCHEMA = "penny.sca-p11-semantic-review.v1" as const;
export const SCA_P11_REPAIR_RECORD_SCHEMA = "penny.sca-p11-repair-record.v1" as const;
export const SCA_P11_REPAIR_PATCH_SCHEMA = "penny.sca-p11-repair-patch.v1" as const;
export const SCA_P11_ADDENDUM_SCHEMA = "penny.sca-p11-addendum.v1" as const;
export const SCA_P11_CHECKPOINT_SCHEMA = "penny.sca-p11-checkpoint.v1" as const;
export const SCA_P11_REASSESSMENT_SCHEMA = "penny.sca-p11-reassessment.v1" as const;
export const SCA_P11_SCORING_POLICY_SCHEMA = "penny.sca-p11-scoring-policy.v1" as const;
export const SCA_P11_REPORT_POLICY_SCHEMA = "penny.sca-p11-report-policy.v1" as const;
export const SCA_P11_RECONCILIATION_SCHEMA = "penny.sca-p11-reconciliation.v1" as const;
export const SCA_P11_REPORT_MARKDOWN_SCHEMA = "penny.sca-p11-report-markdown.v1" as const;
export const SCA_P11_REPORT_JSON_SCHEMA = "penny.sca-p11-report-json.v1" as const;
export const SCA_P11_REPORT_SARIF_SCHEMA = "penny.sca-p11-report-sarif.v1" as const;
export const SCA_P11_SCORING_RECORDS_SCHEMA = "penny.sca-p11-scoring-records.v1" as const;
export const SCA_P11_SCORER_QUALIFICATION_SCHEMA = "penny.sca-p11-scorer-qualification.v1" as const;
export const SCA_P11_OBLIGATION_LEDGER_SCHEMA = "penny.sca-p11-obligation-ledger.v1" as const;
export const SCA_P11_VALIDATION_RECORDS_SCHEMA = "penny.sca-p11-validation-records.v1" as const;
export const SCA_P11_REPORT_SCHEMA = "penny.sca-p11-report.v1" as const;
export const SCA_P11_GATE_SCHEMA = "penny.sca-p11-gate.v1" as const;
export const SCA_P11_TERMINAL_SCHEMA = "penny.sca-p11-terminal.v1" as const;
export const SCA_P11_TO_P12_TRANSITION_SCHEMA = "penny.sca-p11-to-p12-transition.v1" as const;

/**
 * The three schema ids P09/P10 already name as missing downstream artifacts. P11 closes the
 * accounting without renaming.
 */
export const SCA_P11_RECONCILIATION_SCHEMA_ID = SCA_P11_RECONCILIATION_SCHEMA;
export const SCA_P11_REPORT_SCHEMA_ID = SCA_P11_REPORT_SCHEMA;
export const SCA_P11_VALIDATION_RECORDS_SCHEMA_ID = SCA_P11_VALIDATION_RECORDS_SCHEMA;

const NonEmptyTextSchema = Type.String({ minLength: 1, maxLength: 16_384 });
const BlockerCodeSchema = Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" });
const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);
const ItemIdSchema = Type.String({ pattern: "^p09item_[a-f0-9]{64}$" });
const CweIdSchema = Type.String({ pattern: "^CWE-[0-9]{1,5}$" });

const RequiredModelSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    alias: Type.Literal("deepseek-flash"),
    provider: Type.Literal("ollama"),
    model: Type.Literal("deepseek-v4.1-flash:cloud"),
    override: Type.Literal("ollama/deepseek-v4.1-flash:cloud"),
  },
  { additionalProperties: false }
);

const LaneSchema = Type.Union([
  Type.Literal("accepted_progression"),
  Type.Literal("incomplete_closeout"),
]);
const ReportStatusSchema = Type.Union([
  Type.Literal("Confirmed — PoC verified"),
  Type.Literal("Confirmed — code verified"),
  Type.Literal("Probable"),
  Type.Literal("Theoretical"),
  Type.Literal("Remediated"),
  Type.Literal("Partially remediated"),
  Type.Literal("False positive"),
]);
const SeverityTokenSchema = Type.Union([
  Type.Literal("Critical"),
  Type.Literal("High"),
  Type.Literal("Medium"),
  Type.Literal("Low"),
  Type.Literal("None"),
  Type.Literal("Informational"),
  Type.Literal("Unscored"),
  Type.Literal("Not applicable"),
]);
const NomenclatureSchema = Type.Union([
  Type.Literal("CVSS-B"),
  Type.Literal("CVSS-BT"),
  Type.Literal("CVSS-BE"),
  Type.Literal("CVSS-BTE"),
]);
const ExceptionShapeSchema = Type.Union([
  Type.Literal("scored"),
  Type.Literal("none_zero"),
  Type.Literal("informational"),
  Type.Literal("unscored_incomplete"),
  Type.Literal("dismissed_non_vulnerability"),
]);
const PresenceSchema = Type.Object(
  {
    markdown: Type.Boolean(),
    json: Type.Boolean(),
    sarif: Type.Boolean(),
  },
  { additionalProperties: false }
);
const SemanticVerdictSchema = Type.Union([
  Type.Literal("supported"),
  Type.Literal("refuted"),
  Type.Literal("insufficient"),
]);
const OpenItemDispositionSchema = Type.Union([
  Type.Literal("repaired"),
  Type.Literal("retained-incomplete"),
  Type.Literal("dismissed-with-evidence"),
]);
const AddendumKindSchema = Type.Union([
  Type.Literal("later_campaign_fact"),
  Type.Literal("later_disposition_revision"),
  Type.Literal("separate_rescan_outcome"),
]);
const ReassessmentTriggerSchema = Type.Union([
  Type.Literal("new_evidence"),
  Type.Literal("invalidated_evidence"),
  Type.Literal("changed_snapshot"),
  Type.Literal("changed_rule_release"),
  Type.Literal("scope_change"),
]);

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function assertSortedUnique(values: readonly string[], label: string): void {
  const sorted = [...new Set(values)].sort();
  if (!same(values, sorted)) {
    throw new Error(`${label} must be unique and lexicographically sorted`);
  }
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

export function withP11Digest<T extends Readonly<Record<string, unknown>>, K extends string>(
  value: T,
  field: K
): T & Readonly<Record<K, string>> {
  return { ...value, [field]: sha256(canonicalJson(value)) } as T & Readonly<Record<K, string>>;
}

/** Stable identity of one reconciled record row, derived from its kind and identity. */
export function scaP11RecordId(input: {
  readonly record_kind: string;
  readonly identity: string;
}): string {
  return `p11rec_${sha256(canonicalJson({ record_kind: input.record_kind, identity: input.identity }))}`;
}

// --- Request / admission ---------------------------------------------------------------------

export const ScaP11CandidateStartV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_CANDIDATE_START_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    /** Exact P10 terminal/handoff/record refs; the sole entry point. */
    p10_terminal_ref: ArtifactRefSchema,
    p10_transition_ref: NullableArtifactRefSchema,
    p10_outcome_ref: NullableArtifactRefSchema,
    p10_gate_ref: NullableArtifactRefSchema,
    p10_admission_ref: NullableArtifactRefSchema,
    p10_eligibility_ledger_ref: NullableArtifactRefSchema,
    p10_candidate_registry_ref: NullableArtifactRefSchema,
    /** Exact P09 base refs (required so P11 re-derives rather than trusts). */
    p09_terminal_ref: ArtifactRefSchema,
    p09_transition_ref: NullableArtifactRefSchema,
    p09_reconciliation_ledger_ref: NullableArtifactRefSchema,
    p09_gate_ref: NullableArtifactRefSchema,
    p09_admission_ref: NullableArtifactRefSchema,
    /** Exact P08 base refs. */
    p08_terminal_ref: ArtifactRefSchema,
    p08_transition_ref: NullableArtifactRefSchema,
    p08_evidence_ledger_ref: NullableArtifactRefSchema,
    p08_gate_ref: NullableArtifactRefSchema,
    p08_admission_ref: NullableArtifactRefSchema,
    p08_item_universe_ref: NullableArtifactRefSchema,
    p01_obligation_ledger_ref: ArtifactRefSchema,
    /** Exact re-derivation inputs the P10 shared admission path requires. */
    baseline_evidence_ref: ArtifactRefSchema,
    p10_disclosure_scope_ref: ArtifactRefSchema,
    promotion_authority_ref: ArtifactRefSchema,
    active_run_rule_release_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    p09_coverage_input_ref: NullableArtifactRefSchema,
    p09_phase_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    p09_obligation_resolution_ref: NullableArtifactRefSchema,
    p09_reassessment_ref: NullableArtifactRefSchema,
    p10_reassessment_ref: NullableArtifactRefSchema,
    p10_prior_ledger_ref: NullableArtifactRefSchema,
    /** P11 caller constraints. */
    p11_disclosure_scope_ref: ArtifactRefSchema,
    /** Optional distinct admitted repair disclosure scope; absent means repair is not authorized. */
    p11_repair_disclosure_scope_ref: NullableArtifactRefSchema,
    scoring_policy_ref: ArtifactRefSchema,
    report_policy_ref: ArtifactRefSchema,
    p11_reassessment_ref: NullableArtifactRefSchema,
    p11_prior_report_ref: NullableArtifactRefSchema,
  },
  { additionalProperties: false, $id: SCA_P11_CANDIDATE_START_SCHEMA }
);
export type ScaP11CandidateStartV1 = Readonly<Static<typeof ScaP11CandidateStartV1Schema>>;

export const ScaP11AdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_ADMISSION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    p10_terminal_ref: ArtifactRefSchema,
    p10_transition_ref: NullableArtifactRefSchema,
    p09_reconciliation_ledger_ref: NullableArtifactRefSchema,
    p10_outcome_ref: NullableArtifactRefSchema,
    p11_disclosure_scope_ref: ArtifactRefSchema,
    p11_repair_disclosure_scope_ref: NullableArtifactRefSchema,
    scoring_policy_ref: ArtifactRefSchema,
    report_policy_ref: ArtifactRefSchema,
    /** Absent when the input P10 terminal is a non-reportable checkpoint. */
    lane: Type.Optional(LaneSchema),
    reportable: Type.Boolean(),
    non_reportable_reason: Type.Union([NonEmptyTextSchema, Type.Null()]),
    p10_rederivation_ok: Type.Boolean(),
    p10_handoff_agreement_ok: Type.Boolean(),
    item_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    candidate_count: Type.Integer({ minimum: 0, maximum: 1_000 }),
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_ADMISSION_SCHEMA }
);
export type ScaP11AdmissionV1 = Readonly<Static<typeof ScaP11AdmissionV1Schema>>;

export const ScaP11DisclosureScopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_DISCLOSURE_SCOPE_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    required_model: RequiredModelSchema,
    destination_class: Type.Literal("cloud"),
    purpose: Type.Union([
      Type.Literal(SCA_P11_REVIEW_PURPOSE),
      Type.Literal(SCA_P11_REPAIR_PURPOSE),
    ]),
    allowed_data_classes: Type.Tuple([
      Type.Literal("report_assertion_projections"),
      Type.Literal("finding_evidence_excerpts"),
      Type.Literal("source_pointer_projections"),
    ]),
    provider_retention_status: Type.Literal("known"),
    provider_retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    provider_logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_training_use: Type.Literal("prohibited"),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 786_432 }),
    max_provider_calls: Type.Integer({ minimum: 0, maximum: 64 }),
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
    issued_at: Rfc3339UtcSchema,
    scope_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_DISCLOSURE_SCOPE_SCHEMA }
);
export type ScaP11DisclosureScopeV1 = Readonly<Static<typeof ScaP11DisclosureScopeV1Schema>>;

const PayloadAssertionSchema = Type.Object(
  {
    assertion_id: OpaqueIdSchema,
    target_kind: Type.Union([
      Type.Literal("finding"),
      Type.Literal("report"),
      Type.Literal("open_item"),
    ]),
    target_id: OpaqueIdSchema,
    claim: NonEmptyTextSchema,
    /**
     * The host-assigned evidence allowlist for this assertion. A reviewer verdict may only cite an
     * exact ref from this list for its assertion; any other ref is foreign and cannot support it.
     */
    evidence_allowlist: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
    source_pointer: Type.Union([NonEmptyTextSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

export const ScaP11CognitivePayloadV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_COGNITIVE_PAYLOAD_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    call_id: Type.Union([
      Type.Literal(SCA_P11_REVIEW_CALL_ID),
      Type.Literal(SCA_P11_REPAIR_CALL_ID),
    ]),
    role: Type.Literal(SCA_P11_REVIEWER_ROLE),
    purpose: Type.Union([
      Type.Literal(SCA_P11_REVIEW_PURPOSE),
      Type.Literal(SCA_P11_REPAIR_PURPOSE),
    ]),
    required_model: RequiredModelSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    report_ref: ArtifactRefSchema,
    reconciliation_ref: ArtifactRefSchema,
    scoring_records_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    disclosure_scope_ref: ArtifactRefSchema,
    repair_violations: Type.Array(NonEmptyTextSchema, { maxItems: 128 }),
    assigned_assertion_ids: Type.Array(OpaqueIdSchema, { maxItems: 100_000 }),
    assertions: Type.Array(PayloadAssertionSchema, { maxItems: 100_000 }),
    payload_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_COGNITIVE_PAYLOAD_SCHEMA }
);
export type ScaP11CognitivePayloadV1 = Readonly<Static<typeof ScaP11CognitivePayloadV1Schema>>;

export const ScaP11DisclosureAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_DISCLOSURE_ADMISSION_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    call_id: Type.Union([
      Type.Literal(SCA_P11_REVIEW_CALL_ID),
      Type.Literal(SCA_P11_REPAIR_CALL_ID),
    ]),
    role: Type.Literal(SCA_P11_REVIEWER_ROLE),
    purpose: Type.Union([
      Type.Literal(SCA_P11_REVIEW_PURPOSE),
      Type.Literal(SCA_P11_REPAIR_PURPOSE),
    ]),
    required_model: RequiredModelSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    disclosure_scope_sha256: Sha256Schema,
    payload_ref: ArtifactRefSchema,
    payload_sha256: Sha256Schema,
    payload_byte_length: Type.Integer({ minimum: 1, maximum: 786_432 }),
    serialized_opening_byte_limit: Type.Integer({ minimum: 1, maximum: 786_432 }),
    authorized_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 100_000 }),
    destination: Type.Literal("cloud"),
    retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    training: Type.Literal("prohibited"),
    /** Truthful host-owned scan result of the exact serialized payload; never a constant. */
    secrets_embedded: Type.Boolean(),
    personal_data_embedded: Type.Boolean(),
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
    evaluated_before_dispatch: Type.Literal(true),
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_DISCLOSURE_ADMISSION_SCHEMA }
);
export type ScaP11DisclosureAdmissionV1 = Readonly<
  Static<typeof ScaP11DisclosureAdmissionV1Schema>
>;

// --- Reconciliation / scoring policy ---------------------------------------------------------

export const SCA_P11_RECORD_KINDS = Object.freeze([
  "p09_ledger_item",
  "p10_rule_learning_outcome",
  "p10_rule_candidate",
] as const);
export type ScaP11RecordKindV1 = (typeof SCA_P11_RECORD_KINDS)[number];

export const ScaP11ReconciliationRowV1Schema = Type.Object(
  {
    record_id: Type.String({ pattern: "^p11rec_[a-f0-9]{64}$" }),
    record_kind: Type.Union([
      Type.Literal("p09_ledger_item"),
      Type.Literal("p10_rule_learning_outcome"),
      Type.Literal("p10_rule_candidate"),
    ]),
    identity: OpaqueIdSchema,
    item_id: Type.Union([ItemIdSchema, Type.Null()]),
    source_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    current_disposition: Type.Union([
      Type.Literal("confirmed"),
      Type.Literal("rejected-with-evidence"),
      Type.Literal("inconclusive"),
      Type.Literal("deferred"),
      Type.Literal("duplicate-of"),
      Type.Literal("out-of-scope"),
      Type.Literal("not_disposed"),
    ]),
    /** Absent when the record is retained but not presented as a reportable finding. */
    report_status: Type.Union([ReportStatusSchema, Type.Null()]),
    reportable: Type.Boolean(),
    /** True for AI-discovered issues that have no deterministic scanner JSON record. */
    semantic_only: Type.Boolean(),
    representation_presence: PresenceSchema,
    duplicate_of: Type.Union([OpaqueIdSchema, Type.Null()]),
    missing_material: Type.Array(NonEmptyTextSchema, { maxItems: 64 }),
    checkpoint_ref: NullableArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type ScaP11ReconciliationRowV1 = Readonly<Static<typeof ScaP11ReconciliationRowV1Schema>>;

export const ScaP11ReconciliationV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_RECONCILIATION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    p09_reconciliation_ledger_ref: ArtifactRefSchema,
    p10_outcome_ref: NullableArtifactRefSchema,
    rows: Type.Array(ScaP11ReconciliationRowV1Schema, { minItems: 1, maxItems: 10_000 }),
    record_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    reportable_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    semantic_only_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    retained_non_reportable_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    unresolved_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    /** Derived by the reconciliation manifest: the universe is accounted for exactly once. */
    set_equality_valid: Type.Boolean(),
    append_only: Type.Literal(true),
    reconciliation_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_RECONCILIATION_SCHEMA }
);
export type ScaP11ReconciliationV1 = Readonly<Static<typeof ScaP11ReconciliationV1Schema>>;

export const ScaP11ScoringPolicyEntryV1Schema = Type.Object(
  {
    target_id: OpaqueIdSchema,
    base_metrics: Type.Array(
      Type.Object(
        {
          metric: Type.Union([
            Type.Literal("AV"),
            Type.Literal("AC"),
            Type.Literal("AT"),
            Type.Literal("PR"),
            Type.Literal("UI"),
            Type.Literal("VC"),
            Type.Literal("VI"),
            Type.Literal("VA"),
            Type.Literal("SC"),
            Type.Literal("SI"),
            Type.Literal("SA"),
          ]),
          value: Type.String({ pattern: "^[A-Z]{1,2}$" }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 11 }
    ),
    threat_metrics: Type.Array(
      Type.Object(
        {
          metric: Type.Literal("E"),
          value: Type.String({ pattern: "^[A-Z]$" }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1 }
    ),
    environmental_metrics: Type.Array(
      Type.Object(
        {
          metric: Type.String({ pattern: "^[A-Z]{1,2}$" }),
          value: Type.String({ pattern: "^[A-Z]$" }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 16 }
    ),
    exception_shape: ExceptionShapeSchema,
    rationale: NonEmptyTextSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
  },
  { additionalProperties: false }
);
export type ScaP11ScoringPolicyEntryV1 = Readonly<Static<typeof ScaP11ScoringPolicyEntryV1Schema>>;

export const ScaP11ScoringPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_SCORING_POLICY_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    entries: Type.Array(ScaP11ScoringPolicyEntryV1Schema, { maxItems: 10_000 }),
    policy_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_SCORING_POLICY_SCHEMA }
);
export type ScaP11ScoringPolicyV1 = Readonly<Static<typeof ScaP11ScoringPolicyV1Schema>>;

/**
 * The admitted report-content authority. P11 authors layout and consistency only; it never invents
 * a vulnerability claim. Every narrative, CWE, and threat-model fact is projected from this
 * admitted policy, or the finding is retained as incomplete with explicit missing material.
 */
export const ScaP11ReportPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_REPORT_POLICY_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    statements: Type.Object(
      {
        assessment_identity: NonEmptyTextSchema,
        scope_statement: NonEmptyTextSchema,
        coverage_statement: NonEmptyTextSchema,
        rule_learning_statement: NonEmptyTextSchema,
        tools_statement: NonEmptyTextSchema,
        executive_summary: NonEmptyTextSchema,
      },
      { additionalProperties: false }
    ),
    entries: Type.Array(
      Type.Object(
        {
          identity: OpaqueIdSchema,
          title: NonEmptyTextSchema,
          cwe_id: Type.Union([CweIdSchema, Type.Null()]),
          cwe_name: Type.Union([NonEmptyTextSchema, Type.Null()]),
          threat_model_id: Type.Union([
            Type.String({ pattern: "^\\{[A-Z0-9_-]{1,96}\\}$" }),
            Type.Null(),
          ]),
          description: NonEmptyTextSchema,
          steps_to_reproduce: Type.Array(NonEmptyTextSchema, { minItems: 1, maxItems: 128 }),
          code_analysis: Type.Array(NonEmptyTextSchema, { minItems: 1, maxItems: 128 }),
          remediation: NonEmptyTextSchema,
          /**
           * Optional host-authored status note override. A bounded `correct_status_note` repair
           * sets this field for an existing finding; it never changes the finding's status.
           */
          status_note: Type.Union([NonEmptyTextSchema, Type.Null()]),
          evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 10_000 }
    ),
    policy_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_REPORT_POLICY_SCHEMA }
);
export type ScaP11ReportPolicyV1 = Readonly<Static<typeof ScaP11ReportPolicyV1Schema>>;

// --- Semantic review / repair / addendum -----------------------------------------------------

export const ScaP11SemanticReviewV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_SEMANTIC_REVIEW_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    call_id: Type.Literal(SCA_P11_REVIEW_CALL_ID),
    role: Type.Literal(SCA_P11_REVIEWER_ROLE),
    /** Exact reviewer identity (worker output producer) and execution lineage (pinned agent). */
    reviewer_identity_id: OpaqueIdSchema,
    reviewer_lineage_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    report_ref: ArtifactRefSchema,
    report_sha256: Sha256Schema,
    payload_sha256: Sha256Schema,
    /**
     * Exact coverage of the payload's assigned assertion set. A review that resolves fewer (or
     * more) assertions than the host assigned is rejected before any gate is derived.
     */
    verdicts: Type.Array(
      Type.Object(
        {
          assertion_id: OpaqueIdSchema,
          target_id: OpaqueIdSchema,
          verdict: SemanticVerdictSchema,
          reason: NonEmptyTextSchema,
          evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
          repair_candidate: Type.Union([NonEmptyTextSchema, Type.Null()]),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 100_000 }
    ),
    open_items: Type.Array(
      Type.Object(
        {
          open_item_id: OpaqueIdSchema,
          target_id: OpaqueIdSchema,
          severity: Type.Union([Type.Literal("blocking"), Type.Literal("actionable")]),
          evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
          disposition: OpenItemDispositionSchema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 100_000 }
    ),
    gate_verdict_set: Type.Literal(false),
    complete: Type.Literal(true),
    review_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_SEMANTIC_REVIEW_SCHEMA }
);
export type ScaP11SemanticReviewV1 = Readonly<Static<typeof ScaP11SemanticReviewV1Schema>>;

export const ScaP11RepairRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_REPAIR_RECORD_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    base_report_ref: ArtifactRefSchema,
    base_report_sha256: Sha256Schema,
    base_revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    /** Exact repairer identity and execution lineage, bound to the re-entered review record. */
    repairer_identity_id: OpaqueIdSchema,
    repairer_lineage_id: OpaqueIdSchema,
    ordered_operations: Type.Array(
      Type.Object(
        {
          operation: Type.Union([
            Type.Literal("add_finding"),
            Type.Literal("add_metadata"),
            Type.Literal("add_section"),
            Type.Literal("rewrite_prose"),
            Type.Literal("add_evidence_ref"),
            Type.Literal("correct_status_note"),
          ]),
          target_id: OpaqueIdSchema,
          detail: NonEmptyTextSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 1_024 }
    ),
    violations_addressed: Type.Array(NonEmptyTextSchema, { minItems: 1, maxItems: 128 }),
    reentry: Type.Object(
      {
        deterministic_validation_ref: ArtifactRefSchema,
        deterministic_validation_passed: Type.Boolean(),
        semantic_review_ref: ArtifactRefSchema,
        semantic_review_passed: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
    deleted_finding_ids: Type.Array(OpaqueIdSchema, { maxItems: 0 }),
    repair_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_REPAIR_RECORD_SCHEMA }
);
export type ScaP11RepairRecordV1 = Readonly<Static<typeof ScaP11RepairRecordV1Schema>>;

/**
 * The bounded repair output. A repair may only rewrite prose, supply missing narrative sections, or
 * correct a status note. It structurally cannot upgrade a status or severity, add CWE/threat
 * metadata, or supply a score, so a report cannot be made complete by prose repair alone.
 */
export const ScaP11RepairPatchV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_REPAIR_PATCH_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    call_id: Type.Literal(SCA_P11_REPAIR_CALL_ID),
    role: Type.Literal(SCA_P11_REVIEWER_ROLE),
    /** Exact repairer identity (worker output producer) and execution lineage (pinned agent). */
    repairer_identity_id: OpaqueIdSchema,
    repairer_lineage_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    report_ref: ArtifactRefSchema,
    report_sha256: Sha256Schema,
    payload_sha256: Sha256Schema,
    operations: Type.Array(
      Type.Object(
        {
          operation: Type.Union([
            Type.Literal("rewrite_prose"),
            Type.Literal("add_section"),
            Type.Literal("correct_status_note"),
          ]),
          target_id: OpaqueIdSchema,
          field: Type.Union([
            Type.Literal("description"),
            Type.Literal("remediation"),
            Type.Literal("status_note"),
            Type.Literal("steps_to_reproduce"),
            Type.Literal("code_analysis"),
          ]),
          value: NonEmptyTextSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 1_024 }
    ),
    no_metadata_upgrade: Type.Literal(true),
    no_finding_removed: Type.Literal(true),
    complete: Type.Literal(true),
    patch_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_REPAIR_PATCH_SCHEMA }
);
export type ScaP11RepairPatchV1 = Readonly<Static<typeof ScaP11RepairPatchV1Schema>>;

export const ScaP11AddendumV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_ADDENDUM_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    base_report_ref: ArtifactRefSchema,
    base_report_digest: Sha256Schema,
    addendum_kind: AddendumKindSchema,
    subject_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
    rationale: NonEmptyTextSchema,
    /** Addenda are companions only: they can never complete an incomplete report. */
    completes_report: Type.Literal(false),
    mutates_report: Type.Literal(false),
    append_only: Type.Literal(true),
    invalidates_release_approval: Type.Literal(true),
    addendum_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_ADDENDUM_SCHEMA }
);
export type ScaP11AddendumV1 = Readonly<Static<typeof ScaP11AddendumV1Schema>>;

export const ScaP11CheckpointV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_CHECKPOINT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    item_id: OpaqueIdSchema,
    identity: OpaqueIdSchema,
    reason_code: BlockerCodeSchema,
    primary_ref: ArtifactRefSchema,
    missing_evidence_need: NonEmptyTextSchema,
    reopen_condition: NonEmptyTextSchema,
    checkpoint_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_CHECKPOINT_SCHEMA }
);
export type ScaP11CheckpointV1 = Readonly<Static<typeof ScaP11CheckpointV1Schema>>;

export const ScaP11ReassessmentV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_REASSESSMENT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    prior_report_ref: ArtifactRefSchema,
    prior_report_sha256: Sha256Schema,
    prior_validation_ref: ArtifactRefSchema,
    prior_validation_sha256: Sha256Schema,
    trigger_codes: Type.Array(ReassessmentTriggerSchema, { minItems: 1, maxItems: 5 }),
    stimulus_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
    invalidated_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
    reassessment_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_REASSESSMENT_SCHEMA }
);
export type ScaP11ReassessmentV1 = Readonly<Static<typeof ScaP11ReassessmentV1Schema>>;

// --- Accepted finding/disposition projection and representations ------------------------------

export const ScaP11AcceptedFindingV1Schema = Type.Object(
  {
    finding_id: OpaqueIdSchema,
    identity: OpaqueIdSchema,
    semantic_only: Type.Boolean(),
    title: NonEmptyTextSchema,
    severity_token: SeverityTokenSchema,
    cvss_score: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
    cvss_vector: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    base_severity_token: Type.Union([SeverityTokenSchema, Type.Null()]),
    base_cvss_score: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
    base_cvss_vector: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    nomenclature: Type.Union([NomenclatureSchema, Type.Null()]),
    cwe_id: Type.Union([CweIdSchema, Type.Null()]),
    cwe_name: Type.Union([NonEmptyTextSchema, Type.Null()]),
    status: Type.Union([ReportStatusSchema, Type.Null()]),
    status_note: Type.Union([NonEmptyTextSchema, Type.Null()]),
    threat_model_id: Type.Union([
      Type.String({ pattern: "^\\{[A-Z0-9_-]{1,96}\\}$" }),
      Type.Null(),
    ]),
    exception_shape: ExceptionShapeSchema,
    scoring_record_ref: NullableArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
    source_refs: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
    description: NonEmptyTextSchema,
    steps_to_reproduce: Type.Array(NonEmptyTextSchema, { minItems: 1, maxItems: 128 }),
    code_analysis: Type.Array(NonEmptyTextSchema, { minItems: 1, maxItems: 128 }),
    remediation: NonEmptyTextSchema,
    complete: Type.Boolean(),
    missing_material: Type.Array(NonEmptyTextSchema, { maxItems: 64 }),
  },
  { additionalProperties: false }
);
export type ScaP11AcceptedFindingV1 = Readonly<Static<typeof ScaP11AcceptedFindingV1Schema>>;

/**
 * The single accepted finding/disposition set. Every representation derives from exactly this
 * object, so cross-representation set equality is a structural property rather than a hope.
 */
export const ScaP11ReportJsonV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_REPORT_JSON_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    lane: LaneSchema,
    status: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
    source_snapshot_sha256: Sha256Schema,
    assessment_identity: NonEmptyTextSchema,
    scope_statement: NonEmptyTextSchema,
    coverage_statement: NonEmptyTextSchema,
    rule_learning_statement: NonEmptyTextSchema,
    tools_statement: NonEmptyTextSchema,
    executive_summary: NonEmptyTextSchema,
    findings: Type.Array(ScaP11AcceptedFindingV1Schema, { maxItems: 10_000 }),
    finding_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    incomplete_finding_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    missing_sections: Type.Array(NonEmptyTextSchema, { maxItems: 1_024 }),
    representation_omissions: Type.Array(
      Type.Object(
        {
          representation: Type.Union([
            Type.Literal("markdown"),
            Type.Literal("json"),
            Type.Literal("sarif"),
          ]),
          omission: NonEmptyTextSchema,
          justification: NonEmptyTextSchema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    report_json_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_REPORT_JSON_SCHEMA }
);
export type ScaP11ReportJsonV1 = Readonly<Static<typeof ScaP11ReportJsonV1Schema>>;

export const ScaP11ReportSarifV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_REPORT_SARIF_SCHEMA),
    schema_version: Type.Literal(1),
    sarif_schema_version: Type.Literal("2.1.0"),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    driver_name: Type.Literal("penny-sca-p11"),
    rules: Type.Array(
      Type.Object(
        {
          id: NonEmptyTextSchema,
          name: NonEmptyTextSchema,
          shortDescription: NonEmptyTextSchema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 10_000 }
    ),
    results: Type.Array(
      Type.Object(
        {
          ruleId: NonEmptyTextSchema,
          level: Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("note")]),
          message: NonEmptyTextSchema,
          finding_id: OpaqueIdSchema,
          locations: Type.Array(
            Type.Object(
              {
                path: NonEmptyTextSchema,
                start_line: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
              },
              { additionalProperties: false }
            ),
            { maxItems: 64 }
          ),
        },
        { additionalProperties: false }
      ),
      { maxItems: 10_000 }
    ),
    result_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    sarif_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_REPORT_SARIF_SCHEMA }
);
export type ScaP11ReportSarifV1 = Readonly<Static<typeof ScaP11ReportSarifV1Schema>>;

export const ScaP11ScoringRecordsV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_SCORING_RECORDS_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    scorer_id: Type.Union([NonEmptyTextSchema, Type.Null()]),
    scorer_build_sha256: Type.Union([Sha256Schema, Type.Null()]),
    scorer_authority_admitted: Type.Boolean(),
    /** Exact admitted CVSS scorer qualification receipt this scoring run was produced under. */
    scorer_qualification_ref: NullableArtifactRefSchema,
    scorer_qualification_sha256: Type.Union([Sha256Schema, Type.Null()]),
    records: Type.Array(
      Type.Object(
        {
          target_id: OpaqueIdSchema,
          exception_shape: ExceptionShapeSchema,
          metric_vector: Type.Union([
            Type.Array(NonEmptyTextSchema, { maxItems: 16 }),
            Type.Null(),
          ]),
          nomenclature: Type.Union([NomenclatureSchema, Type.Null()]),
          score: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
          severity_token: Type.Union([SeverityTokenSchema, Type.Null()]),
          base_vector: Type.Union([Type.Array(NonEmptyTextSchema, { maxItems: 11 }), Type.Null()]),
          base_score: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
          rationale: NonEmptyTextSchema,
          evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
          model_proposed_number: Type.Literal(false),
        },
        { additionalProperties: false }
      ),
      { maxItems: 10_000 }
    ),
    record_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    scored_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    unscored_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    records_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_SCORING_RECORDS_SCHEMA }
);
export type ScaP11ScoringRecordsV1 = Readonly<Static<typeof ScaP11ScoringRecordsV1Schema>>;

/**
 * The exact admitted CVSS v4.0 scorer qualification receipt. It binds the scorer's identity, build
 * digest, official FIRST reference corpus, and the exact reference vectors the scorer must
 * reproduce. Production composition re-reads this exact artifact (never trusting an object shape).
 */
export const ScaP11CvssScorerQualificationV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_SCORER_QUALIFICATION_SCHEMA),
    schema_version: Type.Literal(1),
    scorer_id: NonEmptyTextSchema,
    /**
     * The exact admitted scorer implementation this receipt claims. The host resolves this id
     * against its own admitted implementation registry and requires `build_sha256` to match the
     * resolved build; the receipt never defines truth about a score.
     */
    implementation_id: NonEmptyTextSchema,
    /**
     * The build digest of the admitted implementation (host-owned), not a digest of the receipt
     * body. It is re-checked against the currently admitted implementation on every use.
     */
    build_sha256: Sha256Schema,
    official_references: Type.Array(NonEmptyTextSchema, { minItems: 1, maxItems: 16 }),
    reference_vectors: Type.Array(
      Type.Object(
        {
          vector: NonEmptyTextSchema,
          score: Type.Number({ minimum: 0, maximum: 10 }),
          nomenclature: NomenclatureSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 256 }
    ),
    qualification_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_SCORER_QUALIFICATION_SCHEMA }
);
export type ScaP11CvssScorerQualificationV1 = Readonly<
  Static<typeof ScaP11CvssScorerQualificationV1Schema>
>;

export const ScaP11ChecksumManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_CHECKSUM_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    artifacts: Type.Array(
      Type.Object(
        {
          artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
          kind: NonEmptyTextSchema,
          content_digest: Sha256Schema,
          byte_length: Type.Integer({ minimum: 0, maximum: 1_073_741_824 }),
          representation: Type.Union([
            Type.Literal("markdown"),
            Type.Literal("json"),
            Type.Literal("sarif"),
            Type.Literal("record"),
          ]),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 512 }
    ),
    artifact_count: Type.Integer({ minimum: 0, maximum: 512 }),
    /**
     * Truthful closure of the manifest. Artifacts produced after the manifest (the manifest itself,
     * the obligation ledger, the report projection, the gate, the handoff, and the terminal) cannot
     * bind themselves; they are named here as deferred and are accounted by the report projection
     * and terminal rather than silently omitted.
     */
    final_closure: Type.Object(
      {
        closed: Type.Boolean(),
        deferred_artifact_kinds: Type.Array(NonEmptyTextSchema, { maxItems: 64 }),
        note: NonEmptyTextSchema,
      },
      { additionalProperties: false }
    ),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_CHECKSUM_SCHEMA }
);
export type ScaP11ChecksumManifestV1 = Readonly<Static<typeof ScaP11ChecksumManifestV1Schema>>;

export const ScaP11ObligationLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_OBLIGATION_LEDGER_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    entries: Type.Array(
      Type.Object(
        {
          obligation_id: Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" }),
          scope: Type.Union([
            Type.Literal("boundary"),
            Type.Literal("phase"),
            Type.Literal("phase-output"),
            Type.Literal("report-output"),
            Type.Literal("milestone"),
            Type.Literal("exploratory"),
          ]),
          covered: Type.Boolean(),
          coverage: NonEmptyTextSchema,
          artifact_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 512 }
    ),
    entry_count: Type.Integer({ minimum: 0, maximum: 512 }),
    uncovered_obligation_ids: Type.Array(Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" }), {
      maxItems: 512,
    }),
    ledger_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_OBLIGATION_LEDGER_SCHEMA }
);
export type ScaP11ObligationLedgerV1 = Readonly<Static<typeof ScaP11ObligationLedgerV1Schema>>;

export const ScaP11ValidationRecordsV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_VALIDATION_RECORDS_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    report_json_ref: ArtifactRefSchema,
    report_json_sha256: Sha256Schema,
    deterministic_checks: Type.Array(
      Type.Object(
        {
          check_id: OpaqueIdSchema,
          passed: Type.Boolean(),
          detail: NonEmptyTextSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 512 }
    ),
    deterministic_passed: Type.Boolean(),
    semantic_review_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    semantic_passed: Type.Boolean(),
    open_items: Type.Array(
      Type.Object(
        {
          open_item_id: OpaqueIdSchema,
          target_id: OpaqueIdSchema,
          severity: Type.Union([Type.Literal("blocking"), Type.Literal("actionable")]),
          disposition: OpenItemDispositionSchema,
          evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 100_000 }
    ),
    repair_records: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
    incomplete: Type.Boolean(),
    incomplete_marker: Type.Union([NonEmptyTextSchema, Type.Null()]),
    missing_material: Type.Array(NonEmptyTextSchema, { maxItems: 1_024 }),
    append_only: Type.Literal(true),
    validation_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_VALIDATION_RECORDS_SCHEMA }
);
export type ScaP11ValidationRecordsV1 = Readonly<Static<typeof ScaP11ValidationRecordsV1Schema>>;

export const ScaP11ReportV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_REPORT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    run_id: OpaqueIdSchema,
    status: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
    latest_revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    lane: LaneSchema,
    markdown_ref: ArtifactRefSchema,
    json_ref: ArtifactRefSchema,
    sarif_ref: ArtifactRefSchema,
    reconciliation_ref: ArtifactRefSchema,
    scoring_records_ref: ArtifactRefSchema,
    checksum_manifest_ref: ArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    validation_records_ref: ArtifactRefSchema,
    addendum_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
    report_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_REPORT_SCHEMA }
);
export type ScaP11ReportV1 = Readonly<Static<typeof ScaP11ReportV1Schema>>;

export const ScaP11GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_GATE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    criterion_id: Type.Literal("AC-P11"),
    verdict: Type.Union([
      Type.Literal("pass_ready"),
      Type.Literal("pass_blocked"),
      Type.Literal("blocked_invalid"),
    ]),
    report_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    lane: Type.Optional(LaneSchema),
    immutable_p10_lineage_valid: Type.Boolean(),
    exhaustive_record_reconciliation: Type.Boolean(),
    set_equality_valid: Type.Boolean(),
    no_dropped_finding: Type.Boolean(),
    semantic_only_findings_included: Type.Boolean(),
    representation_consistency: Type.Boolean(),
    deterministic_validation_passed: Type.Boolean(),
    semantic_review_passed: Type.Boolean(),
    no_unresolved_required_item: Type.Boolean(),
    cwe_metadata_complete: Type.Boolean(),
    status_mapping_valid: Type.Boolean(),
    scoring_records_qualified: Type.Boolean(),
    exception_shapes_valid: Type.Boolean(),
    paths_and_redaction_valid: Type.Boolean(),
    checksum_manifest_valid: Type.Boolean(),
    obligation_ledger_complete: Type.Boolean(),
    latest_revision_only: Type.Boolean(),
    model_identity_and_disclosure_valid: Type.Boolean(),
    p11_reporting_authority_respected: Type.Boolean(),
    p12_or_release_claims_absent: Type.Boolean(),
    finding_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    record_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_GATE_SCHEMA }
);
export type ScaP11GateV1 = Readonly<Static<typeof ScaP11GateV1Schema>>;

export const ScaP11ToP12TransitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_TO_P12_TRANSITION_SCHEMA),
    schema_version: Type.Literal(1),
    source_phase_id: Type.Literal(SCA_P11_PHASE_ID),
    target_phase_id: Type.Literal("SCA-P12"),
    handoff_kind: Type.Literal("accepted_report_evidence_only"),
    qualification_scope: Type.Literal("reporting_gate_only_not_p12_release"),
    phase_gate_passed: Type.Literal(false),
    p12_release_authorized_by_this_transition: Type.Literal(false),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    campaign_completion_claimed: Type.Literal(false),
    report_ref: ArtifactRefSchema,
    reconciliation_ref: ArtifactRefSchema,
    validation_records_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    checksum_manifest_ref: ArtifactRefSchema,
    lane: LaneSchema,
    retained_gap_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    required_downstream_obligation_ids: Type.Array(
      Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" }),
      { maxItems: 32 }
    ),
    required_gaps_retained: Type.Literal(true),
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_TO_P12_TRANSITION_SCHEMA }
);
export type ScaP11ToP12TransitionV1 = Readonly<Static<typeof ScaP11ToP12TransitionV1Schema>>;

export const ScaP11TerminalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P11_TERMINAL_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P11_PHASE_ID),
    status: Type.Union([
      Type.Literal("reporting_complete"),
      Type.Literal("reporting_incomplete"),
      Type.Literal("blocked_invalid"),
      Type.Literal("cancelled"),
    ]),
    lane: Type.Optional(LaneSchema),
    report_ref: NullableArtifactRefSchema,
    reconciliation_ref: NullableArtifactRefSchema,
    validation_records_ref: NullableArtifactRefSchema,
    gate_ref: NullableArtifactRefSchema,
    p12_transition_ref: NullableArtifactRefSchema,
    p12_handoff_ready: Type.Boolean(),
    report_status: Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Null()]),
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
    release_adjudication_performed: Type.Literal(false),
    terminal_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P11_TERMINAL_SCHEMA }
);
export type ScaP11TerminalV1 = Readonly<Static<typeof ScaP11TerminalV1Schema>>;

// --- Validators ------------------------------------------------------------------------------

export function validateScaP11CandidateStartV1(value: unknown): ScaP11CandidateStartV1 {
  const parsed = validateContract(ScaP11CandidateStartV1Schema, value, "SCA P11 candidate start");
  assertSortedUnique(
    parsed.active_run_rule_release_refs.map((ref) => ref.artifact_id),
    "SCA P11 start active-run rule-release refs"
  );
  assertSortedUnique(
    parsed.p09_phase_evidence_refs.map((ref) => ref.artifact_id),
    "SCA P11 start P09 phase-evidence refs"
  );
  return parsed;
}

export function validateScaP11AdmissionV1(value: unknown): ScaP11AdmissionV1 {
  const parsed = validateContract(ScaP11AdmissionV1Schema, value, "SCA P11 admission");
  if (
    parsed.reportable !== (parsed.lane !== undefined) ||
    parsed.reportable !== (parsed.non_reportable_reason === null) ||
    parsed.reportable !== parsed.p10_rederivation_ok ||
    (parsed.reportable && !parsed.p10_handoff_agreement_ok)
  ) {
    throw new Error("SCA P11 admission reportable/lane/rederivation assurance mismatch");
  }
  if (!parsed.reportable && (parsed.lane !== undefined || parsed.non_reportable_reason === null)) {
    throw new Error("SCA P11 non-reportable admission must name a reason and no lane");
  }
  selfDigest(parsed, "admission_sha256", "SCA P11 admission");
  return parsed;
}

export function validateScaP11DisclosureScopeV1(value: unknown): ScaP11DisclosureScopeV1 {
  const parsed = validateContract(ScaP11DisclosureScopeV1Schema, value, "SCA P11 disclosure scope");
  if (parsed.decision === "allow" && parsed.blocker_codes.length !== 0) {
    throw new Error("SCA P11 allowed disclosure scope cannot retain blockers");
  }
  if (parsed.decision === "deny" && parsed.blocker_codes.length === 0) {
    throw new Error("SCA P11 denied disclosure scope must name its blockers");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P11 disclosure scope blocker codes");
  selfDigest(parsed, "scope_sha256", "SCA P11 disclosure scope");
  return parsed;
}

export function validateScaP11CognitivePayloadV1(value: unknown): ScaP11CognitivePayloadV1 {
  const parsed = validateContract(
    ScaP11CognitivePayloadV1Schema,
    value,
    "SCA P11 cognitive payload"
  );
  assertSortedUnique(parsed.assigned_assertion_ids, "SCA P11 payload assigned assertion ids");
  assertSortedUnique(
    parsed.assertions.map((assertion) => assertion.assertion_id),
    "SCA P11 payload assertion ids"
  );
  if (
    parsed.assigned_assertion_ids.length !== parsed.assertions.length ||
    parsed.assigned_assertion_ids.some((id, index) => id !== parsed.assertions[index]?.assertion_id)
  ) {
    throw new Error("SCA P11 cognitive payload assigned assertions are not exhaustive");
  }
  const isRepair = parsed.call_id === SCA_P11_REPAIR_CALL_ID;
  if (isRepair !== (parsed.purpose === SCA_P11_REPAIR_PURPOSE)) {
    throw new Error("SCA P11 cognitive payload call id/purpose mismatch");
  }
  if (isRepair !== parsed.repair_violations.length > 0) {
    throw new Error("SCA P11 repair payload must name its violations");
  }
  for (const assertion of parsed.assertions) {
    assertSortedUnique(
      assertion.evidence_allowlist.map((ref) => ref.artifact_id),
      "SCA P11 payload assertion evidence allowlist"
    );
  }
  selfDigest(parsed, "payload_sha256", "SCA P11 cognitive payload");
  return parsed;
}

export function validateScaP11DisclosureAdmissionV1(value: unknown): ScaP11DisclosureAdmissionV1 {
  const parsed = validateContract(
    ScaP11DisclosureAdmissionV1Schema,
    value,
    "SCA P11 disclosure admission"
  );
  if (
    parsed.payload_sha256 !== parsed.payload_ref.content_digest ||
    parsed.payload_byte_length !== parsed.payload_ref.byte_length
  ) {
    throw new Error("SCA P11 disclosure admission payload ref/digest mismatch");
  }
  if (
    parsed.decision === "deny" &&
    parsed.authorized_refs.length > 0 &&
    parsed.blocker_codes.length === 0
  ) {
    throw new Error("SCA P11 denied disclosure admission must name its blockers");
  }
  if ((parsed.purpose === SCA_P11_REPAIR_PURPOSE) !== (parsed.call_id === SCA_P11_REPAIR_CALL_ID)) {
    throw new Error("SCA P11 disclosure admission call id/purpose mismatch");
  }
  if (parsed.decision === "allow" && (parsed.secrets_embedded || parsed.personal_data_embedded)) {
    throw new Error("SCA P11 allowed disclosure admission cannot embed secrets or personal data");
  }
  assertSortedUnique(
    parsed.authorized_refs.map((ref) => ref.artifact_id),
    "SCA P11 disclosure admission authorized refs"
  );
  assertSortedUnique(parsed.blocker_codes, "SCA P11 disclosure admission blocker codes");
  selfDigest(parsed, "admission_sha256", "SCA P11 disclosure admission");
  return parsed;
}

export function validateScaP11ScoringPolicyV1(value: unknown): ScaP11ScoringPolicyV1 {
  const parsed = validateContract(ScaP11ScoringPolicyV1Schema, value, "SCA P11 scoring policy");
  assertSortedUnique(
    parsed.entries.map((entry) => entry.target_id),
    "SCA P11 scoring policy target ids"
  );
  for (const entry of parsed.entries) {
    if (
      new Set(entry.base_metrics.map((metric) => metric.metric)).size !== entry.base_metrics.length
    ) {
      throw new Error("SCA P11 scoring policy base metrics must be unique");
    }
    const shape = entry.exception_shape;
    const mustScore = shape === "scored" || shape === "none_zero";
    if (mustScore && entry.base_metrics.length !== SCA_P11_BASE_METRICS.length) {
      throw new Error("SCA P11 scored policy entry requires all eleven Base metrics");
    }
    if (mustScore) {
      for (const [index, metric] of SCA_P11_BASE_METRICS.entries()) {
        if (entry.base_metrics[index]?.metric !== metric) {
          throw new Error("SCA P11 scored policy entry Base metrics are not in the required order");
        }
      }
      if (entry.base_metrics.some((metric) => metric.value === "X")) {
        throw new Error("SCA P11 scored policy entry cannot leave a Base metric unset");
      }
    }
    assertSortedUnique(
      entry.environmental_metrics.map((metric) => metric.metric),
      "SCA P11 scoring policy environmental metrics"
    );
    assertSortedUnique(
      entry.evidence_refs.map((ref) => ref.artifact_id),
      "SCA P11 scoring policy evidence refs"
    );
  }
  selfDigest(parsed, "policy_sha256", "SCA P11 scoring policy");
  return parsed;
}

export function validateScaP11ReportPolicyV1(value: unknown): ScaP11ReportPolicyV1 {
  const parsed = validateContract(ScaP11ReportPolicyV1Schema, value, "SCA P11 report policy");
  assertSortedUnique(
    parsed.entries.map((entry) => entry.identity),
    "SCA P11 report policy identities"
  );
  for (const entry of parsed.entries) {
    assertSortedUnique(
      entry.evidence_refs.map((ref) => ref.artifact_id),
      "SCA P11 report policy evidence refs"
    );
  }
  selfDigest(parsed, "policy_sha256", "SCA P11 report policy");
  return parsed;
}

export function validateScaP11ReconciliationV1(value: unknown): ScaP11ReconciliationV1 {
  const parsed = validateContract(ScaP11ReconciliationV1Schema, value, "SCA P11 reconciliation");
  assertSortedUnique(
    parsed.rows.map((row) => row.record_id),
    "SCA P11 reconciliation record ids"
  );
  if (parsed.rows.length !== parsed.record_count) {
    throw new Error("SCA P11 reconciliation record count mismatch");
  }
  for (const row of parsed.rows) {
    assertSortedUnique(
      row.source_refs.map((ref) => ref.artifact_id),
      "SCA P11 reconciliation source refs"
    );
    assertSortedUnique(row.missing_material, "SCA P11 reconciliation missing material");
    if (row.reportable !== (row.report_status !== null)) {
      throw new Error("SCA P11 reconciliation reportable/report-status mismatch");
    }
    if (row.reportable && row.report_status === null) {
      throw new Error("SCA P11 reportable row requires a report status");
    }
    if (
      row.record_id !== scaP11RecordId({ record_kind: row.record_kind, identity: row.identity })
    ) {
      throw new Error("SCA P11 reconciliation record id is not derived from its kind and identity");
    }
  }
  const reportable = parsed.rows.filter((row) => row.reportable);
  const semanticOnly = parsed.rows.filter((row) => row.semantic_only);
  const retained = parsed.rows.filter(
    (row) => !row.reportable && row.current_disposition !== "not_disposed"
  );
  const unresolved = parsed.rows.filter((row) => row.checkpoint_ref !== null);
  if (
    reportable.length !== parsed.reportable_count ||
    semanticOnly.length !== parsed.semantic_only_count ||
    retained.length !== parsed.retained_non_reportable_count ||
    unresolved.length !== parsed.unresolved_count
  ) {
    throw new Error("SCA P11 reconciliation aggregate counts disagree with its rows");
  }
  selfDigest(parsed, "reconciliation_sha256", "SCA P11 reconciliation");
  return parsed;
}

export function validateScaP11AcceptedFindingV1(value: unknown): ScaP11AcceptedFindingV1 {
  const parsed = validateContract(ScaP11AcceptedFindingV1Schema, value, "SCA P11 accepted finding");
  const scored = parsed.exception_shape === "scored" || parsed.exception_shape === "none_zero";
  if (
    scored !==
    (parsed.cvss_vector !== null && parsed.cvss_score !== null && parsed.nomenclature !== null)
  ) {
    throw new Error("SCA P11 scored/none-zero finding requires score, vector, and nomenclature");
  }
  if (
    !scored &&
    (parsed.cvss_score !== null || parsed.cvss_vector !== null || parsed.nomenclature !== null)
  ) {
    throw new Error(
      "SCA P11 non-scored exception shape cannot carry score, vector, or nomenclature"
    );
  }
  if (parsed.exception_shape === "none_zero" && parsed.cvss_score !== 0) {
    throw new Error("SCA P11 None exception shape requires a valid 0.0 score");
  }
  if (parsed.complete !== (parsed.missing_material.length === 0)) {
    throw new Error("SCA P11 finding completeness disagrees with its missing-material list");
  }
  assertSortedUnique(
    parsed.evidence_refs.map((ref) => ref.artifact_id),
    "SCA P11 finding evidence refs"
  );
  assertSortedUnique(
    parsed.source_refs.map((ref) => ref.artifact_id),
    "SCA P11 finding source refs"
  );
  assertSortedUnique(parsed.missing_material, "SCA P11 finding missing material");
  return parsed;
}

export function validateScaP11ReportJsonV1(value: unknown): ScaP11ReportJsonV1 {
  const parsed = validateContract(ScaP11ReportJsonV1Schema, value, "SCA P11 report json");
  for (const finding of parsed.findings) {
    validateScaP11AcceptedFindingV1(finding);
  }
  assertSortedUnique(
    parsed.findings.map((finding) => finding.finding_id),
    "SCA P11 report finding ids"
  );
  if (parsed.findings.length !== parsed.finding_count) {
    throw new Error("SCA P11 report finding count mismatch");
  }
  const incomplete = parsed.findings.filter((finding) => !finding.complete);
  if (
    incomplete.length !== parsed.incomplete_finding_count ||
    incomplete.length !== parsed.missing_sections.length
  ) {
    throw new Error("SCA P11 report incompleteness accounting mismatch");
  }
  if (
    parsed.status === "complete" &&
    (incomplete.length > 0 || parsed.missing_sections.length > 0)
  ) {
    throw new Error("SCA P11 complete report cannot retain an incomplete finding");
  }
  selfDigest(parsed, "report_json_sha256", "SCA P11 report json");
  return parsed;
}

export function validateScaP11ReportSarifV1(value: unknown): ScaP11ReportSarifV1 {
  const parsed = validateContract(ScaP11ReportSarifV1Schema, value, "SCA P11 report sarif");
  assertSortedUnique(
    parsed.rules.map((rule) => rule.id),
    "SCA P11 SARIF rule ids"
  );
  assertSortedUnique(
    parsed.results.map((result) => result.finding_id),
    "SCA P11 SARIF finding ids"
  );
  if (parsed.results.length !== parsed.result_count) {
    throw new Error("SCA P11 SARIF result count mismatch");
  }
  const ruleIds = new Set(parsed.rules.map((rule) => rule.id));
  for (const result of parsed.results) {
    if (!ruleIds.has(result.ruleId)) {
      throw new Error("SCA P11 SARIF result references an undeclared rule");
    }
  }
  selfDigest(parsed, "sarif_sha256", "SCA P11 report sarif");
  return parsed;
}

export function validateScaP11ScoringRecordsV1(value: unknown): ScaP11ScoringRecordsV1 {
  const parsed = validateContract(ScaP11ScoringRecordsV1Schema, value, "SCA P11 scoring records");
  assertSortedUnique(
    parsed.records.map((record) => record.target_id),
    "SCA P11 scoring record target ids"
  );
  if (parsed.records.length !== parsed.record_count) {
    throw new Error("SCA P11 scoring record count mismatch");
  }
  if ((parsed.scorer_id === null) !== (parsed.scorer_build_sha256 === null)) {
    throw new Error("SCA P11 scoring records scorer identity is incomplete");
  }
  if (parsed.scorer_qualification_ref !== null && parsed.scorer_qualification_sha256 === null) {
    throw new Error("SCA P11 scoring records scorer qualification binding is incomplete");
  }
  const scored = parsed.records.filter(
    (record) => record.score !== null && record.nomenclature !== null
  );
  if (scored.length !== parsed.scored_count) {
    throw new Error("SCA P11 scoring scored count mismatch");
  }
  if (parsed.record_count !== parsed.scored_count + parsed.unscored_count) {
    throw new Error("SCA P11 scoring records are not exhaustive");
  }
  for (const record of parsed.records) {
    if (record.model_proposed_number !== false) {
      throw new Error("SCA P11 scoring record may never carry a model-proposed number");
    }
    const isScored = record.score !== null;
    if (isScored && !parsed.scorer_authority_admitted) {
      throw new Error("SCA P11 scored record requires an admitted scorer authority");
    }
    if (isScored && parsed.scorer_qualification_sha256 === null) {
      throw new Error(
        "SCA P11 scored record requires an exact admitted scorer qualification receipt"
      );
    }
    if (isScored && record.metric_vector === null) {
      throw new Error("SCA P11 scored record requires its metric vector");
    }
    if (record.exception_shape === "unscored_incomplete" && record.score !== null) {
      throw new Error("SCA P11 unscored record cannot carry a score");
    }
    if (record.exception_shape === "scored" && (record.score === null || record.score === 0)) {
      throw new Error("SCA P11 scored exception shape requires a non-zero score");
    }
    if (record.exception_shape === "none_zero" && record.score !== 0) {
      throw new Error("SCA P11 None exception shape requires a valid 0.0 score");
    }
  }
  selfDigest(parsed, "records_sha256", "SCA P11 scoring records");
  return parsed;
}

export function validateScaP11ChecksumManifestV1(value: unknown): ScaP11ChecksumManifestV1 {
  const parsed = validateContract(
    ScaP11ChecksumManifestV1Schema,
    value,
    "SCA P11 checksum manifest"
  );
  assertSortedUnique(
    parsed.artifacts.map((entry) => entry.artifact_id),
    "SCA P11 checksum artifact ids"
  );
  if (parsed.artifacts.length !== parsed.artifact_count) {
    throw new Error("SCA P11 checksum manifest artifact count mismatch");
  }
  assertSortedUnique(
    parsed.final_closure.deferred_artifact_kinds,
    "SCA P11 checksum manifest deferred artifact kinds"
  );
  if (parsed.final_closure.closed !== (parsed.final_closure.deferred_artifact_kinds.length === 0)) {
    throw new Error("SCA P11 checksum manifest final closure disagrees with its deferred kinds");
  }
  selfDigest(parsed, "manifest_sha256", "SCA P11 checksum manifest");
  return parsed;
}

export function validateScaP11CvssScorerQualificationV1(
  value: unknown
): ScaP11CvssScorerQualificationV1 {
  const parsed = validateContract(
    ScaP11CvssScorerQualificationV1Schema,
    value,
    "SCA P11 CVSS scorer qualification"
  );
  if (parsed.official_references.length === 0) {
    throw new Error("SCA P11 scorer qualification must pin official references");
  }
  const vectors = parsed.reference_vectors.map((entry) => entry.vector);
  assertSortedUnique(vectors, "SCA P11 scorer qualification reference vectors");
  selfDigest(parsed, "qualification_sha256", "SCA P11 CVSS scorer qualification");
  return parsed;
}

export function validateScaP11ObligationLedgerV1(value: unknown): ScaP11ObligationLedgerV1 {
  const parsed = validateContract(
    ScaP11ObligationLedgerV1Schema,
    value,
    "SCA P11 obligation ledger"
  );
  assertSortedUnique(
    parsed.entries.map((entry) => entry.obligation_id),
    "SCA P11 obligation ledger obligation ids"
  );
  if (parsed.entries.length !== parsed.entry_count) {
    throw new Error("SCA P11 obligation ledger entry count mismatch");
  }
  const uncovered = parsed.entries
    .filter((entry) => !entry.covered)
    .map((entry) => entry.obligation_id);
  if (!same([...uncovered].sort(), [...parsed.uncovered_obligation_ids].sort())) {
    throw new Error("SCA P11 obligation ledger uncovered ids disagree with its entries");
  }
  for (const obligationId of SCA_P11_REQUIRED_OBLIGATION_IDS) {
    if (!parsed.entries.some((entry) => entry.obligation_id === obligationId)) {
      throw new Error(`SCA P11 obligation ledger omits mandatory obligation '${obligationId}'`);
    }
  }
  selfDigest(parsed, "ledger_sha256", "SCA P11 obligation ledger");
  return parsed;
}

export function validateScaP11ValidationRecordsV1(value: unknown): ScaP11ValidationRecordsV1 {
  const parsed = validateContract(
    ScaP11ValidationRecordsV1Schema,
    value,
    "SCA P11 validation records"
  );
  assertSortedUnique(
    parsed.deterministic_checks.map((check) => check.check_id),
    "SCA P11 validation check ids"
  );
  assertSortedUnique(
    parsed.open_items.map((item) => item.open_item_id),
    "SCA P11 validation open item ids"
  );
  assertSortedUnique(
    parsed.repair_records.map((ref) => ref.artifact_id),
    "SCA P11 validation repair record refs"
  );
  assertSortedUnique(parsed.missing_material, "SCA P11 validation missing material");
  if (parsed.deterministic_passed !== parsed.deterministic_checks.every((check) => check.passed)) {
    throw new Error("SCA P11 deterministic pass flag disagrees with its checks");
  }
  if (parsed.report_json_sha256 !== parsed.report_json_ref.content_digest) {
    throw new Error("SCA P11 validation records report ref/digest mismatch");
  }
  if (
    parsed.semantic_passed &&
    (parsed.semantic_review_ref === null ||
      parsed.open_items.some((item) => item.severity === "blocking"))
  ) {
    throw new Error("SCA P11 semantic pass flag disagrees with its review and open items");
  }
  const incomplete =
    parsed.missing_material.length > 0 ||
    parsed.open_items.some((item) => item.disposition === "retained-incomplete");
  if (parsed.incomplete !== incomplete) {
    throw new Error("SCA P11 validation incompleteness is not derived from its content");
  }
  if (parsed.incomplete !== (parsed.incomplete_marker !== null)) {
    throw new Error("SCA P11 validation marker disagrees with its incompleteness");
  }
  if (parsed.append_only !== true) {
    throw new Error("SCA P11 validation records must be append-only");
  }
  selfDigest(parsed, "validation_sha256", "SCA P11 validation records");
  return parsed;
}

export function validateScaP11ReportV1(value: unknown): ScaP11ReportV1 {
  const parsed = validateContract(ScaP11ReportV1Schema, value, "SCA P11 report");
  assertSortedUnique(
    parsed.addendum_refs.map((ref) => ref.artifact_id),
    "SCA P11 report addendum refs"
  );
  selfDigest(parsed, "report_sha256", "SCA P11 report");
  return parsed;
}

const GATE_PREDICATE_KEYS = [
  "immutable_p10_lineage_valid",
  "exhaustive_record_reconciliation",
  "set_equality_valid",
  "no_dropped_finding",
  "semantic_only_findings_included",
  "representation_consistency",
  "deterministic_validation_passed",
  "semantic_review_passed",
  "no_unresolved_required_item",
  "cwe_metadata_complete",
  "status_mapping_valid",
  "scoring_records_qualified",
  "exception_shapes_valid",
  "paths_and_redaction_valid",
  "checksum_manifest_valid",
  "obligation_ledger_complete",
  "latest_revision_only",
  "model_identity_and_disclosure_valid",
  "p11_reporting_authority_respected",
  "p12_or_release_claims_absent",
] as const satisfies readonly (keyof ScaP11GateV1)[];

export function validateScaP11GateV1(value: unknown): ScaP11GateV1 {
  const parsed = validateContract(ScaP11GateV1Schema, value, "SCA P11 gate");
  if (parsed.verdict === "pass_ready") {
    if (
      parsed.report_ref === null ||
      parsed.blocker_codes.length !== 0 ||
      GATE_PREDICATE_KEYS.some((key) => parsed[key] !== true)
    ) {
      throw new Error("SCA P11 pass_ready gate claims an unmet condition");
    }
  }
  if (parsed.verdict === "blocked_invalid" && parsed.blocker_codes.length === 0) {
    throw new Error("SCA P11 blocked_invalid gate must name its blockers");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P11 gate blocker codes");
  selfDigest(parsed, "gate_sha256", "SCA P11 gate");
  return parsed;
}

export function validateScaP11ToP12TransitionV1(value: unknown): ScaP11ToP12TransitionV1 {
  const parsed = validateContract(
    ScaP11ToP12TransitionV1Schema,
    value,
    "SCA P11 successor handoff"
  );
  assertSortedUnique(
    parsed.retained_gap_refs.map((ref) => ref.artifact_id),
    "SCA P11 handoff retained gap refs"
  );
  assertSortedUnique(
    parsed.required_downstream_obligation_ids,
    "SCA P11 handoff downstream obligation ids"
  );
  selfDigest(parsed, "transition_sha256", "SCA P11 successor handoff");
  return parsed;
}

export function validateScaP11TerminalV1(value: unknown): ScaP11TerminalV1 {
  const parsed = validateContract(ScaP11TerminalV1Schema, value, "SCA P11 terminal");
  assertSortedUnique(parsed.blocker_codes, "SCA P11 terminal blocker codes");
  assertSortedUnique(
    parsed.missing_downstream_artifacts,
    "SCA P11 terminal missing downstream artifacts"
  );
  assertSortedUnique(
    parsed.required_downstream_obligation_ids,
    "SCA P11 terminal required downstream obligations"
  );
  if (
    parsed.phase_gate_passed !== false ||
    parsed.release_eligible !== false ||
    parsed.campaign_complete !== false ||
    parsed.nonterminal_campaign !== true ||
    parsed.p12_release_authorized !== false ||
    parsed.release_adjudication_performed !== false
  ) {
    throw new Error("SCA P11 terminal must remain non-positive");
  }
  if ((parsed.p12_transition_ref !== null) !== parsed.p12_handoff_ready) {
    throw new Error("SCA P11 terminal handoff readiness disagrees with its transition ref");
  }
  if (parsed.status === "reporting_complete") {
    if (
      parsed.report_ref === null ||
      parsed.reconciliation_ref === null ||
      parsed.validation_records_ref === null ||
      parsed.gate_ref === null ||
      parsed.p12_transition_ref === null ||
      parsed.lane === undefined ||
      parsed.report_status !== "complete"
    ) {
      throw new Error(
        "SCA P11 reporting_complete terminal requires the full report set and handoff"
      );
    }
  }
  if (parsed.status === "blocked_invalid") {
    if (
      parsed.p12_transition_ref !== null ||
      parsed.p12_handoff_ready ||
      parsed.report_status !== null ||
      parsed.missing_downstream_artifacts.length === 0
    ) {
      throw new Error("SCA P11 blocked_invalid terminal cannot hand off a report");
    }
  }
  if (parsed.status === "cancelled") {
    if (
      parsed.report_ref !== null ||
      parsed.reconciliation_ref !== null ||
      parsed.validation_records_ref !== null ||
      parsed.gate_ref !== null ||
      parsed.p12_transition_ref !== null ||
      parsed.report_status !== null
    ) {
      throw new Error("SCA P11 cancelled terminal cannot carry report state");
    }
  }
  selfDigest(parsed, "terminal_sha256", "SCA P11 terminal");
  return parsed;
}

export function validateScaP11AddendumV1(value: unknown): ScaP11AddendumV1 {
  const parsed = validateContract(ScaP11AddendumV1Schema, value, "SCA P11 addendum");
  if (parsed.base_report_digest !== parsed.base_report_ref.content_digest) {
    throw new Error("SCA P11 addendum base report ref/digest mismatch");
  }
  if (
    parsed.completes_report !== false ||
    parsed.mutates_report !== false ||
    parsed.invalidates_release_approval !== true ||
    parsed.append_only !== true
  ) {
    throw new Error("SCA P11 addendum must remain an immutable append-only companion");
  }
  assertSortedUnique(
    parsed.subject_refs.map((ref) => ref.artifact_id),
    "SCA P11 addendum subject refs"
  );
  selfDigest(parsed, "addendum_sha256", "SCA P11 addendum");
  return parsed;
}

export function validateScaP11SemanticReviewV1(value: unknown): ScaP11SemanticReviewV1 {
  const parsed = validateContract(ScaP11SemanticReviewV1Schema, value, "SCA P11 semantic review");
  if (parsed.report_sha256 !== parsed.report_ref.content_digest) {
    throw new Error("SCA P11 semantic review report ref/digest mismatch");
  }
  if (
    parsed.reviewer_identity_id !== SCA_P11_REVIEWER_IDENTITY_ID ||
    parsed.reviewer_lineage_id !== SCA_P11_REVIEWER_LINEAGE_ID
  ) {
    throw new Error(
      "SCA P11 semantic review reviewer identity/lineage is not the pinned reviewer registration"
    );
  }
  assertSortedUnique(
    parsed.verdicts.map((verdict) => verdict.assertion_id),
    "SCA P11 semantic review assertion ids"
  );
  assertSortedUnique(
    parsed.open_items.map((item) => item.open_item_id),
    "SCA P11 semantic review open item ids"
  );
  for (const verdict of parsed.verdicts) {
    assertSortedUnique(
      verdict.evidence_refs.map((ref) => ref.artifact_id),
      "SCA P11 semantic review evidence refs"
    );
    if (verdict.verdict === "refuted" && verdict.repair_candidate === null) {
      throw new Error("SCA P11 refuted assertion requires a repair candidate");
    }
  }
  if (parsed.gate_verdict_set !== false) {
    throw new Error("SCA P11 semantic review must not set a gate verdict");
  }
  selfDigest(parsed, "review_sha256", "SCA P11 semantic review");
  return parsed;
}

export function validateScaP11RepairRecordV1(value: unknown): ScaP11RepairRecordV1 {
  const parsed = validateContract(ScaP11RepairRecordV1Schema, value, "SCA P11 repair record");
  if (parsed.base_report_sha256 !== parsed.base_report_ref.content_digest) {
    throw new Error("SCA P11 repair record base report ref/digest mismatch");
  }
  if (
    parsed.repairer_identity_id !== SCA_P11_REVIEWER_IDENTITY_ID ||
    parsed.repairer_lineage_id !== SCA_P11_REVIEWER_LINEAGE_ID
  ) {
    throw new Error(
      "SCA P11 repair record repairer identity/lineage is not the pinned reviewer registration"
    );
  }
  if (parsed.revision !== parsed.base_revision + 1) {
    throw new Error("SCA P11 repair record revision must increment exactly once");
  }
  assertSortedUnique(parsed.violations_addressed, "SCA P11 repair violations");
  if (parsed.deleted_finding_ids.length !== 0) {
    throw new Error("SCA P11 repair must never delete a finding");
  }
  selfDigest(parsed, "repair_sha256", "SCA P11 repair record");
  return parsed;
}

export function validateScaP11RepairPatchV1(value: unknown): ScaP11RepairPatchV1 {
  const parsed = validateContract(ScaP11RepairPatchV1Schema, value, "SCA P11 repair patch");
  if (parsed.report_sha256 !== parsed.report_ref.content_digest) {
    throw new Error("SCA P11 repair patch report ref/digest mismatch");
  }
  if (
    parsed.repairer_identity_id !== SCA_P11_REVIEWER_IDENTITY_ID ||
    parsed.repairer_lineage_id !== SCA_P11_REVIEWER_LINEAGE_ID
  ) {
    throw new Error(
      "SCA P11 repair patch repairer identity/lineage is not the pinned reviewer registration"
    );
  }
  if (parsed.no_metadata_upgrade !== true || parsed.no_finding_removed !== true) {
    throw new Error("SCA P11 repair patch must preserve metadata and findings");
  }
  selfDigest(parsed, "patch_sha256", "SCA P11 repair patch");
  return parsed;
}

export function validateScaP11CheckpointV1(value: unknown): ScaP11CheckpointV1 {
  const parsed = validateContract(ScaP11CheckpointV1Schema, value, "SCA P11 checkpoint");
  selfDigest(parsed, "checkpoint_sha256", "SCA P11 checkpoint");
  return parsed;
}

export function validateScaP11ReassessmentV1(value: unknown): ScaP11ReassessmentV1 {
  const parsed = validateContract(ScaP11ReassessmentV1Schema, value, "SCA P11 reassessment");
  if (
    parsed.prior_report_sha256 !== parsed.prior_report_ref.content_digest ||
    parsed.prior_validation_sha256 !== parsed.prior_validation_ref.content_digest
  ) {
    throw new Error("SCA P11 reassessment prior ref/digest mismatch");
  }
  assertSortedUnique(parsed.trigger_codes, "SCA P11 reassessment trigger codes");
  assertSortedUnique(
    parsed.stimulus_refs.map((ref) => ref.artifact_id),
    "SCA P11 reassessment stimulus refs"
  );
  assertSortedUnique(
    parsed.invalidated_evidence_refs.map((ref) => ref.artifact_id),
    "SCA P11 reassessment invalidated evidence refs"
  );
  if (
    parsed.trigger_codes.includes("invalidated_evidence") !==
    parsed.invalidated_evidence_refs.length > 0
  ) {
    throw new Error("SCA P11 reassessment invalidated evidence/trigger mismatch");
  }
  selfDigest(parsed, "reassessment_sha256", "SCA P11 reassessment");
  return parsed;
}
