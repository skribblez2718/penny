import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import {
  SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
  SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P06_REQUIRED_MODEL,
  SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
  scaP06BaseObligationId,
  validateScaP06ActionAuthorityV1,
  validateScaP06CognitivePayloadV1,
  validateScaP06DisclosureAdmissionV1,
  validateScaP06DisclosureAuthorityV1,
  validateScaP06DisclosureScopeV1,
  validateScaP06ResourcePolicyV1,
  withP06SelfDigest,
} from "../dist/sca/p06-contracts.js";
import { withSelfDigest, type ScaP05HypothesisBodyV1 } from "../dist/sca/p05-contracts.js";

function first<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`${label} is absent`);
  return value;
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

export type ScaP06SmokeCase =
  | "source_sufficient"
  | "graph_needed"
  | "runtime_needed"
  | "no_authorized_action";

function hypothesis(
  hypothesisId: string,
  selectedItemId: string,
  smokeCase: ScaP06SmokeCase
): ScaP05HypothesisBodyV1 {
  const suffix = hypothesisId.slice("p05h_".length);
  const atomId = `p05a_${"3".repeat(64)}`;
  const evidenceMode =
    smokeCase === "graph_needed"
      ? ("graph" as const)
      : smokeCase === "runtime_needed"
        ? ("application" as const)
        : ("source" as const);
  const target =
    evidenceMode === "source"
      ? "the exact static guard declaration"
      : evidenceMode === "graph"
        ? "the complete guard-to-operation path relation"
        : "the bounded observed request outcome under runtime-dependent external state";
  const question =
    evidenceMode === "source"
      ? "What decision does the exact static guard declaration encode?"
      : evidenceMode === "graph"
        ? "Does the guard dominate every complete path to the protected operation?"
        : "Does the protected operation occur for the bounded request under admitted runtime-dependent external state that static source or graph evidence cannot determine?";
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
      explanation:
        evidenceMode === "source"
          ? "The exact declaration may reject the bounded input."
          : evidenceMode === "graph"
            ? "A guard may dominate all paths."
            : "Runtime-dependent external state may cause the guard to reject the bounded request.",
      discriminating_observation:
        evidenceMode === "source"
          ? "Inspect the exact static declaration."
          : evidenceMode === "graph"
            ? "Inspect exact domination."
            : "Execute the bounded admitted request and observe whether rejection precedes the protected operation.",
      evidence_atom_ids: [atomId],
    },
    expected_supporting_observations: [
      {
        observable_id: `p05o_${suffix}_supporting_0001`,
        observation:
          evidenceMode === "source"
            ? "The exact declaration permits the bounded input."
            : evidenceMode === "graph"
              ? "A complete bypassing path exists."
              : "The bounded request reaches the protected operation.",
        expected_if_claim: true,
        evidence_mode: evidenceMode,
        basis_atom_ids: [atomId],
      },
    ],
    expected_refuting_observations: [
      {
        observable_id: `p05o_${suffix}_refuting_0001`,
        observation:
          evidenceMode === "source"
            ? "The exact declaration rejects the bounded input."
            : evidenceMode === "graph"
              ? "The guard dominates every complete path."
              : "The bounded request is rejected before the protected operation.",
        expected_if_claim: false,
        evidence_mode: evidenceMode,
        basis_atom_ids: [atomId],
      },
    ],
    next_evidence_need: {
      question,
      evidence_mode: evidenceMode,
      target,
      discriminating_result:
        evidenceMode === "source"
          ? "The exact declaration either permits or rejects the bounded input."
          : evidenceMode === "graph"
            ? "A complete bypass exists or every complete path is dominated."
            : "The bounded request either reaches the operation or is rejected first.",
    },
    stopping_conditions: {
      supported:
        evidenceMode === "source"
          ? "Stop when the exact declaration permits the bounded input."
          : evidenceMode === "graph"
            ? "Stop on a complete bypass."
            : "Stop when the bounded admitted request reaches the protected operation.",
      refuted:
        evidenceMode === "source"
          ? "Stop when the exact declaration rejects the bounded input."
          : evidenceMode === "graph"
            ? "Stop on complete domination."
            : "Stop when the bounded admitted request is rejected before the protected operation.",
      inconclusive: "Stop when evidence cannot distinguish.",
    },
    reopening_conditions: [
      { trigger: "Source changes.", changed_basis_required: "A new snapshot." },
    ],
  };
}

