import type { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import {
  SCA_OBLIGATION_LEDGER_V2_SCHEMA,
  appendScaObligationLedgerV2,
  buildScaInitialObligationLedgerV2,
} from "../dist/sca/p01-contracts.js";
import {
  SCA_P08_ADMISSION_SCHEMA,
  SCA_P08_DISPOSITION_REVISION_SCHEMA,
  SCA_P08_EVIDENCE_LEDGER_SCHEMA,
  SCA_P08_GATE_SCHEMA,
  SCA_P08_ITEM_UNIVERSE_SCHEMA,
  SCA_P08_TERMINAL_SCHEMA,
  SCA_P08_TO_P09_TRANSITION_SCHEMA,
  withP08Digest,
  type ScaP08DispositionKindV1,
  type ScaP08ItemKindV1,
} from "../dist/sca/p08-contracts.js";
import {
  SCA_P09_COVERAGE_EVIDENCE_BY_SURFACE,
  SCA_P09_COVERAGE_INPUT_SCHEMA,
  SCA_P09_OBLIGATION_RESOLUTION_SCHEMA,
  scaP09CoverageEntryIdentity,
  scaP09ExpectedResolutionEvidence,
  scaP09PhaseEvidenceBinding,
  validateScaP09CoverageInputV1,
  validateScaP09ObligationResolutionV1,
  withP09Digest,
  type ScaP09CoverageInputV1,
  type ScaP09ObligationResolutionEntryV1,
} from "../dist/sca/p09-contracts.js";
import { scaP09DueObligationIds } from "../dist/sca/p09-admission.js";
import type { ScaObligationLedgerV2 } from "../dist/sca/p01-contracts.js";
import { buildScaP08Lineage } from "./sca-p08-lineage.js";
import type { ScaP07LineageKind } from "./sca-p07-lineage.js";

/**
 * Focused test-only P07→P08→P09 lineage builder. It reuses the exact P08 lineage fixture, records
 * one immutable P08 disposition revision per admitted item, and persists a valid P08 evidence
 * ledger, gate, non-authorizing P09 transition, terminal, a P01 obligation ledger, and optionally
 * an explicit coverage input. It calls no model, broker, tool, or VM.
 */
const NOW = "2026-09-26T00:00:00.000Z";
const TENANT = "tenant";
const PROJECT = "project";

export interface ScaP09LineageV1 {
  readonly run_id: string;
  readonly p08_terminal_ref: ArtifactRef;
  readonly p08_transition_ref: ArtifactRef;
  readonly p08_evidence_ledger_ref: ArtifactRef;
  readonly p08_gate_ref: ArtifactRef;
  readonly p08_admission_ref: ArtifactRef;
  readonly p08_item_universe_ref: ArtifactRef;
  readonly p01_obligation_ledger_ref: ArtifactRef;
  readonly p07_authority_ref: ArtifactRef;
  readonly coverage_input_ref: ArtifactRef | null;
  readonly coverage_input: ScaP09CoverageInputV1 | null;
  readonly phase_evidence_refs: readonly ArtifactRef[];
  readonly obligation_resolution_ref: ArtifactRef | null;
  readonly p08_gate_verdict: "pass_ready" | "pass_blocked" | "blocked_invalid";
  readonly p08_terminal_status: "candidate_complete" | "blocked" | "cancelled";
  readonly p08_items: readonly {
    readonly item_id: string;
    readonly item_kind: ScaP08ItemKindV1;
    readonly identity: string;
    readonly disposition: ScaP08DispositionKindV1;
  }[];
}

function save(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly phase: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly schema_id: string;
  readonly schema_version?: number;
  readonly value: unknown;
  readonly producer?: string;
  readonly upstream_refs?: readonly ArtifactRef[];
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.run_id,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation_id,
    version: 1,
    producer: input.producer ?? "host:sca-p09-lineage",
    media_type: "application/json",
    content_schema: { schema_id: input.schema_id, schema_version: input.schema_version ?? 1 },
    parent_ref: null,
    upstream_refs: [...(input.upstream_refs ?? [])],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}

interface SupportShape {
  readonly claim: string | null;
  readonly supporting_evidence_refs: readonly ArtifactRef[];
  readonly defeating_evidence_refs: readonly ArtifactRef[];
  readonly evidence_mode: "runtime" | "code" | "none";
  readonly actor_state_stimulus_verified: boolean;
  readonly target_reachability_observed: boolean;
  readonly distinguishing_oracle: string | null;
  readonly complete_code_control_state_evidence: boolean;
  readonly finite_clean_fuzzing_only: boolean;
  readonly unresolved_material_link: string | null;
  readonly resolution_evidence_need: string | null;
  readonly deferral_reason: string | null;
  readonly reopening_conditions: readonly string[];
  readonly duplicate_of_item_id: string | null;
  readonly equivalence_evidence_refs: readonly ArtifactRef[];
  readonly scope_evidence_ref: ArtifactRef | null;
  readonly repository_path: string | null;
  readonly line_start: number | null;
  readonly line_end: number | null;
}

function supportFor(
  disposition: ScaP08DispositionKindV1,
  evidenceRefs: readonly ArtifactRef[],
  primaryRef: ArtifactRef,
  location: {
    readonly path: string;
    readonly line_start: number;
    readonly line_end: number;
  } | null = null
): SupportShape {
  const base: SupportShape = {
    claim: null,
    supporting_evidence_refs: [],
    defeating_evidence_refs: [],
    evidence_mode: "none",
    actor_state_stimulus_verified: false,
    target_reachability_observed: false,
    distinguishing_oracle: null,
    complete_code_control_state_evidence: false,
    finite_clean_fuzzing_only: false,
    unresolved_material_link: null,
    resolution_evidence_need: null,
    deferral_reason: null,
    reopening_conditions: [],
    duplicate_of_item_id: null,
    equivalence_evidence_refs: [],
    scope_evidence_ref: null,
    repository_path: null,
    line_start: null,
    line_end: null,
  };
  const evidence = evidenceRefs.length === 0 ? [primaryRef] : [...evidenceRefs];
  switch (disposition) {
    case "confirmed":
      return {
        ...base,
        claim: "exact admitted claim",
        supporting_evidence_refs: evidence,
        evidence_mode: "runtime",
        actor_state_stimulus_verified: true,
        target_reachability_observed: true,
        repository_path: location?.path ?? null,
        line_start: location?.line_start ?? null,
        line_end: location?.line_end ?? null,
      };
    case "rejected-with-evidence":
      return {
        ...base,
        claim: "exact admitted claim",
        defeating_evidence_refs: evidence,
        evidence_mode: "runtime",
        actor_state_stimulus_verified: true,
        target_reachability_observed: true,
        distinguishing_oracle: "the exact observation separating the claim from its alternatives",
        repository_path: location?.path ?? "src/example.ts",
        line_start: location?.line_start ?? 10,
        line_end: location?.line_end ?? 12,
      };
    case "inconclusive":
      return {
        ...base,
        unresolved_material_link: "an unresolved material link",
        resolution_evidence_need: "the exact resolving evidence",
      };
    case "deferred":
      return {
        ...base,
        deferral_reason: "awaiting an admitted reopening condition",
        reopening_conditions: ["the admitted stimulus"],
      };
    default:
      return base;
  }
}

export interface ScaP09LineageInputV1 {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly kinds: readonly ScaP07LineageKind[];
  /** Plan item indices whose P07 row recorded a completed host operation. */
  readonly completed_indices?: readonly number[];
  /** Disposition per admitted P08 item identity; defaults to `inconclusive` for every item. */
  readonly disposition_for?: (identity: string, kind: ScaP08ItemKindV1) => ScaP08DispositionKindV1;
  /**
   * Optional exact repository location bound to a confirmed/refuted disposition revision. Absent
   * keeps the historical fixture posture (confirmed dispositions are unlocated).
   */
  readonly repository_location_for?: (
    identity: string,
    kind: ScaP08ItemKindV1
  ) => { readonly path: string; readonly line_start: number; readonly line_end: number } | null;
  /** Persist an explicit coverage input. Omitted means coverage is absent (R5 fail-closed). */
  readonly coverage?: {
    readonly entries: readonly {
      readonly surface_kind:
        | "normalized_candidate"
        | "graph_candidate"
        | "p04_selected_candidate"
        | "omitted_surface"
        | "excluded_surface"
        | "unsupported_surface"
        | "failed_surface"
        | "denied_surface"
        | "truncated_surface";
      readonly coverage_state:
        | "covered"
        | "excluded"
        | "unsupported"
        | "failed"
        | "denied"
        | "truncated"
        | "omitted";
      readonly reason: string | null;
    }[];
  };
  /** Build a cancelled P08 terminal with no ledger/gate/transition (non-reconcilable checkpoint). */
  readonly cancelled?: boolean;
  /**
   * Synthesize exact obligation-resolution evidence for every due P01 required-result obligation,
   * backed by per-obligation evidence artifacts of the admissible kind and phase. This is the only
   * way a run can evidence `accepted_progression`; a pending ledger entry is never enough.
   */
  readonly resolutions?: "all_due";
  /**
   * Append one exact promoted P01 obligation revision (strictly stronger class) so the effective
   * class derivation can be exercised against a promoted (not merely registered) revision.
   */
  readonly promote?: {
    readonly obligation_id: string;
    readonly requested_class: "required-result" | "attempt-and-report";
  };
  /**
   * Record a production-attested P08 admission by supplying an independent current P07 authority
   * resolver, so the encoded `p07_authority_assurance` is `attested_unchanged` rather than the
   * reduced fixture assurance. Absent (default) keeps the provider-free fixture posture.
   */
  readonly attest_p07_authority?: boolean;
}

export function buildScaP09Lineage(input: ScaP09LineageInputV1): ScaP09LineageV1 {
  const { store, run_id: runId } = input;
  const p08 = buildScaP08Lineage({
    store,
    run_id: runId,
    kinds: input.kinds,
    completed_indices: input.completed_indices ?? [],
    ...(input.attest_p07_authority === true ? { attest_p07_authority: true } : {}),
  });
  const admission = p08.admission.admission;
  const universe = p08.admission.universe;
  const dispositionFor = input.disposition_for ?? ((): ScaP08DispositionKindV1 => "inconclusive");

  if (input.cancelled === true) {
    const terminalRef = save({
      store,
      run_id: runId,
      phase: "SCA-P08",
      kind: "sca-p08-terminal",
      operation_id: "sca-p08-terminal",
      schema_id: SCA_P08_TERMINAL_SCHEMA,
      value: withP08Digest(
        {
          schema_id: SCA_P08_TERMINAL_SCHEMA,
          schema_version: 1,
          phase_id: "SCA-P08",
          status: "cancelled",
          evidence_ledger_ref: null,
          gate_ref: null,
          p09_transition_ref: null,
          p09_handoff_ready: false,
          item_count: 0,
          confirmed_count: 0,
          rejected_with_evidence_count: 0,
          inconclusive_count: 0,
          deferred_count: 0,
          duplicate_of_count: 0,
          out_of_scope_count: 0,
          selected_artifact_refs: [],
          blocker_codes: ["p08_cancelled"],
          phase_gate_passed: false,
          release_eligible: false,
          campaign_complete: false,
          nonterminal_campaign: true,
          report_or_finding_adjudication_performed: false,
        },
        "terminal_sha256"
      ),
    });
    const p01 = buildP01Ledger(store, runId, terminalRef);
    return {
      run_id: runId,
      p08_terminal_ref: terminalRef,
      p08_transition_ref: terminalRef,
      p08_evidence_ledger_ref: terminalRef,
      p08_gate_ref: terminalRef,
      p08_admission_ref: terminalRef,
      p08_item_universe_ref: terminalRef,
      p01_obligation_ledger_ref: p01.ref,
      p07_authority_ref: p08.p07_authority_ref,
      coverage_input_ref: null,
      coverage_input: null,
      phase_evidence_refs: [],
      obligation_resolution_ref: null,
      p08_gate_verdict: "blocked_invalid",
      p08_terminal_status: "cancelled",
      p08_items: [],
    };
  }

  const admissionRef = save({
    store,
    run_id: runId,
    phase: "SCA-P08",
    kind: "sca-p08-admission",
    operation_id: "sca-p08-admission",
    schema_id: SCA_P08_ADMISSION_SCHEMA,
    value: admission,
  });
  const universeRef = save({
    store,
    run_id: runId,
    phase: "SCA-P08",
    kind: "sca-p08-item-universe",
    operation_id: "sca-p08-item-universe",
    schema_id: SCA_P08_ITEM_UNIVERSE_SCHEMA,
    value: universe,
  });

  const revisionRefs: ArtifactRef[] = [];
  const rows: {
    item_id: string;
    item_kind: ScaP08ItemKindV1;
    identity: string;
    disposition: ScaP08DispositionKindV1;
    current_revision_ref: ArtifactRef;
    prior_revision_refs: ArtifactRef[];
    blocker_codes: string[];
  }[] = [];
  const itemSummaries: {
    readonly item_id: string;
    readonly item_kind: ScaP08ItemKindV1;
    readonly identity: string;
    readonly disposition: ScaP08DispositionKindV1;
  }[] = [];
  for (const item of p08.admission.items) {
    const disposition = dispositionFor(item.identity, item.item_kind);
    const location = input.repository_location_for?.(item.identity, item.item_kind) ?? null;
    const revision = save({
      store,
      run_id: runId,
      phase: "SCA-P08",
      kind: "sca-p08-disposition-revision",
      operation_id: `sca-p08-${item.item_id}-revision-000001`,
      schema_id: SCA_P08_DISPOSITION_REVISION_SCHEMA,
      value: withP08Digest(
        {
          schema_id: SCA_P08_DISPOSITION_REVISION_SCHEMA,
          schema_version: 1,
          phase_id: "SCA-P08",
          run_id: runId,
          item_id: item.item_id,
          item_kind: item.item_kind,
          identity: item.identity,
          revision: 1,
          parent_revision_ref: null,
          parent_revision_sha256: null,
          disposition,
          ...supportFor(disposition, item.p07_evidence_refs, item.primary_ref, location),
          review_verdict: null,
          review_ref: null,
          change_reason_codes: ["initial_construction"],
          changed_fields: [],
          created_at: NOW,
        },
        "revision_sha256"
      ),
    });
    revisionRefs.push(revision);
    rows.push({
      item_id: item.item_id,
      item_kind: item.item_kind,
      identity: item.identity,
      disposition,
      current_revision_ref: revision,
      prior_revision_refs: [],
      blocker_codes: [],
    });
    itemSummaries.push({
      item_id: item.item_id,
      item_kind: item.item_kind,
      disposition,
      identity: item.identity,
    });
  }
  const count = (disposition: ScaP08DispositionKindV1): number =>
    rows.filter((row) => row.disposition === disposition).length;
  const unresolvedRefs = rows
    .filter((row) => row.disposition === "inconclusive" || row.disposition === "deferred")
    .map((row) => row.current_revision_ref);
  const ledgerRef = save({
    store,
    run_id: runId,
    phase: "SCA-P08",
    kind: "sca-p08-evidence-ledger",
    operation_id: "sca-p08-evidence-ledger",
    schema_id: SCA_P08_EVIDENCE_LEDGER_SCHEMA,
    value: withP08Digest(
      {
        schema_id: SCA_P08_EVIDENCE_LEDGER_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P08",
        run_id: runId,
        admission_ref: admissionRef,
        p07_terminal_ref: admission.p07_terminal_ref,
        p07_transition_ref: admission.p07_transition_ref,
        p07_evidence_ledger_ref: admission.p07_evidence_ledger_ref,
        prior_p08_ledger_ref: null,
        prior_p08_ledger_sha256: null,
        ledger_revision: 1,
        append_only: true,
        items: rows,
        item_count: rows.length,
        confirmed_count: count("confirmed"),
        rejected_with_evidence_count: count("rejected-with-evidence"),
        inconclusive_count: count("inconclusive"),
        deferred_count: count("deferred"),
        duplicate_of_count: count("duplicate-of"),
        out_of_scope_count: count("out-of-scope"),
        unresolved_item_refs: unresolvedRefs,
        exhaustive_accounting: true,
        release_eligible: false,
        campaign_complete: false,
      },
      "ledger_sha256"
    ),
  });
  const unresolved = unresolvedRefs.length;
  const predicateHolds = unresolved === 0 && rows.length > 0;
  const verdict = predicateHolds ? ("pass_ready" as const) : ("pass_blocked" as const);
  const gateRef = save({
    store,
    run_id: runId,
    phase: "SCA-P08",
    kind: "sca-p08-gate",
    operation_id: "sca-p08-gate",
    schema_id: SCA_P08_GATE_SCHEMA,
    value: withP08Digest(
      {
        schema_id: SCA_P08_GATE_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P08",
        criterion_id: "AC-P08",
        verdict,
        evidence_ledger_ref: ledgerRef,
        p07_terminal_ref: admission.p07_terminal_ref,
        p07_transition_ref: admission.p07_transition_ref,
        p07_evidence_ledger_ref: admission.p07_evidence_ledger_ref,
        exhaustive_accounting: true,
        immutable_p07_lineage_valid: true,
        support_semantics_valid: predicateHolds,
        no_false_refutation: true,
        scope_duplicate_deferred_valid: true,
        append_only_revisions: true,
        retained_required_gaps: unresolved > 0,
        p09_or_report_or_release_claims_absent: true,
        item_count: rows.length,
        confirmed_count: count("confirmed"),
        rejected_with_evidence_count: count("rejected-with-evidence"),
        inconclusive_count: count("inconclusive"),
        deferred_count: count("deferred"),
        duplicate_of_count: count("duplicate-of"),
        out_of_scope_count: count("out-of-scope"),
        unresolved_item_count: unresolved,
        blocker_codes: unresolved > 0 ? ["p08_required_gaps_retained"] : [],
        evaluated_at: NOW,
      },
      "gate_sha256"
    ),
  });
  const transitionRef = save({
    store,
    run_id: runId,
    phase: "SCA-P08",
    kind: "sca-p08-to-p09-transition",
    operation_id: "sca-p08-to-p09-transition",
    schema_id: SCA_P08_TO_P09_TRANSITION_SCHEMA,
    value: withP08Digest(
      {
        schema_id: SCA_P08_TO_P09_TRANSITION_SCHEMA,
        schema_version: 1,
        source_phase_id: "SCA-P08",
        target_phase_id: "SCA-P09",
        handoff_kind: "candidate_disposition_only",
        qualification_scope: "disposition_gate_only_not_p09_reconciliation",
        phase_gate_passed: false,
        p09_reconciliation_authorized_by_this_transition: false,
        p07_terminal_ref: admission.p07_terminal_ref,
        p07_transition_ref: admission.p07_transition_ref,
        p07_evidence_ledger_ref: admission.p07_evidence_ledger_ref,
        p08_evidence_ledger_ref: ledgerRef,
        item_count: rows.length,
        confirmed_count: count("confirmed"),
        rejected_with_evidence_count: count("rejected-with-evidence"),
        inconclusive_count: count("inconclusive"),
        deferred_count: count("deferred"),
        duplicate_of_count: count("duplicate-of"),
        out_of_scope_count: count("out-of-scope"),
        unresolved_item_refs: unresolvedRefs,
        required_gaps_retained: true,
        release_eligible: false,
        campaign_complete: false,
        campaign_completion_claimed: false,
      },
      "transition_sha256"
    ),
  });
  const terminalRef = save({
    store,
    run_id: runId,
    phase: "SCA-P08",
    kind: "sca-p08-terminal",
    operation_id: "sca-p08-terminal",
    schema_id: SCA_P08_TERMINAL_SCHEMA,
    value: withP08Digest(
      {
        schema_id: SCA_P08_TERMINAL_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P08",
        status: predicateHolds ? "candidate_complete" : "blocked",
        evidence_ledger_ref: ledgerRef,
        gate_ref: gateRef,
        p09_transition_ref: transitionRef,
        p09_handoff_ready: true,
        item_count: rows.length,
        confirmed_count: count("confirmed"),
        rejected_with_evidence_count: count("rejected-with-evidence"),
        inconclusive_count: count("inconclusive"),
        deferred_count: count("deferred"),
        duplicate_of_count: count("duplicate-of"),
        out_of_scope_count: count("out-of-scope"),
        selected_artifact_refs: [ledgerRef, gateRef, transitionRef],
        blocker_codes: unresolved > 0 ? ["p08_required_gaps_retained"] : [],
        phase_gate_passed: false,
        release_eligible: false,
        campaign_complete: false,
        nonterminal_campaign: true,
        report_or_finding_adjudication_performed: false,
      },
      "terminal_sha256"
    ),
  });

  const { ref: initialP01Ref, ledger: initialP01Ledger } = buildP01Ledger(
    store,
    runId,
    admissionRef
  );
  let p01Ref = initialP01Ref;
  let p01Ledger = initialP01Ledger;
  if (input.promote !== undefined) {
    const promoted = appendScaObligationLedgerV2({
      prior_ledger: initialP01Ledger,
      prior_ledger_ref: initialP01Ref,
      authority_policy_ref: admissionRef,
      resource_policy_ref: initialP01Ref,
      operation: {
        schema_id: "penny.sca-obligation-revision-operation.v1",
        schema_version: 1,
        operation_id: "sca-p09-fixture-promotion",
        obligation_id: input.promote.obligation_id,
        requested_class: input.promote.requested_class,
        discovery_evidence_ref: admissionRef,
        assigning_authority_id: "authority",
        policy_refs: [admissionRef, initialP01Ref],
        rationale: "a fixture promotion to a strictly stronger class",
        scope_decision: "allow",
        authority_decision: "allow",
        resource_policy_decision: "allow",
        material: true,
        action_started: false,
        occurred_at: NOW,
        action: "promote",
        supporting_evidence_refs: [admissionRef],
      },
    });
    p01Ledger = promoted;
    p01Ref = save({
      store,
      run_id: runId,
      phase: "SCA-P01",
      kind: "sca-p01-candidate-obligation-ledger",
      operation_id: "sca-p01-candidate-obligation-ledger-promotion",
      schema_id: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
      schema_version: 2,
      value: promoted,
    });
  }
  let coverageInputRef: ArtifactRef | null = null;
  let coverageInput: ScaP09CoverageInputV1 | null = null;
  if (input.coverage !== undefined) {
    const entries = input.coverage.entries.map((entry, index) => {
      const binding = SCA_P09_COVERAGE_EVIDENCE_BY_SURFACE[entry.surface_kind];
      const evidenceKind = binding.kinds[0];
      const evidenceSchema = binding.schema_ids[0];
      if (evidenceKind === undefined || evidenceSchema === undefined) {
        throw new Error(`P09 coverage binding for ${entry.surface_kind} has no evidence`);
      }
      const primaryRef = save({
        store,
        run_id: runId,
        phase: binding.phase_id,
        kind: evidenceKind,
        operation_id: `sca-p09-coverage-evidence-${index}`,
        schema_id: evidenceSchema,
        value: { coverage_identity: `${entry.surface_kind}:${String(index)}` },
      });
      return {
        identity: scaP09CoverageEntryIdentity({
          surface_kind: entry.surface_kind,
          primary_ref: primaryRef,
        }),
        surface_kind: entry.surface_kind,
        primary_ref: primaryRef,
        coverage_state: entry.coverage_state,
        reason: entry.reason,
        blocker_codes: [],
      };
    });
    // Coverage identities are derived, never caller-ordered; sort them deterministically.
    entries.sort((left, right) =>
      left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0
    );
    const coverageValue = validateScaP09CoverageInputV1(
      withP09Digest(
        {
          schema_id: SCA_P09_COVERAGE_INPUT_SCHEMA,
          schema_version: 1,
          phase_id: "SCA-P09",
          run_id: runId,
          entries,
        },
        "coverage_sha256"
      )
    );
    coverageInputRef = save({
      store,
      run_id: runId,
      phase: "SCA-P09",
      kind: "sca-p09-coverage-input",
      operation_id: "sca-p09-coverage-input",
      schema_id: SCA_P09_COVERAGE_INPUT_SCHEMA,
      value: coverageValue,
    });
    coverageInput = coverageValue;
  }

  // The exact lineage refs a P09 resolution may bind to without a separate typed phase-evidence
  // source: the recorded P08 artifacts plus every ref the re-derived P08 admission admitted.
  const lineageRefs: ArtifactRef[] = [
    terminalRef,
    transitionRef,
    ledgerRef,
    gateRef,
    admissionRef,
    universeRef,
    ...revisionRefs,
    ...p08.admission.evidence_refs,
    p08.p07_terminal_ref,
    p08.p07_evidence_ledger_ref,
    p01Ref,
  ];
  let obligationResolutionRef: ArtifactRef | null = null;
  let phaseEvidenceRefs: readonly ArtifactRef[] = [];
  if (input.resolutions === "all_due") {
    const built = buildObligationResolution({ store, runId, ledger: p01Ledger, lineageRefs });
    obligationResolutionRef = built.resolutionRef;
    phaseEvidenceRefs = built.phaseEvidenceRefs;
  }

  return {
    run_id: runId,
    p08_terminal_ref: terminalRef,
    p08_transition_ref: transitionRef,
    p08_evidence_ledger_ref: ledgerRef,
    p08_gate_ref: gateRef,
    p08_admission_ref: admissionRef,
    p08_item_universe_ref: universeRef,
    p01_obligation_ledger_ref: p01Ref,
    p07_authority_ref: p08.p07_authority_ref,
    coverage_input_ref: coverageInputRef,
    coverage_input: coverageInput,
    phase_evidence_refs: phaseEvidenceRefs,
    obligation_resolution_ref: obligationResolutionRef,
    p08_gate_verdict: verdict,
    p08_terminal_status: predicateHolds ? "candidate_complete" : "blocked",
    p08_items: itemSummaries,
  };
}

/**
 * Synthesize exact resolution evidence for every due P01 required-result obligation. Evidence is
 * drawn from the exact admitted lineage when a matching typed record exists (so a phase acceptance
 * obligation binds to the recorded gate itself), and otherwise from explicitly admitted typed
 * phase-evidence sources built here. Each evidence artifact is cited by exactly one resolution
 * entry, and every entry's predicate is the closed role/kind/schema/content contract.
 */
function buildObligationResolution(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly ledger: ScaObligationLedgerV2;
  readonly lineageRefs: readonly ArtifactRef[];
}): { readonly resolutionRef: ArtifactRef; readonly phaseEvidenceRefs: readonly ArtifactRef[] } {
  const due = new Set(scaP09DueObligationIds(input.ledger));
  const lineageByKind = new Map<string, ArtifactRef[]>();
  for (const ref of input.lineageRefs) {
    const list = lineageByKind.get(ref.kind) ?? [];
    list.push(ref);
    lineageByKind.set(ref.kind, list);
  }
  const usedRefIds = new Set<string>();
  const phaseEvidenceRefs: ArtifactRef[] = [];
  const entries: ScaP09ObligationResolutionEntryV1[] = [];
  for (const obligationId of [...due].sort()) {
    const history = input.ledger.entries.filter((entry) => entry.obligation_id === obligationId);
    const last = history[history.length - 1];
    if (last === undefined) continue;
    const expected = scaP09ExpectedResolutionEvidence({
      obligation_id: obligationId,
      scope: last.scope,
      semantic_phase_id: last.semantic_phase_id,
    });
    if (expected === null) continue;
    let evidenceRef: ArtifactRef | null = null;
    for (const kind of expected.kinds) {
      const candidate = (lineageByKind.get(kind) ?? []).find(
        (ref) => !usedRefIds.has(ref.artifact_id)
      );
      if (candidate !== undefined) {
        evidenceRef = candidate;
        break;
      }
    }
    if (evidenceRef === null) {
      const kind = expected.kinds[0];
      if (kind === undefined) continue;
      evidenceRef = buildPhaseEvidenceSource({
        store: input.store,
        runId: input.runId,
        kind,
        index: phaseEvidenceRefs.length,
        obligationId,
      });
      phaseEvidenceRefs.push(evidenceRef);
    }
    usedRefIds.add(evidenceRef.artifact_id);
    entries.push({
      obligation_id: obligationId,
      obligation_entry_sha256: last.entry_sha256,
      resolution_kind: expected.resolution_kind,
      evidence_refs: [evidenceRef],
    });
  }
  const value = validateScaP09ObligationResolutionV1(
    withP09Digest(
      {
        schema_id: SCA_P09_OBLIGATION_RESOLUTION_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P09",
        run_id: input.runId,
        entries,
      },
      "resolution_sha256"
    )
  );
  const resolutionRef = save({
    store: input.store,
    run_id: input.runId,
    phase: "SCA-P09",
    kind: "sca-p09-obligation-resolution",
    operation_id: "sca-p09-obligation-resolution",
    schema_id: SCA_P09_OBLIGATION_RESOLUTION_SCHEMA,
    value,
  });
  return { resolutionRef, phaseEvidenceRefs };
}

