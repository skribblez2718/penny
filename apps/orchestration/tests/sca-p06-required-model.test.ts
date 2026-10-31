import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { SCA_PLAYBOOK_REGISTRATION } from "../dist/playbooks/sca.js";
import { SCA_REQUIRED_MODEL } from "../dist/sca/ordinary-model-guard.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, Directive } from "../dist/contracts.js";
import {
  buildAgentOpening,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
} from "../dist/model-client.js";
import { PLAYBOOK_REGISTRY, validateRegistrationContract } from "../dist/playbooks/registry.js";
import {
  PreDispatchPolicyDeniedError,
  SCA_P04_PROVIDER_OPENING_ADAPTER,
} from "../dist/sca/p04-dispatch-guard.js";
import { SCA_P05_PROVIDER_OPENING_ADAPTER } from "../dist/sca/p05-dispatch-guard.js";
import {
  SCA_P06_INLINE_OPENING_PREFIX,
  SCA_P06_PROVIDER_OPENING_ADAPTER,
  authorizeScaP06SerializedOpening,
  buildScaP06InlineOpeningAppendix,
} from "../dist/sca/p06-dispatch-guard.js";
import {
  SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
  SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P06_DECISION_RESULT_V1_SCHEMA,
  SCA_P06_REQUIRED_MODEL,
  SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
  scaP06BaseObligationId,
  validateScaP06ActionAuthorityV1,
  validateScaP06CognitivePayloadV1,
  validateScaP06DisclosureAdmissionV1,
  validateScaP06DecisionResultAgainstPayload,
  validateScaP06DisclosureAuthorityV1,
  validateScaP06DisclosureScopeV1,
  validateScaP06ResourcePolicyV1,
  withP06SelfDigest,
} from "../dist/sca/p06-contracts.js";
import { SCA_P06_CANDIDATE_REGISTRATION } from "../dist/sca/p06-playbook.js";
import { withSelfDigest, type ScaP05HypothesisBodyV1 } from "../dist/sca/p05-contracts.js";
import { WorkerExecutor } from "../dist/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];
function first<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`${label} is absent`);
  return value;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p06-guard-"));
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
      discriminating_result: "A bypass exists or all paths are dominated.",
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

