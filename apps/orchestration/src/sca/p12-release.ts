import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract, type ArtifactRef } from "../contracts.js";
import {
  validateScaPhaseQualificationRecordV3,
  validateScaPhaseReviewerAuthorityV1,
} from "./qualification-gate-contracts.js";
import {
  verifyScaPhaseGateV3,
  type ScaPhaseQualificationDefinitionV1,
} from "./qualification-gate.js";
import {
  SCA_P12_GATE_SCHEMA,
  SCA_P12_MISSING_DOWNSTREAM_ARTIFACTS,
  SCA_P12_DOWNSTREAM_OBLIGATION_IDS,
  SCA_P12_OBLIGATION_LEDGER_SCHEMA,
  SCA_P12_PHASE_GATE_INDEX_SCHEMA,
  SCA_P12_RELEASE_RECORD_SCHEMA,
  SCA_P12_TERMINAL_SCHEMA,
  SCA_P12_ACCEPTANCE_OBLIGATION_ID,
  SCA_P12_INDEPENDENT_REVIEW_OBLIGATION_ID,
  SCA_P12_RELEASE_AUTHORITY_OBLIGATION_ID,
  validateScaP12GateV1,
  validateScaP12ObligationLedgerV1,
  validateScaP12PhaseGateIndexV1,
  validateScaP12ReleaseRecordV1,
  validateScaP12TerminalV1,
  withP12Digest,
  type ScaP12GateV1,
  type ScaP12LaneV1,
  type ScaP12ObligationLedgerV1,
  type ScaP12PhaseGateIndexV1,
  type ScaP12ReleaseRecordV1,
  type ScaP12TerminalStatusV1,
  type ScaP12TerminalV1,
} from "./p12-contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";

/** The exact accepted phase gates AC-P01..AC-P11 that campaign completion requires (P12-R25.1). */
export const SCA_P12_PHASE_GATE_PHASES = Object.freeze([
  "SCA-P01",
  "SCA-P02",
  "SCA-P03",
  "SCA-P04",
  "SCA-P05",
  "SCA-P06",
  "SCA-P07",
  "SCA-P08",
  "SCA-P09",
  "SCA-P10",
  "SCA-P11",
] as const);

export interface ScaP12PhaseGateDerivedExclusionsV1 {
  readonly identity_ids: readonly string[];
  readonly lineage_ids: readonly string[];
}

export interface ScaP12PhaseGateEvaluationV1 {
  readonly complete: boolean;
  readonly blocker_codes: readonly string[];
  readonly evidence_refs: readonly ArtifactRef[];
  /** Identity/lineage exclusions derived from the verified gate qualification/reviewer records. */
  readonly derived_exclusions: ScaP12PhaseGateDerivedExclusionsV1;
}

function readExactJson<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  validate: (value: unknown) => T
): T {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || canonicalJson(stored) !== canonicalJson(ref)) {
    throw new Error("P12 phase-gate derived record ref is absent or substituted");
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error("P12 phase-gate derived record bytes drifted");
  }
  const text = bytes.toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text)
    throw new Error("P12 phase-gate derived record is noncanonical");
  return validate(parsed);
}

/**
 * Independently re-derive the host-owned phase-gate index (P12-R25.1, ambiguity A5). A caller-supplied
 * index is never trusted: every entry must resolve to an exact `penny.sca-phase-gate-record.v3` that
 * is fully re-verified with `verifyScaPhaseGateV3` (qualification re-derivation + current-authority +
 * upstream custody) against a host-supplied qualification definition, and the index must cover
 * exactly AC-P01..AC-P11. Wire-shape validation alone is never sufficient: a self-sealed or synthetic
 * gate whose qualification does not re-derive fails closed with no positive release.
 */
