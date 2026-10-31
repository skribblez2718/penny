import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import {
  validateHostOperationReceipt,
  validateHostOperationResult,
} from "../host-operations/contracts.js";
import {
  SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
  validateScaCampaignSourceSnapshotV2,
} from "./p01-contracts.js";
import {
  validateScaP05HypothesisRevisionV1,
  validateScaP05TraceabilityV1,
  type ScaP05HypothesisBodyV1,
} from "./p05-contracts.js";
import {
  validateScaP06AcceptedCohortV1,
  validateScaP06ActionRecordV1,
  validateScaP06GateV1,
  validateScaP06ObligationRevisionV1,
  validateScaP06SuccessorLedgerV1,
  validateScaP06ToP07TransitionV1,
  validateScaP06TraceabilityV1,
  type ScaP06ActionRecordV1,
} from "./p06-contracts.js";
import { admitScaP07ExecutionPlan, type ScaP07CurrentAuthorityScopeV1 } from "./p07-admission.js";
import { SCA_P07_OPERATION_KIND } from "./p07-operation.js";
import {
  validateScaP07AdmissionV1,
  validateScaP07EvidenceLedgerV1,
  validateScaP07HostRequestV1,
  validateScaP07HostResultV1,
  validateScaP07TerminalV1,
  validateScaP07ToP08TransitionV1,
  type ScaP07ActionOutcomeV1,
  type ScaP07EvidenceLedgerV1,
} from "./p07-contracts.js";
import {
  SCA_P08_ADMISSION_SCHEMA,
  SCA_P08_ITEM_UNIVERSE_SCHEMA,
  isScaP08ScopeDecisionKind,
  scaP08DuplicatePairKey,
  scaP08ItemId,
  validateScaP08AdmissionV1,
  validateScaP08DisclosureScopeV1,
  validateScaP08DispositionRevisionV1,
  validateScaP08DuplicateEquivalenceProofV1,
  validateScaP08EvidenceLedgerV1,
  validateScaP08ItemUniverseV1,
  validateScaP08ReassessmentV1,
  withP08Digest,
  type ScaP08AdmissionV1,
  type ScaP08DisclosureScopeV1,
  type ScaP08DispositionRevisionV1,
  type ScaP08DuplicateEquivalenceProofV1,
  type ScaP08EvidenceLedgerV1,
  type ScaP08ItemKindV1,
  type ScaP08ItemUniverseItemV1,
  type ScaP08ItemUniverseV1,
  type ScaP08ReassessmentEntryV1,
  type ScaP08ReassessmentV1,
} from "./p08-contracts.js";

type P07Status = "completed" | "blocked" | "not_invoked";

/** One admitted universe item projected with the exact lineage the host later validates against. */
export interface ScaP08AdmittedItemV1 {
  readonly item_id: string;
  readonly item_kind: ScaP08ItemKindV1;
  readonly identity: string;
  readonly primary_ref: ArtifactRef;
  readonly hypothesis_id: string | null;
  readonly p07_status: P07Status | null;
  readonly p07_evidence_refs: readonly ArtifactRef[];
  readonly p07_ledger_row_operation_id: string | null;
  readonly hypothesis: ScaP05HypothesisBodyV1 | null;
  readonly excerpt: string;
  /** Exact prior P08 revision this item carried in the reassessed ledger, when one was admitted. */
  readonly prior_disposition_ref: ArtifactRef | null;
  /** Admitted typed equivalence proofs that name this item as the duplicate subject. */
  readonly duplicate_equivalence_proof_refs: readonly ArtifactRef[];
}

/** One admitted prior P08 revision plus its full append-only chain (ascending revision order). */
export interface ScaP08PriorItemV1 {
  readonly revision: ScaP08DispositionRevisionV1;
  readonly ref: ArtifactRef;
  readonly chain: readonly ArtifactRef[];
}

export interface ScaP08AdmissionResultV1 {
  readonly admission: ScaP08AdmissionV1;
  readonly universe: ScaP08ItemUniverseV1;
  readonly disclosure_scope: ScaP08DisclosureScopeV1;
  readonly items: readonly ScaP08AdmittedItemV1[];
  readonly p07_status_by_item_id: ReadonlyMap<string, P07Status>;
  readonly admitted_evidence_ref_ids: ReadonlySet<string>;
  readonly evidence_refs: readonly ArtifactRef[];
  readonly prior_ledger: ScaP08EvidenceLedgerV1 | null;
  readonly prior_ledger_ref: ArtifactRef | null;
  readonly prior_by_item_id: ReadonlyMap<string, ScaP08PriorItemV1>;
  readonly reassessment: ScaP08ReassessmentV1 | null;
  readonly reassessment_ref: ArtifactRef | null;
  readonly reassessment_by_item_id: ReadonlyMap<string, ScaP08ReassessmentEntryV1>;
  /** Exact admitted P01/P06 campaign/source scope-decision records admissible as evidence. */
  readonly scope_decision_refs: readonly ArtifactRef[];
  /** Their artifact ids, for the `out-of-scope` support-context membership check. */
  readonly scope_decision_ref_ids: ReadonlySet<string>;
  /** Admitted typed equivalence-proof content for each exact duplicate pair. */
  readonly equivalence_proof_by_pair: ReadonlyMap<
    string,
    { readonly ref: ArtifactRef; readonly proof: ScaP08DuplicateEquivalenceProofV1 }
  >;
  readonly equivalence_proof_refs: readonly ArtifactRef[];
}

