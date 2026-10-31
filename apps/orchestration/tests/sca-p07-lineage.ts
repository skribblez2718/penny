import type { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import { SCA_P06_OBLIGATION_IDS, withP06SelfDigest } from "../dist/sca/p06-contracts.js";
import { scaP01SourceTreeDigest } from "../dist/sca/p01-contracts.js";
import { withSelfDigest as withP05SelfDigest } from "../dist/sca/p05-contracts.js";
import { admitScaP07ExecutionPlan } from "../dist/sca/p07-admission.js";
import {
  SCA_P07_ADMISSION_SCHEMA,
  SCA_P07_EXECUTION_AUTHORITY_SCHEMA,
  SCA_P07_EXECUTION_PLAN_SCHEMA,
  validateScaP07AdmissionV1,
  validateScaP07ExecutionPlanV1,
  withP07Digest,
  type ScaP07AdmissionV1,
  type ScaP07ExecutionPlanV1,
} from "../dist/sca/p07-contracts.js";
import {
  scaBrokerExecuteRequestSha256,
  type ScaBrokerExecuteRequestV1,
} from "../dist/sca/broker-contracts.js";

/**
 * Focused test-only P06→P07 lineage builder. It deterministically persists one exact admitted
 * P07 execution plan plus the complete P05/P06/P01 custody that admission must resolve, using a
 * real project-bound `ArtifactStore`. It issues no admission authority and calls no model,
 * broker, or VM.
 */
export const SCA_P07_LINEAGE_KINDS = ["source_query", "graph_query", "application_test"] as const;
export type ScaP07LineageKind = (typeof SCA_P07_LINEAGE_KINDS)[number];

const TENANT = "tenant";
const PROJECT = "project";
const SOURCE_RUN = "run-source";
const NOW = "2026-09-26T00:00:00.000Z";

export interface ScaP07LineageV1 {
  readonly run_id: string;
  readonly p06_transition_ref: ArtifactRef;
  readonly authority_ref: ArtifactRef;
  readonly plan_ref: ArtifactRef;
  readonly admission_ref: ArtifactRef;
  readonly plan: ScaP07ExecutionPlanV1;
  readonly admission: ScaP07AdmissionV1;
}

function hypothesisHex(index: number): string {
  return sha256(`sca-p07-lineage-hypothesis-${index}`);
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
    producer: input.producer ?? "host:sca-p07-lineage",
    media_type: "application/json",
    content_schema: {
      schema_id: input.schema_id,
      schema_version: input.schema_version ?? 1,
    },
    parent_ref: null,
    upstream_refs: [...(input.upstream_refs ?? [])],
  };
  const ref = input.store.persist({ metadata, content: canonicalJson(input.value) });
  return ref;
}

function claim(atom: string, text: string) {
  return { claim: text, evidence_atom_ids: [atom] };
}