export function evaluateScaP12PhaseGateIndexV1(input: {
  readonly store: ArtifactHostStore;
  readonly index: unknown;
  readonly definition_for?: (phase_id: string) => ScaPhaseQualificationDefinitionV1 | null;
}): ScaP12PhaseGateEvaluationV1 {
  const index = validateScaP12PhaseGateIndexV1(input.index);
  const blockers: string[] = [];
  const evidenceRefs: ArtifactRef[] = [];
  const identityIds = new Set<string>();
  const lineageIds = new Set<string>();
  const byPhase = new Map(index.entries.map((entry) => [entry.phase_id, entry]));
  if (!index.closed) blockers.push("p12_phase_gate_index_not_closed");
  for (const phase of SCA_P12_PHASE_GATE_PHASES) {
    const entry = byPhase.get(phase);
    if (entry === undefined) {
      blockers.push(`p12_phase_gate_missing_${phase.toLowerCase()}`);
      continue;
    }
    if (entry.criterion_id !== `AC-${phase.replace(/^SCA-/, "")}`) {
      blockers.push(`p12_phase_gate_criterion_mismatch_${phase.toLowerCase()}`);
      continue;
    }
    const definition = input.definition_for?.(phase) ?? null;
    if (definition === null) {
      blockers.push(`p12_phase_gate_definition_absent_${phase.toLowerCase()}`);
      continue;
    }
    let gate: ReturnType<typeof verifyScaPhaseGateV3>;
    try {
      gate = verifyScaPhaseGateV3({
        store: input.store,
        definition,
        gate_ref: entry.gate_ref,
      });
    } catch {
      blockers.push(`p12_phase_gate_verification_failed_${phase.toLowerCase()}`);
      continue;
    }
    if (gate.phase_id !== phase || gate.status !== "passed") {
      blockers.push(`p12_phase_gate_not_accepted_${phase.toLowerCase()}`);
      continue;
    }
    try {
      const qualification = readExactJson(
        input.store,
        gate.qualification_ref,
        validateScaPhaseQualificationRecordV3
      );
      const reviewer = readExactJson(
        input.store,
        gate.reviewer_authority_ref,
        validateScaPhaseReviewerAuthorityV1
      );
      identityIds.add(qualification.implementer_identity_id);
      identityIds.add(reviewer.reviewer_identity_id);
      lineageIds.add(qualification.implementer_lineage_id);
      lineageIds.add(reviewer.reviewer_lineage_id);
    } catch {
      blockers.push(`p12_phase_gate_identity_unreadable_${phase.toLowerCase()}`);
      continue;
    }
    evidenceRefs.push(entry.gate_ref);
  }
  return {
    complete: blockers.length === 0,
    blocker_codes: [...new Set(blockers)].sort(),
    evidence_refs: evidenceRefs,
    derived_exclusions: {
      identity_ids: [...identityIds].sort(),
      lineage_ids: [...lineageIds].sort(),
    },
  };
}

export function scaP12MissingDownstreamArtifacts(): readonly string[] {
  return [...SCA_P12_MISSING_DOWNSTREAM_ARTIFACTS];
}
export function scaP12DownstreamObligationIds(): readonly string[] {
  return [...SCA_P12_DOWNSTREAM_OBLIGATION_IDS];
}

export function buildScaP12PhaseGateIndexV1(input: {
  readonly run_id: string;
  readonly entries: readonly {
    readonly phase_id: string;
    readonly criterion_id: string;
    readonly gate_ref: ArtifactRef;
  }[];
  readonly closed: boolean;
  readonly issued_at: string;
}): ScaP12PhaseGateIndexV1 {
  return validateScaP12PhaseGateIndexV1(
    withP12Digest(
      {
        schema_id: SCA_P12_PHASE_GATE_INDEX_SCHEMA,
        schema_version: 1 as const,
        run_id: input.run_id,
        phase_id: "SCA-P12" as const,
        entries: input.entries.map((entry) => ({
          phase_id: entry.phase_id,
          criterion_id: entry.criterion_id,
          gate_ref: entry.gate_ref,
        })),
        entry_count: input.entries.length,
        closed: input.closed,
        issued_at: input.issued_at,
      },
      "index_sha256"
    )
  );
}