export interface ScaP08AdmissionInputV1 {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly p07_terminal_ref: ArtifactRef;
  readonly p07_evidence_ledger_ref: ArtifactRef;
  readonly p07_transition_ref: ArtifactRef | null;
  readonly disclosure_scope_ref: ArtifactRef;
  /** Optional exact prior P08 evidence ledger to reassess against. */
  readonly p08_reassessment_ref?: ArtifactRef | null;
  /** Optional exact host-issued duplicate-equivalence proofs cited by `duplicate-of` items. */
  readonly p08_equivalence_proof_refs?: readonly ArtifactRef[];
  /**
   * Independent resolver of the current P07 execution authority. Absent only for the exported
   * provider-free compatibility fixture, which revalidates the ledger's own authority.
   */
  readonly resolve_current_p07_authority_ref?: (
    scope: ScaP07CurrentAuthorityScopeV1
  ) => ArtifactRef;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function requireSame(left: unknown, right: unknown, label: string): void {
  if (!same(left, right)) throw new Error(`P08 ${label} exact binding mismatch`);
}
function exact<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  kind: string,
  validate: (value: unknown) => T
): T {
  if (ref.kind !== kind || !same(store.refById(ref.artifact_id), ref)) {
    throw new Error(`P08 ${kind} exact ref absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P08 ${kind} exact bytes drifted`);
  }
  const text = bytes.toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error(`P08 ${kind} noncanonical bytes`);
  return validate(parsed);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function bounded(text: string): string {
  const trimmed = text.trim();
  return (trimmed.length === 0 ? "unresolved item" : trimmed).slice(0, 12_000);
}
function actionExcerpt(item: ScaP06ActionRecordV1, status: P07Status): string {
  return bounded(
    `action ${item.action_id}: selected ${item.selected_action.action_kind} (${item.decision_classification}) for hypothesis ${item.hypothesis_id}; P07 status ${status}`
  );
}

function rowForAction(
  ledger: ScaP07EvidenceLedgerV1,
  actionRef: ArtifactRef
): ScaP07EvidenceLedgerV1["rows"][number] {
  const row = ledger.rows.find(
    (candidate) => candidate.action_record_ref.artifact_id === actionRef.artifact_id
  );
  if (row === undefined) throw new Error("P08 P07 ledger omits an admitted action");
  return row;
}

/**
 * Exact-read and cross-validate one P07 action row's host evidence (`SCA-P08` R1.6). Every
 * non-null `host_request_ref`/`host_result_ref`/`platform_result_ref`/`host_receipt_ref` is
 * re-read byte-exactly, the host result is revalidated against its host request, and the platform
 * result and host receipt are revalidated against each other and against the row's exact request.
 * Any absent, substituted, digest-drifted, or inconsistent ref aborts admission before any model
 * call; a `blocked`/checkpoint run therefore never leaves row evidence unverified.
 */
function verifyRowHostEvidence(
  store: ArtifactHostStore,
  runId: string,
  row: ScaP07ActionOutcomeV1
): ArtifactRef[] {
  const refs: ArtifactRef[] = [row.host_request_ref];
  const request = exact(
    store,
    row.host_request_ref,
    "sca-p07-host-request",
    validateScaP07HostRequestV1
  );
  const resultRef = row.host_result_ref;
  if (resultRef !== null) {
    exact(store, resultRef, "sca-p07-host-result", (value) =>
      validateScaP07HostResultV1(value, request)
    );
    refs.push(resultRef);
  }
  const platformRef = row.platform_result_ref;
  const receiptRef = row.host_receipt_ref;
  if ((platformRef === null) !== (receiptRef === null)) {
    throw new Error("P08 P07 row cites a host platform result without its exact receipt");
  }
  if (platformRef !== null && receiptRef !== null) {
    const platform = exact(
      store,
      platformRef,
      "host-operation-result",
      validateHostOperationResult
    );
    const receipt = exact(
      store,
      receiptRef,
      "host-operation-receipt",
      validateHostOperationReceipt
    );
    const platformResultRef = platform.operation_result_ref;
    if (
      platform.operation_kind !== SCA_P07_OPERATION_KIND ||
      receipt.operation_kind !== SCA_P07_OPERATION_KIND ||
      platform.identity.run_id !== runId ||
      receipt.identity.run_id !== runId ||
      !same(platform.identity, receipt.identity) ||
      platform.operation_record_id !== receipt.operation_record_id ||
      platform.request_sha256 !== receipt.request_sha256 ||
      platform.registration_sha256 !== receipt.registration_sha256 ||
      platform.operation_id !== row.operation_id ||
      receipt.operation_id !== row.operation_id ||
      platform.request_sha256 !== row.host_request_ref.content_digest ||
      (platformResultRef === null) !== (resultRef === null) ||
      (platformResultRef !== null && !same(platformResultRef, resultRef)) ||
      (receipt.result_sha256 === null) !== (resultRef === null) ||
      (receipt.result_sha256 !== null &&
        resultRef !== null &&
        receipt.result_sha256 !== resultRef.content_digest)
    ) {
      throw new Error("P08 P07 row host result/receipt/platform relationship mismatch");
    }
    refs.push(platformRef, receiptRef);
  }
  return refs;
}

/**
 * Exact P07/P06/P01 lineage admission for the inactive P08 candidate. It re-derives the P07
 * admission through the shared `admitScaP07ExecutionPlan` path (never a second engine), requires
 * the P07→P08 transition to be explicitly non-authorizing when present, and builds the closed item
 * universe of P06 actions, hypotheses, and evidence obligations. Any absent, substituted, cross-run,
 * stale, rehashed, or digest-drifted ref aborts admission before any provider call.
 */
export function admitScaP08Disposition(input: ScaP08AdmissionInputV1): ScaP08AdmissionResultV1 {
  const { store } = input;
  const terminal = exact(
    store,
    input.p07_terminal_ref,
    "sca-p07-terminal",
    validateScaP07TerminalV1
  );
  const ledger = exact(
    store,
    input.p07_evidence_ledger_ref,
    "sca-p07-evidence-ledger",
    validateScaP07EvidenceLedgerV1
  );
  const disclosureScope = exact(
    store,
    input.disclosure_scope_ref,
    "sca-p08-disclosure-scope",
    validateScaP08DisclosureScopeV1
  );
  requireSame(terminal.evidence_ledger_ref, input.p07_evidence_ledger_ref, "terminal ledger");
  if (ledger.run_id !== input.run_id) throw new Error("P08 P07 ledger belongs to another run");
  if (disclosureScope.run_id !== input.run_id) {
    throw new Error("P08 disclosure scope belongs to another run");
  }

  let blockedCheckpoint = false;
  if (input.p07_transition_ref === null) {
    if (terminal.status === "candidate_complete" || terminal.p08_transition_ref !== null) {
      throw new Error("P08 requires the recorded P07 handoff transition");
    }
    blockedCheckpoint = true;
  } else {
    const transition = exact(
      store,
      input.p07_transition_ref,
      "sca-p07-to-p08-transition",
      validateScaP07ToP08TransitionV1
    );
    if (
      transition.handoff_kind !== "candidate_evidence_only" ||
      transition.qualification_scope !== "evidence_gathering_only_not_p08_disposition" ||
      transition.phase_gate_passed !== false ||
      transition.p08_disposition_authorized_by_this_transition !== false ||
      transition.release_eligible !== false ||
      transition.campaign_complete !== false
    ) {
      throw new Error("P08 P07 transition is not the non-authorizing evidence handoff");
    }
    requireSame(terminal.p08_transition_ref, input.p07_transition_ref, "terminal transition");
    requireSame(transition.evidence_ledger_ref, input.p07_evidence_ledger_ref, "handoff ledger");
    requireSame(transition.p06_transition_ref, ledger.transition_ref, "handoff P06 transition");
    requireSame(transition.p07_authority_ref, ledger.authority_ref, "handoff authority");
    requireSame(transition.p07_plan_ref, ledger.plan_ref, "handoff plan");
    requireSame(transition.p07_admission_ref, ledger.admission_ref, "handoff admission");
    if (
      transition.action_count !== ledger.action_count ||
      transition.blocked_action_count !== ledger.blocked_action_count ||
      transition.not_invoked_action_count !== ledger.not_invoked_action_count ||
      transition.evidence_complete !==
        (ledger.blocked_action_count === 0 && ledger.not_invoked_action_count === 0)
    ) {
      throw new Error("P08 P07 handoff accounting disagrees with its ledger");
    }
    const completedRefs = ledger.rows
      .filter((row) => row.status === "completed")
      .map((row) => row.host_result_ref)
      .filter((ref): ref is ArtifactRef => ref !== null)
      .map((ref) => ref.artifact_id)
      .sort();
    requireSame(
      completedRefs,
      transition.completed_action_result_refs.map((ref) => ref.artifact_id).sort(),
      "handoff completed results"
    );
  }

  const rederived = admitScaP07ExecutionPlan({
    store,
    transition_ref: ledger.transition_ref,
    authority_ref: ledger.authority_ref,
    plan_ref: ledger.plan_ref,
    resolve_current_authority_ref:
      input.resolve_current_p07_authority_ref ?? (() => ledger.authority_ref),
  });
  const recordedAdmission = exact(
    store,
    ledger.admission_ref,
    "sca-p07-admission",
    validateScaP07AdmissionV1
  );
  requireSame(rederived, recordedAdmission, "re-derived P07 admission");

  const p06Transition = exact(
    store,
    ledger.transition_ref,
    "sca-p06-to-p07-transition",
    validateScaP06ToP07TransitionV1
  );
  const accepted = exact(
    store,
    p06Transition.accepted_cohort_ref,
    "sca-p06-accepted-cohort",
    validateScaP06AcceptedCohortV1
  );
  // The P01 campaign source scope the admitted P06 cohort binds: the frozen source snapshot the
  // campaign is scoped to, revalidated byte-exactly and digest-bound to what the cohort recorded.
  // It is a campaign/source scope record — not a provider disclosure policy, and not a handoff.
  const sourceScopeRef = accepted.source_snapshot_ref;
  if (
    sourceScopeRef.content_schema?.schema_id !== SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA ||
    sourceScopeRef.content_schema.schema_version !== 2 ||
    accepted.source_snapshot_sha256 !== sourceScopeRef.content_digest
  ) {
    throw new Error("P08 P06 cohort source scope binding mismatch");
  }
  const p06Ledger = exact(
    store,
    p06Transition.successor_ledger_ref,
    "sca-p06-successor-ledger",
    validateScaP06SuccessorLedgerV1
  );
  const p06Gate = exact(store, p06Transition.p06_gate_ref, "sca-p06-gate", validateScaP06GateV1);
  const p06Trace = exact(
    store,
    p06Transition.traceability_ref,
    "sca-p06-traceability",
    validateScaP06TraceabilityV1
  );
  if (
    p06Gate.verdict !== "pass_ready" ||
    !p06Ledger.all_p06_decisions_valid ||
    !p06Ledger.p07_ready ||
    accepted.run_id !== ledger.run_id ||
    p06Trace.rows.length !== p06Transition.action_record_refs.length
  ) {
    throw new Error("P08 P06 lineage gate is blocked or cross-run");
  }

  const evidenceRefs: ArtifactRef[] = [
    input.p07_terminal_ref,
    input.p07_evidence_ledger_ref,
    input.disclosure_scope_ref,
    ledger.transition_ref,
    ledger.authority_ref,
    ledger.plan_ref,
    ledger.admission_ref,
    p06Transition.accepted_cohort_ref,
    p06Transition.successor_ledger_ref,
    p06Transition.p06_gate_ref,
    p06Transition.traceability_ref,
  ];
  if (input.p07_transition_ref !== null) evidenceRefs.push(input.p07_transition_ref);

  const items: ScaP08AdmittedItemV1[] = [];
  const p07StatusByItemId = new Map<string, P07Status>();
  const actionHypothesisById = new Map<string, string>();
  // Exact-read and cross-validate every P07 row's host evidence before any item is admitted. The
  // ledger must name exactly the admitted P06 actions, so no row escapes row-evidence verification.
  const admittedActionIds = new Set(p06Transition.action_record_refs.map((ref) => ref.artifact_id));
  const rowEvidenceByActionId = new Map<string, ArtifactRef[]>();
  for (const row of ledger.rows) {
    if (!admittedActionIds.has(row.action_record_ref.artifact_id)) {
      throw new Error("P08 P07 ledger row names an action outside the admitted P06 lineage");
    }
    rowEvidenceByActionId.set(
      row.action_record_ref.artifact_id,
      verifyRowHostEvidence(store, ledger.run_id, row)
    );
  }
  if (rowEvidenceByActionId.size !== admittedActionIds.size) {
    throw new Error("P08 P07 ledger does not name exactly the admitted P06 actions");
  }
  for (const actionRef of p06Transition.action_record_refs) {
    const action = exact(store, actionRef, "sca-p06-action-record", validateScaP06ActionRecordV1);
    actionHypothesisById.set(actionRef.artifact_id, action.hypothesis_id);
    const row = rowForAction(ledger, actionRef);
    const rowEvidence = rowEvidenceByActionId.get(actionRef.artifact_id) ?? [];
    const itemId = scaP08ItemId({ item_kind: "action", identity: action.action_id });
    items.push({
      item_id: itemId,
      item_kind: "action",
      identity: action.action_id,
      primary_ref: actionRef,
      hypothesis_id: action.hypothesis_id,
      p07_status: row.status,
      p07_evidence_refs: rowEvidence,
      p07_ledger_row_operation_id: row.operation_id,
      hypothesis: null,
      excerpt: actionExcerpt(action, row.status),
      prior_disposition_ref: null,
      duplicate_equivalence_proof_refs: [],
    });
    p07StatusByItemId.set(itemId, row.status);
    evidenceRefs.push(actionRef, ...rowEvidence);
  }
  const p07EvidenceForHypothesis = (hypothesisId: string): ArtifactRef[] =>
    uniqueRefs(
      ledger.rows
        .filter((row) => actionHypothesisId(row, actionHypothesisById, hypothesisId))
        .flatMap((row) => rowEvidenceByActionId.get(row.action_record_ref.artifact_id) ?? [])
    );

  for (const binding of accepted.final_hypotheses) {
    const revision = exact(
      store,
      binding.final_revision_ref,
      "sca-p05-hypothesis-revision",
      validateScaP05HypothesisRevisionV1
    );
    if (revision.hypothesis_id !== binding.hypothesis_id) {
      throw new Error("P08 P06 final hypothesis revision binding mismatch");
    }
    const itemId = scaP08ItemId({ item_kind: "hypothesis", identity: binding.hypothesis_id });
    const p07Evidence = p07EvidenceForHypothesis(binding.hypothesis_id);
    items.push({
      item_id: itemId,
      item_kind: "hypothesis",
      identity: binding.hypothesis_id,
      primary_ref: binding.final_revision_ref,
      hypothesis_id: binding.hypothesis_id,
      p07_status: null,
      p07_evidence_refs: p07Evidence,
      p07_ledger_row_operation_id: null,
      hypothesis: revision.body,
      excerpt: bounded(`hypothesis ${binding.hypothesis_id}: ${revision.body.bounded_claim}`),
      prior_disposition_ref: null,
      duplicate_equivalence_proof_refs: [],
    });
    evidenceRefs.push(binding.final_revision_ref, ...p07Evidence);
  }
  if (accepted.refuted_hypothesis_ids.length > 0) {
    const p05Trace = exact(
      store,
      accepted.p05_traceability_ref,
      "sca-p05-traceability",
      validateScaP05TraceabilityV1
    );
    for (const hypothesisId of accepted.refuted_hypothesis_ids) {
      const row = p05Trace.rows.find((candidate) => candidate.hypothesis_id === hypothesisId);
      if (row === undefined || row.final_revision_ref === null) {
        throw new Error("P08 P05 refuted hypothesis lacks an exact final revision");
      }
      const revision = exact(
        store,
        row.final_revision_ref,
        "sca-p05-hypothesis-revision",
        validateScaP05HypothesisRevisionV1
      );
      if (revision.hypothesis_id !== hypothesisId) {
        throw new Error("P08 P05 refuted hypothesis revision binding mismatch");
      }
      const itemId = scaP08ItemId({ item_kind: "hypothesis", identity: hypothesisId });
      items.push({
        item_id: itemId,
        item_kind: "hypothesis",
        identity: hypothesisId,
        primary_ref: row.final_revision_ref,
        hypothesis_id: hypothesisId,
        p07_status: null,
        p07_evidence_refs: [],
        p07_ledger_row_operation_id: null,
        hypothesis: revision.body,
        excerpt: bounded(`refuted hypothesis ${hypothesisId}: ${revision.body.bounded_claim}`),
        prior_disposition_ref: null,
        duplicate_equivalence_proof_refs: [],
      });
      evidenceRefs.push(row.final_revision_ref);
    }
  }

  for (const obligation of p06Ledger.evidence_obligations) {
    const revision = exact(
      store,
      obligation.obligation_revision_ref,
      "sca-p06-obligation-revision",
      validateScaP06ObligationRevisionV1
    );
    if (
      revision.obligation_id !== obligation.obligation_id ||
      revision.hypothesis_id !== obligation.hypothesis_id
    ) {
      throw new Error("P08 P06 obligation revision binding mismatch");
    }
    const itemId = scaP08ItemId({ item_kind: "obligation", identity: revision.obligation_id });
    const p07Evidence = p07EvidenceForHypothesis(revision.hypothesis_id);
    items.push({
      item_id: itemId,
      item_kind: "obligation",
      identity: revision.obligation_id,
      primary_ref: obligation.obligation_revision_ref,
      hypothesis_id: revision.hypothesis_id,
      p07_status: null,
      p07_evidence_refs: p07Evidence,
      p07_ledger_row_operation_id: null,
      hypothesis: null,
      excerpt: bounded(
        `obligation ${revision.obligation_id}: ${revision.purpose} [${revision.status}]`
      ),
      prior_disposition_ref: null,
      duplicate_equivalence_proof_refs: [],
    });
    evidenceRefs.push(obligation.obligation_revision_ref, ...p07Evidence);
  }

  const sorted = [...items].sort((left, right) =>
    left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0
  );
  if (new Set(sorted.map((item) => item.item_id)).size !== sorted.length) {
    throw new Error("P08 item universe contains a duplicate stable identity");
  }

  const universe = validateScaP08ItemUniverseV1(
    withP08Digest(
      {
        schema_id: SCA_P08_ITEM_UNIVERSE_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P08" as const,
        run_id: input.run_id,
        items: sorted.map(
          (item): ScaP08ItemUniverseItemV1 => ({
            item_id: item.item_id,
            item_kind: item.item_kind,
            identity: item.identity,
            primary_ref: item.primary_ref,
            hypothesis_id: item.hypothesis_id,
          })
        ),
        item_count: sorted.length,
      },
      "universe_sha256"
    )
  );

  if (p06Ledger.evidence_obligations.length === 0) {
    throw new Error("P08 P06 successor ledger declares no evidence obligations");
  }

  // The admitted `out-of-scope` evidence set is derived from the declared closed kind set
  // (`SCA_P08_SCOPE_DECISION_KINDS`) over the exact P01/P06 scope records the admitted lineage
  // binds: the P06 accepted cohort (the cohort admission scope) and the P01 source snapshot it
  // fixes (the campaign source scope). Handoff transitions are not scope decisions and provider
  // disclosure policy is not campaign/source scope, so neither can stand as `out-of-scope`
  // evidence. Each record is exact-read and revalidated before it joins the set.
  const scopeDecisionRefs = admitScopeDecisionRefs({
    store,
    candidates: [
      { ref: p06Transition.accepted_cohort_ref, validate: validateScaP06AcceptedCohortV1 },
      { ref: sourceScopeRef, validate: validateScaCampaignSourceSnapshotV2 },
    ],
  });
  evidenceRefs.push(...scopeDecisionRefs);

  const equivalence = admitEquivalenceProofs({
    store,
    run_id: input.run_id,
    items: sorted.map((item) => ({
      item_id: item.item_id,
      item_kind: item.item_kind,
      identity: item.identity,
      primary_ref: item.primary_ref,
    })),
    proof_refs: input.p08_equivalence_proof_refs ?? [],
  });
  evidenceRefs.push(...equivalence.evidence_refs);

  const prior = admitPriorReassessment({
    store,
    run_id: input.run_id,
    universe: sorted.map((item) => ({
      item_id: item.item_id,
      item_kind: item.item_kind,
      identity: item.identity,
    })),
    p07_evidence_ledger_ref: input.p07_evidence_ledger_ref,
    p08_reassessment_ref: input.p08_reassessment_ref ?? null,
  });
  evidenceRefs.push(...prior.evidence_refs);
  const finalItems: ScaP08AdmittedItemV1[] = sorted.map((item) => ({
    ...item,
    prior_disposition_ref: prior.prior_by_item_id.get(item.item_id)?.ref ?? null,
    duplicate_equivalence_proof_refs: equivalence.proof_refs_by_item_id.get(item.item_id) ?? [],
  }));

  const admission = validateScaP08AdmissionV1(
    withP08Digest(
      {
        schema_id: SCA_P08_ADMISSION_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P08" as const,
        run_id: input.run_id,
        p07_terminal_ref: input.p07_terminal_ref,
        p07_transition_ref: input.p07_transition_ref,
        p07_evidence_ledger_ref: input.p07_evidence_ledger_ref,
        p07_authority_ref: ledger.authority_ref,
        p07_plan_ref: ledger.plan_ref,
        p07_admission_ref: ledger.admission_ref,
        p06_transition_ref: ledger.transition_ref,
        disclosure_scope_ref: input.disclosure_scope_ref,
        // Encode the assurance actually used to re-derive the current P07 authority, so a downstream
        // phase can distinguish production attestation from fixture self-revalidation.
        p07_authority_assurance:
          input.resolve_current_p07_authority_ref === undefined
            ? ("unattested_chain_revalidated" as const)
            : ("attested_unchanged" as const),
        blocked_checkpoint: blockedCheckpoint,
        item_count: sorted.length,
        universe_sha256: universe.universe_sha256,
      },
      "admission_sha256"
    )
  );

  return {
    admission,
    universe,
    disclosure_scope: disclosureScope,
    items: finalItems,
    p07_status_by_item_id: p07StatusByItemId,
    admitted_evidence_ref_ids: new Set(uniqueRefs(evidenceRefs).map((ref) => ref.artifact_id)),
    evidence_refs: uniqueRefs(evidenceRefs),
    prior_ledger: prior.prior_ledger,
    prior_ledger_ref: prior.prior_ledger_ref,
    prior_by_item_id: prior.prior_by_item_id,
    reassessment: prior.reassessment,
    reassessment_ref: prior.reassessment_ref,
    reassessment_by_item_id: prior.reassessment_by_item_id,
    scope_decision_refs: scopeDecisionRefs,
    scope_decision_ref_ids: new Set(scopeDecisionRefs.map((ref) => ref.artifact_id)),
    equivalence_proof_by_pair: equivalence.by_pair,
    equivalence_proof_refs: equivalence.proof_refs,
  };
}

interface ScaP08UniverseIdentityV1 {
  readonly item_id: string;
  readonly item_kind: ScaP08ItemKindV1;
  readonly identity: string;
}

function assertExactRef(store: ArtifactHostStore, ref: ArtifactRef, label: string): void {
  if (!same(store.refById(ref.artifact_id), ref)) {
    throw new Error(`P08 ${label} exact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P08 ${label} exact bytes drifted`);
  }
}

function citedEvidenceIds(revision: ScaP08DispositionRevisionV1): Set<string> {
  return new Set(
    [
      ...revision.supporting_evidence_refs,
      ...revision.defeating_evidence_refs,
      ...revision.equivalence_evidence_refs,
      ...(revision.scope_evidence_ref === null ? [] : [revision.scope_evidence_ref]),
    ].map((ref) => ref.artifact_id)
  );
}

/** One candidate exact P01/P06 scope record in the admitted lineage and its exact validator. */
interface ScaP08ScopeRecordCandidateV1 {
  readonly ref: ArtifactRef;
  readonly validate: (value: unknown) => unknown;
}

/**
 * The admitted campaign/source scope-decision records: the exact P01/P06 scope records the
 * admitted lineage binds, filtered by the declared closed kind set
 * (`SCA_P08_SCOPE_DECISION_KINDS`) and exact-read and revalidated before each joins the set.
 * Nothing else — no handoff transition, no provider disclosure policy, no action record — can
 * become `out-of-scope` evidence.
 */
function admitScopeDecisionRefs(input: {
  readonly store: ArtifactHostStore;
  readonly candidates: readonly ScaP08ScopeRecordCandidateV1[];
}): readonly ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const candidate of input.candidates) {
    if (!isScaP08ScopeDecisionKind(candidate.ref.kind)) continue;
    exact(input.store, candidate.ref, candidate.ref.kind, candidate.validate);
    refs.push(candidate.ref);
  }
  return uniqueRefs(refs);
}

