import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract } from "../contracts.js";
import type { RequiredModelIdentityV1 } from "../required-model.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";

/**
 * Inactive SCA P12 "independent release verification and campaign completion" candidate contracts.
 *
 * P12 admits exactly one entry — the exact P11 terminal artifact plus, for reportable lanes, the
 * exact `penny.sca-p11-to-p12-transition.v1` — independently re-derives the P11 reporting admission
 * across all four P11 terminal statuses through the shared `admitScaP11Reporting` path, performs a
 * deterministic replay and spot-check over exact immutable bytes, derives a verifier verdict set, an
 * independent release record and gate, and closes only on an exact-digest-bound human release
 * approval. Publication is a separate, unmet external action; the candidate performs none.
 *
 * The verifier is deterministic (no model or provider call), so P12 declares no provider-opening
 * guard and no disclosure schemas. It is deliberately absent from `SCA_PHASE_REGISTRY`,
 * `PLAYBOOK_REGISTRY`, and the public `sca` skill, and it always emits a non-positive terminal unless
 * every obligation is evidenced and an authorized, non-verifier, non-report-production human approves.
 */
export const SCA_P12_PHASE_ID = "SCA-P12" as const;
export const SCA_P12_CANDIDATE_PLAYBOOK_NAME = "sca-p12-candidate" as const;

export const SCA_P12_ADMITTING_STATE = "sca_p12_admitting" as const;
export const SCA_P12_VERIFYING_STATE = "sca_p12_verifying" as const;
export const SCA_P12_REPLAYING_STATE = "sca_p12_replaying" as const;
export const SCA_P12_AWAITING_RELEASE_APPROVAL_STATE = "sca_p12_awaiting_release_approval" as const;
export const SCA_P12_FINALIZING_STATE = "sca_p12_finalizing" as const;
export const SCA_P12_CANCELLED_STATE = "sca_p12_cancelled" as const;

/** Deterministic (non-cognitive) host states. P12 dispatches no catalog agent at all. */
export const SCA_P12_HOST_STATES = Object.freeze([
  SCA_P12_ADMITTING_STATE,
  SCA_P12_VERIFYING_STATE,
  SCA_P12_REPLAYING_STATE,
  SCA_P12_FINALIZING_STATE,
  SCA_P12_CANCELLED_STATE,
]);

export const SCA_P12_VERIFIER_ROLE = "release_verifier" as const;

/** Pinned DeepSeek identity for the strict-subset authority proof. P12 makes no provider call. */
export const SCA_P12_REQUIRED_MODEL: RequiredModelIdentityV1 = Object.freeze({
  schema_version: 1,
  alias: "deepseek-flash",
  provider: "ollama",
  model: "deepseek-v4.1-flash:cloud",
  override: "ollama/deepseek-v4.1-flash:cloud",
});
/** The verifier holds the empty tool set — a strict subset of report production's empty set. */
export const SCA_P12_REQUIRED_TOOL_SUBSET = Object.freeze([] as const);

/** Exact P01-catalog obligations P12 is responsible for. Never silently dropped or downgraded. */
export const SCA_P12_ACCEPTANCE_OBLIGATION_ID = "SCA-OBL-P12-ACCEPTANCE" as const;
export const SCA_P12_INDEPENDENT_REVIEW_OBLIGATION_ID =
  "SCA-OBL-BOUNDARY-INDEPENDENT-REVIEW" as const;
export const SCA_P12_RELEASE_AUTHORITY_OBLIGATION_ID =
  "SCA-OBL-BOUNDARY-RELEASE-AUTHORITY" as const;
export const SCA_P12_REQUIRED_OBLIGATION_IDS = Object.freeze(
  [
    SCA_P12_ACCEPTANCE_OBLIGATION_ID,
    SCA_P12_INDEPENDENT_REVIEW_OBLIGATION_ID,
    SCA_P12_RELEASE_AUTHORITY_OBLIGATION_ID,
  ].sort()
);

/**
 * Downstream products P12 does not produce and must name as missing. Publication remains an
 * explicitly unmet external action and product qualification is a separate downstream claim.
 */
export const SCA_P12_MISSING_DOWNSTREAM_ARTIFACTS = Object.freeze([
  "penny.sca-product-qualification.v1",
  "penny.sca-publication-receipt.v1",
] as const);
export const SCA_P12_DOWNSTREAM_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-BOUNDARY-PUBLICATION-AUTHORITY",
  "SCA-OBL-PRODUCT-QUALIFICATION",
] as const);

/** The four P11 terminal statuses P12 re-derives. Only `reporting_complete` may ever be released. */
export const SCA_P12_TERMINAL_STATUSES = Object.freeze([
  "released_complete",
  "release_refused",
  "verification_incomplete",
  "blocked_invalid",
  "cancelled",
] as const);
export type ScaP12TerminalStatusV1 = (typeof SCA_P12_TERMINAL_STATUSES)[number];

export const SCA_P12_LANES = ["accepted_progression", "incomplete_closeout"] as const;
export type ScaP12LaneV1 = (typeof SCA_P12_LANES)[number];

export const SCA_P12_VERDICTS = Object.freeze(["supported", "refuted", "insufficient"] as const);
export type ScaP12VerdictV1 = (typeof SCA_P12_VERDICTS)[number];