function fixture(artifacts: ArtifactStore, deny = false) {
  const runId = "run-p06-guard";
  const suffix = "a".repeat(64);
  const hypothesisId = `p05h_${suffix}`;
  const selectedItemId = `p04i_${suffix}`;
  const sourceRef = persist(artifacts, {
    runId: "run-source",
    phase: "SCA-P01",
    kind: "source-snapshot",
    operationId: "source-snapshot",
    producer: "host:test",
    schemaId: "penny.test-source.v1",
    value: { source: true },
  });
  const p05TransitionRef = persist(artifacts, {
    runId: "run-p05",
    phase: "SCA-P05",
    kind: "sca-p05-to-p06-transition",
    operationId: "sca-p05-to-p06-transition",
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-to-p06-transition.v1",
    value: { transition: true },
  });
  const body = hypothesis(hypothesisId, selectedItemId);
  const revision = withSelfDigest(
    {
      schema_id: "penny.sca-p05-hypothesis-revision.v1" as const,
      schema_version: 1 as const,
      hypothesis_id: hypothesisId,
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
    runId: "run-p05",
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
        decision: deny ? ("denied" as const) : ("approved" as const),
        blocker_codes: deny ? ["operator_denied"] : [],
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
        decision: deny ? ("deny" as const) : ("allow" as const),
        blocker_codes: deny ? ["operator_denied"] : [],
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
        decision: deny ? ("deny" as const) : ("allow" as const),
        blocker_codes: deny ? ["operator_denied"] : [],
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
    task: "Choose evidence actions.",
    input_artifacts: {
      schema_version: 2 as const,
      artifacts: [
        { slot: "cognitive_payload", ref: payloadRef },
        { slot: "disclosure_admission", ref: disclosureRef },
      ],
    },
  };
  return { runId, assignment, payload, payloadRef, disclosure, disclosureRef };
}

function decisionResult(payload: ReturnType<typeof fixture>["payload"]) {
  const item = first(payload.items, "P06 payload item");
  const observables = [
    ...item.hypothesis.expected_supporting_observations,
    ...item.hypothesis.expected_refuting_observations,
  ].sort((left, right) => left.observable_id.localeCompare(right.observable_id));
  return {
    schema_id: SCA_P06_DECISION_RESULT_V1_SCHEMA,
    schema_version: 1 as const,
    role: "evidence_action_decider" as const,
    payload_sha256: payload.payload_sha256,
    assigned_hypothesis_ids: [item.hypothesis_id],
    items: [
      {
        hypothesis_id: item.hypothesis_id,
        final_revision_sha256: item.revision_sha256,
        exact_question: item.hypothesis.next_evidence_need.question,
        considered_alternatives: [
          {
            action_kind: "source_query" as const,
            evidence_mode: "source" as const,
            consequence_rank: 1 as const,
            capability: "capable" as const,
            authority_decision: "approved" as const,
            authority_id: "auth-source",
            resource_profile_id: "resource-source",
            expected_information_gain: "Exact source can answer the question.",
            rationale: "It is least consequential.",
          },
          {
            action_kind: "graph_query" as const,
            evidence_mode: "graph" as const,
            consequence_rank: 2 as const,
            capability: "capable" as const,
            authority_decision: "approved" as const,
            authority_id: "auth-graph",
            resource_profile_id: "resource-graph",
            expected_information_gain: "Graph evidence can establish domination.",
            rationale: "Use only if exact source is insufficient.",
          },
          {
            action_kind: "application_test" as const,
            evidence_mode: "application" as const,
            consequence_rank: 3 as const,
            capability: "incapable" as const,
            authority_decision: "denied" as const,
            authority_id: "auth-app",
            resource_profile_id: "resource-app",
            expected_information_gain: "Runtime evidence could show one path.",
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
        effective_obligation_class: "required-result" as const,
        decision_classification: "source_sufficient" as const,
        selected_action: {
          action_kind: "source_query" as const,
          evidence_mode: "source" as const,
          target: item.hypothesis.next_evidence_need.target,
          rationale: "Inspect exact source first.",
          authority_id: "auth-source",
          resource_profile_id: "resource-source",
          execution_status: "not_invoked" as const,
          p07_execution_claimed: false as const,
        },
        stopping_rule: item.hypothesis.stopping_conditions,
        child_use: {
          status: "not_invoked" as const,
          capability_id: null,
          invocation_ref: null,
          reason_code: "not_required_for_decision" as const,
        },
        p07_execution_status: "not_started" as const,
        vulnerability_adjudication: "not_performed" as const,
        report_or_release_claimed: false as const,
      },
    ],
    complete: true as const,
  };
}

class FencedP06Client implements ModelClient {
  providerPrompts = 0;
  guardCalls = 0;
  constructor(
    private readonly tamper = false,
    private readonly text = "SUMMARY:{}"
  ) {}
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    invocation.admitResolvedModel?.({
      provider: SCA_P06_REQUIRED_MODEL.provider,
      model: SCA_P06_REQUIRED_MODEL.model,
    });
    const appendix = invocation.providerOpeningAppendix?.();
    const opening = buildAgentOpening({
      invocation,
      registration: invocation.registration,
      agentGuidance: "registration-bound",
      domainGuidance: "registration-bound",
      activeToolNames: [],
      ...(appendix === undefined ? {} : { providerOpeningAppendix: appendix }),
    });
    this.guardCalls += 1;
    invocation.guardModelDispatch?.(this.tamper ? `${opening}\nsubstituted` : opening);
    this.providerPrompts += 1;
    return { text: this.text };
  }
}
function worker(artifacts: ArtifactStore, client: ModelClient): WorkerExecutor {
  const executor = new WorkerExecutor(client, artifacts, {
    projectRoot: path.resolve(import.meta.dirname, "../../.."),
    parallelConcurrency: 1,
    registration: SCA_P06_CANDIDATE_REGISTRATION,
  });
  executor.setReceiptAuthority(TEST_RECEIPT_AUTHORITY);
  return executor;
}
function directive(
  built: ReturnType<typeof fixture>,
  disclosureRef = built.disclosureRef
): Extract<Directive, { action: "invoke_agent" }> {
  return {
    schema_version: 2,
    action: "invoke_agent",
    identity: {
      schema_version: 2,
      run_id: built.runId,
      session_id: `session-${built.runId}`,
      playbook: "sca-p06-candidate",
      engine_owner: "typescript",
    },
    state_id: "selecting_evidence_actions",
    agent: "demetri",
    attempt: 1,
    task: built.assignment.task,
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "cognitive_payload", ref: built.payloadRef },
        { slot: "disclosure_admission", ref: disclosureRef },
      ],
    },
    output_artifact: {
      schema_version: 2,
      run_id: built.runId,
      phase: "selecting_evidence_actions",
      branch_id: null,
      kind: "sca-p06-decision-output",
      operation_id: "sca-p06-decision-output",
      version: 1,
      producer: "agent:demetri",
      media_type: "text/plain",
      content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [built.payloadRef, disclosureRef],
    },
    trust_profile: "hardened-untrusted",
    model_override: SCA_P06_REQUIRED_MODEL.override,
  };
}

