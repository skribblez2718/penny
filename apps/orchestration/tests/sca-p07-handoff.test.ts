import { describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactHostStore } from "../dist/artifact-store.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { scaP01SourceTreeDigest } from "../dist/sca/p01-contracts.js";
import { withSelfDigest as withP05SelfDigest } from "../dist/sca/p05-contracts.js";
import {
  SCA_P06_OBLIGATION_IDS,
  validateScaP06GateV1,
  validateScaP06ToP07TransitionV1,
  withP06SelfDigest,
} from "../dist/sca/p06-contracts.js";
import { admitScaP07ExecutionPlan } from "../dist/sca/p07-admission.js";
import {
  SCA_P07_EXECUTION_AUTHORITY_SCHEMA,
  SCA_P07_EXECUTION_PLAN_SCHEMA,
  SCA_P07_HOST_REQUEST_SCHEMA,
  SCA_P07_HOST_RESULT_SCHEMA,
  validateScaP07HostResultV1,
  validateScaP07ExecutionAuthorityV1,
  validateScaP07ExecutionPlanV1,
  validateScaP07HostRequestV1,
  withP07Digest,
} from "../dist/sca/p07-contracts.js";
import {
  scaBrokerExecuteRequestSha256,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerReceiptV1,
} from "../dist/sca/broker-contracts.js";
import {
  createScaP07HostAdapter,
  createScaP07HostDeclaration,
  scaP07HostDirectives,
  SCA_P07_OPERATION_KIND,
} from "../dist/sca/p07-operation.js";
import type { HostOperationExecutionContextV1 } from "../dist/host-operations/contracts.js";
import { createPreparedHostOperationCallRecord } from "../dist/host-operations/storage.js";
import { PLAYBOOK_REGISTRY } from "../dist/playbooks/registry.js";

