import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract, type ArtifactRef } from "../contracts.js";
import {
  ScaP02SemgrepJsTsResultV1Schema,
  ScaP02SemgrepPhpResultV1Schema,
} from "./p02-contracts.js";
import { validateScaRuleReleaseV1 } from "./p01-policy-contracts.js";
import type { ScaP07CurrentAuthorityScopeV1 } from "./p07-admission.js";
import {
  admitScaP09Reconciliation,
  type ScaP09CurrentObligationHeadScopeV1,
} from "./p09-admission.js";
import { reconcileScaP09, type ScaP09ReconciliationResultV1 } from "./p09-reconcile.js";
import {
  validateScaP09AdmissionV1,
  validateScaP09CheckpointV1,
  validateScaP09GateV1,
  validateScaP09ReassessmentV1,
  validateScaP09ReconciliationLedgerV1,
  validateScaP09TerminalV1,
  validateScaP09ToP10TransitionV1,
  type ScaP09AdmissionV1,
  type ScaP09GateV1,
  type ScaP09LedgerItemV1,
  type ScaP09ReassessmentV1,
  type ScaP09ReconciliationLedgerV1,
  type ScaP09TerminalV1,
  type ScaP09ToP10TransitionV1,
} from "./p09-contracts.js";
import { validateScaP08DispositionRevisionV1 } from "./p08-contracts.js";
import {
  SCA_P10_ADMISSION_SCHEMA,
  SCA_P10_ELIGIBILITY_LEDGER_SCHEMA,
  scaP10BaselineCompleted,
  validateScaP10AdmissionV1,
  validateScaP10BaselineEvidenceV1,
  validateScaP10EligibilityLedgerV1,
  validateScaP10ReassessmentV1,
  withP10Digest,
  type ScaP10AdmissionV1,
  type ScaP10BaselineClassificationV1,
  type ScaP10BaselineEntryV1,
  type ScaP10BaselineEvidenceV1,
  type ScaP10BaselineLanguageV1,
  type ScaP10EligibilityItemV1,
  type ScaP10EligibilityLedgerV1,
  type ScaP10IneligibleItemV1,
  type ScaP10LaneV1,
  type ScaP10ReassessmentV1,
} from "./p10-contracts.js";

export interface ScaP10AdmissionInputV1 {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly p09_terminal_ref: ArtifactRef;
  readonly p09_transition_ref: ArtifactRef | null;
  readonly p09_reconciliation_ledger_ref: ArtifactRef | null;
  readonly p09_gate_ref: ArtifactRef | null;
  readonly p09_admission_ref: ArtifactRef | null;
  /** Exact P09 admission base refs, used to re-derive the P09 admission and reconciliation. */
  readonly p08_terminal_ref: ArtifactRef;
  readonly p08_transition_ref: ArtifactRef | null;
  readonly p08_evidence_ledger_ref: ArtifactRef | null;
  readonly p08_gate_ref: ArtifactRef | null;
  readonly p08_admission_ref: ArtifactRef | null;
  readonly p08_item_universe_ref: ArtifactRef | null;
  readonly p01_obligation_ledger_ref: ArtifactRef;
  readonly p09_coverage_input_ref: ArtifactRef | null;
  readonly p09_phase_evidence_refs: readonly ArtifactRef[];
  readonly p09_obligation_resolution_ref: ArtifactRef | null;
  readonly p09_reassessment_ref: ArtifactRef | null;
  /** Caller constraints not reachable from the P09 admission chain. */
  readonly baseline_evidence_ref: ArtifactRef;
  readonly disclosure_scope_ref: ArtifactRef;
  readonly promotion_authority_ref: ArtifactRef;
  readonly active_run_rule_release_refs: readonly ArtifactRef[];
  readonly p10_reassessment_ref?: ArtifactRef | null;
  readonly p10_prior_eligibility_ledger_ref?: ArtifactRef | null;
  readonly resolve_current_p07_authority_ref?: (
    scope: ScaP07CurrentAuthorityScopeV1
  ) => ArtifactRef;
  readonly resolve_current_p01_obligation_head_ref?: (
    scope: ScaP09CurrentObligationHeadScopeV1
  ) => ArtifactRef;
}

export interface ScaP10BaselineBindingV1 {
  readonly evidence: ScaP10BaselineEvidenceV1;
  readonly evidence_ref: ArtifactRef;
  readonly by_language: ReadonlyMap<ScaP10BaselineLanguageV1, ScaP10BaselineDerivedEntryV1>;
  /** Re-derived from the exact frozen P01 rule-release artifact bytes (campaign binding). */
  readonly rule_release_binding_sha256: string;
  readonly rule_release_binding_valid: boolean;
}

export interface ScaP10BaselineDerivedEntryV1 {
  readonly entry: ScaP10BaselineEntryV1;
  /** Analyzer applicability re-derived from the exact P02 analyzer_results. */
  readonly applicable: boolean;
  /** Analyzer completion re-derived from the exact P02 analyzer_results. */
  readonly analyzer_complete: boolean;
  /** Source-snapshot binding re-derived from the exact P02 result bytes. */
  readonly source_binding_sha256: string;
}