export const SCA_P12_OPEN_ITEM_DISPOSITIONS = Object.freeze([
  "repaired-not-applicable",
  "retained-incomplete",
  "dismissed-with-evidence",
] as const);
export type ScaP12OpenItemDispositionV1 = (typeof SCA_P12_OPEN_ITEM_DISPOSITIONS)[number];

/** The exact AC-P12 verification dimensions. */
export const SCA_P12_DIMENSIONS = Object.freeze([
  "identity_lineage_separation",
  "verifier_authority_subset",
  "provenance_scope_completeness",
  "phase_gate_evidence",
  "obligation_ledger_closure",
  "accepted_set_projection_consistency",
  "unresolved_work_status",
  "artifact_identity_digest_binding",
  "stale_mutated_misbound_report",
  "campaign_completion_claim_absence",
] as const);
export type ScaP12DimensionV1 = (typeof SCA_P12_DIMENSIONS)[number];

export const SCA_P12_REASSESSMENT_TRIGGER_CODES = Object.freeze([
  "new_evidence",
  "invalidated_evidence",
  "changed_snapshot",
  "changed_phase_gate",
  "scope_change",
] as const);
export type ScaP12ReassessmentTriggerCodeV1 = (typeof SCA_P12_REASSESSMENT_TRIGGER_CODES)[number];

export const SCA_P12_CANDIDATE_START_SCHEMA = "penny.sca-p12-candidate-start.v1" as const;
export const SCA_P12_ADMISSION_SCHEMA = "penny.sca-p12-admission.v1" as const;
export const SCA_P12_VERIFICATION_SCOPE_SCHEMA = "penny.sca-p12-verification-scope.v1" as const;
export const SCA_P12_VERIFIER_AUTHORITY_SCHEMA = "penny.sca-p12-verifier-authority.v1" as const;
export const SCA_P12_PHASE_GATE_INDEX_SCHEMA = "penny.sca-p12-phase-gate-index.v1" as const;
export const SCA_P12_REPLAY_EVIDENCE_SCHEMA = "penny.sca-p12-replay-evidence.v1" as const;
export const SCA_P12_VERIFIER_VERDICTS_SCHEMA = "penny.sca-p12-verifier-verdicts.v1" as const;
export const SCA_P12_RELEASE_AUTHORITY_SCHEMA = "penny.sca-p12-release-authority.v1" as const;
export const SCA_P12_RELEASE_APPROVAL_SCHEMA = "penny.sca-p12-release-approval.v1" as const;
export const SCA_P12_RELEASE_RECORD_SCHEMA = "penny.sca-p12-release-record.v1" as const;
export const SCA_P12_GATE_SCHEMA = "penny.sca-p12-gate.v1" as const;
export const SCA_P12_TERMINAL_SCHEMA = "penny.sca-p12-terminal.v1" as const;
export const SCA_P12_REASSESSMENT_SCHEMA = "penny.sca-p12-reassessment.v1" as const;
export const SCA_P12_CHECKPOINT_SCHEMA = "penny.sca-p12-checkpoint.v1" as const;
export const SCA_P12_OBLIGATION_LEDGER_SCHEMA = "penny.sca-p12-obligation-ledger.v1" as const;

const NonEmptyTextSchema = Type.String({ minLength: 1, maxLength: 16_384 });
const BlockerCodeSchema = Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" });
const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);
const DimensionIdSchema = Type.Union([
  Type.Literal("identity_lineage_separation"),
  Type.Literal("verifier_authority_subset"),
  Type.Literal("provenance_scope_completeness"),
  Type.Literal("phase_gate_evidence"),
  Type.Literal("obligation_ledger_closure"),
  Type.Literal("accepted_set_projection_consistency"),
  Type.Literal("unresolved_work_status"),
  Type.Literal("artifact_identity_digest_binding"),
  Type.Literal("stale_mutated_misbound_report"),
  Type.Literal("campaign_completion_claim_absence"),
]);
const VerdictSchema = Type.Union([
  Type.Literal("supported"),
  Type.Literal("refuted"),
  Type.Literal("insufficient"),
]);
const OpenItemSeveritySchema = Type.Union([Type.Literal("blocking"), Type.Literal("actionable")]);
const OpenItemDispositionSchema = Type.Union([
  Type.Literal("repaired-not-applicable"),
  Type.Literal("retained-incomplete"),
  Type.Literal("dismissed-with-evidence"),
]);
const LaneSchema = Type.Union([
  Type.Literal("accepted_progression"),
  Type.Literal("incomplete_closeout"),
]);
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
const ObligationIdSchema = Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" });

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

export function withP12Digest<T extends Readonly<Record<string, unknown>>, K extends string>(
  value: T,
  field: K
): T & Readonly<Record<K, string>> {
  return { ...value, [field]: sha256(canonicalJson(value)) } as T & Readonly<Record<K, string>>;
}

// --- Request / admission ---------------------------------------------------------------------