const H = "a".repeat(64);
const now = "2026-09-26T00:00:00.000Z";
const hypothesis = `p05h_${H}`;
function parseUnknown(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}
function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("missing first item");
  return value;
}
function fixture(kind: "source_query" | "graph_query" | "application_test") {
  const objects = new Map<string, { ref: ArtifactRef; bytes: Buffer }>();
  const store: ArtifactHostStore = {
    refById: (id) => objects.get(id)?.ref,
    readById: (id) => {
      const item = objects.get(id);
      if (item === undefined) throw new Error("absent");
      return item.bytes;
    },
    persist: () => {
      throw new Error("test read-only store");
    },
    select: () => {
      throw new Error("test read-only store");
    },
    metadata: () => {
      throw new Error("test read-only store");
    },
    lastVersion: () => 0,
    refFor: () => null,
  };
  function save(
    kindName: string,
    value: unknown,
    phase = "SCA-P06",
    operationId = kindName,
    runId = "run-1",
    provenance?: {
      readonly producer?: string;
      readonly schema_id?: string;
      readonly schema_version?: number;
    }
  ): ArtifactRef {
    const bytes = Buffer.from(canonicalJson(value));
    const identity = {
      branch_id: null,
      kind: kindName,
      operation_id: operationId,
      phase,
      run_id: runId,
      version: 1,
    };
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${sha256(canonicalJson(identity))}`,
      ...identity,
      producer: provenance?.producer ?? "host:test",
      media_type: "application/json",
      content_schema: {
        schema_id: provenance?.schema_id ?? `penny.${kindName}.v1`,
        schema_version: provenance?.schema_version ?? 1,
      },
      byte_length: bytes.length,
      content_digest: sha256(bytes),
      store_ref: `artifact://sha256/${sha256(bytes)}`,
    };
    objects.set(ref.artifact_id, { ref, bytes });
    return ref;
  }
  const sourceBytes = Buffer.from("export const value = 1;\n");
  const sourceIdentity = {
    path: "src/value.ts",
    byte_count: sourceBytes.byteLength,
    content_sha256: sha256(sourceBytes),
  };
  const sourceScope = { include_paths: ["src"], exclude_paths: [] };
  const sourceTree = scaP01SourceTreeDigest([sourceIdentity]);
  const sourceManifest = save(
    "sca-p01-source-file-manifest",
    {
      schema_id: "penny.sca-p01-source-file-manifest.v1",
      schema_version: 1,
      snapshot_id: "snapshot-1",
      scope: sourceScope,
      files: [sourceIdentity],
      file_count: 1,
      byte_count: sourceBytes.byteLength,
      tree_sha256: sourceTree,
    },
    "SCA-P01-source",
    "source-manifest",
    "run-source",
    {
      producer: "host:source-custody",
      schema_id: "penny.sca-p01-source-file-manifest.v1",
    }
  );
  const sourceCustody = save(
    "sca-p01-source-custody-corpus",
    {
      schema_id: "penny.sca-p01-source-custody-corpus.v1",
      schema_version: 1,
      custody_id: "custody-1",
      snapshot_id: "snapshot-1",
      file_manifest_ref: sourceManifest,
      files: [
        {
          ...sourceIdentity,
          encoding: "base64",
          content_base64: sourceBytes.toString("base64"),
        },
      ],
      file_count: 1,
      byte_count: sourceBytes.byteLength,
      tree_sha256: sourceTree,
      sealed: true,
    },
    "SCA-P01-source",
    "source-custody",
    "run-source",
    {
      producer: "host:source-custody",
      schema_id: "penny.sca-p01-source-custody-corpus.v1",
    }
  );
  const sourceSnapshot = {
    schema_id: "penny.sca-campaign-source-snapshot.v2",
    schema_version: 2,
    snapshot_id: "snapshot-1",
    tree_sha256: sourceTree,
    file_manifest_ref: sourceManifest,
    file_manifest_sha256: sourceManifest.content_digest,
    custody_ref: sourceCustody,
    custody_sha256: sourceCustody.content_digest,
    scope: sourceScope,
    file_count: 1,
    byte_count: sourceBytes.byteLength,
    status: "frozen",
  };
  const source = save(
    "source-snapshot",
    sourceSnapshot,
    "SCA-P01-source",
    "source-snapshot",
    "run-source",
    {
      producer: "host:source-custody",
      schema_id: "penny.sca-campaign-source-snapshot.v2",
      schema_version: 2,
    }
  );
  const brokerSource = save(
    "source-snapshot",
    sourceSnapshot,
    "SCA-P01-source",
    "source-snapshot-p07",
    "run-1",
    {
      producer: "host:source-custody",
      schema_id: "penny.sca-campaign-source-snapshot.v2",
      schema_version: 2,
    }
  );
  const config = save("sca-config", { config: true }, "SCA-P07");
  const graph = save("sca-graph", { graph: true }, "SCA-P07");
  const execution = save("sca-execution-plan", { execution: true }, "SCA-P07");
  const policy = save("sca-execution-policy", { policy: true }, "SCA-P07");
  const inputs =
    kind === "source_query"
      ? []
      : kind === "graph_query"
        ? [graph]
        : [execution, policy].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  const p05Transition = save("sca-p05-to-p06-transition", { transition: true }, "SCA-P05");
  const atom = `p05a_${H}`;
  const supportingObservable = `p05o_${H}_supporting_0001`;
  const refutingObservable = `p05o_${H}_refuting_0001`;
  const claim = (text: string) => ({ claim: text, evidence_atom_ids: [atom] });
  const hypothesisBody = {
    hypothesis_id: hypothesis,
    selected_item_id: `p04i_${H}`,
    bounded_claim: "A bounded source path may affect a security-sensitive outcome.",
    actor: claim("An untrusted actor controls input."),
    controlled_input: claim("The actor controls a bounded value."),
    relevant_state: claim("The value reaches relevant state."),
    causal_path: [
      {
        ordinal: 1,
        causal_link: "The value reaches a sink.",
        state_before: "Untrusted value exists.",
        state_after: "The sink receives it.",
        basis: "observed" as const,
        evidence_atom_ids: [atom],
      },
    ],
    security_sensitive_outcome: claim("The sink could expose protected state."),
    competing_benign_explanation: {
      explanation: "Validation may reject the value.",
      discriminating_observation: "Inspect the validation path.",
      evidence_atom_ids: [atom],
    },
    expected_supporting_observations: [
      {
        observable_id: supportingObservable,
        observation: "No validation precedes the sink.",
        expected_if_claim: true,
        evidence_mode: "source" as const,
        basis_atom_ids: [atom],
      },
    ],
    expected_refuting_observations: [
      {
        observable_id: refutingObservable,
        observation: "Validation rejects the input.",
        expected_if_claim: false,
        evidence_mode: "source" as const,
        basis_atom_ids: [atom],
      },
    ],
    next_evidence_need: {
      question: "Does validation dominate the sink?",
      evidence_mode: "source" as const,
      target: "Validation path",
      discriminating_result: "A dominating validator refutes the claim.",
    },
    stopping_conditions: {
      supported: "The unvalidated path is established.",
      refuted: "Validation dominates the sink.",
      inconclusive: "The path remains ambiguous.",
    },
    reopening_conditions: [
      { trigger: "Source changes.", changed_basis_required: "The validation path changes." },
    ],
  };
  const finalRevisionValue = withP05SelfDigest(
    {
      schema_id: "penny.sca-p05-hypothesis-revision.v1",
      schema_version: 1,
      hypothesis_id: hypothesis,
      revision: 1,
      parent_revision_ref: null,
      parent_revision_sha256: null,
      body: hypothesisBody,
      body_sha256: sha256(canonicalJson(hypothesisBody)),
      source_snapshot_ref: source,
      source_snapshot_sha256: source.content_digest,
      p04_transition_ref: p05Transition,
      selected_item_id: `p04i_${H}`,
      cognitive_payload_ref: config,
      model_output_ref: config,
      evidence_atom_ids: [atom],
      change_reason_codes: ["initial_construction"],
      changed_fields: [],
      created_at: now,
    },
    "revision_sha256"
  );
  const finalRevision = save("sca-p05-hypothesis-revision", finalRevisionValue, "SCA-P05");
  const p06Authority = save(
    "sca-p06-action-authority",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-action-authority.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        tenant_id: "tenant",
        project_id: "project",
        run_id: "run-1",
        source_snapshot_sha256: source.content_digest,
        p05_transition_ref: p05Transition,
        hypothesis_authorities: [
          {
            hypothesis_id: hypothesis,
            final_revision_ref: finalRevision,
            modes: (["source_query", "graph_query", "application_test"] as const).map((mode) => ({
              action_kind: mode,
              authority_id: `auth-${mode}`,
              decision: "approved",
              reason_code: "approved",
              scope: "p06_decision_only_not_p07_execution_authority",
            })),
          },
        ],
        issued_at: now,
      },
      "authority_sha256"
    )
  );
  const p06Policy = save(
    "sca-p06-resource-policy",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-resource-policy.v1",
        schema_version: 1,
        run_id: "run-1",
        phase_id: "SCA-P06",
        policy_id: "policy",
        source_snapshot_sha256: source.content_digest,
        p05_transition_ref: p05Transition,
        profiles: (["source_query", "graph_query", "application_test"] as const).map((mode) => ({
          action_kind: mode,
          profile_id: `profile-${mode}`,
          timeout_ms: 1000,
          max_output_bytes: 4096,
          max_result_items: 10,
          max_selectors: 1,
          scope: "p06_decision_only_not_p07_execution_budget",
        })),
        status: "approved",
      },
      "policy_sha256"
    )
  );
  const p06Request = save(
    "sca-p06-request",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-request.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        tenant_id: "tenant",
        project_id: "project",
        run_id: "run-1",
        p05_transition_ref: p05Transition,
        implementation_identity_ref: config,
        runtime_policy_ref: config,
        action_authority_ref: p06Authority,
        resource_policy_ref: p06Policy,
        disclosure_scope_ref: config,
        requested_at: now,
      },
      "request_sha256"
    )
  );
  const accepted = save(
    "sca-p06-accepted-cohort",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-accepted-cohort.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        run_id: "run-1",
        p06_request_ref: p06Request,
        p05_transition_ref: p05Transition,
        p05_gate_ref: config,
        p05_successor_ledger_ref: config,
        p05_traceability_ref: config,
        p05_evidence_manifest_ref: config,
        source_snapshot_ref: source,
        source_snapshot_sha256: source.content_digest,
        active_hypothesis_ids: [hypothesis],
        refuted_hypothesis_ids: [],
        final_hypotheses: [
          {
            hypothesis_id: hypothesis,
            selected_item_id: `p04i_${H}`,
            final_revision_ref: finalRevision,
            revision: 1,
            revision_sha256: finalRevisionValue.revision_sha256,
            body_sha256: finalRevisionValue.body_sha256,
          },
        ],
        runtime_policy_ref: config,
        action_authority_ref: p06Authority,
        resource_policy_ref: p06Policy,
        disclosure_scope_ref: config,
        admitted_at: now,
      },
      "cohort_sha256"
    )
  );
  const selected = {
    action_kind: kind,
    evidence_mode:
      kind === "source_query" ? "source" : kind === "graph_query" ? "graph" : "application",
    target: "bounded target",
    rationale: "discriminating",
    authority_id: `auth-${kind}`,
    resource_profile_id: `profile-${kind}`,
    execution_status: "not_invoked",
    p07_execution_claimed: false,
  };
  const obligation = `p06obl_${H}_evidence_decision_0001`;
  const obligationValue = withP06SelfDigest(
    {
      schema_id: "penny.sca-p06-obligation-revision.v1",
      schema_version: 1,
      obligation_id: obligation,
      revision: 1,
      parent_revision_ref: null,
      parent_revision_sha256: null,
      discovery_reassessment_ref: null,
      discovery_reassessment_sha256: null,
      hypothesis_id: hypothesis,
      final_hypothesis_revision_ref: finalRevision,
      class: "required-result",
      purpose: "Resolve the next discriminating evidence question.",
      source_mandate: "Use the accepted P05 hypothesis and exact source snapshot.",
      assigning_authority: "host_from_accepted_p05_hypothesis",
      rationale: "The accepted hypothesis requires one bounded next evidence action.",
      supporting_observable_ids: [supportingObservable],
      registered_before_action: true,
      status: "pending",
      created_at: now,
    },
    "revision_sha256"
  );
  const obligationRef = save("sca-p06-obligation-revision", obligationValue);
  const action = save(
    "sca-p06-action-record",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-action-record.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        action_id: `p06act_${H}`,
        hypothesis_id: hypothesis,
        final_hypothesis_revision_ref: finalRevision,
        final_hypothesis_revision_sha256: finalRevisionValue.revision_sha256,
        exact_question: "Which path?",
        considered_alternatives: (["source_query", "graph_query", "application_test"] as const).map(
          (mode, index) => ({
            action_kind: mode,
            evidence_mode:
              mode === "source_query" ? "source" : mode === "graph_query" ? "graph" : "application",
            consequence_rank: index + 1,
            capability: "capable",
            authority_decision: "approved",
            authority_id: `auth-${mode}`,
            resource_profile_id: `profile-${mode}`,
            expected_information_gain: "high",
            rationale: "discriminates",
          })
        ),
        discriminating_observable: {
          observable_ids: [supportingObservable],
          observable_records: [
            {
              observable_id: supportingObservable,
              observation: "path",
              expected_if_claim: true,
              evidence_mode: "source",
              basis_atom_ids: [`p05a_${H}`],
            },
          ],
          target: "path",
          expected_change_to_judgment: "resolves",
        },
        authority_ref: p06Authority,
        authority_sha256: p06Authority.content_digest,
        resource_policy_ref: p06Policy,
        resource_policy_sha256: p06Policy.content_digest,
        obligation_revision_ref: obligationRef,
        obligation_revision_sha256: obligationRef.content_digest,
        discovery_reassessment_ref: null,
        discovery_reassessment_sha256: null,
        effective_obligation_id: obligation,
        effective_obligation_class: "required-result",
        decision_classification:
          kind === "source_query"
            ? "source_sufficient"
            : kind === "graph_query"
              ? "graph_needed"
              : "runtime_needed",
        selected_action: selected,
        stopping_rule: { supported: "support", refuted: "refute", inconclusive: "unknown" },
        child_use: {
          status: "not_invoked",
          capability_id: null,
          invocation_ref: null,
          reason_code: "not_required_for_decision",
        },
        cognitive_payload_ref: config,
        model_output_ref: config,
        dispatch_guard_ref: config,
        model_execution_receipt_ref: config,
        p07_execution_status: "not_started",
        vulnerability_adjudication: "not_performed",
        report_or_release_claimed: false,
        created_at: now,
      },
      "record_sha256"
    )
  );
  const trace = save(
    "sca-p06-traceability",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-traceability.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        active_hypothesis_ids: [hypothesis],
        rows: [
          {
            hypothesis_id: hypothesis,
            final_hypothesis_revision_ref: finalRevision,
            base_obligation_ref: obligationRef,
            effective_obligation_ref: obligationRef,
            discovery_reassessment_ref: null,
            disposition: "action_selected",
            decision_classification:
              kind === "source_query"
                ? "source_sufficient"
                : kind === "graph_query"
                  ? "graph_needed"
                  : "runtime_needed",
            action_record_ref: action,
            checkpoint_ref: null,
            p07_execution_status: "not_started",
          },
        ],
        action_record_ids: [`p06act_${H}`],
        blocked_hypothesis_ids: [],
        checkpointed_hypothesis_ids: [],
        exhaustive: true,
      },
      "traceability_sha256"
    )
  );
  const manifest = save(
    "sca-p06-evidence-manifest",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-evidence-manifest.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        source_snapshot_ref: source,
        source_snapshot_sha256: source.content_digest,
        evidence_refs: [action],
        artifact_ids: [action.artifact_id],
      },
      "manifest_sha256"
    )
  );
  const ledger = save(
    "sca-p06-successor-ledger",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-successor-ledger.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        run_id: "run-1",
        predecessor_ledger_ref: config,
        predecessor_ledger_sha256: config.content_digest,
        phase_obligations: SCA_P06_OBLIGATION_IDS.map((id) => ({
          obligation_id: id,
          class: "required-result",
          status: "satisfied",
          evidence_refs: [action],
          blocker_codes: [],
        })),
        evidence_obligations: [
          {
            obligation_id: obligation,
            hypothesis_id: hypothesis,
            class: "required-result",
            status: "selected",
            obligation_revision_ref: obligationRef,
            discovery_reassessment_ref: null,
            action_record_ref: action,
            blocker_codes: [],
          },
        ],
        all_p06_decisions_valid: true,
        p07_ready: true,
        pending_phase_ids: ["SCA-P07", "SCA-P08", "SCA-P09", "SCA-P10", "SCA-P11", "SCA-P12"],
        append_only: true,
        release_eligible: false,
        campaign_complete: false,
        campaign_completion_claimed: false,
      },
      "ledger_sha256"
    )
  );
  const gate = save(
    "sca-p06-gate",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-gate.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        criterion_id: "AC-P06",
        verdict: "pass_ready",
        p05_gate_ref: config,
        traceability_ref: trace,
        evidence_manifest_ref: manifest,
        successor_ledger_ref: ledger,
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
        blocked_action_count: 0,
        checkpoint_count: 0,
        blocker_codes: [],
        evaluated_at: now,
      },
      "gate_sha256"
    )
  );
  const transition = save(
    "sca-p06-to-p07-transition",
    withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-to-p07-transition.v1",
        schema_version: 1,
        source_phase_id: "SCA-P06",
        target_phase_id: "SCA-P07",
        authorized: true,
        qualification_scope: "decision_gate_only_not_p07_execution",
        p06_request_ref: p06Request,
        accepted_cohort_ref: accepted,
        traceability_ref: trace,
        evidence_manifest_ref: manifest,
        successor_ledger_ref: ledger,
        p06_gate_ref: gate,
        action_record_refs: [action],
        discovery_reassessment_refs: [],
        p07_execution_status: "not_started",
        p07_execution_authorized_by_this_transition: false,
        release_eligible: false,
        campaign_complete: false,
      },
      "transition_sha256"
    )
  );
  const tool =
    kind === "source_query"
      ? "sca_source_query"
      : kind === "graph_query"
        ? "sca_graph_query"
        : "sca_application_test";
  const operation_input =
    kind === "source_query"
      ? {
          kind,
          query_id: "query",
          selectors: [{ path: "src/file.ts", line_range: null, symbol: null }],
          parameters: [],
        }
      : kind === "graph_query"
        ? {
            kind,
            graph_ref: graph,
            query_id: "query",
            selectors: [{ path: "src/file.ts", line_range: null, symbol: null }],
            parameters: [],
          }
        : { kind, execution_plan_ref: execution, policy_ref: policy };
  const brokerRequest = {
    schema_id: "penny.sca-broker-execute-request.v1",
    schema_version: 1,
    tenant_id: "tenant",
    project_id: "project",
    run_id: "run-1",
    job_id: "job-1",
    attempt: 1,
    idempotency_key: "key-1",
    tool_name: tool,
    operation: kind,
    submitted_at: now,
    deadline_at: "2026-09-26T00:00:10.000Z",
    limits: { timeout_ms: 1000, max_output_bytes: 4096, max_result_items: 10 },
    source_snapshot_ref: brokerSource,
    config_ref: config,
    input_refs: inputs,
    operation_input,
  } satisfies ScaBrokerExecuteRequestV1;
  const authority = save(
    "sca-p07-execution-authority",
    withP07Digest(
      {
        schema_id: SCA_P07_EXECUTION_AUTHORITY_SCHEMA,
        schema_version: 1,
        tenant_id: "tenant",
        project_id: "project",
        run_id: "run-1",
        transition_ref: transition,
        bindings: [
          {
            action_record_ref: action,
            operation: kind,
            broker_request_sha256: scaBrokerExecuteRequestSha256(brokerRequest),
            source_snapshot_ref: brokerSource,
            config_ref: config,
            input_refs: inputs,
          },
        ],
      },
      "authority_sha256"
    ),
    "SCA-P07"
  );
  const plan = save(
    "sca-p07-execution-plan",
    withP07Digest(
      {
        schema_id: SCA_P07_EXECUTION_PLAN_SCHEMA,
        schema_version: 1,
        transition_ref: transition,
        authority_ref: authority,
        items: [
          {
            action_record_ref: action,
            broker_request: brokerRequest,
            broker_request_sha256: scaBrokerExecuteRequestSha256(brokerRequest),
          },
        ],
      },
      "plan_sha256"
    ),
    "SCA-P07"
  );
  const admission = admitScaP07ExecutionPlan({
    store,
    transition_ref: transition,
    authority_ref: authority,
    resolve_current_authority_ref: () => authority,
    plan_ref: plan,
  });
  const admissionRef = save("sca-p07-admission", admission, "SCA-P07");
  const hostRequest = validateScaP07HostRequestV1(
    withP07Digest(
      {
        schema_id: SCA_P07_HOST_REQUEST_SCHEMA,
        schema_version: 1,
        plan_ref: plan,
        admission_ref: admissionRef,
        item_index: 0,
        action_record_ref: action,
        broker_request: brokerRequest,
        broker_request_sha256: scaBrokerExecuteRequestSha256(brokerRequest),
      },
      "request_sha256"
    )
  );
  const hostRef = save("sca-p07-host-request", hostRequest, "SCA-P07");
  return {
    store,
    save,
    remove: (ref: ArtifactRef) => objects.delete(ref.artifact_id),
    source,
    sourceManifest,
    sourceCustody,
    finalRevision,
    obligationRef,
    config,
    action,
    gate,
    transition,
    authority,
    plan,
    admission,
    admissionRef,
    hostRequest,
    hostRef,
    brokerRequest,
  };
}

