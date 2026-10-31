import type { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type {
  ArtifactRef,
  InputArtifacts,
  JsonValue,
  OutputArtifactMetadata,
  RunIdentity,
} from "../dist/contracts.js";
import {
  scaBrokerExecuteRequestSha256,
  type ScaBrokerReceiptV1,
} from "../dist/sca/broker-contracts.js";
import {
  admitScaP08Disposition,
  type ScaP08AdmittedItemV1,
  type ScaP08AdmissionResultV1,
} from "../dist/sca/p08-admission.js";
import {
  SCA_P08_DISCLOSURE_SCOPE_SCHEMA,
  SCA_P08_EQUIVALENCE_PROOF_SCHEMA,
  SCA_P08_REASSESSMENT_SCHEMA,
  SCA_P08_REQUIRED_MODEL,
  scaP08DuplicatePairKey,
  withP08Digest,
  type ScaP08DisclosureScopeV1,
  type ScaP08ItemKindV1,
} from "../dist/sca/p08-contracts.js";
import { SCA_P07_OPERATION_KIND } from "../dist/sca/p07-operation.js";
import {
  SCA_P07_EVIDENCE_LEDGER_SCHEMA,
  SCA_P07_HOST_REQUEST_SCHEMA,
  SCA_P07_HOST_RESULT_SCHEMA,
  SCA_P07_TERMINAL_SCHEMA,
  SCA_P07_TO_P08_TRANSITION_SCHEMA,
  validateScaP07HostRequestV1,
  withP07Digest,
  type ScaP07HostRequestV1,
} from "../dist/sca/p07-contracts.js";
import { buildScaP07Lineage, type ScaP07LineageKind } from "./sca-p07-lineage.js";

/**
 * Focused test-only P06→P07→P08 lineage builder. It extends the exact P07 lineage fixture with a
 * recorded (all-not-invoked) P07 evidence ledger, a non-authorizing P07→P08 transition, a blocked
 * P07 terminal, and a host-issued P08 disclosure scope, then re-derives the P08 admission through
 * the production admission path over a real project-bound `ArtifactStore`. It calls no model,
 * broker, or VM.
 */
const NOW = "2026-09-26T00:00:00.000Z";

export interface ScaP08LineageV1 {
  readonly run_id: string;
  readonly p06_transition_ref: ArtifactRef;
  readonly p07_plan_ref: ArtifactRef;
  readonly p07_authority_ref: ArtifactRef;
  readonly p07_admission_ref: ArtifactRef;
  readonly p07_evidence_ledger_ref: ArtifactRef;
  readonly p07_transition_ref: ArtifactRef | null;
  readonly p07_terminal_ref: ArtifactRef;
  readonly disclosure_scope_ref: ArtifactRef;
  readonly disclosure_scope: ScaP08DisclosureScopeV1;
  readonly admission: ScaP08AdmissionResultV1;
  /** The exact P07 evidence-ledger rows the fixture recorded (for negative tests). */
  readonly p07_rows: readonly ScaP08LedgerRowFixtureV1[];
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
    producer: input.producer ?? "host:sca-p08-lineage",
    media_type: "application/json",
    content_schema: { schema_id: input.schema_id, schema_version: input.schema_version ?? 1 },
    parent_ref: null,
    upstream_refs: [...(input.upstream_refs ?? [])],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}

/**
 * Deterministic P07 success evidence for one completed plan item: an exact succeeded broker
 * receipt, the P07 host result, and the matching host-operation platform result + receipt. It
 * mirrors what the real host-operation owner records so P08 admission can revalidate the
 * result/request/receipt/platform relationships over exact bytes. No model, broker, or VM is
 * invoked.
 */
function buildCompletedRowEvidence(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly index: number;
  readonly operation_id: string;
  readonly host_request_ref: ArtifactRef;
  readonly request: ScaP07HostRequestV1;
  readonly action_record_ref: ArtifactRef;
}): ScaP08HostOutcomeFixtureV1 {
  const { store, run_id: runId, index, host_request_ref, request } = input;
  const broker = request.broker_request;
  const outputRef = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-p07-evidence-output",
    operation_id: `sca-p07-evidence-output-${index}`,
    schema_id: "penny.sca-p07-evidence-output.v1",
    value: { job_id: broker.job_id, index },
  });
  const receipt: ScaBrokerReceiptV1 = {
    schema_id: "penny.sca-broker-receipt.v1",
    schema_version: 1,
    tenant_id: broker.tenant_id,
    project_id: broker.project_id,
    run_id: broker.run_id,
    job_id: broker.job_id,
    attempt: broker.attempt,
    idempotency_key: broker.idempotency_key,
    tool_name: broker.tool_name,
    operation: broker.operation,
    receipt_id: `receipt-${broker.job_id}`,
    request_sha256: scaBrokerExecuteRequestSha256(broker),
    limits: broker.limits,
    terminal_status: "succeeded",
    partial: false,
    truncated: false,
    source_snapshot_ref: broker.source_snapshot_ref,
    config_ref: broker.config_ref,
    input_refs: broker.input_refs,
    output_refs: [outputRef],
    result_item_count: 1,
    failure: null,
    accepted_at: broker.submitted_at,
    terminal_at: broker.submitted_at,
  };
  const hostResultRef = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-p07-host-result",
    operation_id: `sca-p07-host-result-${index}`,
    schema_id: SCA_P07_HOST_RESULT_SCHEMA,
    value: withP07Digest(
      {
        schema_id: SCA_P07_HOST_RESULT_SCHEMA,
        schema_version: 1,
        request_sha256: request.request_sha256,
        plan_ref: request.plan_ref,
        admission_ref: request.admission_ref,
        action_record_ref: input.action_record_ref,
        receipt,
      },
      "result_sha256"
    ),
  });
  const disposition = {
    outcome: "completed" as const,
    remote_disposition: "proven_terminal" as const,
    lease_disposition: "released" as const,
    retryable: false as const,
    reason_code: null,
  };
  const operationRecordId = `hop_record_${index}`;
  const registrationSha256 = "5".repeat(64);
  const stateId = `sca_p07_action_${index}`;
  const platformResultRef = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "host-operation-result",
    operation_id: `host-operation-platform-result:${operationRecordId}`,
    schema_id: "penny.host-operation-result.v1",
    value: {
      schema_version: 1,
      operation_record_id: operationRecordId,
      identity: p07RunIdentity(runId),
      state_id: stateId,
      attempt: 1,
      operation_id: input.operation_id,
      operation_kind: SCA_P07_OPERATION_KIND,
      registration_sha256: registrationSha256,
      request_sha256: host_request_ref.content_digest,
      lease: null,
      disposition,
      operation_result_ref: hostResultRef,
      output_artifacts: [],
    },
  });
  const hostReceiptRef = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "host-operation-receipt",
    operation_id: `host-operation-receipt:${operationRecordId}`,
    schema_id: "penny.host-operation-receipt.v1",
    value: {
      schema_version: 1,
      receipt_id: `hop_receipt_${operationRecordId}`,
      operation_record_id: operationRecordId,
      identity: p07RunIdentity(runId),
      state_id: stateId,
      attempt: 1,
      operation_id: input.operation_id,
      operation_kind: SCA_P07_OPERATION_KIND,
      registration_sha256: registrationSha256,
      request_sha256: host_request_ref.content_digest,
      started_at: NOW,
      ended_at: NOW,
      progress_event_count: 0,
      poll_count: 0,
      request_bytes: host_request_ref.byte_length,
      output_artifact_count: 1,
      output_bytes: outputRef.byte_length,
      result_sha256: hostResultRef.content_digest,
      remote_correlation_sha256: null,
      lease_disposition_receipt_id: "hop_lease_receipt_0001",
      disposition,
    },
  });
  return {
    host_request_ref,
    request,
    host_result_ref: hostResultRef,
    platform_result_ref: platformResultRef,
    host_receipt_ref: hostReceiptRef,
  };
}

