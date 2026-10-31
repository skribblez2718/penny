import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type InputArtifacts,
  type JsonValue,
  type LivenessSnapshotV1,
  type LivenessTerminalReason,
  type OutputArtifactMetadata,
  type SkillContract,
  type StartRequest,
  validateContract,
  validateDirective,
} from "../contracts.js";
import { RunContext } from "../context.js";
import type { Playbook } from "../playbooks/playbook.js";
import type {
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import {
  assertResolvedModelIdentity,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
  validateModelDispatchGuardV1,
  validateModelExecutionReceiptV1,
} from "../required-model.js";
import {
  admitScaP06Candidate,
  buildScaP06AcceptedCohort,
  scaP06InputArtifacts,
} from "./p06-admission.js";
import {
  SCA_P06_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P06_ACTION_RECORD_V1_SCHEMA,
  SCA_P06_CHECKPOINT_V1_SCHEMA,
  SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P06_DECIDER_ROLE,
  SCA_P06_DECIDING_STATE,
  SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P06_DISCOVERY_REASSESSMENT_V1_SCHEMA,
  SCA_P06_EVIDENCE_MANIFEST_V1_SCHEMA,
  SCA_P06_FINAL_STATE,
  SCA_P06_GATE_V1_SCHEMA,
  SCA_P06_OBLIGATION_IDS,
  SCA_P06_OBLIGATION_REVISION_V1_SCHEMA,
  SCA_P06_PROVIDER_OPENING_GUARD,
  SCA_P06_REQUEST_V1_SCHEMA,
  SCA_P06_REQUIRED_MODEL,
  SCA_P06_REQUIRED_TOOL_SUBSET,
  SCA_P06_SUCCESSOR_LEDGER_V1_SCHEMA,
  SCA_P06_TERMINAL_V1_SCHEMA,
  SCA_P06_TO_P07_TRANSITION_V1_SCHEMA,
  SCA_P06_TRACEABILITY_V1_SCHEMA,
  ScaP06DecisionResultV1Schema,
  ScaP06RequestV1Schema,
  deriveScaP06DiscoveryReassessmentOutcome,
  scaP06ActionId,
  scaP06BaseObligationId,
  scaP06DiscoveryReassessmentId,
  validateScaP06AcceptedCohortV1,
  validateScaP06ActionRecordV1,
  validateScaP06CheckpointV1,
  validateScaP06CognitivePayloadV1,
  validateScaP06DecisionResultAgainstPayload,
  validateScaP06DisclosureAdmissionV1,
  validateScaP06DiscoveryReassessmentAgainstContext,
  validateScaP06EvidenceManifestV1,
  validateScaP06GateV1,
  validateScaP06ObligationRevisionV1,
  validateScaP06RequestV1,
  validateScaP06SuccessorLedgerV1,
  validateScaP06TerminalV1,
  validateScaP06ToP07TransitionV1,
  validateScaP06TraceabilityV1,
  withP06SelfDigest,
  type ScaP06AcceptedCohortV1,
  type ScaP06ActionAuthorityV1,
  type ScaP06ActionRecordV1,
  type ScaP06CheckpointV1,
  type ScaP06CognitivePayloadV1,
  type ScaP06DecisionResultV1,
  type ScaP06DisclosureAdmissionV1,
  type ScaP06DisclosureScopeV1,
  type ScaP06DiscoveryReassessmentV1,
  type ScaP06ObligationRevisionV1,
  type ScaP06ResourcePolicyV1,
  type ScaP06RequestV1,
  type ScaP06TerminalV1,
  type ScaP06ToP07TransitionV1,
  type ScaP06TraceabilityRowV1,
} from "./p06-contracts.js";
import {
  validateScaP05HypothesisRevisionV1,
  type ScaP05HypothesisRevisionV1,
} from "./p05-contracts.js";

const CANDIDATE = "sca-p06-candidate" as const;
const PRODUCER = "host:sca-p06-candidate" as const;
const PENDING_PHASE_IDS = [
  "SCA-P07",
  "SCA-P08",
  "SCA-P09",
  "SCA-P10",
  "SCA-P11",
  "SCA-P12",
] as const;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function refIds(refs: readonly ArtifactRef[]): string[] {
  return [...new Set(refs.map((ref) => ref.artifact_id))].sort();
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) throw new Error(`${label} exact ref is absent`);
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`${label} exact bytes drifted`);
  }
  return bytes;
}
function exactJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  return JSON.parse(exactBytes(store, ref, label).toString("utf8"));
}
function latestSelected(
  context: RunContext,
  predicate: (ref: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts].reverse().find(predicate);
}
function persistJson<T>(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly schema_id: string;
  readonly value: T;
  readonly upstream_refs?: readonly ArtifactRef[];
  readonly context?: RunContext | undefined;
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const prior = input.store.refFor(
    input.run_id,
    "SCA-P06",
    null,
    input.kind,
    input.operation_id,
    1
  );
  if (prior !== null) {
    if (
      prior.content_digest !== sha256(content) ||
      input.store.readById(prior.artifact_id).toString("utf8") !== content
    ) {
      throw new Error(`P06 artifact '${input.operation_id}' conflicts with immutable prior bytes`);
    }
    input.store.select(prior);
    if (
      input.context !== undefined &&
      !input.context.selectedArtifacts.some((ref) => ref.artifact_id === prior.artifact_id)
    ) {
      input.context.selectedArtifacts.push(prior);
    }
    return prior;
  }
  const ref = input.store.persist({
    metadata: {
      schema_version: 2,
      run_id: input.run_id,
      phase: "SCA-P06",
      branch_id: null,
      kind: input.kind,
      operation_id: input.operation_id,
      version: 1,
      producer: PRODUCER,
      media_type: "application/json",
      content_schema: { schema_id: input.schema_id, schema_version: 1 },
      parent_ref: null,
      upstream_refs: uniqueRefs(input.upstream_refs ?? []),
    },
    content,
  });
  input.store.select(ref);
  if (input.context !== undefined) input.context.selectedArtifacts.push(ref);
  return ref;
}
function outputArtifact(runId: string): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: runId,
    phase: SCA_P06_DECIDING_STATE,
    branch_id: null,
    kind: "sca-p06-decision-output",
    operation_id: "sca-p06-decision-output",
    version: 1,
    producer: "agent:demetri",
    media_type: "text/plain",
    content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
}
function observables(body: ScaP06CognitivePayloadV1["items"][number]["hypothesis"]): string[] {
  return [
    ...body.expected_supporting_observations.map((entry) => entry.observable_id),
    ...body.expected_refuting_observations.map((entry) => entry.observable_id),
  ].sort();
}

interface PreparedState {
  readonly request: ScaP06RequestV1;
  readonly request_ref: ArtifactRef;
  readonly accepted_cohort: ScaP06AcceptedCohortV1;
  readonly accepted_cohort_ref: ArtifactRef;
  readonly payload: ScaP06CognitivePayloadV1;
  readonly payload_ref: ArtifactRef;
  readonly disclosure: ScaP06DisclosureAdmissionV1;
  readonly disclosure_ref: ArtifactRef;
  readonly disclosure_scope: ScaP06DisclosureScopeV1;
  readonly action_authority: ScaP06ActionAuthorityV1;
  readonly resource_policy: ScaP06ResourcePolicyV1;
  readonly final_revisions: readonly ScaP05HypothesisRevisionV1[];
  readonly base_obligations: readonly ScaP06ObligationRevisionV1[];
  readonly base_obligation_refs: readonly ArtifactRef[];
  readonly evidence_refs: readonly ArtifactRef[];
}
interface DecisionEvidence {
  readonly decision: ScaP06DecisionResultV1 | null;
  readonly output_ref: ArtifactRef | null;
  readonly guard_ref: ArtifactRef | null;
  readonly receipt_ref: ArtifactRef | null;
  readonly failure_code: string | null;
}

