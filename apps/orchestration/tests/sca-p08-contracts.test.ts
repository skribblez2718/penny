import { describe, expect, it } from "vitest";

import type { ArtifactRef } from "../dist/contracts.js";
import {
  SCA_P08_COGNITIVE_PAYLOAD_SCHEMA,
  SCA_P08_DISPOSITION_REVISION_SCHEMA,
  SCA_P08_EQUIVALENCE_PROOF_SCHEMA,
  SCA_P08_EVIDENCE_LEDGER_SCHEMA,
  SCA_P08_GATE_SCHEMA,
  SCA_P08_ITEM_UNIVERSE_SCHEMA,
  SCA_P08_REASSESSMENT_SCHEMA,
  SCA_P08_REQUIRED_MODEL,
  SCA_P08_SCOPE_DECISION_KINDS,
  SCA_P08_TERMINAL_SCHEMA,
  assertScaP08DuplicateTargetsValid,
  isScaP08ScopeDecisionKind,
  scaP08DuplicatePairKey,
  scaP08ItemId,
  validateScaP08CognitivePayloadV1,
  validateScaP08DispositionAssertionV1,
  validateScaP08DispositionRevisionV1,
  validateScaP08DispositionSupportV1,
  validateScaP08DuplicateEquivalenceProofV1,
  validateScaP08EvidenceLedgerV1,
  validateScaP08GateV1,
  validateScaP08ItemUniverseV1,
  validateScaP08ReassessmentV1,
  validateScaP08TerminalV1,
  withP08Digest,
  type ScaP08DispositionAssertionV1,
  type ScaP08ItemKindV1,
} from "../dist/sca/p08-contracts.js";

const HEX = "a".repeat(64);

function ref(kind = "sca-evidence", hex = HEX): ArtifactRef {
  return {
    schema_version: 2,
    artifact_id: `art_${hex}`,
    run_id: "run",
    phase: "SCA-P07",
    branch_id: null,
    kind,
    operation_id: `${kind}-0001`,
    version: 1,
    producer: "host:test",
    media_type: "application/json",
    content_schema: { schema_id: "penny.sca-test.v1", schema_version: 1 },
    byte_length: 2,
    content_digest: hex,
    store_ref: `artifact://sha256/${hex}`,
  };
}

function itemId(kind: ScaP08ItemKindV1, identity: string): string {
  return scaP08ItemId({ item_kind: kind, identity });
}

const SELF_ID = itemId("action", `p06act_${HEX}`);
const OTHER_ID = itemId("obligation", `p06obl_${HEX}_evidence_decision_0001`);
const SCOPE_REF = ref("sca-p06-accepted-cohort", "b".repeat(64));
const PROOF_REF = ref("sca-p08-duplicate-equivalence-proof", "c".repeat(64));

function assertion(overrides: Record<string, unknown> = {}): ScaP08DispositionAssertionV1 {
  return validateScaP08DispositionAssertionV1({
    item_id: SELF_ID,
    item_kind: "action",
    disposition: "inconclusive",
    claim: null,
    supporting_evidence_refs: [],
    defeating_evidence_refs: [],
    evidence_mode: "none",
    actor_state_stimulus_verified: false,
    target_reachability_observed: false,
    distinguishing_oracle: null,
    complete_code_control_state_evidence: false,
    finite_clean_fuzzing_only: false,
    unresolved_material_link: "link",
    resolution_evidence_need: "need",
    deferral_reason: null,
    reopening_conditions: [],
    duplicate_of_item_id: null,
    equivalence_evidence_refs: [],
    scope_evidence_ref: null,
    repository_path: null,
    line_start: null,
    line_end: null,
    ...overrides,
  });
}

const CONTEXT = {
  universe_item_ids: new Set([SELF_ID, OTHER_ID]),
  p07_status_by_item_id: new Map<string, "completed" | "blocked" | "not_invoked">(),
  admitted_scope_decision_ref_ids: new Set([SCOPE_REF.artifact_id]),
  admitted_equivalence_proof_ref_id_by_pair: new Map([
    [scaP08DuplicatePairKey(SELF_ID, OTHER_ID), PROOF_REF.artifact_id],
  ]),
};

