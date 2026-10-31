import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/checkpointer.js";
import {
  DEFAULT_CHILD_WORKFLOW_POLICY_V1,
  DEFAULT_CHILD_WORKFLOW_POLICY_V2,
  applyChildWorkflowProgressSignal,
  childWorkflowCallId,
  childBudgetFits,
  childWorkflowDirectiveSha256,
  childWorkflowRunIdentity,
  validateCanonicalChildWorkflowRequestBytes,
  validateCanonicalEvidenceContextBytes,
  validateChildWorkflowCallRecord,
  validateChildWorkflowPolicy,
  validateChildWorkflowPolicyV2,
  validateChildWorkflowProgressLeaseState,
  validateChildWorkflowProgressSignal,
  validateLeaseBoundInvokeChildWorkflowDirective,
  validateChildWorkflowResult,
  validateChildWorkflowRequest,
  validateEvidenceContext,
  validateInitialChildWorkflowDirective,
  type ChildWorkflowCallRecordV1,
  type ChildWorkflowRequestV1,
} from "../dist/child-workflows/contracts.js";
import {
  childRequestMatchesProvider,
  childWorkflowCandidateRegistrySha256,
  childWorkflowCandidateRegistryV2Sha256,
  isPromotedChildProvider,
  validateChildProviderDescriptor,
  validateChildWorkflowCandidateRegistry,
  validateChildWorkflowCandidateRegistryV2,
  type ChildProviderDescriptorV1,
  type ChildProviderDescriptorV2,
} from "../dist/child-workflows/registration.js";
import { SEMANTIC_PRODUCT_VALIDATORS } from "../dist/composition.js";
import { validateDirective } from "../dist/contracts.js";
import type {
  ArtifactRef,
  ChildWorkflowOutputContractV1,
  ChildWorkflowPolicyBindingV1,
  ChildWorkflowProgressLeaseBindingV1,
  InputArtifacts,
  InvokeChildWorkflowDirective,
  RunIdentity,
} from "../dist/contracts.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  type PlaybookRegistration,
  validateChildWorkflowCandidateRegistration,
} from "../dist/playbooks/registry.js";
import { assertWorkerExecutableDirective } from "../dist/worker.js";

const CURRENT_ORDINARY_PROVIDER_NAMES = [
  "assess",
  "decide",
  "diagnose",
  "plan",
  "produce",
  "research",
] as const;

function registrationFor(
  name: (typeof CURRENT_ORDINARY_PROVIDER_NAMES)[number]
): PlaybookRegistration {
  const registration = PLAYBOOK_REGISTRY.get(name);
  if (registration === undefined) throw new Error(`missing ordinary registration '${name}'`);
  return registration;
}

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

