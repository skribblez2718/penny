import { describe, expect, it } from "vitest";

import type { ArtifactRef } from "../dist/contracts.js";
import {
  SCA_P11_GATE_SCHEMA,
  SCA_P11_TERMINAL_SCHEMA,
  SCA_P11_ADDENDUM_SCHEMA,
  SCA_P11_REQUIRED_OBLIGATION_IDS,
  SCA_P11_SUPPORTED_REPORT_STATUSES,
  SCA_P11_UNSUPPORTED_REPORT_STATUSES,
  scaP11ReportStatusForDisposition,
  scaP11SeverityTokenForScore,
  validateScaP11AcceptedFindingV1,
  validateScaP11AddendumV1,
  validateScaP11GateV1,
  validateScaP11TerminalV1,
  withP11Digest,
} from "../dist/sca/p11-contracts.js";

const REF: ArtifactRef = {
  schema_version: 2,
  artifact_id: `art_${"a".repeat(64)}`,
  run_id: "run",
  phase: "SCA-P11",
  branch_id: null,
  kind: "sca-p11-report",
  operation_id: "op",
  version: 1,
  producer: "host",
  media_type: "application/json",
  byte_length: 2,
  content_digest: "b".repeat(64),
  store_ref: `artifact://sha256/${"b".repeat(64)}`,
};

