import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract } from "../contracts.js";
import { validateRequiredModelIdentity, type RequiredModelIdentityV1 } from "../required-model.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";
import { ScaP05HypothesisBodyV1Schema } from "./p05-contracts.js";

/**
 * Inactive SCA P08 "evidence-based disposition" candidate contracts.
 *
 * P08 consumes the recorded P07 result and produces exactly one current disposition per admitted
 * P06/P07 item, an exhaustive immutable ledger, a phase gate, and a non-authorizing P09 handoff.
 * It never gathers evidence, never executes a target, and never claims release or campaign
 * completion. These schemas are deliberately absent from every active registry.
 */
export const SCA_P08_PHASE_ID = "SCA-P08" as const;
export const SCA_P08_ADMITTING_STATE = "sca_p08_admitting" as const;
export const SCA_P08_ASSESSING_STATE = "sca_p08_assessing_dispositions" as const;
export const SCA_P08_REVIEWING_STATE = "sca_p08_reviewing_dispositions" as const;
export const SCA_P08_FINAL_STATE = "sca_p08_finalizing_dispositions" as const;
export const SCA_P08_CANCELLED_STATE = "sca_p08_cancelled" as const;

export const SCA_P08_ASSESSOR_ROLE = "evidence_disposition_assessor" as const;
export const SCA_P08_REVIEWER_ROLE = "evidence_disposition_reviewer" as const;
export const SCA_P08_ASSESSOR_AGENT = "demetri" as const;
export const SCA_P08_REVIEWER_AGENT = "ida" as const;

export const SCA_P08_REQUIRED_MODEL: RequiredModelIdentityV1 = Object.freeze({
  schema_version: 1,
  alias: "deepseek-flash",
  provider: "ollama",
  model: "deepseek-v4.1-flash:cloud",
  override: "ollama/deepseek-v4.1-flash:cloud",
});
export const SCA_P08_REQUIRED_TOOL_SUBSET = Object.freeze([] as const);
export const SCA_P08_PROVIDER_OPENING_GUARD = "sca_p08_payload_disclosure_v1" as const;

export const SCA_P08_ASSESSMENT_CALL_ID = "sca-p08-evidence-based-disposition" as const;
export const SCA_P08_REVIEW_CALL_ID = "sca-p08-independent-semantic-review" as const;
export const SCA_P08_ASSESSMENT_PURPOSE = "p08_evidence_based_disposition" as const;
export const SCA_P08_REVIEW_PURPOSE = "p08_independent_semantic_review" as const;
export const SCA_P08_CONTENT_MODE =
  "p07_ledger_p06_hypothesis_obligation_and_prior_disposition_projections" as const;

export const SCA_P08_DISPOSITION_KINDS = Object.freeze([
  "confirmed",
  "rejected-with-evidence",
  "inconclusive",
  "deferred",
  "duplicate-of",
  "out-of-scope",
] as const);
export type ScaP08DispositionKindV1 = (typeof SCA_P08_DISPOSITION_KINDS)[number];

export const SCA_P08_ITEM_KINDS = Object.freeze(["action", "hypothesis", "obligation"] as const);
export type ScaP08ItemKindV1 = (typeof SCA_P08_ITEM_KINDS)[number];

export const SCA_P08_CHANGE_REASON_CODES = Object.freeze([
  "initial_construction",
  "new_evidence",
  "invalidated_evidence",
  "changed_snapshot",
  "scope_change",
  "duplicate_resolution",
  "remediation_verified",
] as const);
export type ScaP08ChangeReasonCodeV1 = (typeof SCA_P08_CHANGE_REASON_CODES)[number];

/**
 * The five reassessment triggers that create a versioned reassessment (`SCA-D02`). The host
 * declares them with exact stimulus refs; the playbook never infers a trigger from prose.
 */
export const SCA_P08_REASSESSMENT_TRIGGER_CODES = Object.freeze([
  "new_evidence",
  "invalidated_evidence",
  "changed_snapshot",
  "scope_change",
  "duplicate_resolution",
] as const);
export type ScaP08ReassessmentTriggerCodeV1 = (typeof SCA_P08_REASSESSMENT_TRIGGER_CODES)[number];

export const SCA_P08_ADMISSION_SCHEMA = "penny.sca-p08-admission.v1" as const;
export const SCA_P08_ITEM_UNIVERSE_SCHEMA = "penny.sca-p08-item-universe.v1" as const;
export const SCA_P08_DISCLOSURE_SCOPE_SCHEMA = "penny.sca-p08-disclosure-scope.v1" as const;
export const SCA_P08_COGNITIVE_PAYLOAD_SCHEMA = "penny.sca-p08-cognitive-payload.v1" as const;
export const SCA_P08_DISCLOSURE_ADMISSION_SCHEMA = "penny.sca-p08-disclosure-admission.v1" as const;
export const SCA_P08_ASSESSMENT_SCHEMA = "penny.sca-p08-disposition-assessment.v1" as const;
export const SCA_P08_REVIEW_SCHEMA = "penny.sca-p08-disposition-review.v1" as const;
export const SCA_P08_DISPOSITION_REVISION_SCHEMA = "penny.sca-p08-disposition-revision.v1" as const;
export const SCA_P08_REASSESSMENT_SCHEMA = "penny.sca-p08-reassessment.v1" as const;
export const SCA_P08_EVIDENCE_LEDGER_SCHEMA = "penny.sca-p08-evidence-ledger.v1" as const;
export const SCA_P08_GATE_SCHEMA = "penny.sca-p08-gate.v1" as const;
export const SCA_P08_TO_P09_TRANSITION_SCHEMA = "penny.sca-p08-to-p09-transition.v1" as const;
export const SCA_P08_TERMINAL_SCHEMA = "penny.sca-p08-terminal.v1" as const;
export const SCA_P08_EQUIVALENCE_PROOF_SCHEMA =
  "penny.sca-p08-duplicate-equivalence-proof.v1" as const;

/**
 * The closed set of admitted P01/P06 *campaign/source scope*-decision kinds. It is the single
 * source of truth for the admitted scope-evidence set: admission reads the exact P01/P06 records
 * the admitted lineage binds, keeps only those whose artifact kind appears here, and exact-reads
 * and revalidates every survivor. An `out-of-scope` disposition may cite only one of those exact
 * admitted records; an unrelated admitted artifact (for example an action record) must fail.
 *
 * Two families are deliberately excluded. Provider *disclosure* policy records
 * (`sca-p06-disclosure-scope`, `sca-p08-disclosure-scope`) govern which data classes may be sent
 * to a cloud model; neither schema excludes an item from the campaign source or the disposition
 * universe, so neither is campaign/source scope. Phase handoff transitions
 * (`sca-p06-to-p07-transition`, `sca-p07-to-p08-transition`) are handoffs, not scope decisions.
 */
export const SCA_P08_SCOPE_DECISION_KINDS = Object.freeze([
  "sca-p06-accepted-cohort",
  "source-snapshot",
] as const);
export type ScaP08ScopeDecisionKindV1 = (typeof SCA_P08_SCOPE_DECISION_KINDS)[number];

/** True when `kind` names an admitted campaign/source scope-decision record. */
export function isScaP08ScopeDecisionKind(kind: string): boolean {
  return (SCA_P08_SCOPE_DECISION_KINDS as readonly string[]).includes(kind);
}

const NonEmptyTextSchema = Type.String({ minLength: 1, maxLength: 16_384 });
const BlockerCodeSchema = Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" });
const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);
const HypothesisIdSchema = Type.String({ pattern: "^p05h_[a-f0-9]{64}$" });
const ItemIdSchema = Type.String({ pattern: "^p08item_[a-f0-9]{64}$" });
const DISPOSITION_REVISION_KIND = "sca-p08-disposition-revision" as const;

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