/** Host-issued typed duplicate-equivalence proof for one exact admitted item pair. */
export function buildScaP08EquivalenceProof(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly duplicate: ScaP08AdmittedItemV1;
  readonly target: ScaP08AdmittedItemV1;
}): ArtifactRef {
  const key = scaP08DuplicatePairKey(input.duplicate.item_id, input.target.item_id);
  return save({
    store: input.store,
    run_id: input.run_id,
    phase: "SCA-P08",
    kind: "sca-p08-duplicate-equivalence-proof",
    operation_id: `sca-p08-equivalence-proof-${sha256(key).slice(0, 32)}`,
    schema_id: SCA_P08_EQUIVALENCE_PROOF_SCHEMA,
    value: withP08Digest(
      {
        schema_id: SCA_P08_EQUIVALENCE_PROOF_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P08",
        run_id: input.run_id,
        duplicate_item_id: input.duplicate.item_id,
        duplicate_item_kind: input.duplicate.item_kind,
        duplicate_item_identity: input.duplicate.identity,
        duplicate_primary_ref: input.duplicate.primary_ref,
        duplicate_primary_sha256: input.duplicate.primary_ref.content_digest,
        target_item_id: input.target.item_id,
        target_item_kind: input.target.item_kind,
        target_item_identity: input.target.identity,
        target_primary_ref: input.target.primary_ref,
        target_primary_sha256: input.target.primary_ref.content_digest,
        basis: "host_adjudicated_identical_subject",
      },
      "proof_sha256"
    ),
  });
}

