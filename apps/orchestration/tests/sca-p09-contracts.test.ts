import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import type { ArtifactRef } from "../dist/contracts.js";
import {
  SCA_P09_COVERAGE_INPUT_SCHEMA,
  SCA_P09_GATE_SCHEMA,
  SCA_P09_TERMINAL_SCHEMA,
  SCA_P09_TO_P10_TRANSITION_SCHEMA,
  scaP09CoverageEntryIdentity,
  scaP09ItemId,
  validateScaP09CoverageInputV1,
  validateScaP09GateV1,
  validateScaP09LedgerItemV1,
  validateScaP09ReassessmentV1,
  validateScaP09TerminalV1,
  validateScaP09ToP10TransitionV1,
  withP09Digest,
} from "../dist/sca/p09-contracts.js";
import {
  SCA_P09_REASSESSMENT_SCHEMA,
  SCA_P09_CHECKPOINT_SCHEMA,
} from "../dist/sca/p09-contracts.js";
import { validateScaP09CheckpointV1 } from "../dist/sca/p09-contracts.js";
import { buildScaP09Lineage, type ScaP09LineageV1 } from "./sca-p09-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p09-contracts-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function ref(lineage: ScaP09LineageV1): ArtifactRef {
  return lineage.p08_terminal_ref;
}

function coverageInput(lineage: ScaP09LineageV1, entries: unknown[]) {
  return withP09Digest(
    {
      schema_id: SCA_P09_COVERAGE_INPUT_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P09",
      run_id: lineage.run_id,
      entries,
      coverage_sha256: undefined,
    },
    "coverage_sha256"
  );
}

describe("SCA P09 coverage input contract", () => {
  it("accepts a closed coverage input and rejects an inadmissible surface/state pairing", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-contract-coverage",
      kinds: ["source_query"],
    });
    const valid = validateScaP09CoverageInputV1(
      coverageInput(lineage, [
        {
          identity: scaP09CoverageEntryIdentity({
            surface_kind: "normalized_candidate",
            primary_ref: ref(lineage),
          }),
          surface_kind: "normalized_candidate",
          primary_ref: ref(lineage),
          coverage_state: "covered",
          reason: null,
          blocker_codes: [],
        },
      ])
    );
    expect(valid.entries).toHaveLength(1);
    expect(() =>
      validateScaP09CoverageInputV1(
        coverageInput(lineage, [
          {
            identity: scaP09CoverageEntryIdentity({
              surface_kind: "failed_surface",
              primary_ref: ref(lineage),
            }),
            surface_kind: "failed_surface",
            primary_ref: ref(lineage),
            coverage_state: "covered",
            reason: null,
            blocker_codes: [],
          },
        ])
      )
    ).toThrow();
    expect(() =>
      validateScaP09CoverageInputV1(
        coverageInput(lineage, [
          {
            identity: scaP09CoverageEntryIdentity({
              surface_kind: "normalized_candidate",
              primary_ref: ref(lineage),
            }),
            surface_kind: "normalized_candidate",
            primary_ref: ref(lineage),
            coverage_state: "covered",
            reason: "should never carry a gap reason",
            blocker_codes: [],
          },
        ])
      )
    ).toThrow();
  });
});

describe("SCA P09 checkpoint contract", () => {
  it("binds the checkpoint to its derived stable item identity", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-contract-checkpoint",
      kinds: ["source_query"],
    });
    const value = withP09Digest(
      {
        schema_id: SCA_P09_CHECKPOINT_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P09",
        run_id: lineage.run_id,
        item_id: scaP09ItemId({ item_kind: "p01_obligation", identity: "SCA-OBL-P03-ACCEPTANCE" }),
        item_kind: "p01_obligation",
        identity: "SCA-OBL-P03-ACCEPTANCE",
        reason_code: "p09_coverage_input_absent",
        primary_ref: ref(lineage),
        missing_evidence_need: "the P02/P03 candidate sets",
        reopen_condition: "supply an admitted coverage input",
      },
      "checkpoint_sha256"
    );
    expect(validateScaP09CheckpointV1(value).identity).toBe("SCA-OBL-P03-ACCEPTANCE");
    expect(() =>
      validateScaP09CheckpointV1({ ...value, identity: "SCA-OBL-P04-ACCEPTANCE" })
    ).toThrow();
  });
});

describe("SCA P09 reassessment contract", () => {
  it("requires invalidated evidence exactly when the invalidation trigger is named", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-contract-reassessment",
      kinds: ["source_query"],
    });
    const base = {
      schema_id: SCA_P09_REASSESSMENT_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P09",
      run_id: lineage.run_id,
      prior_p09_ledger_ref: ref(lineage),
      prior_p09_ledger_sha256: ref(lineage).content_digest,
      trigger_codes: ["new_evidence"],
      stimulus_refs: [ref(lineage)],
      invalidated_evidence_refs: [],
    };
    expect(validateScaP09ReassessmentV1(withP09Digest(base, "reassessment_sha256")).run_id).toBe(
      lineage.run_id
    );
    expect(() =>
      validateScaP09ReassessmentV1(
        withP09Digest({ ...base, trigger_codes: ["invalidated_evidence"] }, "reassessment_sha256")
      )
    ).toThrow();
  });
});

