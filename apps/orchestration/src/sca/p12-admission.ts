import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { type ArtifactRef } from "../contracts.js";
import type { ScaP07CurrentAuthorityScopeV1 } from "./p07-admission.js";
import type { ScaP09CurrentObligationHeadScopeV1 } from "./p09-admission.js";
import { admitScaP11Reporting, type ScaP11AdmissionResultV1 } from "./p11-admission.js";
import {
  SCA_P11_ADMISSION_SCHEMA,
  validateScaP11AdmissionV1,
  validateScaP11ChecksumManifestV1,
  validateScaP11GateV1,
  validateScaP11ObligationLedgerV1,
  validateScaP11ReconciliationV1,
  validateScaP11ReportV1,
  validateScaP11TerminalV1,
  validateScaP11ToP12TransitionV1,
  validateScaP11ValidationRecordsV1,
  type ScaP11ChecksumManifestV1,
  type ScaP11GateV1,
  type ScaP11ObligationLedgerV1,
  type ScaP11ReconciliationV1,
  type ScaP11ReportV1,
  type ScaP11TerminalV1,
  type ScaP11ToP12TransitionV1,
  type ScaP11ValidationRecordsV1,
} from "./p11-contracts.js";
import {
  SCA_P12_ADMISSION_SCHEMA,
  validateScaP12AdmissionV1,
  validateScaP12ReassessmentV1,
  validateScaP12ReleaseRecordV1,
  withP12Digest,
  type ScaP12AdmissionV1,
  type ScaP12LaneV1,
} from "./p12-contracts.js";

/**
 * P12 exact admission input. Every ref is caller/host-supplied at invocation; nothing is assumed
 * about where content lives. The P11 re-derivation inputs mirror the P11 candidate-start lineage so
 * that P12 re-derives rather than trusts any stored PASS label.
 */
export interface ScaP12AdmissionInputV1 {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly p11_terminal_ref: ArtifactRef;
  readonly p11_transition_ref: ArtifactRef | null;
  /** The exact recorded `penny.sca-p11-admission.v1`; required for reportable lanes (P12-R03). */
  readonly p11_admission_ref: ArtifactRef | null;
  readonly verification_scope_ref: ArtifactRef;
  readonly verifier_authority_ref: ArtifactRef;
  readonly release_authority_ref: ArtifactRef;
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
  /** Optional prior-release/reassessment refs consumed read-only for append-only re-verification. */
  readonly p12_reassessment_ref?: ArtifactRef | null;
  readonly p12_prior_release_ref?: ArtifactRef | null;
}

export interface ScaP12AdmissionResultV1 {
  readonly admission: ScaP12AdmissionV1;
  readonly reportable: boolean;
  readonly lane: ScaP12LaneV1 | null;
  readonly non_reportable_reason: string | null;
  readonly p11_terminal_ref: ArtifactRef;
  readonly p11_terminal: ScaP11TerminalV1;
  readonly p11_transition: ScaP11ToP12TransitionV1 | null;
  /** The re-derived P11 reporting admission through the shared path; never a second engine. */
  readonly rederived: ScaP11AdmissionResultV1 | null;
  readonly report: ScaP11ReportV1 | null;
  readonly reconciliation: ScaP11ReconciliationV1 | null;
  readonly validation: ScaP11ValidationRecordsV1 | null;
  readonly p11_gate: ScaP11GateV1 | null;
  readonly checksum: ScaP11ChecksumManifestV1 | null;
  readonly obligation_ledger: ScaP11ObligationLedgerV1 | null;
  readonly report_status: "complete" | "incomplete" | null;
  readonly no_unresolved_required_item: boolean;
  readonly evidence_refs: readonly ArtifactRef[];
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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
    throw new Error(`P12 ${kind} exact ref absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P12 ${kind} exact bytes drifted`);
  }
  const text = bytes.toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error(`P12 ${kind} noncanonical bytes`);
  return validate(parsed);
}

/**
 * Exact P11→P12 lineage admission. P12 re-derives the recorded P11 reporting admission through the
 * shared `admitScaP11Reporting` path (which transitively re-derives P10/P09/P08) and binds the exact
 * recorded P11 report set. A wrong-kind terminal, a non-authorizing-handoff violation, an absent
 * record, cross-run, digest-drifted, non-canonical, or re-derivation-mismatched input fails closed
 * with no release output.
 */