export interface ScaP10AdmissionResultV1 {
  readonly admission: ScaP10AdmissionV1;
  readonly non_learnable: boolean;
  readonly non_learnable_reason: string | null;
  readonly lane: ScaP10LaneV1 | null;
  readonly p09_terminal: ScaP09TerminalV1;
  readonly p09_transition: ScaP09ToP10TransitionV1 | null;
  readonly p09_ledger: ScaP09ReconciliationLedgerV1 | null;
  readonly p09_gate: ScaP09GateV1 | null;
  readonly p09_admission: ScaP09AdmissionV1 | null;
  readonly p09_reconciliation: ScaP09ReconciliationResultV1 | null;
  readonly baseline: ScaP10BaselineBindingV1 | null;
  readonly eligibility: ScaP10EligibilityLedgerV1 | null;
  readonly eligible_refs: readonly ArtifactRef[];
  readonly ineligible_refs: readonly ArtifactRef[];
  readonly unresolved_item_refs: readonly ArtifactRef[];
  readonly evidence_refs: readonly ArtifactRef[];
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function requireSame(left: unknown, right: unknown, label: string): void {
  if (!same(left, right)) throw new Error(`P10 ${label} exact binding mismatch`);
}
function exact<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  kind: string,
  validate: (value: unknown) => T
): T {
  if (ref.kind !== kind || !same(store.refById(ref.artifact_id), ref)) {
    throw new Error(`P10 ${kind} exact ref absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P10 ${kind} exact bytes drifted`);
  }
  const text = bytes.toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error(`P10 ${kind} noncanonical bytes`);
  return validate(parsed);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}

/** Deterministic closed source-language derivation from a repository path extension. */
export function scaP10LanguageForPath(path: string): ScaP10BaselineLanguageV1 | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) {
    return "javascript";
  }
  return null;
}

/**
 * Deterministically re-derive the exact baseline status, normalized alerts, analyzer
 * applicability/completion, and source-snapshot binding from a language's exact P02 Semgrep
 * result bytes. The predicate never consults severity, confidence, prose, or model agreement.
 */
function deriveBaselineFromP02Result(
  store: ArtifactHostStore,
  entry: ScaP10BaselineEntryV1
): {
  readonly status: ScaP10BaselineEntryV1["baseline_status"];
  readonly alerts: ScaP10BaselineEntryV1["alerts"];
  readonly applicable: boolean;
  readonly analyzer_complete: boolean;
  readonly source_binding_sha256: string;
} {
  const raw: unknown = JSON.parse(
    store.readById(entry.p02_result_ref.artifact_id).toString("utf8")
  );
  const result =
    entry.language === "php"
      ? validateContract(ScaP02SemgrepPhpResultV1Schema, raw, "SCA P10 baseline P02 result")
      : validateContract(ScaP02SemgrepJsTsResultV1Schema, raw, "SCA P10 baseline P02 result");
  const analyzerId = entry.language === "php" ? "semgrep-php" : "semgrep-js-ts";
  const analyzer = result.analyzer_results.find(
    (candidate) => candidate.analyzer_id === analyzerId
  );
  const applicable = analyzer?.applicability === "applicable";
  const analyzerComplete = analyzer?.status === "complete";
  const observations = result.normalized_observations as readonly {
    path: string | null;
    start_line: number | null;
  }[];
  const alerts = observations
    .filter(
      (observation): observation is { path: string; start_line: number } =>
        observation.path !== null && observation.start_line !== null
    )
    .map((observation) => ({ path: observation.path, start_line: observation.start_line }));
  const byKey = new Map<string, { path: string; start_line: number }>();
  for (const alert of alerts) byKey.set(`${alert.path}\u0000${String(alert.start_line)}`, alert);
  const sorted = [...byKey.values()].sort((left, right) =>
    left.path === right.path ? left.start_line - right.start_line : left.path < right.path ? -1 : 1
  );
  const status: ScaP10BaselineEntryV1["baseline_status"] =
    result.status === "blocked" ? "failed" : sorted.length > 0 ? "findings" : "succeeded";
  return {
    status,
    alerts: sorted,
    applicable,
    analyzer_complete: analyzerComplete,
    source_binding_sha256: result.source_binding_sha256,
  };
}

/** Re-derive the frozen-rule-release binding from the exact campaign P01 release artifact bytes. */
export function scaP10RuleReleaseBindingSha256(input: {
  readonly release_sha256: string;
  readonly release: ReturnType<typeof validateScaRuleReleaseV1>;
}): string {
  return sha256(
    canonicalJson({
      schema_version: 1,
      release_sha256: input.release_sha256,
      release_id: input.release.release_id,
      rule_bundle_ref_digest: input.release.rule_bundle_ref.content_digest,
      rules_sha256: input.release.rules_sha256,
      rule_count: input.release.rule_count,
      languages: [...input.release.languages].sort(),
    })
  );
}

