import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const p05Seam = vi.hoisted(() => ({
  accepted: undefined as unknown,
}));
vi.mock("../dist/sca/p05-admission.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../dist/sca/p05-admission.js")>();
  return {
    ...original,
    admitScaP05Candidate: () => ({ transitive_refs: [] }),
    buildScaP05AcceptedCohort: () => {
      if (p05Seam.accepted === undefined) throw new Error("P05 accepted fixture is absent");
      return p05Seam.accepted;
    },
  };
});

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  ExecutionReceiptSchema,
  validateContract,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../dist/contracts.js";
import { trustedInvocationDigest } from "../dist/receipts.js";
import {
  MODEL_DISPATCH_GUARD_V1_SCHEMA,
  MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
} from "../dist/required-model.js";
import {
  SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P05_CHALLENGER_RESULT_V1_SCHEMA,
  SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
  SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA,
  SCA_P05_GATE_V1_SCHEMA,
  SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
  SCA_P05_OBLIGATION_IDS,
  SCA_P05_REQUIRED_MODEL,
  SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
  SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
  SCA_P05_TRACEABILITY_V1_SCHEMA,
  scaP05EvidenceAtomId,
  scaP05HypothesisId,
  scaP05ObservableId,
  validateScaP05AcceptedCohortV1,
  validateScaP05CognitivePayloadV1,
  validateScaP05ConstructorResultV1,
  validateScaP05DisclosureAdmissionV1,
  validateScaP05EvidenceManifestV1,
  validateScaP05GateV1,
  validateScaP05HypothesisRevisionV1,
  validateScaP05SuccessorLedgerV1,
  validateScaP05ToP06TransitionV1,
  validateScaP05TraceabilityV1,
  withSelfDigest,
  type ScaP05HypothesisBodyV1,
} from "../dist/sca/p05-contracts.js";
import {
  SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
  SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P06_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  SCA_P06_REQUEST_V1_SCHEMA,
  SCA_P06_REQUIRED_MODEL,
  SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
  SCA_P06_RUNTIME_POLICY_V1_SCHEMA,
  validateScaP06AcceptedCohortV1,
  validateScaP06ActionAuthorityV1,
  validateScaP06DisclosureAuthorityV1,
  validateScaP06DisclosureScopeV1,
  validateScaP06ImplementationIdentityV1,
  validateScaP06RequestV1,
  validateScaP06ResourcePolicyV1,
  validateScaP06RuntimePolicyV1,
  withP06SelfDigest,
} from "../dist/sca/p06-contracts.js";
import {
  admitScaP05CompletedCohort,
  admitScaP06Candidate,
  buildScaP06AcceptedCohort,
  scaP06InputArtifacts,
} from "../dist/sca/p06-admission.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  p05Seam.accepted = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p06-admission-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...new Map(refs.map((ref) => [ref.artifact_id, ref])).values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function persistJson(
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
function persistOutput(
  artifacts: ArtifactStore,
  metadata: OutputArtifactMetadata,
  value: unknown
): ArtifactRef {
  return artifacts.persist({ metadata, content: `SUMMARY:${canonicalJson(value)}` });
}
function first<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`${label} is absent`);
  return value;
}
function hypothesis(input: {
  readonly sourceSha: string;
  readonly selectedId: string;
  readonly atomId: string;
}): ScaP05HypothesisBodyV1 {
  return {
    hypothesis_id: scaP05HypothesisId(input.sourceSha, input.selectedId),
    selected_item_id: input.selectedId,
    bounded_claim: "A non-admin actor may reach a protected operation through this bounded path.",
    actor: { claim: "A non-admin actor", evidence_atom_ids: [input.atomId] },
    controlled_input: { claim: "An actor-controlled input", evidence_atom_ids: [input.atomId] },
    relevant_state: { claim: "The actor lacks authorization", evidence_atom_ids: [input.atomId] },
    causal_path: [
      {
        ordinal: 1,
        causal_link: "The input reaches the protected decision.",
        state_before: "Input accepted",
        state_after: "Protected decision reached",
        basis: "observed",
        evidence_atom_ids: [input.atomId],
      },
    ],
    security_sensitive_outcome: {
      claim: "The protected operation may run",
      evidence_atom_ids: [input.atomId],
    },
    competing_benign_explanation: {
      explanation: "A dominating guard may reject every path.",
      discriminating_observation: "Determine whether the guard dominates the operation.",
      evidence_atom_ids: [input.atomId],
    },
    expected_supporting_observations: [
      {
        observable_id: scaP05ObservableId({
          selected_item_id: input.selectedId,
          kind: "supporting",
          ordinal: 1,
        }),
        observation: "A bypassing path exists.",
        expected_if_claim: true,
        evidence_mode: "graph",
        basis_atom_ids: [input.atomId],
      },
    ],
    expected_refuting_observations: [
      {
        observable_id: scaP05ObservableId({
          selected_item_id: input.selectedId,
          kind: "refuting",
          ordinal: 1,
        }),
        observation: "The guard dominates every path.",
        expected_if_claim: false,
        evidence_mode: "graph",
        basis_atom_ids: [input.atomId],
      },
    ],
    next_evidence_need: {
      question: "Does the guard dominate the protected operation?",
      evidence_mode: "graph",
      target: "The guard and protected operation",
      discriminating_result: "A complete bypass exists or every path is dominated.",
    },
    stopping_conditions: {
      supported: "Stop on a complete bypass.",
      refuted: "Stop on complete domination.",
      inconclusive: "Stop when evidence cannot distinguish.",
    },
    reopening_conditions: [
      { trigger: "Source changes.", changed_basis_required: "A new exact source snapshot." },
    ],
  };
}
function modelEvidence(input: {
  readonly artifacts: ArtifactStore;
  readonly runId: string;
  readonly stateId: "forming_hypotheses" | "challenging_hypotheses";
  readonly agent: "ida" | "annie";
  readonly payloadRef: ArtifactRef;
  readonly disclosureRef: ArtifactRef;
  readonly outputKind: "sca-p05-constructor-output" | "sca-p05-challenger-output";
  readonly value: unknown;
}): {
  readonly outputRef: ArtifactRef;
  readonly guardRef: ArtifactRef;
  readonly receiptRef: ArtifactRef;
} {
  const outputMetadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: input.stateId,
    branch_id: null,
    kind: input.outputKind,
    operation_id: input.outputKind,
    version: 1,
    producer: `agent:${input.agent}`,
    media_type: "text/plain",
    content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [input.payloadRef, input.disclosureRef],
  };
  const outputRef = persistOutput(input.artifacts, outputMetadata, input.value);
  const coordinate = {
    run_id: input.runId,
    state_id: input.stateId,
    branch_id: null,
    agent: input.agent,
    attempt: 1,
  };
  const inputArtifacts = {
    schema_version: 2 as const,
    artifacts: [
      { slot: "cognitive_payload", ref: input.payloadRef },
      { slot: "disclosure_admission", ref: input.disclosureRef },
    ],
  };
  const guardRef = persistJson(input.artifacts, {
    runId: input.runId,
    phase: input.stateId,
    kind: "model-dispatch-guard",
    operationId: modelDispatchGuardOperationId(coordinate),
    producer: "host:required-model-runtime",
    schemaId: MODEL_DISPATCH_GUARD_V1_SCHEMA,
    value: {
      schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA,
      schema_version: 1,
      coordinate,
      registration_sha256: "7".repeat(64),
      requested_model: SCA_P05_REQUIRED_MODEL,
      input_artifacts_sha256: sha256(canonicalJson(inputArtifacts)),
      serialized_opening_sha256: "8".repeat(64),
      serialized_opening_byte_length: 100,
      provider_opening_guard: "sca_p05_payload_disclosure_v1",
      guarded_at: "2026-09-22T00:00:01.000Z",
    },
  });
  const executionReceipt = validateContract(
    ExecutionReceiptSchema,
    {
      schema_version: 2,
      receipt_id: `receipt-${input.agent}`,
      run_id: input.runId,
      state_id: input.stateId,
      branch_id: null,
      agent: input.agent,
      attempt: 1,
      worker_id: `worker-${input.agent}`,
      executor: "pi-sdk",
      command: ["pi-sdk", input.agent],
      model: SCA_P05_REQUIRED_MODEL.override,
      requested_model: SCA_P05_REQUIRED_MODEL,
      observed_model: {
        provider: SCA_P05_REQUIRED_MODEL.provider,
        model: SCA_P05_REQUIRED_MODEL.model,
      },
      working_directory: PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
      started_at: "2026-09-22T00:00:01.000Z",
      ended_at: "2026-09-22T00:00:02.000Z",
      exit_code: 0,
      output_digest: outputRef.content_digest,
      output_artifact_ref: outputRef,
      trusted_invocation_digest: trustedInvocationDigest({
        identity: {
          schema_version: 2,
          run_id: input.runId,
          session_id: `session-${input.runId}`,
          playbook: "sca-p05-candidate",
          engine_owner: "typescript",
        },
        state_id: input.stateId,
        branch_id: null,
        agent: input.agent,
        attempt: 1,
        trust_profile: "hardened-untrusted",
        model_override: SCA_P05_REQUIRED_MODEL.override,
        task_sha256: "9".repeat(64),
        input_artifacts: inputArtifacts,
        output_artifact: outputMetadata,
      }),
      signature: `hmac-sha256:${"a".repeat(64)}`,
    },
    "P05 execution receipt fixture"
  );
  const receiptRef = persistJson(input.artifacts, {
    runId: input.runId,
    phase: input.stateId,
    kind: "model-execution-receipt",
    operationId: modelExecutionReceiptOperationId(coordinate),
    producer: "host:required-model-runtime",
    schemaId: MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
    value: {
      schema_id: MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      dispatch_guard_ref: guardRef,
      execution_receipt: executionReceipt,
    },
  });
  return { outputRef, guardRef, receiptRef };
}

