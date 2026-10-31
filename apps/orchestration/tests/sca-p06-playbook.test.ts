import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const p06AdmissionState: { value: Record<string, unknown> } = { value: {} };
vi.mock("../dist/sca/p06-admission.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../dist/sca/p06-admission.js")>();
  return {
    ...original,
    admitScaP06Candidate: (input: { request: unknown }) => ({
      ...p06AdmissionState.value,
      request: input.request,
      transitive_refs: [],
    }),
  };
});

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  ExecutionReceiptSchema,
  validateContract,
  type ArtifactRef,
  type Directive,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { trustedInvocationDigest } from "../dist/receipts.js";
import {
  MODEL_DISPATCH_GUARD_V1_SCHEMA,
  MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
} from "../dist/required-model.js";
import {
  SCA_P06_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
  SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P06_DECISION_RESULT_V1_SCHEMA,
  SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P06_OBLIGATION_REVISION_V1_SCHEMA,
  SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
  SCA_P06_REQUEST_V1_SCHEMA,
  SCA_P06_REQUIRED_MODEL,
  scaP06BaseObligationId,
  validateScaP06AcceptedCohortV1,
  validateScaP06ActionAuthorityV1,
  validateScaP06ActionRecordV1,
  validateScaP06CognitivePayloadV1,
  validateScaP06DecisionResultAgainstPayload,
  validateScaP06DisclosureAdmissionV1,
  validateScaP06DisclosureScopeV1,
  validateScaP06DiscoveryReassessmentAgainstContext,
  validateScaP06DiscoveryReassessmentV1,
  validateScaP06GateV1,
  validateScaP06ObligationRevisionV1,
  validateScaP06ResourcePolicyV1,
  validateScaP06SuccessorLedgerV1,
  validateScaP06TerminalV1,
  validateScaP06ToP07TransitionV1,
  validateScaP06TraceabilityV1,
  withP06SelfDigest,
  type ScaP06CognitivePayloadV1,
} from "../dist/sca/p06-contracts.js";
import { ScaP06CandidatePlaybook } from "../dist/sca/p06-playbook.js";
import { withSelfDigest, type ScaP05HypothesisBodyV1 } from "../dist/sca/p05-contracts.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
function first<T>(values: readonly T[], label: string): T {
  return required(values[0], label);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p06-playbook-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function persist(
  artifacts: ArtifactStore,
  input: {
    readonly runId: string;
    readonly phase: string;
    readonly kind: string;
    readonly operationId: string;
    readonly producer: string;
    readonly schemaId: string;
    readonly value: unknown;
  }
): ArtifactRef {
  return artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: input.runId,
      phase: input.phase,
      branch_id: null,
      kind: input.kind,
      operation_id: input.operationId,
      version: 1,
      producer: input.producer,
      media_type: "application/json",
      content_schema: { schema_id: input.schemaId, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson(input.value),
  });
}
function placeholder(input: {
  runId: string;
  phase: string;
  kind: string;
  schema: string;
  hex: string;
}): ArtifactRef {
  const digest = input.hex.repeat(64);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: input.runId,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.kind,
    version: 1,
    producer: "host:test",
    media_type: "application/json",
    content_schema: { schema_id: input.schema, schema_version: 1 },
    byte_length: 1,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}
function hypothesis(hypothesisId: string, selectedItemId: string): ScaP05HypothesisBodyV1 {
  const suffix = hypothesisId.slice("p05h_".length);
  const atomId = `p05a_${"3".repeat(64)}`;
  return {
    hypothesis_id: hypothesisId,
    selected_item_id: selectedItemId,
    bounded_claim: "A bounded actor-controlled path may reach a protected operation.",
    actor: { claim: "A non-admin actor", evidence_atom_ids: [atomId] },
    controlled_input: { claim: "An actor-controlled value", evidence_atom_ids: [atomId] },
    relevant_state: { claim: "The actor lacks authorization", evidence_atom_ids: [atomId] },
    causal_path: [
      {
        ordinal: 1,
        causal_link: "Input reaches the decision.",
        state_before: "Input accepted",
        state_after: "Decision reached",
        basis: "observed",
        evidence_atom_ids: [atomId],
      },
    ],
    security_sensitive_outcome: {
      claim: "Protected operation may run",
      evidence_atom_ids: [atomId],
    },
    competing_benign_explanation: {
      explanation: "A guard may dominate all paths.",
      discriminating_observation: "Inspect exact domination.",
      evidence_atom_ids: [atomId],
    },
    expected_supporting_observations: [
      {
        observable_id: `p05o_${suffix}_supporting_0001`,
        observation: "A bypassing path exists.",
        expected_if_claim: true,
        evidence_mode: "graph",
        basis_atom_ids: [atomId],
      },
    ],
    expected_refuting_observations: [
      {
        observable_id: `p05o_${suffix}_refuting_0001`,
        observation: "The guard dominates every path.",
        expected_if_claim: false,
        evidence_mode: "graph",
        basis_atom_ids: [atomId],
      },
    ],
    next_evidence_need: {
      question: "Does the guard dominate the protected operation?",
      evidence_mode: "graph",
      target: "guard and operation",
      discriminating_result: "A bypass exists or every path is dominated.",
    },
    stopping_conditions: {
      supported: "Stop on a complete bypass.",
      refuted: "Stop on complete domination.",
      inconclusive: "Stop when evidence cannot distinguish.",
    },
    reopening_conditions: [
      { trigger: "Source changes.", changed_basis_required: "A new snapshot." },
    ],
  };
}

