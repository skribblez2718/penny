import path from "node:path";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, JsonValue, OutputArtifactMetadata } from "../dist/contracts.js";
import {
  SCA_P11_CANDIDATE_START_SCHEMA,
  SCA_P11_DISCLOSURE_SCOPE_SCHEMA,
  SCA_P11_REPORT_POLICY_SCHEMA,
  SCA_P11_REVIEWER_IDENTITY_ID,
  SCA_P11_REVIEWER_LINEAGE_ID,
  SCA_P11_SCORING_POLICY_SCHEMA,
  validateScaP11CandidateStartV1,
  validateScaP11DisclosureScopeV1,
  validateScaP11ReportPolicyV1,
  validateScaP11ScoringPolicyV1,
  withP11Digest,
  type ScaP11CandidateStartV1,
} from "../dist/sca/p11-contracts.js";
import { admitScaP10Learning } from "../dist/sca/p10-admission.js";
import { SCA_P11_FIXTURE_CVSS_QUALIFICATION } from "../dist/sca/p11-scoring.js";
import {
  SCA_P10_ADMISSION_SCHEMA,
  SCA_P10_ELIGIBILITY_LEDGER_SCHEMA,
  SCA_P10_GATE_SCHEMA,
  SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA,
  SCA_P10_TERMINAL_SCHEMA,
  SCA_P10_TO_P11_TRANSITION_SCHEMA,
  validateScaP10GateV1,
  validateScaP10RuleLearningOutcomeV1,
  validateScaP10TerminalV1,
  validateScaP10ToP11TransitionV1,
  withP10Digest,
} from "../dist/sca/p10-contracts.js";
import { validateScaP09ReconciliationLedgerV1 } from "../dist/sca/p09-contracts.js";
import {
  buildScaP10Lineage,
  baseConstraints,
  driveScaP09,
  type ScaP10LineageV1,
  type ScaP10P09ResultV1,
} from "./sca-p10-lineage.js";
import { buildScaP09Lineage, type ScaP09LineageV1 } from "./sca-p09-lineage.js";

const NOW = "2026-10-02T00:00:05.000Z";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

export interface P11BuildInputV1 {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly confirmed: boolean;
  readonly accepted: boolean;
  readonly kinds?: readonly ("source_query" | "graph_query" | "application_test")[];
  /** `incomplete_closeout` keeps the report honest and incomplete; `learning_complete` closes it. */
  readonly p10_status?: "learning_complete" | "learning_incomplete";
  /** When false, the report content policy omits entries so findings stay incomplete. */
  readonly report_policy_complete?: boolean;
}

export interface ScaP11LineageV1 {
  readonly run_id: string;
  readonly p10: ScaP10LineageV1;
  readonly p09: ScaP09LineageV1;
  readonly p09_result: ScaP10P09ResultV1;
  readonly p10_terminal_ref: ArtifactRef;
  readonly p10_transition_ref: ArtifactRef;
  readonly p10_outcome_ref: ArtifactRef;
  readonly p10_gate_ref: ArtifactRef;
  readonly constraints: ScaP11CandidateStartV1;
}

function save(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly phase: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly schema_id: string;
  readonly value: unknown;
  readonly producer?: string;
  readonly upstream_refs?: readonly ArtifactRef[];
  readonly media_type?: string;
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.run_id,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation_id,
    version: 1,
    producer: input.producer ?? "host:sca-p11-lineage",
    media_type: input.media_type ?? "application/json",
    content_schema: { schema_id: input.schema_id, schema_version: 1 },
    parent_ref: null,
    upstream_refs: [...(input.upstream_refs ?? [])],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}

function nonNull<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}