export interface ScaP08HostOutcomeFixtureV1 {
  readonly host_request_ref: ArtifactRef;
  readonly request: ScaP07HostRequestV1;
  readonly host_result_ref: ArtifactRef | null;
  readonly platform_result_ref: ArtifactRef | null;
  readonly host_receipt_ref: ArtifactRef | null;
}

/** One P07 evidence-ledger row as the fixture builds it (mutable for mutation negatives). */
export interface ScaP08LedgerRowFixtureV1 {
  item_index: number;
  action_record_ref: ArtifactRef;
  operation_id: string;
  host_request_ref: ArtifactRef;
  host_result_ref: ArtifactRef | null;
  platform_result_ref: ArtifactRef | null;
  host_receipt_ref: ArtifactRef | null;
  disposition: Record<string, unknown> | null;
  status: "completed" | "blocked" | "not_invoked";
  blocker_codes: string[];
}

/** Deterministic identity for the recorded P07 host operations the fixture emits. */
const P07_HOST_IDENTITY: RunIdentity = {
  schema_version: 2,
  run_id: "",
  session_id: "",
  playbook: "sca-p07-candidate",
  engine_owner: "typescript",
};
function p07RunIdentity(runId: string): RunIdentity {
  return { ...P07_HOST_IDENTITY, run_id: runId, session_id: `session-${runId}` };
}

