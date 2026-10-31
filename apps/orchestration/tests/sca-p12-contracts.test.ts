import { describe, expect, it } from "vitest";

import {
  SCA_P12_ADMISSION_SCHEMA,
  SCA_P12_GATE_SCHEMA,
  SCA_P12_OBLIGATION_LEDGER_SCHEMA,
  SCA_P12_TERMINAL_SCHEMA,
  SCA_P12_VERIFIER_VERDICTS_SCHEMA,
  validateScaP12AdmissionV1,
  validateScaP12GateV1,
  validateScaP12ObligationLedgerV1,
  validateScaP12TerminalV1,
  validateScaP12VerifierVerdictsV1,
  withP12Digest,
} from "../dist/sca/p12-contracts.js";

const ref = (n: number) => ({
  schema_version: 2 as const,
  artifact_id: `art_${String(n).padStart(64, "a")}`,
  run_id: "run",
  phase: "SCA-P12",
  branch_id: null,
  kind: "test",
  operation_id: `op-${n}`,
  version: 1,
  producer: "host:test",
  media_type: "application/json",
  content_schema: { schema_id: "penny.sca-p12-terminal.v1", schema_version: 1 },
  byte_length: 1,
  content_digest: String(n).padStart(64, "b"),
  store_ref: `artifact://sha256/${String(n).padStart(64, "b")}`,
});

function neutralGateFacts(): Record<string, boolean> {
  return {
    immutable_p11_lineage_valid: true,
    verifier_independent_and_subset_authority: true,
    deterministic_replay_passed: true,
    spot_check_passed: true,
    verifier_verdicts_supported: true,
    no_unresolved_required_item: true,
    phase_gate_index_complete: true,
    obligation_ledger_complete: true,
    accepted_set_projection_consistent: true,
    artifact_identity_valid: true,
    latest_revision_only: true,
    human_release_authority_valid: true,
    release_record_binding_valid: true,
    publication_not_claimed: true,
    p12_release_authority_respected: true,
  };
}