interface ScaP08EquivalenceAdmissionV1 {
  readonly by_pair: ReadonlyMap<
    string,
    { readonly ref: ArtifactRef; readonly proof: ScaP08DuplicateEquivalenceProofV1 }
  >;
  readonly proof_refs_by_item_id: ReadonlyMap<string, readonly ArtifactRef[]>;
  readonly proof_refs: readonly ArtifactRef[];
  readonly evidence_refs: readonly ArtifactRef[];
}

/**
 * Exact admission of the host-issued duplicate-equivalence proofs. Each proof is re-read
 * byte-exactly, schema-validated, bound to this run, and cross-checked against the *admitted*
 * item identities and exact primary refs. A proof outside the universe or misbinding an item's
 * identity/primary ref fails closed, so an `duplicate-of` disposition can never rest on an
 * arbitrary admitted artifact.
 */
function admitEquivalenceProofs(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly items: readonly {
    readonly item_id: string;
    readonly item_kind: ScaP08ItemKindV1;
    readonly identity: string;
    readonly primary_ref: ArtifactRef;
  }[];
  readonly proof_refs: readonly ArtifactRef[];
}): ScaP08EquivalenceAdmissionV1 {
  const byItemId = new Map(input.items.map((item) => [item.item_id, item] as const));
  const byPair = new Map<
    string,
    { readonly ref: ArtifactRef; readonly proof: ScaP08DuplicateEquivalenceProofV1 }
  >();
  const proofRefsByItemId = new Map<string, ArtifactRef[]>();
  const proofRefs: ArtifactRef[] = [];
  for (const ref of input.proof_refs) {
    if (ref.kind !== "sca-p08-duplicate-equivalence-proof") {
      throw new Error("P08 equivalence proof ref has the wrong artifact kind");
    }
    const proof = exact(
      input.store,
      ref,
      "sca-p08-duplicate-equivalence-proof",
      validateScaP08DuplicateEquivalenceProofV1
    );
    if (proof.run_id !== input.run_id) {
      throw new Error("P08 equivalence proof belongs to another run");
    }
    const duplicate = byItemId.get(proof.duplicate_item_id);
    const target = byItemId.get(proof.target_item_id);
    if (
      duplicate === undefined ||
      target === undefined ||
      duplicate.item_kind !== proof.duplicate_item_kind ||
      duplicate.identity !== proof.duplicate_item_identity ||
      target.item_kind !== proof.target_item_kind ||
      target.identity !== proof.target_item_identity ||
      !same(duplicate.primary_ref, proof.duplicate_primary_ref) ||
      !same(target.primary_ref, proof.target_primary_ref)
    ) {
      throw new Error("P08 equivalence proof misbinds its admitted item identities or primaries");
    }
    assertExactRef(input.store, proof.duplicate_primary_ref, "equivalence duplicate primary");
    assertExactRef(input.store, proof.target_primary_ref, "equivalence target primary");
    const key = scaP08DuplicatePairKey(proof.duplicate_item_id, proof.target_item_id);
    if (byPair.has(key)) {
      throw new Error("P08 duplicate equivalence proof is declared twice for one pair");
    }
    byPair.set(key, { ref, proof });
    proofRefs.push(ref);
    const existing = proofRefsByItemId.get(proof.duplicate_item_id) ?? [];
    proofRefsByItemId.set(proof.duplicate_item_id, [...existing, ref]);
  }
  const ordering = (left: ArtifactRef, right: ArtifactRef): number =>
    left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0;
  const sortedById = new Map(
    [...proofRefsByItemId.entries()].map(([itemId, refs]) => [itemId, [...refs].sort(ordering)])
  );
  const sortedProofRefs = [...proofRefs].sort(ordering);
  return {
    by_pair: byPair,
    proof_refs_by_item_id: sortedById,
    proof_refs: sortedProofRefs,
    evidence_refs: sortedProofRefs,
  };
}

