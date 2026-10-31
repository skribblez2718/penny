import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  childResourceReservationFitsRoot,
  childWorkflowCallId,
  childWorkflowDirectiveSha256,
  childWorkflowRunIdentity,
  rootNonTimeEnvelopeSha256,
  validateAcceptedChildResult,
  validateChildProviderQualificationManifest,
  validateChildResourceReservation,
  validateChildResourceSettlementAgainstReservation,
  validateChildWorkflowCallRecord,
  validateChildWorkflowCallRecordV3,
  validateHostAuthorityBinding,
  validateInitialChildWorkflowDirective,
  validateInvokeChildWorkflowDirectiveV4,
  validateParentChildCapabilityPolicy,
  validatePendingChildGate,
  validateRootNonTimeEnvelope,
  type ChildNonTimeResourceVectorV1,
  type ChildResourceReservationV1,
  type HostAuthorityBindingV1,
  type InvokeChildWorkflowDirectiveV4,
  type RootNonTimeEnvelopeV1,
} from "../dist/child-workflows/contracts.js";
import { validateDirective } from "../dist/contracts.js";
import type {
  ArtifactRef,
  ChildWorkflowOutputContractV1,
  ChildWorkflowPolicyBindingV1,
  ChildWorkflowProgressLeaseBindingV1,
  InvokeChildWorkflowDirective,
  LeaseBoundInvokeChildWorkflowDirectiveV1,
  RunIdentity,
} from "../dist/contracts.js";

const PARENT: RunIdentity = {
  schema_version: 2,
  run_id: "parent-run",
  session_id: "parent-session",
  playbook: "parent-playbook",
  engine_owner: "typescript",
};

const POLICY_BINDING: ChildWorkflowPolicyBindingV1 = {
  schema_version: 1,
  project_id: "project-1",
  principal_id: "principal-1",
  scope_id: "scope-1",
  source_policy_id: "source-policy-1",
  destination_policy_id: "destination-policy-1",
};

const OUTPUT: ChildWorkflowOutputContractV1 = {
  schema_version: 1,
  port_name: "decision",
  schema_id: "penny.decision.v2",
  schema_version_required: 2,
  artifact_kind: "semantic-core",
};

const LEASE: ChildWorkflowProgressLeaseBindingV1 = {
  schema_version: 1,
  profile_id: "slow-provider-lease",
  profile_version: 1,
  profile_sha256: "1".repeat(64),
  calibration_id: "calibration-content-free-1",
  calibration_sha256: "2".repeat(64),
  provider_id: "provider-local",
  model_id: "model-local",
  operation_class: "child_execution",
  inactivity_interval_ms: 1_000,
  renewal_policy: "trusted_host_activity_or_convergence_v1",
};

const FENCE = {
  schema_version: 1 as const,
  owner_epoch: 1,
  execution_attempt_id: "attempt-1",
  worker_session_id: "worker-session-1",
  fencing_token_sha256: "3".repeat(64),
};

const ZERO_RESOURCES: ChildNonTimeResourceVectorV1 = {
  model_calls: 0,
  model_turns: 0,
  model_input_tokens: 0,
  model_output_tokens: 0,
  priced_usage_microusd: 0,
  tool_calls: 0,
  external_requests: 0,
  steps: 0,
  input_artifacts: 0,
  output_artifacts: 0,
  retained_artifacts: 0,
  input_bytes: 0,
  output_bytes: 0,
  retained_bytes: 0,
};