describe("SCA P06 required model and complete opening guard", () => {
  it("authorizes the exact minimized payload and rejects task substitution", () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const appendix = buildScaP06InlineOpeningAppendix({
      store: artifacts,
      assignment: built.assignment,
    });
    const opening = `HOST\n\n${appendix}\n\nReturn the complete stage output and end with SUMMARY.`;
    expect(
      authorizeScaP06SerializedOpening({ store: artifacts, assignment: built.assignment, opening })
        .payload_ref
    ).toEqual(built.payloadRef);
    expect(() =>
      authorizeScaP06SerializedOpening({
        store: artifacts,
        assignment: { ...built.assignment, task: "Substituted" },
        opening,
      })
    ).toThrow(/substituted|projection/u);
  });

  it("binds P06 to zero tools and exact DeepSeek while remaining inactive", () => {
    expect(() => validateRegistrationContract(SCA_P06_CANDIDATE_REGISTRATION)).not.toThrow();
    if (SCA_P06_CANDIDATE_REGISTRATION.worker.kind !== "catalog-agent")
      throw new Error("P06 must be catalog-agent");
    const phase = SCA_P06_CANDIDATE_REGISTRATION.worker.phases.get("selecting_evidence_actions");
    expect(phase?.allowed_tools).toEqual([]);
    expect(phase?.required_model).toEqual(SCA_P06_REQUIRED_MODEL);
    expect(phase?.provider_opening_guard).toBe("sca_p06_payload_disclosure_v1");
    expect(SCA_P04_PROVIDER_OPENING_ADAPTER.resultRoutingPolicy).toBe(
      "exact_summary_or_phase_json"
    );
    expect(SCA_P05_PROVIDER_OPENING_ADAPTER.resultRoutingPolicy).toBe(
      "exact_summary_or_phase_json"
    );
    expect(SCA_P06_PROVIDER_OPENING_ADAPTER.resultRoutingPolicy).toBe("exact_summary_only");
    expect(PLAYBOOK_REGISTRY.has("sca-p06-candidate")).toBe(false);
  });

  it("makes zero provider calls when the complete opening drifts", async () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const client = new FencedP06Client(true);
    await expect(worker(artifacts, client).execute(directive(built))).rejects.toBeInstanceOf(
      PreDispatchPolicyDeniedError
    );
    expect(client.guardCalls).toBe(1);
    expect(client.providerPrompts).toBe(0);
  });

  it("makes zero provider calls when disclosure is denied", async () => {
    using artifacts = store();
    const built = fixture(artifacts, true);
    const client = new FencedP06Client();
    await expect(worker(artifacts, client).execute(directive(built))).rejects.toBeInstanceOf(
      PreDispatchPolicyDeniedError
    );
    expect(client.guardCalls).toBe(1);
    expect(client.providerPrompts).toBe(0);
  });

  it("rejects a stale disclosed P05 revision before provider dispatch", async () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const { admission_sha256: _digest, ...body } = built.disclosure;
    const stale = validateScaP06DisclosureAdmissionV1(
      withP06SelfDigest(
        {
          ...body,
          authorized_revision_refs: [
            {
              ...first(body.authorized_revision_refs, "P06 authorized revision"),
              artifact_id: `art_${"f".repeat(64)}`,
            },
          ],
        },
        "admission_sha256"
      )
    );
    const staleRef = persist(artifacts, {
      runId: built.runId,
      phase: "SCA-P06",
      kind: "sca-p06-disclosure-admission",
      operationId: "stale-disclosure",
      producer: "host:sca-p06-candidate",
      schemaId: SCA_P06_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: stale,
    });
    const client = new FencedP06Client();
    await expect(
      worker(artifacts, client).execute(directive(built, staleRef))
    ).rejects.toBeInstanceOf(PreDispatchPolicyDeniedError);
    expect(client.providerPrompts).toBe(0);
  });

  it("rejects schema-valid raw P06 phase JSON while routing the exact SUMMARY framing", async () => {
    using rawArtifacts = store();
    const rawBuilt = fixture(rawArtifacts);
    const valid = decisionResult(rawBuilt.payload);
    expect(() => validateScaP06DecisionResultAgainstPayload(valid, rawBuilt.payload)).not.toThrow();
    const rawText = canonicalJson(valid);
    const rawCompletion = first(
      await worker(rawArtifacts, new FencedP06Client(false, rawText)).execute(directive(rawBuilt)),
      "P06 raw phase-object worker result"
    );
    expect(rawCompletion.details).toEqual({});
    expect(rawArtifacts.readById(rawCompletion.output_artifact.artifact_id).toString("utf8")).toBe(
      rawText
    );
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(rawCompletion.details, rawBuilt.payload)
    ).toThrow();

    using summaryArtifacts = store();
    const summaryBuilt = fixture(summaryArtifacts);
    const summaryDetails = decisionResult(summaryBuilt.payload);
    const summaryText = `SUMMARY:${canonicalJson({ confidence: "CERTAIN", ...summaryDetails })}`;
    const summaryCompletion = first(
      await worker(summaryArtifacts, new FencedP06Client(false, summaryText)).execute(
        directive(summaryBuilt)
      ),
      "P06 exact SUMMARY worker result"
    );
    expect(summaryCompletion.details).toEqual(summaryDetails);
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(summaryCompletion.details, summaryBuilt.payload)
    ).not.toThrow();
  });

  it("refuses to route explanatory prose before an otherwise summary-shaped answer", async () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const valid = decisionResult(built.payload);
    expect(() => validateScaP06DecisionResultAgainstPayload(valid, built.payload)).not.toThrow();
    const text = `Explanatory prefix.\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", ...valid })}`;
    const client = new FencedP06Client(false, text);
    const completed = first(
      await worker(artifacts, client).execute(directive(built)),
      "P06 prose-wrapped worker result"
    );
    expect(completed.details).toEqual({});
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(completed.details, built.payload)
    ).toThrow();
    expect(artifacts.readById(completed.output_artifact.artifact_id).toString("utf8")).toBe(text);
    expect(client.providerPrompts).toBe(1);
  });

  it.each(["suffix", "duplicate-summary"] as const)(
    "refuses %s around an otherwise valid result under the exact guarded output policy",
    async (mode) => {
      using artifacts = store();
      const built = fixture(artifacts);
      const valid = decisionResult(built.payload);
      expect(() => validateScaP06DecisionResultAgainstPayload(valid, built.payload)).not.toThrow();
      const summary = `SUMMARY:${canonicalJson({ confidence: "CERTAIN", ...valid })}`;
      const text = `${summary}\n${mode === "suffix" ? "Trailing prose." : summary}`;
      const client = new FencedP06Client(false, text);
      const completed = first(
        await worker(artifacts, client).execute(directive(built)),
        "P06 invalid exact-output worker result"
      );
      expect(completed.details).toEqual({});
      expect(() =>
        validateScaP06DecisionResultAgainstPayload(completed.details, built.payload)
      ).toThrow();
      expect(artifacts.readById(completed.output_artifact.artifact_id).toString("utf8")).toBe(text);
      expect(client.providerPrompts).toBe(1);
    }
  );

  it("keeps the ordinary evidence decider artifact-only without activating the inline P06 candidate", () => {
    const ordinary = SCA_PLAYBOOK_REGISTRATION.worker;
    if (ordinary.kind !== "catalog-agent") throw new Error("expected ordinary SCA catalog worker");
    const phase = ordinary.phases.get("selecting_evidence_actions");
    expect(phase?.agent).toBe("demetri");
    expect(phase?.allowed_tools).toEqual(["artifact_read"]);
    expect(phase?.required_model).toEqual(SCA_REQUIRED_MODEL);
    expect(phase?.provider_opening_guard).toBeUndefined();
    expect(PLAYBOOK_REGISTRY.get("sca")).toBe(SCA_PLAYBOOK_REGISTRATION);
    expect(PLAYBOOK_REGISTRY.has("sca-p06-candidate")).toBe(false);
  });

  it("uses one canonical host-verified inline envelope marker", () => {
    expect(SCA_P06_INLINE_OPENING_PREFIX).toContain("host-verified");
  });
});