function fixture(artifacts: ArtifactStore, runId: string) {
  const suffix = "a".repeat(64);
  const hypothesisId = `p05h_${suffix}`;
  const selectedItemId = `p04i_${suffix}`;
  const body = hypothesis(hypothesisId, selectedItemId);
  const sourceRef = persist(artifacts, {
    runId: "run-source",
    phase: "SCA-P01",
    kind: "source",
    operationId: "source-snapshot",
    producer: "host:test",
    schemaId: "penny.test-source.v1",
    value: { schema_id: "penny.test-source.v1", schema_version: 1, source: "exact" },
  });
  const revision = withSelfDigest(
    {
      schema_id: "penny.sca-p05-hypothesis-revision.v1" as const,
      schema_version: 1 as const,
      hypothesis_id: hypothesisId,
      selected_item_id: selectedItemId,
      revision: 1 as const,
      parent_revision_ref: null,
      parent_revision_sha256: null,
      body,
      body_sha256: sha256(canonicalJson(body)),
      source_snapshot_ref: sourceRef,
      source_snapshot_sha256: sourceRef.content_digest,
      p04_transition_ref: placeholder({
        runId: "run-p04",
        phase: "SCA-P04",
        kind: "transition",
        schema: "penny.sca-p04-to-p05-transition.v1",
        hex: "2",
      }),
      cognitive_payload_ref: placeholder({
        runId: "run-p05",
        phase: "forming_hypotheses",
        kind: "payload",
        schema: "penny.sca-p05-cognitive-payload.v1",
        hex: "3",
      }),
      model_output_ref: placeholder({
        runId: "run-p05",
        phase: "forming_hypotheses",
        kind: "output",
        schema: "penny.sca-p05-constructor-result.v1",
        hex: "4",
      }),
      evidence_atom_ids: [`p05a_${"3".repeat(64)}`],
      change_reason_codes: ["initial_constructor"],
      changed_fields: [],
      created_at: "2026-09-22T00:00:00.000Z",
    },
    "revision_sha256"
  );
  const finalRevisionRef = persist(artifacts, {
    runId: "run-p05",
    phase: "SCA-P05",
    kind: "sca-p05-hypothesis-revision",
    operationId: `sca-p05-${hypothesisId}-revision-1`,
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-hypothesis-revision.v1",
    value: revision,
  });
  const p05TransitionRef = placeholder({
    runId: "run-p05",
    phase: "SCA-P05",
    kind: "sca-p05-to-p06-transition",
    schema: "penny.sca-p05-to-p06-transition.v1",
    hex: "6",
  });
  const modes = [
    {
      action_kind: "source_query" as const,
      authority_id: "auth-source",
      decision: "approved" as const,
      reason_code: "approved_source",
      scope: "p06_decision_only_not_p07_execution_authority" as const,
    },
    {
      action_kind: "graph_query" as const,
      authority_id: "auth-graph",
      decision: "approved" as const,
      reason_code: "approved_graph",
      scope: "p06_decision_only_not_p07_execution_authority" as const,
    },
    {
      action_kind: "application_test" as const,
      authority_id: "auth-app",
      decision: "denied" as const,
      reason_code: "denied_app",
      scope: "p06_decision_only_not_p07_execution_authority" as const,
    },
  ] as const;
  const profiles = [
    {
      action_kind: "source_query" as const,
      profile_id: "resource-source",
      timeout_ms: 1000,
      max_output_bytes: 1000,
      max_result_items: 10,
      max_selectors: 2,
      scope: "p06_decision_only_not_p07_execution_budget" as const,
    },
    {
      action_kind: "graph_query" as const,
      profile_id: "resource-graph",
      timeout_ms: 1000,
      max_output_bytes: 1000,
      max_result_items: 10,
      max_selectors: 2,
      scope: "p06_decision_only_not_p07_execution_budget" as const,
    },
    {
      action_kind: "application_test" as const,
      profile_id: "resource-app",
      timeout_ms: 1000,
      max_output_bytes: 1000,
      max_result_items: 10,
      max_selectors: 2,
      scope: "p06_decision_only_not_p07_execution_budget" as const,
    },
  ] as const;
  const implementationRef = placeholder({
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-implementation-identity",
    schema: "penny.sca-p06-implementation-identity.v1",
    hex: "7",
  });
  const runtimeRef = placeholder({
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-runtime-policy",
    schema: "penny.sca-p06-runtime-policy.v1",
    hex: "8",
  });
  const authority = validateScaP06ActionAuthorityV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: "tenant",
        project_id: "project",
        run_id: runId,
        phase_id: "SCA-P06" as const,
        source_snapshot_sha256: sourceRef.content_digest,
        p05_transition_ref: p05TransitionRef,
        hypothesis_authorities: [
          { hypothesis_id: hypothesisId, final_revision_ref: finalRevisionRef, modes },
        ],
        issued_at: "2026-09-22T00:00:00.000Z",
      },
      "authority_sha256"
    )
  );
  const authorityRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-action-authority",
    operationId: "sca-p06-action-authority",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
    value: authority,
  });
  const resourcePolicy = validateScaP06ResourcePolicyV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P06" as const,
        policy_id: "p06-resource-policy-test",
        source_snapshot_sha256: sourceRef.content_digest,
        p05_transition_ref: p05TransitionRef,
        profiles,
        status: "approved" as const,
      },
      "policy_sha256"
    )
  );
  const resourceRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-resource-policy",
    operationId: "sca-p06-resource-policy",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
    value: resourcePolicy,
  });
  const disclosureAuthorityRef = placeholder({
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-disclosure-authority",
    schema: "penny.sca-p06-disclosure-authority.v1",
    hex: "b",
  });
  const disclosureScope = validateScaP06DisclosureScopeV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P06" as const,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        p05_transition_ref: p05TransitionRef,
        required_model: SCA_P06_REQUIRED_MODEL,
        destination_class: "cloud" as const,
        purpose: "p06_least_consequential_evidence_decision" as const,
        allowed_data_classes: [
          "p05_hypothesis_revisions",
          "p06_authority_resource_projections",
        ] as const,
        revision_permissions: [
          {
            hypothesis_id: hypothesisId,
            revision_ref: finalRevisionRef,
            revision_sha256: revision.revision_sha256,
            body_sha256: revision.body_sha256,
            allowed: true as const,
          },
        ],
        action_authority_ref: authorityRef,
        resource_policy_ref: resourceRef,
        provider_retention_status: "known" as const,
        provider_retention_days: 0,
        provider_logging_status: "disabled" as const,
        provider_logging_days: 0,
        provider_training_use: "prohibited" as const,
        max_payload_bytes_per_call: 700_000,
        max_provider_calls: 1 as const,
        authority_ref: disclosureAuthorityRef,
        decision: "allow" as const,
        blocker_codes: [],
      },
      "scope_sha256"
    )
  );
  const scopeRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-disclosure-scope",
    operationId: "sca-p06-disclosure-scope",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
    value: disclosureScope,
  });
  const request = withP06SelfDigest(
    {
      schema_id: SCA_P06_REQUEST_V1_SCHEMA,
      schema_version: 1 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: runId,
      phase_id: "SCA-P06" as const,
      p05_transition_ref: p05TransitionRef,
      implementation_identity_ref: implementationRef,
      runtime_policy_ref: runtimeRef,
      action_authority_ref: authorityRef,
      resource_policy_ref: resourceRef,
      disclosure_scope_ref: scopeRef,
      requested_at: "2026-09-22T00:00:00.000Z",
    },
    "request_sha256"
  );
  const requestRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-request",
    operationId: "sca-p06-request",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_REQUEST_V1_SCHEMA,
    value: request,
  });
  const p05GateRef = placeholder({
    runId: "run-p05",
    phase: "SCA-P05",
    kind: "sca-p05-gate",
    schema: "penny.sca-p05-gate.v1",
    hex: "c",
  });
  const p05LedgerRef = placeholder({
    runId: "run-p05",
    phase: "SCA-P05",
    kind: "sca-p05-successor-ledger",
    schema: "penny.sca-p05-successor-ledger.v1",
    hex: "d",
  });
  const p05TraceRef = placeholder({
    runId: "run-p05",
    phase: "SCA-P05",
    kind: "sca-p05-traceability",
    schema: "penny.sca-p05-traceability.v1",
    hex: "e",
  });
  const p05ManifestRef = placeholder({
    runId: "run-p05",
    phase: "SCA-P05",
    kind: "sca-p05-evidence-manifest",
    schema: "penny.sca-p05-evidence-manifest.v1",
    hex: "f",
  });
  const accepted = validateScaP06AcceptedCohortV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_ACCEPTED_COHORT_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P06" as const,
        run_id: runId,
        p06_request_ref: requestRef,
        p05_transition_ref: p05TransitionRef,
        p05_gate_ref: p05GateRef,
        p05_successor_ledger_ref: p05LedgerRef,
        p05_traceability_ref: p05TraceRef,
        p05_evidence_manifest_ref: p05ManifestRef,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        active_hypothesis_ids: [hypothesisId],
        refuted_hypothesis_ids: [],
        final_hypotheses: [
          {
            hypothesis_id: hypothesisId,
            selected_item_id: selectedItemId,
            final_revision_ref: finalRevisionRef,
            revision: 1 as const,
            revision_sha256: revision.revision_sha256,
            body_sha256: revision.body_sha256,
          },
        ],
        runtime_policy_ref: runtimeRef,
        action_authority_ref: authorityRef,
        resource_policy_ref: resourceRef,
        disclosure_scope_ref: scopeRef,
        admitted_at: "2026-09-22T00:00:00.000Z",
      },
      "cohort_sha256"
    )
  );
  const acceptedRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-accepted-cohort",
    operationId: "sca-p06-accepted-cohort",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_ACCEPTED_COHORT_V1_SCHEMA,
    value: accepted,
  });
  const base = validateScaP06ObligationRevisionV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_OBLIGATION_REVISION_V1_SCHEMA,
        schema_version: 1 as const,
        obligation_id: scaP06BaseObligationId(hypothesisId),
        revision: 1 as const,
        parent_revision_ref: null,
        parent_revision_sha256: null,
        discovery_reassessment_ref: null,
        discovery_reassessment_sha256: null,
        hypothesis_id: hypothesisId,
        final_hypothesis_revision_ref: finalRevisionRef,
        class: "required-result" as const,
        purpose: body.next_evidence_need.question,
        source_mandate:
          "Use only the immutable accepted P05 revision and its cited P05/source evidence.",
        assigning_authority: "host_from_accepted_p05_hypothesis" as const,
        rationale: body.next_evidence_need.discriminating_result,
        supporting_observable_ids: [
          first(body.expected_refuting_observations, "P05 refuting observable").observable_id,
          first(body.expected_supporting_observations, "P05 supporting observable").observable_id,
        ].sort(),
        registered_before_action: true as const,
        status: "pending" as const,
        created_at: "2026-09-22T00:00:00.000Z",
      },
      "revision_sha256"
    )
  );
  const baseRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-obligation-revision",
    operationId: `sca-p06-${hypothesisId}-base-obligation`,
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_OBLIGATION_REVISION_V1_SCHEMA,
    value: base,
  });
  const payload = validateScaP06CognitivePayloadV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P06" as const,
        call_id: "sca-p06-evidence-action-decision" as const,
        role: "evidence_action_decider" as const,
        purpose: "p06_least_consequential_evidence_decision" as const,
        required_model: SCA_P06_REQUIRED_MODEL,
        accepted_cohort_ref: acceptedRef,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        p05_transition_ref: p05TransitionRef,
        assigned_hypothesis_ids: [hypothesisId],
        items: [
          {
            hypothesis_id: hypothesisId,
            selected_item_id: selectedItemId,
            final_revision_ref: finalRevisionRef,
            revision: 1 as const,
            revision_sha256: revision.revision_sha256,
            body_sha256: revision.body_sha256,
            hypothesis: body,
            base_obligation_ref: baseRef,
            base_obligation_id: base.obligation_id,
            authority: { hypothesis_id: hypothesisId, final_revision_ref: finalRevisionRef, modes },
            resource_profiles: profiles,
            child_integration: {
              status: "unavailable" as const,
              compatible_capability_ids: [] as const,
              mandatory_invocation: false as const,
              reason_code: "no_admitted_compatible_child_integration" as const,
            },
          },
        ],
        action_authority_ref: authorityRef,
        resource_policy_ref: resourceRef,
        disclosure_scope_ref: scopeRef,
        content_mode: "final_p05_hypotheses_and_minimized_policy_projections" as const,
      },
      "payload_sha256"
    )
  );
  const payloadRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-cognitive-payload",
    operationId: "sca-p06-evidence-action-payload",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
    value: payload,
  });
  const disclosure = validateScaP06DisclosureAdmissionV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P06" as const,
        call_id: "sca-p06-evidence-action-decision" as const,
        role: "evidence_action_decider" as const,
        purpose: "p06_least_consequential_evidence_decision" as const,
        required_model: SCA_P06_REQUIRED_MODEL,
        disclosure_scope_ref: scopeRef,
        disclosure_scope_sha256: disclosureScope.scope_sha256,
        payload_ref: payloadRef,
        payload_sha256: payloadRef.content_digest,
        payload_byte_length: payloadRef.byte_length,
        serialized_opening_byte_limit: 700_000,
        authorized_revision_refs: [finalRevisionRef],
        action_authority_ref: authorityRef,
        resource_policy_ref: resourceRef,
        destination: "cloud" as const,
        retention_days: 0,
        logging_status: "disabled" as const,
        logging_days: 0,
        training: "prohibited" as const,
        secrets_embedded: false as const,
        personal_data_embedded: false as const,
        decision: "allow" as const,
        blocker_codes: [],
        evaluated_before_dispatch: true as const,
      },
      "admission_sha256"
    )
  );
  const disclosureRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-disclosure-admission",
    operationId: "sca-p06-evidence-action-disclosure",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
    value: disclosure,
  });
  p06AdmissionState.value = {
    predecessor: { final_revisions: [revision] },
    disclosure_scope: disclosureScope,
    action_authority: authority,
    resource_policy: resourcePolicy,
  };
  return {
    hypothesisId,
    body,
    revision,
    disclosureScope,
    authority,
    resourcePolicy,
    requestRef,
    acceptedRef,
    payload,
    payloadRef,
    authorityRef,
    resourceRef,
    scopeRef,
    disclosureRef,
    baseRef,
  };
}