function prepare(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly request: ScaP06RequestV1;
  readonly input_artifacts: InputArtifacts;
  readonly trusted_clock: () => Date;
}): PreparedState {
  if (input.run_id !== input.request.run_id) throw new Error("P06 request/run mismatch");
  const admission = admitScaP06Candidate({
    store: input.store,
    request: input.request,
    input_artifacts: input.input_artifacts,
    trusted_clock: input.trusted_clock,
  });
  const requestRef = persistJson({
    store: input.store,
    run_id: input.run_id,
    kind: "sca-p06-request",
    operation_id: "sca-p06-request",
    schema_id: SCA_P06_REQUEST_V1_SCHEMA,
    value: input.request,
  });
  const admittedAt = input.trusted_clock().toISOString();
  const accepted = buildScaP06AcceptedCohort({
    admission,
    p06_request_ref: requestRef,
    admitted_at: admittedAt,
  });
  const acceptedRef = persistJson({
    store: input.store,
    run_id: input.run_id,
    kind: "sca-p06-accepted-cohort",
    operation_id: "sca-p06-accepted-cohort",
    schema_id: SCA_P06_ACCEPTED_COHORT_V1_SCHEMA,
    value: accepted,
  });
  const authorityById = new Map(
    admission.action_authority.hypothesis_authorities.map((entry) => [entry.hypothesis_id, entry])
  );
  const revisionById = new Map(
    admission.predecessor.final_revisions.map((entry) => [entry.hypothesis_id, entry])
  );
  const baseObligations: ScaP06ObligationRevisionV1[] = [];
  const baseRefs: ArtifactRef[] = [];
  for (const binding of accepted.final_hypotheses) {
    const revision = revisionById.get(binding.hypothesis_id);
    if (revision === undefined) throw new Error("P06 admitted final hypothesis body is absent");
    const obligation = validateScaP06ObligationRevisionV1(
      withP06SelfDigest(
        {
          schema_id: SCA_P06_OBLIGATION_REVISION_V1_SCHEMA,
          schema_version: 1 as const,
          obligation_id: scaP06BaseObligationId(binding.hypothesis_id),
          revision: 1 as const,
          parent_revision_ref: null,
          parent_revision_sha256: null,
          discovery_reassessment_ref: null,
          discovery_reassessment_sha256: null,
          hypothesis_id: binding.hypothesis_id,
          final_hypothesis_revision_ref: binding.final_revision_ref,
          class: "required-result" as const,
          purpose: revision.body.next_evidence_need.question,
          source_mandate:
            "The accepted active P05 hypothesis requires one least-consequential discriminating evidence decision before P07.",
          assigning_authority: "host_from_accepted_p05_hypothesis" as const,
          rationale: revision.body.next_evidence_need.discriminating_result,
          supporting_observable_ids: observables(revision.body),
          registered_before_action: true as const,
          status: "pending" as const,
          created_at: admittedAt,
        },
        "revision_sha256"
      )
    );
    const ref = persistJson({
      store: input.store,
      run_id: input.run_id,
      kind: "sca-p06-obligation-revision",
      operation_id: `sca-p06-${binding.hypothesis_id}-base-obligation`,
      schema_id: SCA_P06_OBLIGATION_REVISION_V1_SCHEMA,
      value: obligation,
    });
    baseObligations.push(obligation);
    baseRefs.push(ref);
  }
  const baseRefById = new Map(
    baseObligations.map((entry, index) => [entry.hypothesis_id, baseRefs[index]])
  );
  const items = accepted.final_hypotheses.map((binding) => {
    const revision = revisionById.get(binding.hypothesis_id);
    const authority = authorityById.get(binding.hypothesis_id);
    const baseRef = baseRefById.get(binding.hypothesis_id);
    if (revision === undefined || authority === undefined || baseRef === undefined) {
      throw new Error("P06 cognitive payload projection is incomplete");
    }
    return {
      hypothesis_id: binding.hypothesis_id,
      selected_item_id: binding.selected_item_id,
      final_revision_ref: binding.final_revision_ref,
      revision: binding.revision,
      revision_sha256: binding.revision_sha256,
      body_sha256: binding.body_sha256,
      hypothesis: revision.body,
      base_obligation_ref: baseRef,
      base_obligation_id: scaP06BaseObligationId(binding.hypothesis_id),
      authority,
      resource_profiles: admission.resource_policy.profiles,
      child_integration: admission.runtime_policy.child_integration,
    };
  });
  const payload = validateScaP06CognitivePayloadV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: input.run_id,
        phase_id: "SCA-P06" as const,
        call_id: "sca-p06-evidence-action-decision" as const,
        role: SCA_P06_DECIDER_ROLE,
        purpose: "p06_least_consequential_evidence_decision" as const,
        required_model: SCA_P06_REQUIRED_MODEL,
        accepted_cohort_ref: acceptedRef,
        source_snapshot_ref: accepted.source_snapshot_ref,
        source_snapshot_sha256: accepted.source_snapshot_sha256,
        p05_transition_ref: input.request.p05_transition_ref,
        assigned_hypothesis_ids: accepted.active_hypothesis_ids,
        items,
        action_authority_ref: input.request.action_authority_ref,
        resource_policy_ref: input.request.resource_policy_ref,
        disclosure_scope_ref: input.request.disclosure_scope_ref,
        content_mode: "final_p05_hypotheses_and_minimized_policy_projections" as const,
      },
      "payload_sha256"
    )
  );
  const payloadBytes = Buffer.from(canonicalJson(payload), "utf8");
  const payloadRef = persistJson({
    store: input.store,
    run_id: input.run_id,
    kind: "sca-p06-cognitive-payload",
    operation_id: "sca-p06-evidence-action-payload",
    schema_id: SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
    value: payload,
  });
  if (payloadBytes.byteLength !== payloadRef.byte_length) {
    throw new Error("P06 payload canonical byte length mismatch");
  }
  const withinLimit =
    payloadRef.byte_length <= admission.disclosure_scope.max_payload_bytes_per_call;
  const allowed = admission.disclosure_scope.decision === "allow" && withinLimit;
  const blockerCodes = [
    ...admission.disclosure_scope.blocker_codes,
    ...(withinLimit ? [] : ["p06_payload_limit_exceeded"]),
  ].sort();
  const disclosure = validateScaP06DisclosureAdmissionV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: input.run_id,
        phase_id: "SCA-P06" as const,
        call_id: "sca-p06-evidence-action-decision" as const,
        role: SCA_P06_DECIDER_ROLE,
        purpose: "p06_least_consequential_evidence_decision" as const,
        required_model: SCA_P06_REQUIRED_MODEL,
        disclosure_scope_ref: input.request.disclosure_scope_ref,
        disclosure_scope_sha256: admission.disclosure_scope.scope_sha256,
        payload_ref: payloadRef,
        payload_sha256: payloadRef.content_digest,
        payload_byte_length: payloadRef.byte_length,
        serialized_opening_byte_limit: admission.disclosure_scope.max_payload_bytes_per_call,
        authorized_revision_refs: items
          .map((entry) => entry.final_revision_ref)
          .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
        action_authority_ref: input.request.action_authority_ref,
        resource_policy_ref: input.request.resource_policy_ref,
        destination: "cloud" as const,
        retention_days: admission.disclosure_scope.provider_retention_days,
        logging_status: admission.disclosure_scope.provider_logging_status,
        logging_days: admission.disclosure_scope.provider_logging_days,
        training: "prohibited" as const,
        secrets_embedded: false as const,
        personal_data_embedded: false as const,
        decision: allowed ? ("allow" as const) : ("deny" as const),
        blocker_codes: blockerCodes,
        evaluated_before_dispatch: true as const,
      },
      "admission_sha256"
    )
  );
  const disclosureRef = persistJson({
    store: input.store,
    run_id: input.run_id,
    kind: "sca-p06-disclosure-admission",
    operation_id: "sca-p06-evidence-action-disclosure",
    schema_id: SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
    value: disclosure,
  });
  return {
    request: input.request,
    request_ref: requestRef,
    accepted_cohort: accepted,
    accepted_cohort_ref: acceptedRef,
    payload,
    payload_ref: payloadRef,
    disclosure,
    disclosure_ref: disclosureRef,
    disclosure_scope: admission.disclosure_scope,
    action_authority: admission.action_authority,
    resource_policy: admission.resource_policy,
    final_revisions: admission.predecessor.final_revisions,
    base_obligations: baseObligations,
    base_obligation_refs: baseRefs,
    evidence_refs: uniqueRefs([
      requestRef,
      acceptedRef,
      payloadRef,
      disclosureRef,
      ...baseRefs,
      ...admission.transitive_refs,
    ]),
  };
}

function checkpointFor(input: {
  readonly store: ArtifactHostStore;
  readonly state: PreparedState;
  readonly hypothesis_id: string;
  readonly reason_code: string;
  readonly evidence_refs: readonly ArtifactRef[];
  readonly context?: RunContext | undefined;
}): { readonly value: ScaP06CheckpointV1; readonly ref: ArtifactRef } {
  const value = validateScaP06CheckpointV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_CHECKPOINT_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P06" as const,
        hypothesis_id: input.hypothesis_id,
        stage: "decision" as const,
        reason_code: input.reason_code,
        evidence_refs: uniqueRefs(input.evidence_refs),
        missing_evidence_need:
          "A valid exhaustive least-consequential evidence decision bound to the admitted P05 revision.",
        stop_condition: "Stop P06 progression and do not invoke any evidence action.",
        reopen_condition:
          "Re-run from a newly admitted P06 request; never replay an unknown or malformed provider result.",
        selected_action_invoked: false as const,
        p07_execution_claimed: false as const,
        vulnerability_adjudication: "not_performed" as const,
      },
      "checkpoint_sha256"
    )
  );
  return {
    value,
    ref: persistJson({
      store: input.store,
      run_id: input.state.request.run_id,
      kind: "sca-p06-checkpoint",
      operation_id: `sca-p06-${input.hypothesis_id}-checkpoint`,
      schema_id: SCA_P06_CHECKPOINT_V1_SCHEMA,
      value,
      upstream_refs: input.evidence_refs,
      context: input.context,
    }),
  };
}

