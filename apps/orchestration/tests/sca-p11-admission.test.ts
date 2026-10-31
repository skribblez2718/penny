import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import { admitScaP11Reporting, type ScaP11AdmissionInputV1 } from "../dist/sca/p11-admission.js";
import { buildScaP11Lineage, type ScaP11LineageV1 } from "./sca-p11-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p11-admission-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function lineage(accepted: boolean): {
  readonly artifacts: ArtifactStore;
  readonly value: ScaP11LineageV1;
} {
  const artifacts = store();
  const value = buildScaP11Lineage({
    store: artifacts,
    run_id: accepted ? "run-p11-adm-accepted" : "run-p11-adm-incomplete",
    confirmed: true,
    accepted,
    report_policy_complete: true,
  });
  return { artifacts, value };
}
function admissionInput(artifacts: ArtifactStore, value: ScaP11LineageV1): ScaP11AdmissionInputV1 {
  const c = value.constraints;
  return {
    store: artifacts,
    run_id: c.run_id,
    p10_terminal_ref: c.p10_terminal_ref,
    p10_transition_ref: c.p10_transition_ref,
    p10_outcome_ref: c.p10_outcome_ref,
    p10_gate_ref: c.p10_gate_ref,
    p10_admission_ref: c.p10_admission_ref,
    p10_eligibility_ledger_ref: c.p10_eligibility_ledger_ref,
    p10_candidate_registry_ref: c.p10_candidate_registry_ref,
    p09_terminal_ref: c.p09_terminal_ref,
    p09_transition_ref: c.p09_transition_ref,
    p09_reconciliation_ledger_ref: c.p09_reconciliation_ledger_ref,
    p09_gate_ref: c.p09_gate_ref,
    p09_admission_ref: c.p09_admission_ref,
    p08_terminal_ref: c.p08_terminal_ref,
    p08_transition_ref: c.p08_transition_ref,
    p08_evidence_ledger_ref: c.p08_evidence_ledger_ref,
    p08_gate_ref: c.p08_gate_ref,
    p08_admission_ref: c.p08_admission_ref,
    p08_item_universe_ref: c.p08_item_universe_ref,
    p01_obligation_ledger_ref: c.p01_obligation_ledger_ref,
    baseline_evidence_ref: c.baseline_evidence_ref,
    p10_disclosure_scope_ref: c.p10_disclosure_scope_ref,
    promotion_authority_ref: c.promotion_authority_ref,
    active_run_rule_release_refs: c.active_run_rule_release_refs,
    p09_coverage_input_ref: c.p09_coverage_input_ref,
    p09_phase_evidence_refs: c.p09_phase_evidence_refs,
    p09_obligation_resolution_ref: c.p09_obligation_resolution_ref,
    p09_reassessment_ref: c.p09_reassessment_ref,
    p10_reassessment_ref: c.p10_reassessment_ref,
    p10_prior_ledger_ref: c.p10_prior_ledger_ref,
    p11_disclosure_scope_ref: c.p11_disclosure_scope_ref,
    p11_repair_disclosure_scope_ref: c.p11_repair_disclosure_scope_ref,
    scoring_policy_ref: c.scoring_policy_ref,
    report_policy_ref: c.report_policy_ref,
  };
}
function persistCancelledTerminal(artifacts: ArtifactStore, runId: string): ArtifactRef {
  const body: Record<string, unknown> = {
    schema_id: "penny.sca-p10-terminal.v1",
    schema_version: 1,
    phase_id: "SCA-P10",
    status: "cancelled",
    learning_outcome_ref: null,
    gate_ref: null,
    p11_transition_ref: null,
    p11_handoff_ready: false,
    eligibility_ledger_ref: null,
    promotion_performed: false,
    promotion_receipt_ref: null,
    outcome_disposition: null,
    eligible_refs: [],
    ineligible_refs: [],
    missing_downstream_artifacts: ["penny.sca-p11-report.v1"],
    required_downstream_obligation_ids: ["SCA-OBL-P11-ACCEPTANCE"],
    selected_artifact_refs: [],
    blocker_codes: ["p10_cancelled"],
    phase_gate_passed: false,
    release_eligible: false,
    campaign_complete: false,
    nonterminal_campaign: true,
    p12_release_authorized: false,
    report_or_release_adjudication_performed: false,
  };
  const value = { ...body, terminal_sha256: sha256(canonicalJson(body)) };
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: runId,
    phase: "SCA-P10",
    branch_id: null,
    kind: "sca-p10-terminal",
    operation_id: "sca-p11-admission-cancelled-terminal",
    version: 1,
    producer: "host:sca-p11-lineage",
    media_type: "application/json",
    content_schema: { schema_id: "penny.sca-p10-terminal.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  return artifacts.persist({ metadata, content: canonicalJson(value) });
}

function persistBlockedInvalidTerminal(artifacts: ArtifactStore, runId: string): ArtifactRef {
  const body: Record<string, unknown> = {
    schema_id: "penny.sca-p10-terminal.v1",
    schema_version: 1,
    phase_id: "SCA-P10",
    status: "blocked_invalid",
    learning_outcome_ref: null,
    gate_ref: null,
    p11_transition_ref: null,
    p11_handoff_ready: false,
    eligibility_ledger_ref: null,
    promotion_performed: false,
    promotion_receipt_ref: null,
    outcome_disposition: null,
    eligible_refs: [],
    ineligible_refs: [],
    missing_downstream_artifacts: ["penny.sca-p11-report.v1"],
    required_downstream_obligation_ids: ["SCA-OBL-P11-ACCEPTANCE"],
    selected_artifact_refs: [],
    blocker_codes: ["p10_blocked_invalid"],
    phase_gate_passed: false,
    release_eligible: false,
    campaign_complete: false,
    nonterminal_campaign: true,
    p12_release_authorized: false,
    report_or_release_adjudication_performed: false,
  };
  const value = { ...body, terminal_sha256: sha256(canonicalJson(body)) };
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: runId,
    phase: "SCA-P10",
    branch_id: null,
    kind: "sca-p10-terminal",
    operation_id: "sca-p11-admission-blocked-invalid-terminal",
    version: 1,
    producer: "host:sca-p11-lineage",
    media_type: "application/json",
    content_schema: { schema_id: "penny.sca-p10-terminal.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  return artifacts.persist({ metadata, content: canonicalJson(value) });
}

describe("SCA P11 exact P10 lineage admission", () => {
  it("admits the accepted-progression lane and re-derives the P10 learning lineage", () => {
    const { artifacts, value } = lineage(true);
    const admitted = admitScaP11Reporting(admissionInput(artifacts, value));
    expect(admitted.reportable).toBe(true);
    expect(admitted.lane).toBe("accepted_progression");
    expect(admitted.admission.p10_rederivation_ok).toBe(true);
    expect(admitted.admission.p10_handoff_agreement_ok).toBe(true);
    expect(admitted.p09_ledger).not.toBeNull();
    expect(admitted.unresolved_item_refs.length).toBeGreaterThanOrEqual(0);
  });

  it("admits the incomplete-closeout lane without upgrading unresolved items", () => {
    const { artifacts, value } = lineage(false);
    const admitted = admitScaP11Reporting(admissionInput(artifacts, value));
    expect(admitted.reportable).toBe(true);
    expect(admitted.lane).toBe("incomplete_closeout");
  });

  it("treats a blocked_invalid P10 checkpoint as a non-reportable checkpoint", () => {
    const { artifacts, value } = lineage(true);
    const blockedRef = persistBlockedInvalidTerminal(artifacts, value.run_id);
    const input = admissionInput(artifacts, value);
    const admitted = admitScaP11Reporting({
      ...input,
      p10_terminal_ref: blockedRef,
      p10_transition_ref: null,
    });
    expect(admitted.reportable).toBe(false);
    expect(admitted.lane).toBeNull();
    expect(admitted.non_reportable_reason).toContain("blocked_invalid");
    expect(admitted.p09_ledger).toBeNull();
    expect(admitted.evidence_refs.length).toBeGreaterThan(0);
  });

  it("treats a blocked_invalid or cancelled P10 checkpoint as a non-reportable checkpoint", () => {
    const { artifacts, value } = lineage(true);
    const cancelledRef = persistCancelledTerminal(artifacts, value.run_id);
    const input = admissionInput(artifacts, value);
    const admitted = admitScaP11Reporting({
      ...input,
      p10_terminal_ref: cancelledRef,
      p10_transition_ref: null,
    });
    expect(admitted.reportable).toBe(false);
    expect(admitted.lane).toBeNull();
    expect(admitted.non_reportable_reason).toContain("cancelled");
    expect(admitted.p09_ledger).toBeNull();
    expect(admitted.evidence_refs.length).toBeGreaterThan(0);
  });

  it("requires the complete recorded P10 record set for a reportable lane", () => {
    const { artifacts, value } = lineage(true);
    const input = admissionInput(artifacts, value);
    expect(() => admitScaP11Reporting({ ...input, p10_admission_ref: null })).toThrow();
    expect(() => admitScaP11Reporting({ ...input, p10_eligibility_ledger_ref: null })).toThrow();
    expect(() => admitScaP11Reporting({ ...input, p10_outcome_ref: null })).toThrow();
  });

  it("refuses a wrong-kind predecessor supplied as the P10 terminal", () => {
    const { artifacts, value } = lineage(true);
    const input = admissionInput(artifacts, value);
    expect(() =>
      admitScaP11Reporting({ ...input, p10_terminal_ref: value.p09_result.terminal_ref })
    ).toThrow();
  });

  it("refuses a cross-run lineage reference", () => {
    const { artifacts, value } = lineage(true);
    const input = admissionInput(artifacts, value);
    expect(() => admitScaP11Reporting({ ...input, run_id: "another-run" })).toThrow();
  });
});