function context(runId: string, refs: readonly ArtifactRef[]): RunContext {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: "sca-p06-candidate",
      engine_owner: "typescript",
    },
    goal: "Exercise inactive P06.",
    constraints: {},
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 4,
    initialArtifacts: refs,
  });
}
function result(payload: ScaP06CognitivePayloadV1, noAuthority = false) {
  const item = first(payload.items, "P06 payload item");
  const observables = [
    ...item.hypothesis.expected_supporting_observations,
    ...item.hypothesis.expected_refuting_observations,
  ].sort((left, right) => left.observable_id.localeCompare(right.observable_id));
  return {
    schema_id: SCA_P06_DECISION_RESULT_V1_SCHEMA,
    schema_version: 1,
    role: "evidence_action_decider",
    payload_sha256: payload.payload_sha256,
    assigned_hypothesis_ids: [item.hypothesis_id],
    items: [
      {
        hypothesis_id: item.hypothesis_id,
        final_revision_sha256: item.revision_sha256,
        exact_question: item.hypothesis.next_evidence_need.question,
        considered_alternatives: [
          {
            action_kind: "source_query",
            evidence_mode: "source",
            consequence_rank: 1,
            capability: "capable",
            authority_decision: noAuthority ? "denied" : "approved",
            authority_id: "auth-source",
            resource_profile_id: "resource-source",
            expected_information_gain: "Exact source can answer the question.",
            rationale: "It is least consequential.",
          },
          {
            action_kind: "graph_query",
            evidence_mode: "graph",
            consequence_rank: 2,
            capability: "capable",
            authority_decision: noAuthority ? "denied" : "approved",
            authority_id: "auth-graph",
            resource_profile_id: "resource-graph",
            expected_information_gain: "Graph can establish domination.",
            rationale: "Use only if source is insufficient.",
          },
          {
            action_kind: "application_test",
            evidence_mode: "application",
            consequence_rank: 3,
            capability: "incapable",
            authority_decision: "denied",
            authority_id: "auth-app",
            resource_profile_id: "resource-app",
            expected_information_gain: "Runtime could show one path.",
            rationale: "It is not authorized.",
          },
        ],
        discriminating_observable: {
          observable_ids: observables.map((entry) => entry.observable_id),
          observable_records: observables,
          target: item.hypothesis.next_evidence_need.target,
          expected_change_to_judgment: item.hypothesis.next_evidence_need.discriminating_result,
        },
        material_obligation_discovery: null,
        effective_obligation_id: item.base_obligation_id,
        effective_obligation_class: "required-result",
        decision_classification: noAuthority ? "no_authorized_action" : "source_sufficient",
        selected_action: noAuthority
          ? {
              action_kind: "none",
              evidence_mode: "none",
              target: null,
              rationale: "No capable mode is authorized.",
              authority_id: null,
              resource_profile_id: null,
              execution_status: "not_invoked",
              p07_execution_claimed: false,
            }
          : {
              action_kind: "source_query",
              evidence_mode: "source",
              target: "guard and operation",
              rationale: "Inspect exact source first.",
              authority_id: "auth-source",
              resource_profile_id: "resource-source",
              execution_status: "not_invoked",
              p07_execution_claimed: false,
            },
        stopping_rule: item.hypothesis.stopping_conditions,
        child_use: {
          status: "not_invoked",
          capability_id: null,
          invocation_ref: null,
          reason_code: "not_required_for_decision",
        },
        p07_execution_status: "not_started",
        vulnerability_adjudication: "not_performed",
        report_or_release_claimed: false,
      },
    ],
    complete: true,
  };
}
function persistWorkerEvidence(
  artifacts: ArtifactStore,
  runId: string,
  directive: Extract<Directive, { action: "invoke_agent" }>,
  details: unknown,
  options: { readonly guardStateId?: string } = {}
): ArtifactRef {
  const output = artifacts.persist({
    metadata: directive.output_artifact,
    content: `SUMMARY:${canonicalJson(details)}`,
  });
  const coordinate = {
    run_id: runId,
    state_id: directive.state_id,
    branch_id: null,
    agent: directive.agent,
    attempt: directive.attempt,
  };
  const guard = persist(artifacts, {
    runId,
    phase: directive.state_id,
    kind: "model-dispatch-guard",
    operationId: modelDispatchGuardOperationId(coordinate),
    producer: "host:required-model-runtime",
    schemaId: MODEL_DISPATCH_GUARD_V1_SCHEMA,
    value: {
      schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA,
      schema_version: 1,
      coordinate: {
        ...coordinate,
        state_id: options.guardStateId ?? coordinate.state_id,
      },
      registration_sha256: "3".repeat(64),
      requested_model: SCA_P06_REQUIRED_MODEL,
      input_artifacts_sha256: sha256(canonicalJson(directive.input_artifacts)),
      serialized_opening_sha256: "4".repeat(64),
      serialized_opening_byte_length: 100,
      provider_opening_guard: "sca_p06_payload_disclosure_v1",
      guarded_at: "2026-09-22T00:00:01.000Z",
    },
  });
  const receiptBody = {
    schema_version: 2 as const,
    receipt_id: "receipt-p06",
    run_id: runId,
    state_id: directive.state_id,
    branch_id: null,
    agent: directive.agent,
    attempt: directive.attempt,
    worker_id: "worker-p06",
    executor: "pi-sdk" as const,
    command: ["pi-sdk", directive.agent],
    model: SCA_P06_REQUIRED_MODEL.override,
    requested_model: SCA_P06_REQUIRED_MODEL,
    observed_model: {
      provider: SCA_P06_REQUIRED_MODEL.provider,
      model: SCA_P06_REQUIRED_MODEL.model,
    },
    working_directory: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
    started_at: "2026-09-22T00:00:01.000Z",
    ended_at: "2026-09-22T00:00:02.000Z",
    exit_code: 0,
    output_digest: output.content_digest,
    output_artifact_ref: output,
    trusted_invocation_digest: trustedInvocationDigest({
      identity: directive.identity,
      state_id: directive.state_id,
      branch_id: null,
      agent: directive.agent,
      attempt: directive.attempt,
      trust_profile: directive.trust_profile,
      model_override: directive.model_override ?? null,
      task_sha256: sha256(directive.task),
      input_artifacts: directive.input_artifacts,
      output_artifact: directive.output_artifact,
    }),
  };
  const executionReceipt = validateContract(
    ExecutionReceiptSchema,
    { ...receiptBody, signature: `hmac-sha256:${"9".repeat(64)}` },
    "P06 test receipt"
  );
  persist(artifacts, {
    runId,
    phase: directive.state_id,
    kind: "model-execution-receipt",
    operationId: modelExecutionReceiptOperationId(coordinate),
    producer: "host:required-model-runtime",
    schemaId: MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
    value: {
      schema_id: MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      dispatch_guard_ref: guard,
      execution_receipt: executionReceipt,
    },
  });
  artifacts.select(output);
  return output;
}