function finalize(input: {
  readonly store: ArtifactHostStore;
  readonly state: PreparedState;
  readonly evidence: DecisionEvidence;
  readonly trusted_clock: () => Date;
  readonly context?: RunContext;
}): { readonly output: ScaP06TerminalV1; readonly output_ref: ArtifactRef } {
  const now = input.trusted_clock().toISOString();
  const modelRefs = [
    input.evidence.output_ref,
    input.evidence.guard_ref,
    input.evidence.receipt_ref,
  ].filter((ref): ref is ArtifactRef => ref !== null);
  const actionRecords: ScaP06ActionRecordV1[] = [];
  const actionRefs: ArtifactRef[] = [];
  const checkpoints: ScaP06CheckpointV1[] = [];
  const checkpointRefs: ArtifactRef[] = [];
  const effectiveObligationRefs = new Map<string, ArtifactRef>();
  for (const [index, hypothesisId] of input.state.accepted_cohort.active_hypothesis_ids.entries()) {
    const baseRef = input.state.base_obligation_refs[index];
    if (baseRef === undefined) throw new Error("P06 base obligation ref is absent");
    effectiveObligationRefs.set(hypothesisId, baseRef);
  }
  const discoveryReassessments: ScaP06DiscoveryReassessmentV1[] = [];
  const discoveryReassessmentRefs: ArtifactRef[] = [];
  const reassessmentRefByHypothesis = new Map<string, ArtifactRef>();
  if (input.evidence.decision !== null) {
    if (
      input.evidence.output_ref === null ||
      input.evidence.guard_ref === null ||
      input.evidence.receipt_ref === null
    ) {
      throw new Error("P06 valid decision lacks exact model evidence refs");
    }
    exactBytes(input.store, input.evidence.output_ref, "P06 decision model output");
    for (const decision of input.evidence.decision.items) {
      const discovery = decision.material_obligation_discovery;
      if (discovery === null) continue;
      const binding = input.state.accepted_cohort.final_hypotheses.find(
        (entry) => entry.hypothesis_id === decision.hypothesis_id
      );
      const baseIndex = input.state.accepted_cohort.active_hypothesis_ids.indexOf(
        decision.hypothesis_id
      );
      const baseRef = input.state.base_obligation_refs[baseIndex];
      const baseValue = input.state.base_obligations[baseIndex];
      const finalRevisionValue = input.state.final_revisions.find(
        (entry) => entry.hypothesis_id === decision.hypothesis_id
      );
      if (
        binding === undefined ||
        baseRef === undefined ||
        baseValue === undefined ||
        finalRevisionValue === undefined
      ) {
        throw new Error("P06 material discovery lacks exact prior hypothesis or obligation");
      }
      const baseObligation = validateScaP06ObligationRevisionV1(
        exactJson(input.store, baseRef, "P06 base obligation")
      );
      const finalRevision = validateScaP05HypothesisRevisionV1(
        exactJson(input.store, binding.final_revision_ref, "P06 final P05 revision")
      );
      exactBytes(input.store, finalRevision.source_snapshot_ref, "P06 final P05 source snapshot");
      exactBytes(input.store, input.state.request.disclosure_scope_ref, "P06 disclosure scope");
      exactBytes(input.store, input.state.request.action_authority_ref, "P06 action authority");
      exactBytes(input.store, input.state.request.resource_policy_ref, "P06 resource policy");
      if (!same(finalRevision, finalRevisionValue) || !same(baseObligation, baseValue)) {
        throw new Error("P06 material discovery prior exact bytes differ from admitted state");
      }
      const outcome = deriveScaP06DiscoveryReassessmentOutcome({
        decision,
        base_obligation: baseObligation,
        disclosure_scope: input.state.disclosure_scope,
        resource_policy: input.state.resource_policy,
      });
      const modelDiscoverySha = sha256(canonicalJson(discovery));
      const reassessment = validateScaP06DiscoveryReassessmentAgainstContext(
        withP06SelfDigest(
          {
            schema_id: SCA_P06_DISCOVERY_REASSESSMENT_V1_SCHEMA,
            schema_version: 1 as const,
            phase_id: "SCA-P06" as const,
            reassessment_id: scaP06DiscoveryReassessmentId({
              hypothesis_id: decision.hypothesis_id,
              model_output_sha256: input.evidence.output_ref.content_digest,
              model_discovery_sha256: modelDiscoverySha,
            }),
            hypothesis_id: decision.hypothesis_id,
            model_output_ref: input.evidence.output_ref,
            cognitive_payload_ref: input.state.payload_ref,
            model_discovery: discovery,
            model_discovery_sha256: modelDiscoverySha,
            base_obligation_ref: baseRef,
            base_obligation_id: baseObligation.obligation_id,
            base_obligation_revision_sha256: baseObligation.revision_sha256,
            promotion_chain_refs: [baseRef] as const,
            promoted_obligation_id: discovery.obligation_id,
            final_hypothesis_revision_ref: binding.final_revision_ref,
            final_hypothesis_revision_sha256: finalRevision.revision_sha256,
            final_hypothesis_body_sha256: finalRevision.body_sha256,
            source_snapshot_ref: finalRevision.source_snapshot_ref,
            source_snapshot_sha256: finalRevision.source_snapshot_sha256,
            disclosure_scope_ref: input.state.request.disclosure_scope_ref,
            disclosure_scope_sha256: input.state.disclosure_scope.scope_sha256,
            action_authority_ref: input.state.request.action_authority_ref,
            action_authority_sha256: input.state.action_authority.authority_sha256,
            resource_policy_ref: input.state.request.resource_policy_ref,
            resource_policy_sha256: input.state.resource_policy.policy_sha256,
            ...outcome,
            host_decision_basis: "exact_bindings_and_closed_policy_v1" as const,
            evaluated_at: now,
          },
          "reassessment_sha256"
        ),
        {
          decision,
          payload: input.state.payload,
          payload_ref: input.state.payload_ref,
          model_output_ref: input.evidence.output_ref,
          base_obligation: baseObligation,
          base_obligation_ref: baseRef,
          final_revision: finalRevision,
          disclosure_scope: input.state.disclosure_scope,
          action_authority: input.state.action_authority,
          resource_policy: input.state.resource_policy,
        }
      );
      const reassessmentRef = persistJson({
        store: input.store,
        run_id: input.state.request.run_id,
        kind: "sca-p06-discovery-reassessment",
        operation_id: `sca-p06-${decision.hypothesis_id}-discovery-reassessment`,
        schema_id: SCA_P06_DISCOVERY_REASSESSMENT_V1_SCHEMA,
        value: reassessment,
        upstream_refs: [
          input.evidence.output_ref,
          input.state.payload_ref,
          baseRef,
          binding.final_revision_ref,
          finalRevision.source_snapshot_ref,
          input.state.request.disclosure_scope_ref,
          input.state.request.action_authority_ref,
          input.state.request.resource_policy_ref,
        ],
        context: input.context,
      });
      const exactReassessment = validateScaP06DiscoveryReassessmentAgainstContext(
        exactJson(input.store, reassessmentRef, "P06 discovery reassessment"),
        {
          decision,
          payload: input.state.payload,
          payload_ref: input.state.payload_ref,
          model_output_ref: input.evidence.output_ref,
          base_obligation: baseObligation,
          base_obligation_ref: baseRef,
          final_revision: finalRevision,
          disclosure_scope: input.state.disclosure_scope,
          action_authority: input.state.action_authority,
          resource_policy: input.state.resource_policy,
        }
      );
      discoveryReassessments.push(exactReassessment);
      discoveryReassessmentRefs.push(reassessmentRef);
      reassessmentRefByHypothesis.set(decision.hypothesis_id, reassessmentRef);
      if (exactReassessment.host_decision === "deny") {
        const checkpoint = checkpointFor({
          store: input.store,
          state: input.state,
          hypothesis_id: decision.hypothesis_id,
          reason_code:
            exactReassessment.blocker_codes[0] ?? "p06_material_discovery_reassessment_denied",
          evidence_refs: [
            ...input.state.evidence_refs,
            ...modelRefs,
            reassessmentRef,
            baseRef,
            binding.final_revision_ref,
          ],
          context: input.context,
        });
        checkpoints.push(checkpoint.value);
        checkpointRefs.push(checkpoint.ref);
        continue;
      }
      const obligation = validateScaP06ObligationRevisionV1(
        withP06SelfDigest(
          {
            schema_id: SCA_P06_OBLIGATION_REVISION_V1_SCHEMA,
            schema_version: 1 as const,
            obligation_id: discovery.obligation_id,
            revision: 2 as const,
            parent_revision_ref: baseRef,
            parent_revision_sha256: baseRef.content_digest,
            discovery_reassessment_ref: reassessmentRef,
            discovery_reassessment_sha256: reassessmentRef.content_digest,
            hypothesis_id: decision.hypothesis_id,
            final_hypothesis_revision_ref: binding.final_revision_ref,
            class: "required-result" as const,
            purpose: discovery.purpose,
            source_mandate: discovery.source_mandate,
            assigning_authority: "host_validated_later_material_discovery" as const,
            rationale:
              "Closed host reassessment allowed the bounded discovery under exact P05 lineage and policy bindings.",
            supporting_observable_ids: discovery.supporting_observable_ids,
            registered_before_action: true as const,
            status: "selected" as const,
            created_at: now,
          },
          "revision_sha256"
        )
      );
      const obligationRef = persistJson({
        store: input.store,
        run_id: input.state.request.run_id,
        kind: "sca-p06-obligation-revision",
        operation_id: `sca-p06-${decision.hypothesis_id}-material-obligation`,
        schema_id: SCA_P06_OBLIGATION_REVISION_V1_SCHEMA,
        value: obligation,
        upstream_refs: [baseRef, reassessmentRef, binding.final_revision_ref],
        context: input.context,
      });
      const exactObligation = validateScaP06ObligationRevisionV1(
        exactJson(input.store, obligationRef, "P06 promoted material obligation")
      );
      if (
        !same(exactObligation.parent_revision_ref, baseRef) ||
        !same(exactObligation.discovery_reassessment_ref, reassessmentRef) ||
        exactReassessment.host_decision !== "allow"
      ) {
        throw new Error("P06 promoted obligation lacks allowed reassessment chain");
      }
      effectiveObligationRefs.set(decision.hypothesis_id, obligationRef);
    }
    for (const decision of input.evidence.decision.items) {
      if (checkpoints.some((entry) => entry.hypothesis_id === decision.hypothesis_id)) continue;
      const binding = input.state.accepted_cohort.final_hypotheses.find(
        (entry) => entry.hypothesis_id === decision.hypothesis_id
      );
      const obligationRef = effectiveObligationRefs.get(decision.hypothesis_id);
      const reassessmentRef = reassessmentRefByHypothesis.get(decision.hypothesis_id) ?? null;
      if (binding === undefined || obligationRef === undefined) {
        throw new Error("P06 decision finalization lacks lineage or obligation");
      }
      const value = validateScaP06ActionRecordV1(
        withP06SelfDigest(
          {
            schema_id: SCA_P06_ACTION_RECORD_V1_SCHEMA,
            schema_version: 1 as const,
            phase_id: "SCA-P06" as const,
            action_id: scaP06ActionId({
              source_snapshot_sha256: input.state.accepted_cohort.source_snapshot_sha256,
              hypothesis_id: decision.hypothesis_id,
              final_revision_sha256: binding.revision_sha256,
            }),
            hypothesis_id: decision.hypothesis_id,
            final_hypothesis_revision_ref: binding.final_revision_ref,
            final_hypothesis_revision_sha256: binding.revision_sha256,
            exact_question: decision.exact_question,
            considered_alternatives: decision.considered_alternatives,
            discriminating_observable: decision.discriminating_observable,
            authority_ref: input.state.request.action_authority_ref,
            authority_sha256: input.state.request.action_authority_ref.content_digest,
            resource_policy_ref: input.state.request.resource_policy_ref,
            resource_policy_sha256: input.state.request.resource_policy_ref.content_digest,
            obligation_revision_ref: obligationRef,
            obligation_revision_sha256: obligationRef.content_digest,
            discovery_reassessment_ref: reassessmentRef,
            discovery_reassessment_sha256: reassessmentRef?.content_digest ?? null,
            effective_obligation_id: decision.effective_obligation_id,
            effective_obligation_class: "required-result" as const,
            decision_classification: decision.decision_classification,
            selected_action: decision.selected_action,
            stopping_rule: decision.stopping_rule,
            child_use: decision.child_use,
            cognitive_payload_ref: input.state.payload_ref,
            model_output_ref: input.evidence.output_ref,
            dispatch_guard_ref: input.evidence.guard_ref,
            model_execution_receipt_ref: input.evidence.receipt_ref,
            p07_execution_status: "not_started" as const,
            vulnerability_adjudication: "not_performed" as const,
            report_or_release_claimed: false as const,
            created_at: now,
          },
          "record_sha256"
        )
      );
      const ref = persistJson({
        store: input.store,
        run_id: input.state.request.run_id,
        kind: "sca-p06-action-record",
        operation_id: `sca-p06-${decision.hypothesis_id}-action-record`,
        schema_id: SCA_P06_ACTION_RECORD_V1_SCHEMA,
        value,
        upstream_refs: [
          obligationRef,
          ...(reassessmentRef === null ? [] : [reassessmentRef]),
          input.state.request.action_authority_ref,
          input.state.request.resource_policy_ref,
          input.evidence.output_ref,
        ],
        context: input.context,
      });
      actionRecords.push(value);
      actionRefs.push(ref);
    }
  } else {
    for (const hypothesisId of input.state.accepted_cohort.active_hypothesis_ids) {
      const checkpoint = checkpointFor({
        store: input.store,
        state: input.state,
        hypothesis_id: hypothesisId,
        reason_code: input.evidence.failure_code ?? "p06_decision_unavailable",
        evidence_refs: [...input.state.evidence_refs, ...modelRefs],
        context: input.context,
      });
      checkpoints.push(checkpoint.value);
      checkpointRefs.push(checkpoint.ref);
    }
  }
  const actionByHypothesis = new Map(
    actionRecords.map((entry, index) => [
      entry.hypothesis_id,
      { value: entry, ref: actionRefs[index] },
    ])
  );
  const checkpointByHypothesis = new Map(
    checkpoints.map((entry, index) => [entry.hypothesis_id, checkpointRefs[index]])
  );
  const rows: ScaP06TraceabilityRowV1[] = input.state.accepted_cohort.final_hypotheses.map(
    (binding) => {
      const action = actionByHypothesis.get(binding.hypothesis_id);
      const checkpoint = checkpointByHypothesis.get(binding.hypothesis_id);
      const baseIndex = input.state.accepted_cohort.active_hypothesis_ids.indexOf(
        binding.hypothesis_id
      );
      const baseRef = input.state.base_obligation_refs[baseIndex];
      const effectiveRef = effectiveObligationRefs.get(binding.hypothesis_id);
      if (baseRef === undefined || effectiveRef === undefined) {
        throw new Error("P06 traceability obligation refs are absent");
      }
      if (checkpoint !== undefined) {
        return {
          hypothesis_id: binding.hypothesis_id,
          final_hypothesis_revision_ref: binding.final_revision_ref,
          base_obligation_ref: baseRef,
          effective_obligation_ref: effectiveRef,
          discovery_reassessment_ref:
            reassessmentRefByHypothesis.get(binding.hypothesis_id) ?? null,
          disposition: "checkpointed_invalid" as const,
          decision_classification: null,
          action_record_ref: null,
          checkpoint_ref: checkpoint,
          p07_execution_status: "not_started" as const,
        };
      }
      if (action === undefined || action.ref === undefined) {
        throw new Error("P06 traceability action ref is absent");
      }
      const blocked = action.value.decision_classification === "no_authorized_action";
      return {
        hypothesis_id: binding.hypothesis_id,
        final_hypothesis_revision_ref: binding.final_revision_ref,
        base_obligation_ref: baseRef,
        effective_obligation_ref: effectiveRef,
        discovery_reassessment_ref: reassessmentRefByHypothesis.get(binding.hypothesis_id) ?? null,
        disposition: blocked
          ? ("blocked_no_authorized_action" as const)
          : ("action_selected" as const),
        decision_classification: action.value.decision_classification,
        action_record_ref: action.ref,
        checkpoint_ref: null,
        p07_execution_status: "not_started" as const,
      };
    }
  );
  const traceability = validateScaP06TraceabilityV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_TRACEABILITY_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P06" as const,
        active_hypothesis_ids: input.state.accepted_cohort.active_hypothesis_ids,
        rows,
        action_record_ids: actionRecords.map((entry) => entry.action_id).sort(),
        blocked_hypothesis_ids: rows
          .filter((entry) => entry.disposition === "blocked_no_authorized_action")
          .map((entry) => entry.hypothesis_id)
          .sort(),
        checkpointed_hypothesis_ids: rows
          .filter((entry) => entry.disposition === "checkpointed_invalid")
          .map((entry) => entry.hypothesis_id)
          .sort(),
        exhaustive: true as const,
      },
      "traceability_sha256"
    )
  );
  const traceabilityRef = persistJson({
    store: input.store,
    run_id: input.state.request.run_id,
    kind: "sca-p06-traceability",
    operation_id: "sca-p06-traceability",
    schema_id: SCA_P06_TRACEABILITY_V1_SCHEMA,
    value: traceability,
    upstream_refs: [
      ...input.state.base_obligation_refs,
      ...discoveryReassessmentRefs,
      ...actionRefs,
      ...checkpointRefs,
    ],
    context: input.context,
  });
  const evidenceRefs = uniqueRefs([
    ...input.state.evidence_refs,
    ...modelRefs,
    ...input.state.base_obligation_refs,
    ...discoveryReassessmentRefs,
    ...[...effectiveObligationRefs.values()],
    ...actionRefs.filter((ref): ref is ArtifactRef => ref !== undefined),
    ...checkpointRefs.filter((ref): ref is ArtifactRef => ref !== undefined),
    traceabilityRef,
  ]);
  const manifest = validateScaP06EvidenceManifestV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_EVIDENCE_MANIFEST_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P06" as const,
        source_snapshot_ref: input.state.accepted_cohort.source_snapshot_ref,
        source_snapshot_sha256: input.state.accepted_cohort.source_snapshot_sha256,
        evidence_refs: evidenceRefs,
        artifact_ids: refIds(evidenceRefs),
      },
      "manifest_sha256"
    )
  );
  const manifestRef = persistJson({
    store: input.store,
    run_id: input.state.request.run_id,
    kind: "sca-p06-evidence-manifest",
    operation_id: "sca-p06-evidence-manifest",
    schema_id: SCA_P06_EVIDENCE_MANIFEST_V1_SCHEMA,
    value: manifest,
    upstream_refs: evidenceRefs,
    context: input.context,
  });
  const noCheckpoints = checkpoints.length === 0;
  const phaseStatus = noCheckpoints ? ("satisfied" as const) : ("pending" as const);
  const phaseBlockers = noCheckpoints
    ? []
    : [...new Set(checkpoints.map((entry) => entry.reason_code))].sort();
  const ledger = validateScaP06SuccessorLedgerV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_SUCCESSOR_LEDGER_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P06" as const,
        run_id: input.state.request.run_id,
        predecessor_ledger_ref: input.state.accepted_cohort.p05_successor_ledger_ref,
        predecessor_ledger_sha256:
          input.state.accepted_cohort.p05_successor_ledger_ref.content_digest,
        phase_obligations: SCA_P06_OBLIGATION_IDS.map((obligationId) => ({
          obligation_id: obligationId,
          class: "required-result" as const,
          status: phaseStatus,
          evidence_refs: noCheckpoints
            ? obligationId === "SCA-OBL-P06-ACCEPTANCE"
              ? [input.state.accepted_cohort_ref]
              : obligationId === "SCA-OBL-OUTPUT-P06-ACTION-RECORDS"
                ? actionRefs.filter((ref): ref is ArtifactRef => ref !== undefined)
                : [traceabilityRef]
            : [],
          blocker_codes: phaseBlockers,
        })),
        evidence_obligations: rows.map((row) => {
          const obligationRef = effectiveObligationRefs.get(row.hypothesis_id);
          if (obligationRef === undefined) throw new Error("P06 ledger obligation ref is absent");
          return {
            obligation_id:
              actionByHypothesis.get(row.hypothesis_id)?.value.effective_obligation_id ??
              scaP06BaseObligationId(row.hypothesis_id),
            hypothesis_id: row.hypothesis_id,
            class: "required-result" as const,
            status:
              row.disposition === "action_selected"
                ? ("selected" as const)
                : row.disposition === "blocked_no_authorized_action"
                  ? ("blocked_authority" as const)
                  : ("pending_invalid" as const),
            obligation_revision_ref: obligationRef,
            discovery_reassessment_ref: row.discovery_reassessment_ref,
            action_record_ref: row.action_record_ref,
            blocker_codes:
              row.disposition === "action_selected"
                ? []
                : row.disposition === "blocked_no_authorized_action"
                  ? ["p06_no_authorized_action"]
                  : [
                      checkpoints.find((entry) => entry.hypothesis_id === row.hypothesis_id)
                        ?.reason_code ?? "p06_invalid_decision_output",
                    ],
          };
        }),
        all_p06_decisions_valid: noCheckpoints,
        p07_ready: noCheckpoints && rows.every((row) => row.disposition === "action_selected"),
        pending_phase_ids: PENDING_PHASE_IDS,
        append_only: true as const,
        release_eligible: false as const,
        campaign_complete: false as const,
        campaign_completion_claimed: false as const,
      },
      "ledger_sha256"
    )
  );
  const ledgerRef = persistJson({
    store: input.store,
    run_id: input.state.request.run_id,
    kind: "sca-p06-successor-ledger",
    operation_id: "sca-p06-successor-ledger",
    schema_id: SCA_P06_SUCCESSOR_LEDGER_V1_SCHEMA,
    value: ledger,
    upstream_refs: [manifestRef],
    context: input.context,
  });
  const blockedCount = rows.filter(
    (row) => row.disposition === "blocked_no_authorized_action"
  ).length;
  const blockerCodes = [
    ...new Set([...phaseBlockers, ...(blockedCount > 0 ? ["p06_no_authorized_action"] : [])]),
  ].sort();
  const gate = validateScaP06GateV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_GATE_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P06" as const,
        criterion_id: "AC-P06" as const,
        verdict:
          checkpoints.length > 0
            ? ("blocked_invalid" as const)
            : blockedCount > 0
              ? ("pass_blocked" as const)
              : ("pass_ready" as const),
        p05_gate_ref: input.state.accepted_cohort.p05_gate_ref,
        traceability_ref: traceabilityRef,
        evidence_manifest_ref: manifestRef,
        successor_ledger_ref: ledgerRef,
        exhaustive_accounting: true,
        immutable_p05_lineage_valid: true,
        least_consequence_valid: checkpoints.length === 0,
        authority_and_resource_bindings_valid: checkpoints.length === 0,
        discovery_reassessment_refs: [...discoveryReassessmentRefs].sort((left, right) =>
          left.artifact_id.localeCompare(right.artifact_id)
        ),
        discovery_reassessments_valid: discoveryReassessments.every(
          (entry) => entry.host_decision === "allow"
        ),
        denied_discovery_count: discoveryReassessments.filter(
          (entry) => entry.host_decision === "deny"
        ).length,
        obligations_registered_before_action: true,
        child_policy_valid: checkpoints.length === 0,
        p07_execution_claims_absent: true,
        action_record_count: actionRecords.length,
        blocked_action_count: blockedCount,
        checkpoint_count: checkpoints.length,
        blocker_codes: blockerCodes,
        evaluated_at: now,
      },
      "gate_sha256"
    )
  );
  const gateRef = persistJson({
    store: input.store,
    run_id: input.state.request.run_id,
    kind: "sca-p06-gate",
    operation_id: "sca-p06-gate",
    schema_id: SCA_P06_GATE_V1_SCHEMA,
    value: gate,
    upstream_refs: [traceabilityRef, manifestRef, ledgerRef, ...discoveryReassessmentRefs],
    context: input.context,
  });
  let transition: ScaP06ToP07TransitionV1 | null = null;
  let transitionRef: ArtifactRef | null = null;
  if (gate.verdict === "pass_ready") {
    transition = validateScaP06ToP07TransitionV1(
      withP06SelfDigest(
        {
          schema_id: SCA_P06_TO_P07_TRANSITION_V1_SCHEMA,
          schema_version: 1 as const,
          source_phase_id: "SCA-P06" as const,
          target_phase_id: "SCA-P07" as const,
          authorized: true as const,
          qualification_scope: "decision_gate_only_not_p07_execution" as const,
          p06_request_ref: input.state.request_ref,
          accepted_cohort_ref: input.state.accepted_cohort_ref,
          traceability_ref: traceabilityRef,
          evidence_manifest_ref: manifestRef,
          successor_ledger_ref: ledgerRef,
          p06_gate_ref: gateRef,
          action_record_refs: actionRefs
            .filter((ref): ref is ArtifactRef => ref !== undefined)
            .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
          discovery_reassessment_refs: [...discoveryReassessmentRefs].sort((left, right) =>
            left.artifact_id.localeCompare(right.artifact_id)
          ),
          p07_execution_status: "not_started" as const,
          p07_execution_authorized_by_this_transition: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
        },
        "transition_sha256"
      )
    );
    transitionRef = persistJson({
      store: input.store,
      run_id: input.state.request.run_id,
      kind: "sca-p06-to-p07-transition",
      operation_id: "sca-p06-to-p07-transition",
      schema_id: SCA_P06_TO_P07_TRANSITION_V1_SCHEMA,
      value: transition,
      upstream_refs: [gateRef, ...actionRefs, ...discoveryReassessmentRefs],
      context: input.context,
    });
  }
  const terminal = validateScaP06TerminalV1({
    schema_id: SCA_P06_TERMINAL_V1_SCHEMA,
    schema_version: 1,
    phase_id: "SCA-P06",
    status: transitionRef === null ? "blocked" : "candidate_complete",
    gate_ref: gateRef,
    p07_transition_ref: transitionRef,
    p07_decision_handoff_ready: transitionRef !== null,
    p07_execution_occurred: false,
    selected_artifact_refs:
      transitionRef === null ? [gateRef, ledgerRef] : [transitionRef, gateRef],
    blocker_codes: transitionRef === null ? blockerCodes : [],
    release_eligible: false,
    campaign_complete: false,
    nonterminal_campaign: true,
    report_or_finding_adjudication_performed: false,
  });
  const terminalRef = persistJson({
    store: input.store,
    run_id: input.state.request.run_id,
    kind: "sca-p06-terminal",
    operation_id: "sca-p06-terminal",
    schema_id: SCA_P06_TERMINAL_V1_SCHEMA,
    value: terminal,
    upstream_refs: [gateRef, ledgerRef, ...(transitionRef === null ? [] : [transitionRef])],
    context: input.context,
  });
  if (input.context !== undefined) {
    for (const ref of uniqueRefs([
      ...discoveryReassessmentRefs,
      ...[...effectiveObligationRefs.values()],
      ...actionRefs.filter((ref): ref is ArtifactRef => ref !== undefined),
      ...checkpointRefs.filter((ref): ref is ArtifactRef => ref !== undefined),
      traceabilityRef,
      manifestRef,
      ledgerRef,
      gateRef,
      ...(transitionRef === null ? [] : [transitionRef]),
      terminalRef,
    ])) {
      if (
        !input.context.selectedArtifacts.some(
          (selected) => selected.artifact_id === ref.artifact_id
        )
      ) {
        input.context.selectedArtifacts.push(ref);
      }
    }
  }
  return { output: terminal, output_ref: terminalRef };
}