const declaration = createScaP07HostDeclaration({
  backend_binding_id: "broker",
  lease_profile_id: "lease",
  lease_duration_ms: 30000,
  lease_renew_after_ms: 10000,
  queue_inactivity_ms: 5000,
  operation_inactivity_ms: 30000,
  max_input_bytes: 500000,
  max_output_bytes: 100000,
});
function receipt(
  broker: ScaBrokerExecuteRequestV1,
  status: "succeeded" | "failed",
  output: ArtifactRef
): ScaBrokerReceiptV1 {
  return {
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
    receipt_id: "receipt",
    request_sha256: scaBrokerExecuteRequestSha256(broker),
    limits: broker.limits,
    terminal_status: status,
    partial: false,
    truncated: false,
    source_snapshot_ref: broker.source_snapshot_ref,
    config_ref: broker.config_ref,
    input_refs: broker.input_refs,
    output_refs: status === "succeeded" ? [output] : [],
    result_item_count: status === "succeeded" ? 1 : 0,
    failure: status === "failed" ? { code: "failed", message: "failed" } : null,
    accepted_at: now,
    terminal_at: now,
  };
}

describe("inactive P07 exact handoff", () => {
  for (const kind of ["source_query", "graph_query", "application_test"] as const)
    it(`admits ${kind} and emits one ordered provider-free directive`, () => {
      const f = fixture(kind);
      const directives = scaP07HostDirectives({
        plan: validatePlan(f),
        plan_ref: f.plan,
        admission: f.admission,
        admission_ref: f.admissionRef,
        requests: [{ ref: f.hostRef, value: f.hostRequest }],
        identity: {
          schema_version: 2,
          run_id: "run-1",
          session_id: "session",
          playbook: "sca",
          engine_owner: "typescript",
        },
        state_id: "p07",
        attempt: 1,
        registration_sha256: H,
        declaration,
        backend_key_sha256: H,
      });
      expect(directives).toHaveLength(1);
      expect(first(directives).action).toBe("invoke_host_operation");
      expect(first(directives).operation_kind).toBe(SCA_P07_OPERATION_KIND);
      expect(first(directives).input_artifacts.artifacts.map((entry) => entry.slot)).toEqual([
        "plan",
        "admission",
      ]);
    });
  it("exact-reads source, final-hypothesis and obligation child lineage under owner authority", () => {
    const intact = fixture("source_query");
    const resolver = vi.fn(() => intact.authority);
    expect(
      admitScaP07ExecutionPlan({
        store: intact.store,
        transition_ref: intact.transition,
        authority_ref: intact.authority,
        resolve_current_authority_ref: resolver,
        plan_ref: intact.plan,
      }).admission_sha256
    ).toBe(intact.admission.admission_sha256);
    expect(resolver).toHaveBeenCalledWith({
      tenant_id: "tenant",
      project_id: "project",
      run_id: "run-1",
      transition_ref: intact.transition,
    });
    for (const child of [
      "sourceManifest",
      "sourceCustody",
      "finalRevision",
      "obligationRef",
    ] as const) {
      const f = fixture("source_query");
      expect(f.remove(f[child])).toBe(true);
      expect(() =>
        admitScaP07ExecutionPlan({
          store: f.store,
          transition_ref: f.transition,
          authority_ref: f.authority,
          resolve_current_authority_ref: () => f.authority,
          plan_ref: f.plan,
        })
      ).toThrow("exact ref absent");
    }
  });
  it("refuses missing, stale, cross-bound authority and mutated plan/request", async () => {
    const f = fixture("source_query");
    expect(() =>
      admitScaP07ExecutionPlan({
        store: f.store,
        transition_ref: f.transition,
        authority_ref: f.transition,
        resolve_current_authority_ref: () => f.transition,
        plan_ref: f.plan,
      })
    ).toThrow();
    const alien = f.save(
      "sca-p07-execution-authority",
      withP07Digest(
        {
          schema_id: SCA_P07_EXECUTION_AUTHORITY_SCHEMA,
          schema_version: 1,
          tenant_id: "other",
          project_id: "project",
          run_id: "run-1",
          transition_ref: f.transition,
          bindings: [
            {
              action_record_ref: f.action,
              operation: "source_query",
              broker_request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
              source_snapshot_ref: f.source,
              config_ref: f.config,
              input_refs: [],
            },
          ],
        },
        "authority_sha256"
      ),
      "SCA-P07",
      "alien"
    );
    expect(() =>
      admitScaP07ExecutionPlan({
        store: f.store,
        transition_ref: f.transition,
        authority_ref: alien,
        resolve_current_authority_ref: () => alien,
        plan_ref: f.plan,
      })
    ).toThrow();
    const driftedStore: ArtifactHostStore = {
      ...f.store,
      readById: (id) =>
        id === f.source.artifact_id ? Buffer.from("stale bytes") : f.store.readById(id),
    };
    expect(() =>
      admitScaP07ExecutionPlan({
        store: driftedStore,
        transition_ref: f.transition,
        authority_ref: f.authority,
        resolve_current_authority_ref: () => f.authority,
        plan_ref: f.plan,
      })
    ).toThrow("bytes drifted");
    const changed = { ...f.hostRequest, broker_request: { ...f.brokerRequest, job_id: "other" } };
    expect(() => validateScaP07HostRequestV1(changed)).toThrow();
    const mutatedBroker = { ...f.brokerRequest, job_id: "other" };
    const unauthorizedPlan = f.save(
      "sca-p07-execution-plan",
      withP07Digest(
        {
          schema_id: SCA_P07_EXECUTION_PLAN_SCHEMA,
          schema_version: 1,
          transition_ref: f.transition,
          authority_ref: f.authority,
          items: [
            {
              action_record_ref: f.action,
              broker_request: mutatedBroker,
              broker_request_sha256: scaBrokerExecuteRequestSha256(mutatedBroker),
            },
          ],
        },
        "plan_sha256"
      ),
      "SCA-P07",
      "unauthorized-plan"
    );
    expect(() =>
      admitScaP07ExecutionPlan({
        store: f.store,
        transition_ref: f.transition,
        authority_ref: f.authority,
        resolve_current_authority_ref: () => f.authority,
        plan_ref: unauthorizedPlan,
      })
    ).toThrow();
    const rehashed = validateScaP07HostRequestV1(
      withP07Digest(
        {
          schema_id: SCA_P07_HOST_REQUEST_SCHEMA,
          schema_version: 1,
          plan_ref: f.plan,
          admission_ref: f.admissionRef,
          item_index: 0,
          action_record_ref: f.action,
          broker_request: mutatedBroker,
          broker_request_sha256: scaBrokerExecuteRequestSha256(mutatedBroker),
        },
        "request_sha256"
      )
    );
    const adapter = createScaP07HostAdapter({
      client: {
        execute: vi.fn(async () => {
          throw new Error("model/remote must not start");
        }),
        poll: vi.fn(async () => {
          throw new Error("not polled");
        }),
        cancel: vi.fn(async () => {
          throw new Error("not cancelled");
        }),
      },
      backend_key_sha256: H,
      assertCurrentAdmission: vi.fn(),
    });
    const context = fakeContext(f).context;
    await expect(
      adapter.run({ ...context, request_bytes: Buffer.from(canonicalJson(rehashed)) })
    ).rejects.toThrow("admitted plan");
    const stale = f.save(
      "sca-p07-execution-authority",
      withP07Digest(
        {
          schema_id: SCA_P07_EXECUTION_AUTHORITY_SCHEMA,
          schema_version: 1,
          tenant_id: "tenant",
          project_id: "project",
          run_id: "run-1",
          transition_ref: f.transition,
          bindings: [
            {
              action_record_ref: f.action,
              operation: "source_query",
              broker_request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
              source_snapshot_ref: f.source,
              config_ref: f.source,
              input_refs: [],
            },
          ],
        },
        "authority_sha256"
      ),
      "SCA-P07",
      "stale"
    );
    expect(() =>
      admitScaP07ExecutionPlan({
        store: f.store,
        transition_ref: f.transition,
        authority_ref: stale,
        resolve_current_authority_ref: () => f.authority,
        plan_ref: f.plan,
      })
    ).toThrow();
  });
  it("fails closed on no-authority and blocked action even with rehashed records", () => {
    const f = fixture("source_query");
    const noAuthority = f.save(
      "sca-p07-execution-authority",
      withP07Digest(
        {
          schema_id: SCA_P07_EXECUTION_AUTHORITY_SCHEMA,
          schema_version: 1,
          tenant_id: "tenant",
          project_id: "project",
          run_id: "run-1",
          transition_ref: f.transition,
          bindings: [],
        },
        "authority_sha256"
      ),
      "SCA-P07",
      "empty"
    );
    expect(() =>
      admitScaP07ExecutionPlan({
        store: f.store,
        transition_ref: f.transition,
        authority_ref: noAuthority,
        resolve_current_authority_ref: () => noAuthority,
        plan_ref: f.plan,
      })
    ).toThrow();
    const { gate_sha256: _gateDigest, ...gateBody } = validateScaP06GateV1(
      parseUnknown(f.store.readById(f.gate.artifact_id).toString("utf8"))
    );
    const blocked = withP06SelfDigest(
      {
        ...gateBody,
        verdict: "pass_blocked",
        blocked_action_count: 1,
        blocker_codes: ["p06_no_authorized_action"],
      },
      "gate_sha256"
    );
    const blockedRef = f.save("sca-p06-gate", blocked, "SCA-P06", "blocked");
    const { transition_sha256: _transitionDigest, ...transitionBody } =
      validateScaP06ToP07TransitionV1(
        parseUnknown(f.store.readById(f.transition.artifact_id).toString("utf8"))
      );
    const changedTransition = withP06SelfDigest(
      {
        ...transitionBody,
        p06_gate_ref: blockedRef,
      },
      "transition_sha256"
    );
    const changedRef = f.save("sca-p06-to-p07-transition", changedTransition, "SCA-P06", "blocked");
    const { authority_sha256: _authorityDigest, ...authorityBody } =
      validateScaP07ExecutionAuthorityV1(
        parseUnknown(f.store.readById(f.authority.artifact_id).toString("utf8"))
      );
    const blockedAuthority = f.save(
      "sca-p07-execution-authority",
      withP07Digest({ ...authorityBody, transition_ref: changedRef }, "authority_sha256"),
      "SCA-P07",
      "blocked"
    );
    const { plan_sha256: _planDigest, ...planBody } = validatePlan(f);
    const blockedPlan = f.save(
      "sca-p07-execution-plan",
      withP07Digest(
        { ...planBody, transition_ref: changedRef, authority_ref: blockedAuthority },
        "plan_sha256"
      ),
      "SCA-P07",
      "blocked"
    );
    expect(() =>
      admitScaP07ExecutionPlan({
        store: f.store,
        transition_ref: changedRef,
        authority_ref: blockedAuthority,
        resolve_current_authority_ref: () => blockedAuthority,
        plan_ref: blockedPlan,
      })
    ).toThrow("gate is blocked");
  });
  it("rechecks current admission at use time before broker I/O", async () => {
    const f = fixture("source_query");
    const execute = vi.fn(async () => {
      throw new Error("must not execute");
    });
    const adapter = createScaP07HostAdapter({
      client: {
        execute,
        poll: vi.fn(async () => {
          throw new Error("must not poll");
        }),
        cancel: vi.fn(async () => {
          throw new Error("must not cancel");
        }),
      },
      backend_key_sha256: H,
      assertCurrentAdmission: vi.fn(() => {
        throw new Error("P07 admission superseded");
      }),
    });
    await expect(adapter.run(fakeContext(f).context)).rejects.toThrow("superseded");
    expect(execute).not.toHaveBeenCalled();
  });
  it("replays submitted and fetched without resubmission; validates successful and failed terminal receipts", async () => {
    const f = fixture("source_query");
    const output = f.save("sca-output", { done: true });
    const execute = vi.fn(async () => ({
      schema_id: "penny.sca-broker-execute-accepted-result.v1" as const,
      schema_version: 1 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: "run-1",
      job_id: "job-1",
      attempt: 1,
      idempotency_key: "key-1",
      tool_name: "sca_source_query" as const,
      operation: "source_query" as const,
      status: "accepted" as const,
      request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
      accepted_at: now,
    }));
    let status: "succeeded" | "failed" = "succeeded";
    const poll = vi.fn(async (request: { requested_at: string }) => ({
      schema_id: "penny.sca-broker-poll-result.v1" as const,
      schema_version: 1 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: "run-1",
      job_id: "job-1",
      attempt: 1,
      idempotency_key: "key-1",
      tool_name: "sca_source_query" as const,
      operation: "source_query" as const,
      request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
      status,
      partial: false,
      truncated: false,
      output_refs: status === "succeeded" ? [output] : [],
      result_item_count: status === "succeeded" ? 1 : 0,
      failure: status === "failed" ? { code: "failed" as const, message: "failed" } : null,
      receipt: receipt(f.brokerRequest, status, output),
      observed_at: request.requested_at,
    }));
    const adapter = createScaP07HostAdapter({
      client: {
        execute,
        poll,
        cancel: vi.fn(async () => {
          throw new Error("no cancellation");
        }),
      },
      backend_key_sha256: H,
      assertCurrentAdmission: vi.fn(),
      now: () => new Date(now),
    });
    const harness = fakeContext(f);
    const result = await adapter.run(harness.context);
    expect(result.disposition.outcome).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.fetched).toHaveLength(1);
    const replay = fakeContext(f, "fetched", first(harness.cached));
    const repeated = await adapter.run(replay.context);
    expect(repeated.disposition.outcome).toBe("completed");
    const persisting = fakeContext(f, "persisting", first(harness.cached));
    expect((await adapter.run(persisting.context)).disposition.outcome).toBe("completed");
    const cachePublished = fakeContext(f, "submitted", first(harness.cached));
    expect((await adapter.run(cachePublished.context)).disposition.outcome).toBe("completed");
    expect(cachePublished.fetched).toHaveLength(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const submitted = fakeContext(f, "submitted");
    status = "failed";
    const failed = await adapter.run(submitted.context);
    expect(failed.disposition).toMatchObject({
      outcome: "remote_unknown",
      remote_disposition: "may_continue",
      lease_disposition: "quarantined",
      reason_code: "broker_failure_containment_unproven",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });
  it("renews inactivity only when authenticated broker progress advances", async () => {
    const f = fixture("source_query");
    const output = f.save("sca-output", { done: true });
    const progress = (
      sequence: number,
      phase: "accepted" | "executing" | "materializing_output"
    ) => ({
      schema_id: "penny.sca-broker-job-progress.v1" as const,
      schema_version: 1 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: "run-1",
      job_id: "job-1",
      attempt: 1,
      idempotency_key: "key-1",
      tool_name: "sca_source_query" as const,
      operation: "source_query" as const,
      request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
      sequence,
      phase,
      work_units: 0,
      output_bytes: phase === "materializing_output" ? output.byte_length : 0,
      result_items: phase === "materializing_output" ? 1 : 0,
    });
    const execute = vi.fn(async () => ({
      schema_id: "penny.sca-broker-execute-accepted-result.v2" as const,
      schema_version: 2 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: "run-1",
      job_id: "job-1",
      attempt: 1,
      idempotency_key: "key-1",
      tool_name: "sca_source_query" as const,
      operation: "source_query" as const,
      status: "accepted" as const,
      request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
      accepted_at: now,
      progress: progress(0, "accepted"),
    }));
    let polls = 0;
    const poll = vi.fn(async (request: { requested_at: string }) => {
      polls += 1;
      const terminal = polls === 2;
      return {
        schema_id: "penny.sca-broker-poll-result.v2" as const,
        schema_version: 2 as const,
        tenant_id: "tenant",
        project_id: "project",
        run_id: "run-1",
        job_id: "job-1",
        attempt: 1,
        idempotency_key: "key-1",
        tool_name: "sca_source_query" as const,
        operation: "source_query" as const,
        request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
        status: terminal ? ("succeeded" as const) : ("running" as const),
        progress: progress(polls, terminal ? "materializing_output" : "executing"),
        partial: false,
        truncated: false,
        output_refs: terminal ? [output] : [],
        result_item_count: terminal ? 1 : 0,
        failure: null,
        receipt: terminal ? receipt(f.brokerRequest, "succeeded", output) : null,
        observed_at: request.requested_at,
      };
    });
    const adapter = createScaP07HostAdapter({
      client: {
        execute,
        poll,
        cancel: vi.fn(async () => {
          throw new Error("no cancellation");
        }),
      },
      backend_key_sha256: H,
      assertCurrentAdmission: vi.fn(),
      now: () => new Date(now),
    });
    const harness = fakeContext(f);
    expect((await adapter.run(harness.context)).disposition.outcome).toBe("completed");
    expect(harness.context.reportActivity).toHaveBeenCalledTimes(2);
    expect(harness.context.emitProgress).toHaveBeenCalledTimes(2);
  });
  it("quarantines sequence-only broker updates without renewing inactivity", async () => {
    const f = fixture("source_query");
    const baseProgress = {
      schema_id: "penny.sca-broker-job-progress.v1" as const,
      schema_version: 1 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: "run-1",
      job_id: "job-1",
      attempt: 1,
      idempotency_key: "key-1",
      tool_name: "sca_source_query" as const,
      operation: "source_query" as const,
      request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
      phase: "accepted" as const,
      work_units: 0,
      output_bytes: 0,
      result_items: 0,
    };
    const adapter = createScaP07HostAdapter({
      client: {
        execute: vi.fn(async () => ({
          schema_id: "penny.sca-broker-execute-accepted-result.v2" as const,
          schema_version: 2 as const,
          tenant_id: "tenant",
          project_id: "project",
          run_id: "run-1",
          job_id: "job-1",
          attempt: 1,
          idempotency_key: "key-1",
          tool_name: "sca_source_query" as const,
          operation: "source_query" as const,
          status: "accepted" as const,
          request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
          accepted_at: now,
          progress: { ...baseProgress, sequence: 0 },
        })),
        poll: vi.fn(async (request: { requested_at: string }) => ({
          schema_id: "penny.sca-broker-poll-result.v2" as const,
          schema_version: 2 as const,
          tenant_id: "tenant",
          project_id: "project",
          run_id: "run-1",
          job_id: "job-1",
          attempt: 1,
          idempotency_key: "key-1",
          tool_name: "sca_source_query" as const,
          operation: "source_query" as const,
          request_sha256: scaBrokerExecuteRequestSha256(f.brokerRequest),
          status: "accepted" as const,
          progress: { ...baseProgress, sequence: 1 },
          partial: false,
          truncated: false,
          output_refs: [],
          result_item_count: 0,
          failure: null,
          receipt: null,
          observed_at: request.requested_at,
        })),
        cancel: vi.fn(async () => {
          throw new Error("no cancellation");
        }),
      },
      backend_key_sha256: H,
      assertCurrentAdmission: vi.fn(),
      now: () => new Date(now),
    });
    const harness = fakeContext(f);
    expect((await adapter.run(harness.context)).disposition).toMatchObject({
      outcome: "remote_unknown",
      lease_disposition: "quarantined",
    });
    expect(harness.context.reportActivity).not.toHaveBeenCalled();
    expect(harness.context.emitProgress).not.toHaveBeenCalled();
  });
  it("rejects a terminal receipt bound to a different broker request", () => {
    const f = fixture("application_test");
    const output = f.save("sca-output", { done: true });
    const forged = { ...receipt(f.brokerRequest, "succeeded", output), request_sha256: H };
    expect(() =>
      validateScaP07HostResultV1(
        withP07Digest(
          {
            schema_id: SCA_P07_HOST_RESULT_SCHEMA,
            schema_version: 1,
            request_sha256: f.hostRequest.request_sha256,
            plan_ref: f.plan,
            admission_ref: f.admissionRef,
            action_record_ref: f.action,
            receipt: forged,
          },
          "result_sha256"
        ),
        f.hostRequest
      )
    ).toThrow("exact request");
  });
  it("quarantines remote-unknown, fails closed on cancellation and has no active registration", async () => {
    const f = fixture("graph_query");
    const adapter = createScaP07HostAdapter({
      client: {
        execute: vi.fn(async () => {
          throw new Error("must not submit");
        }),
        poll: vi.fn(async () => {
          throw new Error("remote unavailable");
        }),
        cancel: vi.fn(async () => {
          throw new Error("unknown");
        }),
      },
      backend_key_sha256: H,
      assertCurrentAdmission: vi.fn(),
      now: () => new Date(now),
    });
    const unknown = fakeContext(f, "submitted");
    expect((await adapter.run(unknown.context)).disposition.lease_disposition).toBe("quarantined");
    expect(unknown.cancellation).toHaveLength(1);
    expect(
      (await first(unknown.cancellation)(new AbortController().signal)).remote_disposition
    ).toBe("may_continue");
    const cancelled = fakeContext(f, "submitted");
    cancelled.controller.abort();
    await expect(adapter.run(cancelled.context)).rejects.toThrow("cancelled");
    expect([...PLAYBOOK_REGISTRY.keys()]).not.toContain(SCA_P07_OPERATION_KIND);
    const activeSca = PLAYBOOK_REGISTRY.get("sca");
    if (activeSca === undefined || activeSca.worker.kind !== "catalog-agent") {
      throw new Error("active SCA registration absent");
    }
    expect([...activeSca.worker.phases.keys()]).not.toContain("p07");
    expect(canonicalJson(declaration)).not.toContain("model");
  });
});
function validatePlan(f: ReturnType<typeof fixture>) {
  const parsed: unknown = JSON.parse(f.store.readById(f.plan.artifact_id).toString("utf8"));
  return validateScaP07ExecutionPlanV1(parsed);
}
function fakeContext(
  f: ReturnType<typeof fixture>,
  lifecycle: "prepared" | "submitted" | "fetched" | "persisting" = "prepared",
  cached?: Uint8Array
) {
  const controller = new AbortController();
  const fetched: unknown[] = [];
  const cancellation: Parameters<
    HostOperationExecutionContextV1["registerRemoteCancellation"]
  >[0][] = [];
  const cache: Uint8Array[] = cached === undefined ? [] : [cached];
  const directive = first(
    scaP07HostDirectives({
      plan: validatePlan(f),
      plan_ref: f.plan,
      admission: f.admission,
      admission_ref: f.admissionRef,
      requests: [{ ref: f.hostRef, value: f.hostRequest }],
      identity: {
        schema_version: 2,
        run_id: "run-1",
        session_id: "session",
        playbook: "sca",
        engine_owner: "typescript",
      },
      state_id: "p07",
      attempt: 1,
      registration_sha256: H,
      declaration,
      backend_key_sha256: H,
    })
  );
  const context: HostOperationExecutionContextV1 = {
    directive,
    declaration,
    request_bytes: Buffer.from(canonicalJson(f.hostRequest)),
    journal: {
      ...createPreparedHostOperationCallRecord({
        project_id: "project",
        directive,
        queue_inactivity_expires_at_ms: 5000,
        operation_inactivity_expires_at_ms: 30000,
        timestamp: now,
      }),
      lifecycle,
      remote_correlation_id: lifecycle === "prepared" ? null : "job-1",
      remote_correlation_sha256: lifecycle === "prepared" ? null : sha256("job-1"),
      fetched:
        (lifecycle === "fetched" || lifecycle === "persisting") && cached !== undefined
          ? {
              schema_version: 1,
              content_sha256: sha256(cached),
              byte_length: cached.byteLength,
              item_count: 1,
              poll_count: 1,
            }
          : null,
    },
    signal: controller.signal,
    readInput(slot) {
      if (slot === "plan") return { ref: f.plan, bytes: f.store.readById(f.plan.artifact_id) };
      if (slot === "admission")
        return { ref: f.admissionRef, bytes: f.store.readById(f.admissionRef.artifact_id) };
      throw new Error("unknown input");
    },
    beginSubmission: vi.fn(),
    recordRemoteAccepted: vi.fn(),
    registerRemoteCancellation: (callback) => {
      cancellation.push(callback);
    },
    reportActivity: vi.fn(),
    emitProgress: vi.fn(),
    cacheResult: async (bytes) => {
      cache.push(bytes);
      return {
        schema_version: 1,
        request_sha256: f.hostRef.content_digest,
        content_sha256: sha256(bytes),
        byte_length: bytes.byteLength,
        bytes,
      };
    },
    readCachedResult: async () =>
      cached === undefined
        ? null
        : {
            schema_version: 1,
            request_sha256: f.hostRef.content_digest,
            content_sha256: sha256(cached),
            byte_length: cached.byteLength,
            bytes: cached,
          },
    recordFetched: (value) => {
      fetched.push(value);
    },
    persist: () => ({ operation_result_ref: f.hostRef, output_artifacts: [] }),
  };
  return { context, controller, fetched, cached: cache, cancellation };
}
