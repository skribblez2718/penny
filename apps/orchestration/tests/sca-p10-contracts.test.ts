import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import {
  SCA_P10_EXPECTED_CASE_OUTCOME,
  SCA_P10_GATE_SCHEMA,
  SCA_P10_RESCAN_DIRECTIVE_SCHEMA,
  SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA,
  SCA_P10_RULE_CANDIDATE_REGISTRY_SCHEMA,
  SCA_P10_RULE_PROMOTION_DECISIONS_SCHEMA,
  SCA_P10_RULE_TEST_FIXTURES_SCHEMA,
  SCA_P10_TERMINAL_SCHEMA,
  SCA_P10_VALIDATION_CASE_CLASSES,
  validateScaP10GateV1,
  validateScaP10RescanDirectiveV1,
  validateScaP10RuleCandidateProposalV1,
  validateScaP10RuleCandidateRegistryV1,
  validateScaP10RulePromotionDecisionsV1,
  validateScaP10RuleTestFixturesV1,
  validateScaP10TerminalV1,
  withP10Digest,
} from "../dist/sca/p10-contracts.js";

function ref(id: string): ArtifactRef {
  const digest = sha256(id);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: "run-p10-contracts",
    phase: "SCA-P10",
    branch_id: null,
    kind: "sca-p10-artifact",
    operation_id: id,
    version: 1,
    producer: "host:sca-p10-contracts",
    media_type: "application/json",
    content_schema: { schema_id: "penny.sca-p10-checkpoint.v1", schema_version: 1 },
    byte_length: 2,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function terminalFields(): Record<string, unknown> {
  return {
    schema_id: SCA_P10_TERMINAL_SCHEMA,
    schema_version: 1,
    phase_id: "SCA-P10",
    status: "blocked_invalid",
    learning_outcome_ref: ref("outcome"),
    gate_ref: ref("gate"),
    p11_transition_ref: null,
    p11_handoff_ready: false,
    eligibility_ledger_ref: ref("eligibility"),
    promotion_performed: false,
    promotion_receipt_ref: null,
    outcome_disposition: "blocked_learning",
    eligible_refs: [],
    ineligible_refs: [],
    missing_downstream_artifacts: ["penny.sca-p11-report.v1"],
    required_downstream_obligation_ids: ["SCA-OBL-P11-ACCEPTANCE"],
    selected_artifact_refs: [],
    blocker_codes: ["p10_required_validation_unrun"],
    phase_gate_passed: false,
    release_eligible: false,
    campaign_complete: false,
    nonterminal_campaign: true,
    p12_release_authorized: false,
    report_or_release_adjudication_performed: false,
  };
}

describe("SCA P10 closed contracts", () => {
  it("validates the terminal golden shape and enforces non-positivity", () => {
    const terminal = validateScaP10TerminalV1(withP10Digest(terminalFields(), "terminal_sha256"));
    expect(terminal.promotion_performed).toBe(false);
    expect(() =>
      validateScaP10TerminalV1(
        withP10Digest({ ...terminalFields(), release_eligible: true }, "terminal_sha256")
      )
    ).toThrow();
    expect(() =>
      validateScaP10TerminalV1(
        withP10Digest({ ...terminalFields(), promotion_performed: true }, "terminal_sha256")
      )
    ).toThrow();
  });

  it("rejects a pass_ready gate that claims an unmet condition", () => {
    const fields = {
      schema_id: SCA_P10_GATE_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P10",
      criterion_id: "AC-P10",
      verdict: "pass_ready",
      learning_outcome_ref: ref("outcome"),
      lane: "accepted_progression",
      outcome_disposition: "validated_candidate",
      immutable_p09_lineage_valid: true,
      exhaustive_eligibility: true,
      false_negative_predicate_valid: true,
      no_ineligible_learning: true,
      baseline_binding_valid: true,
      candidate_lineage_complete: true,
      validation_manifest_complete: true,
      no_unrun_required_validation_disguised: true,
      no_overfitting_no_suppressed_retained: true,
      promotion_separately_authorized: true,
      promotion_future_only: true,
      promotion_atomic_immutable: true,
      no_promotion_without_receipt: true,
      append_only_revisions: true,
      frozen_active_run_rules_preserved: true,
      rescan_separate_revision: true,
      downstream_accounting_present: true,
      model_identity_and_disclosure_valid: true,
      deterministic_validation_host_owned: true,
      p12_or_release_claims_absent: true,
      eligible_count: 1,
      candidate_count: 1,
      validated_candidate_count: 1,
      quarantined_candidate_count: 0,
      blocked_candidate_count: 0,
      false_negative_count: 1,
      coverage_gap_count: 0,
      blocker_codes: [],
      evaluated_at: "2026-09-26T00:00:00.000Z",
    };
    expect(validateScaP10GateV1(withP10Digest(fields, "gate_sha256")).verdict).toBe("pass_ready");
    expect(() =>
      validateScaP10GateV1(
        withP10Digest({ ...fields, baseline_binding_valid: false }, "gate_sha256")
      )
    ).toThrow();
    expect(() =>
      validateScaP10GateV1(
        withP10Digest({ ...fields, blocker_codes: ["p10_x"], verdict: "pass_ready" }, "gate_sha256")
      )
    ).toThrow();
  });

  it("rejects a rescan directive that claims to have executed", () => {
    const fields = {
      schema_id: SCA_P10_RESCAN_DIRECTIVE_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P10",
      run_id: "run-p10-contracts",
      promotion_receipt_ref: ref("receipt"),
      successor_release_ref: ref("release"),
      successor_release_sha256: ref("release").content_digest,
      source_snapshot_ref: ref("snapshot"),
      source_snapshot_sha256: ref("snapshot").content_digest,
      retained_baseline_ref: ref("baseline"),
      rescan_revision: 1,
      reenters_investigation_at: "SCA-P04",
      executed: false,
    };
    expect(
      validateScaP10RescanDirectiveV1(withP10Digest(fields, "directive_sha256")).executed
    ).toBe(false);
    expect(() =>
      validateScaP10RescanDirectiveV1(
        withP10Digest({ ...fields, executed: true }, "directive_sha256")
      )
    ).toThrow();
  });

  it("requires exactly the eight case classes with their closed expected outcomes", () => {
    const fields = {
      schema_id: SCA_P10_RULE_TEST_FIXTURES_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P10",
      run_id: "run-p10-contracts",
      candidate_id: `p10cand_${sha256("candidate")}`,
      fixture_directory: "sca-p10/fixtures",
      cases: SCA_P10_VALIDATION_CASE_CLASSES.map((caseClass) => ({
        case_class: caseClass,
        file_name: `${caseClass}.php`,
        fixture_ref: ref(`fixture-${caseClass}`),
        expected_outcome: SCA_P10_EXPECTED_CASE_OUTCOME[caseClass],
        content_sha256: ref(`fixture-${caseClass}`).content_digest,
      })),
    };
    expect(
      validateScaP10RuleTestFixturesV1(withP10Digest(fields, "fixture_sha256")).cases.length
    ).toBe(8);
    expect(() =>
      validateScaP10RuleTestFixturesV1(
        withP10Digest(
          {
            ...fields,
            cases: fields.cases.map((entry, index) =>
              index === 0 ? { ...entry, expected_outcome: "no_match" } : entry
            ),
          },
          "fixture_sha256"
        )
      )
    ).toThrow();
  });

  it("rejects a candidate registry that drops or duplicates a candidate id", () => {
    const candidateId = `p10cand_${sha256("candidate")}`;
    const fields = {
      schema_id: SCA_P10_RULE_CANDIDATE_REGISTRY_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P10",
      run_id: "run-p10-contracts",
      candidates: [
        { candidate_id: candidateId, current_revision_ref: ref("rev"), prior_revision_refs: [] },
      ],
      candidate_count: 1,
      append_only: true,
    };
    expect(
      validateScaP10RuleCandidateRegistryV1(withP10Digest(fields, "registry_sha256"))
        .candidate_count
    ).toBe(1);
    expect(() =>
      validateScaP10RuleCandidateRegistryV1(
        withP10Digest({ ...fields, candidate_count: 2 }, "registry_sha256")
      )
    ).toThrow();
  });

  it("rejects a promotion decision that claims promotion without a receipt", () => {
    const candidateId = `p10cand_${sha256("candidate")}`;
    const fields = {
      schema_id: SCA_P10_RULE_PROMOTION_DECISIONS_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P10",
      run_id: "run-p10-contracts",
      promotion_authority_ref: ref("authority"),
      promotion_authority_admitted: true,
      policy_default: "deny",
      promotion_attempted: true,
      decisions: [
        {
          candidate_id: candidateId,
          rule_revision_ref: ref("rev"),
          decision: "promoted",
          predecessor_release_ref: null,
          predecessor_release_sha256: null,
          successor_release_ref: ref("release"),
          successor_release_sha256: ref("release").content_digest,
          successor_release_revision: 1,
          receipt_ref: ref("receipt"),
          blocker_codes: [],
        },
      ],
      decision_count: 1,
    };
    expect(
      validateScaP10RulePromotionDecisionsV1(withP10Digest(fields, "decisions_sha256"))
        .decision_count
    ).toBe(1);
    expect(() =>
      validateScaP10RulePromotionDecisionsV1(
        withP10Digest(
          {
            ...fields,
            decisions: fields.decisions.map((entry) => ({ ...entry, receipt_ref: null })),
          },
          "decisions_sha256"
        )
      )
    ).toThrow();
    expect(() =>
      validateScaP10RulePromotionDecisionsV1(
        withP10Digest(
          {
            ...fields,
            promotion_authority_admitted: false,
          },
          "decisions_sha256"
        )
      )
    ).toThrow();
  });

  it("enforces the self-digest of every sealed contract", () => {
    const terminal = withP10Digest(terminalFields(), "terminal_sha256");
    expect(canonicalJson(JSON.parse(canonicalJson(terminal)))).toBe(canonicalJson(terminal));
    expect(() =>
      validateScaP10TerminalV1({ ...terminal, terminal_sha256: "0".repeat(64) })
    ).toThrow();
  });

  it("rejects a proposal whose no-feasible-rule flag disagrees with its proposals", () => {
    const fields = {
      schema_id: SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA,
      schema_version: 1,
      role: "rule_candidate_proposer",
      payload_sha256: sha256("payload"),
      proposals: [],
      no_feasible_rule: true,
      rationale: "no feasible rule",
      complete: true,
    };
    expect(validateScaP10RuleCandidateProposalV1(fields).no_feasible_rule).toBe(true);
    expect(() =>
      validateScaP10RuleCandidateProposalV1({ ...fields, no_feasible_rule: false })
    ).toThrow();
  });
});