const SCA_P06_START_V1_SCHEMA = "penny.sca-p06-candidate-start.v1" as const;
const ScaP06StartConstraintsV1Schema = Type.Object(
  { p06_request: ScaP06RequestV1Schema },
  { additionalProperties: false, $id: SCA_P06_START_V1_SCHEMA }
);

const P06DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    accepted_cohort_ref: ArtifactRefSchema,
    payload_ref: ArtifactRefSchema,
    disclosure_ref: ArtifactRefSchema,
    base_obligation_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 10_000 }),
  },
  { additionalProperties: false }
);
type P06Data = Readonly<Static<typeof P06DataSchema>>;
function data(context: RunContext): P06Data {
  return validateContract(P06DataSchema, context.playbookData, "SCA P06 durable state");
}

function preparedFromContext(input: {
  readonly store: ArtifactHostStore;
  readonly context: RunContext;
  readonly trusted_clock: () => Date;
}): PreparedState {
  const state = data(input.context);
  const request = validateScaP06RequestV1(exactJson(input.store, state.request_ref, "P06 request"));
  const accepted = validateContract(
    Type.Object({}, { additionalProperties: true }),
    exactJson(input.store, state.accepted_cohort_ref, "P06 accepted cohort"),
    "P06 accepted cohort JSON"
  );
  const acceptedCohort = validateScaP06AcceptedCohortV1(accepted);
  const payload = validateScaP06CognitivePayloadV1(
    exactJson(input.store, state.payload_ref, "P06 payload")
  );
  const disclosure = validateScaP06DisclosureAdmissionV1(
    exactJson(input.store, state.disclosure_ref, "P06 disclosure")
  );
  const admission = admitScaP06Candidate({
    store: input.store,
    request,
    input_artifacts: scaP06InputArtifacts(request),
    trusted_clock: input.trusted_clock,
  });
  const obligationPairs = state.base_obligation_refs.map((ref) => ({
    ref,
    value: validateScaP06ObligationRevisionV1(exactJson(input.store, ref, "P06 base obligation")),
  }));
  const byHypothesis = new Map(obligationPairs.map((entry) => [entry.value.hypothesis_id, entry]));
  const ordered = acceptedCohort.active_hypothesis_ids.map((hypothesisId) => {
    const entry = byHypothesis.get(hypothesisId);
    if (entry === undefined) throw new Error("P06 durable state omits a base obligation");
    return entry;
  });
  if (
    request.run_id !== input.context.identity.run_id ||
    !same(payload.accepted_cohort_ref, state.accepted_cohort_ref) ||
    !same(payload.disclosure_scope_ref, request.disclosure_scope_ref) ||
    !same(disclosure.payload_ref, state.payload_ref) ||
    !same(acceptedCohort.p06_request_ref, state.request_ref)
  ) {
    throw new Error("P06 durable state cohort/payload/request binding mismatch");
  }
  return {
    request,
    request_ref: state.request_ref,
    accepted_cohort: acceptedCohort,
    accepted_cohort_ref: state.accepted_cohort_ref,
    payload,
    payload_ref: state.payload_ref,
    disclosure,
    disclosure_ref: state.disclosure_ref,
    disclosure_scope: admission.disclosure_scope,
    action_authority: admission.action_authority,
    resource_policy: admission.resource_policy,
    final_revisions: admission.predecessor.final_revisions,
    base_obligations: ordered.map((entry) => entry.value),
    base_obligation_refs: ordered.map((entry) => entry.ref),
    evidence_refs: uniqueRefs([
      state.request_ref,
      state.accepted_cohort_ref,
      state.payload_ref,
      state.disclosure_ref,
      ...state.base_obligation_refs,
      ...admission.transitive_refs,
    ]),
  };
}

