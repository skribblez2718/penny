import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { type ArtifactRef } from "../contracts.js";
import type { ScaP07CurrentAuthorityScopeV1 } from "./p07-admission.js";
import type { ScaP09CurrentObligationHeadScopeV1 } from "./p09-admission.js";
import type { ScaP09LedgerItemV1, ScaP09ReconciliationLedgerV1 } from "./p09-contracts.js";
import { admitScaP10Learning, type ScaP10AdmissionResultV1 } from "./p10-admission.js";
import {
  SCA_P11_ADMISSION_SCHEMA,
  validateScaP11AdmissionV1,
  withP11Digest,
  type ScaP11AdmissionV1,
  type ScaP11LaneV1,
} from "./p11-contracts.js";
import {
  validateScaP10AdmissionV1,
  validateScaP10EligibilityLedgerV1,
  validateScaP10GateV1,
  validateScaP10RuleCandidateRegistryV1,
  validateScaP10RuleLearningOutcomeV1,
  validateScaP10TerminalV1,
  validateScaP10ToP11TransitionV1,
  type ScaP10EligibilityLedgerV1,
  type ScaP10GateV1,
  type ScaP10RuleCandidateRegistryV1,
  type ScaP10RuleLearningOutcomeV1,
  type ScaP10TerminalV1,
  type ScaP10ToP11TransitionV1,
} from "./p10-contracts.js";

export interface ScaP11AdmissionInputV1 {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly p10_terminal_ref: ArtifactRef;
  readonly p10_transition_ref: ArtifactRef | null;
  readonly p10_outcome_ref: ArtifactRef | null;
  readonly p10_gate_ref: ArtifactRef | null;
  readonly p10_admission_ref: ArtifactRef | null;
  readonly p10_eligibility_ledger_ref: ArtifactRef | null;
  readonly p10_candidate_registry_ref: ArtifactRef | null;
  readonly p09_terminal_ref: ArtifactRef;
  readonly p09_transition_ref: ArtifactRef | null;
  readonly p09_reconciliation_ledger_ref: ArtifactRef | null;
  readonly p09_gate_ref: ArtifactRef | null;
  readonly p09_admission_ref: ArtifactRef | null;
  readonly p08_terminal_ref: ArtifactRef;
  readonly p08_transition_ref: ArtifactRef | null;
  readonly p08_evidence_ledger_ref: ArtifactRef | null;
  readonly p08_gate_ref: ArtifactRef | null;
  readonly p08_admission_ref: ArtifactRef | null;
  readonly p08_item_universe_ref: ArtifactRef | null;
  readonly p01_obligation_ledger_ref: ArtifactRef;
  readonly baseline_evidence_ref: ArtifactRef;
  readonly p10_disclosure_scope_ref: ArtifactRef;
  readonly promotion_authority_ref: ArtifactRef;
  readonly active_run_rule_release_refs: readonly ArtifactRef[];
  readonly p09_coverage_input_ref: ArtifactRef | null;
  readonly p09_phase_evidence_refs: readonly ArtifactRef[];
  readonly p09_obligation_resolution_ref: ArtifactRef | null;
  readonly p09_reassessment_ref: ArtifactRef | null;
  readonly p10_reassessment_ref: ArtifactRef | null;
  readonly p10_prior_ledger_ref: ArtifactRef | null;
  readonly p11_disclosure_scope_ref: ArtifactRef;
  readonly p11_repair_disclosure_scope_ref: ArtifactRef | null;
  readonly scoring_policy_ref: ArtifactRef;
  readonly report_policy_ref: ArtifactRef;
  readonly resolve_current_p07_authority_ref?: (
    scope: ScaP07CurrentAuthorityScopeV1
  ) => ArtifactRef;
  readonly resolve_current_p01_obligation_head_ref?: (
    scope: ScaP09CurrentObligationHeadScopeV1
  ) => ArtifactRef;
}