export const ScaP12CandidateStartV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_CANDIDATE_START_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    run_id: OpaqueIdSchema,
    /** The sole entry point: the exact P11 terminal and (for reportable lanes) its handoff. */
    p11_terminal_ref: ArtifactRefSchema,
    p11_transition_ref: NullableArtifactRefSchema,
    /** The exact recorded `penny.sca-p11-admission.v1` the P11 reporting run persisted. */
    p11_admission_ref: NullableArtifactRefSchema,
    /** Exact P10 refs P12 needs to re-derive the P11 reporting admission through the shared path. */
    p10_terminal_ref: ArtifactRefSchema,
    p10_transition_ref: NullableArtifactRefSchema,
    p10_outcome_ref: NullableArtifactRefSchema,
    p10_gate_ref: NullableArtifactRefSchema,
    p10_admission_ref: NullableArtifactRefSchema,
    p10_eligibility_ledger_ref: NullableArtifactRefSchema,
    p10_candidate_registry_ref: NullableArtifactRefSchema,
    /** Exact P09 base refs. */
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
    /** Exact re-derivation inputs the P11 shared admission path requires. */
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
    p11_disclosure_scope_ref: ArtifactRefSchema,
    p11_repair_disclosure_scope_ref: NullableArtifactRefSchema,
    scoring_policy_ref: ArtifactRefSchema,
    report_policy_ref: ArtifactRefSchema,
    /** P12 caller constraints. */
    verification_scope_ref: ArtifactRefSchema,
    verifier_authority_ref: ArtifactRefSchema,
    release_authority_ref: ArtifactRefSchema,
    p12_reassessment_ref: NullableArtifactRefSchema,
    p12_prior_release_ref: NullableArtifactRefSchema,
  },
  { additionalProperties: false, $id: SCA_P12_CANDIDATE_START_SCHEMA }
);
export type ScaP12CandidateStartV1 = Readonly<Static<typeof ScaP12CandidateStartV1Schema>>;

export const ScaP12AdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_ADMISSION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    run_id: OpaqueIdSchema,
    p11_terminal_ref: ArtifactRefSchema,
    p11_transition_ref: NullableArtifactRefSchema,
    p11_admission_ref: NullableArtifactRefSchema,
    p11_report_ref: NullableArtifactRefSchema,
    verification_scope_ref: ArtifactRefSchema,
    verifier_authority_ref: ArtifactRefSchema,
    release_authority_ref: ArtifactRefSchema,
    /** Absent when the input P11 terminal is a non-reportable checkpoint. */
    lane: Type.Optional(LaneSchema),
    reportable: Type.Boolean(),
    non_reportable_reason: Type.Union([NonEmptyTextSchema, Type.Null()]),
    p11_rederivation_ok: Type.Boolean(),
    p11_handoff_agreement_ok: Type.Boolean(),
    report_status: Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Null()]),
    no_unresolved_required_item: Type.Boolean(),
    record_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    finding_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_ADMISSION_SCHEMA }
);
export type ScaP12AdmissionV1 = Readonly<Static<typeof ScaP12AdmissionV1Schema>>;

export const ScaP12VerificationScopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_VERIFICATION_SCOPE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    run_id: OpaqueIdSchema,
    /** The exact AC-P12 dimensions, each with the host-assigned assertion/evidence allowlists. */
    dimensions: Type.Array(
      Type.Object(
        {
          dimension_id: DimensionIdSchema,
          assertion_allowlist: Type.Array(NonEmptyTextSchema, { maxItems: 1_024 }),
          evidence_allowlist: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
        },
        { additionalProperties: false }
      ),
      { minItems: 10, maxItems: 10 }
    ),
    spot_check: Type.Object(
      {
        /** All findings below this count are sampled; otherwise a hash-ordered sample of `size`. */
        threshold: Type.Integer({ minimum: 0, maximum: 10_000 }),
        sample_size: Type.Integer({ minimum: 0, maximum: 10_000 }),
      },
      { additionalProperties: false }
    ),
    issued_at: Rfc3339UtcSchema,
    scope_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_VERIFICATION_SCOPE_SCHEMA }
);
export type ScaP12VerificationScopeV1 = Readonly<Static<typeof ScaP12VerificationScopeV1Schema>>;

export const ScaP12VerifierAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_VERIFIER_AUTHORITY_SCHEMA),
    schema_version: Type.Literal(1),
    authority_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    verifier_identity_id: OpaqueIdSchema,
    verifier_lineage_id: OpaqueIdSchema,
    /** Host-owned denylist of every P01–P11 implementer/report-production identity and lineage. */
    excluded_identity_ids: Type.Array(OpaqueIdSchema, { maxItems: 1_024 }),
    excluded_lineage_ids: Type.Array(OpaqueIdSchema, { maxItems: 1_024 }),
    /** Strict-subset proof: the exact SCA model, the empty tool set, and no external side effects. */
    required_model: RequiredModelSchema,
    allowed_tools: Type.Array(NonEmptyTextSchema, { maxItems: 0 }),
    external_mutations: Type.Literal("forbidden"),
    filesystem_writes: Type.Literal("host_policy_only"),
    allowed_relative_paths: Type.Array(NonEmptyTextSchema, { maxItems: 0 }),
    /** Binds the exact release subject the verifier authorizes. */
    subject_sha256: Sha256Schema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 1_024 }),
    decision: Type.Union([Type.Literal("authorized"), Type.Literal("denied")]),
    issued_at: Rfc3339UtcSchema,
    authority_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_VERIFIER_AUTHORITY_SCHEMA }
);
export type ScaP12VerifierAuthorityV1 = Readonly<Static<typeof ScaP12VerifierAuthorityV1Schema>>;

