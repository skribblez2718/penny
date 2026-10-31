import type { ArtifactRef } from "../contracts.js";
import type { ScaP09LedgerItemV1, ScaP09ReconciliationLedgerV1 } from "./p09-contracts.js";
import type {
  ScaP10RuleCandidateRegistryV1,
  ScaP10RuleLearningOutcomeV1,
} from "./p10-contracts.js";
import {
  SCA_P11_RECONCILIATION_SCHEMA,
  scaP11RecordId,
  scaP11ReportStatusForDisposition,
  validateScaP11ReconciliationV1,
  withP11Digest,
  type ScaP11InternalDispositionV1,
  type ScaP11ReconciliationRowV1,
  type ScaP11ReconciliationV1,
} from "./p11-contracts.js";

/**
 * Deterministic, host-owned reconciliation manifest (`SCA-P11` R02/R03/R11). It accounts for every
 * upstream record exactly once — the reconciled P09 ledger items, the recorded P10 rule-learning
 * outcome, and every registered P10 rule candidate — and preserves refuted, duplicate, out-of-scope,
 * blocked and unresolved records rather than inventing confirmed findings. AI-discovered issues that
 * have no deterministic scanner JSON record are marked `semantic_only` and never dropped because
 * their scanner narrative fields are absent.
 */
export interface ScaP11ReconciliationInputV1 {
  readonly run_id: string;
  readonly revision: number;
  readonly p09_reconciliation_ledger_ref: ArtifactRef;
  readonly ledger: ScaP09ReconciliationLedgerV1;
  readonly p10_outcome_ref: ArtifactRef | null;
  readonly p10_outcome: ScaP10RuleLearningOutcomeV1 | null;
  readonly p10_registry: ScaP10RuleCandidateRegistryV1 | null;
  /**
   * Exact evidence the recorded P11 reassessment invalidated. A reconciled record supported by an
   * invalidated ref is retained as a non-reportable record rather than surviving as reportable
   * support or being silently rewritten away (`P11-R02`/`P11-R11`).
   */
  readonly invalidated_evidence_refs?: readonly ArtifactRef[];
}

/**
 * AI-discovered hypotheses have no deterministic scanner JSON record; a confirmed hypothesis is an
 * established issue that must still appear in every representation.
 */
export function scaP11IsSemanticOnly(item: ScaP09LedgerItemV1): boolean {
  return item.item_kind === "hypothesis";
}

function p09Row(
  item: ScaP09LedgerItemV1,
  invalidatedEvidenceIds: ReadonlySet<string>
): ScaP11ReconciliationRowV1 {
  const disposition: ScaP11InternalDispositionV1 | "not_disposed" =
    item.p08_disposition ?? "not_disposed";
  const sourceRefs = [
    item.primary_ref,
    ...(item.p08_disposition_ref === null ? [] : [item.p08_disposition_ref]),
  ]
    .map((ref) => ref)
    .filter(
      (ref, index, all) => all.findIndex((other) => other.artifact_id === ref.artifact_id) === index
    )
    .sort((left, right) => (left.artifact_id < right.artifact_id ? -1 : 1));
  const invalidatedSupport = sourceRefs.some((ref) => invalidatedEvidenceIds.has(ref.artifact_id));
  const reportStatus =
    disposition === "not_disposed" || invalidatedSupport
      ? null
      : scaP11ReportStatusForDisposition(disposition);
  const reportable = reportStatus !== null;
  const semanticOnly = scaP11IsSemanticOnly(item);
  const missing: string[] = [];
  if (invalidatedSupport) {
    missing.push(
      "evidence invalidated by the recorded reassessment; retained as an unresolved non-reportable record"
    );
  }
  if (disposition === "confirmed" && item.p08_disposition_ref === null) {
    missing.push("established issue lacks its exact disposition revision");
  }
  if (disposition === "duplicate-of") {
    missing.push("duplicate target identity is not recorded by the reconciled ledger");
  }
  if (item.eligibility === "eligible" && disposition === "not_disposed") {
    missing.push("eligible reconciled item carries no disposition");
  }
  return {
    record_id: scaP11RecordId({ record_kind: "p09_ledger_item", identity: item.identity }),
    record_kind: "p09_ledger_item",
    identity: item.identity,
    item_id: item.item_id,
    source_refs: sourceRefs,
    current_disposition: disposition,
    report_status: reportStatus,
    reportable,
    semantic_only: semanticOnly,
    representation_presence: { markdown: reportable, json: reportable, sarif: reportable },
    duplicate_of: null,
    missing_material: [...missing].sort(),
    checkpoint_ref: item.checkpoint_ref,
  };
}

