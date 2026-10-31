import type { ArtifactRef } from "../contracts.js";
import { validateScaObligationLedgerV2, type ScaObligationEntryV2 } from "./p01-contracts.js";
import type { ScaP09AdmissionResultV1, ScaP09AdmittedItemV1 } from "./p09-admission.js";
import {
  isScaP09InvalidBlocker,
  scaP09CoverageComplete,
  scaP09ObligationClassPrecedence,
  type ScaP09AssignedLaneV1,
  type ScaP09EligibilityV1,
  type ScaP09LedgerItemV1,
  type ScaP09ReassessmentV1,
  type ScaP09ReconciliationLedgerV1,
} from "./p09-contracts.js";

/**
 * Deterministic host reconciliation (`SCA-P09` R2–R6). It consumes only admitted exact facts and
 * derives the closed universe accounting, eligibility, class-integrity guards, coverage
 * completeness, due-obligation resolution, and exactly one lane. It never consults prose,
 * confidence, severity, or approval, and it never treats a pending P01 ledger entry as evidence.
 */

export interface ScaP09GatePredicatesV1 {
  readonly exhaustive_accounting: boolean;
  readonly immutable_p08_lineage_valid: boolean;
  readonly set_equality_valid: boolean;
  readonly effective_class_derivation_valid: boolean;
  readonly no_underclassification: boolean;
  readonly no_post_failure_downgrade: boolean;
  readonly no_late_unregistered_action: boolean;
  readonly no_conflicting_replay: boolean;
  readonly coverage_reconciled: boolean;
  readonly append_only_revisions: boolean;
  readonly eligible_handoff_only: boolean;
  readonly downstream_accounting_present: boolean;
  readonly p12_or_release_claims_absent: boolean;
}

export interface ScaP09ReconciliationResultV1 {
  readonly lane: ScaP09AssignedLaneV1 | null;
  readonly items: readonly ScaP09LedgerItemV1[];
  readonly eligible_refs: readonly ArtifactRef[];
  readonly ineligible_refs: readonly ArtifactRef[];
  readonly unresolved_item_refs: readonly ArtifactRef[];
  readonly required_result_total: number;
  readonly required_result_resolved: number;
  readonly downstream_pending_required_result_ids: readonly string[];
  readonly kind_counts: readonly { readonly key: string; readonly count: number }[];
  readonly disposition_counts: readonly { readonly key: string; readonly count: number }[];
  readonly predicates: ScaP09GatePredicatesV1;
  readonly blocker_codes: readonly string[];
  readonly invalid_blocker_codes: readonly string[];
}

export interface ScaP09ReconcileInputV1 {
  readonly admitted: ScaP09AdmissionResultV1;
  readonly reassessment: ScaP09ReassessmentV1 | null;
  readonly prior_ledger: ScaP09ReconciliationLedgerV1 | null;
  readonly prior_ledger_ref: ArtifactRef | null;
  /** Exact persisted P09 checkpoint refs, keyed by the item they account for. */
  readonly checkpoint_refs_by_item_id: ReadonlyMap<string, ArtifactRef>;
}

/** P01 obligation phases that a P06 action relies on and that must therefore precede it. */
const ACTION_P01_PRECEDENCE_PHASES: ReadonlySet<string> = new Set([
  "SCA-P01",
  "SCA-P02",
  "SCA-P03",
  "SCA-P04",
  "SCA-P05",
  "SCA-P06",
  "M1",
]);

/**
 * Coverage states that are honest, accounted decisions rather than unresolved gaps. A deliberate
 * omission or scope exclusion is recorded exactly; only unsupported/failed/denied/truncated
 * surfaces are unresolved blockers.
 */
const NON_BLOCKING_COVERAGE_STATES: ReadonlySet<string> = new Set([
  "covered",
  "omitted",
  "excluded",
]);

function bindingRef(item: ScaP09LedgerItemV1): ArtifactRef {
  return item.p08_disposition_ref ?? item.checkpoint_ref ?? item.primary_ref;
}
function countBy(values: readonly string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}
function uniqueSorted(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0
  );
}
function isRequiredResultKind(item: ScaP09AdmittedItemV1): boolean {
  if (item.item_kind === "p06_obligation") return true;
  return item.item_kind === "p01_obligation" && item.effective_class === "required-result";
}