function artifact(input: {
  readonly id: string;
  readonly kind: string;
  readonly schemaId?: string;
  readonly schemaVersion?: number;
}): ArtifactRef {
  const contentDigest = sha256(input.id);
  return {
    schema_version: 2,
    artifact_id: input.id,
    run_id: "source-run",
    phase: "source-phase",
    branch_id: null,
    kind: input.kind,
    operation_id: `operation-${input.kind}`,
    version: 1,
    producer: "host:contract-test",
    media_type: "application/json",
    ...(input.schemaId === undefined
      ? {}
      : {
          content_schema: {
            schema_id: input.schemaId,
            schema_version: input.schemaVersion ?? 1,
          },
        }),
    byte_length: 2,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function authority(): HostAuthorityBindingV1 {
  return validateHostAuthorityBinding({
    schema_id: "penny.host-authority-binding.v1",
    schema_version: 1,
    authority_id: "authority-1",
    issuer: "trusted_host",
    operation: "invoke_child_workflow",
    parent_run_id: PARENT.run_id,
    parent_state_id: "parent-state",
    parent_state_visit: 1,
    call_offset: 0,
    call_key: "call-1",
    child_name: "decide",
    parent_registration_sha256: "4".repeat(64),
    provider_descriptor_sha256: "5".repeat(64),
    parent_policy_sha256: "6".repeat(64),
    policy_binding: POLICY_BINDING,
    source_capabilities: [{ capability_id: "source-policy-1", capability_sha256: "7".repeat(64) }],
    destination_capabilities: [
      { capability_id: "destination-policy-1", capability_sha256: "8".repeat(64) },
    ],
    consequence_capabilities: [
      { capability_id: "record-artifact", capability_sha256: "9".repeat(64) },
    ],
    approval_policy: {
      capability_id: "approval-policy-1",
      capability_sha256: "a".repeat(64),
    },
    approval_refs: [artifact({ id: `art_${"1".repeat(64)}`, kind: "approval" })],
    issued_at: "2026-09-14T00:00:00Z",
  });
}

function rootEnvelope(binding = authority()): RootNonTimeEnvelopeV1 {
  return validateRootNonTimeEnvelope({
    schema_id: "penny.root-non-time-envelope.v1",
    schema_version: 1,
    envelope_id: "root-envelope-1",
    project_id: POLICY_BINDING.project_id,
    principal_id: POLICY_BINDING.principal_id,
    scope_id: POLICY_BINDING.scope_id,
    authority_sha256: sha256(canonicalJson(binding)),
    resource_policy_id: "root-resource-policy-1",
    resource_policy_sha256: "b".repeat(64),
    topology: {
      nesting_depth: 1,
      max_active_children_per_parent: 1,
      project_concurrency_limit: 1,
    },
    max_child_calls: 3,
    limits: {
      model_calls: 16,
      model_turns: 32,
      model_input_tokens: 100_000,
      model_output_tokens: 25_000,
      priced_usage_microusd: 10_000_000,
      tool_calls: 256,
      external_requests: 64,
      steps: 512,
      input_artifacts: 128,
      output_artifacts: 128,
      retained_artifacts: 256,
      input_bytes: 8_388_608,
      output_bytes: 2_147_483_648,
      retained_bytes: 2_147_483_648,
    },
    final_output_capacity: {
      child_result_bytes: 67_108_864,
      receipt_control_bytes: 33_554_432,
      parent_sealing_bytes: 33_554_432,
    },
    issued_at: "2026-09-14T00:00:00Z",
  });
}

function reservation(root = rootEnvelope()): ChildResourceReservationV1 {
  const allocation: ChildNonTimeResourceVectorV1 = {
    model_calls: 4,
    model_turns: 8,
    model_input_tokens: 25_000,
    model_output_tokens: 6_000,
    priced_usage_microusd: 2_500_000,
    tool_calls: 64,
    external_requests: 16,
    steps: 128,
    input_artifacts: 32,
    output_artifacts: 32,
    retained_artifacts: 64,
    input_bytes: 2_097_152,
    output_bytes: 536_870_912,
    retained_bytes: 536_870_912,
  };
  const finalOutputReserve = {
    child_result_bytes: 16_777_216,
    receipt_control_bytes: 8_388_608,
    parent_sealing_bytes: 8_388_608,
  };
  return validateChildResourceReservation({
    schema_id: "penny.child-resource-reservation.v1",
    schema_version: 1,
    reservation_id: "reservation-1",
    root_envelope_id: root.envelope_id,
    root_envelope_sha256: rootNonTimeEnvelopeSha256(root),
    root_call_ordinal: 1,
    root_account_sequence: 1,
    root_account_fence_sha256: "f".repeat(64),
    call_key: "call-1",
    attempt_id: "attempt-1",
    allocation,
    remaining_before: root.limits,
    remaining_after: {
      model_calls: root.limits.model_calls - allocation.model_calls,
      model_turns: root.limits.model_turns - allocation.model_turns,
      model_input_tokens: root.limits.model_input_tokens - allocation.model_input_tokens,
      model_output_tokens: root.limits.model_output_tokens - allocation.model_output_tokens,
      priced_usage_microusd: root.limits.priced_usage_microusd - allocation.priced_usage_microusd,
      tool_calls: root.limits.tool_calls - allocation.tool_calls,
      external_requests: root.limits.external_requests - allocation.external_requests,
      steps: root.limits.steps - allocation.steps,
      input_artifacts: root.limits.input_artifacts - allocation.input_artifacts,
      output_artifacts: root.limits.output_artifacts - allocation.output_artifacts,
      retained_artifacts: root.limits.retained_artifacts - allocation.retained_artifacts,
      input_bytes: root.limits.input_bytes - allocation.input_bytes,
      output_bytes: root.limits.output_bytes - allocation.output_bytes,
      retained_bytes: root.limits.retained_bytes - allocation.retained_bytes,
    },
    final_output_reserve: finalOutputReserve,
    final_output_remaining_before: root.final_output_capacity,
    final_output_remaining_after: {
      child_result_bytes:
        root.final_output_capacity.child_result_bytes - finalOutputReserve.child_result_bytes,
      receipt_control_bytes:
        root.final_output_capacity.receipt_control_bytes - finalOutputReserve.receipt_control_bytes,
      parent_sealing_bytes:
        root.final_output_capacity.parent_sealing_bytes - finalOutputReserve.parent_sealing_bytes,
    },
  });
}

function directiveV4(): InvokeChildWorkflowDirectiveV4 {
  const hostAuthority = authority();
  const root = rootEnvelope(hostAuthority);
  const childReservation = reservation(root);
  return validateInvokeChildWorkflowDirectiveV4({
    schema_version: 4,
    action: "invoke_child_workflow",
    identity: PARENT,
    state_id: "parent-state",
    parent_state_visit: 1,
    call_offset: 0,
    call_key: "call-1",
    child_name: "decide",
    parent_registration_sha256: hostAuthority.parent_registration_sha256,
    child_registration_sha256: "c".repeat(64),
    parent_policy_sha256: hostAuthority.parent_policy_sha256,
    provider_descriptor_sha256: hostAuthority.provider_descriptor_sha256,
    request_ref: artifact({
      id: `art_${"2".repeat(64)}`,
      kind: "child-request",
      schemaId: "penny.child-workflow-request.v1",
    }),
    input_artifacts: { schema_version: 2, artifacts: [] },
    expected_output: OUTPUT,
    policy_binding: POLICY_BINDING,
    authority: hostAuthority,
    authority_sha256: sha256(canonicalJson(hostAuthority)),
    root_envelope: root,
    root_envelope_sha256: rootNonTimeEnvelopeSha256(root),
    reservation: childReservation,
    reservation_sha256: sha256(canonicalJson(childReservation)),
    progress_lease: LEASE,
  });
}

function openSettlement(childReservation = reservation()) {
  return {
    schema_id: "penny.child-resource-settlement.v1",
    schema_version: 1,
    reservation_id: childReservation.reservation_id,
    root_account_sequence: childReservation.root_account_sequence,
    root_account_fence_sha256: childReservation.root_account_fence_sha256,
    state: "open",
    charged: ZERO_RESOURCES,
    uncertain: ZERO_RESOURCES,
    released: ZERO_RESOURCES,
    final_output_charged: {
      child_result_bytes: 0,
      receipt_control_bytes: 0,
      parent_sealing_bytes: 0,
    },
    final_output_uncertain: {
      child_result_bytes: 0,
      receipt_control_bytes: 0,
      parent_sealing_bytes: 0,
    },
    final_output_released: {
      child_result_bytes: 0,
      receipt_control_bytes: 0,
      parent_sealing_bytes: 0,
    },
    settlement_id: null,
    settled_at: null,
  };
}

function settledSettlement(childReservation: ChildResourceReservationV1) {
  return {
    schema_id: "penny.child-resource-settlement.v1",
    schema_version: 1,
    reservation_id: childReservation.reservation_id,
    root_account_sequence: childReservation.root_account_sequence + 1,
    root_account_fence_sha256: childReservation.root_account_fence_sha256,
    state: "settled",
    charged: {
      model_calls: 1,
      model_turns: 2,
      model_input_tokens: 2_000,
      model_output_tokens: 1_000,
      priced_usage_microusd: 750_000,
      tool_calls: 4,
      external_requests: 1,
      steps: 10,
      input_artifacts: 2,
      output_artifacts: 3,
      retained_artifacts: 5,
      input_bytes: 1_024,
      output_bytes: 2_048,
      retained_bytes: 4_096,
    },
    uncertain: ZERO_RESOURCES,
    released: {
      model_calls: childReservation.allocation.model_calls - 1,
      model_turns: childReservation.allocation.model_turns - 2,
      model_input_tokens: childReservation.allocation.model_input_tokens - 2_000,
      model_output_tokens: childReservation.allocation.model_output_tokens - 1_000,
      priced_usage_microusd: childReservation.allocation.priced_usage_microusd - 750_000,
      tool_calls: childReservation.allocation.tool_calls - 4,
      external_requests: childReservation.allocation.external_requests - 1,
      steps: childReservation.allocation.steps - 10,
      input_artifacts: childReservation.allocation.input_artifacts - 2,
      output_artifacts: childReservation.allocation.output_artifacts - 3,
      retained_artifacts: childReservation.allocation.retained_artifacts - 5,
      input_bytes: childReservation.allocation.input_bytes - 1_024,
      output_bytes: childReservation.allocation.output_bytes - 2_048,
      retained_bytes: childReservation.allocation.retained_bytes - 4_096,
    },
    final_output_charged: {
      child_result_bytes: 2_048,
      receipt_control_bytes: 1_024,
      parent_sealing_bytes: 1_024,
    },
    final_output_uncertain: {
      child_result_bytes: 0,
      receipt_control_bytes: 0,
      parent_sealing_bytes: 0,
    },
    final_output_released: {
      child_result_bytes: childReservation.final_output_reserve.child_result_bytes - 2_048,
      receipt_control_bytes: childReservation.final_output_reserve.receipt_control_bytes - 1_024,
      parent_sealing_bytes: childReservation.final_output_reserve.parent_sealing_bytes - 1_024,
    },
    settlement_id: "settlement-1",
    settled_at: "2026-09-14T00:00:02Z",
  };
}

function leaseState(state: "active" | "suspended" | "expired" | "closed" = "active") {
  return {
    schema_version: 1,
    binding: LEASE,
    fence: FENCE,
    state,
    lease_expires_at_ms: 1_000,
    last_accepted_signal_sequence: 0,
    last_accepted_at_ms: 0,
    last_activity: null,
    last_convergence: null,
    convergence_epoch: 0,
  };
}

function callRecordV3() {
  const directive = directiveV4();
  const callId = childWorkflowCallId({
    parent_run_id: PARENT.run_id,
    parent_state_id: directive.state_id,
    call_key: directive.call_key,
  });
  return {
    schema_version: 3,
    call_id: callId,
    parent_identity: PARENT,
    parent_registration_sha256: directive.parent_registration_sha256,
    parent_state_id: directive.state_id,
    parent_state_visit: 1,
    call_offset: 0,
    call_key: directive.call_key,
    child_identity: childWorkflowRunIdentity({
      call_id: callId,
      parent: PARENT,
      child_name: directive.child_name,
    }),
    child_registration_sha256: directive.child_registration_sha256,
    child_name: directive.child_name,
    idempotency_key_digest: sha256(canonicalJson(directive)),
    lifecycle: "running",
    directive,
    lease_state: leaseState(),
    settlement: openSettlement(directive.reservation),
    pending_gate: null,
    terminal_result_ref: null,
    accepted_result: null,
    created_at: "2026-09-14T00:00:00Z",
    updated_at: "2026-09-14T00:00:01Z",
  };
}

function legacyDirectiveV2(): InvokeChildWorkflowDirective {
  return {
    schema_version: 2,
    action: "invoke_child_workflow",
    identity: PARENT,
    state_id: "parent-state",
    call_key: "legacy-call-1",
    child_name: "decide",
    request_ref: artifact({
      id: `art_${"3".repeat(64)}`,
      kind: "child-request",
      schemaId: "penny.child-workflow-request.v1",
    }),
    input_artifacts: { schema_version: 2, artifacts: [] },
    expected_output: OUTPUT,
    policy_binding: POLICY_BINDING,
    budget: {
      schema_version: 1,
      model_turns: 1,
      tool_calls: 0,
      external_calls: 0,
      wall_clock_ms: 1_000,
      max_steps: 1,
      output_bytes: 1_024,
    },
  };
}

function legacyDirectiveV3(): LeaseBoundInvokeChildWorkflowDirectiveV1 {
  const legacy = legacyDirectiveV2();
  const { budget: _budget, ...withoutBudget } = legacy;
  return { ...withoutBudget, schema_version: 3, progress_lease: LEASE };
}

function legacyCallV1() {
  const directive = legacyDirectiveV2();
  const callId = childWorkflowCallId({
    parent_run_id: PARENT.run_id,
    parent_state_id: directive.state_id,
    call_key: directive.call_key,
  });
  return {
    schema_version: 1,
    call_id: callId,
    parent_identity: PARENT,
    parent_state_id: directive.state_id,
    parent_visit_sequence: 1,
    parent_visit_offset: 0,
    call_key: directive.call_key,
    child_identity: childWorkflowRunIdentity({
      call_id: callId,
      parent: PARENT,
      child_name: directive.child_name,
    }),
    directive,
    directive_sha256: childWorkflowDirectiveSha256(directive),
    request_ref: directive.request_ref,
    request_ref_sha256: sha256(canonicalJson(directive.request_ref)),
    input_artifacts: directive.input_artifacts,
    input_refs_sha256: sha256(canonicalJson(directive.input_artifacts)),
    expected_output: OUTPUT,
    expected_output_sha256: sha256(canonicalJson(OUTPUT)),
    policy_binding: POLICY_BINDING,
    policy_sha256: sha256(canonicalJson(POLICY_BINDING)),
    parent_registration_sha256: "4".repeat(64),
    child_registration_sha256: "c".repeat(64),
    budget: directive.budget,
    lifecycle: "terminal_recorded",
    terminal_action: "complete",
    terminal_sha256: "d".repeat(64),
    output_artifact: artifact({
      id: `art_${"4".repeat(64)}`,
      kind: OUTPUT.artifact_kind,
      schemaId: OUTPUT.schema_id,
      schemaVersion: OUTPUT.schema_version_required,
    }),
    usage: {
      schema_version: 1,
      model_turns: 1,
      tool_calls: 0,
      external_calls: 0,
      active_wall_clock_ms: 10,
      steps: 1,
      output_bytes: 2,
      unknown_usage: false,
    },
    created_at: "2026-09-14T00:00:00Z",
    updated_at: "2026-09-14T00:00:01Z",
  };
}

function legacyCallV2() {
  const previous = legacyCallV1();
  const { budget: _budget, ...withoutBudget } = previous;
  const directive = legacyDirectiveV3();
  return {
    ...withoutBudget,
    schema_version: 2,
    directive,
    directive_sha256: childWorkflowDirectiveSha256(directive),
    progress_lease: LEASE,
  };
}

function acceptedResult(input: {
  readonly callId: string;
  readonly childRunId: string;
  readonly childResultRef: ArtifactRef;
}) {
  return {
    schema_id: "penny.accepted-child-result.v1",
    schema_version: 1,
    acceptance_id: "acceptance-1",
    call_id: input.callId,
    parent_run_id: PARENT.run_id,
    parent_state_id: "parent-state",
    child_run_id: input.childRunId,
    fence: FENCE,
    disposition: "accepted",
    child_result_ref: input.childResultRef,
    terminal_envelope_sha256: "e".repeat(64),
    semantic_output_ref: artifact({
      id: `art_${"6".repeat(64)}`,
      kind: OUTPUT.artifact_kind,
      schemaId: OUTPUT.schema_id,
      schemaVersion: OUTPUT.schema_version_required,
    }),
    invocation_receipt_refs: [
      artifact({
        id: `art_${"7".repeat(64)}`,
        kind: "child-invocation-receipt",
      }),
    ],
    completion_receipt_refs: [
      artifact({
        id: `art_${"8".repeat(64)}`,
        kind: "child-completion-receipt",
      }),
    ],
    settlement_id: "settlement-1",
    rejection_reason: null,
    satisfies_parent_obligation: false,
    recorded_at: "2026-09-14T00:00:03Z",
  };
}

function qualificationBindings() {
  return {
    parent_contracts_sha256: "0".repeat(64),
    provider_descriptor_sha256: "1".repeat(64),
    validator_sha256: "2".repeat(64),
    guidance_sha256: "3".repeat(64),
    tool_contract_sha256: "4".repeat(64),
    non_time_policy_sha256: "5".repeat(64),
    progress_lease_policy_sha256: "6".repeat(64),
    fixture_set_sha256: "7".repeat(64),
    environment_manifest_sha256: "8".repeat(64),
    provider_profile_sha256: "9".repeat(64),
  };
}

describe("CW-01-T2 shared child contract compatibility", () => {
  it("keeps the parent capability empty by default and makes every enabled target explicit", () => {
    const disabled = {
      schema_id: "penny.parent-child-capability-policy.v1",
      schema_version: 1,
      policy_id: "ordinary-parent-default",
      parent_registration_sha256: "a".repeat(64),
      topology: {
        nesting_depth: 1,
        max_active_children_per_parent: 1,
        project_concurrency_limit: 1,
      },
      max_calls: 0,
      root_resource_policy_sha256: null,
      targets: [],
    };
    expect(validateParentChildCapabilityPolicy(disabled)).toEqual(disabled);

    const target = {
      schema_version: 1,
      child_name: "decide",
      provider_descriptor_sha256: "b".repeat(64),
      provider_request_schema_id: "penny.decision-request.v1",
      provider_request_schema_version: 1,
      expected_output: OUTPUT,
      authority_policy_id: "authority-policy-1",
      authority_policy_sha256: "c".repeat(64),
      allocation_policy_id: "allocation-policy-1",
      allocation_policy_sha256: "d".repeat(64),
      progress_lease: LEASE,
    };
    const enabled = {
      ...disabled,
      policy_id: "enabled-parent-capability",
      max_calls: 3,
      root_resource_policy_sha256: "e".repeat(64),
      targets: [target],
    };
    expect(validateParentChildCapabilityPolicy(enabled)).toEqual(enabled);
    expect(() =>
      validateParentChildCapabilityPolicy({ ...enabled, targets: [target, target] })
    ).toThrow(/target child names/);
    expect(() => validateParentChildCapabilityPolicy({ ...disabled, max_calls: 1 })).toThrow(
      /ParentChildCapabilityPolicyV1/
    );
    expect(() =>
      validateParentChildCapabilityPolicy({
        ...disabled,
        implementation_path: "unexpected-private-location",
      })
    ).toThrow(/ParentChildCapabilityPolicyV1/);
  });

  it("binds host authority to exact source/destination policy and refuses label-only widening", () => {
    const binding = authority();
    expect(validateHostAuthorityBinding(binding)).toEqual(binding);
    expect(() =>
      validateHostAuthorityBinding({
        ...binding,
        source_capabilities: [
          { capability_id: "different-source", capability_sha256: "7".repeat(64) },
        ],
      })
    ).toThrow(/source policy lacks a bound capability/);
    expect(() => validateHostAuthorityBinding({ ...binding, approval_refs: [] })).toThrow(
      /consequential authority requires approval evidence/
    );
    expect(() => validateHostAuthorityBinding({ ...binding, grants_authority: true })).toThrow(
      /HostAuthorityBindingV1/
    );
  });

  it("reserves only finite non-time resources and accounts charged, uncertain, and released units", () => {
    const root = rootEnvelope();
    const childReservation = reservation(root);
    expect(childResourceReservationFitsRoot({ reservation: childReservation, root })).toBe(true);
    expect(
      childResourceReservationFitsRoot({
        reservation: {
          ...childReservation,
          remaining_before: {
            ...childReservation.remaining_before,
            model_turns: root.limits.model_turns + 1,
          },
          remaining_after: {
            ...childReservation.remaining_after,
            model_turns: childReservation.remaining_after.model_turns + 1,
          },
        },
        root,
      })
    ).toBe(false);
    expect(
      validateChildResourceSettlementAgainstReservation({
        reservation: childReservation,
        settlement: {
          ...openSettlement(childReservation),
          uncertain: { ...ZERO_RESOURCES, model_turns: childReservation.allocation.model_turns },
        },
      }).uncertain.model_turns
    ).toBe(childReservation.allocation.model_turns);
    expect(() =>
      validateChildResourceReservation({
        ...childReservation,
        remaining_after: {
          ...childReservation.remaining_after,
          model_turns: childReservation.remaining_after.model_turns + 1,
        },
      })
    ).toThrow(/model_turns does not record an exact debit/);
    expect(() =>
      validateChildResourceSettlementAgainstReservation({
        reservation: childReservation,
        settlement: {
          ...openSettlement(childReservation),
          charged: {
            ...ZERO_RESOURCES,
            model_turns: childReservation.allocation.model_turns + 1,
          },
        },
      })
    ).toThrow(/model_turns exceeds its reservation/);
    expect(() =>
      validateChildResourceSettlementAgainstReservation({
        reservation: childReservation,
        settlement: {
          ...settledSettlement(childReservation),
          released: ZERO_RESOURCES,
        },
      })
    ).toThrow(/not fully accounted/);
  });

  it("admits the closed V4 directive only through its isolated validator", () => {
    const directive = directiveV4();
    expect(validateInvokeChildWorkflowDirectiveV4(directive)).toEqual(directive);
    expect(() => validateInitialChildWorkflowDirective(directive)).toThrow(
      /InvokeChildWorkflowDirective/
    );
    expect(() => validateDirective(directive)).toThrow(/directive failed schema validation/);
    expect(() => validateInvokeChildWorkflowDirectiveV4(legacyDirectiveV3())).toThrow(
      /InvokeChildWorkflowDirectiveV4/
    );
    expect(() =>
      validateInvokeChildWorkflowDirectiveV4({
        ...directive,
        authority_sha256: "f".repeat(64),
      })
    ).toThrow(/authority digest mismatch/);
    expect(() =>
      validateInvokeChildWorkflowDirectiveV4({ ...directive, resume: { response: true } })
    ).toThrow(/InvokeChildWorkflowDirectiveV4/);
  });

  it("preserves current V2/V3 directive and V1/V2 call readers byte-for-byte", () => {
    const directive2 = legacyDirectiveV2();
    const directive3 = legacyDirectiveV3();
    expect(validateInitialChildWorkflowDirective(directive2)).toEqual(directive2);
    expect(validateInitialChildWorkflowDirective(directive3)).toEqual(directive3);
    expect(validateDirective(directive2)).toEqual(directive2);
    expect(validateDirective(directive3)).toEqual(directive3);
    const call1 = legacyCallV1();
    const call2 = legacyCallV2();
    expect(validateChildWorkflowCallRecord(call1)).toEqual(call1);
    expect(validateChildWorkflowCallRecord(call2)).toEqual(call2);
    expect(() => validateChildWorkflowCallRecord(callRecordV3())).toThrow(
      /ChildWorkflowCallRecordV1/
    );
    expect(() => validateChildWorkflowCallRecordV3(call2)).toThrow(/ChildWorkflowCallRecordV3/);
  });

  it("validates a durable running V3 call and refuses mismatched retry identity", () => {
    const record = callRecordV3();
    expect(validateChildWorkflowCallRecordV3(record)).toEqual(record);
    expect(() =>
      validateChildWorkflowCallRecordV3({ ...record, idempotency_key_digest: "f".repeat(64) })
    ).toThrow(/idempotency digest mismatch/);
    expect(() => validateChildWorkflowCallRecordV3({ ...record, call_id: "wrong-call" })).toThrow(
      /call_id does not match canonical identity/
    );
    expect(() =>
      validateChildWorkflowCallRecordV3({
        ...record,
        lease_state: { ...record.lease_state, state: "suspended" },
      })
    ).toThrow(/running lifecycle requires an active lease/);
    expect(() =>
      validateChildWorkflowCallRecordV3({
        ...record,
        lease_state: {
          ...record.lease_state,
          fence: { ...FENCE, execution_attempt_id: "different-attempt" },
        },
      })
    ).toThrow(/execution attempt lost its reservation fence/);
  });

  it("persists a pending gate under the current fence and rejects stale ownership", () => {
    const record = callRecordV3();
    const gate = validatePendingChildGate({
      schema_id: "penny.pending-child-gate.v1",
      schema_version: 1,
      call_id: record.call_id,
      child_run_id: record.child_identity.run_id,
      gate_id: "gate-1",
      challenge_id: "challenge-1",
      payload_sha256: "a".repeat(64),
      fence: FENCE,
      state: "pending",
      response_ref: null,
      operator_evidence_refs: [],
      recorded_at: "2026-09-14T00:00:01Z",
    });
    const waiting = {
      ...record,
      lifecycle: "waiting_user",
      lease_state: leaseState("suspended"),
      pending_gate: gate,
    };
    expect(validateChildWorkflowCallRecordV3(waiting)).toEqual(waiting);
    expect(() =>
      validateChildWorkflowCallRecordV3({
        ...waiting,
        pending_gate: {
          ...gate,
          fence: { ...FENCE, owner_epoch: 2 },
        },
      })
    ).toThrow(/pending gate identity or fence mismatch/);
    expect(() =>
      validatePendingChildGate({
        ...gate,
        state: "resolved",
      })
    ).toThrow(/resolved gate requires a response/);
  });

  it("accepts an exact child result without claiming the parent obligation is complete", () => {
    const running = callRecordV3();
    const childResultRef = artifact({
      id: `art_${"5".repeat(64)}`,
      kind: "child-result",
      schemaId: "penny.child-workflow-result.v1",
    });
    const acceptance = acceptedResult({
      callId: running.call_id,
      childRunId: running.child_identity.run_id,
      childResultRef,
    });
    expect(validateAcceptedChildResult(acceptance).satisfies_parent_obligation).toBe(false);
    const consumed = {
      ...running,
      lifecycle: "consumed",
      lease_state: leaseState("closed"),
      settlement: settledSettlement(running.directive.reservation),
      terminal_result_ref: childResultRef,
      accepted_result: acceptance,
      updated_at: "2026-09-14T00:00:03Z",
    };
    expect(validateChildWorkflowCallRecordV3(consumed)).toEqual(consumed);
    expect(() => validateAcceptedChildResult({ ...acceptance, semantic_output_ref: null })).toThrow(
      /accepted disposition requires output/
    );
    expect(() =>
      validateChildWorkflowCallRecordV3({
        ...consumed,
        accepted_result: { ...acceptance, settlement_id: "different-settlement" },
      })
    ).toThrow(/accepted result identity mismatch/);
    expect(() =>
      validateChildWorkflowCallRecordV3({
        ...consumed,
        accepted_result: {
          ...acceptance,
          semantic_output_ref: artifact({
            id: `art_${"c".repeat(64)}`,
            kind: "semantic-core",
            schemaId: "penny.wrong-output.v1",
          }),
        },
      })
    ).toThrow(/does not match the expected exact output contract/);
  });

  it("keeps qualification non-discoverable until independent evidence and operator decision exist", () => {
    const candidate = {
      schema_id: "penny.child-provider-qualification-manifest.v1",
      schema_version: 1,
      manifest_id: "qualification-manifest-1",
      provider_name: "decide",
      status: "candidate",
      code_revision: "8fa234443906f94b",
      bindings: qualificationBindings(),
      evidence_refs: [],
      independent_verification_ref: null,
      operator_decision_ref: null,
      state_reason: null,
      recorded_at: "2026-09-14T00:00:00Z",
    };
    expect(validateChildProviderQualificationManifest(candidate)).toEqual(candidate);
    const evidenceRef = artifact({
      id: `art_${"9".repeat(64)}`,
      kind: "child-provider-qualification-evidence",
    });
    const verificationRef = artifact({
      id: `art_${"a".repeat(64)}`,
      kind: "child-provider-independent-verification",
    });
    const operatorRef = artifact({
      id: `art_${"b".repeat(64)}`,
      kind: "child-provider-operator-decision",
    });
    const qualified = {
      ...candidate,
      status: "qualified_non_discoverable",
      evidence_refs: [evidenceRef],
      independent_verification_ref: verificationRef,
    };
    expect(validateChildProviderQualificationManifest(qualified)).toEqual(qualified);
    expect(() =>
      validateChildProviderQualificationManifest({ ...qualified, status: "discoverable" })
    ).toThrow(/requires evidence, verification, and operator decision/);
    const discoverable = {
      ...qualified,
      status: "discoverable",
      operator_decision_ref: operatorRef,
    };
    expect(validateChildProviderQualificationManifest(discoverable)).toEqual(discoverable);
    expect(() =>
      validateChildProviderQualificationManifest({
        ...discoverable,
        status: "stale",
        state_reason: null,
      })
    ).toThrow(/explains staleness/);
  });
});