function completedP05(
  artifacts: ArtifactStore,
  options: {
    readonly omitChallengerReceiptFromManifest?: boolean;
    readonly mutateFinalRevisionParent?: boolean;
    readonly mutateLedger?: boolean;
    readonly mutateGate?: boolean;
  } = {}
) {
  const runId = "run-p05-completed";
  const selectedId = `p04i_${"1".repeat(64)}`;
  const sourceRef = persistJson(artifacts, {
    runId: "run-source",
    phase: "SCA-P01",
    kind: "source-snapshot",
    operationId: "source-snapshot",
    producer: "host:test",
    schemaId: "penny.test-source.v1",
    value: { source: true },
  });
  const p04TransitionRef = persistJson(artifacts, {
    runId: "run-p04",
    phase: "SCA-P04",
    kind: "sca-p04-to-p05-transition",
    operationId: "sca-p04-to-p05-transition",
    producer: "host:sca-p04-candidate",
    schemaId: "penny.sca-p04-to-p05-transition.v1",
    value: { transition: true },
  });
  const p04GateRef = persistJson(artifacts, {
    runId: "run-p04",
    phase: "SCA-P04",
    kind: "sca-p04-gate",
    operationId: "sca-p04-gate",
    producer: "host:sca-p04-candidate",
    schemaId: "penny.sca-p04-gate.v1",
    value: { gate: true },
  });
  const p04LedgerRef = persistJson(artifacts, {
    runId: "run-p04",
    phase: "SCA-P04",
    kind: "sca-p04-successor-ledger",
    operationId: "sca-p04-successor-ledger",
    producer: "host:sca-p04-candidate",
    schemaId: "penny.sca-p04-successor-ledger.v1",
    value: { ledger: true },
  });
  const p04SelectionRef = persistJson(artifacts, {
    runId: "run-p04",
    phase: "SCA-P04",
    kind: "sca-p04-selection-dossier",
    operationId: "sca-p04-selection-dossier",
    producer: "host:sca-p04-candidate",
    schemaId: "penny.sca-p04-selection-dossier.v1",
    value: { selection: true },
  });
  const implementationRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-implementation-identity",
    operationId: "sca-p05-implementation-identity",
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-implementation-identity.v1",
    value: { identity: true },
  });
  const runtimeRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-runtime-policy",
    operationId: "sca-p05-runtime-policy",
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-runtime-policy.v1",
    value: { policy: true },
  });
  const scopeRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-disclosure-scope",
    operationId: "sca-p05-disclosure-scope",
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-disclosure-scope.v1",
    value: { scope: true },
  });
  const request = withSelfDigest(
    {
      schema_id: "penny.sca-p05-request.v1" as const,
      schema_version: 1 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: runId,
      phase_id: "SCA-P05" as const,
      p04_transition_ref: p04TransitionRef,
      implementation_identity_ref: implementationRef,
      runtime_policy_ref: runtimeRef,
      disclosure_scope_ref: scopeRef,
      requested_at: "2026-09-22T00:00:00.000Z",
    },
    "request_sha256"
  );
  const requestRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-candidate-request",
    operationId: "sca-p05-candidate-request",
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-request.v1",
    value: request,
  });
  const accepted = validateScaP05AcceptedCohortV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P05" as const,
        run_id: runId,
        p05_request_ref: requestRef,
        p04_transition_ref: p04TransitionRef,
        p04_gate_ref: p04GateRef,
        p04_successor_ledger_ref: p04LedgerRef,
        p04_selection_dossier_ref: p04SelectionRef,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        selected_item_ids: [selectedId],
        runtime_policy_ref: runtimeRef,
        disclosure_scope_ref: scopeRef,
        admitted_at: "2026-09-22T00:00:00.000Z",
      },
      "cohort_sha256"
    )
  );
  p05Seam.accepted = accepted;
  const acceptedRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-accepted-cohort",
    operationId: "sca-p05-accepted-cohort",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
    value: accepted,
  });
  const atomValue = "const guarded = true;";
  const atomSelector = "source-segment:p05s_" + "3".repeat(64);
  const atomValueSha = sha256(canonicalJson(atomValue));
  const atomId = scaP05EvidenceAtomId({
    origin_ref: sourceRef,
    selector: atomSelector,
    value_sha256: atomValueSha,
  });
  const body = hypothesis({ sourceSha: sourceRef.content_digest, selectedId, atomId });
  const atoms = [
    {
      atom_id: atomId,
      selected_item_id: selectedId,
      atom_kind: "source_segment" as const,
      origin_ref: sourceRef,
      selector: atomSelector,
      value_sha256: atomValueSha,
      value: atomValue,
    },
  ];
  const item = {
    selected_item_id: selectedId,
    expected_hypothesis_id: body.hypothesis_id,
    normalized_locator: "source:src/auth.ts",
    source_path: "src/auth.ts",
    package_coordinate: null,
    selection_rationale_code: "select_for_p05",
    evidence_atom_ids: [atomId],
  };
  const constructorPayload = validateScaP05CognitivePayloadV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P05" as const,
        call_id: "sca-p05-hypothesis-constructor",
        role: "hypothesis_constructor" as const,
        purpose: "p05_hypothesis_construction" as const,
        required_model: SCA_P05_REQUIRED_MODEL,
        accepted_cohort_ref: acceptedRef,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        assigned_item_ids: [selectedId],
        items: [item],
        evidence_atoms: atoms,
        constructor_result_ref: null,
        constructor_result: null,
        disclosure_scope_ref: scopeRef,
        content_mode: "authorized_segments_and_exact_evidence_atoms" as const,
      },
      "payload_sha256"
    )
  );
  const constructorPayloadRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-cognitive-payload",
    operationId: "sca-p05-constructor-payload",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
    value: constructorPayload,
  });
  const constructorDisclosure = validateScaP05DisclosureAdmissionV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P05" as const,
        call_id: constructorPayload.call_id,
        role: constructorPayload.role,
        purpose: constructorPayload.purpose,
        required_model: SCA_P05_REQUIRED_MODEL,
        disclosure_scope_ref: scopeRef,
        disclosure_scope_sha256: scopeRef.content_digest,
        payload_ref: constructorPayloadRef,
        payload_sha256: constructorPayloadRef.content_digest,
        payload_byte_length: constructorPayloadRef.byte_length,
        serialized_opening_byte_limit: 700_000,
        authorized_segment_ids: [atoms[0]?.selector.replace("source-segment:", "")],
        authorized_atom_ids: [atomId],
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
  const constructorDisclosureRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-disclosure-admission",
    operationId: "sca-p05-constructor-disclosure",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
    value: constructorDisclosure,
  });
  const constructorResult = validateScaP05ConstructorResultV1({
    schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
    schema_version: 1,
    role: "hypothesis_constructor",
    payload_sha256: constructorPayloadRef.content_digest,
    assigned_item_ids: [selectedId],
    items: [{ selected_item_id: selectedId, disposition: "formed", hypothesis: body }],
    complete: true,
  });
  const constructorExecution = modelEvidence({
    artifacts,
    runId,
    stateId: "forming_hypotheses",
    agent: "ida",
    payloadRef: constructorPayloadRef,
    disclosureRef: constructorDisclosureRef,
    outputKind: "sca-p05-constructor-output",
    value: constructorResult,
  });
  const revision = validateScaP05HypothesisRevisionV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
        schema_version: 1 as const,
        hypothesis_id: body.hypothesis_id,
        revision: 1 as const,
        parent_revision_ref: null,
        parent_revision_sha256: null,
        body,
        body_sha256: sha256(canonicalJson(body)),
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        p04_transition_ref: p04TransitionRef,
        selected_item_id: selectedId,
        cognitive_payload_ref: constructorPayloadRef,
        model_output_ref: constructorExecution.outputRef,
        evidence_atom_ids: [atomId],
        change_reason_codes: ["initial_constructor"],
        changed_fields: [],
        created_at: "2026-09-22T00:00:02.000Z",
      },
      "revision_sha256"
    )
  );
  const revisionRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-hypothesis-revision",
    operationId: `sca-p05-${selectedId}-revision-1`,
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
    value: revision,
  });
  const { payload_sha256: _constructorPayloadDigest, ...constructorPayloadBody } =
    constructorPayload;
  const challengerPayload = validateScaP05CognitivePayloadV1(
    withSelfDigest(
      {
        ...constructorPayloadBody,
        call_id: "sca-p05-falsification-challenger",
        role: "falsification_challenger" as const,
        purpose: "p05_falsification_challenge" as const,
        constructor_result_ref: constructorExecution.outputRef,
        constructor_result: constructorResult,
      },
      "payload_sha256"
    )
  );
  const challengerPayloadRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-cognitive-payload",
    operationId: "sca-p05-challenger-payload",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
    value: challengerPayload,
  });
  const { admission_sha256: _constructorAdmissionDigest, ...constructorDisclosureBody } =
    constructorDisclosure;
  const challengerDisclosure = validateScaP05DisclosureAdmissionV1(
    withSelfDigest(
      {
        ...constructorDisclosureBody,
        call_id: challengerPayload.call_id,
        role: challengerPayload.role,
        purpose: challengerPayload.purpose,
        payload_ref: challengerPayloadRef,
        payload_sha256: challengerPayloadRef.content_digest,
        payload_byte_length: challengerPayloadRef.byte_length,
      },
      "admission_sha256"
    )
  );
  const challengerDisclosureRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-disclosure-admission",
    operationId: "sca-p05-challenger-disclosure",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
    value: challengerDisclosure,
  });
  const challengerExecution = modelEvidence({
    artifacts,
    runId,
    stateId: "challenging_hypotheses",
    agent: "annie",
    payloadRef: challengerPayloadRef,
    disclosureRef: challengerDisclosureRef,
    outputKind: "sca-p05-challenger-output",
    value: {
      schema_id: SCA_P05_CHALLENGER_RESULT_V1_SCHEMA,
      schema_version: 1,
      role: "falsification_challenger",
      payload_sha256: challengerPayloadRef.content_digest,
      assigned_item_ids: [selectedId],
      items: [
        {
          selected_item_id: selectedId,
          hypothesis_id: body.hypothesis_id,
          decision: "accept_for_investigation",
          replacement_hypothesis: null,
          changed_fields: [],
          control_atom_ids: [],
          critique: "The bounded hypothesis remains suitable for evidence gathering.",
          counterevidence_sought: "A dominating exact control was sought.",
          unresolved_uncertainties: ["Graph domination remains unresolved."],
          reason_code: "accepted_after_challenge",
          missing_evidence_need: null,
          stop_condition: null,
          reopen_condition: null,
          vulnerability_adjudication: "not_performed",
          safe_claim: false,
        },
      ],
      complete: true,
    },
  });
  let finalRevision = revision;
  let finalRevisionRef = revisionRef;
  if (options.mutateFinalRevisionParent) {
    const { revision_sha256: _initialRevisionDigest, ...revisionBody } = revision;
    const revisedBody: ScaP05HypothesisBodyV1 = {
      ...body,
      bounded_claim: `${body.bounded_claim} Mutated final revision.`,
    };
    finalRevision = validateScaP05HypothesisRevisionV1(
      withSelfDigest(
        {
          ...revisionBody,
          revision: 2 as const,
          parent_revision_ref: p04GateRef,
          parent_revision_sha256: p04GateRef.content_digest,
          body: revisedBody,
          body_sha256: sha256(canonicalJson(revisedBody)),
          cognitive_payload_ref: challengerPayloadRef,
          model_output_ref: challengerExecution.outputRef,
          change_reason_codes: ["challenger_revision"],
          changed_fields: ["bounded_claim"],
          created_at: "2026-09-22T00:00:02.500Z",
        },
        "revision_sha256"
      )
    );
    finalRevisionRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-hypothesis-revision",
      operationId: `sca-p05-${selectedId}-revision-2-mutated-parent`,
      producer: "host:sca-p05-candidate",
      schemaId: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
      value: finalRevision,
    });
  }
  const traceability = validateScaP05TraceabilityV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_TRACEABILITY_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P05" as const,
        selected_item_ids: [selectedId],
        rows: [
          {
            selected_item_id: selectedId,
            disposition: "active_hypothesis" as const,
            hypothesis_id: body.hypothesis_id,
            constructor_output_ref: constructorExecution.outputRef,
            constructor_guard_ref: constructorExecution.guardRef,
            constructor_receipt_ref: constructorExecution.receiptRef,
            initial_revision_ref: revisionRef,
            challenger_output_ref: challengerExecution.outputRef,
            challenger_guard_ref: challengerExecution.guardRef,
            challenger_receipt_ref: challengerExecution.receiptRef,
            final_revision_ref: finalRevisionRef,
            checkpoint_ref: null,
            safe_claim: false as const,
          },
        ],
        active_hypothesis_ids: [body.hypothesis_id],
        refuted_hypothesis_ids: [],
        checkpointed_item_ids: [],
        exhaustive: true as const,
      },
      "traceability_sha256"
    )
  );
  const traceabilityRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-traceability",
    operationId: "sca-p05-traceability",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_TRACEABILITY_V1_SCHEMA,
    value: traceability,
  });
  const evidenceRefs = uniqueRefs([
    requestRef,
    acceptedRef,
    p04TransitionRef,
    p04GateRef,
    p04LedgerRef,
    p04SelectionRef,
    sourceRef,
    constructorPayloadRef,
    constructorDisclosureRef,
    constructorExecution.outputRef,
    constructorExecution.guardRef,
    constructorExecution.receiptRef,
    revisionRef,
    finalRevisionRef,
    challengerPayloadRef,
    challengerDisclosureRef,
    challengerExecution.outputRef,
    challengerExecution.guardRef,
    ...(options.omitChallengerReceiptFromManifest ? [] : [challengerExecution.receiptRef]),
    traceabilityRef,
  ]);
  const manifest = validateScaP05EvidenceManifestV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P05" as const,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        evidence_refs: evidenceRefs,
        artifact_ids: evidenceRefs.map((ref) => ref.artifact_id).sort(),
      },
      "manifest_sha256"
    )
  );
  const manifestRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-evidence-manifest",
    operationId: "sca-p05-evidence-manifest",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA,
    value: manifest,
  });
  const ledger = validateScaP05SuccessorLedgerV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P05" as const,
        run_id: runId,
        predecessor_ledger_ref: p04LedgerRef,
        predecessor_ledger_sha256: p04LedgerRef.content_digest,
        obligations: SCA_P05_OBLIGATION_IDS.map((obligationId, index) => ({
          obligation_id: obligationId,
          class: "required-result" as const,
          status:
            options.mutateLedger && index === 0 ? ("pending" as const) : ("satisfied" as const),
          evidence_refs: options.mutateLedger && index === 0 ? [] : [traceabilityRef, manifestRef],
          blocker_codes: options.mutateLedger && index === 0 ? ["mutated_pending_obligation"] : [],
        })),
        all_required_satisfied: !options.mutateLedger,
        pending_phase_ids: [
          "SCA-P06",
          "SCA-P07",
          "SCA-P08",
          "SCA-P09",
          "SCA-P10",
          "SCA-P11",
          "SCA-P12",
        ] as const,
        append_only: true as const,
        release_eligible: false as const,
        campaign_complete: false as const,
        campaign_completion_claimed: false as const,
      },
      "ledger_sha256"
    )
  );
  const ledgerRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-successor-ledger",
    operationId: "sca-p05-successor-ledger",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
    value: ledger,
  });
  const gate = validateScaP05GateV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_GATE_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P05" as const,
        criterion_id: "AC-P05" as const,
        verdict: options.mutateGate ? ("blocked" as const) : ("pass" as const),
        p04_gate_ref: p04GateRef,
        traceability_ref: traceabilityRef,
        evidence_manifest_ref: manifestRef,
        successor_ledger_ref: ledgerRef,
        exhaustive_accounting: true,
        immutable_revisions_valid: !options.mutateGate,
        disclosure_and_model_evidence_valid: true,
        checkpoint_count: 0,
        blocker_codes: options.mutateGate ? ["mutated_gate_blocker"] : [],
        evaluated_at: "2026-09-22T00:00:03.000Z",
      },
      "gate_sha256"
    )
  );
  const gateRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-gate",
    operationId: "sca-p05-gate",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_GATE_V1_SCHEMA,
    value: gate,
  });
  const transition = validateScaP05ToP06TransitionV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
        schema_version: 1 as const,
        source_phase_id: "SCA-P05" as const,
        target_phase_id: "SCA-P06" as const,
        authorized: true as const,
        qualification_scope: "live_qualified" as const,
        p05_request_ref: requestRef,
        accepted_cohort_ref: acceptedRef,
        traceability_ref: traceabilityRef,
        evidence_manifest_ref: manifestRef,
        successor_ledger_ref: ledgerRef,
        p05_gate_ref: gateRef,
        active_hypothesis_ids: [body.hypothesis_id],
        refuted_hypothesis_ids: [],
        release_eligible: false as const,
        campaign_complete: false as const,
      },
      "transition_sha256"
    )
  );
  const transitionRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-to-p06-transition",
    operationId: "sca-p05-to-p06-transition",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
    value: transition,
  });
  return {
    transitionRef,
    body: finalRevision.body,
    revisionRef: finalRevisionRef,
    challengerExecution,
  };
}