describe("SCA P12 contracts", () => {
  it("enforces the admission reportable/lane/reason assurance", () => {
    const value = withP12Digest(
      {
        schema_id: SCA_P12_ADMISSION_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        run_id: "run",
        p11_terminal_ref: ref(1),
        p11_transition_ref: null,
        p11_admission_ref: null,
        p11_report_ref: null,
        verification_scope_ref: ref(2),
        verifier_authority_ref: ref(3),
        release_authority_ref: ref(4),
        reportable: false,
        non_reportable_reason: "p11_cancelled_non_reportable",
        p11_rederivation_ok: false,
        p11_handoff_agreement_ok: false,
        report_status: null,
        no_unresolved_required_item: false,
        record_count: 0,
        finding_count: 0,
      },
      "admission_sha256"
    );
    expect(validateScaP12AdmissionV1(value).reportable).toBe(false);
    expect(() => validateScaP12AdmissionV1({ ...value, reportable: true })).toThrow();
  });

  it("rejects a pass_ready gate that claims an unmet predicate", () => {
    const value = withP12Digest(
      {
        schema_id: SCA_P12_GATE_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        criterion_id: "AC-P12" as const,
        verdict: "pass_ready" as const,
        report_ref: ref(1),
        release_record_ref: null,
        lane: "accepted_progression" as const,
        ...neutralGateFacts(),
        finding_count: 3,
        record_count: 70,
        blocker_codes: [],
        evaluated_at: "2026-10-03T00:00:00.000Z",
      },
      "gate_sha256"
    );
    expect(validateScaP12GateV1(value).verdict).toBe("pass_ready");
    const unmet = { ...value, spot_check_passed: false };
    const resealed = withP12Digest(
      Object.fromEntries(Object.entries(unmet).filter(([k]) => k !== "gate_sha256")),
      "gate_sha256"
    );
    expect(() => validateScaP12GateV1(resealed)).toThrow();
  });

  it("keeps the terminal non-positive and requires the incomplete marker", () => {
    const value = withP12Digest(
      {
        schema_id: SCA_P12_TERMINAL_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        status: "verification_incomplete" as const,
        lane: "accepted_progression" as const,
        release_record_ref: null,
        gate_ref: null,
        release_approval_ref: null,
        p11_terminal_ref: ref(1),
        report_ref: ref(2),
        campaign_complete: false,
        release_eligible: false,
        publication_authorized: false as const,
        publication_performed: false as const,
        incomplete_marker: "⚠ INCOMPLETE — missing: p12_phase_gate_index_incomplete",
        missing_downstream_artifacts: ["penny.sca-product-qualification.v1"],
        required_downstream_obligation_ids: ["SCA-OBL-PRODUCT-QUALIFICATION"],
        selected_artifact_refs: [],
        blocker_codes: ["p12_phase_gate_index_incomplete"],
      },
      "terminal_sha256"
    );
    expect(validateScaP12TerminalV1(value).status).toBe("verification_incomplete");
    const noMarker = withP12Digest(
      Object.fromEntries(Object.entries(value).filter(([k]) => k !== "terminal_sha256")),
      "terminal_sha256"
    );
    expect(() =>
      validateScaP12TerminalV1({ ...(noMarker as object), incomplete_marker: null })
    ).toThrow();
  });

  it("keeps the obligation ledger uncovered ids consistent with its entries", () => {
    const value = withP12Digest(
      {
        schema_id: SCA_P12_OBLIGATION_LEDGER_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        run_id: "run",
        revision: 1,
        entries: [
          {
            obligation_id: "SCA-OBL-BOUNDARY-INDEPENDENT-REVIEW",
            scope: "boundary" as const,
            covered: true,
            coverage: "covered",
            artifact_refs: [ref(1)],
          },
          {
            obligation_id: "SCA-OBL-BOUNDARY-RELEASE-AUTHORITY",
            scope: "boundary" as const,
            covered: false,
            coverage: "publication authority remains separate and unmet",
            artifact_refs: [ref(2)],
          },
          {
            obligation_id: "SCA-OBL-P12-ACCEPTANCE",
            scope: "phase" as const,
            covered: true,
            coverage: "covered",
            artifact_refs: [ref(3)],
          },
        ],
        entry_count: 3,
        uncovered_obligation_ids: ["SCA-OBL-BOUNDARY-RELEASE-AUTHORITY"],
      },
      "ledger_sha256"
    );
    expect(validateScaP12ObligationLedgerV1(value).uncovered_obligation_ids).toHaveLength(1);
    const inconsistent = withP12Digest(
      Object.fromEntries(Object.entries(value).filter(([k]) => k !== "ledger_sha256")),
      "ledger_sha256"
    );
    expect(() =>
      validateScaP12ObligationLedgerV1({
        ...(inconsistent as object),
        uncovered_obligation_ids: [],
      })
    ).toThrow();
  });

  it("requires verdict dimensions to be unique and the gate verdict unset", () => {
    const dimension = "identity_lineage_separation";
    const value = withP12Digest(
      {
        schema_id: SCA_P12_VERIFIER_VERDICTS_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        run_id: "run",
        revision: 1,
        verification_scope_sha256: "c".repeat(64),
        verdicts: [
          {
            dimension_id: dimension,
            verdict: "supported" as const,
            reason: "ok",
            evidence_refs: [ref(1)],
          },
        ],
        open_items: [],
        gate_verdict_set: false as const,
        complete: true as const,
      },
      "verdicts_sha256"
    );
    expect(validateScaP12VerifierVerdictsV1(value).verdicts).toHaveLength(1);
    const resealed = withP12Digest(
      Object.fromEntries(Object.entries(value).filter(([k]) => k !== "verdicts_sha256")),
      "verdicts_sha256"
    );
    expect(() =>
      validateScaP12VerifierVerdictsV1({ ...(resealed as object), gate_verdict_set: true })
    ).toThrow();
  });
});