export interface ScaP11AdmissionResultV1 {
  readonly admission: ScaP11AdmissionV1;
  readonly reportable: boolean;
  readonly lane: ScaP11LaneV1 | null;
  readonly non_reportable_reason: string | null;
  readonly p10_terminal: ScaP10TerminalV1;
  readonly p10_transition: ScaP10ToP11TransitionV1 | null;
  readonly p10_outcome: ScaP10RuleLearningOutcomeV1 | null;
  readonly p10_gate: ScaP10GateV1 | null;
  readonly p10_eligibility: ScaP10EligibilityLedgerV1 | null;
  readonly p10_registry: ScaP10RuleCandidateRegistryV1 | null;
  /** The re-derived P10 admission result (shared path; never a second engine). */
  readonly rederived: ScaP10AdmissionResultV1 | null;
  /** The re-derived P09 reconciliation ledger, the P11 record universe anchor. */
  readonly p09_ledger: ScaP09ReconciliationLedgerV1 | null;
  readonly p09_items: readonly ScaP09LedgerItemV1[];
  readonly eligible_refs: readonly ArtifactRef[];
  readonly ineligible_refs: readonly ArtifactRef[];
  readonly unresolved_item_refs: readonly ArtifactRef[];
  readonly evidence_refs: readonly ArtifactRef[];
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function requireSame(left: unknown, right: unknown, label: string): void {
  if (!same(left, right)) throw new Error(`P11 ${label} exact binding mismatch`);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function exact<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  kind: string,
  validate: (value: unknown) => T
): T {
  if (ref.kind !== kind || !same(store.refById(ref.artifact_id), ref)) {
    throw new Error(`P11 ${kind} exact ref absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P11 ${kind} exact bytes drifted`);
  }
  const text = bytes.toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error(`P11 ${kind} noncanonical bytes`);
  return validate(parsed);
}

/**
 * Exact P10→P11 lineage admission. P11 re-derives the recorded P10 admission and eligibility
 * through the shared `admitScaP10Learning` path (which transitively re-derives P09 and walks the
 * append-only prior chains) and requires deep equality with the recorded artifacts. A wrong-kind
 * (for example a P08 disposition handoff supplied as the P10 terminal), handoff-absent, cross-run,
 * digest-drifted, non-canonical, or re-derivation-mismatched input fails closed with no report
 * output.
 */
export function admitScaP11Reporting(input: ScaP11AdmissionInputV1): ScaP11AdmissionResultV1 {
  const { store } = input;
  const evidenceRefs: ArtifactRef[] = [input.p10_terminal_ref];
  const terminal = exact(
    store,
    input.p10_terminal_ref,
    "sca-p10-terminal",
    validateScaP10TerminalV1
  );

  const reportableLane: ScaP11LaneV1 | null =
    terminal.status === "learning_complete"
      ? "accepted_progression"
      : terminal.status === "learning_incomplete"
        ? "incomplete_closeout"
        : null;

  const admissionFor = (fields: {
    readonly lane?: ScaP11LaneV1;
    readonly reportable: boolean;
    readonly nonReportableReason: string | null;
    readonly rederivationOk: boolean;
    readonly handoffOk: boolean;
    readonly itemCount: number;
    readonly candidateCount: number;
  }): ScaP11AdmissionV1 =>
    validateScaP11AdmissionV1(
      withP11Digest(
        {
          schema_id: SCA_P11_ADMISSION_SCHEMA,
          schema_version: 1 as const,
          phase_id: "SCA-P11" as const,
          run_id: input.run_id,
          p10_terminal_ref: input.p10_terminal_ref,
          p10_transition_ref: input.p10_transition_ref,
          p09_reconciliation_ledger_ref: input.p09_reconciliation_ledger_ref,
          p10_outcome_ref: input.p10_outcome_ref,
          p11_disclosure_scope_ref: input.p11_disclosure_scope_ref,
          p11_repair_disclosure_scope_ref: input.p11_repair_disclosure_scope_ref,
          scoring_policy_ref: input.scoring_policy_ref,
          report_policy_ref: input.report_policy_ref,
          ...(fields.lane === undefined ? {} : { lane: fields.lane }),
          reportable: fields.reportable,
          non_reportable_reason: fields.nonReportableReason,
          p10_rederivation_ok: fields.rederivationOk,
          p10_handoff_agreement_ok: fields.handoffOk,
          item_count: fields.itemCount,
          candidate_count: fields.candidateCount,
        },
        "admission_sha256"
      )
    );

  if (reportableLane === null) {
    const reason =
      input.p10_transition_ref === null
        ? `p10_${terminal.status}_non_reportable_checkpoint`
        : `p10_${terminal.status}_not_reportable`;
    const admission = admissionFor({
      reportable: false,
      nonReportableReason: reason,
      rederivationOk: false,
      handoffOk: false,
      itemCount: 0,
      candidateCount: 0,
    });
    return {
      admission,
      reportable: false,
      lane: null,
      non_reportable_reason: reason,
      p10_terminal: terminal,
      p10_transition: null,
      p10_outcome: null,
      p10_gate: null,
      p10_eligibility: null,
      p10_registry: null,
      rederived: null,
      p09_ledger: null,
      p09_items: [],
      eligible_refs: [],
      ineligible_refs: [],
      unresolved_item_refs: [],
      evidence_refs: uniqueRefs([input.p10_terminal_ref, input.p11_disclosure_scope_ref]),
    };
  }

  if (input.p10_transition_ref === null) {
    throw new Error("P11 reportable lane requires the recorded P10 handoff");
  }
  const transition = exact(
    store,
    input.p10_transition_ref,
    "sca-p10-to-p11-transition",
    validateScaP10ToP11TransitionV1
  );
  evidenceRefs.push(input.p10_transition_ref);

  // The P10 handoff must be the explicit non-authorizing handoff.
  if (
    transition.handoff_kind !== "eligible_only_learning_evidence_only" ||
    transition.qualification_scope !== "learning_gate_only_not_p11_reporting" ||
    transition.phase_gate_passed !== false ||
    transition.p11_reporting_authorized_by_this_transition !== false ||
    transition.release_eligible !== false ||
    transition.campaign_complete !== false ||
    transition.campaign_completion_claimed !== false ||
    transition.required_gaps_retained !== true
  ) {
    throw new Error("P11 P10 handoff is not the explicit non-authorizing reporting handoff");
  }
  for (const ref of [
    input.p10_terminal_ref,
    input.p10_transition_ref,
    input.p09_terminal_ref,
    input.p08_terminal_ref,
    input.p01_obligation_ledger_ref,
    input.p11_disclosure_scope_ref,
    input.scoring_policy_ref,
    input.report_policy_ref,
  ]) {
    if (ref.run_id !== input.run_id) throw new Error("P11 cross-run lineage ref");
  }

  // A reportable lane must be admitted against the complete recorded P10 record set (§4.1). The
  // deep-equality bind below is only meaningful when every recorded record is present, so an
  // absent outcome, gate, admission, or eligibility ledger fails closed before any re-derivation.
  for (const [label, ref] of [
    ["P10 rule-learning outcome", input.p10_outcome_ref],
    ["P10 gate", input.p10_gate_ref],
    ["P10 admission", input.p10_admission_ref],
    ["P10 eligibility ledger", input.p10_eligibility_ledger_ref],
  ] as const) {
    if (ref === null) throw new Error(`P11 reportable lane requires the recorded ${label}`);
  }

  // Re-derive the recorded P10 learning admission through the shared path.
  const rederived = admitScaP10Learning({
    store,
    run_id: input.run_id,
    p09_terminal_ref: input.p09_terminal_ref,
    p09_transition_ref: input.p09_transition_ref,
    p09_reconciliation_ledger_ref: input.p09_reconciliation_ledger_ref,
    p09_gate_ref: input.p09_gate_ref,
    p09_admission_ref: input.p09_admission_ref,
    p08_terminal_ref: input.p08_terminal_ref,
    p08_transition_ref: input.p08_transition_ref,
    p08_evidence_ledger_ref: input.p08_evidence_ledger_ref,
    p08_gate_ref: input.p08_gate_ref,
    p08_admission_ref: input.p08_admission_ref,
    p08_item_universe_ref: input.p08_item_universe_ref,
    p01_obligation_ledger_ref: input.p01_obligation_ledger_ref,
    p09_coverage_input_ref: input.p09_coverage_input_ref,
    p09_phase_evidence_refs: input.p09_phase_evidence_refs,
    p09_obligation_resolution_ref: input.p09_obligation_resolution_ref,
    p09_reassessment_ref: input.p09_reassessment_ref,
    baseline_evidence_ref: input.baseline_evidence_ref,
    disclosure_scope_ref: input.p10_disclosure_scope_ref,
    promotion_authority_ref: input.promotion_authority_ref,
    active_run_rule_release_refs: input.active_run_rule_release_refs,
    p10_reassessment_ref: input.p10_reassessment_ref,
    p10_prior_eligibility_ledger_ref: input.p10_prior_ledger_ref,
    ...(input.resolve_current_p07_authority_ref === undefined
      ? {}
      : { resolve_current_p07_authority_ref: input.resolve_current_p07_authority_ref }),
    ...(input.resolve_current_p01_obligation_head_ref === undefined
      ? {}
      : { resolve_current_p01_obligation_head_ref: input.resolve_current_p01_obligation_head_ref }),
  });
  if (rederived.non_learnable || rederived.lane === null) {
    throw new Error("P11 reportable lane re-derived a non-learnable P10 admission");
  }
  if (rederived.lane !== reportableLane) {
    throw new Error("P11 reportable lane disagrees with the re-derived P10 lane");
  }
  for (const ref of rederived.evidence_refs) evidenceRefs.push(ref);

  // Bind the recorded P10 admission and eligibility exactly where supplied.
  if (input.p10_admission_ref !== null) {
    const recorded = exact(
      store,
      input.p10_admission_ref,
      "sca-p10-admission",
      validateScaP10AdmissionV1
    );
    requireSame(rederived.admission, recorded, "re-derived P10 admission");
    evidenceRefs.push(input.p10_admission_ref);
  }
  if (input.p10_eligibility_ledger_ref !== null) {
    if (rederived.eligibility === null) {
      throw new Error("P11 re-derivation produced no P10 eligibility ledger");
    }
    const recorded = exact(
      store,
      input.p10_eligibility_ledger_ref,
      "sca-p10-eligibility-ledger",
      validateScaP10EligibilityLedgerV1
    );
    requireSame(rederived.eligibility, recorded, "re-derived P10 eligibility ledger");
    requireSame(
      recorded.p09_reconciliation_ledger_ref,
      input.p09_reconciliation_ledger_ref,
      "P10 eligibility ledger P09 ledger"
    );
    evidenceRefs.push(input.p10_eligibility_ledger_ref);
  }

  const outcome =
    input.p10_outcome_ref === null
      ? null
      : exact(
          store,
          input.p10_outcome_ref,
          "sca-p10-rule-learning-outcome",
          validateScaP10RuleLearningOutcomeV1
        );
  if (input.p10_outcome_ref !== null) evidenceRefs.push(input.p10_outcome_ref);
  const gate =
    input.p10_gate_ref === null
      ? null
      : exact(store, input.p10_gate_ref, "sca-p10-gate", validateScaP10GateV1);
  if (input.p10_gate_ref !== null) evidenceRefs.push(input.p10_gate_ref);
  const registry =
    input.p10_candidate_registry_ref === null
      ? null
      : exact(
          store,
          input.p10_candidate_registry_ref,
          "sca-p10-rule-candidate-registry",
          validateScaP10RuleCandidateRegistryV1
        );
  if (input.p10_candidate_registry_ref !== null)
    evidenceRefs.push(input.p10_candidate_registry_ref);

  // Handoff agreement: lane, refs, sets, and the false literals of the P10 boundary.
  const laneAgreement =
    (terminal.status === "learning_complete" && transition.lane === "accepted_progression") ||
    (terminal.status === "learning_incomplete" && transition.lane === "incomplete_closeout");
  if (!laneAgreement || transition.lane !== reportableLane) {
    throw new Error("P11 P10 terminal status disagrees with its transition lane");
  }
  requireSame(
    transition.learning_outcome_ref,
    terminal.learning_outcome_ref,
    "P10 handoff outcome"
  );
  requireSame(transition.gate_ref, terminal.gate_ref, "P10 handoff gate");
  if (outcome !== null) {
    requireSame(transition.learning_outcome_ref, input.p10_outcome_ref, "P10 handoff outcome ref");
    if (outcome.lane !== reportableLane) {
      throw new Error("P11 P10 outcome lane disagrees with the terminal lane");
    }
  }
  if (gate !== null) {
    const verdictLaneAgreement =
      (terminal.status === "learning_complete" && gate.verdict === "pass_ready") ||
      (terminal.status === "learning_incomplete" && gate.verdict === "pass_blocked");
    if (!verdictLaneAgreement) {
      throw new Error("P11 P10 terminal status disagrees with its gate verdict");
    }
    if (gate.learning_outcome_ref.artifact_id !== transition.learning_outcome_ref.artifact_id) {
      throw new Error("P11 P10 gate outcome binding mismatch");
    }
  }
  requireSame(transition.eligible_refs, rederived.eligible_refs, "P10 handoff eligible refs");
  requireSame(transition.ineligible_refs, rederived.ineligible_refs, "P10 handoff ineligible refs");
  requireSame(
    transition.unresolved_item_refs,
    rederived.unresolved_item_refs,
    "P10 handoff unresolved refs"
  );
  const eligibleIds = new Set(transition.eligible_refs.map((ref) => ref.artifact_id));
  for (const ref of transition.ineligible_refs) {
    if (eligibleIds.has(ref.artifact_id)) {
      throw new Error("P11 P10 handoff makes ineligible evidence eligible");
    }
  }

  const admission = admissionFor({
    lane: reportableLane,
    reportable: true,
    nonReportableReason: null,
    rederivationOk: true,
    handoffOk: true,
    itemCount: rederived.p09_ledger?.items.length ?? 0,
    candidateCount: registry?.candidate_count ?? 0,
  });

  return {
    admission,
    reportable: true,
    lane: reportableLane,
    non_reportable_reason: null,
    p10_terminal: terminal,
    p10_transition: transition,
    p10_outcome: outcome,
    p10_gate: gate,
    p10_eligibility: rederived.eligibility,
    p10_registry: registry,
    rederived,
    p09_ledger: rederived.p09_ledger,
    p09_items: rederived.p09_ledger?.items ?? [],
    eligible_refs: rederived.eligible_refs,
    ineligible_refs: rederived.ineligible_refs,
    unresolved_item_refs: rederived.unresolved_item_refs,
    evidence_refs: uniqueRefs(evidenceRefs),
  };
}