function persistGuardOnly(
  artifacts: ArtifactStore,
  runId: string,
  directive: Extract<Directive, { action: "invoke_agent" }>
): ArtifactRef {
  const coordinate = {
    run_id: runId,
    state_id: directive.state_id,
    branch_id: null,
    agent: directive.agent,
    attempt: directive.attempt,
  };
  return persist(artifacts, {
    runId,
    phase: directive.state_id,
    kind: "model-dispatch-guard",
    operationId: modelDispatchGuardOperationId(coordinate),
    producer: "host:required-model-runtime",
    schemaId: MODEL_DISPATCH_GUARD_V1_SCHEMA,
    value: {
      schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA,
      schema_version: 1,
      coordinate,
      registration_sha256: "3".repeat(64),
      requested_model: SCA_P06_REQUIRED_MODEL,
      input_artifacts_sha256: sha256(canonicalJson(directive.input_artifacts)),
      serialized_opening_sha256: "4".repeat(64),
      serialized_opening_byte_length: 100,
      provider_opening_guard: "sca_p06_payload_disclosure_v1",
      guarded_at: "2026-09-22T00:00:01.000Z",
    },
  });
}

describe("SCA P06 deterministic finalization", () => {
  it("creates exhaustive action records and a non-executing P07 decision handoff", () => {
    using artifacts = store();
    const runId = "run-p06-positive";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(
      artifacts,
      () => new Date("2026-09-22T00:00:03.000Z")
    );
    const directive = playbook.initialize(run);
    if (directive.action !== "invoke_agent") throw new Error("expected P06 model directive");
    const details = result(built.payload);
    const output = persistWorkerEvidence(artifacts, runId, directive, details);
    run.selectedArtifacts.push(output);
    const terminalDirective = playbook.acceptSummary(run, details, "CERTAIN");
    if (terminalDirective.action !== "incomplete")
      throw new Error("expected nonterminal P06 output");
    const terminal = validateScaP06TerminalV1(terminalDirective.result);
    expect(terminal.status).toBe("candidate_complete");
    expect(terminal.p07_execution_occurred).toBe(false);
    expect(terminal.p07_transition_ref).not.toBeNull();
    const transition = validateScaP06ToP07TransitionV1(
      JSON.parse(
        artifacts.read(required(terminal.p07_transition_ref, "P07 transition ref")).toString("utf8")
      )
    );
    expect(transition.p07_execution_authorized_by_this_transition).toBe(false);
    const actionRef = run.selectedArtifacts.find((ref) => ref.kind === "sca-p06-action-record");
    expect(actionRef).toBeDefined();
    const action = validateScaP06ActionRecordV1(
      JSON.parse(artifacts.read(required(actionRef, "P06 action ref")).toString("utf8"))
    );
    expect(action.selected_action.execution_status).toBe("not_invoked");
    const traceRef = run.selectedArtifacts.find((ref) => ref.kind === "sca-p06-traceability");
    expect(
      validateScaP06TraceabilityV1(
        JSON.parse(artifacts.read(required(traceRef, "P06 traceability ref")).toString("utf8"))
      ).exhaustive
    ).toBe(true);
  });

  it("registers a later-discovered material obligation before the action record relies on it", () => {
    using artifacts = store();
    const runId = "run-p06-material-obligation";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(
      artifacts,
      () => new Date("2026-09-22T00:00:03.000Z")
    );
    const directive = playbook.initialize(run);
    if (directive.action !== "invoke_agent") throw new Error("expected P06 model directive");
    const base = result(built.payload);
    const materialId = `p06obl_${built.hypothesisId.slice("p05h_".length)}_material_0001`;
    const details = {
      ...base,
      items: base.items.map((item) => ({
        ...item,
        material_obligation_discovery: {
          obligation_id: materialId,
          purpose: built.body.next_evidence_need.question,
          source_mandate:
            "Use only the immutable accepted P05 revision and its cited P05/source evidence.",
          rationale: "It changes which evidence can discriminate the claim.",
          supporting_observable_ids: [
            first(built.body.expected_supporting_observations, "P05 supporting observable")
              .observable_id,
          ],
          scope_effect: "within_exact_p05_hypothesis",
          effective_class: "required-result",
        },
        effective_obligation_id: materialId,
      })),
    };
    const output = persistWorkerEvidence(artifacts, runId, directive, details);
    run.selectedArtifacts.push(output);
    const terminalDirective = playbook.acceptSummary(run, details, "PROBABLE");
    if (terminalDirective.action !== "incomplete") throw new Error("expected P06 terminal");
    const reassessmentRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p06-discovery-reassessment"),
      "P06 discovery reassessment ref"
    );
    const reassessment = validateScaP06DiscoveryReassessmentV1(
      JSON.parse(artifacts.read(reassessmentRef).toString("utf8"))
    );
    expect(reassessment.host_decision).toBe("allow");
    const materialRef = required(
      run.selectedArtifacts.find(
        (ref) =>
          ref.kind === "sca-p06-obligation-revision" &&
          ref.operation_id.endsWith("-material-obligation")
      ),
      "P06 material obligation ref"
    );
    const material = validateScaP06ObligationRevisionV1(
      JSON.parse(artifacts.read(materialRef).toString("utf8"))
    );
    expect(material.parent_revision_ref).toEqual(built.baseRef);
    expect(material.discovery_reassessment_ref).toEqual(reassessmentRef);
    expect(material.rationale).toBe(
      "Closed host reassessment allowed the bounded discovery under exact P05 lineage and policy bindings."
    );
    expect(material.rationale).not.toBe(
      first(details.items, "P06 material decision").material_obligation_discovery?.rationale
    );
    const actionRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p06-action-record"),
      "P06 action ref"
    );
    const action = validateScaP06ActionRecordV1(
      JSON.parse(artifacts.read(actionRef).toString("utf8"))
    );
    expect(action.effective_obligation_id).toBe(materialId);
    expect(action.obligation_revision_ref).toEqual(materialRef);
    expect(action.discovery_reassessment_ref).toEqual(reassessmentRef);
    const selectedIds = run.selectedArtifacts.map((ref) => ref.artifact_id);
    expect(selectedIds.indexOf(reassessmentRef.artifact_id)).toBeLessThan(
      selectedIds.indexOf(materialRef.artifact_id)
    );
    expect(selectedIds.indexOf(materialRef.artifact_id)).toBeLessThan(
      selectedIds.indexOf(actionRef.artifact_id)
    );
    const terminal = validateScaP06TerminalV1(terminalDirective.result);
    const transition = validateScaP06ToP07TransitionV1(
      JSON.parse(
        artifacts.read(required(terminal.p07_transition_ref, "P06 transition ref")).toString("utf8")
      )
    );
    expect(transition.discovery_reassessment_refs).toEqual([reassessmentRef]);
    const gateRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p06-gate"),
      "P06 gate ref"
    );
    expect(
      validateScaP06GateV1(JSON.parse(artifacts.read(gateRef).toString("utf8")))
        .discovery_reassessment_refs
    ).toEqual([reassessmentRef]);
    const ledgerRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p06-successor-ledger"),
      "P06 ledger ref"
    );
    expect(
      first(
        validateScaP06SuccessorLedgerV1(JSON.parse(artifacts.read(ledgerRef).toString("utf8")))
          .evidence_obligations,
        "P06 ledger obligation"
      ).discovery_reassessment_ref
    ).toEqual(reassessmentRef);
    const restored = RunContext.fromSnapshot(run.snapshot());
    expect(
      restored.selectedArtifacts.some((ref) => ref.artifact_id === materialRef.artifact_id)
    ).toBe(true);

    const decision = first(
      validateScaP06DecisionResultAgainstPayload(details, built.payload).items,
      "P06 material decision"
    );
    const baseObligation = validateScaP06ObligationRevisionV1(
      JSON.parse(artifacts.read(built.baseRef).toString("utf8"))
    );
    const validationContext = {
      decision,
      payload: built.payload,
      payload_ref: built.payloadRef,
      model_output_ref: output,
      base_obligation: baseObligation,
      base_obligation_ref: built.baseRef,
      final_revision: built.revision,
      disclosure_scope: built.disclosureScope,
      action_authority: built.authority,
      resource_policy: built.resourcePolicy,
    };
    const { reassessment_sha256: _reassessmentDigest, ...reassessmentBody } = reassessment;
    const mutants = [
      { ...reassessmentBody, base_obligation_revision_sha256: "0".repeat(64) },
      {
        ...reassessmentBody,
        base_obligation_ref: actionRef,
        promotion_chain_refs: [actionRef],
      },
      { ...reassessmentBody, final_hypothesis_body_sha256: "0".repeat(64) },
      {
        ...reassessmentBody,
        action_authority_ref: built.resourceRef,
        action_authority_sha256: built.resourcePolicy.policy_sha256,
      },
      {
        ...reassessmentBody,
        scope_result: "scope_expansion_denied",
        host_decision: "deny",
        blocker_codes: ["p06_material_discovery_scope_expansion"],
      },
    ];
    for (const mutant of mutants) {
      expect(() =>
        validateScaP06DiscoveryReassessmentAgainstContext(
          withP06SelfDigest(mutant, "reassessment_sha256"),
          validationContext
        )
      ).toThrow();
    }
  });

  it("denies a scope-expanding discovery before promotion, action, or P07 handoff", () => {
    using artifacts = store();
    const runId = "run-p06-denied-discovery";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(
      artifacts,
      () => new Date("2026-09-22T00:00:03.000Z")
    );
    const directive = playbook.initialize(run);
    if (directive.action !== "invoke_agent") throw new Error("expected P06 model directive");
    const base = result(built.payload);
    const materialId = `p06obl_${built.hypothesisId.slice("p05h_".length)}_material_0001`;
    const details = {
      ...base,
      items: base.items.map((item) => ({
        ...item,
        material_obligation_discovery: {
          obligation_id: materialId,
          purpose: "An expanded purpose not admitted by exact P05.",
          source_mandate: "Use evidence beyond the exact admitted P05 scope.",
          rationale: "The model proposes broader work.",
          supporting_observable_ids: [
            first(built.body.expected_supporting_observations, "P05 supporting observable")
              .observable_id,
          ],
          scope_effect: "expands_beyond_exact_p05_hypothesis",
          effective_class: "required-result",
        },
        effective_obligation_id: materialId,
      })),
    };
    const output = persistWorkerEvidence(artifacts, runId, directive, details);
    run.selectedArtifacts.push(output);
    const terminalDirective = playbook.acceptSummary(run, details, "PROBABLE");
    if (terminalDirective.action !== "incomplete") throw new Error("expected blocked P06 output");
    const terminal = validateScaP06TerminalV1(terminalDirective.result);
    expect(terminal.status).toBe("blocked");
    expect(terminal.p07_transition_ref).toBeNull();
    const reassessmentRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p06-discovery-reassessment"),
      "P06 denied reassessment ref"
    );
    const reassessment = validateScaP06DiscoveryReassessmentV1(
      JSON.parse(artifacts.read(reassessmentRef).toString("utf8"))
    );
    expect(reassessment.host_decision).toBe("deny");
    expect(reassessment.blocker_codes).toContain("p06_material_discovery_scope_expansion");
    expect(
      run.selectedArtifacts.some(
        (ref) =>
          ref.kind === "sca-p06-obligation-revision" &&
          ref.operation_id.endsWith("-material-obligation")
      )
    ).toBe(false);
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p06-action-record")).toBe(false);
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p06-checkpoint")).toBe(true);
  });

  it("checkpoints malformed semantic output without retry or P07 transition", () => {
    using artifacts = store();
    const runId = "run-p06-malformed";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(
      artifacts,
      () => new Date("2026-09-22T00:00:03.000Z")
    );
    const directive = playbook.initialize(run);
    if (directive.action !== "invoke_agent") throw new Error("expected P06 model directive");
    const malformed = { ...result(built.payload), payload_sha256: "0".repeat(64) };
    const output = persistWorkerEvidence(artifacts, runId, directive, malformed);
    run.selectedArtifacts.push(output);
    const terminalDirective = playbook.acceptSummary(run, malformed, "UNCERTAIN");
    if (terminalDirective.action !== "incomplete") throw new Error("expected blocked P06 output");
    const terminal = validateScaP06TerminalV1(terminalDirective.result);
    expect(terminal.status).toBe("blocked");
    expect(terminal.p07_transition_ref).toBeNull();
    const gateRef = run.selectedArtifacts.find((ref) => ref.kind === "sca-p06-gate");
    expect(
      validateScaP06GateV1(
        JSON.parse(artifacts.read(required(gateRef, "P06 gate ref")).toString("utf8"))
      ).verdict
    ).toBe("blocked_invalid");
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p06-checkpoint")).toBe(true);
    const restored = RunContext.fromSnapshot(run.snapshot());
    expect(playbook.rebindPendingDirective(restored)).toEqual(terminalDirective);
  });

  it("records a valid no-authority decision but blocks the P07 handoff", () => {
    using artifacts = store();
    const runId = "run-p06-no-authority";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(
      artifacts,
      () => new Date("2026-09-22T00:00:03.000Z")
    );
    const directive = playbook.initialize(run);
    if (directive.action !== "invoke_agent") throw new Error("expected P06 model directive");
    const details = result(built.payload, true);
    // The host payload remains authoritative, so mirror only the policy decisions in the result.
    const hostCompatible = {
      ...details,
      items: details.items.map((item) => ({
        ...item,
        considered_alternatives: item.considered_alternatives.map((entry) => ({
          ...entry,
          authority_decision: entry.action_kind === "application_test" ? "denied" : "approved",
          capability: entry.action_kind === "application_test" ? "capable" : "incapable",
        })),
      })),
    };
    const output = persistWorkerEvidence(artifacts, runId, directive, hostCompatible);
    run.selectedArtifacts.push(output);
    const terminalDirective = playbook.acceptSummary(run, hostCompatible, "PROBABLE");
    if (terminalDirective.action !== "incomplete") throw new Error("expected blocked P06 output");
    const terminal = validateScaP06TerminalV1(terminalDirective.result);
    expect(terminal.status).toBe("blocked");
    expect(terminal.p07_transition_ref).toBeNull();
    const gateRef = run.selectedArtifacts.find((ref) => ref.kind === "sca-p06-gate");
    expect(
      validateScaP06GateV1(
        JSON.parse(artifacts.read(required(gateRef, "P06 gate ref")).toString("utf8"))
      ).verdict
    ).toBe("pass_blocked");
  });
});

