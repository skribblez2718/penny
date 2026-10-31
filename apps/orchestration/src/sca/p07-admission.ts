import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { SCA_TOOL_OPERATION_MAP } from "./broker-contracts.js";
import {
  validateScaCampaignSourceSnapshotV2,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
} from "./p01-contracts.js";
import { validateScaP05HypothesisRevisionV1 } from "./p05-contracts.js";
import {
  validateScaP06AcceptedCohortV1,
  validateScaP06ActionAuthorityV1,
  validateScaP06ActionRecordV1,
  validateScaP06DiscoveryReassessmentV1,
  validateScaP06EvidenceManifestV1,
  validateScaP06GateV1,
  validateScaP06ObligationRevisionV1,
  validateScaP06RequestV1,
  validateScaP06ResourcePolicyV1,
  validateScaP06SuccessorLedgerV1,
  validateScaP06ToP07TransitionV1,
  validateScaP06TraceabilityV1,
} from "./p06-contracts.js";
import {
  SCA_P07_ADMISSION_SCHEMA,
  validateScaP07ExecutionAuthorityV1,
  validateScaP07ExecutionPlanV1,
  validateScaP07AdmissionV1,
  withP07Digest,
  type ScaP07AdmissionV1,
} from "./p07-contracts.js";

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function requireSame(left: unknown, right: unknown, label: string): void {
  if (!same(left, right)) throw new Error(`P07 ${label} exact binding mismatch`);
}
function exact<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  kind: string,
  validate: (value: unknown) => T
): T {
  if (ref.kind !== kind || !same(store.refById(ref.artifact_id), ref))
    throw new Error(`P07 ${kind} exact ref absent or substituted`);
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    throw new Error(`P07 ${kind} exact bytes drifted`);
  if (
    (kind === "sca-p07-execution-plan" || kind === "sca-p07-execution-authority") &&
    bytes.byteLength > 16_777_216
  )
    throw new Error("P07 plan or authority exceeds admission byte limit");
  const text = bytes.toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error(`P07 ${kind} noncanonical bytes`);
  return validate(parsed);
}