export function createScaP06GuardFixture(
  artifacts: ArtifactStore,
  smokeCase: ScaP06SmokeCase = "source_sufficient"
) {
  const caseOrdinal: Record<ScaP06SmokeCase, string> = {
    source_sufficient: "01",
    graph_needed: "02",
    runtime_needed: "03",
    no_authorized_action: "04",
  };
  const runId = `run-p06-guard-case-${caseOrdinal[smokeCase]}`;
  const suffix = "a".repeat(64);
  const hypothesisId = `p05h_${suffix}`;
  const selectedItemId = `p04i_${suffix}`;
  const sourceRef = persist(artifacts, {
    runId: `${runId}-source`,
    phase: "SCA-P01",
    kind: "source-snapshot",
    operationId: "source-snapshot",
    producer: "host:test",
    schemaId: "penny.test-source.v1",
    value: { source: true },
  });
  const p05TransitionRef = persist(artifacts, {
    runId: `${runId}-p05`,
    phase: "SCA-P05",
    kind: "sca-p05-to-p06-transition",
    operationId: "sca-p05-to-p06-transition",
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-to-p06-transition.v1",
    value: { transition: true },
  });
  const body = hypothesis(hypothesisId, selectedItemId, smokeCase);
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
      p04_transition_ref: p05TransitionRef,
      cognitive_payload_ref: p05TransitionRef,
      model_output_ref: p05TransitionRef,
      evidence_atom_ids: [`p05a_${"3".repeat(64)}`],
      change_reason_codes: ["initial_constructor"],
      changed_fields: [],
      created_at: "2026-09-22T00:00:00.000Z",
    },
    "revision_sha256"
  );
  const revisionRef = persist(artifacts, {
    runId: `${runId}-p05`,
    phase: "SCA-P05",
    kind: "sca-p05-hypothesis-revision",
    operationId: "revision",
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-hypothesis-revision.v1",
    value: revision,
  });
  const cohortRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-accepted-cohort",
    operationId: "cohort",
    producer: "host:sca-p06-candidate",
    schemaId: "penny.sca-p06-accepted-cohort.v1",
    value: { cohort: true },
  });
  const baseObligationRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-obligation-revision",
    operationId: "base-obligation",
    producer: "host:sca-p06-candidate",
    schemaId: "penny.sca-p06-obligation-revision.v1",
    value: { obligation: true },
  });
  const actionAuthority = validateScaP06ActionAuthorityV1(
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
          {
            hypothesis_id: hypothesisId,
            final_revision_ref: revisionRef,
            modes: [
              {
                action_kind: "source_query" as const,
                authority_id: "auth-source",
                decision:
                  smokeCase === "no_authorized_action"
                    ? ("denied" as const)
                    : ("approved" as const),
                reason_code:
                  smokeCase === "no_authorized_action"
                    ? "denied_source_for_blinded_case"
                    : "approved_source",
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
                decision:
                  smokeCase === "runtime_needed" ? ("approved" as const) : ("denied" as const),
                reason_code: smokeCase === "runtime_needed" ? "approved_app" : "denied_app",
                scope: "p06_decision_only_not_p07_execution_authority" as const,
              },
            ],
          },
        ],
        issued_at: "2026-09-22T00:00:00.000Z",
      },
      "authority_sha256"
    )
  );
  const actionAuthorityRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-action-authority",
    operationId: "sca-p06-action-authority",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
    value: actionAuthority,
  });
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
  const resourcePolicy = validateScaP06ResourcePolicyV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P06" as const,
        policy_id: "p06-resource",
        source_snapshot_sha256: sourceRef.content_digest,
        p05_transition_ref: p05TransitionRef,
        profiles,
        status: "approved" as const,
      },
      "policy_sha256"
    )
  );
  const resourcePolicyRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-resource-policy",
    operationId: "sca-p06-resource-policy",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
    value: resourcePolicy,
  });
  const disclosureAuthority = validateScaP06DisclosureAuthorityV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: "tenant",
        project_id: "project",
        run_id: runId,
        phase_id: "SCA-P06" as const,
        source_snapshot_sha256: sourceRef.content_digest,
        required_model: SCA_P06_REQUIRED_MODEL,
        destination_class: "cloud" as const,
        purpose: "p06_least_consequential_evidence_decision" as const,
        allowed_data_classes: [
          "p05_hypothesis_revisions" as const,
          "p06_authority_resource_projections" as const,
        ],
        provider_retention_status: "known" as const,
        provider_retention_days: 0,
        provider_logging_status: "disabled" as const,
        provider_logging_days: 0,
        provider_training_use: "prohibited" as const,
        max_payload_bytes_per_call: 700_000,
        max_provider_calls: 1 as const,
        decision: "approved" as const,
        blocker_codes: [],
        issued_at: "2026-09-22T00:00:00.000Z",
      },
      "authority_sha256"
    )
  );
  const disclosureAuthorityRef = persist(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-disclosure-authority",
    operationId: "sca-p06-disclosure-authority",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA,
    value: disclosureAuthority,
  });
  const scope = validateScaP06DisclosureScopeV1(
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
          "p05_hypothesis_revisions" as const,
          "p06_authority_resource_projections" as const,
        ],
        revision_permissions: [
          {
            hypothesis_id: hypothesisId,
            revision_ref: revisionRef,
            revision_sha256: revision.revision_sha256,
            body_sha256: revision.body_sha256,
            allowed: true as const,
          },
        ],
        action_authority_ref: actionAuthorityRef,
        resource_policy_ref: resourcePolicyRef,
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
    operationId: "scope",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
    value: scope,
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
        accepted_cohort_ref: cohortRef,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        p05_transition_ref: p05TransitionRef,
        assigned_hypothesis_ids: [hypothesisId],
        items: [
          {
            hypothesis_id: hypothesisId,
            selected_item_id: selectedItemId,
            final_revision_ref: revisionRef,
            revision: 1 as const,
            revision_sha256: revision.revision_sha256,
            body_sha256: revision.body_sha256,
            hypothesis: body,
            base_obligation_ref: baseObligationRef,
            base_obligation_id: scaP06BaseObligationId(hypothesisId),
            authority: first(actionAuthority.hypothesis_authorities, "P06 hypothesis authority"),
            resource_profiles: resourcePolicy.profiles,
            child_integration: {
              status: "unavailable" as const,
              compatible_capability_ids: [] as const,
              mandatory_invocation: false as const,
              reason_code: "no_admitted_compatible_child_integration" as const,
            },
          },
        ],
        action_authority_ref: actionAuthorityRef,
        resource_policy_ref: resourcePolicyRef,
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
    operationId: "payload",
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
        disclosure_scope_sha256: scope.scope_sha256,
        payload_ref: payloadRef,
        payload_sha256: payloadRef.content_digest,
        payload_byte_length: payloadRef.byte_length,
        serialized_opening_byte_limit: 700_000,
        authorized_revision_refs: [revisionRef],
        action_authority_ref: actionAuthorityRef,
        resource_policy_ref: resourcePolicyRef,
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
    operationId: "disclosure",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
    value: disclosure,
  });
  const assignment = {
    registration_name: "sca-p06-candidate",
    run_id: runId,
    state_id: "selecting_evidence_actions",
    branch_id: null,
    agent: "demetri",
    task: "Choose the least-consequential evidence decision from the exact payload. Infer capability independently; preserve exact P05 semantics and policy bindings; do not execute any action.",
    input_artifacts: {
      schema_version: 2 as const,
      artifacts: [
        { slot: "cognitive_payload", ref: payloadRef },
        { slot: "disclosure_admission", ref: disclosureRef },
      ],
    },
  };
  return {
    runId,
    smokeCase,
    assignment,
    payload,
    payloadRef,
    disclosure,
    disclosureRef,
  };
}