const DispositionSchema = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("rejected-with-evidence"),
  Type.Literal("inconclusive"),
  Type.Literal("deferred"),
  Type.Literal("duplicate-of"),
  Type.Literal("out-of-scope"),
]);
const ItemKindSchema = Type.Union([
  Type.Literal("action"),
  Type.Literal("hypothesis"),
  Type.Literal("obligation"),
]);
const ChangeReasonSchema = Type.Union([
  Type.Literal("initial_construction"),
  Type.Literal("new_evidence"),
  Type.Literal("invalidated_evidence"),
  Type.Literal("changed_snapshot"),
  Type.Literal("scope_change"),
  Type.Literal("duplicate_resolution"),
  Type.Literal("remediation_verified"),
]);
const ReassessmentTriggerSchema = Type.Union([
  Type.Literal("new_evidence"),
  Type.Literal("invalidated_evidence"),
  Type.Literal("changed_snapshot"),
  Type.Literal("scope_change"),
  Type.Literal("duplicate_resolution"),
]);
const P07ActionStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("not_invoked"),
]);
const EvidenceModeSchema = Type.Union([
  Type.Literal("runtime"),
  Type.Literal("code"),
  Type.Literal("none"),
]);

/** Stable identity of one universe item. It is derived, never model-or-caller selected. */
export function scaP08ItemId(input: {
  readonly item_kind: ScaP08ItemKindV1;
  readonly identity: string;
}): string {
  return `p08item_${sha256(canonicalJson({ item_kind: input.item_kind, identity: input.identity }))}`;
}

export const ScaP08DisclosureScopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_DISCLOSURE_SCOPE_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    required_model: RequiredModelSchema,
    destination_class: Type.Literal("cloud"),
    purpose: Type.Union([
      Type.Literal(SCA_P08_ASSESSMENT_PURPOSE),
      Type.Literal(SCA_P08_REVIEW_PURPOSE),
    ]),
    allowed_data_classes: Type.Tuple([
      Type.Literal("p07_evidence_ledger_excerpts"),
      Type.Literal("p06_hypothesis_obligation_projections"),
      Type.Literal("prior_disposition_revisions"),
    ]),
    provider_retention_status: Type.Literal("known"),
    provider_retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    provider_logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    provider_training_use: Type.Literal("prohibited"),
    max_payload_bytes_per_call: Type.Integer({ minimum: 1, maximum: 786_432 }),
    max_provider_calls: Type.Literal(2),
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
    issued_at: Rfc3339UtcSchema,
    scope_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_DISCLOSURE_SCOPE_SCHEMA }
);
export type ScaP08DisclosureScopeV1 = Readonly<Static<typeof ScaP08DisclosureScopeV1Schema>>;

/** One closed universe item. `primary_ref` is the exact lineage artifact for the item. */
export const ScaP08ItemUniverseItemV1Schema = Type.Object(
  {
    item_id: ItemIdSchema,
    item_kind: ItemKindSchema,
    identity: OpaqueIdSchema,
    primary_ref: ArtifactRefSchema,
    hypothesis_id: Type.Union([HypothesisIdSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ScaP08ItemUniverseItemV1 = Readonly<Static<typeof ScaP08ItemUniverseItemV1Schema>>;

export const ScaP08ItemUniverseV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_ITEM_UNIVERSE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    run_id: OpaqueIdSchema,
    items: Type.Array(ScaP08ItemUniverseItemV1Schema, { minItems: 1, maxItems: 10_000 }),
    item_count: Type.Integer({ minimum: 1, maximum: 10_000 }),
    universe_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_ITEM_UNIVERSE_SCHEMA }
);
export type ScaP08ItemUniverseV1 = Readonly<Static<typeof ScaP08ItemUniverseV1Schema>>;

export const ScaP08AdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_ADMISSION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    run_id: OpaqueIdSchema,
    p07_terminal_ref: ArtifactRefSchema,
    p07_transition_ref: NullableArtifactRefSchema,
    p07_evidence_ledger_ref: ArtifactRefSchema,
    p07_authority_ref: ArtifactRefSchema,
    p07_plan_ref: ArtifactRefSchema,
    p07_admission_ref: ArtifactRefSchema,
    p06_transition_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    /**
     * Encoded production-attestation posture of the re-derived P07 execution authority. It is
     * `attested_unchanged` only when admission was given an independent current-authority resolver;
     * otherwise it records the honest reduced-assurance `unattested_chain_revalidated`.
     */
    p07_authority_assurance: Type.Union([
      Type.Literal("attested_unchanged"),
      Type.Literal("unattested_chain_revalidated"),
    ]),
    blocked_checkpoint: Type.Boolean(),
    item_count: Type.Integer({ minimum: 1, maximum: 10_000 }),
    universe_sha256: Sha256Schema,
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_ADMISSION_SCHEMA }
);
export type ScaP08AdmissionV1 = Readonly<Static<typeof ScaP08AdmissionV1Schema>>;

const PayloadItemSchema = Type.Object(
  {
    item_id: ItemIdSchema,
    item_kind: ItemKindSchema,
    identity: OpaqueIdSchema,
    hypothesis_id: Type.Union([HypothesisIdSchema, Type.Null()]),
    primary_ref: ArtifactRefSchema,
    p07_status: Type.Union([P07ActionStatusSchema, Type.Null()]),
    p07_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
    p07_ledger_row_operation_id: Type.Union([OpaqueIdSchema, Type.Null()]),
    hypothesis: Type.Union([ScaP05HypothesisBodyV1Schema, Type.Null()]),
    prior_disposition_ref: NullableArtifactRefSchema,
    /** Admitted typed equivalence proofs that name this item as the duplicate subject. */
    equivalence_proof_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
    excerpt: NonEmptyTextSchema,
  },
  { additionalProperties: false }
);

export const ScaP08CognitivePayloadV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_COGNITIVE_PAYLOAD_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    call_id: Type.Union([
      Type.Literal(SCA_P08_ASSESSMENT_CALL_ID),
      Type.Literal(SCA_P08_REVIEW_CALL_ID),
    ]),
    role: Type.Union([Type.Literal(SCA_P08_ASSESSOR_ROLE), Type.Literal(SCA_P08_REVIEWER_ROLE)]),
    purpose: Type.Union([
      Type.Literal(SCA_P08_ASSESSMENT_PURPOSE),
      Type.Literal(SCA_P08_REVIEW_PURPOSE),
    ]),
    required_model: RequiredModelSchema,
    p07_terminal_ref: ArtifactRefSchema,
    p07_transition_ref: NullableArtifactRefSchema,
    p07_evidence_ledger_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    /**
     * The exact admitted campaign/source scope-decision records the zero-tool assessor may cite
     * for an `out-of-scope` disposition: the host projection of the admission's allowlist-derived
     * set (`SCA_P08_SCOPE_DECISION_KINDS`). It is never model- or caller-selected.
     */
    scope_decision_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 32 }),
    assessment_ref: NullableArtifactRefSchema,
    assigned_item_ids: Type.Array(ItemIdSchema, { minItems: 1, maxItems: 10_000 }),
    items: Type.Array(PayloadItemSchema, { minItems: 1, maxItems: 10_000 }),
    content_mode: Type.Literal(SCA_P08_CONTENT_MODE),
    payload_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_COGNITIVE_PAYLOAD_SCHEMA }
);
export type ScaP08CognitivePayloadV1 = Readonly<Static<typeof ScaP08CognitivePayloadV1Schema>>;
export type ScaP08PayloadItemV1 = Readonly<Static<typeof PayloadItemSchema>>;

