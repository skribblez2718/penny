import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, InputArtifacts } from "../contracts.js";
import {
  MODEL_DISPATCH_GUARD_V1_SCHEMA,
  MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
  assertResolvedModelIdentity,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
  validateModelDispatchGuardV1,
  validateModelExecutionReceiptV1,
} from "../required-model.js";
import {
  admitScaP05Candidate,
  buildScaP05AcceptedCohort,
  scaP05InputArtifacts,
  type ScaP05AdmissionResultV1,
} from "./p05-admission.js";
import {
  SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA,
  SCA_P05_GATE_V1_SCHEMA,
  SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
  SCA_P05_REQUEST_V1_SCHEMA,
  SCA_P05_PROVIDER_OPENING_GUARD,
  SCA_P05_REQUIRED_MODEL,
  SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
  SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
  SCA_P05_TRACEABILITY_V1_SCHEMA,
  scaP05HypothesisId,
  validateScaP05AcceptedCohortV1,
  validateScaP05CognitivePayloadV1,
  validateScaP05DisclosureAdmissionV1,
  validateScaP05EvidenceManifestV1,
  validateScaP05GateV1,
  validateScaP05HypothesisRevisionV1,
  validateScaP05RequestV1,
  validateScaP05SuccessorLedgerV1,
  validateScaP05ToP06TransitionV1,
  validateScaP05TraceabilityV1,
  type ScaP05AcceptedCohortV1,
  type ScaP05EvidenceManifestV1,
  type ScaP05GateV1,
  type ScaP05HypothesisRevisionV1,
  type ScaP05SuccessorLedgerV1,
  type ScaP05ToP06TransitionV1,
  type ScaP05TraceabilityV1,
} from "./p05-contracts.js";
import {
  SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
  SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P06_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  SCA_P06_REQUEST_V1_SCHEMA,
  SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
  SCA_P06_RUNTIME_POLICY_V1_SCHEMA,
  SCA_P06_ACCEPTED_COHORT_V1_SCHEMA,
  validateScaP06AcceptedCohortV1,
  validateScaP06ActionAuthorityV1,
  validateScaP06DisclosureAuthorityV1,
  validateScaP06DisclosureScopeV1,
  validateScaP06ImplementationIdentityV1,
  validateScaP06RequestV1,
  validateScaP06ResourcePolicyV1,
  validateScaP06RuntimePolicyV1,
  withP06SelfDigest,
  type ScaP06AcceptedCohortV1,
  type ScaP06ActionAuthorityV1,
  type ScaP06DisclosureScopeV1,
  type ScaP06FinalHypothesisBindingV1,
  type ScaP06ImplementationIdentityV1,
  type ScaP06RequestV1,
  type ScaP06ResourcePolicyV1,
  type ScaP06RuntimePolicyV1,
} from "./p06-contracts.js";

const P06_PRODUCER = "host:sca-p06-candidate" as const;

export class ScaP06AdmissionError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "artifact_mismatch"
      | "cross_cohort_substitution"
      | "predecessor_not_accepted"
      | "policy_mismatch"
      | "source_binding_mismatch"
      | "limit_exceeded",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaP06AdmissionError";
  }
}