export function buildScaP08Lineage(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly kinds: readonly ScaP07LineageKind[];
  /** False builds a P08 blocked-checkpoint admission with no P07→P08 transition. */
  readonly with_transition?: boolean;
  /** Deny the host-issued P08 disclosure scope so no provider call is authorized. */
  readonly scope_decision?: "allow" | "deny";
  /** Override the admitted per-call payload byte limit (for payload-limit negatives). */
  readonly max_payload_bytes_per_call?: number;
  /** Plan item indices whose P07 row recorded a completed host operation (host evidence). */
  readonly completed_indices?: readonly number[];
  /**
   * Encode a production authority attestation in the recorded P08 admission by supplying an
   * independent current P07 authority resolver. Absent (default) records the honest reduced
   * fixture assurance `unattested_chain_revalidated`.
   */
  readonly attest_p07_authority?: boolean;
  /** Deterministic mutation of one built ledger row, for row-evidence negative tests. */
  readonly tamper_row?: (row: ScaP08LedgerRowFixtureV1, index: number) => ScaP08LedgerRowFixtureV1;
}): ScaP08LineageV1 {
  const { store, run_id: runId } = input;
  const scopeDecision = input.scope_decision ?? "allow";
  const completedIndices = new Set(input.completed_indices ?? []);
  const p07 = buildScaP07Lineage({ store, run_id: runId, kinds: input.kinds });
  const withTransition = input.with_transition ?? true;
  const builtRows: ScaP08LedgerRowFixtureV1[] = p07.plan.items.map((item, index) => {
    const request = validateScaP07HostRequestV1(
      withP07Digest(
        {
          schema_id: SCA_P07_HOST_REQUEST_SCHEMA,
          schema_version: 1 as const,
          plan_ref: p07.plan_ref,
          admission_ref: p07.admission_ref,
          item_index: index,
          action_record_ref: item.action_record_ref,
          broker_request: item.broker_request,
          broker_request_sha256: item.broker_request_sha256,
        },
        "request_sha256"
      )
    );
    const hostRequestRef = save({
      store,
      run_id: runId,
      phase: "SCA-P07",
      kind: "sca-p07-host-request",
      operation_id: `sca-p07-host-request-${String(index).padStart(4, "0")}`,
      schema_id: SCA_P07_HOST_REQUEST_SCHEMA,
      value: request,
    });
    const operationId = `sca-p07-operation-${index}`;
    if (!completedIndices.has(index)) {
      return {
        item_index: index,
        action_record_ref: item.action_record_ref,
        operation_id: operationId,
        host_request_ref: hostRequestRef,
        host_result_ref: null,
        platform_result_ref: null,
        host_receipt_ref: null,
        disposition: null,
        status: "not_invoked",
        blocker_codes: ["p07_action_not_invoked"],
      };
    }
    const evidence = buildCompletedRowEvidence({
      store,
      run_id: runId,
      index,
      operation_id: operationId,
      host_request_ref: hostRequestRef,
      request,
      action_record_ref: item.action_record_ref,
    });
    return {
      item_index: index,
      action_record_ref: item.action_record_ref,
      operation_id: operationId,
      host_request_ref: hostRequestRef,
      host_result_ref: evidence.host_result_ref,
      platform_result_ref: evidence.platform_result_ref,
      host_receipt_ref: evidence.host_receipt_ref,
      disposition: {
        outcome: "completed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        retryable: false,
        reason_code: null,
      },
      status: "completed",
      blocker_codes: [],
    };
  });
  const tamper = input.tamper_row;
  const rows = tamper === undefined ? builtRows : builtRows.map((row, index) => tamper(row, index));
  const completedRows = rows.filter((row) => row.status === "completed");
  const blockedCount = rows.filter((row) => row.status === "blocked").length;
  const notInvokedCount = rows.length - completedRows.length - blockedCount;
  const ledger = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-p07-evidence-ledger",
    operation_id: "sca-p07-evidence-ledger",
    schema_id: SCA_P07_EVIDENCE_LEDGER_SCHEMA,
    value: withP07Digest(
      {
        schema_id: SCA_P07_EVIDENCE_LEDGER_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P07",
        run_id: runId,
        transition_ref: p07.p06_transition_ref,
        authority_ref: p07.authority_ref,
        plan_ref: p07.plan_ref,
        admission_ref: p07.admission_ref,
        rows,
        action_count: rows.length,
        completed_action_count: completedRows.length,
        blocked_action_count: blockedCount,
        not_invoked_action_count: notInvokedCount,
        exhaustive_accounting: true,
        execution_occurred: completedRows.length + blockedCount > 0,
        release_eligible: false,
        campaign_complete: false,
      },
      "ledger_sha256"
    ),
  });
  const evidenceComplete = blockedCount === 0 && notInvokedCount === 0;
  const completedResultRefs = completedRows
    .map((row) => row.host_result_ref)
    .filter((ref): ref is ArtifactRef => ref !== null);
  const transitionRef = withTransition
    ? save({
        store,
        run_id: runId,
        phase: "SCA-P07",
        kind: "sca-p07-to-p08-transition",
        operation_id: "sca-p07-to-p08-transition",
        schema_id: SCA_P07_TO_P08_TRANSITION_SCHEMA,
        value: withP07Digest(
          {
            schema_id: SCA_P07_TO_P08_TRANSITION_SCHEMA,
            schema_version: 1,
            source_phase_id: "SCA-P07",
            target_phase_id: "SCA-P08",
            handoff_kind: "candidate_evidence_only",
            qualification_scope: "evidence_gathering_only_not_p08_disposition",
            phase_gate_passed: false,
            p06_transition_ref: p07.p06_transition_ref,
            p07_authority_ref: p07.authority_ref,
            p07_plan_ref: p07.plan_ref,
            p07_admission_ref: p07.admission_ref,
            evidence_ledger_ref: ledger,
            action_count: rows.length,
            completed_action_result_refs: completedResultRefs,
            blocked_action_count: blockedCount,
            not_invoked_action_count: notInvokedCount,
            evidence_complete: evidenceComplete,
            p08_disposition_authorized_by_this_transition: false,
            release_eligible: false,
            campaign_complete: false,
            campaign_completion_claimed: false,
          },
          "transition_sha256"
        ),
      })
    : null;
  const terminal = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-p07-terminal",
    operation_id: "sca-p07-terminal",
    schema_id: SCA_P07_TERMINAL_SCHEMA,
    value: withP07Digest(
      {
        schema_id: SCA_P07_TERMINAL_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P07",
        status: evidenceComplete ? "candidate_complete" : "blocked",
        evidence_ledger_ref: ledger,
        p08_transition_ref: transitionRef,
        p08_handoff_ready: transitionRef !== null,
        evidence_complete: evidenceComplete,
        phase_gate_passed: false,
        execution_occurred: completedRows.length + blockedCount > 0,
        action_count: rows.length,
        completed_action_count: completedRows.length,
        blocked_action_count: blockedCount,
        not_invoked_action_count: notInvokedCount,
        selected_artifact_refs: [ledger, ...(transitionRef === null ? [] : [transitionRef])],
        blocker_codes: evidenceComplete ? [] : ["p07_no_action_executed"],
        release_eligible: false,
        campaign_complete: false,
        nonterminal_campaign: true,
        report_or_finding_adjudication_performed: false,
      },
      "terminal_sha256"
    ),
  });
  const scope = save({
    store,
    run_id: runId,
    phase: "SCA-P08",
    kind: "sca-p08-disclosure-scope",
    operation_id: "sca-p08-disclosure-scope",
    schema_id: SCA_P08_DISCLOSURE_SCOPE_SCHEMA,
    value: withP08Digest(
      {
        schema_id: SCA_P08_DISCLOSURE_SCOPE_SCHEMA,
        schema_version: 1,
        run_id: runId,
        phase_id: "SCA-P08",
        required_model: SCA_P08_REQUIRED_MODEL,
        destination_class: "cloud",
        purpose: "p08_evidence_based_disposition",
        allowed_data_classes: [
          "p07_evidence_ledger_excerpts",
          "p06_hypothesis_obligation_projections",
          "prior_disposition_revisions",
        ],
        provider_retention_status: "known",
        provider_retention_days: 0,
        provider_logging_status: "disabled",
        provider_logging_days: 0,
        provider_training_use: "prohibited",
        max_payload_bytes_per_call: input.max_payload_bytes_per_call ?? 262_144,
        max_provider_calls: 2,
        decision: scopeDecision,
        blocker_codes: scopeDecision === "allow" ? [] : ["p08_disclosure_denied"],
        issued_at: NOW,
      },
      "scope_sha256"
    ),
  });
  const admission = admitScaP08Disposition({
    store,
    run_id: runId,
    p07_terminal_ref: terminal,
    p07_evidence_ledger_ref: ledger,
    p07_transition_ref: transitionRef,
    disclosure_scope_ref: scope,
    ...(input.attest_p07_authority === true
      ? { resolve_current_p07_authority_ref: () => p07.authority_ref }
      : {}),
  });
  return {
    run_id: runId,
    p06_transition_ref: p07.p06_transition_ref,
    p07_plan_ref: p07.plan_ref,
    p07_authority_ref: p07.authority_ref,
    p07_admission_ref: p07.admission_ref,
    p07_evidence_ledger_ref: ledger,
    p07_transition_ref: transitionRef,
    p07_terminal_ref: terminal,
    disclosure_scope_ref: scope,
    disclosure_scope: admission.disclosure_scope,
    admission,
    p07_rows: rows,
  };
}