// --- Obligation ledger ------------------------------------------------------------------------

export function buildScaP12ObligationLedgerV1(input: {
  readonly run_id: string;
  readonly revision: number;
  readonly admission_ref: ArtifactRef;
  readonly verifier_authority_ref: ArtifactRef;
  readonly release_authority_ref: ArtifactRef;
  readonly replay_ref: ArtifactRef;
  readonly verdicts_ref: ArtifactRef;
  readonly approval_ref: ArtifactRef | null;
  readonly acceptance_covered: boolean;
  readonly independent_review_covered: boolean;
  readonly release_authority_covered: boolean;
}): ScaP12ObligationLedgerV1 {
  const entries = [
    {
      obligation_id: SCA_P12_ACCEPTANCE_OBLIGATION_ID,
      scope: "phase" as const,
      covered: input.acceptance_covered,
      coverage: input.acceptance_covered
        ? "P12 admission, deterministic replay, and verifier verdicts establish the AC-P12 acceptance evidence."
        : "AC-P12 acceptance evidence is incomplete; the missing item is retained.",
      artifact_refs: [input.admission_ref, input.replay_ref, input.verdicts_ref],
    },
    {
      obligation_id: SCA_P12_INDEPENDENT_REVIEW_OBLIGATION_ID,
      scope: "boundary" as const,
      covered: input.independent_review_covered,
      coverage: input.independent_review_covered
        ? "An independent, strict-subset, current-authority verifier produced the supported verdict set."
        : "Independent review is not established with a separated current-authority verifier.",
      artifact_refs: [input.verifier_authority_ref, input.verdicts_ref],
    },
    {
      obligation_id: SCA_P12_RELEASE_AUTHORITY_OBLIGATION_ID,
      scope: "boundary" as const,
      covered: input.release_authority_covered,
      coverage: input.release_authority_covered
        ? "An authorized, distinct release authority and its exact-bound human release approval are present. Publication authority remains separate and unmet."
        : "The release authority or its exact-bound human release approval is absent; publication authority remains separate and unmet.",
      artifact_refs:
        input.approval_ref === null
          ? [input.release_authority_ref]
          : [input.release_authority_ref, input.approval_ref],
    },
  ].sort((left, right) => left.obligation_id.localeCompare(right.obligation_id));
  const uncovered = entries
    .filter((entry) => !entry.covered)
    .map((entry) => entry.obligation_id)
    .sort();
  return validateScaP12ObligationLedgerV1(
    withP12Digest(
      {
        schema_id: SCA_P12_OBLIGATION_LEDGER_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        run_id: input.run_id,
        revision: input.revision,
        entries,
        entry_count: entries.length,
        uncovered_obligation_ids: uncovered,
      },
      "ledger_sha256"
    )
  );
}

// --- Release record / gate / terminal ---------------------------------------------------------

