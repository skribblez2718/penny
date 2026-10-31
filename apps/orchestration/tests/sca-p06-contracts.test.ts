import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import {
  SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P06_DECISION_RESULT_V1_SCHEMA,
  SCA_P06_REQUIRED_MODEL,
  scaP06BaseObligationId,
  scaP06MaterialObligationId,
  validateScaP06CognitivePayloadV1,
  validateScaP06DecisionResultAgainstPayload,
  validateScaP06GateV1,
  validateScaP06ObligationRevisionV1,
  withP06SelfDigest,
} from "../dist/sca/p06-contracts.js";
import { withSelfDigest, type ScaP05HypothesisBodyV1 } from "../dist/sca/p05-contracts.js";

const suffix = "1".repeat(64);
const hypothesisId = `p05h_${suffix}`;
const selectedItemId = `p04i_${suffix}`;
const supportingId = `p05o_${suffix}_supporting_0001`;
const refutingId = `p05o_${suffix}_refuting_0001`;

function first<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`${label} is absent`);
  return value;
}

function ref(input: { kind: string; schema: string; digest?: string }): ArtifactRef {
  const digest = input.digest ?? "2".repeat(64);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: "run-p06",
    phase: "SCA-P06",
    branch_id: null,
    kind: input.kind,
    operation_id: input.kind,
    version: 1,
    producer: "host:test",
    media_type: "application/json",
    content_schema: { schema_id: input.schema, schema_version: 1 },
    byte_length: 10,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function hypothesis(): ScaP05HypothesisBodyV1 {
  return {
    hypothesis_id: hypothesisId,
    selected_item_id: selectedItemId,
    bounded_claim: "A bounded actor-controlled path may reach a protected operation.",
    actor: { claim: "A non-admin actor", evidence_atom_ids: ["p05a_" + "3".repeat(64)] },
    controlled_input: {
      claim: "An actor-controlled value",
      evidence_atom_ids: ["p05a_" + "3".repeat(64)],
    },
    relevant_state: {
      claim: "The actor lacks authorization state",
      evidence_atom_ids: ["p05a_" + "3".repeat(64)],
    },
    causal_path: [
      {
        ordinal: 1,
        causal_link: "The value reaches the decision branch.",
        state_before: "Input accepted",
        state_after: "Decision branch reached",
        basis: "observed",
        evidence_atom_ids: ["p05a_" + "3".repeat(64)],
      },
    ],
    security_sensitive_outcome: {
      claim: "The protected operation may run",
      evidence_atom_ids: ["p05a_" + "3".repeat(64)],
    },
    competing_benign_explanation: {
      explanation: "A dominating guard may reject the operation.",
      discriminating_observation: "Find whether the exact guard dominates all paths.",
      evidence_atom_ids: ["p05a_" + "3".repeat(64)],
    },
    expected_supporting_observations: [
      {
        observable_id: supportingId,
        observation: "A path exists without guard domination.",
        expected_if_claim: true,
        evidence_mode: "graph",
        basis_atom_ids: ["p05a_" + "3".repeat(64)],
      },
    ],
    expected_refuting_observations: [
      {
        observable_id: refutingId,
        observation: "The exact guard dominates every path.",
        expected_if_claim: false,
        evidence_mode: "graph",
        basis_atom_ids: ["p05a_" + "3".repeat(64)],
      },
    ],
    next_evidence_need: {
      question: "Does the exact guard dominate the protected operation?",
      evidence_mode: "graph",
      target: "The guard and protected operation",
      discriminating_result: "A complete path either bypasses or is dominated by the guard.",
    },
    stopping_conditions: {
      supported: "Stop when a complete bypassing path is observed.",
      refuted: "Stop when the guard dominates every complete path.",
      inconclusive: "Stop when admitted evidence cannot distinguish either outcome.",
    },
    reopening_conditions: [
      {
        trigger: "The exact source snapshot changes.",
        changed_basis_required: "A new exact snapshot digest.",
      },
    ],
  };
}

function payload() {
  const body = hypothesis();
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
      source_snapshot_ref: ref({
        kind: "source",
        schema: "penny.test-source.v1",
        digest: "4".repeat(64),
      }),
      source_snapshot_sha256: "4".repeat(64),
      p04_transition_ref: ref({
        kind: "p04-transition",
        schema: "penny.sca-p04-to-p05-transition.v1",
        digest: "5".repeat(64),
      }),
      cognitive_payload_ref: ref({
        kind: "p05-payload",
        schema: "penny.sca-p05-cognitive-payload.v1",
        digest: "6".repeat(64),
      }),
      model_output_ref: ref({
        kind: "p05-output",
        schema: "penny.sca-p05-constructor-result.v1",
        digest: "7".repeat(64),
      }),
      evidence_atom_ids: ["p05a_" + "3".repeat(64)],
      change_reason_codes: ["initial_constructor"],
      changed_fields: [],
      created_at: "2026-09-22T00:00:00.000Z",
    },
    "revision_sha256"
  );
  const finalRevisionRef = ref({
    kind: "sca-p05-hypothesis-revision",
    schema: "penny.sca-p05-hypothesis-revision.v1",
    digest: sha256(canonicalJson(revision)),
  });
  const acceptedRef = ref({
    kind: "sca-p06-accepted-cohort",
    schema: "penny.sca-p06-accepted-cohort.v1",
    digest: "8".repeat(64),
  });
  const sourceRef = ref({ kind: "source", schema: "penny.test-source.v1", digest: "4".repeat(64) });
  const p05TransitionRef = ref({
    kind: "sca-p05-to-p06-transition",
    schema: "penny.sca-p05-to-p06-transition.v1",
    digest: "9".repeat(64),
  });
  const authorityRef = ref({
    kind: "sca-p06-action-authority",
    schema: "penny.sca-p06-action-authority.v1",
    digest: "a".repeat(64),
  });
  const resourceRef = ref({
    kind: "sca-p06-resource-policy",
    schema: "penny.sca-p06-resource-policy.v1",
    digest: "b".repeat(64),
  });
  const scopeRef = ref({
    kind: "sca-p06-disclosure-scope",
    schema: "penny.sca-p06-disclosure-scope.v1",
    digest: "c".repeat(64),
  });
  const obligationRef = ref({
    kind: "sca-p06-obligation-revision",
    schema: "penny.sca-p06-obligation-revision.v1",
    digest: "d".repeat(64),
  });
  return validateScaP06CognitivePayloadV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_COGNITIVE_PAYLOAD_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: "run-p06",
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
            base_obligation_ref: obligationRef,
            base_obligation_id: scaP06BaseObligationId(hypothesisId),
            authority: {
              hypothesis_id: hypothesisId,
              final_revision_ref: finalRevisionRef,
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
            resource_profiles: [
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
            ],
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
}