function fail(code: ScaP06AdmissionError["code"], message: string, cause?: unknown): never {
  throw new ScaP06AdmissionError(code, message, cause === undefined ? undefined : { cause });
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const prior = byId.get(ref.artifact_id);
    if (prior !== undefined && !same(prior, ref)) {
      fail("cross_cohort_substitution", "P06 evidence contains conflicting full artifact refs");
    }
    byId.set(ref.artifact_id, ref);
  }
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) {
    fail("artifact_mismatch", `${label} full artifact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    fail("artifact_mismatch", `${label} exact bytes do not match the admitted ref`);
  }
  return bytes;
}
function exactJson<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string,
  validate: (value: unknown) => T
): T {
  try {
    const parsed: unknown = JSON.parse(exactBytes(store, ref, label).toString("utf8"));
    return validate(parsed);
  } catch (error) {
    if (error instanceof ScaP06AdmissionError) throw error;
    fail("artifact_mismatch", `${label} is not valid contract JSON`, error);
  }
}
function hostP05Ref(
  ref: ArtifactRef,
  input: {
    readonly run_id: string;
    readonly kind: string;
    readonly operation_id: string;
    readonly schema_id: string;
  }
): boolean {
  return (
    ref.run_id === input.run_id &&
    ref.phase === "SCA-P05" &&
    ref.branch_id === null &&
    ref.kind === input.kind &&
    ref.operation_id === input.operation_id &&
    ref.version === 1 &&
    ref.producer === "host:sca-p05-candidate" &&
    ref.media_type === "application/json" &&
    ref.content_schema?.schema_id === input.schema_id &&
    ref.content_schema.schema_version === 1
  );
}
export function assertScaP06InputMetadata(
  ref: ArtifactRef,
  input: {
    readonly run_id: string;
    readonly kind: string;
    readonly operation_id: string;
    readonly schema_id: string;
  }
): void {
  if (
    ref.run_id !== input.run_id ||
    ref.phase !== "SCA-P06" ||
    ref.branch_id !== null ||
    ref.kind !== input.kind ||
    ref.operation_id !== input.operation_id ||
    ref.version !== 1 ||
    ref.producer !== P06_PRODUCER ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== input.schema_id ||
    ref.content_schema.schema_version !== 1
  ) {
    fail(
      "artifact_mismatch",
      `P06 input '${input.kind}' metadata is not exact host-owned metadata`
    );
  }
}
function assertExactInputs(actual: InputArtifacts, expected: InputArtifacts): void {
  if (!same(actual, expected))
    fail("invalid_request", "P06 exact start inputs differ from request");
}

function validateP05ExecutionEvidence(input: {
  readonly store: ArtifactHostStore;
  readonly p05_run_id: string;
  readonly state_id: "forming_hypotheses" | "challenging_hypotheses";
  readonly agent: "ida" | "annie";
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
  readonly output_ref: ArtifactRef;
  readonly guard_ref: ArtifactRef;
  readonly receipt_ref: ArtifactRef;
}): void {
  const coordinate = {
    run_id: input.p05_run_id,
    state_id: input.state_id,
    branch_id: null,
    agent: input.agent,
    attempt: 1,
  };
  const payloadOperation =
    input.agent === "ida" ? "sca-p05-constructor-payload" : "sca-p05-challenger-payload";
  const disclosureOperation =
    input.agent === "ida" ? "sca-p05-constructor-disclosure" : "sca-p05-challenger-disclosure";
  if (
    !hostP05Ref(input.payload_ref, {
      run_id: input.p05_run_id,
      kind: "sca-p05-cognitive-payload",
      operation_id: payloadOperation,
      schema_id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
    }) ||
    !hostP05Ref(input.disclosure_ref, {
      run_id: input.p05_run_id,
      kind: "sca-p05-disclosure-admission",
      operation_id: disclosureOperation,
      schema_id: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
    })
  ) {
    fail(
      "artifact_mismatch",
      "P05 model payload/disclosure metadata is not exact host-owned metadata"
    );
  }
  const expectedInputArtifacts = {
    schema_version: 2 as const,
    artifacts: [
      { slot: "cognitive_payload", ref: input.payload_ref },
      { slot: "disclosure_admission", ref: input.disclosure_ref },
    ],
  };
  const payload = exactJson(
    input.store,
    input.payload_ref,
    "P05 cognitive payload",
    validateScaP05CognitivePayloadV1
  );
  const disclosure = exactJson(
    input.store,
    input.disclosure_ref,
    "P05 disclosure admission",
    validateScaP05DisclosureAdmissionV1
  );
  const guard = exactJson(
    input.store,
    input.guard_ref,
    "P05 dispatch guard",
    validateModelDispatchGuardV1
  );
  const wrapper = exactJson(
    input.store,
    input.receipt_ref,
    "P05 model execution receipt",
    validateModelExecutionReceiptV1
  );
  const receipt = wrapper.execution_receipt;
  const outputKind =
    input.agent === "ida" ? "sca-p05-constructor-output" : "sca-p05-challenger-output";
  if (
    payload.run_id !== input.p05_run_id ||
    disclosure.run_id !== input.p05_run_id ||
    disclosure.decision !== "allow" ||
    disclosure.blocker_codes.length !== 0 ||
    !same(disclosure.payload_ref, input.payload_ref) ||
    disclosure.payload_sha256 !== input.payload_ref.content_digest ||
    payload.role !==
      (input.agent === "ida" ? "hypothesis_constructor" : "falsification_challenger") ||
    disclosure.role !== payload.role ||
    input.output_ref.run_id !== input.p05_run_id ||
    input.output_ref.phase !== input.state_id ||
    input.output_ref.branch_id !== null ||
    input.output_ref.kind !== outputKind ||
    input.output_ref.operation_id !== outputKind ||
    input.output_ref.version !== 1 ||
    input.output_ref.producer !== `agent:${input.agent}` ||
    input.output_ref.media_type !== "text/plain" ||
    input.output_ref.content_schema?.schema_id !== "penny.persisted-summary-line.v1" ||
    input.output_ref.content_schema.schema_version !== 1 ||
    input.guard_ref.run_id !== input.p05_run_id ||
    input.guard_ref.phase !== input.state_id ||
    input.guard_ref.branch_id !== null ||
    input.guard_ref.kind !== "model-dispatch-guard" ||
    input.guard_ref.operation_id !== modelDispatchGuardOperationId(coordinate) ||
    input.guard_ref.version !== 1 ||
    input.guard_ref.producer !== "host:required-model-runtime" ||
    input.guard_ref.media_type !== "application/json" ||
    input.guard_ref.content_schema?.schema_id !== MODEL_DISPATCH_GUARD_V1_SCHEMA ||
    input.guard_ref.content_schema.schema_version !== 1 ||
    input.receipt_ref.run_id !== input.p05_run_id ||
    input.receipt_ref.phase !== input.state_id ||
    input.receipt_ref.branch_id !== null ||
    input.receipt_ref.kind !== "model-execution-receipt" ||
    input.receipt_ref.operation_id !== modelExecutionReceiptOperationId(coordinate) ||
    input.receipt_ref.version !== 1 ||
    input.receipt_ref.producer !== "host:required-model-runtime" ||
    input.receipt_ref.media_type !== "application/json" ||
    input.receipt_ref.content_schema?.schema_id !== MODEL_EXECUTION_RECEIPT_V1_SCHEMA ||
    input.receipt_ref.content_schema.schema_version !== 1 ||
    !same(guard.coordinate, coordinate) ||
    !same(guard.requested_model, SCA_P05_REQUIRED_MODEL) ||
    guard.provider_opening_guard !== SCA_P05_PROVIDER_OPENING_GUARD ||
    guard.input_artifacts_sha256 !== sha256(canonicalJson(expectedInputArtifacts)) ||
    !same(wrapper.dispatch_guard_ref, input.guard_ref) ||
    receipt.run_id !== input.p05_run_id ||
    receipt.state_id !== input.state_id ||
    receipt.branch_id !== null ||
    receipt.agent !== input.agent ||
    receipt.attempt !== 1 ||
    !same(receipt.requested_model, SCA_P05_REQUIRED_MODEL) ||
    receipt.observed_model === undefined ||
    !same(receipt.output_artifact_ref, input.output_ref) ||
    receipt.output_digest !== input.output_ref.content_digest
  ) {
    fail("cross_cohort_substitution", "P05 model execution evidence is stale or cross-spliced");
  }
  try {
    assertResolvedModelIdentity(
      SCA_P05_REQUIRED_MODEL,
      receipt.observed_model,
      "P05 observed model"
    );
  } catch (error) {
    fail("predecessor_not_accepted", "P05 observed model is not exact DeepSeek", error);
  }
  exactBytes(input.store, input.output_ref, "P05 model output");
}

export interface ScaP06AcceptedP05CohortV1 {
  readonly transition: ScaP05ToP06TransitionV1;
  readonly accepted_cohort: ScaP05AcceptedCohortV1;
  readonly traceability: ScaP05TraceabilityV1;
  readonly evidence_manifest: ScaP05EvidenceManifestV1;
  readonly successor_ledger: ScaP05SuccessorLedgerV1;
  readonly gate: ScaP05GateV1;
  readonly p05_admission: ScaP05AdmissionResultV1;
  readonly final_hypotheses: readonly ScaP06FinalHypothesisBindingV1[];
  readonly final_revisions: readonly ScaP05HypothesisRevisionV1[];
  readonly exact_refs: readonly ArtifactRef[];
}

export function admitScaP05CompletedCohort(input: {
  readonly store: ArtifactHostStore;
  readonly transition_ref: ArtifactRef;
  readonly trusted_clock: () => Date;
}): ScaP06AcceptedP05CohortV1 {
  const transition = exactJson(
    input.store,
    input.transition_ref,
    "P05 to P06 transition",
    validateScaP05ToP06TransitionV1
  );
  if (
    transition.target_phase_id !== "SCA-P06" ||
    transition.qualification_scope !== "live_qualified" ||
    !transition.authorized
  ) {
    fail("predecessor_not_accepted", "P05 transition is not live-qualified and authorized");
  }
  if (
    !hostP05Ref(input.transition_ref, {
      run_id: transition.p05_request_ref.run_id,
      kind: "sca-p05-to-p06-transition",
      operation_id: "sca-p05-to-p06-transition",
      schema_id: SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
    })
  ) {
    fail("artifact_mismatch", "P05 transition metadata is not exact host-owned metadata");
  }
  if (
    !hostP05Ref(transition.p05_request_ref, {
      run_id: transition.p05_request_ref.run_id,
      kind: "sca-p05-candidate-request",
      operation_id: "sca-p05-candidate-request",
      schema_id: SCA_P05_REQUEST_V1_SCHEMA,
    })
  ) {
    fail("artifact_mismatch", "P05 request metadata is not exact host-owned metadata");
  }
  const p05Request = exactJson(
    input.store,
    transition.p05_request_ref,
    "P05 request",
    validateScaP05RequestV1
  );
  let p05Admission: ScaP05AdmissionResultV1;
  try {
    p05Admission = admitScaP05Candidate({
      store: input.store,
      request: p05Request,
      input_artifacts: scaP05InputArtifacts(p05Request),
      trusted_clock: input.trusted_clock,
    });
  } catch (error) {
    fail("predecessor_not_accepted", "P05 transitive admission could not be reproduced", error);
  }
  const accepted = exactJson(
    input.store,
    transition.accepted_cohort_ref,
    "P05 accepted cohort",
    validateScaP05AcceptedCohortV1
  );
  const expectedAccepted = buildScaP05AcceptedCohort({
    admission: p05Admission,
    p05_request_ref: transition.p05_request_ref,
    admitted_at: accepted.admitted_at,
  });
  if (!same(accepted, expectedAccepted)) {
    fail(
      "cross_cohort_substitution",
      "P05 accepted cohort is not its deterministic transitive rebuild"
    );
  }
  const traceability = exactJson(
    input.store,
    transition.traceability_ref,
    "P05 traceability",
    validateScaP05TraceabilityV1
  );
  const manifest = exactJson(
    input.store,
    transition.evidence_manifest_ref,
    "P05 evidence manifest",
    validateScaP05EvidenceManifestV1
  );
  const ledger = exactJson(
    input.store,
    transition.successor_ledger_ref,
    "P05 successor ledger",
    validateScaP05SuccessorLedgerV1
  );
  const gate = exactJson(input.store, transition.p05_gate_ref, "P05 gate", validateScaP05GateV1);
  if (
    p05Request.run_id !== accepted.run_id ||
    transition.p05_request_ref.run_id !== accepted.run_id ||
    !same(accepted.p05_request_ref, transition.p05_request_ref) ||
    !same(accepted.p04_transition_ref, p05Request.p04_transition_ref) ||
    !same(transition.traceability_ref, gate.traceability_ref) ||
    !same(transition.evidence_manifest_ref, gate.evidence_manifest_ref) ||
    !same(transition.successor_ledger_ref, gate.successor_ledger_ref) ||
    gate.verdict !== "pass" ||
    gate.checkpoint_count !== 0 ||
    gate.blocker_codes.length !== 0 ||
    !ledger.all_required_satisfied ||
    ledger.obligations.some((entry) => entry.status !== "satisfied") ||
    !same(ledger.predecessor_ledger_ref, accepted.p04_successor_ledger_ref) ||
    !same(transition.active_hypothesis_ids, traceability.active_hypothesis_ids) ||
    !same(transition.refuted_hypothesis_ids, traceability.refuted_hypothesis_ids) ||
    traceability.checkpointed_item_ids.length !== 0 ||
    !traceability.exhaustive ||
    !same(manifest.source_snapshot_ref, accepted.source_snapshot_ref) ||
    manifest.source_snapshot_sha256 !== accepted.source_snapshot_sha256
  ) {
    fail(
      "predecessor_not_accepted",
      "P05 gate, ledger, traceability, or transition closure is not passing"
    );
  }
  const coreMetadata = [
    [
      transition.accepted_cohort_ref,
      "sca-p05-accepted-cohort",
      "sca-p05-accepted-cohort",
      SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
    ],
    [
      transition.traceability_ref,
      "sca-p05-traceability",
      "sca-p05-traceability",
      SCA_P05_TRACEABILITY_V1_SCHEMA,
    ],
    [
      transition.evidence_manifest_ref,
      "sca-p05-evidence-manifest",
      "sca-p05-evidence-manifest",
      SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA,
    ],
    [
      transition.successor_ledger_ref,
      "sca-p05-successor-ledger",
      "sca-p05-successor-ledger",
      SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
    ],
    [transition.p05_gate_ref, "sca-p05-gate", "sca-p05-gate", SCA_P05_GATE_V1_SCHEMA],
  ] as const;
  for (const [ref, kind, operationId, schemaId] of coreMetadata) {
    if (
      !hostP05Ref(ref, {
        run_id: accepted.run_id,
        kind,
        operation_id: operationId,
        schema_id: schemaId,
      })
    ) {
      fail("artifact_mismatch", `P05 '${kind}' metadata is not exact host-owned metadata`);
    }
  }
  const manifestIds = new Set(manifest.evidence_refs.map((ref) => ref.artifact_id));
  for (const ref of manifest.evidence_refs)
    exactBytes(input.store, ref, "P05 evidence manifest member");
  for (const required of [
    transition.p05_request_ref,
    transition.accepted_cohort_ref,
    transition.traceability_ref,
    accepted.p04_transition_ref,
    accepted.p04_gate_ref,
    accepted.p04_successor_ledger_ref,
    accepted.source_snapshot_ref,
  ]) {
    if (!manifestIds.has(required.artifact_id)) {
      fail("cross_cohort_substitution", "P05 evidence manifest omits required lineage");
    }
  }
  const finalBindings: ScaP06FinalHypothesisBindingV1[] = [];
  const finalRevisions: ScaP05HypothesisRevisionV1[] = [];
  for (const row of traceability.rows) {
    if (row.disposition === "checkpointed_incomplete") {
      fail(
        "predecessor_not_accepted",
        "P05 accepted transition contains a checkpointed hypothesis"
      );
    }
    const constructorOutput = row.constructor_output_ref;
    const constructorGuard = row.constructor_guard_ref;
    const constructorReceipt = row.constructor_receipt_ref;
    const initialRevisionRef = row.initial_revision_ref;
    const challengerOutput = row.challenger_output_ref;
    const challengerGuard = row.challenger_guard_ref;
    const challengerReceipt = row.challenger_receipt_ref;
    const finalRevisionRef = row.final_revision_ref;
    if (
      constructorOutput === null ||
      constructorGuard === null ||
      constructorReceipt === null ||
      initialRevisionRef === null ||
      challengerOutput === null ||
      challengerGuard === null ||
      challengerReceipt === null ||
      finalRevisionRef === null
    ) {
      fail("cross_cohort_substitution", "P05 accepted traceability row lacks required exact refs");
    }
    const refs: ArtifactRef[] = [
      constructorOutput,
      constructorGuard,
      constructorReceipt,
      initialRevisionRef,
      challengerOutput,
      challengerGuard,
      challengerReceipt,
      finalRevisionRef,
    ];
    for (const ref of refs) {
      if (!manifestIds.has(ref.artifact_id)) {
        fail(
          "cross_cohort_substitution",
          "P05 traceability ref is absent from the evidence manifest"
        );
      }
    }
    const constructorPayloadRef = exactJson(
      input.store,
      initialRevisionRef,
      "P05 initial hypothesis revision",
      validateScaP05HypothesisRevisionV1
    ).cognitive_payload_ref;
    const constructorDisclosureRef = manifest.evidence_refs.find(
      (ref) =>
        ref.kind === "sca-p05-disclosure-admission" &&
        ref.operation_id === "sca-p05-constructor-disclosure"
    );
    const challengerRevision = exactJson(
      input.store,
      finalRevisionRef,
      "P05 final hypothesis revision",
      validateScaP05HypothesisRevisionV1
    );
    const challengerPayloadRef = manifest.evidence_refs.find(
      (ref) =>
        ref.kind === "sca-p05-cognitive-payload" &&
        ref.operation_id === "sca-p05-challenger-payload"
    );
    const challengerDisclosureRef = manifest.evidence_refs.find(
      (ref) =>
        ref.kind === "sca-p05-disclosure-admission" &&
        ref.operation_id === "sca-p05-challenger-disclosure"
    );
    if (
      constructorDisclosureRef === undefined ||
      challengerPayloadRef === undefined ||
      challengerDisclosureRef === undefined
    ) {
      fail(
        "cross_cohort_substitution",
        "P05 model payload/disclosure refs are absent from exact evidence"
      );
    }
    validateP05ExecutionEvidence({
      store: input.store,
      p05_run_id: accepted.run_id,
      state_id: "forming_hypotheses",
      agent: "ida",
      payload_ref: constructorPayloadRef,
      disclosure_ref: constructorDisclosureRef,
      output_ref: constructorOutput,
      guard_ref: constructorGuard,
      receipt_ref: constructorReceipt,
    });
    validateP05ExecutionEvidence({
      store: input.store,
      p05_run_id: accepted.run_id,
      state_id: "challenging_hypotheses",
      agent: "annie",
      payload_ref: challengerPayloadRef,
      disclosure_ref: challengerDisclosureRef,
      output_ref: challengerOutput,
      guard_ref: challengerGuard,
      receipt_ref: challengerReceipt,
    });
    const initialRevision = exactJson(
      input.store,
      initialRevisionRef,
      "P05 initial hypothesis revision",
      validateScaP05HypothesisRevisionV1
    );
    if (
      !hostP05Ref(initialRevisionRef, {
        run_id: accepted.run_id,
        kind: "sca-p05-hypothesis-revision",
        operation_id: `sca-p05-${row.selected_item_id}-revision-1`,
        schema_id: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
      }) ||
      initialRevision.revision !== 1 ||
      initialRevision.hypothesis_id !== row.hypothesis_id ||
      initialRevision.selected_item_id !== row.selected_item_id ||
      initialRevision.source_snapshot_sha256 !== accepted.source_snapshot_sha256 ||
      !same(initialRevision.source_snapshot_ref, accepted.source_snapshot_ref) ||
      !same(initialRevision.p04_transition_ref, accepted.p04_transition_ref) ||
      initialRevision.hypothesis_id !==
        scaP05HypothesisId(accepted.source_snapshot_sha256, row.selected_item_id)
    ) {
      fail("cross_cohort_substitution", "P05 initial hypothesis revision lineage is inconsistent");
    }
    if (
      challengerRevision.hypothesis_id !== row.hypothesis_id ||
      challengerRevision.selected_item_id !== row.selected_item_id ||
      challengerRevision.source_snapshot_sha256 !== accepted.source_snapshot_sha256 ||
      !same(challengerRevision.source_snapshot_ref, accepted.source_snapshot_ref) ||
      !same(challengerRevision.p04_transition_ref, accepted.p04_transition_ref)
    ) {
      fail("cross_cohort_substitution", "P05 final hypothesis revision lineage is inconsistent");
    }
    if (challengerRevision.revision === 1) {
      if (
        !same(finalRevisionRef, initialRevisionRef) ||
        !same(challengerRevision, initialRevision)
      ) {
        fail(
          "cross_cohort_substitution",
          "P05 unchanged final revision substituted its initial revision"
        );
      }
    } else {
      if (
        !hostP05Ref(finalRevisionRef, {
          run_id: accepted.run_id,
          kind: "sca-p05-hypothesis-revision",
          operation_id: `sca-p05-${row.selected_item_id}-revision-2`,
          schema_id: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
        }) ||
        !same(challengerRevision.parent_revision_ref, initialRevisionRef) ||
        challengerRevision.parent_revision_sha256 !== initialRevisionRef.content_digest
      ) {
        fail(
          "cross_cohort_substitution",
          "P05 revised final hypothesis lacks exact immutable parent lineage"
        );
      }
    }
    if (row.disposition === "active_hypothesis") {
      finalBindings.push({
        hypothesis_id: challengerRevision.hypothesis_id,
        selected_item_id: challengerRevision.selected_item_id,
        final_revision_ref: finalRevisionRef,
        revision: challengerRevision.revision,
        revision_sha256: challengerRevision.revision_sha256,
        body_sha256: challengerRevision.body_sha256,
      });
      finalRevisions.push(challengerRevision);
    }
  }
  finalBindings.sort((left, right) => left.hypothesis_id.localeCompare(right.hypothesis_id));
  finalRevisions.sort((left, right) => left.hypothesis_id.localeCompare(right.hypothesis_id));
  if (
    finalBindings.length === 0 ||
    !same(
      finalBindings.map((entry) => entry.hypothesis_id),
      transition.active_hypothesis_ids
    )
  ) {
    fail("predecessor_not_accepted", "P05 transition has no exact active final hypothesis cohort");
  }
  const exactRefs = uniqueRefs([
    input.transition_ref,
    transition.p05_request_ref,
    transition.accepted_cohort_ref,
    transition.traceability_ref,
    transition.evidence_manifest_ref,
    transition.successor_ledger_ref,
    transition.p05_gate_ref,
    ...manifest.evidence_refs,
    ...p05Admission.transitive_refs,
  ]);
  return {
    transition,
    accepted_cohort: accepted,
    traceability,
    evidence_manifest: manifest,
    successor_ledger: ledger,
    gate,
    p05_admission: p05Admission,
    final_hypotheses: finalBindings,
    final_revisions: finalRevisions,
    exact_refs: exactRefs,
  };
}

export function scaP06InputArtifacts(request: ScaP06RequestV1): InputArtifacts {
  return {
    schema_version: 2,
    artifacts: [
      { slot: "p05_transition", ref: request.p05_transition_ref },
      { slot: "implementation_identity", ref: request.implementation_identity_ref },
      { slot: "runtime_policy", ref: request.runtime_policy_ref },
      { slot: "action_authority", ref: request.action_authority_ref },
      { slot: "resource_policy", ref: request.resource_policy_ref },
      { slot: "disclosure_scope", ref: request.disclosure_scope_ref },
    ],
  };
}

export interface ScaP06AdmissionResultV1 {
  readonly request: ScaP06RequestV1;
  readonly implementation_identity: ScaP06ImplementationIdentityV1;
  readonly runtime_policy: ScaP06RuntimePolicyV1;
  readonly action_authority: ScaP06ActionAuthorityV1;
  readonly resource_policy: ScaP06ResourcePolicyV1;
  readonly disclosure_scope: ScaP06DisclosureScopeV1;
  readonly predecessor: ScaP06AcceptedP05CohortV1;
  readonly transitive_refs: readonly ArtifactRef[];
}

export function admitScaP06Candidate(input: {
  readonly store: ArtifactHostStore;
  readonly request: unknown;
  readonly input_artifacts: InputArtifacts;
  readonly trusted_clock: () => Date;
}): ScaP06AdmissionResultV1 {
  let request: ScaP06RequestV1;
  try {
    request = validateScaP06RequestV1(input.request);
  } catch (error) {
    fail("invalid_request", "P06 request validation failed", error);
  }
  assertExactInputs(input.input_artifacts, scaP06InputArtifacts(request));
  const inputs = [
    [
      request.implementation_identity_ref,
      "sca-p06-implementation-identity",
      "sca-p06-implementation-identity",
      SCA_P06_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    ],
    [
      request.runtime_policy_ref,
      "sca-p06-runtime-policy",
      "sca-p06-runtime-policy",
      SCA_P06_RUNTIME_POLICY_V1_SCHEMA,
    ],
    [
      request.action_authority_ref,
      "sca-p06-action-authority",
      "sca-p06-action-authority",
      SCA_P06_ACTION_AUTHORITY_V1_SCHEMA,
    ],
    [
      request.resource_policy_ref,
      "sca-p06-resource-policy",
      "sca-p06-resource-policy",
      SCA_P06_RESOURCE_POLICY_V1_SCHEMA,
    ],
    [
      request.disclosure_scope_ref,
      "sca-p06-disclosure-scope",
      "sca-p06-disclosure-scope",
      SCA_P06_DISCLOSURE_SCOPE_V1_SCHEMA,
    ],
  ] as const;
  for (const [ref, kind, operationId, schemaId] of inputs) {
    assertScaP06InputMetadata(ref, {
      run_id: request.run_id,
      kind,
      operation_id: operationId,
      schema_id: schemaId,
    });
  }
  const implementationIdentity = exactJson(
    input.store,
    request.implementation_identity_ref,
    "P06 implementation identity",
    validateScaP06ImplementationIdentityV1
  );
  const runtimePolicy = exactJson(
    input.store,
    request.runtime_policy_ref,
    "P06 runtime policy",
    validateScaP06RuntimePolicyV1
  );
  const actionAuthority = exactJson(
    input.store,
    request.action_authority_ref,
    "P06 action authority",
    validateScaP06ActionAuthorityV1
  );
  const resourcePolicy = exactJson(
    input.store,
    request.resource_policy_ref,
    "P06 resource policy",
    validateScaP06ResourcePolicyV1
  );
  const disclosureScope = exactJson(
    input.store,
    request.disclosure_scope_ref,
    "P06 disclosure scope",
    validateScaP06DisclosureScopeV1
  );
  const predecessor = admitScaP05CompletedCohort({
    store: input.store,
    transition_ref: request.p05_transition_ref,
    trusted_clock: input.trusted_clock,
  });
  const sourceRef = predecessor.accepted_cohort.source_snapshot_ref;
  const sourceSha = predecessor.accepted_cohort.source_snapshot_sha256;
  const activeIds = predecessor.transition.active_hypothesis_ids;
  if (activeIds.length > runtimePolicy.max_active_hypotheses) {
    fail("limit_exceeded", "P06 active hypothesis count exceeds admitted policy");
  }
  if (
    actionAuthority.tenant_id !== request.tenant_id ||
    actionAuthority.project_id !== request.project_id ||
    actionAuthority.run_id !== request.run_id ||
    actionAuthority.source_snapshot_sha256 !== sourceSha ||
    !same(actionAuthority.p05_transition_ref, request.p05_transition_ref) ||
    resourcePolicy.run_id !== request.run_id ||
    resourcePolicy.source_snapshot_sha256 !== sourceSha ||
    !same(resourcePolicy.p05_transition_ref, request.p05_transition_ref) ||
    disclosureScope.run_id !== request.run_id ||
    disclosureScope.source_snapshot_sha256 !== sourceSha ||
    !same(disclosureScope.source_snapshot_ref, sourceRef) ||
    !same(disclosureScope.p05_transition_ref, request.p05_transition_ref) ||
    !same(disclosureScope.action_authority_ref, request.action_authority_ref) ||
    !same(disclosureScope.resource_policy_ref, request.resource_policy_ref) ||
    disclosureScope.max_payload_bytes_per_call > runtimePolicy.max_payload_bytes_per_call ||
    disclosureScope.max_provider_calls !== runtimePolicy.max_provider_calls
  ) {
    fail(
      "policy_mismatch",
      "P06 authority, resource, disclosure, or source cohort binding mismatch"
    );
  }
  if (
    !same(
      actionAuthority.hypothesis_authorities.map((entry) => entry.hypothesis_id),
      activeIds
    ) ||
    !same(
      disclosureScope.revision_permissions.map((entry) => entry.hypothesis_id),
      activeIds
    )
  ) {
    fail(
      "cross_cohort_substitution",
      "P06 policy projections are not exhaustive for active P05 hypotheses"
    );
  }
  const finalById = new Map(
    predecessor.final_hypotheses.map((entry) => [entry.hypothesis_id, entry])
  );
  for (const authority of actionAuthority.hypothesis_authorities) {
    const final = finalById.get(authority.hypothesis_id);
    if (final === undefined || !same(authority.final_revision_ref, final.final_revision_ref)) {
      fail(
        "cross_cohort_substitution",
        "P06 action authority binds a stale or cross-hypothesis revision"
      );
    }
  }
  for (const permission of disclosureScope.revision_permissions) {
    const final = finalById.get(permission.hypothesis_id);
    if (
      final === undefined ||
      !same(permission.revision_ref, final.final_revision_ref) ||
      permission.revision_sha256 !== final.revision_sha256 ||
      permission.body_sha256 !== final.body_sha256
    ) {
      fail(
        "cross_cohort_substitution",
        "P06 disclosure scope binds a stale or cross-hypothesis revision"
      );
    }
    exactBytes(input.store, permission.revision_ref, "P06 disclosed P05 hypothesis revision");
  }
  assertScaP06InputMetadata(disclosureScope.authority_ref, {
    run_id: request.run_id,
    kind: "sca-p06-disclosure-authority",
    operation_id: "sca-p06-disclosure-authority",
    schema_id: SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  });
  const disclosureAuthority = exactJson(
    input.store,
    disclosureScope.authority_ref,
    "P06 disclosure authority",
    validateScaP06DisclosureAuthorityV1
  );
  if (
    disclosureAuthority.tenant_id !== request.tenant_id ||
    disclosureAuthority.project_id !== request.project_id ||
    disclosureAuthority.run_id !== request.run_id ||
    disclosureAuthority.source_snapshot_sha256 !== sourceSha ||
    !same(disclosureAuthority.required_model, disclosureScope.required_model) ||
    disclosureAuthority.destination_class !== disclosureScope.destination_class ||
    disclosureAuthority.purpose !== disclosureScope.purpose ||
    !same(disclosureAuthority.allowed_data_classes, disclosureScope.allowed_data_classes) ||
    disclosureAuthority.provider_retention_status !== disclosureScope.provider_retention_status ||
    disclosureAuthority.provider_retention_days !== disclosureScope.provider_retention_days ||
    disclosureAuthority.provider_logging_status !== disclosureScope.provider_logging_status ||
    disclosureAuthority.provider_logging_days !== disclosureScope.provider_logging_days ||
    disclosureAuthority.provider_training_use !== disclosureScope.provider_training_use ||
    disclosureAuthority.max_payload_bytes_per_call !== disclosureScope.max_payload_bytes_per_call ||
    disclosureAuthority.max_provider_calls !== disclosureScope.max_provider_calls ||
    (disclosureScope.decision === "allow") !== (disclosureAuthority.decision === "approved")
  ) {
    fail("policy_mismatch", "P06 disclosure scope differs from exact typed authority");
  }
  return {
    request,
    implementation_identity: implementationIdentity,
    runtime_policy: runtimePolicy,
    action_authority: actionAuthority,
    resource_policy: resourcePolicy,
    disclosure_scope: disclosureScope,
    predecessor,
    transitive_refs: uniqueRefs([
      ...predecessor.exact_refs,
      request.implementation_identity_ref,
      request.runtime_policy_ref,
      request.action_authority_ref,
      request.resource_policy_ref,
      request.disclosure_scope_ref,
      disclosureScope.authority_ref,
      ...disclosureScope.revision_permissions.map((entry) => entry.revision_ref),
    ]),
  };
}

export function buildScaP06AcceptedCohort(input: {
  readonly admission: ScaP06AdmissionResultV1;
  readonly p06_request_ref: ArtifactRef;
  readonly admitted_at: string;
}): ScaP06AcceptedCohortV1 {
  const predecessor = input.admission.predecessor;
  return validateScaP06AcceptedCohortV1(
    withP06SelfDigest(
      {
        schema_id: SCA_P06_ACCEPTED_COHORT_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P06" as const,
        run_id: input.admission.request.run_id,
        p06_request_ref: input.p06_request_ref,
        p05_transition_ref: input.admission.request.p05_transition_ref,
        p05_gate_ref: predecessor.transition.p05_gate_ref,
        p05_successor_ledger_ref: predecessor.transition.successor_ledger_ref,
        p05_traceability_ref: predecessor.transition.traceability_ref,
        p05_evidence_manifest_ref: predecessor.transition.evidence_manifest_ref,
        source_snapshot_ref: predecessor.accepted_cohort.source_snapshot_ref,
        source_snapshot_sha256: predecessor.accepted_cohort.source_snapshot_sha256,
        active_hypothesis_ids: [...predecessor.transition.active_hypothesis_ids],
        refuted_hypothesis_ids: [...predecessor.transition.refuted_hypothesis_ids],
        final_hypotheses: [...predecessor.final_hypotheses],
        runtime_policy_ref: input.admission.request.runtime_policy_ref,
        action_authority_ref: input.admission.request.action_authority_ref,
        resource_policy_ref: input.admission.request.resource_policy_ref,
        disclosure_scope_ref: input.admission.request.disclosure_scope_ref,
        admitted_at: input.admitted_at,
      },
      "cohort_sha256"
    )
  );
}

void SCA_P06_REQUEST_V1_SCHEMA;