function admitBaseline(input: {
  readonly store: ArtifactHostStore;
  readonly ref: ArtifactRef;
  readonly runId: string;
}): ScaP10BaselineBindingV1 {
  const evidence = exact(
    input.store,
    input.ref,
    "sca-p10-baseline-evidence",
    validateScaP10BaselineEvidenceV1
  );
  if (evidence.run_id !== input.runId) {
    throw new Error("P10 baseline evidence belongs to another run");
  }
  // Re-derive the frozen rule-release binding from the exact campaign P01 release bytes.
  const releaseRef = evidence.frozen_rule_release_ref;
  const storedRelease = input.store.refById(releaseRef.artifact_id);
  if (storedRelease === undefined || !same(storedRelease, releaseRef)) {
    throw new Error("P10 baseline frozen rule release exact ref is absent or substituted");
  }
  const releaseBytes = input.store.readById(releaseRef.artifact_id);
  if (
    releaseBytes.byteLength !== releaseRef.byte_length ||
    sha256(releaseBytes) !== releaseRef.content_digest
  ) {
    throw new Error("P10 baseline frozen rule release exact bytes drifted");
  }
  const releaseValue: unknown = JSON.parse(releaseBytes.toString("utf8"));
  const release = validateScaRuleReleaseV1(releaseValue);
  const ruleReleaseBindingSha256 = scaP10RuleReleaseBindingSha256({
    release_sha256: releaseRef.content_digest,
    release,
  });
  const ruleReleaseBindingValid = evidence.frozen_rule_config_sha256 === ruleReleaseBindingSha256;
  const byLanguage = new Map<ScaP10BaselineLanguageV1, ScaP10BaselineDerivedEntryV1>();
  for (const entry of evidence.entries) {
    const stored = input.store.refById(entry.p02_result_ref.artifact_id);
    if (stored === undefined || !same(stored, entry.p02_result_ref)) {
      throw new Error("P10 baseline P02 result exact ref is absent or substituted");
    }
    const bytes = input.store.readById(entry.p02_result_ref.artifact_id);
    if (
      bytes.byteLength !== entry.p02_result_ref.byte_length ||
      sha256(bytes) !== entry.p02_result_ref.content_digest
    ) {
      throw new Error("P10 baseline P02 result exact bytes drifted");
    }
    const derived = deriveBaselineFromP02Result(input.store, entry);
    if (derived.status !== entry.baseline_status) {
      throw new Error("P10 baseline status is not re-derived from the exact P02 bytes");
    }
    requireSame(entry.alerts, derived.alerts, "baseline normalized alerts");
    if (entry.truncated && scaP10BaselineCompleted(entry.baseline_status)) {
      throw new Error("P10 baseline entry cannot claim truncation and completion together");
    }
    byLanguage.set(entry.language, {
      entry,
      applicable: derived.applicable,
      analyzer_complete: derived.analyzer_complete,
      source_binding_sha256: derived.source_binding_sha256,
    });
  }
  return {
    evidence,
    evidence_ref: input.ref,
    by_language: byLanguage,
    rule_release_binding_sha256: ruleReleaseBindingSha256,
    rule_release_binding_valid: ruleReleaseBindingValid,
  };
}

interface ScaP10LocatedIssueV1 {
  readonly item: ScaP09LedgerItemV1;
  readonly repository_path: string;
  readonly line_start: number;
  readonly line_end: number;
}

function classifyBaseline(
  issue: ScaP10LocatedIssueV1,
  baseline: ScaP10BaselineBindingV1
): {
  readonly classification: ScaP10BaselineClassificationV1;
  readonly language: ScaP10BaselineLanguageV1 | null;
} {
  const language = scaP10LanguageForPath(issue.repository_path);
  if (language === null) return { classification: "coverage_gap", language: null };
  const found = baseline.by_language.get(language);
  if (found === undefined) return { classification: "coverage_gap", language };
  // Every non-applicable / non-completed / unbound / truncated / non-successful baseline is a
  // coverage gap, never false-negative evidence.
  if (!baseline.rule_release_binding_valid) return { classification: "coverage_gap", language };
  if (!found.applicable) return { classification: "coverage_gap", language };
  if (!found.analyzer_complete) return { classification: "coverage_gap", language };
  if (found.source_binding_sha256 !== baseline.evidence.source_snapshot_sha256) {
    return { classification: "coverage_gap", language };
  }
  const entry = found.entry;
  if (!scaP10BaselineCompleted(entry.baseline_status)) {
    return { classification: "coverage_gap", language };
  }
  if (entry.truncated) return { classification: "coverage_gap", language };
  const hit = entry.alerts.some(
    (alert) =>
      alert.path === issue.repository_path &&
      alert.start_line >= issue.line_start &&
      alert.start_line <= issue.line_end
  );
  return { classification: hit ? "baseline_hit" : "false_negative", language };
}

/**
 * Exact P09→P10 lineage admission plus deterministic eligibility and false-negative derivation.
 *
 * The recorded P09 admission and reconciliation are re-derived through the shared admission path
 * (`admitScaP09Reconciliation` + `reconcileScaP09`) — never a second engine — and any absent,
 * substituted, cross-run, digest-drifted, non-canonical, or re-derivation-mismatched ref aborts
 * admission with no learning output.
 */