const START_ADMISSION: StartAdmissionV1 = {
  schema_id: SCA_P06_START_V1_SCHEMA,
  schema_version: 1,
  prepare(request: StartRequest): PreparedStartV1 {
    const constraints = validateContract(
      ScaP06StartConstraintsV1Schema,
      request.constraints,
      "SCA P06 start constraints"
    );
    const p06 = validateScaP06RequestV1(constraints.p06_request);
    if (
      request.identity.playbook !== CANDIDATE ||
      request.identity.run_id !== p06.run_id ||
      request.input_artifacts === undefined ||
      !same(request.input_artifacts, scaP06InputArtifacts(p06))
    ) {
      throw new Error("SCA P06 start identity or exact input set is invalid");
    }
    return {
      schema_id: SCA_P06_START_V1_SCHEMA,
      schema_version: 1,
      request,
      goal: request.goal,
      constraints,
      input_artifacts: request.input_artifacts,
      admission_data: p06,
    };
  },
  materialize(prepared, host) {
    if (host.artifactStore === undefined || prepared.input_artifacts === undefined) {
      throw new Error("SCA P06 materialization requires artifact store and exact inputs");
    }
    const clock = host.trustedClock ?? (() => new Date());
    const request = validateScaP06RequestV1(prepared.admission_data);
    const state = prepare({
      store: host.artifactStore,
      run_id: host.run_id,
      request,
      input_artifacts: prepared.input_artifacts,
      trusted_clock: clock,
    });
    return [
      state.request_ref,
      state.accepted_cohort_ref,
      state.payload_ref,
      state.disclosure_ref,
      ...state.base_obligation_refs,
    ];
  },
};