function outcomeRow(outcome: ScaP10RuleLearningOutcomeV1): ScaP11ReconciliationRowV1 {
  const identity = `p10outcome:${outcome.disposition}`;
  return {
    record_id: scaP11RecordId({ record_kind: "p10_rule_learning_outcome", identity }),
    record_kind: "p10_rule_learning_outcome",
    identity,
    item_id: null,
    source_refs: [outcome.eligibility_ledger_ref],
    current_disposition: "not_disposed",
    report_status: null,
    reportable: false,
    semantic_only: false,
    representation_presence: { markdown: false, json: false, sarif: false },
    duplicate_of: null,
    missing_material: [],
    checkpoint_ref: outcome.quarantine_records_ref,
  };
}

function candidateRow(candidateId: string): ScaP11ReconciliationRowV1 {
  return {
    record_id: scaP11RecordId({ record_kind: "p10_rule_candidate", identity: candidateId }),
    record_kind: "p10_rule_candidate",
    identity: candidateId,
    item_id: null,
    source_refs: [],
    current_disposition: "not_disposed",
    report_status: null,
    reportable: false,
    semantic_only: false,
    representation_presence: { markdown: false, json: false, sarif: false },
    duplicate_of: null,
    missing_material: [],
    checkpoint_ref: null,
  };
}

export function reconcileScaP11(input: ScaP11ReconciliationInputV1): ScaP11ReconciliationV1 {
  const invalidatedEvidenceIds = new Set(
    (input.invalidated_evidence_refs ?? []).map((ref) => ref.artifact_id)
  );
  const rows: ScaP11ReconciliationRowV1[] = [];
  for (const item of input.ledger.items) rows.push(p09Row(item, invalidatedEvidenceIds));
  if (input.p10_outcome !== null) rows.push(outcomeRow(input.p10_outcome));
  for (const candidate of input.p10_registry?.candidates ?? []) {
    rows.push(candidateRow(candidate.candidate_id));
  }
  const sorted = [...rows].sort((left, right) =>
    left.record_id < right.record_id ? -1 : left.record_id > right.record_id ? 1 : 0
  );
  const ids = new Set(sorted.map((row) => row.record_id));
  if (ids.size !== sorted.length) {
    throw new Error("SCA P11 reconciliation produced a duplicate record identity");
  }
  // Set equality: every reconciled P09 ledger item, the P10 outcome, and every registered candidate
  // is present exactly once. The flag is derived from the exact universe, not asserted.
  const expected =
    input.ledger.items.length +
    (input.p10_outcome === null ? 0 : 1) +
    (input.p10_registry?.candidate_count ?? 0);
  const setEqualityValid = sorted.length === expected;
  if (!setEqualityValid) {
    throw new Error("SCA P11 reconciliation universe is not exhaustive");
  }
  const reportable = sorted.filter((row) => row.reportable);
  const semanticOnly = sorted.filter((row) => row.semantic_only);
  const retained = sorted.filter(
    (row) => !row.reportable && row.current_disposition !== "not_disposed"
  );
  const unresolved = sorted.filter((row) => row.checkpoint_ref !== null);
  return validateScaP11ReconciliationV1(
    withP11Digest(
      {
        schema_id: SCA_P11_RECONCILIATION_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: input.run_id,
        revision: input.revision,
        p09_reconciliation_ledger_ref: input.p09_reconciliation_ledger_ref,
        p10_outcome_ref: input.p10_outcome_ref,
        rows: sorted,
        record_count: sorted.length,
        reportable_count: reportable.length,
        semantic_only_count: semanticOnly.length,
        retained_non_reportable_count: retained.length,
        unresolved_count: unresolved.length,
        set_equality_valid: setEqualityValid,
        append_only: true as const,
      },
      "reconciliation_sha256"
    )
  );
}