describe("SCA P08 disposition support semantics", () => {
  it("accepts a runtime confirmation with correct actor/state/stimulus and reachability", () => {
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "confirmed",
          claim: "A bypassing path reaches the sink.",
          supporting_evidence_refs: [ref()],
          evidence_mode: "runtime",
          actor_state_stimulus_verified: true,
          target_reachability_observed: true,
        }),
        CONTEXT
      )
    ).not.toThrow();
  });

  it("rejects confirmation without evidence or from finite clean fuzzing", () => {
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "confirmed",
          claim: "claimed",
          evidence_mode: "runtime",
          actor_state_stimulus_verified: true,
          target_reachability_observed: true,
        }),
        CONTEXT
      )
    ).toThrow();
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "confirmed",
          claim: "claimed",
          supporting_evidence_refs: [ref()],
          evidence_mode: "runtime",
          actor_state_stimulus_verified: true,
          target_reachability_observed: true,
          finite_clean_fuzzing_only: true,
        }),
        CONTEXT
      )
    ).toThrow();
  });

  it("rejects a runtime refutation without observed reachability", () => {
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "rejected-with-evidence",
          claim: "claimed",
          defeating_evidence_refs: [ref()],
          evidence_mode: "runtime",
          actor_state_stimulus_verified: true,
          target_reachability_observed: false,
          repository_path: "src/a.ts",
          line_start: 1,
          line_end: 2,
        }),
        CONTEXT
      )
    ).toThrow();
  });

  it("rejects a runtime refutation without a distinguishing oracle", () => {
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "rejected-with-evidence",
          claim: "claimed",
          defeating_evidence_refs: [ref()],
          evidence_mode: "runtime",
          actor_state_stimulus_verified: true,
          target_reachability_observed: true,
          distinguishing_oracle: null,
          repository_path: "src/a.ts",
          line_start: 1,
          line_end: 2,
        }),
        CONTEXT
      )
    ).toThrow();
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "rejected-with-evidence",
          claim: "claimed",
          defeating_evidence_refs: [ref()],
          evidence_mode: "runtime",
          actor_state_stimulus_verified: true,
          target_reachability_observed: true,
          distinguishing_oracle: "the validation path rejects the exact payload",
          repository_path: "src/a.ts",
          line_start: 1,
          line_end: 2,
        }),
        CONTEXT
      )
    ).not.toThrow();
  });

  it("accepts a code refutation with complete evidence and a path/line range", () => {
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "rejected-with-evidence",
          claim: "claimed",
          defeating_evidence_refs: [ref()],
          evidence_mode: "code",
          complete_code_control_state_evidence: true,
          repository_path: "src/a.ts",
          line_start: 10,
          line_end: 20,
        }),
        CONTEXT
      )
    ).not.toThrow();
  });

  it("forbids confirming or refuting an item whose P07 action is blocked or not invoked", () => {
    const blocked = {
      ...CONTEXT,
      p07_status_by_item_id: new Map([[SELF_ID, "not_invoked" as const]]),
    };
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "confirmed",
          claim: "claimed",
          supporting_evidence_refs: [ref()],
          evidence_mode: "runtime",
          actor_state_stimulus_verified: true,
          target_reachability_observed: true,
        }),
        blocked
      )
    ).toThrow();
  });

  it("requires a named gap and resolution need for inconclusive", () => {
    expect(() =>
      validateScaP08DispositionSupportV1(assertion({ disposition: "inconclusive" }), CONTEXT)
    ).not.toThrow();
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({ disposition: "inconclusive", resolution_evidence_need: null }),
        CONTEXT
      )
    ).toThrow();
  });

  it("requires a reason and reopening conditions for deferred", () => {
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "deferred",
          deferral_reason: "waiting",
          reopening_conditions: ["x"],
        }),
        CONTEXT
      )
    ).not.toThrow();
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "deferred",
          deferral_reason: "waiting",
          reopening_conditions: [],
        }),
        CONTEXT
      )
    ).toThrow();
  });

  it("requires a non-self duplicate identity inside the universe plus equivalence evidence", () => {
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "duplicate-of",
          duplicate_of_item_id: OTHER_ID,
          equivalence_evidence_refs: [PROOF_REF],
        }),
        CONTEXT
      )
    ).not.toThrow();
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "duplicate-of",
          duplicate_of_item_id: OTHER_ID,
          equivalence_evidence_refs: [ref()],
        }),
        CONTEXT
      )
    ).toThrow();
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "duplicate-of",
          duplicate_of_item_id: SELF_ID,
          equivalence_evidence_refs: [PROOF_REF],
        }),
        CONTEXT
      )
    ).toThrow();
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({
          disposition: "duplicate-of",
          duplicate_of_item_id: itemId("action", `p06act_${"d".repeat(64)}`),
          equivalence_evidence_refs: [PROOF_REF],
        }),
        CONTEXT
      )
    ).toThrow();
  });

  it("rejects a duplicate-of cycle and a non-cyclic duplicate-of chain", () => {
    expect(() =>
      assertScaP08DuplicateTargetsValid([
        assertion({
          item_id: SELF_ID,
          disposition: "duplicate-of",
          duplicate_of_item_id: OTHER_ID,
        }),
        assertion({
          item_id: OTHER_ID,
          item_kind: "obligation",
          disposition: "duplicate-of",
          duplicate_of_item_id: SELF_ID,
        }),
      ])
    ).toThrow();
    // A→B→C: A's target B is itself `duplicate-of`, so the chain is rejected even though it is
    // acyclic.
    const third = itemId("hypothesis", `p05h_${"e".repeat(64)}`);
    expect(() =>
      assertScaP08DuplicateTargetsValid([
        assertion({
          item_id: SELF_ID,
          disposition: "duplicate-of",
          duplicate_of_item_id: OTHER_ID,
        }),
        assertion({
          item_id: OTHER_ID,
          item_kind: "obligation",
          disposition: "duplicate-of",
          duplicate_of_item_id: third,
        }),
        assertion({
          item_id: third,
          item_kind: "hypothesis",
          disposition: "out-of-scope",
          scope_evidence_ref: SCOPE_REF,
          unresolved_material_link: null,
          resolution_evidence_need: null,
        }),
      ])
    ).toThrow();
    // A valid single edge to a non-duplicate target is accepted.
    expect(() =>
      assertScaP08DuplicateTargetsValid([
        assertion({
          item_id: SELF_ID,
          disposition: "duplicate-of",
          duplicate_of_item_id: OTHER_ID,
          equivalence_evidence_refs: [PROOF_REF],
        }),
        assertion({
          item_id: OTHER_ID,
          item_kind: "obligation",
          disposition: "deferred",
          deferral_reason: "waiting",
          reopening_conditions: ["x"],
        }),
      ])
    ).not.toThrow();
  });

  it("requires admitted scope evidence for out-of-scope", () => {
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({ disposition: "out-of-scope", scope_evidence_ref: SCOPE_REF }),
        CONTEXT
      )
    ).not.toThrow();
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({ disposition: "out-of-scope", scope_evidence_ref: null }),
        CONTEXT
      )
    ).toThrow();
    // A non-null but arbitrary admitted ref (for example an evidence/action record) fails.
    expect(() =>
      validateScaP08DispositionSupportV1(
        assertion({ disposition: "out-of-scope", scope_evidence_ref: ref() }),
        CONTEXT
      )
    ).toThrow();
  });
});