export function buildScaP12ReleaseRecordV1(input: {
  readonly run_id: string;
  readonly phase_gate_index_ref: ArtifactRef;
  readonly p11_terminal_ref: ArtifactRef;
  readonly p11_report_ref: ArtifactRef;
  readonly p11_reconciliation_ref: ArtifactRef;
  readonly p11_validation_records_ref: ArtifactRef;
  readonly p11_gate_ref: ArtifactRef;
  readonly admission_ref: ArtifactRef;
  readonly replay_evidence_ref: ArtifactRef;
  readonly verifier_verdicts_ref: ArtifactRef;
  readonly release_authority_ref: ArtifactRef;
  readonly release_approval_ref: ArtifactRef | null;
  readonly obligation_ledger_ref: ArtifactRef;
  readonly release_eligible: boolean;
  readonly campaign_complete: boolean;
  readonly blocker_codes: readonly string[];
}): ScaP12ReleaseRecordV1 {
  return validateScaP12ReleaseRecordV1(
    withP12Digest(
      {
        schema_id: SCA_P12_RELEASE_RECORD_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        run_id: input.run_id,
        phase_gate_index_ref: input.phase_gate_index_ref,
        p11_terminal_ref: input.p11_terminal_ref,
        p11_report_ref: input.p11_report_ref,
        p11_reconciliation_ref: input.p11_reconciliation_ref,
        p11_validation_records_ref: input.p11_validation_records_ref,
        p11_gate_ref: input.p11_gate_ref,
        admission_ref: input.admission_ref,
        replay_evidence_ref: input.replay_evidence_ref,
        verifier_verdicts_ref: input.verifier_verdicts_ref,
        release_authority_ref: input.release_authority_ref,
        release_approval_ref: input.release_approval_ref,
        obligation_ledger_ref: input.obligation_ledger_ref,
        release_eligible: input.release_eligible,
        campaign_complete: input.campaign_complete,
        publication_authorized: false as const,
        publication_performed: false as const,
        missing_downstream_artifacts: scaP12MissingDownstreamArtifacts(),
        required_downstream_obligation_ids: scaP12DownstreamObligationIds(),
        blocker_codes: [...input.blocker_codes],
      },
      "release_record_sha256"
    )
  );
}

export interface ScaP12GateFactsV1 {
  readonly immutable_p11_lineage_valid: boolean;
  readonly verifier_independent_and_subset_authority: boolean;
  readonly deterministic_replay_passed: boolean;
  readonly spot_check_passed: boolean;
  readonly verifier_verdicts_supported: boolean;
  readonly no_unresolved_required_item: boolean;
  readonly phase_gate_index_complete: boolean;
  readonly obligation_ledger_complete: boolean;
  readonly accepted_set_projection_consistent: boolean;
  readonly artifact_identity_valid: boolean;
  readonly latest_revision_only: boolean;
  readonly human_release_authority_valid: boolean;
  readonly release_record_binding_valid: boolean;
  readonly publication_not_claimed: boolean;
  readonly p12_release_authority_respected: boolean;
}

export const SCA_P12_GATE_PREDICATE_KEYS = Object.freeze([
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
] as const satisfies readonly (keyof ScaP12GateFactsV1)[]);

export function scaP12AllGateFactsTrue(facts: ScaP12GateFactsV1): boolean {
  return SCA_P12_GATE_PREDICATE_KEYS.every((key) => facts[key]);
}

export function buildScaP12GateV1(input: {
  readonly report_ref: ArtifactRef | null;
  readonly release_record_ref: ArtifactRef | null;
  readonly lane: ScaP12LaneV1 | undefined;
  readonly facts: ScaP12GateFactsV1;
  readonly blocker_codes: readonly string[];
  readonly finding_count: number;
  readonly record_count: number;
  readonly evaluated_at: string;
}): ScaP12GateV1 {
  const allTrue = scaP12AllGateFactsTrue(input.facts);
  const blockers = [...new Set(input.blocker_codes)].sort();
  const verdict: ScaP12GateV1["verdict"] =
    input.lane === undefined
      ? "blocked_invalid"
      : allTrue && blockers.length === 0
        ? "pass_ready"
        : "pass_blocked";
  return validateScaP12GateV1(
    withP12Digest(
      {
        schema_id: SCA_P12_GATE_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        criterion_id: "AC-P12" as const,
        verdict,
        report_ref: input.report_ref,
        release_record_ref: input.release_record_ref,
        ...(input.lane === undefined ? {} : { lane: input.lane }),
        immutable_p11_lineage_valid: input.facts.immutable_p11_lineage_valid,
        verifier_independent_and_subset_authority:
          input.facts.verifier_independent_and_subset_authority,
        deterministic_replay_passed: input.facts.deterministic_replay_passed,
        spot_check_passed: input.facts.spot_check_passed,
        verifier_verdicts_supported: input.facts.verifier_verdicts_supported,
        no_unresolved_required_item: input.facts.no_unresolved_required_item,
        phase_gate_index_complete: input.facts.phase_gate_index_complete,
        obligation_ledger_complete: input.facts.obligation_ledger_complete,
        accepted_set_projection_consistent: input.facts.accepted_set_projection_consistent,
        artifact_identity_valid: input.facts.artifact_identity_valid,
        latest_revision_only: input.facts.latest_revision_only,
        human_release_authority_valid: input.facts.human_release_authority_valid,
        release_record_binding_valid: input.facts.release_record_binding_valid,
        publication_not_claimed: input.facts.publication_not_claimed,
        p12_release_authority_respected: input.facts.p12_release_authority_respected,
        finding_count: input.finding_count,
        record_count: input.record_count,
        blocker_codes: blockers,
        evaluated_at: input.evaluated_at,
      },
      "gate_sha256"
    )
  );
}