function decisionDirective(context: RunContext, state: PreparedState): Directive {
  const artifact = outputArtifact(context.identity.run_id);
  artifact.upstream_refs = [state.payload_ref, state.disclosure_ref];
  return validateDirective({
    schema_version: 2,
    action: "invoke_agent",
    identity: context.identity,
    state_id: SCA_P06_DECIDING_STATE,
    agent: "demetri",
    attempt: 1,
    task: 'For every assigned active P05 hypothesis, choose the least-consequential capable and authorized evidence action. Compare source, graph, then application evidence in that exact order. For the result\'s payload_sha256 field, copy the exact payload.payload_sha256 JSON field inside the cognitive payload; do not copy the input artifact ref content_digest, which is a different digest. Bind the exact question, discriminating observables, authority, resource profile, and stopping rules. No child capability is needed or available, so child_use must be exactly {"status":"not_invoked","capability_id":null,"invocation_ref":null,"reason_code":"not_required_for_decision"}. Do not invoke an action, adjudicate a vulnerability, or claim P07, report, release, or campaign work. Return only the exact closed decision-result JSON contract. No tools are available.',
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "cognitive_payload", ref: state.payload_ref },
        { slot: "disclosure_admission", ref: state.disclosure_ref },
      ],
    },
    output_artifact: artifact,
    trust_profile: "hardened-untrusted",
    model_override: SCA_P06_REQUIRED_MODEL.override,
  });
}