type P06AdmissionMutation =
  | "none"
  | "implementation_metadata"
  | "authority_wrong_run"
  | "authority_wrong_source"
  | "resource_wrong_transition"
  | "authority_missing_hypothesis"
  | "authority_extra_hypothesis"
  | "disclosure_missing_hypothesis"
  | "disclosure_extra_hypothesis"
  | "stale_authority_revision"
  | "stale_disclosure_revision_digest"
  | "stale_disclosure_body_digest"
  | "resource_limit_overflow"
  | "disclosure_runtime_limit_overflow"
  | "disclosure_authority_parity";

const P06_CLOCK = () => new Date("2026-09-22T00:00:04.000Z");

function p06CandidateFixture(artifacts: ArtifactStore, mutation: P06AdmissionMutation = "none") {
  const p05 = completedP05(artifacts);
  const predecessor = admitScaP05CompletedCohort({
    store: artifacts,
    transition_ref: p05.transitionRef,
    trusted_clock: P06_CLOCK,
  });
  const runId = "run-p06-admission";
  const sourceSha = predecessor.accepted_cohort.source_snapshot_sha256;
  const sourceRef = predecessor.accepted_cohort.source_snapshot_ref;
  const finalHypotheses = predecessor.final_hypotheses;
  const firstFinal = first(finalHypotheses, "P06 final hypothesis binding");
  const fakeHypothesisId = `p05h_${
    firstFinal.hypothesis_id === `p05h_${"f".repeat(64)}` ? "0".repeat(64) : "f".repeat(64)
  }`;

  const implementationIdentity = validateScaP06ImplementationIdentityV1({
    schema_id: SCA_P06_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    schema_version: 1,
    phase_id: "SCA-P06",
    implementation_revision: "p06-review-candidate",
    contracts_sha256: "a".repeat(64),
    prompts_sha256: "b".repeat(64),
    identity_scope: "caller_declaration_not_runtime_attestation",
    host_issued: true,
    required_model: SCA_P06_REQUIRED_MODEL,
  });
  const implementationRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-implementation-identity",
    operationId: "sca-p06-implementation-identity",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    value: implementationIdentity,
  });

  const runtimePolicy = validateScaP06RuntimePolicyV1({
    schema_id: SCA_P06_RUNTIME_POLICY_V1_SCHEMA,
    schema_version: 1,
    phase_id: "SCA-P06",
    policy_id: "p06-runtime-policy",
    required_model: SCA_P06_REQUIRED_MODEL,
    required_tools: [],
    max_active_hypotheses: 128,
    max_payload_bytes_per_call: 700_000,
    max_provider_calls: 1,
    allow_payload_truncation: false,
    allow_model_fallback: false,
    malformed_semantic_output: "checkpoint_without_retry",
    remote_unknown_recovery: "quarantine_without_replay",
    child_integration: {
      status: "unavailable",
      compatible_capability_ids: [],
      mandatory_invocation: false,
      reason_code: "no_admitted_compatible_child_integration",
    },
    status: "approved",
  });
  const runtimeRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-runtime-policy",
    operationId: "sca-p06-runtime-policy",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_RUNTIME_POLICY_V1_SCHEMA,
    value: runtimePolicy,
  });

  const authorityModes = [
    {
      action_kind: "source_query" as const,
      authority_id: "p06-source-authority",
      decision: "approved" as const,
      reason_code: "source_query_approved",
      scope: "p06_decision_only_not_p07_execution_authority" as const,
    },
    {
      action_kind: "graph_query" as const,
      authority_id: "p06-graph-authority",
      decision: "approved" as const,
      reason_code: "graph_query_approved",
      scope: "p06_decision_only_not_p07_execution_authority" as const,
    },
    {
      action_kind: "application_test" as const,
      authority_id: "p06-application-authority",
      decision: "denied" as const,
      reason_code: "application_test_denied",
      scope: "p06_decision_only_not_p07_execution_authority" as const,
    },
  ];
  const validActionAuthority = validateScaP06ActionAuthorityV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: "tenant",
        project_id: "project",
        run_id: runId,
        phase_id: "SCA-P06" as const,
        source_snapshot_sha256: sourceSha,
        p05_transition_ref: p05.transitionRef,
        hypothesis_authorities: finalHypotheses.map((binding) => ({
          hypothesis_id: binding.hypothesis_id,
          final_revision_ref: binding.final_revision_ref,
          modes: authorityModes,
        })),
        issued_at: "2026-09-22T00:00:00.000Z",
      },
      "authority_sha256"
    )
  );
  const { authority_sha256: _actionDigest, ...actionAuthorityBody } = validActionAuthority;
  let actionAuthorityValue: unknown = validActionAuthority;
  if (mutation === "authority_wrong_run") {
    actionAuthorityValue = withP06SelfDigest(
      { ...actionAuthorityBody, run_id: "run-p06-other" },
      "authority_sha256"
    );
  } else if (mutation === "authority_wrong_source") {
    actionAuthorityValue = withP06SelfDigest(
      { ...actionAuthorityBody, source_snapshot_sha256: "0".repeat(64) },
      "authority_sha256"
    );
  } else if (mutation === "authority_missing_hypothesis") {
    actionAuthorityValue = withP06SelfDigest(
      { ...actionAuthorityBody, hypothesis_authorities: [] },
      "authority_sha256"
    );
  } else if (mutation === "authority_extra_hypothesis") {
    actionAuthorityValue = withP06SelfDigest(
      {
        ...actionAuthorityBody,
        hypothesis_authorities: [
          ...actionAuthorityBody.hypothesis_authorities,
          {
            hypothesis_id: fakeHypothesisId,
            final_revision_ref: firstFinal.final_revision_ref,
            modes: authorityModes,
          },
        ].sort((left, right) => left.hypothesis_id.localeCompare(right.hypothesis_id)),
      },
      "authority_sha256"
    );
  } else if (mutation === "stale_authority_revision") {
    actionAuthorityValue = withP06SelfDigest(
      {
        ...actionAuthorityBody,
        hypothesis_authorities: actionAuthorityBody.hypothesis_authorities.map((entry, index) =>
          index === 0
            ? { ...entry, final_revision_ref: predecessor.transition.p05_gate_ref }
            : entry
        ),
      },
      "authority_sha256"
    );
  }
  const actionAuthorityRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-action-authority",
    operationId: "sca-p06-action-authority",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
    value: actionAuthorityValue,
  });

  const resourceProfiles = [
    {
      action_kind: "source_query" as const,
      profile_id: "p06-source-resource",
      timeout_ms: 10_000,
      max_output_bytes: 131_072,
      max_result_items: 128,
      max_selectors: 16,
      scope: "p06_decision_only_not_p07_execution_budget" as const,
    },
    {
      action_kind: "graph_query" as const,
      profile_id: "p06-graph-resource",
      timeout_ms: 10_000,
      max_output_bytes: 131_072,
      max_result_items: 128,
      max_selectors: 16,
      scope: "p06_decision_only_not_p07_execution_budget" as const,
    },
    {
      action_kind: "application_test" as const,
      profile_id: "p06-application-resource",
      timeout_ms: 10_000,
      max_output_bytes: 131_072,
      max_result_items: 128,
      max_selectors: 16,
      scope: "p06_decision_only_not_p07_execution_budget" as const,
    },
  ];
  const validResourcePolicy = validateScaP06ResourcePolicyV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P06" as const,
        policy_id: "p06-resource-policy",
        source_snapshot_sha256: sourceSha,
        p05_transition_ref: p05.transitionRef,
        profiles: resourceProfiles,
        status: "approved" as const,
      },
      "policy_sha256"
    )
  );
  const { policy_sha256: _resourceDigest, ...resourcePolicyBody } = validResourcePolicy;
  let resourcePolicyValue: unknown = validResourcePolicy;
  if (mutation === "resource_wrong_transition") {
    resourcePolicyValue = withP06SelfDigest(
      { ...resourcePolicyBody, p05_transition_ref: predecessor.transition.p05_gate_ref },
      "policy_sha256"
    );
  } else if (mutation === "resource_limit_overflow") {
    resourcePolicyValue = withP06SelfDigest(
      {
        ...resourcePolicyBody,
        profiles: resourcePolicyBody.profiles.map((profile, index) =>
          index === 0 ? { ...profile, timeout_ms: 300_001 } : profile
        ),
      },
      "policy_sha256"
    );
  }
  const resourcePolicyRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-resource-policy",
    operationId: "sca-p06-resource-policy",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
    value: resourcePolicyValue,
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
        source_snapshot_sha256: sourceSha,
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
  const disclosureAuthorityRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-disclosure-authority",
    operationId: "sca-p06-disclosure-authority",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA,
    value: disclosureAuthority,
  });

  const validDisclosureScope = validateScaP06DisclosureScopeV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P06" as const,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceSha,
        p05_transition_ref: p05.transitionRef,
        required_model: SCA_P06_REQUIRED_MODEL,
        destination_class: "cloud" as const,
        purpose: "p06_least_consequential_evidence_decision" as const,
        allowed_data_classes: [
          "p05_hypothesis_revisions" as const,
          "p06_authority_resource_projections" as const,
        ],
        revision_permissions: finalHypotheses.map((binding) => ({
          hypothesis_id: binding.hypothesis_id,
          revision_ref: binding.final_revision_ref,
          revision_sha256: binding.revision_sha256,
          body_sha256: binding.body_sha256,
          allowed: true as const,
        })),
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
  const { scope_sha256: _scopeDigest, ...disclosureScopeBody } = validDisclosureScope;
  let disclosureScopeValue: unknown = validDisclosureScope;
  if (mutation === "disclosure_missing_hypothesis") {
    disclosureScopeValue = withP06SelfDigest(
      { ...disclosureScopeBody, revision_permissions: [] },
      "scope_sha256"
    );
  } else if (mutation === "disclosure_extra_hypothesis") {
    disclosureScopeValue = withP06SelfDigest(
      {
        ...disclosureScopeBody,
        revision_permissions: [
          ...disclosureScopeBody.revision_permissions,
          {
            hypothesis_id: fakeHypothesisId,
            revision_ref: firstFinal.final_revision_ref,
            revision_sha256: firstFinal.revision_sha256,
            body_sha256: firstFinal.body_sha256,
            allowed: true as const,
          },
        ].sort((left, right) => left.hypothesis_id.localeCompare(right.hypothesis_id)),
      },
      "scope_sha256"
    );
  } else if (mutation === "stale_disclosure_revision_digest") {
    disclosureScopeValue = withP06SelfDigest(
      {
        ...disclosureScopeBody,
        revision_permissions: disclosureScopeBody.revision_permissions.map((entry, index) =>
          index === 0 ? { ...entry, revision_sha256: "c".repeat(64) } : entry
        ),
      },
      "scope_sha256"
    );
  } else if (mutation === "stale_disclosure_body_digest") {
    disclosureScopeValue = withP06SelfDigest(
      {
        ...disclosureScopeBody,
        revision_permissions: disclosureScopeBody.revision_permissions.map((entry, index) =>
          index === 0 ? { ...entry, body_sha256: "d".repeat(64) } : entry
        ),
      },
      "scope_sha256"
    );
  } else if (mutation === "disclosure_runtime_limit_overflow") {
    disclosureScopeValue = withP06SelfDigest(
      { ...disclosureScopeBody, max_payload_bytes_per_call: 700_001 },
      "scope_sha256"
    );
  } else if (mutation === "disclosure_authority_parity") {
    disclosureScopeValue = withP06SelfDigest(
      { ...disclosureScopeBody, provider_retention_days: 1 },
      "scope_sha256"
    );
  }
  const disclosureScopeRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-disclosure-scope",
    operationId: "sca-p06-disclosure-scope",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
    value: disclosureScopeValue,
  });

  const requestImplementationRef =
    mutation === "implementation_metadata"
      ? { ...implementationRef, producer: "host:substituted" }
      : implementationRef;
  const request = validateScaP06RequestV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_REQUEST_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: "tenant",
        project_id: "project",
        run_id: runId,
        phase_id: "SCA-P06" as const,
        p05_transition_ref: p05.transitionRef,
        implementation_identity_ref: requestImplementationRef,
        runtime_policy_ref: runtimeRef,
        action_authority_ref: actionAuthorityRef,
        resource_policy_ref: resourcePolicyRef,
        disclosure_scope_ref: disclosureScopeRef,
        requested_at: "2026-09-22T00:00:00.000Z",
      },
      "request_sha256"
    )
  );
  const requestRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P06",
    kind: "sca-p06-candidate-request",
    operationId: "sca-p06-candidate-request",
    producer: "host:sca-p06-candidate",
    schemaId: SCA_P06_REQUEST_V1_SCHEMA,
    value: request,
  });
  return {
    request,
    requestRef,
    inputArtifacts: scaP06InputArtifacts(request),
    implementationRef,
    runtimeRef,
    actionAuthorityRef,
    resourcePolicyRef,
    disclosureScopeRef,
    predecessor,
  };
}