export const ScaP08DisclosureAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_DISCLOSURE_ADMISSION_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    call_id: Type.Union([
      Type.Literal(SCA_P08_ASSESSMENT_CALL_ID),
      Type.Literal(SCA_P08_REVIEW_CALL_ID),
    ]),
    role: Type.Union([Type.Literal(SCA_P08_ASSESSOR_ROLE), Type.Literal(SCA_P08_REVIEWER_ROLE)]),
    purpose: Type.Union([
      Type.Literal(SCA_P08_ASSESSMENT_PURPOSE),
      Type.Literal(SCA_P08_REVIEW_PURPOSE),
    ]),
    required_model: RequiredModelSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    disclosure_scope_sha256: Sha256Schema,
    payload_ref: ArtifactRefSchema,
    payload_sha256: Sha256Schema,
    payload_byte_length: Type.Integer({ minimum: 1, maximum: 786_432 }),
    serialized_opening_byte_limit: Type.Integer({ minimum: 1, maximum: 786_432 }),
    authorized_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 10_000 }),
    destination: Type.Literal("cloud"),
    retention_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    logging_status: Type.Union([Type.Literal("disabled"), Type.Literal("known_bounded")]),
    logging_days: Type.Integer({ minimum: 0, maximum: 3650 }),
    training: Type.Literal("prohibited"),
    secrets_embedded: Type.Literal(false),
    personal_data_embedded: Type.Literal(false),
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 32 }),
    evaluated_before_dispatch: Type.Literal(true),
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_DISCLOSURE_ADMISSION_SCHEMA }
);
export type ScaP08DisclosureAdmissionV1 = Readonly<
  Static<typeof ScaP08DisclosureAdmissionV1Schema>
>;

/**
 * The disposition support fields the host validates. They are shared by the model assessment
 * assertions and the immutable per-item revisions so a revision can be re-derived from exact
 * evidence without re-asking a model.
 */
const DispositionSupportProperties = {
  claim: Type.Union([NonEmptyTextSchema, Type.Null()]),
  supporting_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
  defeating_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
  evidence_mode: EvidenceModeSchema,
  actor_state_stimulus_verified: Type.Boolean(),
  target_reachability_observed: Type.Boolean(),
  /**
   * The distinguishing oracle a runtime refutation must supply: the exact observation that
   * separates the defeated claim from its competing explanations. A runtime refutation without
   * it is not a refutation (`SCA-P08` R2).
   */
  distinguishing_oracle: Type.Union([NonEmptyTextSchema, Type.Null()]),
  complete_code_control_state_evidence: Type.Boolean(),
  finite_clean_fuzzing_only: Type.Boolean(),
  unresolved_material_link: Type.Union([NonEmptyTextSchema, Type.Null()]),
  resolution_evidence_need: Type.Union([NonEmptyTextSchema, Type.Null()]),
  deferral_reason: Type.Union([NonEmptyTextSchema, Type.Null()]),
  reopening_conditions: Type.Array(NonEmptyTextSchema, { maxItems: 16 }),
  duplicate_of_item_id: Type.Union([ItemIdSchema, Type.Null()]),
  equivalence_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
  scope_evidence_ref: NullableArtifactRefSchema,
  repository_path: Type.Union([Type.String({ minLength: 1, maxLength: 1024 }), Type.Null()]),
  line_start: Type.Union([Type.Integer({ minimum: 1, maximum: 10_000_000 }), Type.Null()]),
  line_end: Type.Union([Type.Integer({ minimum: 1, maximum: 10_000_000 }), Type.Null()]),
} as const;

export const ScaP08DispositionAssertionV1Schema = Type.Object(
  {
    item_id: ItemIdSchema,
    item_kind: ItemKindSchema,
    disposition: DispositionSchema,
    ...DispositionSupportProperties,
  },
  { additionalProperties: false }
);
export type ScaP08DispositionAssertionV1 = Readonly<
  Static<typeof ScaP08DispositionAssertionV1Schema>
>;

export const ScaP08DispositionAssessmentV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_ASSESSMENT_SCHEMA),
    schema_version: Type.Literal(1),
    role: Type.Literal(SCA_P08_ASSESSOR_ROLE),
    payload_sha256: Sha256Schema,
    assigned_item_ids: Type.Array(ItemIdSchema, { minItems: 1, maxItems: 10_000 }),
    items: Type.Array(ScaP08DispositionAssertionV1Schema, { minItems: 1, maxItems: 10_000 }),
    complete: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P08_ASSESSMENT_SCHEMA }
);
export type ScaP08DispositionAssessmentV1 = Readonly<
  Static<typeof ScaP08DispositionAssessmentV1Schema>
>;

const ReviewVerdictSchema = Type.Union([
  Type.Literal("permits_confirmation"),
  Type.Literal("permits_refutation"),
  Type.Literal("not_permitted"),
]);

export const ScaP08DispositionReviewV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_REVIEW_SCHEMA),
    schema_version: Type.Literal(1),
    role: Type.Literal(SCA_P08_REVIEWER_ROLE),
    payload_sha256: Sha256Schema,
    assessment_sha256: Sha256Schema,
    assigned_item_ids: Type.Array(ItemIdSchema, { minItems: 1, maxItems: 10_000 }),
    items: Type.Array(
      Type.Object(
        {
          item_id: ItemIdSchema,
          item_kind: ItemKindSchema,
          verdict: ReviewVerdictSchema,
          exact_record_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 32 }),
          rationale: NonEmptyTextSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 10_000 }
    ),
    complete: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P08_REVIEW_SCHEMA }
);
export type ScaP08DispositionReviewV1 = Readonly<Static<typeof ScaP08DispositionReviewV1Schema>>;

/**
 * Host-issued reassessment stimulus. One entry per item whose disposition must be recomputed. The
 * reason codes name the `SCA-D02` trigger; the stimulus refs are the exact evidence the host
 * attests changed (new evidence, invalidated evidence, changed snapshot, changed scope) and the
 * duplicate identity the host resolved. It never authorizes P08 and never weakens P07 lineage.
 */
export const ScaP08ReassessmentEntryV1Schema = Type.Object(
  {
    item_id: ItemIdSchema,
    item_kind: ItemKindSchema,
    identity: OpaqueIdSchema,
    change_reason_codes: Type.Array(ReassessmentTriggerSchema, { minItems: 1, maxItems: 5 }),
    stimulus_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
    duplicate_of_item_id: Type.Union([ItemIdSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ScaP08ReassessmentEntryV1 = Readonly<Static<typeof ScaP08ReassessmentEntryV1Schema>>;

export const ScaP08ReassessmentV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_REASSESSMENT_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    run_id: OpaqueIdSchema,
    prior_p08_ledger_ref: ArtifactRefSchema,
    prior_p08_ledger_sha256: Sha256Schema,
    entries: Type.Array(ScaP08ReassessmentEntryV1Schema, { minItems: 1, maxItems: 10_000 }),
    reassessment_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_REASSESSMENT_SCHEMA }
);
export type ScaP08ReassessmentV1 = Readonly<Static<typeof ScaP08ReassessmentV1Schema>>;

/**
 * A host-issued, typed proof that two exact universe items are the same underlying subject. It is
 * the only evidence form admitted for `duplicate-of` equivalence: it binds the exact pair (both
 * derived item ids, identities, and exact primary refs/digests) so an arbitrary admitted artifact
 * cannot stand in for equivalence. The host issues it and revalidates every binding exactly.
 */
export const ScaP08DuplicateEquivalenceProofV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_EQUIVALENCE_PROOF_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    run_id: OpaqueIdSchema,
    duplicate_item_id: ItemIdSchema,
    duplicate_item_kind: ItemKindSchema,
    duplicate_item_identity: OpaqueIdSchema,
    duplicate_primary_ref: ArtifactRefSchema,
    duplicate_primary_sha256: Sha256Schema,
    target_item_id: ItemIdSchema,
    target_item_kind: ItemKindSchema,
    target_item_identity: OpaqueIdSchema,
    target_primary_ref: ArtifactRefSchema,
    target_primary_sha256: Sha256Schema,
    basis: Type.Literal("host_adjudicated_identical_subject"),
    proof_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_EQUIVALENCE_PROOF_SCHEMA }
);
export type ScaP08DuplicateEquivalenceProofV1 = Readonly<
  Static<typeof ScaP08DuplicateEquivalenceProofV1Schema>