function ref(
  input: {
    readonly id?: string;
    readonly kind?: string;
    readonly schemaId?: string;
    readonly schemaVersion?: number;
  } = {}
): ArtifactRef {
  const contentDigest = "a".repeat(64);
  return {
    schema_version: 2,
    artifact_id: input.id ?? `art_${"b".repeat(64)}`,
    run_id: "source-run",
    phase: "source-phase",
    branch_id: null,
    kind: input.kind ?? "semantic-core",
    operation_id: "source-operation",
    version: 1,
    producer: "host:source",
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

function request(providerRequest: unknown = { alternatives: ["a", "b"] }): ChildWorkflowRequestV1 {
  return validateChildWorkflowRequest({
    schema_id: "penny.child-workflow-request.v1",
    schema_version: 1,
    child_name: "decide",
    provider_request_schema_id: "penny.decision-request.v1",
    provider_request_schema_version: 1,
    provider_request: providerRequest,
    policy_binding: POLICY_BINDING,
  });
}

function evidenceContext(selector: unknown = { kind: "line_range", start: 1, end: 2 }): unknown {
  const source = ref({ id: `art_${"c".repeat(64)}`, kind: "source-document" });
  return {
    schema_id: "penny.evidence-context.v1",
    schema_version: 1,
    purpose: "Provide bounded evidence to a compatible child.",
    question: "What does the source establish?",
    origin: {
      project_id: "project-1",
      principal_id: "principal-1",
      scope_id: "scope-1",
      snapshot_id: "snapshot-1",
    },
    policy: {
      source_policy_id: "source-policy-1",
      destination_policy_id: "destination-policy-1",
    },
    entries: [
      {
        entry_id: "entry-1",
        source_type: "document",
        source_ref: source,
        selector,
        classification: "observation",
        statement: "The source contains one bounded observation.",
        uncertainty: { status: "none" },
      },
    ],
    transitive_refs: [source],
    limitations: ["The observation is constrained to the selected source range."],
  };
}

function candidateProvider(registration = registrationFor("decide")): ChildProviderDescriptorV1 {
  const admission = registration.start_admission;
  if (admission === undefined) throw new Error("decide start admission is required");
  const output = registration.contract.io.active_output_ports[0];
  if (output === undefined || output.artifact_kind === null) {
    throw new Error("decide terminal output is required");
  }
  const worker = registration.worker;
  if (worker.kind !== "catalog-agent") throw new Error("decide must retain its catalog worker");
  const phaseAuthority = [...worker.phases.entries()].map(([stateId, phase]) => ({
    schema_version: 1 as const,
    state_id: stateId,
    agent: phase.agent,
    tools_sha256: "d".repeat(64),
    destination_policy_sha256: "e".repeat(64),
  }));
  return {
    schema_version: 1,
    provider_name: registration.name,
    ingress: "skill",
    model_visibility: "model_visible_ordinary",
    request: {
      schema_id: admission.schema_id,
      schema_version: admission.schema_version,
    },
    input_ports: registration.contract.io.input_ports.map((port) => ({
      schema_version: 1,
      name: port.name,
      schema_id: port.schema_id,
      schema_version_required: port.schema_version_required,
      artifact_kind: port.artifact_kind ?? "inline-request",
      required: port.min_items > 0,
    })),
    terminal_output: {
      schema_version: 1,
      port_name: output.name,
      schema_id: output.schema_id,
      schema_version_required: output.schema_version_required,
      artifact_kind: output.artifact_kind,
    },
    partial_output: null,
    phase_authority: phaseAuthority,
    consequence_ids: ["caller-skill-request"],
    required_gate_ids: [],
    budget_policy_id: registration.contract.budget_policy.policy_id,
    recovery_policy_id: "orchestration-exact-run-recover-v1",
    availability: "candidate",
    qualification_manifest: null,
  };
}

function candidateProviderV2(registration = registrationFor("decide")): ChildProviderDescriptorV2 {
  const legacy = candidateProvider(registration);
  const { budget_policy_id, ...compatible } = legacy;
  if (budget_policy_id.length === 0) throw new Error("legacy fixture must retain its policy ID");
  return {
    ...compatible,
    schema_version: 2,
    progress_lease: LEASE,
  };
}

function callRecord(): ChildWorkflowCallRecordV1 {
  const callKey = "call-1";
  const callId = childWorkflowCallId({
    parent_run_id: PARENT.run_id,
    parent_state_id: "parent-state",
    call_key: callKey,
  });
  const requestRef = ref({
    id: `art_${"d".repeat(64)}`,
    kind: "child-request",
    schemaId: "penny.child-workflow-request.v1",
  });
  const inputs: InputArtifacts = { schema_version: 2, artifacts: [] };
  const directive: InvokeChildWorkflowDirective = {
    schema_version: 2,
    action: "invoke_child_workflow",
    identity: PARENT,
    state_id: "parent-state",
    call_key: callKey,
    child_name: "decide",
    request_ref: requestRef,
    input_artifacts: inputs,
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
  return {
    schema_version: 1,
    call_id: callId,
    parent_identity: PARENT,
    parent_state_id: "parent-state",
    parent_visit_sequence: 1,
    parent_visit_offset: 0,
    call_key: callKey,
    child_identity: childWorkflowRunIdentity({
      call_id: callId,
      parent: PARENT,
      child_name: "decide",
    }),
    directive,
    directive_sha256: childWorkflowDirectiveSha256(directive),
    request_ref: requestRef,
    request_ref_sha256: sha256(canonicalJson(requestRef)),
    input_artifacts: inputs,
    input_refs_sha256: sha256(canonicalJson(inputs)),
    expected_output: OUTPUT,
    expected_output_sha256: sha256(canonicalJson(OUTPUT)),
    policy_binding: POLICY_BINDING,
    policy_sha256: sha256(canonicalJson(POLICY_BINDING)),
    parent_registration_sha256: "e".repeat(64),
    child_registration_sha256: "f".repeat(64),
    budget: directive.budget,
    lifecycle: "terminal_recorded",
    terminal_action: "complete",
    terminal_sha256: "1".repeat(64),
    output_artifact: ref({
      id: `art_${"e".repeat(64)}`,
      kind: "semantic-core",
      schemaId: "penny.decision.v2",
      schemaVersion: 2,
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
    created_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T00:00:01Z",
  };
}

describe("CW-01 child-workflow contract closure", () => {
  it("bounds generic envelopes while preserving the native provider request identity", () => {
    expect(request().provider_request_schema_id).toBe("penny.decision-request.v1");
    expect(() =>
      validateChildWorkflowRequest({ ...request(), provider_request: "x".repeat(65_536) })
    ).toThrow(/canonical UTF-8 bytes/);
    const nativeValueAtLimit = "x".repeat(65_534);
    expect(Buffer.byteLength(canonicalJson(nativeValueAtLimit), "utf8")).toBe(65_536);
    expect(() =>
      validateChildWorkflowRequest({ ...request(), provider_request: nativeValueAtLimit })
    ).toThrow(/ChildWorkflowRequestV1 must contain 1\.\.65536 canonical UTF-8 bytes/);

    let deep: unknown = "leaf";
    for (let index = 0; index < 17; index += 1) deep = [deep];
    expect(() => validateChildWorkflowRequest({ ...request(), provider_request: deep })).toThrow(
      /nesting levels/
    );
    expect(() =>
      validateChildWorkflowRequest({
        ...request(),
        provider_request: Array.from({ length: 257 }, () => 1),
      })
    ).toThrow(/aggregate members/);
    const unsafeKey: Record<string, unknown> = {};
    Object.defineProperty(unsafeKey, "__proto__", {
      enumerable: true,
      value: "forbidden",
    });
    expect(() =>
      validateChildWorkflowRequest({
        ...request(),
        provider_request: unsafeKey,
      })
    ).toThrow(/unsafe key/);
  });

  it("binds versioned invocation policy into canonical child request bytes", () => {
    const strict = validateChildWorkflowRequest({
      ...request(),
      child_name: "plan",
      provider_request_schema_id: "penny.plan-request.v1",
      invocation_policy: { schema_version: 2, specification_assurance: "reviewed_definition" },
    });
    expect(strict.invocation_policy).toEqual({
      schema_version: 2,
      specification_assurance: "reviewed_definition",
    });
    expect(canonicalJson(strict)).not.toBe(
      canonicalJson({
        ...strict,
        invocation_policy: { schema_version: 2, specification_assurance: "semantic_only" },
      })
    );
    expect(() =>
      validateChildWorkflowRequest({
        ...strict,
        invocation_policy: { schema_version: 1, specification_assurance: "reviewed_definition" },
      })
    ).toThrow();
    expect(() =>
      validateChildWorkflowRequest({
        ...strict,
        invocation_policy: {
          schema_version: 2,
          specification_assurance: "reviewed_definition",
          extra: true,
        },
      })
    ).toThrow();
  });

  it("requires exact canonical child-request artifact bytes", () => {
    const value = request();
    const content = canonicalJson(value);
    const bytes = Buffer.from(content, "utf8");
    const requestRef: ArtifactRef = {
      ...ref({
        id: `art_${"f".repeat(64)}`,
        kind: "child-request",
        schemaId: "penny.child-workflow-request.v1",
      }),
      byte_length: bytes.byteLength,
      content_digest: sha256(bytes),
      store_ref: `artifact://sha256/${sha256(bytes)}`,
    };
    expect(validateCanonicalChildWorkflowRequestBytes(bytes, requestRef)).toEqual(value);
    expect(() =>
      validateCanonicalChildWorkflowRequestBytes(Buffer.from(`${content}\n`, "utf8"), requestRef)
    ).toThrow(/wrong identity/);
  });

  it("enforces direct EvidenceContext size and half-open non-empty selectors", () => {
    expect(validateEvidenceContext(evidenceContext())).toMatchObject({
      schema_id: "penny.evidence-context.v1",
    });
    expect(() =>
      validateEvidenceContext(evidenceContext({ kind: "byte_range", start: 1, end: 1 }))
    ).toThrow(/non-empty range/);
    expect(() =>
      validateEvidenceContext(evidenceContext({ kind: "line_range", start: 2, end: 2 }))
    ).toThrow(/non-empty range/);

    const ordinary = validateEvidenceContext(evidenceContext());
    const bytes = Buffer.from(canonicalJson(ordinary), "utf8");
    const contextDigest = sha256(bytes);
    const contextRef: ArtifactRef = {
      ...ref({
        id: `art_${"0".repeat(64)}`,
        kind: "evidence-context",
        schemaId: "penny.evidence-context.v1",
      }),
      byte_length: bytes.byteLength,
      content_digest: contextDigest,
      store_ref: `artifact://sha256/${contextDigest}`,
    };
    expect(validateCanonicalEvidenceContextBytes(bytes, contextRef)).toEqual(ordinary);
    expect(() =>
      validateCanonicalEvidenceContextBytes(
        Buffer.from(`${canonicalJson(ordinary)}\n`, "utf8"),
        contextRef
      )
    ).toThrow(/wrong identity/);
    const first = ordinary.entries[0];
    if (first === undefined) throw new Error("evidence fixture has no entry");
    const oversized = {
      ...ordinary,
      entries: Array.from({ length: 64 }, (_, index) => ({
        ...first,
        entry_id: `entry-${index + 1}`,
        statement: "x".repeat(16_384),
      })),
    };
    expect(() => validateEvidenceContext(oversized)).toThrow(/canonical UTF-8 bytes/);
  });

  it("keeps empty parent policy deny-by-default and rejects incompatible policy shapes", () => {
    expect(validateChildWorkflowPolicy(DEFAULT_CHILD_WORKFLOW_POLICY_V1)).toEqual(
      DEFAULT_CHILD_WORKFLOW_POLICY_V1
    );
    expect(
      childBudgetFits(
        {
          schema_version: 1,
          model_turns: 1,
          tool_calls: 0,
          external_calls: 0,
          wall_clock_ms: 1,
          max_steps: 1,
          output_bytes: 1,
        },
        DEFAULT_CHILD_WORKFLOW_POLICY_V1.total_budget
      )
    ).toBe(false);
    expect(() =>
      validateChildWorkflowPolicy({ ...DEFAULT_CHILD_WORKFLOW_POLICY_V1, max_calls: 1 })
    ).toThrow(/reserve zero child calls/);
    expect(() =>
      validateChildWorkflowPolicy({
        ...DEFAULT_CHILD_WORKFLOW_POLICY_V1,
        max_calls: 1,
        targets: [
          {
            schema_version: 1,
            child_name: "decide",
            child_request_schema_id: "penny.decision-request.v1",
            child_request_schema_version: 1,
            child_behavior_sha256: "a".repeat(64),
            expected_output: OUTPUT,
            scope_id: "scope-1",
            source_policy_id: "source-policy-1",
            destination_policy_id: "destination-policy-1",
          },
        ],
      })
    ).toThrow(/canonical child request schema/);
  });

  it("validates compact call records and rejects operand or lifecycle drift", () => {
    const record = callRecord();
    expect(validateChildWorkflowCallRecord(record)).toEqual(record);
    expect(validateInitialChildWorkflowDirective(record.directive)).toEqual(record.directive);
    expect(() =>
      validateInitialChildWorkflowDirective({
        ...record.directive,
        resume: {
          schema_version: 1,
          child_gate_id: "child-gate",
          child_challenge: "child-challenge",
          child_payload_digest: "a".repeat(64),
          response: { answer: "yes" },
        },
      })
    ).toThrow(/initial child directive/);
    expect(() =>
      validateChildWorkflowCallRecord({ ...record, directive_sha256: "0".repeat(64) })
    ).toThrow(/operand digest diverged/);
    expect(() =>
      validateChildWorkflowCallRecord({
        ...record,
        output_artifact: ref({
          id: `art_${"9".repeat(64)}`,
          kind: "wrong-kind",
          schemaId: "penny.wrong-output.v1",
        }),
      })
    ).toThrow(/expected exact output contract/);
    expect(() =>
      validateChildWorkflowCallRecord({ ...record, lifecycle: "running", terminal_action: null })
    ).toThrow(/terminal lifecycle/);
  });

  it("keeps a child terminal distinct from parent completion", () => {
    const outputArtifact = ref({
      id: `art_${"1".repeat(64)}`,
      kind: "semantic-core",
      schemaId: "penny.decision.v2",
      schemaVersion: 2,
    });
    const result = {
      schema_version: 1,
      call_id: "call-1",
      parent_run_id: PARENT.run_id,
      parent_state_id: "parent-state",
      call_key: "call-1",
      child_identity: childWorkflowRunIdentity({
        call_id: "call-1",
        parent: PARENT,
        child_name: "decide",
      }),
      parent_registration_sha256: "a".repeat(64),
      child_registration_sha256: "b".repeat(64),
      terminal_action: "complete",
      met: true,
      parent_obligation: "unresolved",
      terminal_sha256: "c".repeat(64),
      output_contract: OUTPUT,
      output_artifact: outputArtifact,
      artifacts: [outputArtifact],
      usage: {
        schema_version: 1,
        model_turns: 1,
        tool_calls: 0,
        external_calls: 0,
        active_wall_clock_ms: 1,
        steps: 1,
        output_bytes: 2,
        unknown_usage: false,
      },
    };
    expect(validateChildWorkflowResult(result)).toEqual(result);
    expect(() =>
      validateChildWorkflowResult({ ...result, parent_obligation: "satisfied" })
    ).toThrow();
  });

  it("registers exact-byte validators without mutating the production registry", () => {
    expect(SEMANTIC_PRODUCT_VALIDATORS.get("penny.child-workflow-request.v1")).toMatchObject({
      artifact_kind: "child-request",
    });
    expect(SEMANTIC_PRODUCT_VALIDATORS.get("penny.evidence-context.v1")).toMatchObject({
      artifact_kind: "evidence-context",
    });
    expect(SEMANTIC_PRODUCT_VALIDATORS.get("penny.strategy.v1")).toMatchObject({
      artifact_kind: "strategy",
    });
    for (const name of CURRENT_ORDINARY_PROVIDER_NAMES) {
      const registration = registrationFor(name);
      const before = runtimeRegistrationSha256(registration);
      const candidate = validateChildWorkflowCandidateRegistration({
        registration,
        parent_policy: DEFAULT_CHILD_WORKFLOW_POLICY_V1,
        provider: candidateProvider(registration),
      });
      expect(candidate.provider?.availability).toBe("candidate");
      expect(runtimeRegistrationSha256(registration)).toBe(before);
    }
  });

  it("keeps candidates non-shipping and proves descriptor/request compatibility without a name branch", () => {
    const provider = validateChildProviderDescriptor(candidateProvider());
    expect(childRequestMatchesProvider(request(), provider)).toBe(true);
    expect(childRequestMatchesProvider({ ...request(), child_name: "plan" }, provider)).toBe(false);
    expect(isPromotedChildProvider(provider)).toBe(false);

    const policy = {
      ...DEFAULT_CHILD_WORKFLOW_POLICY_V1,
      max_calls: 1,
      total_budget: {
        schema_version: 1,
        model_turns: 1,
        tool_calls: 0,
        external_calls: 0,
        wall_clock_ms: 1_000,
        max_steps: 1,
        output_bytes: 1_024,
      },
      parent_sealing_reserve: {
        schema_version: 1,
        model_turns: 0,
        tool_calls: 0,
        external_calls: 0,
        wall_clock_ms: 0,
        max_steps: 0,
        output_bytes: 0,
      },
      targets: [
        {
          schema_version: 1,
          child_name: provider.provider_name,
          child_request_schema_id: "penny.child-workflow-request.v1",
          child_request_schema_version: 1,
          child_behavior_sha256: "c".repeat(64),
          expected_output: provider.terminal_output,
          scope_id: "scope-1",
          source_policy_id: "source-policy-1",
          destination_policy_id: "destination-policy-1",
        },
      ],
    };
    const candidate = validateChildWorkflowCandidateRegistry({
      schema_version: 1,
      registry_kind: "non_shipping_candidate",
      parent_policy: policy,
      providers: [provider],
    });
    expect(childWorkflowCandidateRegistrySha256(candidate)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      validateChildWorkflowCandidateRegistry({
        ...candidate,
        providers: [{ ...provider, availability: "promoted", qualification_manifest: ref() }],
      })
    ).toThrow(/cannot expose a promoted provider/);
  });

  it("keeps legacy timing policies replayable while active policy contains no execution guesses", () => {
    expect(validateChildWorkflowPolicyV2(DEFAULT_CHILD_WORKFLOW_POLICY_V2)).toEqual(
      DEFAULT_CHILD_WORKFLOW_POLICY_V2
    );
    const activePolicyJson = JSON.stringify(DEFAULT_CHILD_WORKFLOW_POLICY_V2);
    for (const forbidden of [
      "budget",
      "model_turns",
      "tool_calls",
      "external_calls",
      "max_steps",
      "output_bytes",
      "wall_clock",
      "sealing_reserve",
    ]) {
      expect(activePolicyJson).not.toContain(forbidden);
    }
    expect(() =>
      validateChildWorkflowPolicyV2({
        ...DEFAULT_CHILD_WORKFLOW_POLICY_V2,
        total_budget: { schema_version: 2 },
      })
    ).toThrow(/ChildWorkflowPolicyV2/);

    const policy = {
      ...DEFAULT_CHILD_WORKFLOW_POLICY_V2,
      max_calls: 1,
      targets: [
        {
          schema_version: 2,
          child_name: "decide",
          child_request_schema_id: "penny.child-workflow-request.v1",
          child_request_schema_version: 1,
          child_behavior_sha256: "4".repeat(64),
          expected_output: OUTPUT,
          scope_id: "scope-1",
          source_policy_id: "source-policy-1",
          destination_policy_id: "destination-policy-1",
          progress_lease: LEASE,
        },
      ],
    };
    expect(validateChildWorkflowPolicyV2(policy)).toEqual(policy);
    expect(validateChildWorkflowPolicy(DEFAULT_CHILD_WORKFLOW_POLICY_V1)).toEqual(
      DEFAULT_CHILD_WORKFLOW_POLICY_V1
    );
  });

  it("binds new directives to a content-free inactivity lease and rejects guessed budgets", () => {
    const legacy = callRecord().directive;
    const { budget: legacyBudget, ...legacyWithoutBudget } = legacy;
    const leaseBound = {
      ...legacyWithoutBudget,
      schema_version: 3,
      progress_lease: LEASE,
    };
    const validatedLeaseBound = validateLeaseBoundInvokeChildWorkflowDirective(leaseBound);
    expect(validatedLeaseBound).toEqual(leaseBound);
    expect(validateDirective(leaseBound)).toEqual(leaseBound);
    const legacyRecord = callRecord();
    const { budget: legacyRecordBudget, ...legacyRecordWithoutBudget } = legacyRecord;
    expect(legacyRecordBudget).toEqual(legacyBudget);
    const leaseBoundRecord = {
      ...legacyRecordWithoutBudget,
      schema_version: 2,
      directive: validatedLeaseBound,
      directive_sha256: childWorkflowDirectiveSha256(validatedLeaseBound),
      progress_lease: LEASE,
    };
    expect(validateChildWorkflowCallRecord(leaseBoundRecord)).toEqual(leaseBoundRecord);
    expect(() =>
      validateLeaseBoundInvokeChildWorkflowDirective({
        ...leaseBound,
        budget: legacyBudget,
      })
    ).toThrow(/LeaseBoundInvokeChildWorkflowDirectiveV1/);
    expect(() =>
      validateLeaseBoundInvokeChildWorkflowDirective({
        ...leaseBound,
        progress_lease: { ...LEASE, model_progress: "renew me" },
      })
    ).toThrow(/LeaseBoundInvokeChildWorkflowDirectiveV1/);
  });

  it("renews only fenced host-observed activity and distinguishes it from convergence", () => {
    const initial = validateChildWorkflowProgressLeaseState({
      schema_version: 1,
      binding: LEASE,
      fence: FENCE,
      state: "active",
      lease_expires_at_ms: 0,
      last_accepted_signal_sequence: 0,
      last_accepted_at_ms: 0,
      last_activity: null,
      last_convergence: null,
      convergence_epoch: 0,
    });
    const activity = validateChildWorkflowProgressSignal({
      schema_version: 1,
      source: "trusted_host_observed",
      fence: FENCE,
      signal_sequence: 1,
      observed_at_ms: 100,
      observed_units: 1,
      kind: "worker_activity",
      activity_class: "tool_execution_updated",
    });
    const afterActivity = applyChildWorkflowProgressSignal({ state: initial, signal: activity });
    expect(afterActivity.lease_expires_at_ms).toBe(1_100);
    expect(afterActivity.convergence_epoch).toBe(0);
    expect(afterActivity.last_convergence).toBeNull();
    expect(() =>
      applyChildWorkflowProgressSignal({ state: afterActivity, signal: activity })
    ).toThrow(/replayed signal sequence/);
    expect(() =>
      validateChildWorkflowProgressSignal({
        ...activity,
        signal_sequence: 2,
        observed_units: 0,
      })
    ).toThrow(/ChildWorkflowProgressSignalV1/);
    expect(() =>
      validateChildWorkflowProgressSignal({
        ...activity,
        signal_sequence: 2,
        model_declared_progress: true,
      })
    ).toThrow(/ChildWorkflowProgressSignalV1/);

    const convergence = validateChildWorkflowProgressSignal({
      schema_version: 1,
      source: "trusted_host_observed",
      fence: FENCE,
      signal_sequence: 2,
      observed_at_ms: 200,
      observed_units: 1,
      kind: "workflow_convergence",
      convergence_class: "artifact_admitted",
      convergence_coordinate_sha256: "5".repeat(64),
    });
    const afterConvergence = applyChildWorkflowProgressSignal({
      state: afterActivity,
      signal: convergence,
    });
    expect(afterConvergence.convergence_epoch).toBe(1);
    expect(afterConvergence.last_convergence).toMatchObject({
      kind: "artifact_admitted",
      coordinate_sha256: "5".repeat(64),
    });
    expect(() =>
      applyChildWorkflowProgressSignal({
        state: afterConvergence,
        signal: { ...convergence, signal_sequence: 3, fence: { ...FENCE, owner_epoch: 2 } },
      })
    ).toThrow(/stale owner fence/);
  });

  it("keeps a lease-bound candidate registry non-shipping and rejects profile mismatch", () => {
    const provider = candidateProviderV2();
    const policy = {
      ...DEFAULT_CHILD_WORKFLOW_POLICY_V2,
      max_calls: 1,
      targets: [
        {
          schema_version: 2,
          child_name: provider.provider_name,
          child_request_schema_id: "penny.child-workflow-request.v1",
          child_request_schema_version: 1,
          child_behavior_sha256: "6".repeat(64),
          expected_output: provider.terminal_output,
          scope_id: "scope-1",
          source_policy_id: "source-policy-1",
          destination_policy_id: "destination-policy-1",
          progress_lease: LEASE,
        },
      ],
    };
    const candidate = validateChildWorkflowCandidateRegistryV2({
      schema_version: 2,
      registry_kind: "non_shipping_candidate",
      parent_policy: policy,
      providers: [provider],
    });
    expect(childWorkflowCandidateRegistryV2Sha256(candidate)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      validateChildWorkflowCandidateRegistryV2({
        ...candidate,
        providers: [
          {
            ...provider,
            progress_lease: { ...LEASE, profile_version: 2 },
          },
        ],
      })
    ).toThrow(/mismatched progress lease/);
  });

  it("refuses to route an internal child directive through the ordinary worker path", () => {
    expect(() => assertWorkerExecutableDirective(callRecord().directive)).toThrow(
      /not executable by a worker/
    );
  });
});