/** Eligibility is derived only from the inherited P08 disposition and coverage state (`SCA-P09` R9). */
function eligibilityOf(item: ScaP09AdmittedItemV1): ScaP09EligibilityV1 {
  if (item.item_kind === "candidate" || item.item_kind === "surface") return "non_finding";
  switch (item.p08_disposition) {
    case "confirmed":
    case "rejected-with-evidence":
      return "eligible";
    case "inconclusive":
    case "deferred":
      return "ineligible";
    case "duplicate-of":
    case "out-of-scope":
      return "non_finding";
    default:
      return "non_finding";
  }
}

/**
 * Resolution truth (`SCA-P09` R3/R6/R10): a due required-result obligation is resolved only by an
 * exact adequate obligation-resolution entry (P01) or an eligible inherited disposition (P06).
 * A P01 ledger entry's frozen `status: pending` is never resolution evidence.
 */
function isResolved(
  item: ScaP09AdmittedItemV1,
  resolutionIds: ReadonlySet<string>,
  eligibility: ScaP09EligibilityV1
): boolean {
  if (!item.due_at_p09_entry) return false;
  if (item.item_kind === "p06_obligation") return eligibility === "eligible";
  if (item.item_kind === "p01_obligation" && item.effective_class === "required-result") {
    return resolutionIds.has(item.identity);
  }
  return false;
}

/**
 * Re-verify the P01 obligation history independently of the ledger validator: duplicate
 * registrations, replayed revisions, and non-monotone promotions are conflicting replay; a
 * promotion that lowers a class is a post-failure downgrade (`SCA-O02`, `SCA-P09` R4).
 */
function verifyP01History(head: ReturnType<typeof validateScaObligationLedgerV2>): {
  readonly conflictingReplay: boolean;
  readonly monotoneDowngrade: boolean;
} {
  const revisions = new Map<string, ScaObligationEntryV2>();
  const operationIds = new Set<string>();
  let conflictingReplay = false;
  let monotoneDowngrade = false;
  for (const entry of head.entries) {
    const prior = revisions.get(entry.obligation_id);
    if (prior === undefined) {
      if (
        entry.revision !== 1 ||
        entry.revision_kind !== "registered" ||
        entry.prior_entry_sha256 !== null
      ) {
        conflictingReplay = true;
      }
    } else if (
      entry.revision !== prior.revision + 1 ||
      entry.revision_kind !== "promoted" ||
      entry.prior_entry_sha256 !== prior.entry_sha256
    ) {
      conflictingReplay = true;
    } else if (
      scaP09ObligationClassPrecedence(entry.effective_class) <=
      scaP09ObligationClassPrecedence(prior.effective_class)
    ) {
      monotoneDowngrade = true;
    }
    revisions.set(entry.obligation_id, entry);
  }
  for (const event of head.events) {
    if (operationIds.has(event.operation_id)) conflictingReplay = true;
    operationIds.add(event.operation_id);
  }
  return { conflictingReplay, monotoneDowngrade };
}