function result(
  overrides: Record<string, unknown> = {},
  p: ReturnType<typeof payload> = payload()
) {
  const item = first(p.items, "P06 payload item");
  const observables = [
    ...item.hypothesis.expected_supporting_observations,
    ...item.hypothesis.expected_refuting_observations,
  ].sort((left, right) => left.observable_id.localeCompare(right.observable_id));
  return {
    schema_id: SCA_P06_DECISION_RESULT_V1_SCHEMA,
    schema_version: 1,
    role: "evidence_action_decider",
    payload_sha256: p.payload_sha256,
    assigned_hypothesis_ids: [hypothesisId],
    items: [
      {
        hypothesis_id: hypothesisId,
        final_revision_sha256: item.revision_sha256,
        exact_question: item.hypothesis.next_evidence_need.question,
        considered_alternatives: [
          {
            action_kind: "source_query",
            evidence_mode: "source",
            consequence_rank: 1,
            capability: "capable",
            authority_decision: "approved",
            authority_id: "auth-source",
            resource_profile_id: "resource-source",
            expected_information_gain: "The exact source answers the guard question.",
            rationale: "Source inspection is sufficient and least consequential.",
          },
          {
            action_kind: "graph_query",
            evidence_mode: "graph",
            consequence_rank: 2,
            capability: "capable",
            authority_decision: "approved",
            authority_id: "auth-graph",
            resource_profile_id: "resource-graph",
            expected_information_gain: "A graph can establish domination.",
            rationale: "Use only if source inspection cannot discriminate.",
          },
          {
            action_kind: "application_test",
            evidence_mode: "application",
            consequence_rank: 3,
            capability: "incapable",
            authority_decision: "denied",
            authority_id: "auth-app",
            resource_profile_id: "resource-app",
            expected_information_gain: "A runtime trace could show one path.",
            rationale: "It is more consequential and not authorized.",
          },
        ],
        discriminating_observable: {
          observable_ids: observables.map((entry) => entry.observable_id),
          observable_records: observables,
          target: item.hypothesis.next_evidence_need.target,
          expected_change_to_judgment: item.hypothesis.next_evidence_need.discriminating_result,
        },
        material_obligation_discovery: null,
        effective_obligation_id: scaP06BaseObligationId(hypothesisId),
        effective_obligation_class: "required-result",
        decision_classification: "source_sufficient",
        selected_action: {
          action_kind: "source_query",
          evidence_mode: "source",
          target: item.hypothesis.next_evidence_need.target,
          rationale: "Inspect the least-consequential exact source first.",
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
        ...overrides,
      },
    ],
    complete: true,
  };
}

describe("SCA P06 least-consequential evidence contracts", () => {
  it("accepts a source-first decision bound to the exact P05 hypothesis", () => {
    expect(
      validateScaP06DecisionResultAgainstPayload(result(), payload()).items[0]
        ?.decision_classification
    ).toBe("source_sufficient");
  });

  it("accepts graph evidence when source is incapable of changing the judgment", () => {
    const base = result();
    const alternatives = first(base.items, "P06 result item").considered_alternatives.map(
      (entry) => ({
        ...entry,
        capability: entry.action_kind === "graph_query" ? "capable" : "incapable",
      })
    );
    const value = result({
      considered_alternatives: alternatives,
      decision_classification: "graph_needed",
      selected_action: {
        action_kind: "graph_query",
        evidence_mode: "graph",
        target: hypothesis().next_evidence_need.target,
        rationale: "Source is insufficient; graph evidence is next least consequential.",
        authority_id: "auth-graph",
        resource_profile_id: "resource-graph",
        execution_status: "not_invoked",
        p07_execution_claimed: false,
      },
    });
    expect(
      validateScaP06DecisionResultAgainstPayload(value, payload()).items[0]?.decision_classification
    ).toBe("graph_needed");
  });

  it("accepts application evidence only when source and graph are incapable", () => {
    const original = payload();
    const { payload_sha256: _digest, ...body } = original;
    const applicationPayload = validateScaP06CognitivePayloadV1(
      withP06SelfDigest(
        {
          ...body,
          items: body.items.map((item) => ({
            ...item,
            authority: {
              ...item.authority,
              modes: item.authority.modes.map((mode) =>
                mode.action_kind === "application_test"
                  ? { ...mode, decision: "approved" as const, reason_code: "approved_app" }
                  : mode
              ),
            },
          })),
        },
        "payload_sha256"
      )
    );
    const base = result({}, applicationPayload);
    const alternatives = first(base.items, "P06 result item").considered_alternatives.map(
      (entry) => ({
        ...entry,
        capability: entry.action_kind === "application_test" ? "capable" : "incapable",
        authority_decision:
          entry.action_kind === "application_test"
            ? ("approved" as const)
            : entry.authority_decision,
      })
    );
    const value = result(
      {
        considered_alternatives: alternatives,
        decision_classification: "runtime_needed",
        selected_action: {
          action_kind: "application_test",
          evidence_mode: "application",
          target: hypothesis().next_evidence_need.target,
          rationale: "Only actual behavior can distinguish the hypothesis.",
          authority_id: "auth-app",
          resource_profile_id: "resource-app",
          execution_status: "not_invoked",
          p07_execution_claimed: false,
        },
      },
      applicationPayload
    );
    expect(
      validateScaP06DecisionResultAgainstPayload(value, applicationPayload).items[0]
        ?.decision_classification
    ).toBe("runtime_needed");
  });

  it("blocks instead of escalating when the first capable mode lacks authority", () => {
    const original = payload();
    const { payload_sha256: _digest, ...body } = original;
    const deniedSourcePayload = validateScaP06CognitivePayloadV1(
      withP06SelfDigest(
        {
          ...body,
          items: body.items.map((item) => ({
            ...item,
            authority: {
              ...item.authority,
              modes: item.authority.modes.map((mode) =>
                mode.action_kind === "source_query"
                  ? { ...mode, decision: "denied" as const, reason_code: "denied_source" }
                  : mode
              ),
            },
          })),
        },
        "payload_sha256"
      )
    );
    const base = result({}, deniedSourcePayload);
    const alternatives = first(base.items, "P06 result item").considered_alternatives.map(
      (entry) => ({
        ...entry,
        authority_decision:
          entry.action_kind === "source_query" ? ("denied" as const) : entry.authority_decision,
      })
    );
    const value = result(
      {
        considered_alternatives: alternatives,
        decision_classification: "no_authorized_action",
        selected_action: {
          action_kind: "none",
          evidence_mode: "none",
          target: null,
          rationale: "The first capable mode lacks authority; do not escalate.",
          authority_id: null,
          resource_profile_id: null,
          execution_status: "not_invoked",
          p07_execution_claimed: false,
        },
      },
      deniedSourcePayload
    );
    expect(
      validateScaP06DecisionResultAgainstPayload(value, deniedSourcePayload).items[0]
        ?.decision_classification
    ).toBe("no_authorized_action");
  });

  it("rejects skipping a capable authorized source action for graph evidence", () => {
    const value = result({
      decision_classification: "graph_needed",
      selected_action: {
        action_kind: "graph_query",
        evidence_mode: "graph",
        target: hypothesis().next_evidence_need.target,
        rationale: "skip source",
        authority_id: "auth-graph",
        resource_profile_id: "resource-graph",
        execution_status: "not_invoked",
        p07_execution_claimed: false,
      },
    });
    expect(() => validateScaP06DecisionResultAgainstPayload(value, payload())).toThrow(
      /least-consequential/u
    );
  });

  it("rejects a stale P05 revision digest", () => {
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(
        result({ final_revision_sha256: "f".repeat(64) }),
        payload()
      )
    ).toThrow(/revision binding/u);
  });

  it("rejects an evidence question that differs from the exact P05 need", () => {
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(
        result({ exact_question: "A different question?" }),
        payload()
      )
    ).toThrow(/question/u);
  });

  it("rejects target drift under a valid observable ID", () => {
    const decision = first(result().items, "P06 result item");
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(
        result({
          discriminating_observable: {
            ...decision.discriminating_observable,
            target: "A semantically different target",
          },
        }),
        payload()
      )
    ).toThrow(/target or expected judgment/u);
  });

  it("rejects expected-judgment drift under a valid observable ID", () => {
    const decision = first(result().items, "P06 result item");
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(
        result({
          discriminating_observable: {
            ...decision.discriminating_observable,
            expected_change_to_judgment: "A changed oracle.",
          },
        }),
        payload()
      )
    ).toThrow(/target or expected judgment/u);
  });

  it("rejects a valid observable ID paired with changed semantics", () => {
    const decision = first(result().items, "P06 result item");
    const observable = first(
      decision.discriminating_observable.observable_records,
      "P06 observable record"
    );
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(
        result({
          discriminating_observable: {
            ...decision.discriminating_observable,
            observable_records: [{ ...observable, observation: "Changed semantics." }],
          },
        }),
        payload()
      )
    ).toThrow(/drifted from exact P05 records/u);
  });

  it("rejects a selected-action target that differs from exact P05", () => {
    const decision = first(result().items, "P06 result item");
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(
        result({
          selected_action: {
            ...decision.selected_action,
            target: "A drifted execution target",
          },
        }),
        payload()
      )
    ).toThrow(/selected action/u);
  });

  it("rejects an observable outside the P05 hypothesis", () => {
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(
        result({
          discriminating_observable: {
            observable_ids: [`p05o_${"f".repeat(64)}_supporting_0001`],
            observable_records: [
              {
                observable_id: `p05o_${"f".repeat(64)}_supporting_0001`,
                observation: "Other observation.",
                expected_if_claim: true,
                evidence_mode: "source",
                basis_atom_ids: ["p05a_" + "3".repeat(64)],
              },
            ],
            target: hypothesis().next_evidence_need.target,
            expected_change_to_judgment: hypothesis().next_evidence_need.discriminating_result,
          },
        }),
        payload()
      )
    ).toThrow(/outside its P05 hypothesis/u);
  });

  it("requires a discovered material obligation to use the host-derived stable ID", () => {
    const discovery = {
      obligation_id: scaP06MaterialObligationId(hypothesisId),
      purpose: "Preserve a newly material decision condition.",
      source_mandate: "The exact P05 hypothesis makes this condition material.",
      rationale: "It changes which evidence can discriminate the claim.",
      supporting_observable_ids: [supportingId],
      scope_effect: "within_exact_p05_hypothesis",
      effective_class: "required-result",
    };
    expect(
      validateScaP06DecisionResultAgainstPayload(
        result({
          material_obligation_discovery: discovery,
          effective_obligation_id: discovery.obligation_id,
        }),
        payload()
      ).items[0]?.effective_obligation_id
    ).toBe(discovery.obligation_id);
  });

  it("rejects a discovered obligation that is not promoted before reliance", () => {
    expect(() =>
      validateScaP06DecisionResultAgainstPayload(
        result({
          material_obligation_discovery: {
            obligation_id: scaP06MaterialObligationId(hypothesisId),
            purpose: "material",
            source_mandate: "mandate",
            rationale: "rationale",
            supporting_observable_ids: [supportingId],
            scope_effect: "within_exact_p05_hypothesis",
            effective_class: "required-result",
          },
        }),
        payload()
      )
    ).toThrow(/promoted before reliance/u);
  });

  it("validates host-minted base obligation identity and self-digest", () => {
    const value = withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-obligation-revision.v1" as const,
        schema_version: 1 as const,
        obligation_id: scaP06BaseObligationId(hypothesisId),
        revision: 1 as const,
        parent_revision_ref: null,
        parent_revision_sha256: null,
        discovery_reassessment_ref: null,
        discovery_reassessment_sha256: null,
        hypothesis_id: hypothesisId,
        final_hypothesis_revision_ref: first(payload().items, "P06 payload item")
          .final_revision_ref,
        class: "required-result" as const,
        purpose: "Choose evidence.",
        source_mandate: "P05 active hypothesis.",
        assigning_authority: "host_from_accepted_p05_hypothesis" as const,
        rationale: "One decision is required.",
        supporting_observable_ids: [supportingId],
        registered_before_action: true as const,
        status: "pending" as const,
        created_at: "2026-09-22T00:00:00.000Z",
      },
      "revision_sha256"
    );
    expect(validateScaP06ObligationRevisionV1(value).obligation_id).toBe(
      scaP06BaseObligationId(hypothesisId)
    );
  });

  it("derives a blocked gate when otherwise-valid decisions lack authority", () => {
    const traceRef = ref({
      kind: "trace",
      schema: "penny.sca-p06-traceability.v1",
      digest: "a".repeat(64),
    });
    const manifestRef = ref({
      kind: "manifest",
      schema: "penny.sca-p06-evidence-manifest.v1",
      digest: "b".repeat(64),
    });
    const ledgerRef = ref({
      kind: "ledger",
      schema: "penny.sca-p06-successor-ledger.v1",
      digest: "c".repeat(64),
    });
    const p05GateRef = ref({
      kind: "p05-gate",
      schema: "penny.sca-p05-gate.v1",
      digest: "d".repeat(64),
    });
    const gate = withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-gate.v1" as const,
        schema_version: 1 as const,
        phase_id: "SCA-P06" as const,
        criterion_id: "AC-P06" as const,
        verdict: "pass_blocked" as const,
        p05_gate_ref: p05GateRef,
        traceability_ref: traceRef,
        evidence_manifest_ref: manifestRef,
        successor_ledger_ref: ledgerRef,
        exhaustive_accounting: true,
        immutable_p05_lineage_valid: true,
        least_consequence_valid: true,
        authority_and_resource_bindings_valid: true,
        discovery_reassessment_refs: [],
        discovery_reassessments_valid: true,
        denied_discovery_count: 0,
        obligations_registered_before_action: true,
        child_policy_valid: true,
        p07_execution_claims_absent: true,
        action_record_count: 1,
        blocked_action_count: 1,
        checkpoint_count: 0,
        blocker_codes: ["p06_no_authorized_action"],
        evaluated_at: "2026-09-22T00:00:00.000Z",
      },
      "gate_sha256"
    );
    expect(validateScaP06GateV1(gate).verdict).toBe("pass_blocked");
  });

  it("keeps the cognitive payload schema closed", () => {
    const value = { ...payload(), extra: true };
    expect(() => validateContractForPayload(value)).toThrow();
  });
});

function validateContractForPayload(value: unknown) {
  return validateScaP06CognitivePayloadV1(value);
}