export const ScaP12PhaseGateIndexV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_PHASE_GATE_INDEX_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    entries: Type.Array(
      Type.Object(
        {
          phase_id: OpaqueIdSchema,
          criterion_id: OpaqueIdSchema,
          gate_ref: ArtifactRefSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 64 }
    ),
    entry_count: Type.Integer({ minimum: 0, maximum: 64 }),
    closed: Type.Boolean(),
    issued_at: Rfc3339UtcSchema,
    index_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_PHASE_GATE_INDEX_SCHEMA }
);
export type ScaP12PhaseGateIndexV1 = Readonly<Static<typeof ScaP12PhaseGateIndexV1Schema>>;

export const ScaP12ReplayEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_REPLAY_EVIDENCE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    replay_lineage_id: OpaqueIdSchema,
    checks: Type.Array(
      Type.Object(
        {
          check_id: OpaqueIdSchema,
          expected_digest: Sha256Schema,
          observed_digest: Sha256Schema,
          passed: Type.Boolean(),
          detail: NonEmptyTextSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 512 }
    ),
    sampled_identity_ids: Type.Array(OpaqueIdSchema, { maxItems: 100_000 }),
    spot_check_passed: Type.Boolean(),
    /** Derived: every check passed. Never authored directly. */
    passed: Type.Boolean(),
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
    replay_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_REPLAY_EVIDENCE_SCHEMA }
);
export type ScaP12ReplayEvidenceV1 = Readonly<Static<typeof ScaP12ReplayEvidenceV1Schema>>;

export const ScaP12VerifierVerdictsV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_VERIFIER_VERDICTS_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    /** The exact verification-scope digest the verdicts were produced under. */
    verification_scope_sha256: Sha256Schema,
    verdicts: Type.Array(
      Type.Object(
        {
          dimension_id: DimensionIdSchema,
          verdict: VerdictSchema,
          reason: NonEmptyTextSchema,
          evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 64 }
    ),
    open_items: Type.Array(
      Type.Object(
        {
          open_item_id: OpaqueIdSchema,
          dimension_id: DimensionIdSchema,
          severity: OpenItemSeveritySchema,
          disposition: OpenItemDispositionSchema,
          evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_024 }
    ),
    /** The verifier may never set the gate verdict; the host derives it. */
    gate_verdict_set: Type.Literal(false),
    complete: Type.Literal(true),
    verdicts_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_VERIFIER_VERDICTS_SCHEMA }
);
export type ScaP12VerifierVerdictsV1 = Readonly<Static<typeof ScaP12VerifierVerdictsV1Schema>>;

export const ScaP12ReleaseAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_RELEASE_AUTHORITY_SCHEMA),
    schema_version: Type.Literal(1),
    authority_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    release_authority_identity_id: OpaqueIdSchema,
    release_authority_lineage_id: OpaqueIdSchema,
    /** Publication authority is deliberately separate and unmet. */
    publication_authority: Type.Literal("separate_unmet"),
    decision: Type.Union([Type.Literal("authorized"), Type.Literal("denied")]),
    subject_sha256: Sha256Schema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
    issued_at: Rfc3339UtcSchema,
    authority_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_RELEASE_AUTHORITY_SCHEMA }
);
export type ScaP12ReleaseAuthorityV1 = Readonly<Static<typeof ScaP12ReleaseAuthorityV1Schema>>;

export const ScaP12ReleaseApprovalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_RELEASE_APPROVAL_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    report_projection_ref: ArtifactRefSchema,
    report_projection_sha256: Sha256Schema,
    gate_ref: ArtifactRefSchema,
    gate_sha256: Sha256Schema,
    release_record_draft_sha256: Sha256Schema,
    release_authority_ref: ArtifactRefSchema,
    decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
    human_principal_id: OpaqueIdSchema,
    authority_receipt_sha256: Sha256Schema,
    decided_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
    /** Derived by the host from the actual verifier / report-production / release-authority identities. */
    separated_from_verifier: Type.Boolean(),
    separated_from_report_production: Type.Boolean(),
    distinct_from_release_authority: Type.Boolean(),
    approval_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_RELEASE_APPROVAL_SCHEMA }
);
export type ScaP12ReleaseApprovalV1 = Readonly<Static<typeof ScaP12ReleaseApprovalV1Schema>>;

export const ScaP12ReleaseRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_RELEASE_RECORD_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    run_id: OpaqueIdSchema,
    phase_gate_index_ref: ArtifactRefSchema,
    p11_terminal_ref: ArtifactRefSchema,
    p11_report_ref: ArtifactRefSchema,
    p11_reconciliation_ref: ArtifactRefSchema,
    p11_validation_records_ref: ArtifactRefSchema,
    p11_gate_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    replay_evidence_ref: ArtifactRefSchema,
    verifier_verdicts_ref: ArtifactRefSchema,
    release_authority_ref: ArtifactRefSchema,
    release_approval_ref: NullableArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    release_eligible: Type.Boolean(),
    campaign_complete: Type.Boolean(),
    publication_authorized: Type.Literal(false),
    publication_performed: Type.Literal(false),
    missing_downstream_artifacts: Type.Array(NonEmptyTextSchema, { maxItems: 32 }),
    required_downstream_obligation_ids: Type.Array(ObligationIdSchema, { maxItems: 32 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    release_record_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_RELEASE_RECORD_SCHEMA }
);
export type ScaP12ReleaseRecordV1 = Readonly<Static<typeof ScaP12ReleaseRecordV1Schema>>;