export function admitScaP12Release(input: ScaP12AdmissionInputV1): ScaP12AdmissionResultV1 {
  const { store } = input;
  const evidenceRefs: ArtifactRef[] = [input.p11_terminal_ref];

  const terminal = exact(
    store,
    input.p11_terminal_ref,
    "sca-p11-terminal",
    validateScaP11TerminalV1
  );

  // A reassessment or prior release is consumed read-only; it invalidates any prior release
  // approval and forces a fresh verification against the exact latest revision (P12-R18).
  if (input.p12_reassessment_ref !== undefined && input.p12_reassessment_ref !== null) {
    const reassessment = exact(
      store,
      input.p12_reassessment_ref,
      "sca-p12-reassessment",
      validateScaP12ReassessmentV1
    );
    if (!reassessment.append_only || !reassessment.invalidates_release_approval) {
      throw new Error("P12 reassessment must remain append-only and invalidate prior approvals");
    }
    evidenceRefs.push(input.p12_reassessment_ref);
  }
  if (input.p12_prior_release_ref !== undefined && input.p12_prior_release_ref !== null) {
    exact(
      store,
      input.p12_prior_release_ref,
      "sca-p12-release-record",
      validateScaP12ReleaseRecordV1
    );
    evidenceRefs.push(input.p12_prior_release_ref);
  }

  const reportableTerminal =
    terminal.status === "reporting_complete" || terminal.status === "reporting_incomplete";

  const admissionFor = (fields: {
    readonly lane?: ScaP12LaneV1;
    readonly reportable: boolean;
    readonly nonReportableReason: string | null;
    readonly rederivationOk: boolean;
    readonly handoffOk: boolean;
    readonly reportRef: ArtifactRef | null;
    readonly reportStatus: "complete" | "incomplete" | null;
    readonly noUnresolved: boolean;
    readonly recordCount: number;
    readonly findingCount: number;
  }): ScaP12AdmissionV1 =>
    validateScaP12AdmissionV1(
      withP12Digest(
        {
          schema_id: SCA_P12_ADMISSION_SCHEMA,
          schema_version: 1 as const,
          phase_id: "SCA-P12" as const,
          run_id: input.run_id,
          p11_terminal_ref: input.p11_terminal_ref,
          p11_transition_ref: input.p11_transition_ref,
          p11_admission_ref: input.p11_admission_ref,
          p11_report_ref: fields.reportRef,
          verification_scope_ref: input.verification_scope_ref,
          verifier_authority_ref: input.verifier_authority_ref,
          release_authority_ref: input.release_authority_ref,
          ...(fields.lane === undefined ? {} : { lane: fields.lane }),
          reportable: fields.reportable,
          non_reportable_reason: fields.nonReportableReason,
          p11_rederivation_ok: fields.rederivationOk,
          p11_handoff_agreement_ok: fields.handoffOk,
          report_status: fields.reportStatus,
          no_unresolved_required_item: fields.noUnresolved,
          record_count: fields.recordCount,
          finding_count: fields.findingCount,
        },
        "admission_sha256"
      )
    );

  if (!reportableTerminal) {
    const reason = `p11_${terminal.status}_non_reportable`;
    const admission = admissionFor({
      reportable: false,
      nonReportableReason: reason,
      rederivationOk: false,
      handoffOk: false,
      reportRef: null,
      reportStatus: null,
      noUnresolved: false,
      recordCount: 0,
      findingCount: 0,
    });
    return {
      admission,
      reportable: false,
      lane: null,
      non_reportable_reason: reason,
      p11_terminal_ref: input.p11_terminal_ref,
      p11_terminal: terminal,
      p11_transition: null,
      rederived: null,
      report: null,
      reconciliation: null,
      validation: null,
      p11_gate: null,
      checksum: null,
      obligation_ledger: null,
      report_status: null,
      no_unresolved_required_item: false,
      evidence_refs: uniqueRefs([
        input.p11_terminal_ref,
        input.verification_scope_ref,
        input.verifier_authority_ref,
        input.release_authority_ref,
      ]),
    };
  }

  if (input.p11_transition_ref === null) {
    throw new Error("P12 reportable lane requires the recorded P11 report handoff");
  }
  if (input.p11_admission_ref === null) {
    throw new Error("P12 reportable lane requires the recorded P11 admission");
  }
  const transition = exact(
    store,
    input.p11_transition_ref,
    "sca-p11-to-p12-transition",
    validateScaP11ToP12TransitionV1
  );
  evidenceRefs.push(input.p11_transition_ref);

  // The P11 handoff must be the explicit non-authorizing reporting handoff (P12-R01).
  if (
    transition.handoff_kind !== "accepted_report_evidence_only" ||
    transition.qualification_scope !== "reporting_gate_only_not_p12_release" ||
    transition.phase_gate_passed !== false ||
    transition.p12_release_authorized_by_this_transition !== false ||
    transition.release_eligible !== false ||
    transition.campaign_complete !== false ||
    transition.campaign_completion_claimed !== false ||
    transition.required_gaps_retained !== true
  ) {
    throw new Error("P12 P11 handoff is not the explicit non-authorizing reporting handoff");
  }

  // A reportable lane must be admitted against the complete recorded P11 record set (P12-R04).
  const reportRef = terminal.report_ref;
  const reconciliationRef = terminal.reconciliation_ref;
  const validationRef = terminal.validation_records_ref;
  const gateRef = terminal.gate_ref;
  if (
    reportRef === null ||
    reconciliationRef === null ||
    validationRef === null ||
    gateRef === null
  ) {
    throw new Error("P12 reportable lane requires the complete recorded P11 report set");
  }
  for (const ref of [
    input.p11_terminal_ref,
    input.p11_transition_ref,
    input.p11_admission_ref,
    reportRef,
    reconciliationRef,
    validationRef,
    gateRef,
    transition.obligation_ledger_ref,
    transition.checksum_manifest_ref,
    input.verification_scope_ref,
    input.verifier_authority_ref,
    input.release_authority_ref,
    input.p01_obligation_ledger_ref,
  ]) {
    if (ref.run_id !== input.run_id) throw new Error("P12 cross-run lineage ref");
  }

  const report = exact(store, reportRef, "sca-p11-report", validateScaP11ReportV1);
  const reconciliation = exact(
    store,
    reconciliationRef,
    "sca-p11-reconciliation",
    validateScaP11ReconciliationV1
  );
  const validation = exact(
    store,
    validationRef,
    "sca-p11-validation-records",
    validateScaP11ValidationRecordsV1
  );
  const p11Gate = exact(store, gateRef, "sca-p11-gate", validateScaP11GateV1);
  const checksum = exact(
    store,
    transition.checksum_manifest_ref,
    "sca-p11-checksum-manifest",
    validateScaP11ChecksumManifestV1
  );
  const obligationLedger = exact(
    store,
    transition.obligation_ledger_ref,
    "sca-p11-obligation-ledger",
    validateScaP11ObligationLedgerV1
  );
  evidenceRefs.push(
    reportRef,
    reconciliationRef,
    validationRef,
    gateRef,
    transition.checksum_manifest_ref,
    transition.obligation_ledger_ref
  );

  // Recorded-ref agreement: the handoff and terminal must bind the same P11 artifacts.
  for (const [label, left, right] of [
    ["report", transition.report_ref, reportRef],
    ["reconciliation", transition.reconciliation_ref, reconciliationRef],
    ["validation records", transition.validation_records_ref, validationRef],
    ["gate", transition.gate_ref, gateRef],
    ["checksum manifest", transition.checksum_manifest_ref, report.checksum_manifest_ref],
    ["obligation ledger", transition.obligation_ledger_ref, report.obligation_ledger_ref],
  ] as const) {
    if (!same(left, right)) throw new Error(`P12 P11 handoff ${label} binding mismatch`);
  }
  if (transition.lane !== report.lane) {
    throw new Error("P12 P11 handoff lane disagrees with the recorded report lane");
  }
  if (terminal.lane !== undefined && terminal.lane !== report.lane) {
    throw new Error("P12 P11 terminal lane disagrees with the recorded report lane");
  }
  const reportableLane: ScaP12LaneV1 = report.lane;
  if (
    terminal.status === "reporting_complete"
      ? report.status !== "complete"
      : report.status !== "incomplete"
  ) {
    throw new Error("P12 P11 terminal status disagrees with the recorded report status");
  }
  if (
    (report.status === "complete" && p11Gate.verdict !== "pass_ready") ||
    (report.status === "incomplete" && p11Gate.verdict === "pass_ready")
  ) {
    throw new Error("P12 P11 report status disagrees with its gate verdict");
  }
  if (!same(validation.report_json_ref, report.json_ref)) {
    throw new Error("P12 recorded P11 validation records are bound to another report JSON");
  }

  // Re-derive the recorded P11 reporting admission through the shared path (P12-R03).
  const rederived = admitScaP11Reporting({
    store,
    run_id: input.run_id,
    p10_terminal_ref: input.p10_terminal_ref,
    p10_transition_ref: input.p10_transition_ref,
    p10_outcome_ref: input.p10_outcome_ref,
    p10_gate_ref: input.p10_gate_ref,
    p10_admission_ref: input.p10_admission_ref,
    p10_eligibility_ledger_ref: input.p10_eligibility_ledger_ref,
    p10_candidate_registry_ref: input.p10_candidate_registry_ref,
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
    p10_disclosure_scope_ref: input.p10_disclosure_scope_ref,
    promotion_authority_ref: input.promotion_authority_ref,
    active_run_rule_release_refs: input.active_run_rule_release_refs,
    p10_reassessment_ref: input.p10_reassessment_ref,
    p10_prior_ledger_ref: input.p10_prior_ledger_ref,
    p11_disclosure_scope_ref: input.p11_disclosure_scope_ref,
    p11_repair_disclosure_scope_ref: input.p11_repair_disclosure_scope_ref,
    scoring_policy_ref: input.scoring_policy_ref,
    report_policy_ref: input.report_policy_ref,
    ...(input.resolve_current_p07_authority_ref === undefined
      ? {}
      : { resolve_current_p07_authority_ref: input.resolve_current_p07_authority_ref }),
    ...(input.resolve_current_p01_obligation_head_ref === undefined
      ? {}
      : { resolve_current_p01_obligation_head_ref: input.resolve_current_p01_obligation_head_ref }),
  });
  if (!rederived.reportable || rederived.lane === null) {
    throw new Error("P12 reportable lane re-derived a non-reportable P11 admission");
  }
  if (rederived.lane !== reportableLane) {
    throw new Error("P12 reportable lane disagrees with the re-derived P11 lane");
  }
  if (rederived.admission.schema_id !== SCA_P11_ADMISSION_SCHEMA) {
    throw new Error("P12 re-derived P11 admission has an unexpected schema");
  }
  // Deep equality against the exact recorded P11 admission (P12-R03). A shallow lane/schema check is
  // not sufficient: the recorded admission must equal the fully re-derived shared-path admission.
  const recordedAdmission = exact(
    store,
    input.p11_admission_ref,
    "sca-p11-admission",
    validateScaP11AdmissionV1
  );
  if (!same(rederived.admission, recordedAdmission)) {
    throw new Error("P12 re-derived P11 admission disagrees with the recorded P11 admission");
  }
  evidenceRefs.push(input.p11_admission_ref);
  for (const ref of rederived.evidence_refs) evidenceRefs.push(ref);

  const noUnresolved =
    terminal.status === "reporting_complete" &&
    report.status === "complete" &&
    validation.incomplete === false &&
    reconciliation.unresolved_count === 0;
  const recordCount = reconciliation.record_count;
  const findingCount = reconciliation.reportable_count;

  const admission = admissionFor({
    lane: reportableLane,
    reportable: true,
    nonReportableReason: null,
    rederivationOk: true,
    handoffOk: true,
    reportRef,
    reportStatus: report.status,
    noUnresolved,
    recordCount,
    findingCount,
  });

  return {
    admission,
    reportable: true,
    lane: reportableLane,
    non_reportable_reason: null,
    p11_terminal_ref: input.p11_terminal_ref,
    p11_terminal: terminal,
    p11_transition: transition,
    rederived,
    report,
    reconciliation,
    validation,
    p11_gate: p11Gate,
    checksum,
    obligation_ledger: obligationLedger,
    report_status: report.status,
    no_unresolved_required_item: noUnresolved,
    evidence_refs: uniqueRefs(evidenceRefs),
  };
}