export function admitScaP10Learning(input: ScaP10AdmissionInputV1): ScaP10AdmissionResultV1 {
  const { store } = input;
  const evidenceRefs: ArtifactRef[] = [input.p09_terminal_ref];
  const terminal = exact(
    store,
    input.p09_terminal_ref,
    "sca-p09-terminal",
    validateScaP09TerminalV1
  );

  // A cancelled or ledger-less P09 result is an explicit non-learnable checkpoint. P10 admits as
  // durable accounting only and fabricates no eligibility or candidate.
  const learnable =
    (terminal.status === "accepted_progression" || terminal.status === "incomplete_closeout") &&
    terminal.reconciliation_ledger_ref !== null &&
    terminal.p10_transition_ref !== null;

  const admissionFor = (fields: {
    readonly lane?: ScaP10LaneV1;
    readonly nonLearnable: boolean;
    readonly nonLearnableReason: string | null;
    readonly itemCount: number;
    readonly eligibleCount: number;
    readonly p09RedervationOk: boolean;
    readonly p09ReconciliationOk: boolean;
    readonly extraRefs: readonly ArtifactRef[];
  }): ScaP10AdmissionV1 =>
    validateScaP10AdmissionV1(
      withP10Digest(
        {
          schema_id: SCA_P10_ADMISSION_SCHEMA,
          schema_version: 1 as const,
          phase_id: "SCA-P10" as const,
          run_id: input.run_id,
          p09_terminal_ref: input.p09_terminal_ref,
          p09_transition_ref: input.p09_transition_ref,
          p09_reconciliation_ledger_ref: input.p09_reconciliation_ledger_ref,
          p09_gate_ref: input.p09_gate_ref,
          p09_admission_ref: input.p09_admission_ref,
          baseline_evidence_ref: input.baseline_evidence_ref,
          disclosure_scope_ref: input.disclosure_scope_ref,
          promotion_authority_ref: input.promotion_authority_ref,
          active_run_rule_release_refs: [...input.active_run_rule_release_refs],
          ...(fields.lane === undefined ? {} : { lane: fields.lane }),
          p09_rederivation_ok: fields.p09RedervationOk,
          p09_reconciliation_rederivation_ok: fields.p09ReconciliationOk,
          non_learnable: fields.nonLearnable,
          non_learnable_reason: fields.nonLearnableReason,
          item_count: fields.itemCount,
          eligible_count: fields.eligibleCount,
        },
        "admission_sha256"
      )
    );

  if (!learnable) {
    const reason =
      input.p09_reconciliation_ledger_ref === null || input.p09_transition_ref === null
        ? `p09_${terminal.status}_non_reconcilable_checkpoint`
        : `p09_${terminal.status}_not_learnable`;
    const admission = admissionFor({
      nonLearnable: true,
      nonLearnableReason: reason,
      itemCount: 0,
      eligibleCount: 0,
      p09RedervationOk: false,
      p09ReconciliationOk: false,
      extraRefs: [],
    });
    return {
      admission,
      non_learnable: true,
      non_learnable_reason: reason,
      lane: null,
      p09_terminal: terminal,
      p09_transition: null,
      p09_ledger: null,
      p09_gate: null,
      p09_admission: null,
      p09_reconciliation: null,
      baseline: null,
      eligibility: null,
      eligible_refs: [],
      ineligible_refs: [],
      unresolved_item_refs: [],
      evidence_refs: uniqueRefs([
        input.p09_terminal_ref,
        input.baseline_evidence_ref,
        input.disclosure_scope_ref,
        input.promotion_authority_ref,
      ]),
    };
  }

  if (
    input.p09_transition_ref === null ||
    input.p09_reconciliation_ledger_ref === null ||
    input.p09_gate_ref === null ||
    input.p09_admission_ref === null
  ) {
    throw new Error("P10 learning requires every recorded P09 artifact ref");
  }
  const transition = exact(
    store,
    input.p09_transition_ref,
    "sca-p09-to-p10-transition",
    validateScaP09ToP10TransitionV1
  );
  const ledger = exact(
    store,
    input.p09_reconciliation_ledger_ref,
    "sca-p09-reconciliation-ledger",
    validateScaP09ReconciliationLedgerV1
  );
  const gate = exact(store, input.p09_gate_ref, "sca-p09-gate", validateScaP09GateV1);
  const recordedAdmission = exact(
    store,
    input.p09_admission_ref,
    "sca-p09-admission",
    validateScaP09AdmissionV1
  );
  evidenceRefs.push(
    input.p09_transition_ref,
    input.p09_reconciliation_ledger_ref,
    input.p09_gate_ref,
    input.p09_admission_ref
  );

  // The P09 transition must be the explicit non-authorizing handoff.
  if (
    transition.handoff_kind !== "reconciled_eligible_evidence_only" ||
    transition.qualification_scope !== "reconciliation_gate_only_not_p10_learning" ||
    transition.phase_gate_passed !== false ||
    transition.p10_rule_learning_authorized_by_this_transition !== false ||
    transition.release_eligible !== false ||
    transition.campaign_complete !== false ||
    transition.campaign_completion_claimed !== false ||
    transition.required_gaps_retained !== true
  ) {
    throw new Error("P10 P09 transition is not the explicit non-authorizing learning handoff");
  }
  requireSame(
    transition.p09_reconciliation_ledger_ref,
    input.p09_reconciliation_ledger_ref,
    "P09 transition ledger"
  );
  requireSame(
    terminal.reconciliation_ledger_ref,
    input.p09_reconciliation_ledger_ref,
    "P09 terminal ledger"
  );
  requireSame(terminal.gate_ref, input.p09_gate_ref, "P09 terminal gate");
  requireSame(terminal.p10_transition_ref, input.p09_transition_ref, "P09 terminal transition");
  if (
    transition.release_eligible !== false ||
    transition.campaign_complete !== false ||
    transition.campaign_completion_claimed !== false
  ) {
    throw new Error("P10 P09 transition claims release or campaign completion");
  }
  const laneAgreement =
    (terminal.status === "accepted_progression" && gate.verdict === "pass_ready") ||
    (terminal.status === "incomplete_closeout" && gate.verdict === "pass_blocked");
  if (!laneAgreement) {
    throw new Error("P10 P09 terminal status disagrees with its gate verdict");
  }
  if (terminal.status !== transition.lane) {
    throw new Error("P10 P09 terminal status disagrees with its transition lane");
  }
  if (ledger.lane === undefined || ledger.lane !== transition.lane) {
    throw new Error("P10 P09 ledger lane disagrees with its transition");
  }
  for (const ref of [
    input.p09_terminal_ref,
    input.p09_transition_ref,
    input.p09_reconciliation_ledger_ref,
    input.p09_gate_ref,
    input.p09_admission_ref,
    input.p08_terminal_ref,
    input.p01_obligation_ledger_ref,
  ]) {
    if (ref.run_id !== input.run_id) throw new Error("P10 cross-run P09 ref");
  }
  if (recordedAdmission.non_reconcilable) {
    throw new Error("P10 learnable input cannot bind a non-reconcilable P09 admission");
  }

  // Re-derive the P09 admission through the shared path, supplying the same resolvers when the
  // recorded admission encoded independent attestations.
  const rederived = admitScaP09Reconciliation({
    store,
    run_id: input.run_id,
    p08_terminal_ref: input.p08_terminal_ref,
    p08_transition_ref: input.p08_transition_ref,
    p08_evidence_ledger_ref: input.p08_evidence_ledger_ref,
    p08_gate_ref: input.p08_gate_ref,
    p08_admission_ref: input.p08_admission_ref,
    p08_item_universe_ref: input.p08_item_universe_ref,
    p01_obligation_ledger_ref: input.p01_obligation_ledger_ref,
    coverage_input_ref: input.p09_coverage_input_ref,
    phase_evidence_refs: input.p09_phase_evidence_refs,
    obligation_resolution_ref: input.p09_obligation_resolution_ref,
    ...(input.resolve_current_p07_authority_ref === undefined
      ? {}
      : { resolve_current_p07_authority_ref: input.resolve_current_p07_authority_ref }),
    ...(input.resolve_current_p01_obligation_head_ref === undefined
      ? {}
      : { resolve_current_p01_obligation_head_ref: input.resolve_current_p01_obligation_head_ref }),
  });
  requireSame(rederived.admission, recordedAdmission, "re-derived P09 admission");
  for (const ref of rederived.evidence_refs) evidenceRefs.push(ref);

  // Re-derive the P09 reconciliation over the re-derived admission and exact reassessment lineage.
  const reassessment = readP09Reassessment(store, input.p09_reassessment_ref);
  const priorLedgerRef = reassessment === null ? null : reassessment.prior_p09_ledger_ref;
  const priorLedger =
    priorLedgerRef === null
      ? null
      : exact(
          store,
          priorLedgerRef,
          "sca-p09-reconciliation-ledger",
          validateScaP09ReconciliationLedgerV1
        );
  if (priorLedgerRef !== null) evidenceRefs.push(priorLedgerRef);
  if (input.p09_reassessment_ref !== null) evidenceRefs.push(input.p09_reassessment_ref);
  const checkpointRefs = new Map<string, ArtifactRef>();
  for (const item of ledger.items) {
    if (item.checkpoint_ref === null) continue;
    const checkpoint = exact(
      store,
      item.checkpoint_ref,
      "sca-p09-checkpoint",
      validateScaP09CheckpointV1
    );
    if (checkpoint.item_id !== item.item_id) {
      throw new Error("P10 P09 checkpoint item binding mismatch");
    }
    checkpointRefs.set(item.item_id, item.checkpoint_ref);
    evidenceRefs.push(item.checkpoint_ref);
  }
  const reconciliation = reconcileScaP09({
    admitted: rederived,
    reassessment,
    prior_ledger: priorLedger,
    prior_ledger_ref: priorLedgerRef,
    checkpoint_refs_by_item_id: checkpointRefs,
  });
  requireSame(reconciliation.items, ledger.items, "re-derived P09 reconciliation items");
  requireSame(reconciliation.eligible_refs, ledger.eligible_refs, "re-derived P09 eligible refs");
  requireSame(
    reconciliation.ineligible_refs,
    ledger.ineligible_refs,
    "re-derived P09 ineligible refs"
  );
  requireSame(
    reconciliation.unresolved_item_refs,
    ledger.unresolved_item_refs,
    "re-derived P09 unresolved refs"
  );
  requireSame(
    reconciliation.downstream_pending_required_result_ids,
    ledger.downstream_pending_required_result_ids,
    "re-derived P09 downstream ids"
  );
  requireSame(reconciliation.blocker_codes, ledger.blocker_codes, "re-derived P09 blockers");
  if (
    reconciliation.required_result_total !== ledger.required_result_total ||
    reconciliation.required_result_resolved !== ledger.required_result_resolved ||
    reconciliation.lane !== ledger.lane
  ) {
    throw new Error("P10 re-derived P09 reconciliation counts or lane disagree with the ledger");
  }
  requireSame(
    {
      exhaustive_accounting: reconciliation.predicates.exhaustive_accounting,
      immutable_p08_lineage_valid: reconciliation.predicates.immutable_p08_lineage_valid,
      set_equality_valid: reconciliation.predicates.set_equality_valid,
      effective_class_derivation_valid: reconciliation.predicates.effective_class_derivation_valid,
      no_underclassification: reconciliation.predicates.no_underclassification,
      no_post_failure_downgrade: reconciliation.predicates.no_post_failure_downgrade,
      no_late_unregistered_action: reconciliation.predicates.no_late_unregistered_action,
      no_conflicting_replay: reconciliation.predicates.no_conflicting_replay,
      coverage_reconciled: reconciliation.predicates.coverage_reconciled,
      append_only_revisions: reconciliation.predicates.append_only_revisions,
      eligible_handoff_only: reconciliation.predicates.eligible_handoff_only,
      downstream_accounting_present: reconciliation.predicates.downstream_accounting_present,
      p12_or_release_claims_absent: reconciliation.predicates.p12_or_release_claims_absent,
    },
    {
      exhaustive_accounting: gate.exhaustive_accounting,
      immutable_p08_lineage_valid: gate.immutable_p08_lineage_valid,
      set_equality_valid: gate.set_equality_valid,
      effective_class_derivation_valid: gate.effective_class_derivation_valid,
      no_underclassification: gate.no_underclassification,
      no_post_failure_downgrade: gate.no_post_failure_downgrade,
      no_late_unregistered_action: gate.no_late_unregistered_action,
      no_conflicting_replay: gate.no_conflicting_replay,
      coverage_reconciled: gate.coverage_reconciled,
      append_only_revisions: gate.append_only_revisions,
      eligible_handoff_only: gate.eligible_handoff_only,
      downstream_accounting_present: gate.downstream_accounting_present,
      p12_or_release_claims_absent: gate.p12_or_release_claims_absent,
    },
    "re-derived P09 predicates"
  );
  if (
    gate.reconciliation_ledger_ref.artifact_id !== input.p09_reconciliation_ledger_ref.artifact_id
  ) {
    throw new Error("P10 P09 gate ledger binding mismatch");
  }

  // Walk the recorded P09 ledger's prior chain to its version-1 root with a gapless decrement.
  let chain = priorLedger;
  let chainRef = priorLedgerRef;
  let revision = ledger.ledger_revision ?? 1;
  while (chainRef !== null && chain !== null) {
    evidenceRefs.push(chainRef);
    const expectedRevision = revision - 1;
    if ((chain.ledger_revision ?? 1) !== expectedRevision) {
      throw new Error("P10 P09 ledger prior chain is not a gapless append-only sequence");
    }
    chainRef = chain.prior_p09_ledger_ref ?? null;
    chain =
      chainRef === null
        ? null
        : exact(
            store,
            chainRef,
            "sca-p09-reconciliation-ledger",
            validateScaP09ReconciliationLedgerV1
          );
    revision = expectedRevision;
  }
  if (revision !== 1) {
    throw new Error("P10 P09 ledger prior chain does not reach its version-1 root");
  }

  const lane: ScaP10LaneV1 = ledger.lane;

  // Exact baseline binding admitted from caller constraints (not reachable from the P09 chain).
  const baseline = admitBaseline({
    store,
    ref: input.baseline_evidence_ref,
    runId: input.run_id,
  });
  evidenceRefs.push(
    baseline.evidence.frozen_rule_release_ref,
    baseline.evidence.source_snapshot_ref,
    ...baseline.evidence.entries.map((entry) => entry.p02_result_ref)
  );

  // Exact P10 reassessment lineage: bind the prior eligibility revision and reject any eligible
  // support the reassessment explicitly invalidated. Invalidated evidence may neither survive as
  // eligible support nor be silently rewritten away; it is retained as an ineligible record.
  const p10ReassessmentRef = input.p10_reassessment_ref ?? null;
  let eligibilityPriorRef: ArtifactRef | null = input.p10_prior_eligibility_ledger_ref ?? null;
  let priorEligibility: ScaP10EligibilityLedgerV1 | null = null;
  let p10Reassessment: ScaP10ReassessmentV1 | null = null;
  if (p10ReassessmentRef !== null) {
    p10Reassessment = exact(
      store,
      p10ReassessmentRef,
      "sca-p10-reassessment",
      validateScaP10ReassessmentV1
    );
    if (p10Reassessment.run_id !== input.run_id) {
      throw new Error("P10 reassessment belongs to another run");
    }
    if (eligibilityPriorRef === null) {
      eligibilityPriorRef = p10Reassessment.prior_p10_ledger_ref;
    } else {
      requireSame(
        eligibilityPriorRef,
        p10Reassessment.prior_p10_ledger_ref,
        "P10 reassessment prior ledger"
      );
    }
    const priorRef = eligibilityPriorRef;
    priorEligibility = exact(
      store,
      priorRef,
      "sca-p10-eligibility-ledger",
      validateScaP10EligibilityLedgerV1
    );
    if (
      !same(priorEligibility.p09_reconciliation_ledger_ref, p10Reassessment.prior_p09_ledger_ref)
    ) {
      throw new Error(
        "P10 reassessment prior ledger is bound to a different prior P09 reconciliation"
      );
    }
    for (const ref of p10Reassessment.stimulus_refs) {
      const stored = store.refById(ref.artifact_id);
      if (stored === undefined || !same(stored, ref)) {
        throw new Error("P10 reassessment stimulus is absent or substituted");
      }
      const bytes = store.readById(ref.artifact_id);
      if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
        throw new Error("P10 reassessment stimulus is absent or drifted");
      }
    }
    evidenceRefs.push(p10ReassessmentRef, priorRef);
  } else if (
    input.p10_prior_eligibility_ledger_ref !== null &&
    input.p10_prior_eligibility_ledger_ref !== undefined
  ) {
    throw new Error("P10 prior eligibility ledger requires an exact reassessment");
  }
  const invalidatedEvidenceIds = new Set(
    (p10Reassessment?.invalidated_evidence_refs ?? []).map((ref) => ref.artifact_id)
  );
  const invalidatedLedgerIds = new Set<string>();
  const invalidatedSupportRefs: ArtifactRef[] = [];

  // Eligible-only classification: the closed universe of items with `eligibility === eligible`.
  const eligibleItems: ScaP10EligibilityItemV1[] = [];
  const ineligibleItems: ScaP10IneligibleItemV1[] = [];
  const eligibleRefs: ArtifactRef[] = [];
  for (const item of ledger.items) {
    if (item.eligibility === "eligible") {
      const dispositionRef = item.p08_disposition_ref;
      if (dispositionRef === null) {
        throw new Error("P10 eligible item lacks its exact disposition revision");
      }
      if (
        invalidatedEvidenceIds.has(dispositionRef.artifact_id) ||
        invalidatedEvidenceIds.has(item.primary_ref.artifact_id)
      ) {
        invalidatedLedgerIds.add(item.item_id);
        invalidatedSupportRefs.push(dispositionRef);
        ineligibleItems.push({
          item_id: item.item_id,
          identity: item.identity,
          eligibility: "ineligible",
          blocker_codes: ["p10_evidence_invalidated"],
        });
        continue;
      }
      const revision = exact(
        store,
        dispositionRef,
        "sca-p08-disposition-revision",
        validateScaP08DispositionRevisionV1
      );
      evidenceRefs.push(dispositionRef, item.primary_ref);
      if (revision.disposition === "confirmed") {
        if (
          revision.repository_path === null ||
          revision.line_start === null ||
          revision.line_end === null
        ) {
          const classification = classifyBaseline(
            { item, repository_path: "", line_start: 1, line_end: 1 },
            baseline
          );
          eligibleItems.push({
            item_id: item.item_id,
            identity: item.identity,
            primary_ref: item.primary_ref,
            p08_disposition: "confirmed",
            p08_disposition_ref: dispositionRef,
            eligible_classification: "established_issue",
            baseline_language: classification.language,
            baseline_classification: "coverage_gap",
            blocker_codes: ["p10_issue_unlocated"],
          });
        } else {
          const classification = classifyBaseline(
            {
              item,
              repository_path: revision.repository_path,
              line_start: revision.line_start,
              line_end: revision.line_end,
            },
            baseline
          );
          eligibleItems.push({
            item_id: item.item_id,
            identity: item.identity,
            primary_ref: item.primary_ref,
            p08_disposition: "confirmed",
            p08_disposition_ref: dispositionRef,
            eligible_classification: "established_issue",
            baseline_language: classification.language,
            baseline_classification: classification.classification,
            blocker_codes:
              classification.classification === "coverage_gap" ? ["p10_baseline_coverage_gap"] : [],
          });
        }
      } else if (revision.disposition === "rejected-with-evidence") {
        eligibleItems.push({
          item_id: item.item_id,
          identity: item.identity,
          primary_ref: item.primary_ref,
          p08_disposition: "rejected-with-evidence",
          p08_disposition_ref: dispositionRef,
          eligible_classification: "refutation",
          baseline_language: null,
          baseline_classification: null,
          blocker_codes: [],
        });
      } else {
        throw new Error("P10 eligible item has an inadmissible disposition");
      }
      eligibleRefs.push(dispositionRef);
    } else {
      ineligibleItems.push({
        item_id: item.item_id,
        identity: item.identity,
        eligibility: item.eligibility,
        blocker_codes: [...item.blocker_codes],
      });
    }
  }

  // E-elig set-equality: eligible items are exactly established issues plus refutations.
  const established = eligibleItems.filter(
    (item) => item.eligible_classification === "established_issue"
  );
  const refutations = eligibleItems.filter((item) => item.eligible_classification === "refutation");
  if (established.length + refutations.length !== eligibleItems.length) {
    throw new Error("P10 E-elig set equality violated: an eligible item is unclassified");
  }
  if (established.some((item) => item.p08_disposition !== "confirmed")) {
    throw new Error(
      "P10 E-elig set equality violated: a non-confirmed item is an established issue"
    );
  }
  if (refutations.some((item) => item.p08_disposition !== "rejected-with-evidence")) {
    throw new Error("P10 E-elig set equality violated: a non-refutation item claims refutation");
  }
  const eligibleLedgerIds = new Set(
    ledger.items.filter((item) => item.eligibility === "eligible").map((item) => item.item_id)
  );
  const classifiedIds = new Set(eligibleItems.map((item) => item.item_id));
  if (
    eligibleLedgerIds.size !== classifiedIds.size + invalidatedLedgerIds.size ||
    [...eligibleLedgerIds].some((id) => !classifiedIds.has(id) && !invalidatedLedgerIds.has(id))
  ) {
    throw new Error("P10 E-elig set equality violated: eligible universe is not exhaustive");
  }

  const eligibilityRevision =
    priorEligibility === null ? 1 : (priorEligibility.eligibility_ledger_revision ?? 1) + 1;
  const eligibility = validateScaP10EligibilityLedgerV1(
    withP10Digest(
      {
        schema_id: SCA_P10_ELIGIBILITY_LEDGER_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P10" as const,
        run_id: input.run_id,
        p09_reconciliation_ledger_ref: input.p09_reconciliation_ledger_ref,
        lane,
        eligible_items: [...eligibleItems].sort((left, right) =>
          left.item_id < right.item_id ? -1 : 1
        ),
        ineligible_items: [...ineligibleItems].sort((left, right) =>
          left.item_id < right.item_id ? -1 : 1
        ),
        eligibility_ledger_revision: eligibilityRevision,
        prior_eligibility_ledger_ref: eligibilityPriorRef,
        prior_eligibility_ledger_sha256:
          eligibilityPriorRef === null ? null : eligibilityPriorRef.content_digest,
        append_only: true as const,
        item_count: eligibleItems.length + ineligibleItems.length,
        eligible_count: eligibleItems.length,
        established_issue_count: established.length,
        refutation_count: refutations.length,
        false_negative_count: established.filter(
          (item) => item.baseline_classification === "false_negative"
        ).length,
        baseline_hit_count: established.filter(
          (item) => item.baseline_classification === "baseline_hit"
        ).length,
        coverage_gap_count: established.filter(
          (item) => item.baseline_classification === "coverage_gap"
        ).length,
        set_equality_valid: true as const,
      },
      "eligibility_sha256"
    )
  );

  const admission = admissionFor({
    lane,
    nonLearnable: false,
    nonLearnableReason: null,
    itemCount: ledger.items.length,
    eligibleCount: eligibleItems.length,
    p09RedervationOk: true,
    p09ReconciliationOk: true,
    extraRefs: [],
  });

  return {
    admission,
    non_learnable: false,
    non_learnable_reason: null,
    lane,
    p09_terminal: terminal,
    p09_transition: transition,
    p09_ledger: ledger,
    p09_gate: gate,
    p09_admission: recordedAdmission,
    p09_reconciliation: reconciliation,
    baseline,
    eligibility,
    eligible_refs: uniqueRefs(eligibleRefs),
    ineligible_refs: uniqueRefs([...ledger.ineligible_refs, ...invalidatedSupportRefs]),
    unresolved_item_refs: uniqueRefs(ledger.unresolved_item_refs.map((ref) => ref)),
    evidence_refs: uniqueRefs(evidenceRefs),
  };
}

function readP09Reassessment(
  store: ArtifactHostStore,
  ref: ArtifactRef | null
): ScaP09ReassessmentV1 | null {
  if (ref === null) return null;
  return exact(store, ref, "sca-p09-reassessment", validateScaP09ReassessmentV1);
}