export interface ScaP07CurrentAuthorityScopeV1 {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly transition_ref: ArtifactRef;
}
/** The owner resolves current authority independently; P06 and plan artifacts cannot select it. */
export function admitScaP07ExecutionPlan(input: {
  readonly store: ArtifactHostStore;
  readonly transition_ref: ArtifactRef;
  readonly authority_ref: ArtifactRef;
  readonly resolve_current_authority_ref: (scope: ScaP07CurrentAuthorityScopeV1) => ArtifactRef;
  readonly plan_ref: ArtifactRef;
}): ScaP07AdmissionV1 {
  const { store } = input;
  const transition = exact(
    store,
    input.transition_ref,
    "sca-p06-to-p07-transition",
    validateScaP06ToP07TransitionV1
  );
  const authority = exact(
    store,
    input.authority_ref,
    "sca-p07-execution-authority",
    validateScaP07ExecutionAuthorityV1
  );
  const plan = exact(
    store,
    input.plan_ref,
    "sca-p07-execution-plan",
    validateScaP07ExecutionPlanV1
  );
  requireSame(authority.transition_ref, input.transition_ref, "authority transition");
  requireSame(plan.transition_ref, input.transition_ref, "plan transition");
  requireSame(plan.authority_ref, input.authority_ref, "plan authority");
  const p06Request = exact(
    store,
    transition.p06_request_ref,
    "sca-p06-request",
    validateScaP06RequestV1
  );
  if (
    p06Request.run_id !== authority.run_id ||
    p06Request.tenant_id !== authority.tenant_id ||
    p06Request.project_id !== authority.project_id
  )
    throw new Error("P07 authority cross-bound scope");
  const currentAuthorityRef = input.resolve_current_authority_ref({
    tenant_id: p06Request.tenant_id,
    project_id: p06Request.project_id,
    run_id: p06Request.run_id,
    transition_ref: input.transition_ref,
  });
  requireSame(input.authority_ref, currentAuthorityRef, "current host authority");
  const accepted = exact(
    store,
    transition.accepted_cohort_ref,
    "sca-p06-accepted-cohort",
    validateScaP06AcceptedCohortV1
  );
  requireSame(accepted.p06_request_ref, transition.p06_request_ref, "accepted request");
  requireSame(accepted.p05_transition_ref, p06Request.p05_transition_ref, "accepted predecessor");
  requireSame(
    accepted.action_authority_ref,
    p06Request.action_authority_ref,
    "accepted P06 authority"
  );
  requireSame(accepted.resource_policy_ref, p06Request.resource_policy_ref, "accepted P06 policy");
  if (accepted.run_id !== authority.run_id) throw new Error("P07 accepted cohort run mismatch");
  const gate = exact(store, transition.p06_gate_ref, "sca-p06-gate", validateScaP06GateV1);
  const ledger = exact(
    store,
    transition.successor_ledger_ref,
    "sca-p06-successor-ledger",
    validateScaP06SuccessorLedgerV1
  );
  const manifest = exact(
    store,
    transition.evidence_manifest_ref,
    "sca-p06-evidence-manifest",
    validateScaP06EvidenceManifestV1
  );
  const trace = exact(
    store,
    transition.traceability_ref,
    "sca-p06-traceability",
    validateScaP06TraceabilityV1
  );
  if (
    gate.verdict !== "pass_ready" ||
    !ledger.p07_ready ||
    !ledger.all_p06_decisions_valid ||
    !gate.p07_execution_claims_absent ||
    gate.blocked_action_count !== 0 ||
    gate.checkpoint_count !== 0
  )
    throw new Error("P07 P06 gate is blocked");
  requireSame(accepted.active_hypothesis_ids, trace.active_hypothesis_ids, "accepted hypotheses");
  requireSame(
    accepted.source_snapshot_ref,
    manifest.source_snapshot_ref,
    "accepted source snapshot"
  );
  if (accepted.source_snapshot_sha256 !== manifest.source_snapshot_sha256)
    throw new Error("P07 accepted source digest mismatch");
  requireSame(accepted.p05_gate_ref, gate.p05_gate_ref, "P05 gate lineage");
  requireSame(
    accepted.p05_successor_ledger_ref,
    ledger.predecessor_ledger_ref,
    "P05 ledger lineage"
  );
  for (const ref of transition.discovery_reassessment_refs) {
    const reassessment = exact(
      store,
      ref,
      "sca-p06-discovery-reassessment",
      validateScaP06DiscoveryReassessmentV1
    );
    if (
      reassessment.host_decision !== "allow" ||
      !manifest.evidence_refs.some((entry) => same(entry, ref))
    )
      throw new Error("P07 discovery reassessment denied or absent from manifest");
  }
  requireSame(gate.traceability_ref, transition.traceability_ref, "gate traceability");
  requireSame(gate.evidence_manifest_ref, transition.evidence_manifest_ref, "gate manifest");
  requireSame(gate.successor_ledger_ref, transition.successor_ledger_ref, "gate ledger");
  requireSame(
    gate.discovery_reassessment_refs,
    transition.discovery_reassessment_refs,
    "gate reassessments"
  );
  requireSame(
    manifest.source_snapshot_ref.content_digest,
    manifest.source_snapshot_sha256,
    "manifest snapshot"
  );
  if (
    ledger.run_id !== authority.run_id ||
    gate.action_record_count !== transition.action_record_refs.length ||
    trace.rows.length !== transition.action_record_refs.length ||
    ledger.evidence_obligations.length !== trace.rows.length
  )
    throw new Error("P07 P06 cohort count or run mismatch");
  requireSame(
    plan.items.map((item) => item.action_record_ref),
    authority.bindings.map((binding) => binding.action_record_ref),
    "plan and authority actions"
  );
  requireSame(
    plan.items.map((item) => item.action_record_ref.artifact_id).sort(),
    transition.action_record_refs.map((ref) => ref.artifact_id).sort(),
    "complete P06 action cohort"
  );
  const sourceBytes = store.readById(manifest.source_snapshot_ref.artifact_id);
  if (
    !same(store.refById(manifest.source_snapshot_ref.artifact_id), manifest.source_snapshot_ref) ||
    sourceBytes.byteLength !== manifest.source_snapshot_ref.byte_length ||
    sha256(sourceBytes) !== manifest.source_snapshot_ref.content_digest
  )
    throw new Error("P07 P06 source snapshot bytes drifted");
  const sourceSnapshot = exact(
    store,
    manifest.source_snapshot_ref,
    "source-snapshot",
    validateScaCampaignSourceSnapshotV2
  );
  const sourceManifest = exact(
    store,
    sourceSnapshot.file_manifest_ref,
    "sca-p01-source-file-manifest",
    validateScaP01SourceFileManifestV1
  );
  const sourceCustody = exact(
    store,
    sourceSnapshot.custody_ref,
    "sca-p01-source-custody-corpus",
    validateScaP01SourceCustodyCorpusV1
  );
  validateScaP01SourceMaterialV1({
    snapshot: sourceSnapshot,
    file_manifest_ref: sourceSnapshot.file_manifest_ref,
    file_manifest: sourceManifest,
    custody_ref: sourceSnapshot.custody_ref,
    custody: sourceCustody,
  });
  const p06Authority = exact(
    store,
    accepted.action_authority_ref,
    "sca-p06-action-authority",
    validateScaP06ActionAuthorityV1
  );
  const p06Policy = exact(
    store,
    accepted.resource_policy_ref,
    "sca-p06-resource-policy",
    validateScaP06ResourcePolicyV1
  );
  if (
    p06Authority.run_id !== authority.run_id ||
    p06Authority.source_snapshot_sha256 !== manifest.source_snapshot_sha256 ||
    p06Policy.run_id !== authority.run_id ||
    p06Policy.source_snapshot_sha256 !== manifest.source_snapshot_sha256 ||
    !same(p06Authority.p05_transition_ref, accepted.p05_transition_ref) ||
    !same(p06Policy.p05_transition_ref, accepted.p05_transition_ref)
  )
    throw new Error("P07 P06 authority or policy source mismatch");
  const authorityByHypothesis = new Map(
    p06Authority.hypothesis_authorities.map((entry) => [entry.hypothesis_id, entry])
  );
  const recordIds: string[] = [];
  const actions = new Map<string, ReturnType<typeof validateScaP06ActionRecordV1>>();
  for (const ref of transition.action_record_refs) {
    const action = exact(store, ref, "sca-p06-action-record", validateScaP06ActionRecordV1);
    recordIds.push(action.action_id);
    actions.set(ref.artifact_id, action);
    const hypothesisAuthority = authorityByHypothesis.get(action.hypothesis_id);
    const finalBinding = accepted.final_hypotheses.find(
      (candidate) => candidate.hypothesis_id === action.hypothesis_id
    );
    const finalRevision = exact(
      store,
      action.final_hypothesis_revision_ref,
      "sca-p05-hypothesis-revision",
      validateScaP05HypothesisRevisionV1
    );
    const obligationRevision = exact(
      store,
      action.obligation_revision_ref,
      "sca-p06-obligation-revision",
      validateScaP06ObligationRevisionV1
    );
    if (
      finalBinding === undefined ||
      !same(finalBinding.final_revision_ref, action.final_hypothesis_revision_ref) ||
      finalBinding.revision_sha256 !== action.final_hypothesis_revision_sha256 ||
      finalBinding.body_sha256 !== finalRevision.body_sha256 ||
      finalBinding.revision !== finalRevision.revision ||
      finalRevision.hypothesis_id !== action.hypothesis_id ||
      finalRevision.revision_sha256 !== action.final_hypothesis_revision_sha256 ||
      !same(finalRevision.source_snapshot_ref, accepted.source_snapshot_ref) ||
      finalRevision.source_snapshot_sha256 !== accepted.source_snapshot_sha256 ||
      obligationRevision.obligation_id !== action.effective_obligation_id ||
      obligationRevision.hypothesis_id !== action.hypothesis_id ||
      obligationRevision.status !==
        (action.discovery_reassessment_ref === null ? "pending" : "selected") ||
      !same(obligationRevision.final_hypothesis_revision_ref, action.final_hypothesis_revision_ref)
    )
      throw new Error("P07 P06 action child lineage mismatch");
    if (action.discovery_reassessment_ref === null) {
      if (
        obligationRevision.discovery_reassessment_ref !== null ||
        obligationRevision.discovery_reassessment_sha256 !== null
      )
        throw new Error("P07 P06 base obligation unexpectedly names a reassessment");
    } else {
      const reassessment = exact(
        store,
        action.discovery_reassessment_ref,
        "sca-p06-discovery-reassessment",
        validateScaP06DiscoveryReassessmentV1
      );
      if (
        !transition.discovery_reassessment_refs.some((ref) =>
          same(ref, action.discovery_reassessment_ref)
        ) ||
        !same(obligationRevision.discovery_reassessment_ref, action.discovery_reassessment_ref) ||
        obligationRevision.discovery_reassessment_sha256 !==
          action.discovery_reassessment_ref.content_digest ||
        reassessment.hypothesis_id !== action.hypothesis_id ||
        reassessment.promoted_obligation_id !== action.effective_obligation_id ||
        !same(reassessment.final_hypothesis_revision_ref, action.final_hypothesis_revision_ref) ||
        reassessment.final_hypothesis_revision_sha256 !== action.final_hypothesis_revision_sha256 ||
        reassessment.host_decision !== "allow"
      )
        throw new Error("P07 P06 reassessment lineage mismatch");
    }
    if (
      !same(action.authority_ref, accepted.action_authority_ref) ||
      !same(action.resource_policy_ref, accepted.resource_policy_ref) ||
      hypothesisAuthority === undefined ||
      !same(hypothesisAuthority.final_revision_ref, action.final_hypothesis_revision_ref) ||
      !hypothesisAuthority.modes.some(
        (mode) =>
          mode.action_kind === action.selected_action.action_kind &&
          mode.decision === "approved" &&
          mode.authority_id === action.selected_action.authority_id
      ) ||
      !p06Policy.profiles.some(
        (profile) =>
          profile.action_kind === action.selected_action.action_kind &&
          profile.profile_id === action.selected_action.resource_profile_id
      )
    )
      throw new Error("P07 P06 action authority denied");
    const row = trace.rows.find((candidate) => candidate.hypothesis_id === action.hypothesis_id);
    const obligation = ledger.evidence_obligations.find(
      (candidate) => candidate.hypothesis_id === action.hypothesis_id
    );
    if (
      action.selected_action.action_kind === "none" ||
      action.decision_classification === "no_authorized_action" ||
      row?.disposition !== "action_selected" ||
      obligation?.status !== "selected" ||
      !same(row.action_record_ref, ref) ||
      !same(obligation.action_record_ref, ref) ||
      obligation.obligation_id !== action.effective_obligation_id ||
      !manifest.evidence_refs.some((entry) => same(entry, ref))
    )
      throw new Error("P07 blocked or unbound P06 action");
  }
  requireSame(recordIds.sort(), trace.action_record_ids, "trace action IDs");
  const jobAttempts = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const [index, item] of plan.items.entries()) {
    const binding = authority.bindings[index];
    if (binding === undefined) throw new Error("P07 authority binding missing");
    const action = actions.get(item.action_record_ref.artifact_id);
    if (action === undefined) throw new Error("P07 plan action absent from P06 transition");
    const row = trace.rows.find((candidate) => candidate.hypothesis_id === action.hypothesis_id);
    const obligation = ledger.evidence_obligations.find(
      (candidate) => candidate.hypothesis_id === action.hypothesis_id
    );
    if (
      action.selected_action.action_kind === "none" ||
      action.decision_classification === "no_authorized_action" ||
      row?.disposition !== "action_selected" ||
      obligation?.status !== "selected" ||
      !same(row.action_record_ref, item.action_record_ref) ||
      !same(obligation.action_record_ref, item.action_record_ref) ||
      obligation.obligation_id !== action.effective_obligation_id ||
      !same(binding.action_record_ref, item.action_record_ref)
    )
      throw new Error("P07 blocked or unbound P06 action");
    const request = item.broker_request;
    const jobAttempt = `${request.job_id}:${request.attempt}`;
    if (jobAttempts.has(jobAttempt) || idempotencyKeys.has(request.idempotency_key))
      throw new Error("P07 duplicate broker submission identity");
    jobAttempts.add(jobAttempt);
    idempotencyKeys.add(request.idempotency_key);
    const expectedTool =
      action.selected_action.action_kind === "source_query"
        ? "sca_source_query"
        : action.selected_action.action_kind === "graph_query"
          ? "sca_graph_query"
          : "sca_application_test";
    if (
      request.operation !== action.selected_action.action_kind ||
      request.tool_name !== expectedTool ||
      SCA_TOOL_OPERATION_MAP[request.tool_name] !== request.operation ||
      request.operation_input.kind !== request.operation ||
      binding.operation !== request.operation ||
      binding.broker_request_sha256 !== item.broker_request_sha256 ||
      request.tenant_id !== authority.tenant_id ||
      request.project_id !== authority.project_id ||
      request.run_id !== authority.run_id
    )
      throw new Error("P07 action/tool/scope mismatch");
    // The qualified broker requires same-run refs. A host-custodied copy of the P06 snapshot
    // is admissible only with identical exact bytes and canonical P01 provenance.
    if (
      request.source_snapshot_ref.kind !== "source-snapshot" ||
      request.source_snapshot_ref.phase !== "SCA-P01-source" ||
      request.source_snapshot_ref.producer !== "host:source-custody" ||
      request.source_snapshot_ref.content_schema?.schema_id !==
        "penny.sca-campaign-source-snapshot.v2" ||
      request.source_snapshot_ref.content_schema.schema_version !== 2 ||
      request.source_snapshot_ref.content_digest !== manifest.source_snapshot_ref.content_digest ||
      request.source_snapshot_ref.byte_length !== manifest.source_snapshot_ref.byte_length ||
      request.source_snapshot_ref.media_type !== manifest.source_snapshot_ref.media_type ||
      !same(request.source_snapshot_ref.content_schema, manifest.source_snapshot_ref.content_schema)
    )
      throw new Error("P07 broker snapshot differs from P06 source bytes");
    requireSame(request.source_snapshot_ref, binding.source_snapshot_ref, "authorized source");
    const brokerSourceSnapshot = exact(
      store,
      request.source_snapshot_ref,
      "source-snapshot",
      validateScaCampaignSourceSnapshotV2
    );
    requireSame(brokerSourceSnapshot, sourceSnapshot, "broker source custody snapshot");
    requireSame(request.config_ref, binding.config_ref, "authorized config");
    requireSame(request.input_refs, binding.input_refs, "authorized inputs");
    for (const ref of [request.source_snapshot_ref, request.config_ref, ...request.input_refs]) {
      if (ref.run_id !== authority.run_id) throw new Error("P07 cross-run broker ref");
      if (!same(store.refById(ref.artifact_id), ref)) throw new Error("P07 broker ref substituted");
      const bytes = store.readById(ref.artifact_id);
      if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest)
        throw new Error("P07 broker input bytes drifted");
    }
  }
  return validateScaP07AdmissionV1(
    withP07Digest(
      {
        schema_id: SCA_P07_ADMISSION_SCHEMA,
        schema_version: 1 as const,
        transition_ref: input.transition_ref,
        authority_ref: input.authority_ref,
        plan_ref: input.plan_ref,
        request_hashes: plan.items.map((item) => item.broker_request_sha256),
      },
      "admission_sha256"
    )
  );
}