>;

/** Pair key used to bind an admitted equivalence proof to one duplicate subject/target. */
export function scaP08DuplicatePairKey(duplicateItemId: string, targetItemId: string): string {
  return `${duplicateItemId}::${targetItemId}`;
}

export function validateScaP08DuplicateEquivalenceProofV1(
  value: unknown
): ScaP08DuplicateEquivalenceProofV1 {
  const parsed = validateContract(
    ScaP08DuplicateEquivalenceProofV1Schema,
    value,
    "SCA P08 duplicate equivalence proof"
  );
  if (
    parsed.duplicate_item_id !==
    scaP08ItemId({
      item_kind: parsed.duplicate_item_kind,
      identity: parsed.duplicate_item_identity,
    })
  ) {
    throw new Error("SCA P08 equivalence proof duplicate identity mismatch");
  }
  if (
    parsed.target_item_id !==
    scaP08ItemId({ item_kind: parsed.target_item_kind, identity: parsed.target_item_identity })
  ) {
    throw new Error("SCA P08 equivalence proof target identity mismatch");
  }
  if (parsed.duplicate_item_id === parsed.target_item_id) {
    throw new Error("SCA P08 equivalence proof cannot equate an item with itself");
  }
  if (parsed.duplicate_primary_sha256 !== parsed.duplicate_primary_ref.content_digest) {
    throw new Error("SCA P08 equivalence proof duplicate primary digest mismatch");
  }
  if (parsed.target_primary_sha256 !== parsed.target_primary_ref.content_digest) {
    throw new Error("SCA P08 equivalence proof target primary digest mismatch");
  }
  selfDigest(parsed, "proof_sha256", "SCA P08 equivalence proof");
  return parsed;
}

export const ScaP08DispositionRevisionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_DISPOSITION_REVISION_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    run_id: OpaqueIdSchema,
    item_id: ItemIdSchema,
    item_kind: ItemKindSchema,
    identity: OpaqueIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    parent_revision_ref: NullableArtifactRefSchema,
    parent_revision_sha256: Type.Union([Sha256Schema, Type.Null()]),
    disposition: DispositionSchema,
    ...DispositionSupportProperties,
    review_verdict: Type.Union([ReviewVerdictSchema, Type.Null()]),
    review_ref: NullableArtifactRefSchema,
    review_exact_record_refs: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 64 })),
    change_reason_codes: Type.Array(ChangeReasonSchema, { minItems: 1, maxItems: 16 }),
    changed_fields: Type.Array(OpaqueIdSchema, { maxItems: 32 }),
    created_at: Rfc3339UtcSchema,
    revision_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_DISPOSITION_REVISION_SCHEMA }
);
export type ScaP08DispositionRevisionV1 = Readonly<
  Static<typeof ScaP08DispositionRevisionV1Schema>
>;

const LedgerItemRowSchema = Type.Object(
  {
    item_id: ItemIdSchema,
    item_kind: ItemKindSchema,
    identity: OpaqueIdSchema,
    disposition: DispositionSchema,
    current_revision_ref: ArtifactRefSchema,
    prior_revision_refs: Type.Array(ArtifactRefSchema, { maxItems: 1024 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 16 }),
  },
  { additionalProperties: false }
);
export type ScaP08LedgerItemRowV1 = Readonly<Static<typeof LedgerItemRowSchema>>;

const CountField = Type.Integer({ minimum: 0, maximum: 10_000 });

export const ScaP08EvidenceLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_EVIDENCE_LEDGER_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    run_id: OpaqueIdSchema,
    admission_ref: ArtifactRefSchema,
    p07_terminal_ref: ArtifactRefSchema,
    p07_transition_ref: NullableArtifactRefSchema,
    p07_evidence_ledger_ref: ArtifactRefSchema,
    /** Additive reassessment lineage. Absent on the first ledger revision. */
    prior_p08_ledger_ref: Type.Optional(NullableArtifactRefSchema),
    prior_p08_ledger_sha256: Type.Optional(Type.Union([Sha256Schema, Type.Null()])),
    ledger_revision: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    append_only: Type.Optional(Type.Literal(true)),
    items: Type.Array(LedgerItemRowSchema, { minItems: 1, maxItems: 10_000 }),
    item_count: Type.Integer({ minimum: 1, maximum: 10_000 }),
    confirmed_count: CountField,
    rejected_with_evidence_count: CountField,
    inconclusive_count: CountField,
    deferred_count: CountField,
    duplicate_of_count: CountField,
    out_of_scope_count: CountField,
    unresolved_item_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    exhaustive_accounting: Type.Literal(true),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    ledger_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_EVIDENCE_LEDGER_SCHEMA }
);
export type ScaP08EvidenceLedgerV1 = Readonly<Static<typeof ScaP08EvidenceLedgerV1Schema>>;

export const ScaP08GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_GATE_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    criterion_id: Type.Literal("AC-P08"),
    verdict: Type.Union([
      Type.Literal("pass_ready"),
      Type.Literal("pass_blocked"),
      Type.Literal("blocked_invalid"),
    ]),
    evidence_ledger_ref: ArtifactRefSchema,
    p07_terminal_ref: ArtifactRefSchema,
    p07_transition_ref: NullableArtifactRefSchema,
    p07_evidence_ledger_ref: ArtifactRefSchema,
    exhaustive_accounting: Type.Boolean(),
    immutable_p07_lineage_valid: Type.Boolean(),
    support_semantics_valid: Type.Boolean(),
    no_false_refutation: Type.Boolean(),
    scope_duplicate_deferred_valid: Type.Boolean(),
    append_only_revisions: Type.Boolean(),
    retained_required_gaps: Type.Boolean(),
    p09_or_report_or_release_claims_absent: Type.Boolean(),
    item_count: Type.Integer({ minimum: 1, maximum: 10_000 }),
    confirmed_count: CountField,
    rejected_with_evidence_count: CountField,
    inconclusive_count: CountField,
    deferred_count: CountField,
    duplicate_of_count: CountField,
    out_of_scope_count: CountField,
    unresolved_item_count: CountField,
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 64 }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_GATE_SCHEMA }
);
export type ScaP08GateV1 = Readonly<Static<typeof ScaP08GateV1Schema>>;