/**
 * Optional exact prior P08 ledger/revision-chain admission. It never replaces the independent P07
 * lineage admission above: the current run still re-derives every P07/P06/P05/P01 ref exactly. It
 * only adds the append-only prior snapshots the reassessment diffs against.
 */
function admitPriorReassessment(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly universe: readonly ScaP08UniverseIdentityV1[];
  readonly p07_evidence_ledger_ref: ArtifactRef;
  readonly p08_reassessment_ref: ArtifactRef | null;
}): {
  readonly prior_ledger: ScaP08EvidenceLedgerV1 | null;
  readonly prior_ledger_ref: ArtifactRef | null;
  readonly prior_by_item_id: ReadonlyMap<string, ScaP08PriorItemV1>;
  readonly reassessment: ScaP08ReassessmentV1 | null;
  readonly reassessment_ref: ArtifactRef | null;
  readonly reassessment_by_item_id: ReadonlyMap<string, ScaP08ReassessmentEntryV1>;
  readonly evidence_refs: readonly ArtifactRef[];
} {
  const { store } = input;
  const empty = {
    prior_ledger: null,
    prior_ledger_ref: null,
    prior_by_item_id: new Map<string, ScaP08PriorItemV1>(),
    reassessment: null,
    reassessment_ref: null,
    reassessment_by_item_id: new Map<string, ScaP08ReassessmentEntryV1>(),
    evidence_refs: [] as ArtifactRef[],
  };
  if (input.p08_reassessment_ref === null) return empty;

  const reassessment = exact(
    store,
    input.p08_reassessment_ref,
    "sca-p08-reassessment",
    validateScaP08ReassessmentV1
  );
  if (reassessment.run_id !== input.run_id) {
    throw new Error("P08 reassessment belongs to another run");
  }
  const priorLedgerRef = reassessment.prior_p08_ledger_ref;
  const priorLedger = exact(
    store,
    priorLedgerRef,
    "sca-p08-evidence-ledger",
    validateScaP08EvidenceLedgerV1
  );
  if (priorLedger.run_id === input.run_id) {
    throw new Error("P08 reassessment requires a prior ledger from an earlier run");
  }

  const universeById = new Map(input.universe.map((item) => [item.item_id, item]));
  const priorById = new Map<string, ScaP08PriorItemV1>();
  const evidenceRefs: ArtifactRef[] = [priorLedgerRef, input.p08_reassessment_ref];
  for (const row of priorLedger.items) {
    const current = universeById.get(row.item_id);
    if (
      current === undefined ||
      current.item_kind !== row.item_kind ||
      current.identity !== row.identity
    ) {
      throw new Error("P08 prior ledger names an item outside the current universe");
    }
    const chainRefs = [...row.prior_revision_refs, row.current_revision_ref];
    const revisions = chainRefs.map((ref) => ({
      ref,
      revision: exact(
        store,
        ref,
        "sca-p08-disposition-revision",
        validateScaP08DispositionRevisionV1
      ),
    }));
    revisions.sort((left, right) => left.revision.revision - right.revision.revision);
    const last = revisions[revisions.length - 1];
    if (revisions.length < 1 || last === undefined || last.revision.revision !== revisions.length) {
      throw new Error("P08 prior revision chain length mismatch");
    }
    for (let index = 0; index < revisions.length; index += 1) {
      const entry = revisions[index];
      if (entry === undefined) throw new Error("P08 prior revision chain is sparse");
      if (entry.revision.revision !== index + 1) {
        throw new Error("P08 prior revision chain is not a gapless append-only sequence");
      }
      if (entry.revision.run_id !== priorLedger.run_id) {
        throw new Error("P08 prior revision belongs to another run");
      }
      if (
        entry.revision.item_id !== row.item_id ||
        entry.revision.item_kind !== row.item_kind ||
        entry.revision.identity !== row.identity
      ) {
        throw new Error("P08 prior revision item identity mismatch");
      }
      if (index === 0) {
        if (entry.revision.parent_revision_ref !== null) {
          throw new Error("P08 prior revision chain root carries a parent");
        }
      } else {
        const parent = revisions[index - 1];
        if (
          parent === undefined ||
          entry.revision.parent_revision_ref === null ||
          entry.revision.parent_revision_ref.artifact_id !== parent.ref.artifact_id ||
          entry.revision.parent_revision_sha256 !== parent.ref.content_digest
        ) {
          throw new Error("P08 prior revision chain parent linkage mismatch");
        }
      }
      evidenceRefs.push(entry.ref);
    }
    const currentEntry = revisions[revisions.length - 1];
    if (currentEntry === undefined || currentEntry.revision.disposition !== row.disposition) {
      throw new Error("P08 prior ledger row disagrees with its current revision");
    }
    priorById.set(row.item_id, {
      revision: currentEntry.revision,
      ref: currentEntry.ref,
      chain: revisions.map((entry) => entry.ref),
    });
  }

  const reassessmentById = new Map<string, ScaP08ReassessmentEntryV1>();
  for (const entry of reassessment.entries) {
    const current = universeById.get(entry.item_id);
    const prior = priorById.get(entry.item_id);
    if (
      current === undefined ||
      prior === undefined ||
      current.item_kind !== entry.item_kind ||
      current.identity !== entry.identity
    ) {
      throw new Error("P08 reassessment entry is outside the admitted prior/current universe");
    }
    for (const ref of entry.stimulus_refs) assertExactRef(store, ref, "reassessment stimulus");
    if (entry.change_reason_codes.includes("invalidated_evidence")) {
      const cited = citedEvidenceIds(prior.revision);
      if (!entry.stimulus_refs.some((ref) => cited.has(ref.artifact_id))) {
        throw new Error(
          "P08 invalidated_evidence reassessment does not name evidence the prior revision relied on"
        );
      }
    }
    if (entry.duplicate_of_item_id !== null && !universeById.has(entry.duplicate_of_item_id)) {
      throw new Error("P08 reassessment duplicate identity is outside the universe");
    }
    reassessmentById.set(entry.item_id, entry);
    evidenceRefs.push(...entry.stimulus_refs);
  }

  return {
    prior_ledger: priorLedger,
    prior_ledger_ref: priorLedgerRef,
    prior_by_item_id: priorById,
    reassessment,
    reassessment_ref: input.p08_reassessment_ref,
    reassessment_by_item_id: reassessmentById,
    evidence_refs: uniqueRefs(evidenceRefs),
  };
}

function actionHypothesisId(
  row: ScaP07EvidenceLedgerV1["rows"][number],
  actionHypothesisById: ReadonlyMap<string, string>,
  hypothesisId: string
): boolean {
  return actionHypothesisById.get(row.action_record_ref.artifact_id) === hypothesisId;
}