describe("SCA P11 closed contracts", () => {
  it("maps internal dispositions and scores deterministically", () => {
    expect(scaP11ReportStatusForDisposition("confirmed")).toBe("Confirmed — code verified");
    expect(scaP11ReportStatusForDisposition("rejected-with-evidence")).toBe("False positive");
    expect(scaP11ReportStatusForDisposition("inconclusive")).toBe("Probable");
    expect(scaP11ReportStatusForDisposition("deferred")).toBe("Theoretical");
    expect(scaP11ReportStatusForDisposition("duplicate-of")).toBeNull();
    expect(scaP11ReportStatusForDisposition("out-of-scope")).toBeNull();
    expect(SCA_P11_SUPPORTED_REPORT_STATUSES).toContain("Probable");
    expect(SCA_P11_UNSUPPORTED_REPORT_STATUSES).toContain("Confirmed — PoC verified");
    expect(scaP11SeverityTokenForScore(0)).toBe("None");
    expect(scaP11SeverityTokenForScore(9.3)).toBe("Critical");
    expect(() => scaP11SeverityTokenForScore(11)).toThrow();
  });

  it("omits score, vector, and nomenclature for every non-scored exception shape", () => {
    const base = {
      finding_id: "sca11find_" + "c".repeat(64),
      identity: "p09item_" + "d".repeat(64),
      semantic_only: false,
      title: "Finding",
      severity_token: "Informational" as const,
      cvss_score: null,
      cvss_vector: null,
      base_severity_token: null,
      base_cvss_score: null,
      base_cvss_vector: null,
      nomenclature: null,
      cwe_id: "CWE-79",
      cwe_name: "Improper Neutralization",
      status: null,
      status_note: null,
      threat_model_id: "{T-EXAMPLE}",
      exception_shape: "informational" as const,
      scoring_record_ref: null,
      evidence_refs: [REF],
      source_refs: [REF],
      description: "d",
      steps_to_reproduce: ["1"],
      code_analysis: ["1"],
      remediation: "r",
      complete: true,
      missing_material: [],
    };
    expect(validateScaP11AcceptedFindingV1(base).exception_shape).toBe("informational");
    expect(() => validateScaP11AcceptedFindingV1({ ...base, cvss_score: 7.5 })).toThrow();
    expect(() =>
      validateScaP11AcceptedFindingV1({ ...base, exception_shape: "none_zero", cvss_score: 5 })
    ).toThrow();
    expect(() =>
      validateScaP11AcceptedFindingV1({ ...base, complete: true, missing_material: ["x"] })
    ).toThrow();
  });

  it("keeps the terminal always non-positive", () => {
    const cancelled = withP11Digest(
      {
        schema_id: SCA_P11_TERMINAL_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        status: "cancelled" as const,
        report_ref: null,
        reconciliation_ref: null,
        validation_records_ref: null,
        gate_ref: null,
        p12_transition_ref: null,
        p12_handoff_ready: false,
        report_status: null,
        missing_downstream_artifacts: ["penny.sca-p12-release-record.v1"],
        required_downstream_obligation_ids: ["SCA-OBL-P12-ACCEPTANCE"],
        selected_artifact_refs: [],
        blocker_codes: ["p11_cancelled"],
        phase_gate_passed: false as const,
        release_eligible: false as const,
        campaign_complete: false as const,
        nonterminal_campaign: true as const,
        p12_release_authorized: false as const,
        release_adjudication_performed: false as const,
      },
      "terminal_sha256"
    );
    expect(validateScaP11TerminalV1(cancelled).status).toBe("cancelled");
    expect(() => validateScaP11TerminalV1({ ...cancelled, phase_gate_passed: true })).toThrow();
    expect(() => validateScaP11TerminalV1({ ...cancelled, report_ref: REF })).toThrow();
  });

  it("requires every predicate and an empty blocker list before a pass_ready gate", () => {
    const gate = withP11Digest(
      {
        schema_id: SCA_P11_GATE_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        criterion_id: "AC-P11" as const,
        verdict: "pass_ready" as const,
        report_ref: REF,
        lane: "accepted_progression" as const,
        immutable_p10_lineage_valid: true,
        exhaustive_record_reconciliation: true,
        set_equality_valid: true,
        no_dropped_finding: true,
        semantic_only_findings_included: true,
        representation_consistency: true,
        deterministic_validation_passed: true,
        semantic_review_passed: true,
        no_unresolved_required_item: true,
        cwe_metadata_complete: true,
        status_mapping_valid: true,
        scoring_records_qualified: true,
        exception_shapes_valid: true,
        paths_and_redaction_valid: true,
        checksum_manifest_valid: true,
        obligation_ledger_complete: true,
        latest_revision_only: true,
        model_identity_and_disclosure_valid: true,
        p11_reporting_authority_respected: true,
        p12_or_release_claims_absent: true,
        finding_count: 1,
        record_count: 1,
        blocker_codes: [],
        evaluated_at: "2026-10-02T00:00:00.000Z",
      },
      "gate_sha256"
    );
    expect(validateScaP11GateV1(gate).verdict).toBe("pass_ready");
    expect(() => validateScaP11GateV1({ ...gate, semantic_review_passed: false })).toThrow();
    expect(() =>
      validateScaP11GateV1({ ...gate, blocker_codes: ["p11_open_item_retained:x"] })
    ).toThrow();
  });

  it("keeps an addendum an immutable append-only companion that cannot complete a report", () => {
    const addendum = withP11Digest(
      {
        schema_id: SCA_P11_ADDENDUM_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: "run",
        base_report_ref: REF,
        base_report_digest: REF.content_digest,
        addendum_kind: "later_campaign_fact" as const,
        subject_refs: [REF],
        rationale: "A later campaign fact recorded without mutating the report.",
        completes_report: false as const,
        mutates_report: false as const,
        append_only: true as const,
        invalidates_release_approval: true as const,
      },
      "addendum_sha256"
    );
    expect(validateScaP11AddendumV1(addendum).invalidates_release_approval).toBe(true);
    expect(() =>
      validateScaP11AddendumV1({ ...addendum, base_report_digest: "e".repeat(64) })
    ).toThrow();
    expect(() =>
      validateScaP11AddendumV1({ ...addendum, invalidates_release_approval: false })
    ).toThrow();
  });

  it("exposes the exact P01-catalog P11 obligations", () => {
    expect(SCA_P11_REQUIRED_OBLIGATION_IDS).toContain("SCA-OBL-P11-ACCEPTANCE");
    expect(SCA_P11_REQUIRED_OBLIGATION_IDS).toContain("SCA-OBL-REPORT-MARKDOWN");
    expect(SCA_P11_REQUIRED_OBLIGATION_IDS.length).toBe(9);
  });
});