export const ScaP08ToP09TransitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_TO_P09_TRANSITION_SCHEMA),
    schema_version: Type.Literal(1),
    source_phase_id: Type.Literal(SCA_P08_PHASE_ID),
    target_phase_id: Type.Literal("SCA-P09"),
    handoff_kind: Type.Literal("candidate_disposition_only"),
    qualification_scope: Type.Literal("disposition_gate_only_not_p09_reconciliation"),
    phase_gate_passed: Type.Literal(false),
    p09_reconciliation_authorized_by_this_transition: Type.Literal(false),
    p07_terminal_ref: ArtifactRefSchema,
    p07_transition_ref: NullableArtifactRefSchema,
    p07_evidence_ledger_ref: ArtifactRefSchema,
    p08_evidence_ledger_ref: ArtifactRefSchema,
    item_count: Type.Integer({ minimum: 1, maximum: 10_000 }),
    confirmed_count: CountField,
    rejected_with_evidence_count: CountField,
    inconclusive_count: CountField,
    deferred_count: CountField,
    duplicate_of_count: CountField,
    out_of_scope_count: CountField,
    unresolved_item_refs: Type.Array(ArtifactRefSchema, { maxItems: 10_000 }),
    required_gaps_retained: Type.Literal(true),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    campaign_completion_claimed: Type.Literal(false),
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_TO_P09_TRANSITION_SCHEMA }
);
export type ScaP08ToP09TransitionV1 = Readonly<Static<typeof ScaP08ToP09TransitionV1Schema>>;

export const ScaP08TerminalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P08_TERMINAL_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal(SCA_P08_PHASE_ID),
    status: Type.Union([
      Type.Literal("candidate_complete"),
      Type.Literal("blocked"),
      Type.Literal("cancelled"),
    ]),
    evidence_ledger_ref: NullableArtifactRefSchema,
    gate_ref: NullableArtifactRefSchema,
    p09_transition_ref: NullableArtifactRefSchema,
    p09_handoff_ready: Type.Boolean(),
    item_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    confirmed_count: CountField,
    rejected_with_evidence_count: CountField,
    inconclusive_count: CountField,
    deferred_count: CountField,
    duplicate_of_count: CountField,
    out_of_scope_count: CountField,
    selected_artifact_refs: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 64 }),
    phase_gate_passed: Type.Literal(false),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    nonterminal_campaign: Type.Literal(true),
    report_or_finding_adjudication_performed: Type.Literal(false),
    terminal_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P08_TERMINAL_SCHEMA }
);
export type ScaP08TerminalV1 = Readonly<Static<typeof ScaP08TerminalV1Schema>>;

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
function assertExactRequiredModel(value: RequiredModelIdentityV1, label: string): void {
  validateRequiredModelIdentity(value, label);
  if (!same(value, SCA_P08_REQUIRED_MODEL)) {
    throw new Error(`${label} is not the exact DeepSeek identity`);
  }
}
function assertNoBlankStrings(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (value.trim().length === 0) throw new Error(`${label} contains blank text`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoBlankStrings(entry, label);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) assertNoBlankStrings(entry, label);
  }
}

export function withP08Digest<T extends Readonly<Record<string, unknown>>, K extends string>(
  value: T,
  field: K
): T & Readonly<Record<K, string>> {
  return { ...value, [field]: sha256(canonicalJson(value)) } as T & Readonly<Record<K, string>>;
}

export function validateScaP08DisclosureScopeV1(value: unknown): ScaP08DisclosureScopeV1 {
  const parsed = validateContract(ScaP08DisclosureScopeV1Schema, value, "SCA P08 disclosure scope");
  assertExactRequiredModel(parsed.required_model, "SCA P08 disclosure scope model");
  if ((parsed.decision === "allow") !== (parsed.blocker_codes.length === 0)) {
    throw new Error("SCA P08 disclosure scope decision/blocker mismatch");
  }
  assertSortedUnique(parsed.blocker_codes, "SCA P08 disclosure scope blockers");
  selfDigest(parsed, "scope_sha256", "SCA P08 disclosure scope");
  return parsed;
}

export function validateScaP08ItemUniverseItemV1(value: unknown): ScaP08ItemUniverseItemV1 {
  const parsed = validateContract(
    ScaP08ItemUniverseItemV1Schema,
    value,
    "SCA P08 item universe item"
  );
  if (parsed.item_id !== scaP08ItemId({ item_kind: parsed.item_kind, identity: parsed.identity })) {
    throw new Error("SCA P08 item identity does not match its derived stable id");
  }
  return parsed;
}

export function validateScaP08ItemUniverseV1(value: unknown): ScaP08ItemUniverseV1 {
  const parsed = validateContract(ScaP08ItemUniverseV1Schema, value, "SCA P08 item universe");
  if (parsed.items.length !== parsed.item_count) {
    throw new Error("SCA P08 item universe count mismatch");
  }
  for (const item of parsed.items) validateScaP08ItemUniverseItemV1(item);
  assertSortedUnique(
    parsed.items.map((item) => item.item_id),
    "SCA P08 item universe ids"
  );
  selfDigest(parsed, "universe_sha256", "SCA P08 item universe");
  return parsed;
}

export function validateScaP08AdmissionV1(value: unknown): ScaP08AdmissionV1 {
  const parsed = validateContract(ScaP08AdmissionV1Schema, value, "SCA P08 admission");
  selfDigest(parsed, "admission_sha256", "SCA P08 admission");
  return parsed;
}

function assertCallRole(
  value: {
    readonly call_id: string;
    readonly role: string;
    readonly purpose: string;
  },
  label: string
): void {
  const assessment =
    value.call_id === SCA_P08_ASSESSMENT_CALL_ID &&
    value.role === SCA_P08_ASSESSOR_ROLE &&
    value.purpose === SCA_P08_ASSESSMENT_PURPOSE;
  const review =
    value.call_id === SCA_P08_REVIEW_CALL_ID &&
    value.role === SCA_P08_REVIEWER_ROLE &&
    value.purpose === SCA_P08_REVIEW_PURPOSE;
  if (!assessment && !review) throw new Error(`${label} call identity mismatch`);
}