export class ScaP06CandidatePlaybook implements Playbook {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly trustedClock: () => Date = () => new Date()
  ) {}

  initialize(context: RunContext): Directive {
    const requestRef = latestSelected(
      context,
      (ref) => ref.kind === "sca-p06-request" && ref.run_id === context.identity.run_id
    );
    const cohortRef = latestSelected(context, (ref) => ref.kind === "sca-p06-accepted-cohort");
    const payloadRef = latestSelected(context, (ref) => ref.kind === "sca-p06-cognitive-payload");
    const disclosureRef = latestSelected(
      context,
      (ref) => ref.kind === "sca-p06-disclosure-admission"
    );
    const baseRefs = context.selectedArtifacts
      .filter(
        (ref) =>
          ref.kind === "sca-p06-obligation-revision" &&
          ref.operation_id.endsWith("-base-obligation")
      )
      .sort((left, right) => left.operation_id.localeCompare(right.operation_id));
    if (
      requestRef === undefined ||
      cohortRef === undefined ||
      payloadRef === undefined ||
      disclosureRef === undefined ||
      baseRefs.length === 0
    ) {
      throw new Error("SCA P06 entry artifacts are absent");
    }
    Object.assign(context.playbookData, {
      request_ref: requestRef,
      accepted_cohort_ref: cohortRef,
      payload_ref: payloadRef,
      disclosure_ref: disclosureRef,
      base_obligation_refs: baseRefs,
    });
    const state = preparedFromContext({
      store: this.store,
      context,
      trusted_clock: this.trustedClock,
    });
    if (state.disclosure.decision !== "allow") {
      context.transition(SCA_P06_FINAL_STATE);
      const completed = finalize({
        store: this.store,
        state,
        evidence: {
          decision: null,
          output_ref: null,
          guard_ref: null,
          receipt_ref: null,
          failure_code:
            state.disclosure.blocker_codes[0] ?? "p06_disclosure_denied_before_dispatch",
        },
        trusted_clock: this.trustedClock,
        context,
      });
      return this.completedDirective(context, completed.output);
    }
    context.transition(SCA_P06_DECIDING_STATE);
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    if (context.stateId !== SCA_P06_DECIDING_STATE) {
      throw new Error(`SCA P06 has no dispatch for '${context.stateId}'`);
    }
    const state = preparedFromContext({
      store: this.store,
      context,
      trusted_clock: this.trustedClock,
    });
    if (state.disclosure.decision !== "allow") {
      throw new Error("SCA P06 denied disclosure cannot dispatch");
    }
    const directive = decisionDirective(context, state);
    context.pendingDirective = directive;
    return directive;
  }

  resume(): Directive {
    throw new Error("SCA P06 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = "sca_p06_cancelled";
    context.status = "cancelled";
    context.met = false;
    const terminal = validateScaP06TerminalV1({
      schema_id: SCA_P06_TERMINAL_V1_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P06",
      status: "cancelled",
      gate_ref: null,
      p07_transition_ref: null,
      p07_decision_handoff_ready: false,
      p07_execution_occurred: false,
      selected_artifact_refs: this.terminalArtifacts(context),
      blocker_codes: [
        reason.startsWith("model call outcome remote_unknown")
          ? "p06_remote_unknown_quarantined"
          : reason.startsWith("model outcome persisted but not committed")
            ? "p06_uncommitted_outcome_quarantined"
            : "p06_cancelled",
      ],
      release_eligible: false,
      campaign_complete: false,
      nonterminal_campaign: true,
      report_or_finding_adjudication_performed: false,
    });
    const directive = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: terminal,
      artifacts: this.terminalArtifacts(context),
      unresolved: terminal.blocker_codes,
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (context.stateId === SCA_P06_DECIDING_STATE && pending?.action === "invoke_agent") {
      const coordinate = {
        run_id: context.identity.run_id,
        state_id: pending.state_id,
        branch_id: null,
        agent: pending.agent,
        attempt: pending.attempt,
      };
      const guardRef = this.store.refFor(
        context.identity.run_id,
        pending.state_id,
        null,
        "model-dispatch-guard",
        modelDispatchGuardOperationId(coordinate),
        1
      );
      if (guardRef !== null) {
        const outputRef = this.store.refFor(
          context.identity.run_id,
          pending.state_id,
          null,
          pending.output_artifact.kind,
          pending.output_artifact.operation_id,
          pending.output_artifact.version
        );
        const receiptRef = this.store.refFor(
          context.identity.run_id,
          pending.state_id,
          null,
          "model-execution-receipt",
          modelExecutionReceiptOperationId(coordinate),
          1
        );
        let complete = false;
        if (outputRef !== null && receiptRef !== null) {
          try {
            const prepared = preparedFromContext({
              store: this.store,
              context,
              trusted_clock: this.trustedClock,
            });
            this.executionEvidence(context, prepared, outputRef);
            complete = true;
          } catch {
            complete = false;
          }
        }
        return this.cancel(
          context,
          complete
            ? "model outcome persisted but not committed; durable fencing prohibits implicit acceptance or replay"
            : "model call outcome remote_unknown; durable dispatch fencing prohibits automatic replay"
        );
      }
    }
    return pending;
  }

  terminalizeLiveness(
    context: RunContext,
    reason: LivenessTerminalReason,
    _snapshot: LivenessSnapshotV1
  ): Directive {
    const state = preparedFromContext({
      store: this.store,
      context,
      trusted_clock: this.trustedClock,
    });
    const outputRef = latestSelected(context, (ref) => ref.kind === "sca-p06-decision-output");
    const coordinate = {
      run_id: context.identity.run_id,
      state_id: SCA_P06_DECIDING_STATE,
      branch_id: null,
      agent: "demetri",
      attempt: 1,
    };
    const guardRef = this.store.refFor(
      context.identity.run_id,
      SCA_P06_DECIDING_STATE,
      null,
      "model-dispatch-guard",
      modelDispatchGuardOperationId(coordinate),
      1
    );
    const receiptRef = this.store.refFor(
      context.identity.run_id,
      SCA_P06_DECIDING_STATE,
      null,
      "model-execution-receipt",
      modelExecutionReceiptOperationId(coordinate),
      1
    );
    context.transition(SCA_P06_FINAL_STATE);
    const completed = finalize({
      store: this.store,
      state,
      evidence: {
        decision: null,
        output_ref: outputRef ?? null,
        guard_ref: guardRef,
        receipt_ref: receiptRef,
        failure_code: `p06_liveness_${reason}`,
      },
      trusted_clock: this.trustedClock,
      context,
    });
    return this.completedDirective(context, completed.output);
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    if (context.stateId !== SCA_P06_DECIDING_STATE) {
      throw new Error(`unexpected SCA P06 summary in '${context.stateId}'`);
    }
    const state = preparedFromContext({
      store: this.store,
      context,
      trusted_clock: this.trustedClock,
    });
    const outputRef = latestSelected(context, (ref) => ref.kind === "sca-p06-decision-output");
    if (outputRef === undefined) throw new Error("SCA P06 decision output ref is absent");
    let evidence: DecisionEvidence;
    try {
      const execution = this.executionEvidence(context, state, outputRef);
      evidence = {
        decision: validateScaP06DecisionResultAgainstPayload(details, state.payload),
        output_ref: outputRef,
        guard_ref: execution.guard_ref,
        receipt_ref: execution.receipt_ref,
        failure_code: null,
      };
    } catch {
      const coordinate = {
        run_id: context.identity.run_id,
        state_id: SCA_P06_DECIDING_STATE,
        branch_id: null,
        agent: "demetri",
        attempt: 1,
      };
      evidence = {
        decision: null,
        output_ref: outputRef,
        guard_ref: this.store.refFor(
          context.identity.run_id,
          SCA_P06_DECIDING_STATE,
          null,
          "model-dispatch-guard",
          modelDispatchGuardOperationId(coordinate),
          1
        ),
        receipt_ref: this.store.refFor(
          context.identity.run_id,
          SCA_P06_DECIDING_STATE,
          null,
          "model-execution-receipt",
          modelExecutionReceiptOperationId(coordinate),
          1
        ),
        failure_code: "p06_semantic_or_execution_evidence_invalid",
      };
    }
    context.transition(SCA_P06_FINAL_STATE);
    const completed = finalize({
      store: this.store,
      state,
      evidence,
      trusted_clock: this.trustedClock,
      context,
    });
    return this.completedDirective(context, completed.output);
  }

  private executionEvidence(
    context: RunContext,
    state: PreparedState,
    outputRef: ArtifactRef
  ): { readonly guard_ref: ArtifactRef; readonly receipt_ref: ArtifactRef } {
    const coordinate = {
      run_id: context.identity.run_id,
      state_id: SCA_P06_DECIDING_STATE,
      branch_id: null,
      agent: "demetri",
      attempt: 1,
    };
    const guardRef = this.store.refFor(
      context.identity.run_id,
      SCA_P06_DECIDING_STATE,
      null,
      "model-dispatch-guard",
      modelDispatchGuardOperationId(coordinate),
      1
    );
    const receiptRef = this.store.refFor(
      context.identity.run_id,
      SCA_P06_DECIDING_STATE,
      null,
      "model-execution-receipt",
      modelExecutionReceiptOperationId(coordinate),
      1
    );
    if (guardRef === null || receiptRef === null) {
      throw new Error("P06 model dispatch guard or receipt is absent");
    }
    const guard = validateModelDispatchGuardV1(exactJson(this.store, guardRef, "P06 guard"));
    const wrapper = validateModelExecutionReceiptV1(
      exactJson(this.store, receiptRef, "P06 receipt")
    );
    const receipt = wrapper.execution_receipt;
    const inputs = {
      schema_version: 2 as const,
      artifacts: [
        { slot: "cognitive_payload", ref: state.payload_ref },
        { slot: "disclosure_admission", ref: state.disclosure_ref },
      ],
    };
    if (
      !same(guard.coordinate, coordinate) ||
      !same(guard.requested_model, SCA_P06_REQUIRED_MODEL) ||
      guard.provider_opening_guard !== SCA_P06_PROVIDER_OPENING_GUARD ||
      guard.input_artifacts_sha256 !== sha256(canonicalJson(inputs)) ||
      !same(wrapper.dispatch_guard_ref, guardRef) ||
      receipt.run_id !== coordinate.run_id ||
      receipt.state_id !== coordinate.state_id ||
      receipt.branch_id !== null ||
      receipt.agent !== coordinate.agent ||
      receipt.attempt !== coordinate.attempt ||
      !same(receipt.requested_model, SCA_P06_REQUIRED_MODEL) ||
      receipt.observed_model === undefined ||
      !same(receipt.output_artifact_ref, outputRef) ||
      receipt.output_digest !== outputRef.content_digest
    ) {
      throw new Error("P06 model execution evidence binding mismatch");
    }
    assertResolvedModelIdentity(
      SCA_P06_REQUIRED_MODEL,
      receipt.observed_model,
      "P06 observed model"
    );
    return { guard_ref: guardRef, receipt_ref: receiptRef };
  }

  private completedDirective(context: RunContext, terminal: ScaP06TerminalV1): Directive {
    context.stateId = SCA_P06_FINAL_STATE;
    context.status = "incomplete";
    context.met = false;
    const artifacts = this.terminalArtifacts(context);
    const directive = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: terminal,
      artifacts,
      unresolved:
        terminal.status === "candidate_complete"
          ? ["SCA-P07 remains separately admitted; no P07 action was executed."]
          : terminal.blocker_codes,
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private terminalArtifacts(context: RunContext): ArtifactRef[] {
    const kinds = new Set([
      "sca-p06-request",
      "sca-p06-accepted-cohort",
      "sca-p06-traceability",
      "sca-p06-evidence-manifest",
      "sca-p06-successor-ledger",
      "sca-p06-gate",
      "sca-p06-to-p07-transition",
      "sca-p06-terminal",
    ]);
    const core = context.selectedArtifacts.filter(
      (ref) => ref.run_id === context.identity.run_id && kinds.has(ref.kind)
    );
    const checkpoint = [...context.selectedArtifacts]
      .reverse()
      .find((ref) => ref.kind === "sca-p06-checkpoint");
    return uniqueRefs(checkpoint === undefined ? core : [...core, checkpoint]).slice(0, 128);
  }
}

function port(input: {
  readonly name: string;
  readonly kind: string;
  readonly schema: string;
  readonly direction: "input" | "output";
  readonly min?: number;
  readonly max?: number;
}) {
  return {
    schema_version: 1 as const,
    name: input.name,
    direction: input.direction,
    transport: "artifact" as const,
    schema_id: input.schema,
    schema_version_required: 1 as const,
    artifact_kind: input.kind,
    source: input.direction === "input" ? ("caller" as const) : ("skill" as const),
    min_items: input.min ?? 1,
    max_items: input.max ?? 1,
    semantic_product: input.direction === "output",
  };
}

export const SCA_P06_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: CANDIDATE,
  objective:
    "Choose one least-consequential discriminating evidence action for every exact active P05 hypothesis without executing P07 or adjudicating a vulnerability.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: SCA_P06_START_V1_SCHEMA,
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [
      port({
        name: "p05_transition",
        kind: "sca-p05-to-p06-transition",
        schema: "penny.sca-p05-to-p06-transition.v1",
        direction: "input",
      }),
      port({
        name: "implementation_identity",
        kind: "sca-p06-implementation-identity",
        schema: "penny.sca-p06-implementation-identity.v1",
        direction: "input",
      }),
      port({
        name: "runtime_policy",
        kind: "sca-p06-runtime-policy",
        schema: "penny.sca-p06-runtime-policy.v1",
        direction: "input",
      }),
      port({
        name: "action_authority",
        kind: "sca-p06-action-authority",
        schema: "penny.sca-p06-action-authority.v1",
        direction: "input",
      }),
      port({
        name: "resource_policy",
        kind: "sca-p06-resource-policy",
        schema: "penny.sca-p06-resource-policy.v1",
        direction: "input",
      }),
      port({
        name: "disclosure_scope",
        kind: "sca-p06-disclosure-scope",
        schema: "penny.sca-p06-disclosure-scope.v1",
        direction: "input",
      }),
    ],
    active_output_ports: [
      port({
        name: "discovery_reassessments",
        kind: "sca-p06-discovery-reassessment",
        schema: SCA_P06_DISCOVERY_REASSESSMENT_V1_SCHEMA,
        direction: "output",
        min: 0,
        max: 10_000,
      }),
      port({
        name: "traceability",
        kind: "sca-p06-traceability",
        schema: SCA_P06_TRACEABILITY_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "gate",
        kind: "sca-p06-gate",
        schema: SCA_P06_GATE_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p07_transition",
        kind: "sca-p06-to-p07-transition",
        schema: SCA_P06_TO_P07_TRANSITION_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
    ],
  },
  behavior: {
    side_effects: {
      external_reads: "host_policy_only",
      external_mutations: "forbidden",
      filesystem_writes: "host_policy_only",
      allowed_relative_paths: [],
    },
    approval: { policy: "caller_skill_request", additional_approval_required: false },
    stopping: {
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "incomplete",
    },
    escalation: { out_of_scope_effect: "non_positive", sandbox_prevention_claim: false },
    violation_terminal: "incomplete",
  },
  guidance: {
    skill_root: ".pi/skills/sca/assets/prompts",
    resolution: "per_agent_phase",
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.sca-p06-candidate-budget.v1",
    resolver_id: "scaP06CandidateLeaseResolver",
    admission_id: "scaP06CandidateAdmission",
    snapshot_id: "scaP06CandidateSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [SCA_P06_FINAL_STATE],
    required_visited_states: [SCA_P06_FINAL_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: SCA_P06_TERMINAL_V1_SCHEMA,
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

export const SCA_P06_CANDIDATE_REGISTRATION: PlaybookRegistration = {
  name: CANDIDATE,
  contract: SCA_P06_CANDIDATE_SKILL_CONTRACT,
  ingress: "skill",
  start_admission: START_ADMISSION,
  caller_documentation: {
    constraints_schema: ScaP06StartConstraintsV1Schema,
    example: {
      goal: "Run inactive P06 evidence-decision candidate.",
      constraints: { p06_request: {} },
    },
    semantic_caveat:
      "P06 chooses but never executes evidence actions. It does not adjudicate vulnerabilities, report, release, or complete a campaign.",
  },
  liveness: {
    resolver_id: SCA_P06_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
    resolve: () => undefined,
    thinking_policy: "agent_ssot",
  },
  worker: {
    kind: "catalog-agent",
    workflow_name: CANDIDATE,
    guidance: SCA_P06_CANDIDATE_SKILL_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: new Map([
      [
        SCA_P06_DECIDING_STATE,
        {
          agent: "demetri",
          result_schema_id: "penny.sca-p06-decision-result.v1",
          result_schema_version: 1 as const,
          schema: ScaP06DecisionResultV1Schema,
          allowed_tools: SCA_P06_REQUIRED_TOOL_SUBSET,
          required_model: SCA_P06_REQUIRED_MODEL,
          provider_opening_guard: SCA_P06_PROVIDER_OPENING_GUARD,
        },
      ],
    ]),
  },
  host_states: [SCA_P06_FINAL_STATE],
  completionReceiptPredicates: new Map(),
  construct: (options) => {
    if (options.artifactStore === undefined) throw new Error("P06 candidate needs artifact store");
    return new ScaP06CandidatePlaybook(
      options.artifactStore,
      options.trustedClock ?? (() => new Date())
    );
  },
};