function revision(overrides: Record<string, unknown>): unknown {
  return withP08Digest(
    {
      ...assertion(),
      schema_id: SCA_P08_DISPOSITION_REVISION_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P08",
      run_id: "run",
      identity: `p06act_${HEX}`,
      revision: 1,
      parent_revision_ref: null,
      parent_revision_sha256: null,
      review_verdict: null,
      review_ref: null,
      change_reason_codes: ["initial_construction"],
      changed_fields: [],
      created_at: "2026-09-26T00:00:00.000Z",
      ...overrides,
    },
    "revision_sha256"
  );
}

describe("SCA P08 immutable disposition revisions", () => {
  it("accepts an initial revision", () => {
    expect(() => validateScaP08DispositionRevisionV1(revision({}))).not.toThrow();
  });

  it("rejects a reassessed revision without a parent", () => {
    expect(() =>
      validateScaP08DispositionRevisionV1(
        revision({
          revision: 2,
          change_reason_codes: ["new_evidence"],
          changed_fields: ["disposition"],
        })
      )
    ).toThrow();
  });

  it("rejects an initial revision that carries a parent", () => {
    expect(() =>
      validateScaP08DispositionRevisionV1(
        revision({
          parent_revision_ref: ref("sca-p08-disposition-revision"),
          parent_revision_sha256: HEX,
        })
      )
    ).toThrow();
  });

  it("accepts a reassessed revision with a parent, changed fields, and a reason", () => {
    expect(() =>
      validateScaP08DispositionRevisionV1(
        revision({
          revision: 2,
          parent_revision_ref: ref("sca-p08-disposition-revision"),
          parent_revision_sha256: HEX,
          change_reason_codes: ["new_evidence"],
          changed_fields: ["disposition"],
        })
      )
    ).not.toThrow();
  });

  it("rejects a reassessed revision with no changed field or an unknown reason", () => {
    expect(() =>
      validateScaP08DispositionRevisionV1(
        revision({
          revision: 2,
          parent_revision_ref: ref("sca-p08-disposition-revision"),
          parent_revision_sha256: HEX,
          change_reason_codes: ["new_evidence"],
          changed_fields: [],
        })
      )
    ).toThrow();
    expect(() =>
      validateScaP08DispositionRevisionV1(revision({ change_reason_codes: ["severity_changed"] }))
    ).toThrow();
  });
});