/** Build one explicit typed phase-evidence source with satisfied gate/status/content semantics. */
function buildPhaseEvidenceSource(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly kind: string;
  readonly index: number;
  readonly obligationId: string;
}): ArtifactRef {
  const binding = scaP09PhaseEvidenceBinding(input.kind);
  if (binding === null) throw new Error(`P09 has no phase-evidence binding for ${input.kind}`);
  const schemaId = binding.schema_ids[0];
  if (schemaId === undefined) throw new Error(`P09 phase-evidence ${input.kind} lacks a schema`);
  const value =
    binding.semantics === "gate"
      ? { verdict: "pass_ready" }
      : binding.semantics === "terminal"
        ? { status: "candidate_complete" }
        : { phase_evidence: input.obligationId };
  return save({
    store: input.store,
    run_id: input.runId,
    phase: binding.phase_id,
    kind: input.kind,
    operation_id: `sca-p09-phase-evidence-${String(input.index).padStart(4, "0")}`,
    schema_id: schemaId,
    value,
  });
}

function buildP01Ledger(
  _store: ArtifactStore,
  runId: string,
  evidenceRef: ArtifactRef
): { readonly ref: ArtifactRef; readonly ledger: ScaObligationLedgerV2 } {
  const ledger = buildScaInitialObligationLedgerV2({
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: runId,
    created_at: NOW,
    assigning_authority_id: "authority",
    policy_refs: [evidenceRef],
    supporting_evidence_refs: [evidenceRef],
  });
  const ref = save({
    store: _store,
    run_id: runId,
    phase: "SCA-P01",
    kind: "sca-p01-candidate-obligation-ledger",
    operation_id: "sca-p01-candidate-obligation-ledger",
    schema_id: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
    schema_version: 2,
    value: ledger,
  });
  return { ref, ledger };
}