const COVERAGE_FULL: NonNullable<Parameters<typeof buildScaP09Lineage>[0]["coverage"]> = {
  entries: [
    { surface_kind: "normalized_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "graph_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "p04_selected_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "omitted_surface", coverage_state: "omitted", reason: "no omission candidate" },
  ],
};

export function buildScaP11Lineage(input: P11BuildInputV1): ScaP11LineageV1 {
  const { store } = input;
  const kinds = input.kinds ?? (["source_query"] as const);
  const p09 = buildScaP09Lineage({
    store,
    run_id: input.run_id,
    kinds,
    completed_indices: kinds.map((_, index) => index),
    disposition_for: () => (input.confirmed ? "confirmed" : "inconclusive"),
    repository_location_for: () => ({ path: "src/example.php", line_start: 10, line_end: 12 }),
    ...(input.accepted ? { resolutions: "all_due" as const, coverage: COVERAGE_FULL } : {}),
  });
  const p09Result = driveScaP09({ store, p09 });
  const p10 = buildScaP10Lineage({
    store,
    p09,
    p09_result: p09Result,
    baseline_languages: ["php"],
  });

  const rederived = admitScaP10Learning({
    store,
    run_id: input.run_id,
    p09_terminal_ref: p10.constraints.p09_terminal_ref,
    p09_transition_ref: p10.constraints.p09_transition_ref,
    p09_reconciliation_ledger_ref: p10.constraints.p09_reconciliation_ledger_ref,
    p09_gate_ref: p10.constraints.p09_gate_ref,
    p09_admission_ref: p10.constraints.p09_admission_ref,
    p08_terminal_ref: p10.constraints.p08_terminal_ref,
    p08_transition_ref: p10.constraints.p08_transition_ref,
    p08_evidence_ledger_ref: p10.constraints.p08_evidence_ledger_ref,
    p08_gate_ref: p10.constraints.p08_gate_ref,
    p08_admission_ref: p10.constraints.p08_admission_ref,
    p08_item_universe_ref: p10.constraints.p08_item_universe_ref,
    p01_obligation_ledger_ref: p10.constraints.p01_obligation_ledger_ref,
    p09_coverage_input_ref: p10.constraints.p09_coverage_input_ref,
    p09_phase_evidence_refs: p10.constraints.p09_phase_evidence_refs,
    p09_obligation_resolution_ref: p10.constraints.p09_obligation_resolution_ref,
    p09_reassessment_ref: p10.constraints.p09_reassessment_ref,
    baseline_evidence_ref: p10.constraints.baseline_evidence_ref,
    disclosure_scope_ref: p10.constraints.disclosure_scope_ref,
    promotion_authority_ref: p10.constraints.promotion_authority_ref,
    active_run_rule_release_refs: p10.constraints.active_run_rule_release_refs,
    p10_reassessment_ref: p10.constraints.p10_reassessment_ref,
    p10_prior_eligibility_ledger_ref: p10.constraints.p10_prior_ledger_ref,
  });
  // Persist the exact recorded P10 admission and eligibility ledger so the P11 reportable lane
  // re-derives against the complete recorded P10 record set (§4.1) rather than an absent set.
  const p10AdmissionRef = save({
    store,
    run_id: input.run_id,
    phase: "SCA-P10",
    kind: "sca-p10-admission",
    operation_id: "sca-p11-lineage-p10-admission",
    schema_id: SCA_P10_ADMISSION_SCHEMA,
    value: rederived.admission,
  });
  const p10EligibilityRef =
    rederived.eligibility === null
      ? null
      : save({
          store,
          run_id: input.run_id,
          phase: "SCA-P10",
          kind: "sca-p10-eligibility-ledger",
          operation_id: "sca-p11-lineage-p10-eligibility",
          schema_id: SCA_P10_ELIGIBILITY_LEDGER_SCHEMA,
          value: rederived.eligibility,
        });
  const lane = rederived.lane;
  const completeLane = lane === "accepted_progression";
  const outcome = validateScaP10RuleLearningOutcomeV1(
    withP10Digest(
      {
        schema_id: SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P10" as const,
        run_id: input.run_id,
        disposition: "no_rule" as const,
        reason_code: "p10_no_eligible_finding_or_infeasible_rule",
        lane,
        eligibility_ledger_ref: nonNull(
          p10.constraints.p09_reconciliation_ledger_ref,
          "P09 reconciliation ledger"
        ),
        candidate_registry_ref: null,
        validation_manifest_ref: null,
        quarantine_records_ref: null,
        promotion_decisions_ref: null,
        eligible_refs: [...rederived.eligible_refs],
        ineligible_refs: [...rederived.ineligible_refs],
        unresolved_item_refs: [...rederived.unresolved_item_refs],
        candidate_count: 0,
        validated_candidate_count: 0,
        quarantined_candidate_count: 0,
        blocked_candidate_count: 0,
        false_negative_count: rederived.eligibility?.false_negative_count ?? 0,
        baseline_hit_count: rederived.eligibility?.baseline_hit_count ?? 0,
        coverage_gap_count: rederived.eligibility?.coverage_gap_count ?? 0,
        missing_downstream_artifacts: [
          "penny.sca-p11-reconciliation.v1",
          "penny.sca-p11-report.v1",
          "penny.sca-p11-validation-records.v1",
          "penny.sca-p12-release-record.v1",
        ],
        required_downstream_obligation_ids: [
          "SCA-OBL-P11-ACCEPTANCE",
          "SCA-OBL-P12-ACCEPTANCE",
          "SCA-OBL-REPORT-RECONCILIATION",
        ],
        blocker_codes: [],
        non_positive: true as const,
      },
      "outcome_sha256"
    )
  );
  const outcomeRef = save({
    store,
    run_id: input.run_id,
    phase: "SCA-P10",
    kind: "sca-p10-rule-learning-outcome",
    operation_id: "sca-p11-lineage-p10-outcome",
    schema_id: SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA,
    value: outcome,
  });
  const gate = validateScaP10GateV1(
    withP10Digest(
      {
        schema_id: SCA_P10_GATE_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P10" as const,
        criterion_id: "AC-P10" as const,
        verdict: completeLane ? ("pass_ready" as const) : ("pass_blocked" as const),
        learning_outcome_ref: outcomeRef,
        lane,
        outcome_disposition: "no_rule" as const,
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
        eligible_count: rederived.eligible_refs.length,
        candidate_count: 0,
        validated_candidate_count: 0,
        quarantined_candidate_count: 0,
        blocked_candidate_count: 0,
        false_negative_count: 0,
        coverage_gap_count: 0,
        blocker_codes: [],
        evaluated_at: NOW,
      },
      "gate_sha256"
    )
  );
  const gateRef = save({
    store,
    run_id: input.run_id,
    phase: "SCA-P10",
    kind: "sca-p10-gate",
    operation_id: "sca-p11-lineage-p10-gate",
    schema_id: SCA_P10_GATE_SCHEMA,
    value: gate,
  });
  // The terminal binds its own handoff, so persist the transition first; the transition references
  // the terminal only through the lane and the shared eligible/ineligible/unresolved sets.
  const transition = validateScaP10ToP11TransitionV1(
    withP10Digest(
      {
        schema_id: SCA_P10_TO_P11_TRANSITION_SCHEMA,
        schema_version: 1 as const,
        source_phase_id: "SCA-P10" as const,
        target_phase_id: "SCA-P11" as const,
        handoff_kind: "eligible_only_learning_evidence_only" as const,
        qualification_scope: "learning_gate_only_not_p11_reporting" as const,
        phase_gate_passed: false as const,
        p11_reporting_authorized_by_this_transition: false as const,
        release_eligible: false as const,
        campaign_complete: false as const,
        campaign_completion_claimed: false as const,
        p09_terminal_ref: p10.constraints.p09_terminal_ref,
        p09_reconciliation_ledger_ref: nonNull(
          p10.constraints.p09_reconciliation_ledger_ref,
          "ledger"
        ),
        p09_gate_ref: nonNull(p10.constraints.p09_gate_ref, "gate"),
        learning_outcome_ref: outcomeRef,
        gate_ref: gateRef,
        candidate_registry_ref: null,
        quarantine_records_ref: null,
        promotion_decisions_ref: null,
        frozen_rule_release_ref: p10.frozen_rule_release_ref,
        lane,
        eligible_refs: [...rederived.eligible_refs],
        ineligible_refs: [...rederived.ineligible_refs],
        unresolved_item_refs: [...rederived.unresolved_item_refs],
        required_gaps_retained: true as const,
      },
      "transition_sha256"
    )
  );
  const transitionRef = save({
    store,
    run_id: input.run_id,
    phase: "SCA-P10",
    kind: "sca-p10-to-p11-transition",
    operation_id: "sca-p11-lineage-p10-transition",
    schema_id: SCA_P10_TO_P11_TRANSITION_SCHEMA,
    value: transition,
  });
  const terminalBound = validateScaP10TerminalV1(
    withP10Digest(
      {
        schema_id: SCA_P10_TERMINAL_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P10" as const,
        status: (completeLane ? "learning_complete" : "learning_incomplete") as
          | "learning_complete"
          | "learning_incomplete",
        lane,
        learning_outcome_ref: outcomeRef,
        gate_ref: gateRef,
        p11_transition_ref: transitionRef,
        p11_handoff_ready: true,
        eligibility_ledger_ref: null,
        promotion_performed: false,
        promotion_receipt_ref: null,
        outcome_disposition: "no_rule" as const,
        eligible_refs: [...rederived.eligible_refs],
        ineligible_refs: [...rederived.ineligible_refs],
        missing_downstream_artifacts: [
          "penny.sca-p11-reconciliation.v1",
          "penny.sca-p11-report.v1",
          "penny.sca-p11-validation-records.v1",
          "penny.sca-p12-release-record.v1",
        ],
        required_downstream_obligation_ids: [
          "SCA-OBL-P11-ACCEPTANCE",
          "SCA-OBL-P12-ACCEPTANCE",
          "SCA-OBL-REPORT-RECONCILIATION",
        ],
        selected_artifact_refs: [],
        blocker_codes: [],
        phase_gate_passed: false as const,
        release_eligible: false as const,
        campaign_complete: false as const,
        nonterminal_campaign: true as const,
        p12_release_authorized: false as const,
        report_or_release_adjudication_performed: false as const,
      },
      "terminal_sha256"
    )
  );
  const terminalRef = save({
    store,
    run_id: input.run_id,
    phase: "SCA-P10",
    kind: "sca-p10-terminal",
    operation_id: "sca-p11-lineage-p10-terminal",
    schema_id: SCA_P10_TERMINAL_SCHEMA,
    value: terminalBound,
  });

  // --- P11 caller constraints -----------------------------------------------------------------
  const ledger = validateScaP09ReconciliationLedgerV1(
    JSON.parse(
      store
        .readById(nonNull(p10.constraints.p09_reconciliation_ledger_ref, "ledger").artifact_id)
        .toString("utf8")
    )
  );
  const confirmedIdentities = ledger.items
    .filter((item) => item.p08_disposition === "confirmed")
    .map((item) => item.identity);
  const vectorBase = [
    { metric: "AV" as const, value: "N" },
    { metric: "AC" as const, value: "L" },
    { metric: "AT" as const, value: "N" },
    { metric: "PR" as const, value: "N" },
    { metric: "UI" as const, value: "N" },
    { metric: "VC" as const, value: "H" },
    { metric: "VI" as const, value: "H" },
    { metric: "VA" as const, value: "H" },
    { metric: "SC" as const, value: "N" },
    { metric: "SI" as const, value: "N" },
    { metric: "SA" as const, value: "N" },
  ];
  const scoringPolicy = validateScaP11ScoringPolicyV1(
    withP11Digest(
      {
        schema_id: SCA_P11_SCORING_POLICY_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: input.run_id,
        entries:
          input.report_policy_complete === false
            ? []
            : [...new Set(confirmedIdentities)].sort().map((identity) => ({
                target_id: identity,
                base_metrics: vectorBase,
                threat_metrics: [],
                environmental_metrics: [],
                exception_shape: "scored" as const,
                rationale: "Admitted metric assignment; the qualified scorer supplies the number.",
                evidence_refs: [],
              })),
      },
      "policy_sha256"
    )
  );
  const scoringPolicyRef = save({
    store,
    run_id: input.run_id,
    phase: "SCA-P11",
    kind: "sca-p11-scoring-policy",
    operation_id: "sca-p11-lineage-scoring-policy",
    schema_id: SCA_P11_SCORING_POLICY_SCHEMA,
    value: scoringPolicy,
  });
  const reportPolicy = validateScaP11ReportPolicyV1(
    withP11Digest(
      {
        schema_id: SCA_P11_REPORT_POLICY_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: input.run_id,
        statements: {
          assessment_identity: "Inactive SCA P11 provider-free lineage fixture.",
          scope_statement: "Scope: the exact reconciled record universe of the fixture run.",
          coverage_statement:
            "Coverage: every reconciled record is accounted for exactly once; unresolved gaps are retained.",
          rule_learning_statement:
            "Rule learning: the recorded P10 outcome is projected without promoting or re-learning anything.",
          tools_statement:
            "Tools: the deterministic reporting fixtures only; no scanner or provider ran.",
          executive_summary:
            "This fixture report projects the recorded analysis and does not assert that the analyzed software is safe.",
        },
        entries:
          input.report_policy_complete === false
            ? []
            : [...new Set(confirmedIdentities)].sort().map((identity) => ({
                identity,
                title: `Fixture finding for ${identity.slice(0, 24)}`,
                cwe_id: "CWE-79",
                cwe_name:
                  "Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting')",
                threat_model_id: "{T-EXAMPLE}",
                description: "Fixture description grounded in the exact reconciled evidence.",
                steps_to_reproduce: [
                  "NOT RUN — planned reproduction from the exact admitted evidence.",
                ],
                code_analysis: [
                  "input → propagation → security-sensitive sink, cited from the complete repository-root path.",
                ],
                remediation:
                  "Apply the application-specific fix in the cited handler and add the referenced regression test.",
                status_note: null,
                evidence_refs: [],
              })),
      },
      "policy_sha256"
    )
  );
  const reportPolicyRef = save({
    store,
    run_id: input.run_id,
    phase: "SCA-P11",
    kind: "sca-p11-report-policy",
    operation_id: "sca-p11-lineage-report-policy",
    schema_id: SCA_P11_REPORT_POLICY_SCHEMA,
    value: reportPolicy,
  });
  const disclosureScope = validateScaP11DisclosureScopeV1(
    withP11Digest(
      {
        schema_id: SCA_P11_DISCLOSURE_SCOPE_SCHEMA,
        schema_version: 1 as const,
        run_id: input.run_id,
        phase_id: "SCA-P11" as const,
        required_model: {
          schema_version: 1 as const,
          alias: "deepseek-flash" as const,
          provider: "ollama" as const,
          model: "deepseek-v4.1-flash:cloud" as const,
          override: "ollama/deepseek-v4.1-flash:cloud" as const,
        },
        destination_class: "cloud" as const,
        purpose: "p11_report_semantic_review" as const,
        allowed_data_classes: [
          "report_assertion_projections",
          "finding_evidence_excerpts",
          "source_pointer_projections",
        ] as const,
        provider_retention_status: "known" as const,
        provider_retention_days: 0,
        provider_logging_status: "disabled" as const,
        provider_logging_days: 0,
        provider_training_use: "prohibited" as const,
        max_payload_bytes_per_call: 786_432,
        max_provider_calls: 8,
        decision: "allow" as const,
        blocker_codes: [],
        issued_at: NOW,
      },
      "scope_sha256"
    )
  );
  const disclosureScopeRef = save({
    store,
    run_id: input.run_id,
    phase: "SCA-P11",
    kind: "sca-p11-disclosure-scope",
    operation_id: "sca-p11-lineage-disclosure-scope",
    schema_id: SCA_P11_DISCLOSURE_SCOPE_SCHEMA,
    value: disclosureScope,
  });
  // A distinct admitted repair scope. The review scope never silently authorizes the repair call
  // (`P11-R16`, report standard §7).
  const repairDisclosureScope = validateScaP11DisclosureScopeV1(
    withP11Digest(
      {
        ...(() => {
          const { scope_sha256: _ignore, ...body } = disclosureScope;
          return body;
        })(),
        purpose: "p11_report_bounded_repair" as const,
      },
      "scope_sha256"
    )
  );
  const repairDisclosureScopeRef = save({
    store,
    run_id: input.run_id,
    phase: "SCA-P11",
    kind: "sca-p11-disclosure-scope",
    operation_id: "sca-p11-lineage-repair-disclosure-scope",
    schema_id: SCA_P11_DISCLOSURE_SCOPE_SCHEMA,
    value: repairDisclosureScope,
  });

  const constraints = validateScaP11CandidateStartV1({
    schema_id: SCA_P11_CANDIDATE_START_SCHEMA,
    schema_version: 1,
    phase_id: "SCA-P11",
    run_id: input.run_id,
    p10_terminal_ref: terminalRef,
    p10_transition_ref: transitionRef,
    p10_outcome_ref: outcomeRef,
    p10_gate_ref: gateRef,
    p10_admission_ref: p10AdmissionRef,
    p10_eligibility_ledger_ref: p10EligibilityRef,
    p10_candidate_registry_ref: null,
    p09_terminal_ref: p09Result.terminal_ref,
    p09_transition_ref: p09Result.transition_ref,
    p09_reconciliation_ledger_ref: p09Result.ledger_ref,
    p09_gate_ref: p09Result.gate_ref,
    p09_admission_ref: p09Result.admission_ref,
    ...baseConstraints(p09),
    baseline_evidence_ref: p10.constraints.baseline_evidence_ref,
    p10_disclosure_scope_ref: p10.constraints.disclosure_scope_ref,
    promotion_authority_ref: p10.constraints.promotion_authority_ref,
    active_run_rule_release_refs: [...p10.constraints.active_run_rule_release_refs],
    p10_reassessment_ref: p10.constraints.p10_reassessment_ref,
    p10_prior_ledger_ref: p10.constraints.p10_prior_ledger_ref,
    p11_disclosure_scope_ref: disclosureScopeRef,
    p11_repair_disclosure_scope_ref: repairDisclosureScopeRef,
    scoring_policy_ref: scoringPolicyRef,
    report_policy_ref: reportPolicyRef,
    p11_reassessment_ref: null,
    p11_prior_report_ref: null,
  });

  return {
    run_id: input.run_id,
    p10,
    p09,
    p09_result: p09Result,
    p10_terminal_ref: terminalRef,
    p10_transition_ref: transitionRef,
    p10_outcome_ref: outcomeRef,
    p10_gate_ref: gateRef,
    constraints,
  };
}

/**
 * Persist the exact official FIRST CVSS v4.0 qualification receipt used by provider-free tests and
 * return its immutable artifact ref, so tests bind a receipt rather than an object shape.
 */
export function persistScaP11FixtureQualification(
  store: ArtifactStore,
  runId: string
): ArtifactRef {
  return save({
    store,
    run_id: runId,
    phase: "SCA-P11",
    kind: "sca-p11-scorer-qualification",
    operation_id: "sca-p11-fixture-scorer-qualification",
    schema_id: "penny.sca-p11-scorer-qualification.v1",
    value: SCA_P11_FIXTURE_CVSS_QUALIFICATION,
  });
}

/** Persist an arbitrary (possibly fabricated) scorer qualification for rejection tests. */
export function persistScaP11QualificationValue(
  store: ArtifactStore,
  runId: string,
  qualification: unknown,
  operationId = "sca-p11-test-scorer-qualification"
): ArtifactRef {
  return save({
    store,
    run_id: runId,
    phase: "SCA-P11",
    kind: "sca-p11-scorer-qualification",
    operation_id: operationId,
    schema_id: "penny.sca-p11-scorer-qualification.v1",
    value: qualification,
  });
}

export function slotsForP11(constraints: ScaP11CandidateStartV1): {
  readonly slot: string;
  readonly ref: ArtifactRef;
}[] {
  const optional = (slot: string, ref: ArtifactRef | null): { slot: string; ref: ArtifactRef }[] =>
    ref === null ? [] : [{ slot, ref }];
  return [
    { slot: "p10_terminal", ref: constraints.p10_terminal_ref },
    ...optional("p10_transition", constraints.p10_transition_ref),
    ...optional("p10_outcome", constraints.p10_outcome_ref),
    ...optional("p10_gate", constraints.p10_gate_ref),
    ...optional("p10_admission", constraints.p10_admission_ref),
    ...optional("p10_eligibility_ledger", constraints.p10_eligibility_ledger_ref),
    ...optional("p10_candidate_registry", constraints.p10_candidate_registry_ref),
    { slot: "p09_terminal", ref: constraints.p09_terminal_ref },
    ...optional("p09_transition", constraints.p09_transition_ref),
    ...optional("p09_reconciliation_ledger", constraints.p09_reconciliation_ledger_ref),
    ...optional("p09_gate", constraints.p09_gate_ref),
    ...optional("p09_admission", constraints.p09_admission_ref),
    { slot: "p08_terminal", ref: constraints.p08_terminal_ref },
    ...optional("p08_transition", constraints.p08_transition_ref),
    ...optional("p08_evidence_ledger", constraints.p08_evidence_ledger_ref),
    ...optional("p08_gate", constraints.p08_gate_ref),
    ...optional("p08_admission", constraints.p08_admission_ref),
    ...optional("p08_item_universe", constraints.p08_item_universe_ref),
    { slot: "p01_obligation_ledger", ref: constraints.p01_obligation_ledger_ref },
    { slot: "baseline_evidence", ref: constraints.baseline_evidence_ref },
    { slot: "p10_disclosure_scope", ref: constraints.p10_disclosure_scope_ref },
    { slot: "promotion_authority", ref: constraints.promotion_authority_ref },
    ...constraints.active_run_rule_release_refs.map((ref, index) => ({
      slot: `active_run_rule_release_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...optional("p09_coverage_input", constraints.p09_coverage_input_ref),
    ...constraints.p09_phase_evidence_refs.map((ref, index) => ({
      slot: `p09_phase_evidence_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...optional("p09_obligation_resolution", constraints.p09_obligation_resolution_ref),
    ...optional("p09_reassessment", constraints.p09_reassessment_ref),
    ...optional("p10_reassessment", constraints.p10_reassessment_ref),
    ...optional("p10_prior_ledger", constraints.p10_prior_ledger_ref),
    { slot: "p11_disclosure_scope", ref: constraints.p11_disclosure_scope_ref },
    ...optional("p11_repair_disclosure_scope", constraints.p11_repair_disclosure_scope_ref),
    { slot: "scoring_policy", ref: constraints.scoring_policy_ref },
    { slot: "report_policy", ref: constraints.report_policy_ref },
    ...optional("p11_reassessment", constraints.p11_reassessment_ref),
    ...optional("p11_prior_report", constraints.p11_prior_report_ref),
  ];
}

export const P11_PROJECT_ROOT = PROJECT_ROOT;
export type { ScaP10LineageV1, ScaP10P09ResultV1 };

export interface ScaP11ReviewOutputInputV1 {
  readonly run_id: string;
  readonly report_ref: ArtifactRef;
  readonly payload: {
    readonly payload_sha256: string;
    readonly revision?: number;
    readonly assigned_assertion_ids: readonly string[];
    readonly assertions: readonly {
      readonly assertion_id: string;
      readonly target_id: string;
      readonly evidence_allowlist: readonly ArtifactRef[];
    }[];
  };
  readonly open_items?: readonly {
    readonly open_item_id: string;
    readonly target_id: string;
    readonly severity: "blocking" | "actionable";
    readonly evidence_refs: readonly ArtifactRef[];
    readonly disposition: "repaired" | "retained-incomplete" | "dismissed-with-evidence";
  }[];
}

/** Build the exact closed semantic-review output a stub reviewer would return. */
export function stubScaP11ReviewOutput(
  input: ScaP11ReviewOutputInputV1
): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = {
    schema_id: "penny.sca-p11-semantic-review.v1",
    schema_version: 1,
    run_id: input.run_id,
    phase_id: "SCA-P11",
    call_id: "sca-p11-semantic-review",
    role: "report_semantic_reviewer",
    reviewer_identity_id: SCA_P11_REVIEWER_IDENTITY_ID,
    reviewer_lineage_id: SCA_P11_REVIEWER_LINEAGE_ID,
    revision: input.payload.revision ?? 1,
    report_ref: input.report_ref,
    report_sha256: input.report_ref.content_digest,
    payload_sha256: input.payload.payload_sha256,
    verdicts: input.payload.assertions.map((assertion) => ({
      assertion_id: assertion.assertion_id,
      target_id: assertion.target_id,
      verdict: "supported",
      reason: "Resolved to the exact admitted evidence in the payload.",
      evidence_refs: [...assertion.evidence_allowlist],
      repair_candidate: null,
    })),
    open_items: (input.open_items ?? []).map((item) => ({
      open_item_id: item.open_item_id,
      target_id: item.target_id,
      severity: item.severity,
      evidence_refs: [...item.evidence_refs],
      disposition: item.disposition,
    })),
    gate_verdict_set: false,
    complete: true,
  };
  return withP11Digest(body, "review_sha256");
}

export interface ScaP11RepairPatchInputV1 {
  readonly run_id: string;
  readonly payload: {
    readonly revision: number;
    readonly payload_sha256: string;
    readonly report_ref: ArtifactRef;
  };
  readonly operations: readonly {
    readonly operation: "rewrite_prose" | "add_section" | "correct_status_note";
    readonly target_id: string;
    readonly field:
      | "description"
      | "remediation"
      | "status_note"
      | "steps_to_reproduce"
      | "code_analysis";
    readonly value: string;
  }[];
}

/** Build the exact closed bounded-repair patch a stub reviewer would return. */
export function stubScaP11RepairPatch(input: ScaP11RepairPatchInputV1): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = {
    schema_id: "penny.sca-p11-repair-patch.v1",
    schema_version: 1,
    run_id: input.run_id,
    phase_id: "SCA-P11",
    call_id: "sca-p11-bounded-repair",
    role: "report_semantic_reviewer",
    repairer_identity_id: SCA_P11_REVIEWER_IDENTITY_ID,
    repairer_lineage_id: SCA_P11_REVIEWER_LINEAGE_ID,
    revision: input.payload.revision,
    report_ref: input.payload.report_ref,
    report_sha256: input.payload.report_ref.content_digest,
    payload_sha256: input.payload.payload_sha256,
    operations: input.operations.map((operation) => ({
      operation: operation.operation,
      target_id: operation.target_id,
      field: operation.field,
      value: operation.value,
    })),
    no_metadata_upgrade: true,
    no_finding_removed: true,
    complete: true,
  };
  return withP11Digest(body, "patch_sha256");
}