function hypothesisBody(index: number) {
  const hex = hypothesisHex(index);
  const atom = `p05a_${hex}`;
  const supporting = `p05o_${hex}_supporting_0001`;
  const refuting = `p05o_${hex}_refuting_0001`;
  return {
    hypothesis_id: `p05h_${hex}`,
    selected_item_id: `p04i_${hex}`,
    bounded_claim: `Bounded claim ${index} may affect a security-sensitive outcome.`,
    actor: claim(atom, "An untrusted actor controls input."),
    controlled_input: claim(atom, "The actor controls a bounded value."),
    relevant_state: claim(atom, "The value reaches relevant state."),
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
    security_sensitive_outcome: claim(atom, "The sink could expose protected state."),
    competing_benign_explanation: {
      explanation: "Validation may reject the value.",
      discriminating_observation: "Inspect the validation path.",
      evidence_atom_ids: [atom],
    },
    expected_supporting_observations: [
      {
        observable_id: supporting,
        observation: "No validation precedes the sink.",
        expected_if_claim: true,
        evidence_mode: "source" as const,
        basis_atom_ids: [atom],
      },
    ],
    expected_refuting_observations: [
      {
        observable_id: refuting,
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
}

export function buildScaP07Lineage(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly kinds: readonly ScaP07LineageKind[];
  /**
   * Deterministic RFC 3339 base instant for every recorded timestamp. The default keeps the
   * original frozen fixture output; a real socket regression may pass a wall-clock-relative
   * instant so its broker request window is still open when the transport executes.
   */
  readonly now?: string;
}): ScaP07LineageV1 {
  const { store, run_id: runId } = input;
  const baseInstant = input.now ?? NOW;
  const deadline = new Date(Date.parse(baseInstant) + 10_000).toISOString();
  if (input.kinds.length < 1 || input.kinds.length > 8) {
    throw new Error("SCA P07 lineage fixture supports 1..8 actions");
  }
  const sourceBytes = Buffer.from("export const value = 1;\n");
  const sourceIdentity = {
    path: "src/value.ts",
    byte_count: sourceBytes.byteLength,
    content_sha256: sha256(sourceBytes),
  };
  const sourceScope = { include_paths: ["src"], exclude_paths: [] };
  const sourceTree = scaP01SourceTreeDigest([sourceIdentity]);
  const sourceManifest = save({
    store,
    run_id: SOURCE_RUN,
    phase: "SCA-P01-source",
    kind: "sca-p01-source-file-manifest",
    operation_id: "source-manifest",
    schema_id: "penny.sca-p01-source-file-manifest.v1",
    producer: "host:source-custody",
    value: {
      schema_id: "penny.sca-p01-source-file-manifest.v1",
      schema_version: 1,
      snapshot_id: "snapshot-1",
      scope: sourceScope,
      files: [sourceIdentity],
      file_count: 1,
      byte_count: sourceBytes.byteLength,
      tree_sha256: sourceTree,
    },
  });
  const sourceCustody = save({
    store,
    run_id: SOURCE_RUN,
    phase: "SCA-P01-source",
    kind: "sca-p01-source-custody-corpus",
    operation_id: "source-custody",
    schema_id: "penny.sca-p01-source-custody-corpus.v1",
    producer: "host:source-custody",
    value: {
      schema_id: "penny.sca-p01-source-custody-corpus.v1",
      schema_version: 1,
      custody_id: "custody-1",
      snapshot_id: "snapshot-1",
      file_manifest_ref: sourceManifest,
      files: [
        { ...sourceIdentity, encoding: "base64", content_base64: sourceBytes.toString("base64") },
      ],
      file_count: 1,
      byte_count: sourceBytes.byteLength,
      tree_sha256: sourceTree,
      sealed: true,
    },
  });
  const sourceSnapshotValue = {
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
  const source = save({
    store,
    run_id: SOURCE_RUN,
    phase: "SCA-P01-source",
    kind: "source-snapshot",
    operation_id: "source-snapshot",
    schema_id: "penny.sca-campaign-source-snapshot.v2",
    schema_version: 2,
    producer: "host:source-custody",
    value: sourceSnapshotValue,
  });
  const brokerSource = save({
    store,
    run_id: runId,
    phase: "SCA-P01-source",
    kind: "source-snapshot",
    operation_id: "source-snapshot-p07",
    schema_id: "penny.sca-campaign-source-snapshot.v2",
    schema_version: 2,
    producer: "host:source-custody",
    value: sourceSnapshotValue,
  });
  const config = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-config",
    operation_id: "sca-config",
    schema_id: "penny.sca-config.v1",
    value: { config: true },
  });
  const graph = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-graph",
    operation_id: "sca-graph",
    schema_id: "penny.sca-graph.v1",
    value: { graph: true },
  });
  const execution = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-execution-plan",
    operation_id: "sca-execution-plan",
    schema_id: "penny.sca-execution-plan.v1",
    value: { execution: true },
  });
  const policy = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-execution-policy",
    operation_id: "sca-execution-policy",
    schema_id: "penny.sca-execution-policy.v1",
    value: { policy: true },
  });
  const p05Transition = save({
    store,
    run_id: runId,
    phase: "SCA-P05",
    kind: "sca-p05-to-p06-transition",
    operation_id: "sca-p05-to-p06-transition",
    schema_id: "penny.sca-p05-to-p06-transition.v1",
    value: { transition: true },
  });

  const bases = input.kinds.map((kind, index) => {
    const body = hypothesisBody(index);
    const atom = `p05a_${hypothesisHex(index)}`;
    const supporting = `p05o_${hypothesisHex(index)}_supporting_0001`;
    const finalRevisionValue = withP05SelfDigest(
      {
        schema_id: "penny.sca-p05-hypothesis-revision.v1",
        schema_version: 1,
        hypothesis_id: body.hypothesis_id,
        revision: 1,
        parent_revision_ref: null,
        parent_revision_sha256: null,
        body,
        body_sha256: sha256(canonicalJson(body)),
        source_snapshot_ref: source,
        source_snapshot_sha256: source.content_digest,
        p04_transition_ref: p05Transition,
        selected_item_id: body.selected_item_id,
        cognitive_payload_ref: config,
        model_output_ref: config,
        evidence_atom_ids: [atom],
        change_reason_codes: ["initial_construction"],
        changed_fields: [],
        created_at: baseInstant,
      },
      "revision_sha256"
    );
    const finalRevision = save({
      store,
      run_id: runId,
      phase: "SCA-P05",
      kind: "sca-p05-hypothesis-revision",
      operation_id: `sca-p05-revision-${index}`,
      schema_id: "penny.sca-p05-hypothesis-revision.v1",
      value: finalRevisionValue,
    });
    const obligationId = `p06obl_${hypothesisHex(index)}_evidence_decision_0001`;
    const obligationValue = withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-obligation-revision.v1",
        schema_version: 1,
        obligation_id: obligationId,
        revision: 1,
        parent_revision_ref: null,
        parent_revision_sha256: null,
        discovery_reassessment_ref: null,
        discovery_reassessment_sha256: null,
        hypothesis_id: body.hypothesis_id,
        final_hypothesis_revision_ref: finalRevision,
        class: "required-result",
        purpose: "Resolve the next discriminating evidence question.",
        source_mandate: "Use the accepted P05 hypothesis and exact source snapshot.",
        assigning_authority: "host_from_accepted_p05_hypothesis",
        rationale: "The accepted hypothesis requires one bounded next evidence action.",
        supporting_observable_ids: [supporting],
        registered_before_action: true,
        status: "pending",
        created_at: baseInstant,
      },
      "revision_sha256"
    );
    const obligationRef = save({
      store,
      run_id: runId,
      phase: "SCA-P06",
      kind: "sca-p06-obligation-revision",
      operation_id: `sca-p06-obligation-${index}`,
      schema_id: "penny.sca-p06-obligation-revision.v1",
      value: obligationValue,
    });
    return {
      kind,
      index,
      body,
      atom,
      supporting,
      finalRevision,
      finalRevisionValue,
      obligationId,
      obligationRef,
    };
  });

  const sortedBases = [...bases].sort((left, right) =>
    left.body.hypothesis_id.localeCompare(right.body.hypothesis_id)
  );
  const p06AuthorityRef = save({
    store,
    run_id: runId,
    phase: "SCA-P06",
    kind: "sca-p06-action-authority",
    operation_id: "sca-p06-action-authority",
    schema_id: "penny.sca-p06-action-authority.v1",
    value: withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-action-authority.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        tenant_id: TENANT,
        project_id: PROJECT,
        run_id: runId,
        source_snapshot_sha256: source.content_digest,
        p05_transition_ref: p05Transition,
        hypothesis_authorities: sortedBases.map((base) => ({
          hypothesis_id: base.body.hypothesis_id,
          final_revision_ref: base.finalRevision,
          modes: (["source_query", "graph_query", "application_test"] as const).map((mode) => ({
            action_kind: mode,
            authority_id: `auth-${mode}`,
            decision: "approved",
            reason_code: "approved",
            scope: "p06_decision_only_not_p07_execution_authority",
          })),
        })),
        issued_at: baseInstant,
      },
      "authority_sha256"
    ),
  });
  const p06PolicyRef = save({
    store,
    run_id: runId,
    phase: "SCA-P06",
    kind: "sca-p06-resource-policy",
    operation_id: "sca-p06-resource-policy",
    schema_id: "penny.sca-p06-resource-policy.v1",
    value: withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-resource-policy.v1",
        schema_version: 1,
        run_id: runId,
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
    ),
  });

  const items = bases.map((base) => {
    const { kind, index } = base;
    const classification =
      kind === "source_query"
        ? ("source_sufficient" as const)
        : kind === "graph_query"
          ? ("graph_needed" as const)
          : ("runtime_needed" as const);
    const evidenceMode =
      kind === "source_query" ? "source" : kind === "graph_query" ? "graph" : "application";
    const inputs =
      kind === "source_query"
        ? []
        : kind === "graph_query"
          ? [graph]
          : [execution, policy].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
    const tool =
      kind === "source_query"
        ? "sca_source_query"
        : kind === "graph_query"
          ? "sca_graph_query"
          : "sca_application_test";
    const operationInput =
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
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: runId,
      job_id: `job-${index}`,
      attempt: 1,
      idempotency_key: `key-${index}`,
      tool_name: tool,
      operation: kind,
      submitted_at: baseInstant,
      deadline_at: deadline,
      limits: { timeout_ms: 1000, max_output_bytes: 4096, max_result_items: 10 },
      source_snapshot_ref: brokerSource,
      config_ref: config,
      input_refs: inputs,
      operation_input: operationInput,
    } satisfies ScaBrokerExecuteRequestV1;
    const action = save({
      store,
      run_id: runId,
      phase: "SCA-P06",
      kind: "sca-p06-action-record",
      operation_id: `sca-p06-action-${index}`,
      schema_id: "penny.sca-p06-action-record.v1",
      value: withP06SelfDigest(
        {
          schema_id: "penny.sca-p06-action-record.v1",
          schema_version: 1,
          phase_id: "SCA-P06",
          action_id: `p06act_${hypothesisHex(index)}`,
          hypothesis_id: base.body.hypothesis_id,
          final_hypothesis_revision_ref: base.finalRevision,
          final_hypothesis_revision_sha256: base.finalRevisionValue.revision_sha256,
          exact_question: "Which path?",
          considered_alternatives: (
            ["source_query", "graph_query", "application_test"] as const
          ).map((mode, order) => ({
            action_kind: mode,
            evidence_mode:
              mode === "source_query" ? "source" : mode === "graph_query" ? "graph" : "application",
            consequence_rank: order + 1,
            capability: "capable",
            authority_decision: "approved",
            authority_id: `auth-${mode}`,
            resource_profile_id: `profile-${mode}`,
            expected_information_gain: "high",
            rationale: "discriminates",
          })),
          discriminating_observable: {
            observable_ids: [base.supporting],
            observable_records: [
              {
                observable_id: base.supporting,
                observation: "path",
                expected_if_claim: true,
                evidence_mode: "source",
                basis_atom_ids: [base.atom],
              },
            ],
            target: "path",
            expected_change_to_judgment: "resolves",
          },
          authority_ref: p06AuthorityRef,
          authority_sha256: p06AuthorityRef.content_digest,
          resource_policy_ref: p06PolicyRef,
          resource_policy_sha256: p06PolicyRef.content_digest,
          obligation_revision_ref: base.obligationRef,
          obligation_revision_sha256: base.obligationRef.content_digest,
          discovery_reassessment_ref: null,
          discovery_reassessment_sha256: null,
          effective_obligation_id: base.obligationId,
          effective_obligation_class: "required-result",
          decision_classification: classification,
          selected_action: {
            action_kind: kind,
            evidence_mode: evidenceMode,
            target: "bounded target",
            rationale: "discriminating",
            authority_id: `auth-${kind}`,
            resource_profile_id: `profile-${kind}`,
            execution_status: "not_invoked",
            p07_execution_claimed: false,
          },
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
          created_at: baseInstant,
        },
        "record_sha256"
      ),
    });
    return { base, kind, classification, brokerRequest, action };
  });

  const sortedByHypothesis = [...items].sort((left, right) =>
    left.base.body.hypothesis_id.localeCompare(right.base.body.hypothesis_id)
  );
  const sortedActions = [...items].sort((left, right) =>
    left.action.artifact_id.localeCompare(right.action.artifact_id)
  );
  const p06Request = save({
    store,
    run_id: runId,
    phase: "SCA-P06",
    kind: "sca-p06-request",
    operation_id: "sca-p06-request",
    schema_id: "penny.sca-p06-request.v1",
    value: withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-request.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        tenant_id: TENANT,
        project_id: PROJECT,
        run_id: runId,
        p05_transition_ref: p05Transition,
        implementation_identity_ref: config,
        runtime_policy_ref: config,
        action_authority_ref: p06AuthorityRef,
        resource_policy_ref: p06PolicyRef,
        disclosure_scope_ref: config,
        requested_at: baseInstant,
      },
      "request_sha256"
    ),
  });
  const accepted = save({
    store,
    run_id: runId,
    phase: "SCA-P06",
    kind: "sca-p06-accepted-cohort",
    operation_id: "sca-p06-accepted-cohort",
    schema_id: "penny.sca-p06-accepted-cohort.v1",
    value: withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-accepted-cohort.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        run_id: runId,
        p06_request_ref: p06Request,
        p05_transition_ref: p05Transition,
        p05_gate_ref: config,
        p05_successor_ledger_ref: config,
        p05_traceability_ref: config,
        p05_evidence_manifest_ref: config,
        source_snapshot_ref: source,
        source_snapshot_sha256: source.content_digest,
        active_hypothesis_ids: sortedBases.map((base) => base.body.hypothesis_id),
        refuted_hypothesis_ids: [],
        final_hypotheses: sortedBases.map((base) => ({
          hypothesis_id: base.body.hypothesis_id,
          selected_item_id: base.body.selected_item_id,
          final_revision_ref: base.finalRevision,
          revision: 1,
          revision_sha256: base.finalRevisionValue.revision_sha256,
          body_sha256: base.finalRevisionValue.body_sha256,
        })),
        runtime_policy_ref: config,
        action_authority_ref: p06AuthorityRef,
        resource_policy_ref: p06PolicyRef,
        disclosure_scope_ref: config,
        admitted_at: baseInstant,
      },
      "cohort_sha256"
    ),
  });
  const trace = save({
    store,
    run_id: runId,
    phase: "SCA-P06",
    kind: "sca-p06-traceability",
    operation_id: "sca-p06-traceability",
    schema_id: "penny.sca-p06-traceability.v1",
    value: withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-traceability.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        active_hypothesis_ids: sortedBases.map((base) => base.body.hypothesis_id),
        rows: sortedByHypothesis.map((item) => ({
          hypothesis_id: item.base.body.hypothesis_id,
          final_hypothesis_revision_ref: item.base.finalRevision,
          base_obligation_ref: item.base.obligationRef,
          effective_obligation_ref: item.base.obligationRef,
          discovery_reassessment_ref: null,
          disposition: "action_selected",
          decision_classification: item.classification,
          action_record_ref: item.action,
          checkpoint_ref: null,
          p07_execution_status: "not_started",
        })),
        action_record_ids: sortedActions
          .map((item) => `p06act_${hypothesisHex(item.base.index)}`)
          .sort(),
        blocked_hypothesis_ids: [],
        checkpointed_hypothesis_ids: [],
        exhaustive: true,
      },
      "traceability_sha256"
    ),
  });
  const manifest = save({
    store,
    run_id: runId,
    phase: "SCA-P06",
    kind: "sca-p06-evidence-manifest",
    operation_id: "sca-p06-evidence-manifest",
    schema_id: "penny.sca-p06-evidence-manifest.v1",
    value: withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-evidence-manifest.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        source_snapshot_ref: source,
        source_snapshot_sha256: source.content_digest,
        evidence_refs: sortedActions.map((item) => item.action),
        artifact_ids: sortedActions.map((item) => item.action.artifact_id),
      },
      "manifest_sha256"
    ),
  });
  const ledger = save({
    store,
    run_id: runId,
    phase: "SCA-P06",
    kind: "sca-p06-successor-ledger",
    operation_id: "sca-p06-successor-ledger",
    schema_id: "penny.sca-p06-successor-ledger.v1",
    value: withP06SelfDigest(
      {
        schema_id: "penny.sca-p06-successor-ledger.v1",
        schema_version: 1,
        phase_id: "SCA-P06",
        run_id: runId,
        predecessor_ledger_ref: config,
        predecessor_ledger_sha256: config.content_digest,
        phase_obligations: SCA_P06_OBLIGATION_IDS.map((id) => ({
          obligation_id: id,
          class: "required-result",
          status: "satisfied",
          evidence_refs: sortedActions.map((item) => item.action),
          blocker_codes: [],
        })),
        evidence_obligations: sortedByHypothesis.map((item) => ({
          obligation_id: item.base.obligationId,
          hypothesis_id: item.base.body.hypothesis_id,
          class: "required-result",
          status: "selected",
          obligation_revision_ref: item.base.obligationRef,
          discovery_reassessment_ref: null,
          action_record_ref: item.action,
          blocker_codes: [],
        })),
        all_p06_decisions_valid: true,
        p07_ready: true,
        pending_phase_ids: ["SCA-P07", "SCA-P08", "SCA-P09", "SCA-P10", "SCA-P11", "SCA-P12"],
        append_only: true,
        release_eligible: false,
        campaign_complete: false,
        campaign_completion_claimed: false,
      },
      "ledger_sha256"
    ),
  });
  const gate = save({
    store,
    run_id: runId,
    phase: "SCA-P06",
    kind: "sca-p06-gate",
    operation_id: "sca-p06-gate",
    schema_id: "penny.sca-p06-gate.v1",
    value: withP06SelfDigest(
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
        action_record_count: items.length,
        blocked_action_count: 0,
        checkpoint_count: 0,
        blocker_codes: [],
        evaluated_at: baseInstant,
      },
      "gate_sha256"
    ),
  });
  const transition = save({
    store,
    run_id: runId,
    phase: "SCA-P06",
    kind: "sca-p06-to-p07-transition",
    operation_id: "sca-p06-to-p07-transition",
    schema_id: "penny.sca-p06-to-p07-transition.v1",
    value: withP06SelfDigest(
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
        action_record_refs: sortedActions.map((item) => item.action),
        discovery_reassessment_refs: [],
        p07_execution_status: "not_started",
        p07_execution_authorized_by_this_transition: false,
        release_eligible: false,
        campaign_complete: false,
      },
      "transition_sha256"
    ),
  });

  const ordered = sortedActions;
  const authority = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-p07-execution-authority",
    operation_id: "sca-p07-execution-authority",
    schema_id: SCA_P07_EXECUTION_AUTHORITY_SCHEMA,
    value: withP07Digest(
      {
        schema_id: SCA_P07_EXECUTION_AUTHORITY_SCHEMA,
        schema_version: 1,
        tenant_id: TENANT,
        project_id: PROJECT,
        run_id: runId,
        transition_ref: transition,
        bindings: ordered.map((item) => ({
          action_record_ref: item.action,
          operation: item.kind,
          broker_request_sha256: scaBrokerExecuteRequestSha256(item.brokerRequest),
          source_snapshot_ref: item.brokerRequest.source_snapshot_ref,
          config_ref: item.brokerRequest.config_ref,
          input_refs: item.brokerRequest.input_refs,
        })),
      },
      "authority_sha256"
    ),
  });
  const planRef = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-p07-execution-plan",
    operation_id: "sca-p07-execution-plan",
    schema_id: SCA_P07_EXECUTION_PLAN_SCHEMA,
    value: withP07Digest(
      {
        schema_id: SCA_P07_EXECUTION_PLAN_SCHEMA,
        schema_version: 1,
        transition_ref: transition,
        authority_ref: authority,
        items: ordered.map((item) => ({
          action_record_ref: item.action,
          broker_request: item.brokerRequest,
          broker_request_sha256: scaBrokerExecuteRequestSha256(item.brokerRequest),
        })),
      },
      "plan_sha256"
    ),
  });
  const admission = admitScaP07ExecutionPlan({
    store,
    transition_ref: transition,
    authority_ref: authority,
    resolve_current_authority_ref: () => authority,
    plan_ref: planRef,
  });
  const admissionRef = save({
    store,
    run_id: runId,
    phase: "SCA-P07",
    kind: "sca-p07-admission",
    operation_id: "sca-p07-admission",
    schema_id: SCA_P07_ADMISSION_SCHEMA,
    value: admission,
  });
  return {
    run_id: runId,
    p06_transition_ref: transition,
    authority_ref: authority,
    plan_ref: planRef,
    admission_ref: admissionRef,
    plan: validateScaP07ExecutionPlanV1(
      JSON.parse(store.readById(planRef.artifact_id).toString("utf8"))
    ),
    admission: validateScaP07AdmissionV1(
      JSON.parse(store.readById(admissionRef.artifact_id).toString("utf8"))
    ),
  };
}