describe("SCA P06 restart and dispatch fencing", () => {
  it("rebinds a clean pending dispatch without changing its exact directive", () => {
    using artifacts = store();
    const runId = "run-p06-clean-rebind";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(artifacts);
    const pending = playbook.initialize(run);
    if (pending.action !== "invoke_agent") throw new Error("expected P06 model directive");
    const restored = RunContext.fromSnapshot(run.snapshot());
    expect(playbook.rebindPendingDirective(restored)).toEqual(pending);
  });

  it("quarantines remote-unknown dispatch across restart without replay", () => {
    using artifacts = store();
    const runId = "run-p06-remote-unknown";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(artifacts);
    const pending = playbook.initialize(run);
    if (pending.action !== "invoke_agent") throw new Error("expected P06 model directive");
    persistGuardOnly(artifacts, runId, pending);
    const restored = RunContext.fromSnapshot(run.snapshot());
    const rebound = playbook.rebindPendingDirective(restored);
    expect(rebound?.action).toBe("cancelled");
    if (rebound?.action !== "cancelled") throw new Error("expected cancelled P06 dispatch");
    expect(rebound.unresolved).toContain("p06_remote_unknown_quarantined");
    expect(playbook.rebindPendingDirective(restored)).toEqual(rebound);
    expect(restored.selectedArtifacts.some((ref) => ref.kind === "sca-p06-decision-output")).toBe(
      false
    );
  });

  it("quarantines a complete-but-uncommitted outcome across restart without accepting it", () => {
    using artifacts = store();
    const runId = "run-p06-complete-uncommitted";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(artifacts);
    const pending = playbook.initialize(run);
    if (pending.action !== "invoke_agent") throw new Error("expected P06 model directive");
    const output = persistWorkerEvidence(artifacts, runId, pending, result(built.payload));
    run.selectedArtifacts.push(output);
    const restored = RunContext.fromSnapshot(run.snapshot());
    const rebound = playbook.rebindPendingDirective(restored);
    expect(rebound?.action).toBe("cancelled");
    if (rebound?.action !== "cancelled") throw new Error("expected cancelled P06 outcome");
    expect(rebound.unresolved).toContain("p06_uncommitted_outcome_quarantined");
    expect(playbook.rebindPendingDirective(restored)).toEqual(rebound);
    expect(restored.selectedArtifacts.some((ref) => ref.kind === "sca-p06-action-record")).toBe(
      false
    );
  });

  it("checkpoints stale dispatch coordinates and refuses a P07 transition", () => {
    using artifacts = store();
    const runId = "run-p06-stale-coordinate";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(artifacts);
    const pending = playbook.initialize(run);
    if (pending.action !== "invoke_agent") throw new Error("expected P06 model directive");
    const details = result(built.payload);
    const output = persistWorkerEvidence(artifacts, runId, pending, details, {
      guardStateId: "stale-selecting-evidence-actions",
    });
    run.selectedArtifacts.push(output);
    const completed = playbook.acceptSummary(run, details, "CERTAIN");
    if (completed.action !== "incomplete") throw new Error("expected blocked P06 terminal");
    const terminal = validateScaP06TerminalV1(completed.result);
    expect(terminal.status).toBe("blocked");
    expect(terminal.p07_transition_ref).toBeNull();
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p06-checkpoint")).toBe(true);
  });

  it("rejects conflicting duplicate output coordinates", () => {
    using artifacts = store();
    const runId = "run-p06-duplicate-output";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.acceptedRef,
      built.payloadRef,
      built.disclosureRef,
      built.baseRef,
    ]);
    const playbook = new ScaP06CandidatePlaybook(artifacts);
    const pending = playbook.initialize(run);
    if (pending.action !== "invoke_agent") throw new Error("expected P06 model directive");
    persistWorkerEvidence(artifacts, runId, pending, result(built.payload));
    expect(() =>
      artifacts.persist({
        metadata: pending.output_artifact,
        content: 'SUMMARY:{"conflicting":true}',
      })
    ).toThrow();
  });
});