export function buildScaP12TerminalV1(input: {
  readonly status: ScaP12TerminalStatusV1;
  readonly lane?: ScaP12LaneV1 | undefined;
  readonly release_record_ref: ArtifactRef | null;
  readonly gate_ref: ArtifactRef | null;
  readonly release_approval_ref: ArtifactRef | null;
  readonly p11_terminal_ref: ArtifactRef | null;
  readonly report_ref: ArtifactRef | null;
  readonly campaign_complete: boolean;
  readonly release_eligible: boolean;
  readonly incomplete_marker: string | null;
  readonly selected_artifact_refs: readonly ArtifactRef[];
  readonly blocker_codes: readonly string[];
}): ScaP12TerminalV1 {
  return validateScaP12TerminalV1(
    withP12Digest(
      {
        schema_id: SCA_P12_TERMINAL_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        status: input.status,
        ...(input.lane === undefined ? {} : { lane: input.lane }),
        release_record_ref: input.release_record_ref,
        gate_ref: input.gate_ref,
        release_approval_ref: input.release_approval_ref,
        p11_terminal_ref: input.p11_terminal_ref,
        report_ref: input.report_ref,
        campaign_complete: input.campaign_complete,
        release_eligible: input.release_eligible,
        publication_authorized: false as const,
        publication_performed: false as const,
        incomplete_marker: input.incomplete_marker,
        missing_downstream_artifacts: scaP12MissingDownstreamArtifacts(),
        required_downstream_obligation_ids: scaP12DownstreamObligationIds(),
        selected_artifact_refs: input.selected_artifact_refs.slice(0, 128),
        blocker_codes: [...new Set(input.blocker_codes)].sort(),
      },
      "terminal_sha256"
    )
  );
}

/** The exact `⚠ INCOMPLETE — missing: …` marker required by report standard §11 (P12-R23). */
export function scaP12IncompleteMarker(items: readonly string[]): string {
  const missing = [...new Set(items)].sort();
  return `⚠ INCOMPLETE — missing: ${missing.length === 0 ? "(unspecified)" : missing.join(", ")}`;
}

// A local schema for the closed human resume payload (A4). Kept private to the release module so the
// playbook can validate the human gate response before sealing the approval.
export const SCA_P12_RESUME_PAYLOAD_SCHEMA = "penny.sca-p12-release-resume.v1" as const;
export const ScaP12ResumePayloadV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    action: Type.Literal("release_decision"),
    run_id: OpaqueIdSchema,
    decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
    human_principal_id: OpaqueIdSchema,
    authority_receipt_sha256: Sha256Schema,
    decided_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false, $id: SCA_P12_RESUME_PAYLOAD_SCHEMA }
);
export type ScaP12ResumePayloadV1 = Readonly<Static<typeof ScaP12ResumePayloadV1Schema>>;

export function validateScaP12ResumePayloadV1(value: unknown): ScaP12ResumePayloadV1 {
  return validateContract(ScaP12ResumePayloadV1Schema, value, "SCA P12 release resume payload");
}