describe("SCA P09 ledger item contract", () => {
  it("requires obligations to carry a consistent class derivation", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-contract-ledger-item",
      kinds: ["source_query"],
    });
    const evidence = ref(lineage);
    const item = {
      item_id: scaP09ItemId({ item_kind: "p01_obligation", identity: "SCA-OBL-P01-ACCEPTANCE" }),
      item_kind: "p01_obligation",
      identity: "SCA-OBL-P01-ACCEPTANCE",
      primary_ref: evidence,
      p08_disposition: null,
      p08_disposition_ref: null,
      checkpoint_ref: null,
      effective_class: "required-result",
      precedence: 3,
      revision_chain_refs: [evidence],
      coverage_state: null,
      eligibility: "non_finding",
      due_at_p09_entry: true,
      resolved: true,
      blocker_codes: [],
    };
    expect(validateScaP09LedgerItemV1(item).effective_class).toBe("required-result");
    expect(() => validateScaP09LedgerItemV1({ ...item, precedence: 2 })).toThrow();
    expect(() => validateScaP09LedgerItemV1({ ...item, resolved: false })).toThrow();
    expect(() =>
      validateScaP09LedgerItemV1({
        ...item,
        item_kind: "action",
        item_id: scaP09ItemId({ item_kind: "action", identity: "SCA-OBL-P01-ACCEPTANCE" }),
      })
    ).toThrow();
  });
});

describe("SCA P09 gate contract", () => {
  it("makes a pass_ready verdict impossible while any predicate is unmet", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-contract-gate",
      kinds: ["source_query"],
    });
    const gate = {
      schema_id: SCA_P09_GATE_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P09",
      criterion_id: "AC-P09",
      verdict: "pass_ready",
      reconciliation_ledger_ref: ref(lineage),
      p08_terminal_ref: ref(lineage),
      p08_evidence_ledger_ref: ref(lineage),
      p08_gate_ref: ref(lineage),
      lane: "accepted_progression",
      exhaustive_accounting: true,
      immutable_p08_lineage_valid: true,
      set_equality_valid: true,
      effective_class_derivation_valid: true,
      no_underclassification: true,
      no_post_failure_downgrade: true,
      no_late_unregistered_action: true,
      no_conflicting_replay: true,
      coverage_reconciled: true,
      append_only_revisions: true,
      eligible_handoff_only: true,
      downstream_accounting_present: true,
      p12_or_release_claims_absent: true,
      p01_head_attested: false,
      p08_authority_attested: false,
      retained_required_gaps: false,
      item_count: 1,
      required_result_total: 1,
      required_result_resolved: 1,
      required_result_downstream_pending: 0,
      blocker_codes: [],
      evaluated_at: "2026-09-26T00:00:00.000Z",
    };
    expect(validateScaP09GateV1(withP09Digest(gate, "gate_sha256")).verdict).toBe("pass_ready");
    expect(() =>
      validateScaP09GateV1(withP09Digest({ ...gate, coverage_reconciled: false }, "gate_sha256"))
    ).toThrow();
    expect(() =>
      validateScaP09GateV1(withP09Digest({ ...gate, retained_required_gaps: true }, "gate_sha256"))
    ).toThrow();
    expect(() =>
      validateScaP09GateV1(
        withP09Digest(
          { ...gate, required_result_total: 0, required_result_resolved: 0 },
          "gate_sha256"
        )
      )
    ).toThrow();
  });
});

describe("SCA P09 terminal and handoff contracts", () => {
  it("rejects a reconciled terminal without its ledger, gate, and handoff", () => {
    const terminal = {
      schema_id: SCA_P09_TERMINAL_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P09",
      status: "accepted_progression",
      reconciliation_ledger_ref: null,
      gate_ref: null,
      p10_transition_ref: null,
      p10_handoff_ready: false,
      lane: "accepted_progression",
      item_count: 0,
      kind_counts: [],
      disposition_counts: [],
      required_result_total: 0,
      required_result_resolved: 0,
      eligible_refs: [],
      ineligible_refs: [],
      missing_downstream_artifacts: [],
      required_downstream_obligation_ids: [],
      selected_artifact_refs: [],
      blocker_codes: [],
      phase_gate_passed: false,
      release_eligible: false,
      campaign_complete: false,
      nonterminal_campaign: true,
      p12_release_authorized: false,
      report_or_release_adjudication_performed: false,
    };
    expect(() => validateScaP09TerminalV1(withP09Digest(terminal, "terminal_sha256"))).toThrow();
    expect(() =>
      validateScaP09TerminalV1(
        withP09Digest({ ...terminal, status: "cancelled" }, "terminal_sha256")
      )
    ).toThrow();
  });

  it("never lets unresolved evidence appear as eligible handoff evidence", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-contract-handoff",
      kinds: ["source_query"],
    });
    const shared = ref(lineage);
    const transition = {
      schema_id: SCA_P09_TO_P10_TRANSITION_SCHEMA,
      schema_version: 1,
      source_phase_id: "SCA-P09",
      target_phase_id: "SCA-P10",
      handoff_kind: "reconciled_eligible_evidence_only",
      qualification_scope: "reconciliation_gate_only_not_p10_learning",
      phase_gate_passed: false,
      p10_rule_learning_authorized_by_this_transition: false,
      release_eligible: false,
      campaign_complete: false,
      campaign_completion_claimed: false,
      p08_terminal_ref: shared,
      p08_transition_ref: shared,
      p08_evidence_ledger_ref: shared,
      p09_reconciliation_ledger_ref: shared,
      lane: "incomplete_closeout",
      eligible_refs: [shared],
      ineligible_refs: [shared],
      unresolved_item_refs: [shared],
      required_gaps_retained: true,
    };
    expect(() =>
      validateScaP09ToP10TransitionV1(withP09Digest(transition, "transition_sha256"))
    ).toThrow();
  });
});