describe("SCA P08 ledger, gate, and terminal accounting", () => {
  const row = (id: string, disposition: string) => ({
    item_id: id,
    item_kind: "action" as const,
    identity: `p06act_${HEX}`,
    disposition,
    current_revision_ref: ref("sca-p08-disposition-revision"),
    prior_revision_refs: [],
    blocker_codes: [],
  });

  it("accepts an exhaustive ledger and rejects a count mismatch", () => {
    const base = {
      schema_id: SCA_P08_EVIDENCE_LEDGER_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P08",
      run_id: "run",
      admission_ref: ref("sca-p08-admission"),
      p07_terminal_ref: ref("sca-p07-terminal"),
      p07_transition_ref: ref("sca-p07-to-p08-transition"),
      p07_evidence_ledger_ref: ref("sca-p07-evidence-ledger"),
      items: [row(SELF_ID, "out-of-scope")],
      item_count: 1,
      confirmed_count: 0,
      rejected_with_evidence_count: 0,
      inconclusive_count: 0,
      deferred_count: 0,
      duplicate_of_count: 0,
      out_of_scope_count: 1,
      unresolved_item_refs: [],
      exhaustive_accounting: true,
      release_eligible: false,
      campaign_complete: false,
    };
    expect(() =>
      validateScaP08EvidenceLedgerV1(withP08Digest(base, "ledger_sha256"))
    ).not.toThrow();
    expect(() =>
      validateScaP08EvidenceLedgerV1(
        withP08Digest({ ...base, out_of_scope_count: 0 }, "ledger_sha256")
      )
    ).toThrow();
  });

  it("rejects a pass_ready gate that carries a blocker or an unmet derived boolean", () => {
    const base = {
      schema_id: SCA_P08_GATE_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P08",
      criterion_id: "AC-P08",
      verdict: "pass_ready",
      evidence_ledger_ref: ref("sca-p08-evidence-ledger"),
      p07_terminal_ref: ref("sca-p07-terminal"),
      p07_transition_ref: ref("sca-p07-to-p08-transition"),
      p07_evidence_ledger_ref: ref("sca-p07-evidence-ledger"),
      exhaustive_accounting: true,
      immutable_p07_lineage_valid: true,
      support_semantics_valid: true,
      no_false_refutation: true,
      scope_duplicate_deferred_valid: true,
      append_only_revisions: true,
      retained_required_gaps: false,
      p09_or_report_or_release_claims_absent: true,
      item_count: 1,
      confirmed_count: 0,
      rejected_with_evidence_count: 0,
      inconclusive_count: 0,
      deferred_count: 0,
      duplicate_of_count: 0,
      out_of_scope_count: 1,
      unresolved_item_count: 0,
      blocker_codes: ["p08_something"],
      evaluated_at: "2026-09-26T00:00:00.000Z",
    };
    expect(() => validateScaP08GateV1(withP08Digest(base, "gate_sha256"))).toThrow();
    // Every derived boolean must hold for `pass_ready`; each false boolean is independently fatal.
    for (const override of [
      { scope_duplicate_deferred_valid: false },
      { no_false_refutation: false },
      { support_semantics_valid: false },
      { append_only_revisions: false },
      { immutable_p07_lineage_valid: false },
      { exhaustive_accounting: false },
      { p09_or_report_or_release_claims_absent: false },
      { retained_required_gaps: true },
    ]) {
      expect(() =>
        validateScaP08GateV1(
          withP08Digest({ ...base, blocker_codes: [], ...override }, "gate_sha256")
        )
      ).toThrow();
    }
    expect(() =>
      validateScaP08GateV1(withP08Digest({ ...base, blocker_codes: [] }, "gate_sha256"))
    ).not.toThrow();
  });

  it("keeps every terminal non-positive and non-authorizing", () => {
    const base = {
      schema_id: SCA_P08_TERMINAL_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P08",
      status: "blocked",
      evidence_ledger_ref: ref("sca-p08-evidence-ledger"),
      gate_ref: ref("sca-p08-gate"),
      p09_transition_ref: ref("sca-p08-to-p09-transition"),
      p09_handoff_ready: true,
      item_count: 1,
      confirmed_count: 0,
      rejected_with_evidence_count: 0,
      inconclusive_count: 1,
      deferred_count: 0,
      duplicate_of_count: 0,
      out_of_scope_count: 0,
      selected_artifact_refs: [],
      blocker_codes: ["p08_required_gaps_retained"],
      phase_gate_passed: false,
      release_eligible: false,
      campaign_complete: false,
      nonterminal_campaign: true,
      report_or_finding_adjudication_performed: false,
    };
    expect(() => validateScaP08TerminalV1(withP08Digest(base, "terminal_sha256"))).not.toThrow();
    expect(() =>
      validateScaP08TerminalV1(
        withP08Digest(
          { ...base, status: "cancelled", p09_transition_ref: ref(), p09_handoff_ready: true },
          "terminal_sha256"
        )
      )
    ).toThrow();
    expect(() =>
      validateScaP08TerminalV1(
        withP08Digest(
          {
            ...base,
            status: "candidate_complete",
            p09_transition_ref: null,
            p09_handoff_ready: false,
          },
          "terminal_sha256"
        )
      )
    ).toThrow();
  });
});