export function validateScaP08CognitivePayloadV1(value: unknown): ScaP08CognitivePayloadV1 {
  const parsed = validateContract(
    ScaP08CognitivePayloadV1Schema,
    value,
    "SCA P08 cognitive payload"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P08 cognitive payload model");
  assertCallRole(parsed, "SCA P08 cognitive payload");
  assertSortedUnique(parsed.assigned_item_ids, "SCA P08 payload assigned items");
  assertSortedUnique(
    parsed.items.map((item) => item.item_id),
    "SCA P08 payload item ids"
  );
  if (
    !same(
      parsed.assigned_item_ids,
      parsed.items.map((item) => item.item_id)
    )
  ) {
    throw new Error("SCA P08 cognitive payload is not exhaustive");
  }
  assertSortedUnique(
    parsed.scope_decision_refs.map((ref) => ref.artifact_id),
    "SCA P08 payload scope-decision refs"
  );
  for (const ref of parsed.scope_decision_refs) {
    if (!isScaP08ScopeDecisionKind(ref.kind)) {
      throw new Error("SCA P08 payload scope-decision ref is not an admitted scope-decision kind");
    }
  }
  for (const item of parsed.items) {
    if (
      item.item_id !== scaP08ItemId({ item_kind: item.item_kind, identity: item.identity }) ||
      (item.item_kind === "hypothesis") !== (item.hypothesis !== null)
    ) {
      throw new Error("SCA P08 payload item lineage mismatch");
    }
    assertSortedUnique(
      item.equivalence_proof_refs.map((ref) => ref.artifact_id),
      "SCA P08 payload item equivalence proof refs"
    );
  }
  if (parsed.call_id === SCA_P08_REVIEW_CALL_ID && parsed.assessment_ref === null) {
    throw new Error("SCA P08 review payload must name the assessment under review");
  }
  if (parsed.call_id === SCA_P08_ASSESSMENT_CALL_ID && parsed.assessment_ref !== null) {
    throw new Error("SCA P08 assessment payload cannot name an assessment");
  }
  selfDigest(parsed, "payload_sha256", "SCA P08 cognitive payload");
  return parsed;
}

export function validateScaP08DisclosureAdmissionV1(value: unknown): ScaP08DisclosureAdmissionV1 {
  const parsed = validateContract(
    ScaP08DisclosureAdmissionV1Schema,
    value,
    "SCA P08 disclosure admission"
  );
  assertExactRequiredModel(parsed.required_model, "SCA P08 disclosure admission model");
  assertCallRole(parsed, "SCA P08 disclosure admission");
  assertSortedUnique(
    parsed.authorized_refs.map((ref) => ref.artifact_id),
    "SCA P08 disclosure authorized refs"
  );
  if ((parsed.decision === "allow") !== (parsed.blocker_codes.length === 0)) {
    throw new Error("SCA P08 disclosure admission decision/blocker mismatch");
  }
  selfDigest(parsed, "admission_sha256", "SCA P08 disclosure admission");
  return parsed;
}

export function validateScaP08DispositionAssertionV1(value: unknown): ScaP08DispositionAssertionV1 {
  const parsed = validateContract(
    ScaP08DispositionAssertionV1Schema,
    value,
    "SCA P08 disposition assertion"
  );
  assertNoBlankStrings(parsed, "SCA P08 disposition assertion");
  return parsed;
}

export function validateScaP08DispositionAssessmentV1(
  value: unknown
): ScaP08DispositionAssessmentV1 {
  const parsed = validateContract(
    ScaP08DispositionAssessmentV1Schema,
    value,
    "SCA P08 disposition assessment"
  );
  assertSortedUnique(parsed.assigned_item_ids, "SCA P08 assessment assigned items");
  assertSortedUnique(
    parsed.items.map((item) => item.item_id),
    "SCA P08 assessment item ids"
  );
  if (
    !same(
      parsed.assigned_item_ids,
      parsed.items.map((item) => item.item_id)
    )
  ) {
    throw new Error("SCA P08 disposition assessment is not exhaustive");
  }
  for (const item of parsed.items) validateScaP08DispositionAssertionV1(item);
  return parsed;
}

export function validateScaP08DispositionReviewV1(value: unknown): ScaP08DispositionReviewV1 {
  const parsed = validateContract(
    ScaP08DispositionReviewV1Schema,
    value,
    "SCA P08 disposition review"
  );
  assertSortedUnique(parsed.assigned_item_ids, "SCA P08 review assigned items");
  assertSortedUnique(
    parsed.items.map((item) => item.item_id),
    "SCA P08 review item ids"
  );
  if (
    !same(
      parsed.assigned_item_ids,
      parsed.items.map((item) => item.item_id)
    )
  ) {
    throw new Error("SCA P08 disposition review is not exhaustive");
  }
  for (const item of parsed.items) {
    if (item.exact_record_refs.length === 0) {
      throw new Error("SCA P08 review item lacks an exact-record binding");
    }
    assertSortedUnique(
      item.exact_record_refs.map((ref) => ref.artifact_id),
      "SCA P08 review exact-record refs"
    );
  }
  return parsed;
}

/**
 * Deterministic host-side support validation for one disposition assertion. It encodes the six
 * required-support predicates and never lets severity, confidence, agreement, or prose select or
 * upgrade a disposition.
 */
export interface ScaP08SupportContextV1 {
  readonly universe_item_ids: ReadonlySet<string>;
  readonly p07_status_by_item_id: ReadonlyMap<string, "completed" | "blocked" | "not_invoked">;
  /** Exact admitted P01/P06 scope-decision record ids an `out-of-scope` item may cite. */
  readonly admitted_scope_decision_ref_ids: ReadonlySet<string>;
  /** Admitted typed equivalence-proof ref id for each exact duplicate pair (duplicate::target). */
  readonly admitted_equivalence_proof_ref_id_by_pair: ReadonlyMap<string, string>;
}

export function validateScaP08DispositionSupportV1(
  assertion: ScaP08DispositionAssertionV1,
  context: ScaP08SupportContextV1
): void {
  const blocked = context.p07_status_by_item_id.get(assertion.item_id);
  const actionBlocked = blocked !== undefined && blocked !== "completed";
  if (
    actionBlocked &&
    (assertion.disposition === "confirmed" || assertion.disposition === "rejected-with-evidence")
  ) {
    throw new Error(
      "SCA P08 cannot confirm or refute an item whose P07 action is blocked or not invoked"
    );
  }
  const runtimePredicate =
    assertion.evidence_mode === "runtime" &&
    assertion.actor_state_stimulus_verified &&
    assertion.target_reachability_observed;
  const codePredicate =
    assertion.evidence_mode === "code" && assertion.complete_code_control_state_evidence;
  switch (assertion.disposition) {
    case "confirmed": {
      if (assertion.claim === null || assertion.supporting_evidence_refs.length === 0) {
        throw new Error("SCA P08 confirmation requires a claim and exact supporting evidence");
      }
      if (!runtimePredicate && !codePredicate) {
        throw new Error(
          "SCA P08 confirmation requires correct actor/state/stimulus and reachability or complete code evidence"
        );
      }
      if (assertion.defeating_evidence_refs.length > 0 || assertion.finite_clean_fuzzing_only) {
        throw new Error("SCA P08 confirmation cites defeating or finite-fuzzing-only evidence");
      }
      return;
    }
    case "rejected-with-evidence": {
      if (assertion.claim === null || assertion.defeating_evidence_refs.length === 0) {
        throw new Error("SCA P08 refutation requires a claim and exact defeating evidence");
      }
      if (assertion.finite_clean_fuzzing_only) {
        throw new Error("SCA P08 finite clean fuzzing cannot support a refutation");
      }
      if (!runtimePredicate && !codePredicate) {
        throw new Error(
          "SCA P08 refutation requires correct actor/state/stimulus and reachability or complete code evidence"
        );
      }
      if (assertion.evidence_mode === "runtime" && assertion.distinguishing_oracle === null) {
        throw new Error(
          "SCA P08 runtime refutation requires a distinguishing oracle separating the claim from its alternatives"
        );
      }
      if (
        assertion.repository_path === null ||
        assertion.line_start === null ||
        assertion.line_end === null ||
        assertion.line_end < assertion.line_start
      ) {
        throw new Error("SCA P08 refutation must cite a repository path and line range");
      }
      return;
    }
    case "inconclusive": {
      if (
        assertion.unresolved_material_link === null ||
        assertion.resolution_evidence_need === null
      ) {
        throw new Error(
          "SCA P08 inconclusive disposition requires a named unresolved link and resolution evidence need"
        );
      }
      return;
    }
    case "deferred": {
      if (assertion.deferral_reason === null || assertion.reopening_conditions.length === 0) {
        throw new Error("SCA P08 deferred disposition requires a reason and reopening conditions");
      }
      return;
    }
    case "duplicate-of": {
      if (assertion.duplicate_of_item_id === null) {
        throw new Error("SCA P08 duplicate-of requires an exact duplicate identity");
      }
      if (assertion.duplicate_of_item_id === assertion.item_id) {
        throw new Error("SCA P08 duplicate-of cannot reference itself");
      }
      if (!context.universe_item_ids.has(assertion.duplicate_of_item_id)) {
        throw new Error("SCA P08 duplicate-of references an item outside the universe");
      }
      if (assertion.equivalence_evidence_refs.length === 0) {
        throw new Error("SCA P08 duplicate-of requires equivalence evidence");
      }
      const proofRefId = context.admitted_equivalence_proof_ref_id_by_pair.get(
        scaP08DuplicatePairKey(assertion.item_id, assertion.duplicate_of_item_id)
      );
      if (proofRefId === undefined) {
        throw new Error(
          "SCA P08 duplicate-of requires an admitted typed equivalence proof for the exact pair"
        );
      }
      if (!assertion.equivalence_evidence_refs.some((ref) => ref.artifact_id === proofRefId)) {
        throw new Error(
          "SCA P08 duplicate-of must cite the admitted equivalence proof for the exact pair"
        );
      }
      return;
    }
    case "out-of-scope": {
      if (assertion.scope_evidence_ref === null) {
        throw new Error("SCA P08 out-of-scope requires admitted scope evidence");
      }
      if (!context.admitted_scope_decision_ref_ids.has(assertion.scope_evidence_ref.artifact_id)) {
        throw new Error("SCA P08 out-of-scope must cite an admitted P01/P06 scope-decision record");
      }
      return;
    }
  }
}

/**
 * Rejects any `duplicate-of` edge whose target is absent from the dispositioned set, is the item
 * itself, or is *itself* `duplicate-of`. Requiring the target to carry a non-duplicate disposition
 * rejects every chain (`A→B→C`) as well as every cycle; a pure cycle check is insufficient
 * because `A→B→C` has no cycle yet still resolves to a `duplicate-of` target (`SCA-P08` R2).
 * Reassessment never rewrites an earlier snapshot.
 */
export function assertScaP08DuplicateTargetsValid(
  assertions: readonly {
    readonly item_id: string;
    readonly disposition: ScaP08DispositionKindV1;
    readonly duplicate_of_item_id: string | null;
  }[]
): void {
  const byId = new Map(assertions.map((assertion) => [assertion.item_id, assertion] as const));
  for (const assertion of assertions) {
    if (assertion.disposition !== "duplicate-of") continue;
    const targetId = assertion.duplicate_of_item_id;
    if (targetId === null) {
      throw new Error("SCA P08 duplicate-of assertion has no target identity");
    }
    if (targetId === assertion.item_id) {
      throw new Error("SCA P08 duplicate-of cannot reference itself");
    }
    const target = byId.get(targetId);
    if (target === undefined) {
      throw new Error("SCA P08 duplicate-of target is not dispositioned in this assessment");
    }
    if (target.disposition === "duplicate-of") {
      throw new Error(
        "SCA P08 duplicate-of target is itself duplicate-of (duplicate-of chains are forbidden)"
      );
    }
  }
}

export function validateScaP08AssessmentAgainstPayload(
  resultValue: unknown,
  payloadValue: unknown
): ScaP08DispositionAssessmentV1 {
  const result = validateScaP08DispositionAssessmentV1(resultValue);
  const payload = validateScaP08CognitivePayloadV1(payloadValue);
  if (
    payload.call_id !== SCA_P08_ASSESSMENT_CALL_ID ||
    result.payload_sha256 !== payload.payload_sha256 ||
    !same(result.assigned_item_ids, payload.assigned_item_ids)
  ) {
    throw new Error("SCA P08 assessment payload/assignment binding mismatch");
  }
  const byId = new Map(payload.items.map((entry) => [entry.item_id, entry]));
  for (const item of result.items) {
    const payloadItem = byId.get(item.item_id);
    if (payloadItem === undefined) {
      throw new Error("SCA P08 assessment is outside the assigned item universe");
    }
    if (payloadItem.item_kind !== item.item_kind) {
      throw new Error("SCA P08 assessment item kind drifted from the payload");
    }
  }
  assertScaP08DuplicateTargetsValid(result.items);
  return result;
}

export function validateScaP08ReviewAgainstPayload(
  resultValue: unknown,
  payloadValue: unknown,
  assessmentSha256: string
): ScaP08DispositionReviewV1 {
  const result = validateScaP08DispositionReviewV1(resultValue);
  const payload = validateScaP08CognitivePayloadV1(payloadValue);
  if (
    payload.call_id !== SCA_P08_REVIEW_CALL_ID ||
    result.payload_sha256 !== payload.payload_sha256 ||
    result.assessment_sha256 !== assessmentSha256 ||
    !same(result.assigned_item_ids, payload.assigned_item_ids)
  ) {
    throw new Error("SCA P08 review payload/assessment binding mismatch");
  }
  const byId = new Map(payload.items.map((entry) => [entry.item_id, entry]));
  for (const item of result.items) {
    const payloadItem = byId.get(item.item_id);
    if (payloadItem === undefined || payloadItem.item_kind !== item.item_kind) {
      throw new Error("SCA P08 review item kind drifted from the payload");
    }
  }
  return result;
}

export function validateScaP08DispositionRevisionV1(value: unknown): ScaP08DispositionRevisionV1 {
  const parsed = validateContract(
    ScaP08DispositionRevisionV1Schema,
    value,
    "SCA P08 disposition revision"
  );
  if (parsed.item_id !== scaP08ItemId({ item_kind: parsed.item_kind, identity: parsed.identity })) {
    throw new Error("SCA P08 disposition revision item identity mismatch");
  }
  if (
    (parsed.parent_revision_ref === null) !== (parsed.parent_revision_sha256 === null) ||
    (parsed.parent_revision_ref !== null &&
      parsed.parent_revision_sha256 !== parsed.parent_revision_ref.content_digest) ||
    (parsed.parent_revision_ref !== null &&
      parsed.parent_revision_ref.kind !== DISPOSITION_REVISION_KIND)
  ) {
    throw new Error("SCA P08 disposition revision parent chain shape mismatch");
  }
  if (parsed.revision === 1 && parsed.parent_revision_ref !== null) {
    throw new Error("SCA P08 initial disposition revision cannot have a parent");
  }
  if (parsed.revision > 1 && parsed.parent_revision_ref === null) {
    throw new Error("SCA P08 reassessed disposition revision requires a parent");
  }
  assertSortedUnique(parsed.change_reason_codes, "SCA P08 revision change reasons");
  assertSortedUnique(parsed.changed_fields, "SCA P08 revision changed fields");
  if (parsed.revision > 1 && parsed.changed_fields.length === 0) {
    throw new Error("SCA P08 reassessed disposition revision must change at least one field");
  }
  if (parsed.revision === 1 && !same(parsed.change_reason_codes, ["initial_construction"])) {
    throw new Error("SCA P08 initial disposition revision reason must be initial_construction");
  }
  if (parsed.revision > 1 && parsed.change_reason_codes.includes("initial_construction")) {
    throw new Error("SCA P08 reassessed disposition revision cannot claim initial_construction");
  }
  if ((parsed.review_verdict === null) !== (parsed.review_ref === null)) {
    throw new Error("SCA P08 disposition revision review verdict/ref binding mismatch");
  }
  if (parsed.review_exact_record_refs !== undefined) {
    assertSortedUnique(
      parsed.review_exact_record_refs.map((ref) => ref.artifact_id),
      "SCA P08 revision review exact-record refs"
    );
    if (parsed.review_exact_record_refs.length > 0 && parsed.review_ref === null) {
      throw new Error("SCA P08 disposition revision binds review records without a review ref");
    }
  }
  selfDigest(parsed, "revision_sha256", "SCA P08 disposition revision");
  return parsed;
}

export function validateScaP08ReassessmentV1(value: unknown): ScaP08ReassessmentV1 {
  const parsed = validateContract(ScaP08ReassessmentV1Schema, value, "SCA P08 reassessment");
  if (parsed.prior_p08_ledger_sha256 !== parsed.prior_p08_ledger_ref.content_digest) {
    throw new Error("SCA P08 reassessment prior-ledger digest binding mismatch");
  }
  assertSortedUnique(
    parsed.entries.map((entry) => entry.item_id),
    "SCA P08 reassessment entry ids"
  );
  for (const entry of parsed.entries) {
    if (entry.item_id !== scaP08ItemId({ item_kind: entry.item_kind, identity: entry.identity })) {
      throw new Error("SCA P08 reassessment entry identity mismatch");
    }
    assertSortedUnique(entry.change_reason_codes, "SCA P08 reassessment reason codes");
    assertSortedUnique(
      entry.stimulus_refs.map((ref) => ref.artifact_id),
      "SCA P08 reassessment stimulus refs"
    );
    const duplicate = entry.change_reason_codes.includes("duplicate_resolution");
    if (duplicate !== (entry.duplicate_of_item_id !== null)) {
      throw new Error("SCA P08 reassessment duplicate identity/trigger mismatch");
    }
    if (entry.duplicate_of_item_id === entry.item_id) {
      throw new Error("SCA P08 reassessment cannot resolve an item as its own duplicate");
    }
  }
  selfDigest(parsed, "reassessment_sha256", "SCA P08 reassessment");
  return parsed;
}

export function validateScaP08EvidenceLedgerV1(value: unknown): ScaP08EvidenceLedgerV1 {
  const parsed = validateContract(ScaP08EvidenceLedgerV1Schema, value, "SCA P08 evidence ledger");
  if (parsed.items.length !== parsed.item_count) {
    throw new Error("SCA P08 evidence ledger row count mismatch");
  }
  assertSortedUnique(
    parsed.items.map((item) => item.item_id),
    "SCA P08 evidence ledger item ids"
  );
  const counts = new Map<string, number>();
  for (const item of parsed.items) {
    counts.set(item.disposition, (counts.get(item.disposition) ?? 0) + 1);
  }
  const accounted =
    (counts.get("confirmed") ?? 0) +
    (counts.get("rejected-with-evidence") ?? 0) +
    (counts.get("inconclusive") ?? 0) +
    (counts.get("deferred") ?? 0) +
    (counts.get("duplicate-of") ?? 0) +
    (counts.get("out-of-scope") ?? 0);
  if (
    accounted !== parsed.item_count ||
    (counts.get("confirmed") ?? 0) !== parsed.confirmed_count ||
    (counts.get("rejected-with-evidence") ?? 0) !== parsed.rejected_with_evidence_count ||
    (counts.get("inconclusive") ?? 0) !== parsed.inconclusive_count ||
    (counts.get("deferred") ?? 0) !== parsed.deferred_count ||
    (counts.get("duplicate-of") ?? 0) !== parsed.duplicate_of_count ||
    (counts.get("out-of-scope") ?? 0) !== parsed.out_of_scope_count
  ) {
    throw new Error("SCA P08 evidence ledger disposition accounting is not exhaustive");
  }
  const expectedUnresolved = parsed.items
    .filter((item) => item.disposition === "inconclusive" || item.disposition === "deferred")
    .map((item) => item.current_revision_ref.artifact_id)
    .sort();
  if (!same(expectedUnresolved, parsed.unresolved_item_refs.map((ref) => ref.artifact_id).sort())) {
    throw new Error("SCA P08 evidence ledger unresolved refs disagree with its rows");
  }
  const revision = parsed.ledger_revision ?? 1;
  const priorRef = parsed.prior_p08_ledger_ref ?? null;
  const priorSha = parsed.prior_p08_ledger_sha256 ?? null;
  if ((priorRef === null) !== (priorSha === null)) {
    throw new Error("SCA P08 evidence ledger prior-ledger ref/digest mismatch");
  }
  if (priorRef !== null && priorSha !== priorRef.content_digest) {
    throw new Error("SCA P08 evidence ledger prior-ledger digest binding mismatch");
  }
  if ((priorRef !== null) !== revision > 1) {
    throw new Error("SCA P08 evidence ledger revision/prior-ledger mismatch");
  }
  if (parsed.append_only !== undefined && parsed.append_only !== true) {
    throw new Error("SCA P08 evidence ledger must be append-only");
  }
  selfDigest(parsed, "ledger_sha256", "SCA P08 evidence ledger");
  return parsed;
}

export function validateScaP08GateV1(value: unknown): ScaP08GateV1 {
  const parsed = validateContract(ScaP08GateV1Schema, value, "SCA P08 gate");
  if (
    parsed.verdict === "pass_ready" &&
    (parsed.blocker_codes.length !== 0 ||
      !parsed.exhaustive_accounting ||
      !parsed.immutable_p07_lineage_valid ||
      !parsed.support_semantics_valid ||
      !parsed.no_false_refutation ||
      !parsed.scope_duplicate_deferred_valid ||
      !parsed.append_only_revisions ||
      parsed.retained_required_gaps ||
      !parsed.p09_or_report_or_release_claims_absent)
  ) {
    throw new Error("SCA P08 pass_ready gate claims an unmet condition");
  }
  if (
    parsed.verdict !== "pass_ready" &&
    parsed.blocker_codes.length === 0 &&
    parsed.unresolved_item_count > 0 &&
    !parsed.retained_required_gaps
  ) {
    throw new Error("SCA P08 gate retains unresolved items without a blocker code");
  }
  selfDigest(parsed, "gate_sha256", "SCA P08 gate");
  return parsed;
}

export function validateScaP08ToP09TransitionV1(value: unknown): ScaP08ToP09TransitionV1 {
  const parsed = validateContract(
    ScaP08ToP09TransitionV1Schema,
    value,
    "SCA P08 successor handoff"
  );
  const sum =
    parsed.confirmed_count +
    parsed.rejected_with_evidence_count +
    parsed.inconclusive_count +
    parsed.deferred_count +
    parsed.duplicate_of_count +
    parsed.out_of_scope_count;
  if (sum !== parsed.item_count) {
    throw new Error("SCA P08 successor handoff disposition accounting is not exhaustive");
  }
  selfDigest(parsed, "transition_sha256", "SCA P08 successor handoff");
  return parsed;
}

export function validateScaP08TerminalV1(value: unknown): ScaP08TerminalV1 {
  const parsed = validateContract(ScaP08TerminalV1Schema, value, "SCA P08 terminal");
  const sum =
    parsed.confirmed_count +
    parsed.rejected_with_evidence_count +
    parsed.inconclusive_count +
    parsed.deferred_count +
    parsed.duplicate_of_count +
    parsed.out_of_scope_count;
  if (sum !== parsed.item_count) {
    throw new Error("SCA P08 terminal disposition accounting is not exhaustive");
  }
  if ((parsed.p09_transition_ref !== null) !== parsed.p09_handoff_ready) {
    throw new Error("SCA P08 terminal handoff readiness disagrees with its transition ref");
  }
  if (parsed.status === "candidate_complete" && parsed.p09_transition_ref === null) {
    throw new Error("SCA P08 candidate_complete terminal requires a P09 handoff");
  }
  if (parsed.status === "cancelled" && parsed.p09_transition_ref !== null) {
    throw new Error("SCA P08 cancelled terminal cannot hand off a successor transition");
  }
  selfDigest(parsed, "terminal_sha256", "SCA P08 terminal");
  return parsed;
}