export function scaP08RunIdentity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: `session-${runId}`,
    playbook: "sca-p08-candidate",
    engine_owner: "typescript",
  };
}

export function scaP08StartRequest(
  lineage: ScaP08LineageV1,
  goal = "Exercise inactive P08.",
  reassessmentRef: ArtifactRef | null = null,
  equivalenceProofRefs: readonly ArtifactRef[] = []
): {
  readonly identity: RunIdentity;
  readonly goal: string;
  readonly constraints: Record<string, JsonValue>;
  readonly inputArtifacts: InputArtifacts;
} {
  const constraints: Record<string, JsonValue> = {
    p07_terminal_ref: lineage.p07_terminal_ref,
    p07_transition_ref: lineage.p07_transition_ref,
    p07_evidence_ledger_ref: lineage.p07_evidence_ledger_ref,
    disclosure_scope_ref: lineage.disclosure_scope_ref,
    ...(reassessmentRef === null ? {} : { p08_reassessment_ref: reassessmentRef }),
    ...(equivalenceProofRefs.length === 0
      ? {}
      : { p08_equivalence_proof_refs: [...equivalenceProofRefs] }),
  };
  const inputArtifacts: InputArtifacts = {
    schema_version: 2,
    artifacts: [
      { slot: "p07_terminal", ref: lineage.p07_terminal_ref },
      { slot: "p07_evidence_ledger", ref: lineage.p07_evidence_ledger_ref },
      { slot: "disclosure_scope", ref: lineage.disclosure_scope_ref },
      ...(lineage.p07_transition_ref === null
        ? []
        : [{ slot: "p07_transition", ref: lineage.p07_transition_ref }]),
      ...(reassessmentRef === null ? [] : [{ slot: "p08_reassessment", ref: reassessmentRef }]),
      ...equivalenceProofRefs.map((ref) => ({ slot: "p08_equivalence_proof", ref })),
    ],
  };
  return {
    identity: scaP08RunIdentity(lineage.run_id),
    goal,
    constraints,
    inputArtifacts,
  };
}