export const ScaP12GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_GATE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    criterion_id: Type.Literal("AC-P12"),
    verdict: Type.Union([
      Type.Literal("pass_ready"),
      Type.Literal("pass_blocked"),
      Type.Literal("blocked_invalid"),
    ]),
    report_ref: NullableArtifactRefSchema,
    release_record_ref: NullableArtifactRefSchema,
    lane: Type.Optional(LaneSchema),
    immutable_p11_lineage_valid: Type.Boolean(),
    verifier_independent_and_subset_authority: Type.Boolean(),
    deterministic_replay_passed: Type.Boolean(),
    spot_check_passed: Type.Boolean(),
    verifier_verdicts_supported: Type.Boolean(),
    no_unresolved_required_item: Type.Boolean(),
    phase_gate_index_complete: Type.Boolean(),
    obligation_ledger_complete: Type.Boolean(),
    accepted_set_projection_consistent: Type.Boolean(),
    artifact_identity_valid: Type.Boolean(),
    latest_revision_only: Type.Boolean(),
    human_release_authority_valid: Type.Boolean(),
    release_record_binding_valid: Type.Boolean(),
    publication_not_claimed: Type.Boolean(),
    p12_release_authority_respected: Type.Boolean(),
    finding_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    record_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_GATE_SCHEMA }
);
export type ScaP12GateV1 = Readonly<Static<typeof ScaP12GateV1Schema>>;

export const ScaP12TerminalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_TERMINAL_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    status: Type.Union([
      Type.Literal("released_complete"),
      Type.Literal("release_refused"),
      Type.Literal("verification_incomplete"),
      Type.Literal("blocked_invalid"),
      Type.Literal("cancelled"),
    ]),
    lane: Type.Optional(LaneSchema),
    release_record_ref: NullableArtifactRefSchema,
    gate_ref: NullableArtifactRefSchema,
    release_approval_ref: NullableArtifactRefSchema,
    p11_terminal_ref: NullableArtifactRefSchema,
    report_ref: NullableArtifactRefSchema,
    campaign_complete: Type.Boolean(),
    release_eligible: Type.Boolean(),
    publication_authorized: Type.Literal(false),
    publication_performed: Type.Literal(false),
    /** Required exact `⚠ INCOMPLETE — missing: …` marker for `verification_incomplete`. */
    incomplete_marker: Type.Union([NonEmptyTextSchema, Type.Null()]),
    missing_downstream_artifacts: Type.Array(NonEmptyTextSchema, { maxItems: 32 }),
    required_downstream_obligation_ids: Type.Array(ObligationIdSchema, { maxItems: 32 }),
    selected_artifact_refs: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    terminal_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_TERMINAL_SCHEMA }
);
export type ScaP12TerminalV1 = Readonly<Static<typeof ScaP12TerminalV1Schema>>;

export const ScaP12ReassessmentV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_REASSESSMENT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    run_id: OpaqueIdSchema,
    prior_release_record_ref: ArtifactRefSchema,
    prior_release_record_sha256: Sha256Schema,
    trigger_codes: Type.Array(
      Type.Union([
        Type.Literal("new_evidence"),
        Type.Literal("invalidated_evidence"),
        Type.Literal("changed_snapshot"),
        Type.Literal("changed_phase_gate"),
        Type.Literal("scope_change"),
      ]),
      { minItems: 1, maxItems: 5 }
    ),
    stimulus_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
    invalidated_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1_024 }),
    append_only: Type.Literal(true),
    invalidates_release_approval: Type.Literal(true),
    reassessment_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_REASSESSMENT_SCHEMA }
);
export type ScaP12ReassessmentV1 = Readonly<Static<typeof ScaP12ReassessmentV1Schema>>;

export const ScaP12CheckpointV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_CHECKPOINT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    run_id: OpaqueIdSchema,
    item_id: OpaqueIdSchema,
    identity: OpaqueIdSchema,
    reason_code: BlockerCodeSchema,
    primary_ref: ArtifactRefSchema,
    missing_evidence_need: NonEmptyTextSchema,
    reopen_condition: NonEmptyTextSchema,
    checkpoint_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_CHECKPOINT_SCHEMA }
);
export type ScaP12CheckpointV1 = Readonly<Static<typeof ScaP12CheckpointV1Schema>>;