function admitP06Fixture(artifacts: ArtifactStore, mutation: P06AdmissionMutation = "none") {
  const built = p06CandidateFixture(artifacts, mutation);
  return {
    built,
    admission: admitScaP06Candidate({
      store: artifacts,
      request: built.request,
      input_artifacts: built.inputArtifacts,
      trusted_clock: P06_CLOCK,
    }),
  };
}

describe("SCA P06 transitive P05 admission", () => {
  it("revalidates the complete live-qualified P05 lineage and immutable final revision", () => {
    using artifacts = store();
    const built = completedP05(artifacts);
    const admitted = admitScaP05CompletedCohort({
      store: artifacts,
      transition_ref: built.transitionRef,
      trusted_clock: () => new Date("2026-09-22T00:00:04.000Z"),
    });
    expect(admitted.final_hypotheses).toHaveLength(1);
    expect(first(admitted.final_hypotheses, "P06 final hypothesis").hypothesis_id).toBe(
      built.body.hypothesis_id
    );
    expect(first(admitted.final_hypotheses, "P06 final hypothesis").final_revision_ref).toEqual(
      built.revisionRef
    );
  });

  it("rejects a traceability receipt omitted from the exact P05 evidence manifest", () => {
    using artifacts = store();
    const built = completedP05(artifacts, { omitChallengerReceiptFromManifest: true });
    expect(() =>
      admitScaP05CompletedCohort({
        store: artifacts,
        transition_ref: built.transitionRef,
        trusted_clock: () => new Date("2026-09-22T00:00:04.000Z"),
      })
    ).toThrow(/absent from the evidence manifest/u);
  });

  it("rejects a mutated P05 final-revision parent chain", () => {
    using artifacts = store();
    const built = completedP05(artifacts, { mutateFinalRevisionParent: true });
    expect(() =>
      admitScaP05CompletedCohort({
        store: artifacts,
        transition_ref: built.transitionRef,
        trusted_clock: () => new Date("2026-09-22T00:00:04.000Z"),
      })
    ).toThrow(/immutable parent lineage/u);
  });

  it("rejects an authorized transition bound to a non-passing P05 gate", () => {
    using artifacts = store();
    const built = completedP05(artifacts, { mutateGate: true });
    expect(() =>
      admitScaP05CompletedCohort({
        store: artifacts,
        transition_ref: built.transitionRef,
        trusted_clock: () => new Date("2026-09-22T00:00:04.000Z"),
      })
    ).toThrow(/gate/u);
  });

  it("rejects an authorized transition bound to an unsatisfied P05 ledger", () => {
    using artifacts = store();
    const built = completedP05(artifacts, { mutateLedger: true });
    expect(() =>
      admitScaP05CompletedCohort({
        store: artifacts,
        transition_ref: built.transitionRef,
        trusted_clock: () => new Date("2026-09-22T00:00:04.000Z"),
      })
    ).toThrow(/ledger/u);
  });
});