/** Host-issued reassessment stimulus over an earlier P08 ledger; no model, broker, or VM call. */
export function buildScaP08Reassessment(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly prior_ledger_ref: ArtifactRef;
  readonly entries: readonly {
    readonly item_id: string;
    readonly item_kind: ScaP08ItemKindV1;
    readonly identity: string;
    readonly change_reason_codes: readonly string[];
    readonly stimulus_refs: readonly ArtifactRef[];
    readonly duplicate_of_item_id?: string | null;
  }[];
}): ArtifactRef {
  const entries = input.entries.map((entry) => ({
    item_id: entry.item_id,
    item_kind: entry.item_kind,
    identity: entry.identity,
    change_reason_codes: [...entry.change_reason_codes].sort(),
    stimulus_refs: [...entry.stimulus_refs],
    duplicate_of_item_id: entry.duplicate_of_item_id ?? null,
  }));
  return save({
    store: input.store,
    run_id: input.run_id,
    phase: "SCA-P08",
    kind: "sca-p08-reassessment",
    operation_id: "sca-p08-reassessment",
    schema_id: SCA_P08_REASSESSMENT_SCHEMA,
    value: withP08Digest(
      {
        schema_id: SCA_P08_REASSESSMENT_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P08",
        run_id: input.run_id,
        prior_p08_ledger_ref: input.prior_ledger_ref,
        prior_p08_ledger_sha256: input.prior_ledger_ref.content_digest,
        entries,
      },
      "reassessment_sha256"
    ),
  });
}

export function digestOf(store: ArtifactStore, ref: ArtifactRef): string {
  const bytes = store.readById(ref.artifact_id);
  if (sha256(bytes) !== ref.content_digest) throw new Error("digest drift");
  return ref.content_digest;
}