describe("SCA P08 item universe identity", () => {
  it("derives stable ids and rejects a substituted identity", () => {
    const universe = withP08Digest(
      {
        schema_id: SCA_P08_ITEM_UNIVERSE_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P08",
        run_id: "run",
        items: [
          {
            item_id: SELF_ID,
            item_kind: "action",
            identity: `p06act_${HEX}`,
            primary_ref: ref(),
            hypothesis_id: null,
          },
        ],
        item_count: 1,
      },
      "universe_sha256"
    );
    expect(() => validateScaP08ItemUniverseV1(universe)).not.toThrow();
    const tampered = {
      ...universe,
      items: [{ ...universe.items[0], item_id: itemId("action", "other") }],
    };
    expect(() => validateScaP08ItemUniverseV1(tampered)).toThrow();
  });
});

describe("SCA P08 reassessment contracts", () => {
  function reassessment(overrides: Record<string, unknown> = {}): unknown {
    const priorLedger = ref("sca-p08-evidence-ledger");
    return withP08Digest(
      {
        schema_id: SCA_P08_REASSESSMENT_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P08",
        run_id: "run",
        prior_p08_ledger_ref: priorLedger,
        prior_p08_ledger_sha256: priorLedger.content_digest,
        entries: [
          {
            item_id: SELF_ID,
            item_kind: "action",
            identity: `p06act_${HEX}`,
            change_reason_codes: ["new_evidence"],
            stimulus_refs: [ref()],
            duplicate_of_item_id: null,
          },
        ],
        ...overrides,
      },
      "reassessment_sha256"
    );
  }

  it("accepts a host-issued reassessment and rejects trigger/identity defects", () => {
    expect(() => validateScaP08ReassessmentV1(reassessment())).not.toThrow();
    // duplicate_resolution requires an exact duplicate identity.
    expect(() =>
      validateScaP08ReassessmentV1(
        reassessment({
          entries: [
            {
              item_id: SELF_ID,
              item_kind: "action",
              identity: `p06act_${HEX}`,
              change_reason_codes: ["duplicate_resolution"],
              stimulus_refs: [ref()],
              duplicate_of_item_id: null,
            },
          ],
        })
      )
    ).toThrow();
    // A substituted item identity is rejected.
    expect(() =>
      validateScaP08ReassessmentV1(
        reassessment({
          entries: [
            {
              item_id: OTHER_ID,
              item_kind: "action",
              identity: `p06act_${HEX}`,
              change_reason_codes: ["new_evidence"],
              stimulus_refs: [ref()],
              duplicate_of_item_id: null,
            },
          ],
        })
      )
    ).toThrow();
    // A digest-drifted prior ledger binding is rejected.
    expect(() =>
      validateScaP08ReassessmentV1(reassessment({ prior_p08_ledger_sha256: "c".repeat(64) }))
    ).toThrow();
  });

  it("binds revision review verdicts to an exact review ref and its records", () => {
    expect(() =>
      validateScaP08DispositionRevisionV1(
        revision({
          review_verdict: "permits_confirmation",
          review_ref: ref("sca-p08-disposition-review"),
          review_exact_record_refs: [ref()],
        })
      )
    ).not.toThrow();
    expect(() =>
      validateScaP08DispositionRevisionV1(revision({ review_verdict: "permits_confirmation" }))
    ).toThrow();
    expect(() =>
      validateScaP08DispositionRevisionV1(revision({ review_exact_record_refs: [ref()] }))
    ).toThrow();
  });

  it("names the prior ledger on a reassessed ledger revision", () => {
    const priorLedger = ref("sca-p08-evidence-ledger");
    const base = {
      schema_id: SCA_P08_EVIDENCE_LEDGER_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P08",
      run_id: "run",
      admission_ref: ref("sca-p08-admission"),
      p07_terminal_ref: ref("sca-p07-terminal"),
      p07_transition_ref: ref("sca-p07-to-p08-transition"),
      p07_evidence_ledger_ref: ref("sca-p07-evidence-ledger"),
      prior_p08_ledger_ref: priorLedger,
      prior_p08_ledger_sha256: priorLedger.content_digest,
      ledger_revision: 2,
      append_only: true,
      items: [
        {
          item_id: SELF_ID,
          item_kind: "action",
          identity: `p06act_${HEX}`,
          disposition: "out-of-scope",
          current_revision_ref: ref("sca-p08-disposition-revision"),
          prior_revision_refs: [ref("sca-p08-disposition-revision")],
          blocker_codes: [],
        },
      ],
      item_count: 1,
      confirmed_count: 0,
      rejected_with_evidence_count: 0,
      inconclusive_count: 0,
      deferred_count: 0,
      duplicate_of_count: 0,
      out_of_scope_count: 1,
      unresolved_item_refs: [],
      exhaustive_accounting: true,
      release_eligible: false,
      campaign_complete: false,
    };
    expect(() =>
      validateScaP08EvidenceLedgerV1(withP08Digest(base, "ledger_sha256"))
    ).not.toThrow();
    expect(() =>
      validateScaP08EvidenceLedgerV1(
        withP08Digest(
          { ...base, prior_p08_ledger_ref: null, prior_p08_ledger_sha256: null },
          "ledger_sha256"
        )
      )
    ).toThrow();
    expect(() =>
      validateScaP08EvidenceLedgerV1(
        withP08Digest({ ...base, prior_p08_ledger_sha256: "d".repeat(64) }, "ledger_sha256")
      )
    ).toThrow();
  });
});