export function reconcileScaP09(input: ScaP09ReconcileInputV1): ScaP09ReconciliationResultV1 {
  const { admitted } = input;
  if (admitted.non_reconcilable) {
    throw new Error("P09 reconciliation is unavailable for a non-reconcilable checkpoint");
  }
  const blockers = new Set<string>(admitted.invalid_blocker_codes);

  // R3/R4.1: immutable effective-class derivation and underclassification.
  let effectiveClassValid = true;
  let underclassification = false;
  for (const derivation of admitted.p01_obligations.values()) {
    if (derivation.precedence !== scaP09ObligationClassPrecedence(derivation.effective_class)) {
      effectiveClassValid = false;
      blockers.add("p09_effective_class_invalid::precedence_field");
    }
    if (
      scaP09ObligationClassPrecedence(derivation.strongest_class_seen) >
      scaP09ObligationClassPrecedence(derivation.effective_class)
    ) {
      effectiveClassValid = false;
      blockers.add("p09_effective_class_invalid::monotone_chain");
    }
    if (derivation.effective_class === "optional" && derivation.material) {
      underclassification = true;
      blockers.add("p09_underclassification::required_for_campaign_optional");
    }
    if (
      (derivation.scope === "phase" ||
        derivation.scope === "phase-output" ||
        derivation.scope === "milestone" ||
        derivation.scope === "report-output") &&
      derivation.effective_class !== "required-result"
    ) {
      underclassification = true;
      blockers.add("p09_underclassification::mandatory_scope");
    }
  }

  // R4.2 and R4.4: post-failure downgrade and conflicting replay against the P01 history.
  let postFailureDowngrade = false;
  let conflictingReplay = false;
  if (admitted.p01_ledger !== null) {
    const history = verifyP01History(validateScaObligationLedgerV2(admitted.p01_ledger));
    if (history.conflictingReplay) {
      conflictingReplay = true;
      blockers.add("p09_conflicting_replay::p01_history");
    }
    if (history.monotoneDowngrade) {
      postFailureDowngrade = true;
      blockers.add("p09_post_failure_downgrade::p01_weakened");
    }
  }

  // The hypothesis each admitted item belongs to, so a blocked action cannot leave its
  // dependents confirmed or refuted under a weaker claim (R4.2).
  const blockedStatusByHypothesis = new Map<string, "blocked" | "not_invoked">();
  for (const item of admitted.items) {
    if (item.item_kind !== "action" || item.p07_status === null) continue;
    const hypothesisId = admitted.hypothesis_id_by_identity.get(item.identity);
    if (hypothesisId !== undefined && item.p07_status !== "completed") {
      blockedStatusByHypothesis.set(hypothesisId, item.p07_status);
    }
  }
  for (const item of admitted.items) {
    if (item.p08_disposition !== "confirmed" && item.p08_disposition !== "rejected-with-evidence") {
      continue;
    }
    const direct =
      item.p07_status !== null && item.p07_status !== "completed" ? item.p07_status : undefined;
    const hypothesisId = admitted.hypothesis_id_by_identity.get(item.identity);
    const inherited =
      hypothesisId === undefined ? undefined : blockedStatusByHypothesis.get(hypothesisId);
    if ((direct ?? inherited) !== undefined) {
      postFailureDowngrade = true;
      blockers.add("p09_post_failure_downgrade::blocked_action_satisfied");
    }
  }

  // R4.3: a P06 action's relied-on obligation (P06 revision, its P05 hypothesis, and any discovery
  // reassessment) must have been admitted and registered *before* the action's `created_at`.
  let lateAction = false;
  for (const item of admitted.items) {
    if (item.item_kind !== "action") continue;
    const action = admitted.action_by_identity.get(item.identity);
    if (action === undefined) {
      lateAction = true;
      blockers.add("p09_late_unregistered_action::action_absent");
      continue;
    }
    const obligation = admitted.p06_obligation_by_identity.get(action.effective_obligation_id);
    if (obligation === undefined) {
      lateAction = true;
      blockers.add("p09_late_unregistered_action::obligation_absent");
      continue;
    }
    if (
      action.obligation_revision_ref.artifact_id !== obligation.revision_ref.artifact_id ||
      action.obligation_revision_sha256 !== obligation.revision_ref.content_digest
    ) {
      lateAction = true;
      blockers.add("p09_late_unregistered_action::obligation_mismatch");
    }
    if (obligation.revision.created_at > action.created_at) {
      lateAction = true;
      blockers.add("p09_late_unregistered_action::obligation_after_action");
    }
    if (
      obligation.hypothesis_created_at !== null &&
      obligation.hypothesis_created_at > action.created_at
    ) {
      lateAction = true;
      blockers.add("p09_late_unregistered_action::hypothesis_after_action");
    }
    if (
      obligation.reassessment_evaluated_at !== null &&
      obligation.reassessment_evaluated_at > action.created_at
    ) {
      lateAction = true;
      blockers.add("p09_late_unregistered_action::reassessment_after_action");
    }
    // Every P01-level obligation the action relies on must likewise precede the action.
    for (const derivation of admitted.p01_obligations.values()) {
      const applies =
        derivation.semantic_phase_id === null
          ? derivation.scope === "boundary"
          : ACTION_P01_PRECEDENCE_PHASES.has(derivation.semantic_phase_id);
      if (applies && derivation.occurred_at > action.created_at) {
        lateAction = true;
        blockers.add("p09_late_unregistered_action::p01_obligation_after_action");
      }
    }
  }

  // R7: the append-only reassessment lineage binds the exact earlier ledger and never lets
  // invalidated evidence survive as current support. A same-campaign/run revision is coherent when
  // it versions an earlier finalized P09 ledger snapshot.
  let appendOnlyRevisions = true;
  if (input.reassessment !== null) {
    if (
      input.prior_ledger === null ||
      input.prior_ledger_ref === null ||
      input.reassessment.prior_p09_ledger_ref.artifact_id !== input.prior_ledger_ref.artifact_id ||
      input.reassessment.prior_p09_ledger_ref.content_digest !==
        input.prior_ledger_ref.content_digest
    ) {
      appendOnlyRevisions = false;
      blockers.add("p09_revision_chain_invalid::reassessment_prior");
    } else if (input.prior_ledger.append_only !== true || input.prior_ledger.lane === undefined) {
      // The predecessor must be a finalized append-only snapshot, same campaign/run or earlier.
      appendOnlyRevisions = false;
      blockers.add("p09_revision_chain_invalid::prior_ledger_unfinalized");
    }
  }

  // Per-item eligibility, blockers, and due required-result resolution.
  const resolutionIds = new Set(admitted.obligation_resolutions.keys());
  const ledgerItems: ScaP09LedgerItemV1[] = [];
  for (const item of admitted.items) {
    const itemBlockers = new Set<string>([
      ...item.p08_blocker_codes,
      ...item.coverage_blocker_codes,
    ]);
    if (item.p07_status !== null && item.p07_status !== "completed") {
      itemBlockers.add("p09_p07_row_unresolved");
    }
    if (item.checkpoint_needed !== null) itemBlockers.add(item.checkpoint_needed.reason_code);
    if (item.coverage_state !== null && !NON_BLOCKING_COVERAGE_STATES.has(item.coverage_state)) {
      itemBlockers.add(`p09_coverage_${item.coverage_state}`);
    }
    const eligibility = eligibilityOf(item);
    const resolved = isResolved(item, resolutionIds, eligibility);
    if (item.due_at_p09_entry && isRequiredResultKind(item) && !resolved) {
      itemBlockers.add("p09_required_result_unresolved");
    }
    const persistedCheckpoint = input.checkpoint_refs_by_item_id.get(item.item_id) ?? null;
    if (item.checkpoint_needed !== null && persistedCheckpoint === null) {
      throw new Error("P09 unresolved checkpoint item lacks its exact persisted checkpoint");
    }
    const blockerCodes = [...itemBlockers].sort();
    for (const code of blockerCodes) blockers.add(code);
    ledgerItems.push({
      item_id: item.item_id,
      item_kind: item.item_kind,
      identity: item.identity,
      primary_ref: item.primary_ref,
      p08_disposition: item.p08_disposition,
      p08_disposition_ref: item.p08_disposition_ref,
      checkpoint_ref: item.p06_checkpoint_ref ?? persistedCheckpoint,
      effective_class: item.effective_class,
      precedence: item.precedence,
      revision_chain_refs: [...item.revision_chain_refs],
      coverage_state: item.coverage_state,
      eligibility,
      due_at_p09_entry: item.due_at_p09_entry,
      resolved,
      blocker_codes: blockerCodes,
    });
  }
  const ordered = [...ledgerItems].sort((left, right) =>
    left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0
  );

  const requiredTotal = ordered.filter((item) => item.due_at_p09_entry && requiredResultKind(item));
  const requiredResolved = requiredTotal.filter((item) => item.resolved);
  const downstreamPendingIds = ordered
    .filter(
      (item) =>
        item.item_kind === "p01_obligation" &&
        !item.due_at_p09_entry &&
        item.effective_class === "required-result"
    )
    .map((item) => item.identity)
    .sort();
  const eligibleItems = ordered.filter((item) => item.eligibility === "eligible");
  const eligibleIds = new Set(eligibleItems.map((item) => item.item_id));
  const ineligibleItems = ordered.filter(
    (item) =>
      !eligibleIds.has(item.item_id) &&
      (item.eligibility === "ineligible" || item.blocker_codes.length > 0)
  );
  const unresolvedItems = ordered.filter((item) => item.blocker_codes.length > 0);

  if (input.reassessment !== null) {
    const priorBindings = priorLedgerBindingIds(input.prior_ledger);
    for (const ref of input.reassessment.invalidated_evidence_refs) {
      if (eligibleItems.some((item) => bindingRef(item).artifact_id === ref.artifact_id)) {
        appendOnlyRevisions = false;
        blockers.add("p09_revision_chain_invalid::invalidated_survived");
      }
      if (!priorBindings.has(ref.artifact_id)) {
        appendOnlyRevisions = false;
        blockers.add("p09_revision_chain_invalid::invalidated_not_relied_on");
      }
    }
  }

  const coverageComplete = scaP09CoverageComplete(admitted.coverage_input);
  const exhaustiveAccounting =
    ordered.length === admitted.items.length &&
    new Set(ordered.map((item) => item.item_id)).size === ordered.length;

  const invalidBlockerCodes = [...blockers].filter(isScaP09InvalidBlocker).sort();
  const setEqualityValid = invalidBlockerCodes.every(
    (code) =>
      !code.startsWith("p09_set_equality_violation") && !code.startsWith("p09_unaccounted_item")
  );
  const effectiveClassDerivationValid = effectiveClassValid && !underclassification;

  // Derived, non-hardcoded predicates. Each is a genuine computation over admitted facts.
  const immutableP08LineageValid = admitted.admission.p08_rederivation_ok;
  const eligibleHandoffOnly =
    eligibleItems.every((item) => item.blocker_codes.length === 0) &&
    unresolvedItems.every((item) => item.eligibility !== "eligible");
  const expectedDownstream = [...admitted.p01_obligations.values()].filter(
    (derivation) => !derivation.due_at_p09_entry && derivation.effective_class === "required-result"
  ).length;
  const downstreamAccountingPresent = downstreamPendingIds.length === expectedDownstream;
  const p12OrReleaseClaimsAbsent =
    admitted.p08_terminal !== null &&
    admitted.p08_terminal.release_eligible === false &&
    admitted.p08_terminal.campaign_complete === false &&
    admitted.p08_terminal.nonterminal_campaign === true;

  const allPredicatesMet =
    exhaustiveAccounting &&
    immutableP08LineageValid &&
    setEqualityValid &&
    invalidBlockerCodes.length === 0 &&
    effectiveClassDerivationValid &&
    !underclassification &&
    !postFailureDowngrade &&
    !lateAction &&
    !conflictingReplay &&
    appendOnlyRevisions &&
    eligibleHandoffOnly &&
    downstreamAccountingPresent &&
    p12OrReleaseClaimsAbsent;

  let lane: ScaP09AssignedLaneV1 | null;
  if (!allPredicatesMet) {
    lane = null;
  } else if (
    requiredTotal.length > 0 &&
    requiredResolved.length === requiredTotal.length &&
    coverageComplete &&
    admitted.p08_gate !== null &&
    admitted.p08_gate.verdict === "pass_ready" &&
    admitted.p08_terminal !== null &&
    admitted.p08_terminal.status === "candidate_complete" &&
    blockers.size === 0
  ) {
    lane = "accepted_progression";
  } else {
    lane = "incomplete_closeout";
  }

  const finalBlockers = [...blockers].sort();
  const predicates: ScaP09GatePredicatesV1 = {
    exhaustive_accounting: exhaustiveAccounting,
    immutable_p08_lineage_valid: immutableP08LineageValid,
    set_equality_valid: setEqualityValid,
    effective_class_derivation_valid: effectiveClassDerivationValid,
    no_underclassification: !underclassification,
    no_post_failure_downgrade: !postFailureDowngrade,
    no_late_unregistered_action: !lateAction,
    no_conflicting_replay: !conflictingReplay,
    coverage_reconciled: coverageComplete,
    append_only_revisions: appendOnlyRevisions,
    eligible_handoff_only: eligibleHandoffOnly,
    downstream_accounting_present: downstreamAccountingPresent,
    p12_or_release_claims_absent: p12OrReleaseClaimsAbsent,
  };

  return {
    lane,
    items: ordered,
    eligible_refs: uniqueSorted(eligibleItems.map(bindingRef)),
    ineligible_refs: uniqueSorted(ineligibleItems.map(bindingRef)),
    unresolved_item_refs: uniqueSorted(unresolvedItems.map(bindingRef)),
    required_result_total: requiredTotal.length,
    required_result_resolved: requiredResolved.length,
    downstream_pending_required_result_ids: downstreamPendingIds,
    kind_counts: countBy(ordered.map((item) => item.item_kind)),
    disposition_counts: countBy(
      ordered
        .map((item) => item.p08_disposition)
        .filter((value): value is NonNullable<typeof value> => value !== null)
    ),
    predicates,
    blocker_codes: finalBlockers,
    invalid_blocker_codes: invalidBlockerCodes,
  };
}

function requiredResultKind(item: ScaP09LedgerItemV1): boolean {
  if (item.item_kind === "p06_obligation") return true;
  return item.item_kind === "p01_obligation" && item.effective_class === "required-result";
}

/** The exact artifact ids a prior P09 ledger relied on as item bindings. */
function priorLedgerBindingIds(prior: ScaP09ReconciliationLedgerV1 | null): ReadonlySet<string> {
  const ids = new Set<string>();
  if (prior === null) return ids;
  for (const item of prior.items) {
    ids.add((item.p08_disposition_ref ?? item.checkpoint_ref ?? item.primary_ref).artifact_id);
  }
  for (const ref of [
    ...prior.eligible_refs,
    ...prior.ineligible_refs,
    ...prior.unresolved_item_refs,
  ]) {
    ids.add(ref.artifact_id);
  }
  return ids;
}