describe("SCA P06 direct candidate admission boundary", () => {
  it("admits one full provider-free P06 cohort through the real boundary", () => {
    using artifacts = store();
    const { built, admission } = admitP06Fixture(artifacts);
    expect(admission.request).toEqual(built.request);
    expect(admission.predecessor.final_hypotheses).toEqual(built.predecessor.final_hypotheses);
    expect(admission.transitive_refs).toContainEqual(built.actionAuthorityRef);
    expect(admission.transitive_refs).toContainEqual(built.disclosureScopeRef);
    const accepted = buildScaP06AcceptedCohort({
      admission,
      p06_request_ref: built.requestRef,
      admitted_at: "2026-09-22T00:00:04.000Z",
    });
    expect(() => validateScaP06AcceptedCohortV1(accepted)).not.toThrow();
    expect(accepted.active_hypothesis_ids).toEqual(
      admission.predecessor.transition.active_hypothesis_ids
    );
    expect(accepted.final_hypotheses).toEqual(admission.predecessor.final_hypotheses);
  });

  it("rejects missing, extra, and substituted exact input slots", () => {
    using artifacts = store();
    const built = p06CandidateFixture(artifacts);
    const bindings = built.inputArtifacts.artifacts;
    const vectors = [
      {
        schema_version: 2 as const,
        artifacts: bindings.slice(0, -1),
      },
      {
        schema_version: 2 as const,
        artifacts: [...bindings, { slot: "unexpected", ref: built.disclosureScopeRef }],
      },
      {
        schema_version: 2 as const,
        artifacts: bindings.map((binding) =>
          binding.slot === "implementation_identity"
            ? { ...binding, ref: built.runtimeRef }
            : binding
        ),
      },
    ];
    for (const inputArtifacts of vectors) {
      expect(() =>
        admitScaP06Candidate({
          store: artifacts,
          request: built.request,
          input_artifacts: inputArtifacts,
          trusted_clock: P06_CLOCK,
        })
      ).toThrow(/exact start inputs/u);
    }
  });

  it.each([
    ["implementation metadata substitution", "implementation_metadata", /metadata/u],
    ["wrong run binding", "authority_wrong_run", /binding mismatch/u],
    ["wrong source binding", "authority_wrong_source", /binding mismatch/u],
    ["wrong transition binding", "resource_wrong_transition", /binding mismatch/u],
    [
      "missing hypothesis authority projection",
      "authority_missing_hypothesis",
      /action authority is not valid contract JSON/u,
    ],
    ["extra hypothesis authority projection", "authority_extra_hypothesis", /not exhaustive/u],
    [
      "missing disclosure revision projection",
      "disclosure_missing_hypothesis",
      /disclosure scope is not valid contract JSON/u,
    ],
    ["extra disclosure revision projection", "disclosure_extra_hypothesis", /not exhaustive/u],
    ["stale final revision authority", "stale_authority_revision", /stale/u],
    ["stale final revision digest", "stale_disclosure_revision_digest", /stale/u],
    ["stale final body digest", "stale_disclosure_body_digest", /stale/u],
    [
      "resource profile contract overflow",
      "resource_limit_overflow",
      /resource policy is not valid contract JSON/u,
    ],
    [
      "runtime disclosure byte-limit overflow",
      "disclosure_runtime_limit_overflow",
      /binding mismatch/u,
    ],
    [
      "disclosure scope and typed authority parity drift",
      "disclosure_authority_parity",
      /differs from exact typed authority/u,
    ],
  ] as const)("rejects %s", (_name, mutation, message) => {
    using artifacts = store();
    expect(() => admitP06Fixture(artifacts, mutation)).toThrow(message);
  });
});