describe("SCA P08 typed duplicate-equivalence proof", () => {
  function proof(overrides: Record<string, unknown> = {}): unknown {
    return withP08Digest(
      {
        schema_id: SCA_P08_EQUIVALENCE_PROOF_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P08",
        run_id: "run",
        duplicate_item_id: SELF_ID,
        duplicate_item_kind: "action",
        duplicate_item_identity: `p06act_${HEX}`,
        duplicate_primary_ref: ref("sca-p06-action-record", "1".repeat(64)),
        duplicate_primary_sha256: "1".repeat(64),
        target_item_id: OTHER_ID,
        target_item_kind: "obligation",
        target_item_identity: `p06obl_${HEX}_evidence_decision_0001`,
        target_primary_ref: ref("sca-p06-obligation-revision", "2".repeat(64)),
        target_primary_sha256: "2".repeat(64),
        basis: "host_adjudicated_identical_subject",
        ...overrides,
      },
      "proof_sha256"
    );
  }

  it("accepts an exact pair proof and rejects a misbound identity, primary, or self pair", () => {
    expect(() => validateScaP08DuplicateEquivalenceProofV1(proof())).not.toThrow();
    // A substituted item identity no longer derives the recorded item id.
    expect(() =>
      validateScaP08DuplicateEquivalenceProofV1(
        proof({ duplicate_item_identity: `p06act_${"9".repeat(64)}` })
      )
    ).toThrow();
    // A drifted primary digest is rejected.
    expect(() =>
      validateScaP08DuplicateEquivalenceProofV1(proof({ duplicate_primary_sha256: "3".repeat(64) }))
    ).toThrow();
    // Equating an item with itself is not a duplicate.
    expect(() =>
      validateScaP08DuplicateEquivalenceProofV1(
        proof({
          target_item_id: SELF_ID,
          target_item_kind: "action",
          target_item_identity: `p06act_${HEX}`,
          target_primary_ref: ref("sca-p06-action-record", "1".repeat(64)),
          target_primary_sha256: "1".repeat(64),
        })
      )
    ).toThrow();
  });
});