export const ScaP12ObligationLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_OBLIGATION_LEDGER_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P12_PHASE_ID),
    run_id: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    entries: Type.Array(
      Type.Object(
        {
          obligation_id: ObligationIdSchema,
          scope: Type.Union([
            Type.Literal("boundary"),
            Type.Literal("phase"),
            Type.Literal("phase-output"),
            Type.Literal("milestone"),
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
    uncovered_obligation_ids: Type.Array(ObligationIdSchema, { maxItems: 512 }),
    ledger_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P12_OBLIGATION_LEDGER_SCHEMA }
);
export type ScaP12ObligationLedgerV1 = Readonly<Static<typeof ScaP12ObligationLedgerV1Schema>>;

// --- Validators ------------------------------------------------------------------------------

export function validateScaP12CandidateStartV1(value: unknown): ScaP12CandidateStartV1 {
  const parsed = validateContract(ScaP12CandidateStartV1Schema, value, "SCA P12 candidate start");
  assertSortedUnique(
    parsed.active_run_rule_release_refs.map((ref) => ref.artifact_id),
    "SCA P12 start active-run rule-release refs"
  );
  assertSortedUnique(
    parsed.p09_phase_evidence_refs.map((ref) => ref.artifact_id),
    "SCA P12 start P09 phase-evidence refs"
  );
  return parsed;
}

export function validateScaP12AdmissionV1(value: unknown): ScaP12AdmissionV1 {
  const parsed = validateContract(ScaP12AdmissionV1Schema, value, "SCA P12 admission");
  if (
    parsed.reportable !== (parsed.lane !== undefined) ||
    parsed.reportable !== (parsed.non_reportable_reason === null) ||
    parsed.reportable !== parsed.p11_rederivation_ok ||
    (parsed.reportable && !parsed.p11_handoff_agreement_ok)
  ) {
    throw new Error("SCA P12 admission reportable/lane/rederivation assurance mismatch");
  }
  if (!parsed.reportable && (parsed.lane !== undefined || parsed.non_reportable_reason === null)) {
    throw new Error("SCA P12 non-reportable admission must name a reason and no lane");
  }
  if (parsed.reportable && parsed.p11_report_ref === null) {
    throw new Error("SCA P12 reportable admission requires the recorded P11 report");
  }
  if (parsed.reportable && parsed.p11_admission_ref === null) {
    throw new Error("SCA P12 reportable admission requires the recorded P11 admission");
  }
  selfDigest(parsed, "admission_sha256", "SCA P12 admission");
  return parsed;
}

export function validateScaP12VerificationScopeV1(value: unknown): ScaP12VerificationScopeV1 {
  const parsed = validateContract(
    ScaP12VerificationScopeV1Schema,
    value,
    "SCA P12 verification scope"
  );
  assertSortedUnique(
    parsed.dimensions.map((dimension) => dimension.dimension_id),
    "SCA P12 verification scope dimensions"
  );
  const expected = [...SCA_P12_DIMENSIONS].sort();
  if (!same(parsed.dimensions.map((dimension) => dimension.dimension_id).sort(), expected)) {
    throw new Error("SCA P12 verification scope must cover the exact AC-P12 dimension set");
  }
  for (const dimension of parsed.dimensions) {
    assertSortedUnique(
      dimension.assertion_allowlist,
      "SCA P12 verification scope assertion allowlist"
    );
    assertSortedUnique(
      dimension.evidence_allowlist.map((ref) => ref.artifact_id),
      "SCA P12 verification scope evidence allowlist"
    );
  }
  selfDigest(parsed, "scope_sha256", "SCA P12 verification scope");
  return parsed;
}

export function validateScaP12VerifierAuthorityV1(value: unknown): ScaP12VerifierAuthorityV1 {
  const parsed = validateContract(
    ScaP12VerifierAuthorityV1Schema,
    value,
    "SCA P12 verifier authority"
  );
  if (parsed.verifier_identity_id === parsed.verifier_lineage_id) {
    throw new Error("SCA P12 verifier identity and lineage must be distinct");
  }
  if (
    parsed.allowed_tools.length !== 0 ||
    parsed.allowed_relative_paths.length !== 0 ||
    parsed.external_mutations !== "forbidden" ||
    parsed.filesystem_writes !== "host_policy_only"
  ) {
    throw new Error("SCA P12 verifier must hold the strict-subset no-authority surface");
  }
  assertSortedUnique(parsed.excluded_identity_ids, "SCA P12 verifier excluded identity ids");
  assertSortedUnique(parsed.excluded_lineage_ids, "SCA P12 verifier excluded lineage ids");
  assertSortedUnique(
    parsed.evidence_refs.map((ref) => ref.artifact_id),
    "SCA P12 verifier authority evidence refs"
  );
  selfDigest(parsed, "authority_sha256", "SCA P12 verifier authority");
  return parsed;
}

export function validateScaP12PhaseGateIndexV1(value: unknown): ScaP12PhaseGateIndexV1 {
  const parsed = validateContract(ScaP12PhaseGateIndexV1Schema, value, "SCA P12 phase gate index");
  assertSortedUnique(
    parsed.entries.map((entry) => entry.criterion_id),
    "SCA P12 phase gate index criterion ids"
  );
  if (parsed.entries.length !== parsed.entry_count) {
    throw new Error("SCA P12 phase gate index entry count mismatch");
  }
  for (const entry of parsed.entries) {
    if (entry.criterion_id !== `AC-${entry.phase_id.replace(/^SCA-/, "")}`) {
      throw new Error("SCA P12 phase gate index entry criterion does not match its phase");
    }
  }
  selfDigest(parsed, "index_sha256", "SCA P12 phase gate index");
  return parsed;
}

export function validateScaP12ReplayEvidenceV1(value: unknown): ScaP12ReplayEvidenceV1 {
  const parsed = validateContract(ScaP12ReplayEvidenceV1Schema, value, "SCA P12 replay evidence");
  assertSortedUnique(
    parsed.checks.map((check) => check.check_id),
    "SCA P12 replay evidence check ids"
  );
  assertSortedUnique(parsed.sampled_identity_ids, "SCA P12 replay evidence sampled identities");
  assertSortedUnique(
    parsed.evidence_refs.map((ref) => ref.artifact_id),
    "SCA P12 replay evidence refs"
  );
  if (parsed.passed !== parsed.checks.every((check) => check.passed)) {
    throw new Error("SCA P12 replay pass flag disagrees with its checks");
  }
  selfDigest(parsed, "replay_sha256", "SCA P12 replay evidence");
  return parsed;
}

export function validateScaP12VerifierVerdictsV1(value: unknown): ScaP12VerifierVerdictsV1 {
  const parsed = validateContract(
    ScaP12VerifierVerdictsV1Schema,
    value,
    "SCA P12 verifier verdicts"
  );
  assertSortedUnique(
    parsed.verdicts.map((verdict) => verdict.dimension_id),
    "SCA P12 verifier verdict dimensions"
  );
  assertSortedUnique(
    parsed.open_items.map((item) => item.open_item_id),
    "SCA P12 verifier open item ids"
  );
  for (const verdict of parsed.verdicts) {
    assertSortedUnique(
      verdict.evidence_refs.map((ref) => ref.artifact_id),
      "SCA P12 verifier verdict evidence refs"
    );
  }
  for (const item of parsed.open_items) {
    assertSortedUnique(
      item.evidence_refs.map((ref) => ref.artifact_id),
      "SCA P12 verifier open item evidence refs"
    );
  }
  if (parsed.gate_verdict_set !== false) {
    throw new Error("SCA P12 verifier must never set the gate verdict");
  }
  selfDigest(parsed, "verdicts_sha256", "SCA P12 verifier verdicts");
  return parsed;
}

export function validateScaP12ReleaseAuthorityV1(value: unknown): ScaP12ReleaseAuthorityV1 {
  const parsed = validateContract(
    ScaP12ReleaseAuthorityV1Schema,
    value,
    "SCA P12 release authority"
  );
  assertSortedUnique(
    parsed.evidence_refs.map((ref) => ref.artifact_id),
    "SCA P12 release authority evidence refs"
  );
  selfDigest(parsed, "authority_sha256", "SCA P12 release authority");
  return parsed;
}

export function validateScaP12ReleaseApprovalV1(value: unknown): ScaP12ReleaseApprovalV1 {
  const parsed = validateContract(ScaP12ReleaseApprovalV1Schema, value, "SCA P12 release approval");
  if (parsed.report_projection_sha256 !== parsed.report_projection_ref.content_digest) {
    throw new Error("SCA P12 release approval report projection ref/digest mismatch");
  }
  if (parsed.gate_sha256 !== parsed.gate_ref.content_digest) {
    throw new Error("SCA P12 release approval gate ref/digest mismatch");
  }
  if (
    !Number.isFinite(Date.parse(parsed.decided_at)) ||
    !Number.isFinite(Date.parse(parsed.expires_at)) ||
    Date.parse(parsed.expires_at) < Date.parse(parsed.decided_at)
  ) {
    throw new Error("SCA P12 release approval time range is invalid");
  }
  selfDigest(parsed, "approval_sha256", "SCA P12 release approval");
  return parsed;
}

export function validateScaP12ReleaseRecordV1(value: unknown): ScaP12ReleaseRecordV1 {
  const parsed = validateContract(ScaP12ReleaseRecordV1Schema, value, "SCA P12 release record");
  assertSortedUnique(parsed.blocker_codes, "SCA P12 release record blocker codes");
  assertSortedUnique(
    parsed.required_downstream_obligation_ids,
    "SCA P12 release record downstream obligation ids"
  );
  assertSortedUnique(
    parsed.missing_downstream_artifacts,
    "SCA P12 release record missing downstream artifacts"
  );
  if (parsed.campaign_complete && !parsed.release_eligible) {
    throw new Error(
      "SCA P12 release record cannot complete a campaign that is not release-eligible"
    );
  }
  if (parsed.release_eligible && parsed.blocker_codes.length > 0) {
    throw new Error("SCA P12 release-eligible record cannot retain blockers");
  }
  if (parsed.release_eligible && parsed.release_approval_ref === null) {
    throw new Error("SCA P12 release-eligible record requires the exact human release approval");
  }
  selfDigest(parsed, "release_record_sha256", "SCA P12 release record");
  return parsed;
}

const GATE_PREDICATE_KEYS = [
  "immutable_p11_lineage_valid",
  "verifier_independent_and_subset_authority",
  "deterministic_replay_passed",
  "spot_check_passed",
  "verifier_verdicts_supported",
  "no_unresolved_required_item",
  "phase_gate_index_complete",
  "obligation_ledger_complete",
  "accepted_set_projection_consistent",
  "artifact_identity_valid",
  "latest_revision_only",
  "human_release_authority_valid",
  "release_record_binding_valid",
  "publication_not_claimed",
  "p12_release_authority_respected",
] as const satisfies readonly (keyof ScaP12GateV1)[];

export function validateScaP12GateV1(value: unknown): ScaP12GateV1 {
  const parsed = validateContract(ScaP12GateV1Schema, value, "SCA P12 gate");
  if (parsed.verdict === "pass_ready") {
    if (
      parsed.report_ref === null ||
      parsed.blocker_codes.length !== 0 ||
      GATE_PREDICATE_KEYS.some((key) => parsed[key] !== true)
    ) {
      throw new Error("SCA P12 pass_ready gate claims an unmet condition");
    }
  }
  if (parsed.verdict === "blocked_invalid" && parsed.blocker_codes.length === 0) {
    throw new Error("SCA P12 blocked_invalid gate must name its blockers");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P12 gate blocker codes");
  selfDigest(parsed, "gate_sha256", "SCA P12 gate");
  return parsed;
}

export function validateScaP12TerminalV1(value: unknown): ScaP12TerminalV1 {
  const parsed = validateContract(ScaP12TerminalV1Schema, value, "SCA P12 terminal");
  assertSortedUnique(parsed.blocker_codes, "SCA P12 terminal blocker codes");
  assertSortedUnique(
    parsed.missing_downstream_artifacts,
    "SCA P12 terminal missing downstream artifacts"
  );
  assertSortedUnique(
    parsed.required_downstream_obligation_ids,
    "SCA P12 terminal required downstream obligations"
  );
  assertSortedUnique(
    parsed.selected_artifact_refs.map((ref) => ref.artifact_id),
    "SCA P12 terminal selected artifact refs"
  );
  if (parsed.publication_authorized !== false || parsed.publication_performed !== false) {
    throw new Error("SCA P12 terminal must never authorize or perform publication");
  }
  if (parsed.status !== "released_complete") {
    if (parsed.campaign_complete || parsed.release_eligible) {
      throw new Error("SCA P12 non-positive terminal cannot be completed or release-eligible");
    }
  }
  if (parsed.status === "released_complete") {
    if (
      !parsed.campaign_complete ||
      !parsed.release_eligible ||
      parsed.release_record_ref === null ||
      parsed.gate_ref === null ||
      parsed.release_approval_ref === null ||
      parsed.p11_terminal_ref === null ||
      parsed.report_ref === null ||
      parsed.blocker_codes.length > 0
    ) {
      throw new Error("SCA P12 released_complete terminal requires the full positive closure");
    }
  }
  if (parsed.status === "verification_incomplete") {
    if (parsed.incomplete_marker === null) {
      throw new Error("SCA P12 verification_incomplete terminal requires its exact marker");
    }
  }
  if (parsed.status === "cancelled") {
    if (
      parsed.release_record_ref !== null ||
      parsed.gate_ref !== null ||
      parsed.release_approval_ref !== null
    ) {
      throw new Error("SCA P12 cancelled terminal cannot carry release or gate state");
    }
  }
  selfDigest(parsed, "terminal_sha256", "SCA P12 terminal");
  return parsed;
}

export function validateScaP12ReassessmentV1(value: unknown): ScaP12ReassessmentV1 {
  const parsed = validateContract(ScaP12ReassessmentV1Schema, value, "SCA P12 reassessment");
  if (parsed.prior_release_record_sha256 !== parsed.prior_release_record_ref.content_digest) {
    throw new Error("SCA P12 reassessment prior release ref/digest mismatch");
  }
  assertSortedUnique(parsed.trigger_codes, "SCA P12 reassessment trigger codes");
  assertSortedUnique(
    parsed.stimulus_refs.map((ref) => ref.artifact_id),
    "SCA P12 reassessment stimulus refs"
  );
  assertSortedUnique(
    parsed.invalidated_evidence_refs.map((ref) => ref.artifact_id),
    "SCA P12 reassessment invalidated evidence refs"
  );
  if (
    parsed.trigger_codes.includes("invalidated_evidence") !==
    parsed.invalidated_evidence_refs.length > 0
  ) {
    throw new Error("SCA P12 reassessment invalidated evidence/trigger mismatch");
  }
  selfDigest(parsed, "reassessment_sha256", "SCA P12 reassessment");
  return parsed;
}

export function validateScaP12CheckpointV1(value: unknown): ScaP12CheckpointV1 {
  const parsed = validateContract(ScaP12CheckpointV1Schema, value, "SCA P12 checkpoint");
  selfDigest(parsed, "checkpoint_sha256", "SCA P12 checkpoint");
  return parsed;
}

export function validateScaP12ObligationLedgerV1(value: unknown): ScaP12ObligationLedgerV1 {
  const parsed = validateContract(
    ScaP12ObligationLedgerV1Schema,
    value,
    "SCA P12 obligation ledger"
  );
  assertSortedUnique(
    parsed.entries.map((entry) => entry.obligation_id),
    "SCA P12 obligation ledger obligation ids"
  );
  if (parsed.entries.length !== parsed.entry_count) {
    throw new Error("SCA P12 obligation ledger entry count mismatch");
  }
  const uncovered = parsed.entries
    .filter((entry) => !entry.covered)
    .map((entry) => entry.obligation_id)
    .sort();
  if (!same(uncovered, [...parsed.uncovered_obligation_ids].sort())) {
    throw new Error("SCA P12 obligation ledger uncovered ids disagree with its entries");
  }
  for (const obligationId of SCA_P12_REQUIRED_OBLIGATION_IDS) {
    if (!parsed.entries.some((entry) => entry.obligation_id === obligationId)) {
      throw new Error(`SCA P12 obligation ledger omits mandatory obligation '${obligationId}'`);
    }
  }
  selfDigest(parsed, "ledger_sha256", "SCA P12 obligation ledger");
  return parsed;
}