describe("SCA P08 admitted scope-decision allowlist", () => {
  const PAYLOAD_ITEM = {
    item_id: SELF_ID,
    item_kind: "action" as const,
    identity: `p06act_${HEX}`,
    hypothesis_id: null,
    primary_ref: ref("sca-p06-action-record"),
    p07_status: null,
    p07_evidence_refs: [],
    p07_ledger_row_operation_id: null,
    hypothesis: null,
    prior_disposition_ref: null,
    equivalence_proof_refs: [],
    excerpt: "action excerpt",
  };

  function payload(scopeDecisionRefs: readonly ArtifactRef[]): unknown {
    return withP08Digest(
      {
        schema_id: SCA_P08_COGNITIVE_PAYLOAD_SCHEMA,
        schema_version: 1,
        run_id: "run",
        phase_id: "SCA-P08",
        call_id: "sca-p08-evidence-based-disposition",
        role: "evidence_disposition_assessor",
        purpose: "p08_evidence_based_disposition",
        required_model: { ...SCA_P08_REQUIRED_MODEL },
        p07_terminal_ref: ref("sca-p07-terminal"),
        p07_transition_ref: null,
        p07_evidence_ledger_ref: ref("sca-p07-evidence-ledger"),
        disclosure_scope_ref: ref("sca-p08-disclosure-scope"),
        scope_decision_refs: scopeDecisionRefs,
        assessment_ref: null,
        assigned_item_ids: [SELF_ID],
        items: [PAYLOAD_ITEM],
        content_mode: "p07_ledger_p06_hypothesis_obligation_and_prior_disposition_projections",
      },
      "payload_sha256"
    );
  }

  it("names only campaign/source scope kinds, never disclosure policy or handoff transitions", () => {
    expect(SCA_P08_SCOPE_DECISION_KINDS).toEqual(["sca-p06-accepted-cohort", "source-snapshot"]);
    expect(isScaP08ScopeDecisionKind("sca-p06-accepted-cohort")).toBe(true);
    expect(isScaP08ScopeDecisionKind("source-snapshot")).toBe(true);
    expect(isScaP08ScopeDecisionKind("sca-p06-disclosure-scope")).toBe(false);
    expect(isScaP08ScopeDecisionKind("sca-p08-disclosure-scope")).toBe(false);
    expect(isScaP08ScopeDecisionKind("sca-p06-to-p07-transition")).toBe(false);
    expect(isScaP08ScopeDecisionKind("sca-p07-to-p08-transition")).toBe(false);
    expect(isScaP08ScopeDecisionKind("sca-p06-action-record")).toBe(false);
  });

  it("requires a payload scope-decision projection of allowlisted kinds only", () => {
    expect(() =>
      validateScaP08CognitivePayloadV1(
        payload([
          ref("sca-p06-accepted-cohort", "b".repeat(64)),
          ref("source-snapshot", "e".repeat(64)),
        ])
      )
    ).not.toThrow();
    // A handoff transition is a lineage ref, not a scope decision.
    expect(() =>
      validateScaP08CognitivePayloadV1(payload([ref("sca-p07-to-p08-transition", "b".repeat(64))]))
    ).toThrow();
    // A provider disclosure policy is not campaign/source scope.
    expect(() =>
      validateScaP08CognitivePayloadV1(payload([ref("sca-p06-disclosure-scope", "b".repeat(64))]))
    ).toThrow();
    // The projection is mandatory.
    expect(() => validateScaP08CognitivePayloadV1(payload([]))).toThrow();
  });
});
