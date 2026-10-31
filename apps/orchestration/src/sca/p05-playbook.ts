import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type JsonValue,
  type LivenessSnapshotV1,
  type LivenessTerminalReason,
  type OutputArtifactMetadata,
  type SkillContract,
  type StartRequest,
  validateContract,
  validateDirective,
} from "../contracts.js";
import { RunContext } from "../context.js";
import type { Playbook } from "../playbooks/playbook.js";
import {
  assertResolvedModelIdentity,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
  validateModelDispatchGuardV1,
  validateModelExecutionReceiptV1,
} from "../required-model.js";
import type {
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import {
  admitScaP05Candidate,
  buildScaP05AcceptedCohort,
  resolveScaP05EvidencePermissionValue,
  scaP05InputArtifacts,
  type ScaP05AdmissionResultV1,
} from "./p05-admission.js";
import {
  SCA_P05_SERIALIZED_OPENING_MAX_BYTES,
  SCA_P05_SERIALIZED_OPENING_RESERVE_BYTES,
} from "./p05-dispatch-guard.js";
import {
  SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P05_CHALLENGER_RESULT_V1_SCHEMA,
  SCA_P05_CHALLENGER_ROLE,
  SCA_P05_CHALLENGING_STATE,
  SCA_P05_CHECKPOINT_V1_SCHEMA,
  SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
  SCA_P05_CONSTRUCTOR_ROLE,
  SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA,
  SCA_P05_FINAL_STATE,
  SCA_P05_FORMING_STATE,
  SCA_P05_GATE_V1_SCHEMA,
  SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
  SCA_P05_OBLIGATION_IDS,
  SCA_P05_PROVIDER_OPENING_GUARD,
  SCA_P05_REQUEST_V1_SCHEMA,
  SCA_P05_REQUIRED_MODEL,
  SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
  SCA_P05_TERMINAL_V1_SCHEMA,
  SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
  SCA_P05_TRACEABILITY_V1_SCHEMA,
  ScaP05ChallengerResultV1Schema,
  ScaP05ConstructorResultV1Schema,
  ScaP05RequestV1Schema,
  scaP05HypothesisId,
  validateScaP05AcceptedCohortV1,
  validateScaP05ChallengerResultV1,
  validateScaP05CheckpointV1,
  validateScaP05CognitivePayloadV1,
  validateScaP05ConstructorResultV1,
  validateScaP05DisclosureAdmissionV1,
  validateScaP05DisclosureScopeV1,
  validateScaP05EvidenceManifestV1,
  validateScaP05GateV1,
  validateScaP05HypothesisAgainstPayload,
  validateScaP05HypothesisRevisionV1,
  validateScaP05RequestV1,
  validateScaP05SuccessorLedgerV1,
  validateScaP05TerminalV1,
  validateScaP05ToP06TransitionV1,
  validateScaP05TraceabilityV1,
  withSelfDigest,
  type ScaP05ChallengerResultV1,
  type ScaP05CognitivePayloadV1,
  type ScaP05ConstructorResultV1,
  type ScaP05DisclosureAdmissionV1,
  type ScaP05EvidenceAtomV1,
  type ScaP05HypothesisBodyV1,
  type ScaP05TraceabilityRowV1,
} from "./p05-contracts.js";

export const SCA_P05_CANDIDATE_PLAYBOOK_NAME = "sca-p05-candidate" as const;
export const SCA_P05_START_V1_SCHEMA = "penny.sca-p05-candidate-start.v1" as const;
const PHASE = "SCA-P05" as const;
const PRODUCER = "host:sca-p05-candidate" as const;

const ScaP05StartConstraintsV1Schema = Type.Object(
  { p05_request: ScaP05RequestV1Schema },
  { additionalProperties: false, $id: SCA_P05_START_V1_SCHEMA }
);

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const prior = byId.get(ref.artifact_id);
    if (prior !== undefined && !same(prior, ref)) throw new Error("conflicting artifact refs");
    byId.set(ref.artifact_id, ref);
  }
  return [...byId.values()].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
}
function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) throw new Error(`${label} exact ref is absent`);
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`${label} exact bytes drifted`);
  }
  return bytes;
}
function exactJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const parsed: unknown = JSON.parse(exactBytes(store, ref, label).toString("utf8"));
  return parsed;
}
function latestSelected(
  context: RunContext,
  predicate: (ref: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts].reverse().find(predicate);
}
function persistJson(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly schema_id: string;
  readonly value: unknown;
  readonly upstream_refs: readonly ArtifactRef[];
  readonly parent_ref?: ArtifactRef | null;
  readonly context?: RunContext;
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const prior = input.store.refFor(input.run_id, PHASE, null, input.kind, input.operation_id, 1);
  if (prior !== null) {
    if (
      prior.content_digest !== sha256(content) ||
      input.store.readById(prior.artifact_id).toString("utf8") !== content
    ) {
      throw new Error(`P05 artifact '${input.operation_id}' conflicts with immutable prior bytes`);
    }
    input.store.select(prior);
    if (
      input.context !== undefined &&
      !input.context.selectedArtifacts.some((ref) => ref.artifact_id === prior.artifact_id)
    ) {
      input.context.selectedArtifacts.push(prior);
    }
    return prior;
  }
  const ref = input.store.persist({
    metadata: {
      schema_version: 2,
      run_id: input.run_id,
      phase: PHASE,
      branch_id: null,
      kind: input.kind,
      operation_id: input.operation_id,
      version: 1,
      producer: PRODUCER,
      media_type: "application/json",
      content_schema: { schema_id: input.schema_id, schema_version: 1 },
      parent_ref: input.parent_ref ?? null,
      upstream_refs: uniqueRefs(input.upstream_refs),
    },
    content,
  });
  input.store.select(ref);
  if (input.context !== undefined) input.context.selectedArtifacts.push(ref);
  return ref;
}
function outputArtifact(
  runId: string,
  state: typeof SCA_P05_FORMING_STATE | typeof SCA_P05_CHALLENGING_STATE,
  agent: "ida" | "annie"
): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: runId,
    phase: state,
    branch_id: null,
    kind:
      state === SCA_P05_FORMING_STATE ? "sca-p05-constructor-output" : "sca-p05-challenger-output",
    operation_id:
      state === SCA_P05_FORMING_STATE ? "sca-p05-constructor-output" : "sca-p05-challenger-output",
    version: 1,
    producer: `agent:${agent}`,
    media_type: "text/plain",
    content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
}

function changedHypothesisFields(
  before: ScaP05HypothesisBodyV1,
  after: ScaP05HypothesisBodyV1
): string[] {
  const fields: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["bounded_claim", before.bounded_claim, after.bounded_claim],
    ["actor", before.actor, after.actor],
    ["controlled_input", before.controlled_input, after.controlled_input],
    ["relevant_state", before.relevant_state, after.relevant_state],
    ["causal_path", before.causal_path, after.causal_path],
    [
      "security_sensitive_outcome",
      before.security_sensitive_outcome,
      after.security_sensitive_outcome,
    ],
    [
      "competing_benign_explanation",
      before.competing_benign_explanation,
      after.competing_benign_explanation,
    ],
    [
      "expected_supporting_observations",
      before.expected_supporting_observations,
      after.expected_supporting_observations,
    ],
    [
      "expected_refuting_observations",
      before.expected_refuting_observations,
      after.expected_refuting_observations,
    ],
    ["next_evidence_need", before.next_evidence_need, after.next_evidence_need],
    ["stopping_conditions", before.stopping_conditions, after.stopping_conditions],
    ["reopening_conditions", before.reopening_conditions, after.reopening_conditions],
  ];
  return fields
    .filter(([, left, right]) => !same(left, right))
    .map(([field]) => field)
    .sort();
}

function evidenceAtomIds(body: ScaP05HypothesisBodyV1): string[] {
  return [
    ...body.actor.evidence_atom_ids,
    ...body.controlled_input.evidence_atom_ids,
    ...body.relevant_state.evidence_atom_ids,
    ...body.causal_path.flatMap((entry) => entry.evidence_atom_ids),
    ...body.security_sensitive_outcome.evidence_atom_ids,
    ...body.competing_benign_explanation.evidence_atom_ids,
    ...body.expected_supporting_observations.flatMap((entry) => entry.basis_atom_ids),
    ...body.expected_refuting_observations.flatMap((entry) => entry.basis_atom_ids),
  ];
}

function buildEvidenceAtoms(
  store: ArtifactHostStore,
  admission: ScaP05AdmissionResultV1
): ScaP05EvidenceAtomV1[] {
  const atoms = admission.disclosure_scope.evidence_permissions.map((permission) => {
    const value = resolveScaP05EvidencePermissionValue({ store, admission, permission });
    if (sha256(canonicalJson(value)) !== permission.value_sha256) {
      throw new Error(`P05 evidence permission '${permission.atom_id}' value digest mismatch`);
    }
    return {
      atom_id: permission.atom_id,
      selected_item_id: permission.selected_item_id,
      atom_kind: permission.atom_kind,
      origin_ref: permission.origin_ref,
      selector: permission.selector,
      value_sha256: permission.value_sha256,
      value,
    };
  });
  return atoms.sort((a, b) => a.atom_id.localeCompare(b.atom_id));
}

function buildPayload(input: {
  readonly store: ArtifactHostStore;
  readonly admission: ScaP05AdmissionResultV1;
  readonly accepted_cohort_ref: ArtifactRef;
  readonly role: typeof SCA_P05_CONSTRUCTOR_ROLE | typeof SCA_P05_CHALLENGER_ROLE;
  readonly constructor_result_ref: ArtifactRef | null;
  readonly constructor_result: ScaP05ConstructorResultV1 | null;
}): ScaP05CognitivePayloadV1 {
  const atoms = buildEvidenceAtoms(input.store, input.admission);
  const selected = [...input.admission.predecessor.selection_dossier.selected].sort((a, b) =>
    a.stable_id.localeCompare(b.stable_id)
  );
  const assignedIds =
    input.role === SCA_P05_CONSTRUCTOR_ROLE
      ? selected.map((entry) => entry.stable_id)
      : (input.constructor_result?.items
          .filter((entry) => entry.disposition === "formed")
          .map((entry) => entry.selected_item_id)
          .sort() ?? []);
  if (assignedIds.length === 0 && input.role === SCA_P05_CHALLENGER_ROLE) {
    throw new Error("P05 cannot build a challenger payload without formed hypotheses");
  }
  const body = {
    schema_id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
    schema_version: 1 as const,
    run_id: input.admission.request.run_id,
    phase_id: PHASE,
    call_id:
      input.role === SCA_P05_CONSTRUCTOR_ROLE
        ? "sca-p05-hypothesis-constructor"
        : "sca-p05-falsification-challenger",
    role: input.role,
    purpose:
      input.role === SCA_P05_CONSTRUCTOR_ROLE
        ? ("p05_hypothesis_construction" as const)
        : ("p05_falsification_challenge" as const),
    required_model: SCA_P05_REQUIRED_MODEL,
    accepted_cohort_ref: input.accepted_cohort_ref,
    source_snapshot_ref: input.admission.disclosure_scope.source_snapshot_ref,
    source_snapshot_sha256: input.admission.disclosure_scope.source_snapshot_sha256,
    assigned_item_ids: assignedIds,
    items: selected
      .filter((entry) => assignedIds.includes(entry.stable_id))
      .map((entry) => ({
        selected_item_id: entry.stable_id,
        expected_hypothesis_id: scaP05HypothesisId(
          input.admission.disclosure_scope.source_snapshot_sha256,
          entry.stable_id
        ),
        normalized_locator:
          entry.source_path ?? entry.package_coordinate ?? `p04-selection:${entry.stable_id}`,
        source_path: entry.source_path,
        package_coordinate: entry.package_coordinate,
        selection_rationale_code: entry.reason_code,
        evidence_atom_ids: atoms
          .filter((atom) => atom.selected_item_id === entry.stable_id)
          .map((atom) => atom.atom_id)
          .sort(),
      })),
    evidence_atoms: atoms.filter((atom) => assignedIds.includes(atom.selected_item_id)),
    constructor_result_ref: input.constructor_result_ref,
    constructor_result: input.constructor_result,
    disclosure_scope_ref: input.admission.request.disclosure_scope_ref,
    content_mode: "authorized_segments_and_exact_evidence_atoms" as const,
  };
  return validateScaP05CognitivePayloadV1(withSelfDigest(body, "payload_sha256"));
}

function buildDisclosure(input: {
  readonly admission: ScaP05AdmissionResultV1;
  readonly payload: ScaP05CognitivePayloadV1;
  readonly payload_ref: ArtifactRef;
}): ScaP05DisclosureAdmissionV1 {
  const scope = input.admission.disclosure_scope;
  const segmentIds = input.payload.evidence_atoms
    .filter((entry) => entry.atom_kind === "source_segment")
    .map((entry) => entry.selector.replace(/^source-segment:/u, ""))
    .sort();
  const atomIds = input.payload.evidence_atoms.map((entry) => entry.atom_id).sort();
  const blockerCodes: string[] = [];
  const openingLimit = Math.min(
    input.admission.runtime_policy.max_payload_bytes_per_call,
    scope.max_payload_bytes_per_call,
    SCA_P05_SERIALIZED_OPENING_MAX_BYTES
  );
  if (input.payload_ref.byte_length > openingLimit - SCA_P05_SERIALIZED_OPENING_RESERVE_BYTES) {
    blockerCodes.push("payload_size_denied");
  }
  if (scope.decision !== "allow") blockerCodes.push("disclosure_scope_denied");
  if (segmentIds.some((id) => !scope.source_segments.some((entry) => entry.segment_id === id))) {
    blockerCodes.push("source_segment_not_authorized");
  }
  if (atomIds.some((id) => !scope.evidence_permissions.some((entry) => entry.atom_id === id))) {
    blockerCodes.push("evidence_atom_not_authorized");
  }
  const value = withSelfDigest(
    {
      schema_id: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
      schema_version: 1 as const,
      run_id: input.admission.request.run_id,
      phase_id: PHASE,
      call_id: input.payload.call_id,
      role: input.payload.role,
      purpose: input.payload.purpose,
      required_model: SCA_P05_REQUIRED_MODEL,
      disclosure_scope_ref: input.admission.request.disclosure_scope_ref,
      disclosure_scope_sha256: scope.scope_sha256,
      payload_ref: input.payload_ref,
      payload_sha256: input.payload_ref.content_digest,
      payload_byte_length: input.payload_ref.byte_length,
      serialized_opening_byte_limit: openingLimit,
      authorized_segment_ids: segmentIds,
      authorized_atom_ids: atomIds,
      destination: "cloud" as const,
      retention_days: scope.provider_retention_days,
      logging_status: scope.provider_logging_status,
      logging_days: scope.provider_logging_days,
      training: "prohibited" as const,
      secrets_embedded: false as const,
      personal_data_embedded: false as const,
      decision: blockerCodes.length === 0 ? ("allow" as const) : ("deny" as const),
      blocker_codes: [...new Set(blockerCodes)].sort(),
      evaluated_before_dispatch: true as const,
    },
    "admission_sha256"
  );
  return validateScaP05DisclosureAdmissionV1(value);
}

const START_ADMISSION: StartAdmissionV1 = {
  schema_id: SCA_P05_START_V1_SCHEMA,
  schema_version: 1,
  prepare(request: StartRequest): PreparedStartV1 {
    const constraints = validateContract(
      ScaP05StartConstraintsV1Schema,
      request.constraints,
      "SCA P05 start constraints"
    );
    const p05 = validateScaP05RequestV1(constraints.p05_request);
    if (
      request.identity.playbook !== SCA_P05_CANDIDATE_PLAYBOOK_NAME ||
      request.identity.run_id !== p05.run_id ||
      request.input_artifacts === undefined ||
      !same(request.input_artifacts, scaP05InputArtifacts(p05))
    ) {
      throw new Error("SCA P05 start identity or exact input set is invalid");
    }
    return {
      schema_id: SCA_P05_START_V1_SCHEMA,
      schema_version: 1,
      request,
      goal: request.goal,
      constraints,
      input_artifacts: request.input_artifacts,
      admission_data: p05,
    };
  },
  materialize(prepared, host) {
    if (host.artifactStore === undefined || prepared.input_artifacts === undefined) {
      throw new Error("SCA P05 materialization requires artifact store and exact inputs");
    }
    const clock = host.trustedClock ?? (() => new Date());
    const admission = admitScaP05Candidate({
      store: host.artifactStore,
      request: prepared.admission_data,
      input_artifacts: prepared.input_artifacts,
      trusted_clock: clock,
    });
    const requestRef = persistJson({
      store: host.artifactStore,
      run_id: host.run_id,
      kind: "sca-p05-candidate-request",
      operation_id: "sca-p05-candidate-request",
      schema_id: SCA_P05_REQUEST_V1_SCHEMA,
      value: admission.request,
      upstream_refs: prepared.input_artifacts.artifacts.map((entry) => entry.ref),
    });
    const now = clock();
    if (!Number.isFinite(now.getTime())) throw new Error("SCA P05 trusted clock is invalid");
    const cohort = buildScaP05AcceptedCohort({
      admission,
      p05_request_ref: requestRef,
      admitted_at: now.toISOString(),
    });
    const cohortRef = persistJson({
      store: host.artifactStore,
      run_id: host.run_id,
      kind: "sca-p05-accepted-cohort",
      operation_id: "sca-p05-accepted-cohort",
      schema_id: SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
      value: cohort,
      upstream_refs: [requestRef, ...admission.transitive_refs],
    });
    const payload = buildPayload({
      store: host.artifactStore,
      admission,
      accepted_cohort_ref: cohortRef,
      role: SCA_P05_CONSTRUCTOR_ROLE,
      constructor_result_ref: null,
      constructor_result: null,
    });
    const payloadRef = persistJson({
      store: host.artifactStore,
      run_id: host.run_id,
      kind: "sca-p05-cognitive-payload",
      operation_id: "sca-p05-constructor-payload",
      schema_id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
      value: payload,
      upstream_refs: [cohortRef, admission.request.disclosure_scope_ref],
    });
    const disclosure = buildDisclosure({ admission, payload, payload_ref: payloadRef });
    const disclosureRef = persistJson({
      store: host.artifactStore,
      run_id: host.run_id,
      kind: "sca-p05-disclosure-admission",
      operation_id: "sca-p05-constructor-disclosure",
      schema_id: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: disclosure,
      upstream_refs: [payloadRef, admission.request.disclosure_scope_ref],
    });
    return [requestRef, cohortRef, payloadRef, disclosureRef];
  },
};

const P05DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    accepted_cohort_ref: ArtifactRefSchema,
    constructor_payload_ref: ArtifactRefSchema,
    constructor_disclosure_ref: ArtifactRefSchema,
    challenger_payload_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    challenger_disclosure_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
type P05Data = Readonly<Static<typeof P05DataSchema>>;
function data(context: RunContext): P05Data {
  return validateContract(P05DataSchema, context.playbookData, "SCA P05 durable state");
}

export class ScaP05CandidatePlaybook implements Playbook {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly trustedClock: () => Date = () => new Date()
  ) {}

  initialize(context: RunContext): Directive {
    const requestRef = latestSelected(
      context,
      (ref) => ref.kind === "sca-p05-candidate-request" && ref.run_id === context.identity.run_id
    );
    const cohortRef = latestSelected(context, (ref) => ref.kind === "sca-p05-accepted-cohort");
    const payloadRef = latestSelected(
      context,
      (ref) =>
        ref.kind === "sca-p05-cognitive-payload" &&
        ref.operation_id === "sca-p05-constructor-payload"
    );
    const disclosureRef = latestSelected(
      context,
      (ref) =>
        ref.kind === "sca-p05-disclosure-admission" &&
        ref.operation_id === "sca-p05-constructor-disclosure"
    );
    if (!requestRef || !cohortRef || !payloadRef || !disclosureRef) {
      throw new Error("SCA P05 entry artifacts are absent");
    }
    validateScaP05AcceptedCohortV1(exactJson(this.store, cohortRef, "P05 cohort"));
    const disclosure = validateScaP05DisclosureAdmissionV1(
      exactJson(this.store, disclosureRef, "P05 constructor disclosure")
    );
    Object.assign(context.playbookData, {
      request_ref: requestRef,
      accepted_cohort_ref: cohortRef,
      constructor_payload_ref: payloadRef,
      constructor_disclosure_ref: disclosureRef,
      challenger_payload_ref: null,
      challenger_disclosure_ref: null,
    });
    if (disclosure.decision !== "allow") {
      const cohort = validateScaP05AcceptedCohortV1(
        exactJson(this.store, cohortRef, "P05 denied constructor cohort")
      );
      const result = validateScaP05ConstructorResultV1({
        schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
        schema_version: 1,
        role: SCA_P05_CONSTRUCTOR_ROLE,
        payload_sha256: payloadRef.content_digest,
        assigned_item_ids: [...cohort.selected_item_ids],
        items: cohort.selected_item_ids.map((selectedItemId) => ({
          selected_item_id: selectedItemId,
          disposition: "checkpointed_incomplete" as const,
          hypothesis: null,
          reason_code: "payload_limit" as const,
          missing_evidence_need:
            "An exact constructor payload authorized for provider disclosure is required.",
          stop_condition: "Stop before provider dispatch or hypothesis construction.",
          reopen_condition:
            "Reopen in a fresh run after an exact disclosure scope authorizes the constructor payload.",
          vulnerability_adjudication: "not_performed" as const,
          safe_claim: false as const,
        })),
        complete: true,
      });
      for (const item of result.items) {
        if (item.disposition !== "checkpointed_incomplete") continue;
        this.persistCheckpoint(context, {
          selected_item_id: item.selected_item_id,
          stage: "constructor",
          reason_code: "constructor_disclosure_denied",
          evidence_refs: [cohortRef, payloadRef, disclosureRef],
          missing_evidence_need: item.missing_evidence_need,
          stop_condition: item.stop_condition,
          reopen_condition: item.reopen_condition,
        });
      }
      context.transition(SCA_P05_FINAL_STATE);
      return this.finalize(context, result, null);
    }
    context.transition(SCA_P05_FORMING_STATE);
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    const state = data(context);
    if (context.stateId === SCA_P05_FORMING_STATE) {
      const artifact = outputArtifact(context.identity.run_id, SCA_P05_FORMING_STATE, "ida");
      artifact.upstream_refs = [state.constructor_payload_ref, state.constructor_disclosure_ref];
      const directive = validateDirective({
        schema_version: 2,
        action: "invoke_agent",
        identity: context.identity,
        state_id: SCA_P05_FORMING_STATE,
        agent: "ida",
        attempt: 1,
        task: "Construct one complete falsifiable bounded hypothesis or one explicit incomplete checkpoint for every assigned P04 selection in the inline host-authorized payload. Use only exact evidence atoms. Do not adjudicate a vulnerability or claim safety. No tools are available.",
        input_artifacts: {
          schema_version: 2,
          artifacts: [
            { slot: "cognitive_payload", ref: state.constructor_payload_ref },
            { slot: "disclosure_admission", ref: state.constructor_disclosure_ref },
          ],
        },
        output_artifact: artifact,
        trust_profile: "hardened-untrusted",
        model_override: SCA_P05_REQUIRED_MODEL.override,
      });
      context.pendingDirective = directive;
      return directive;
    }
    if (context.stateId === SCA_P05_CHALLENGING_STATE) {
      if (state.challenger_payload_ref === null || state.challenger_disclosure_ref === null) {
        throw new Error("SCA P05 challenger inputs are absent");
      }
      const artifact = outputArtifact(context.identity.run_id, SCA_P05_CHALLENGING_STATE, "annie");
      artifact.upstream_refs = [state.challenger_payload_ref, state.challenger_disclosure_ref];
      const directive = validateDirective({
        schema_version: 2,
        action: "invoke_agent",
        identity: context.identity,
        state_id: SCA_P05_CHALLENGING_STATE,
        agent: "annie",
        attempt: 1,
        task: "Challenge every formed hypothesis against its exact evidence atoms and competing benign explanation. Accept, return a complete replacement revision, refute only with an exact existing control, or checkpoint unable-to-validate. Seek counterevidence. Do not make broad safety claims. No tools are available.",
        input_artifacts: {
          schema_version: 2,
          artifacts: [
            { slot: "cognitive_payload", ref: state.challenger_payload_ref },
            { slot: "disclosure_admission", ref: state.challenger_disclosure_ref },
          ],
        },
        output_artifact: artifact,
        trust_profile: "hardened-untrusted",
        model_override: SCA_P05_REQUIRED_MODEL.override,
      });
      context.pendingDirective = directive;
      return directive;
    }
    throw new Error(`SCA P05 has no dispatch for '${context.stateId}'`);
  }

  resume(): Directive {
    throw new Error("SCA P05 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    const priorState = context.stateId;
    if (priorState === SCA_P05_FORMING_STATE || priorState === SCA_P05_CHALLENGING_STATE) {
      const state = data(context);
      const cohort = validateScaP05AcceptedCohortV1(
        exactJson(this.store, state.accepted_cohort_ref, "P05 cancellation cohort")
      );
      const stage = priorState === SCA_P05_FORMING_STATE ? "constructor" : "challenger";
      const payloadRef =
        priorState === SCA_P05_FORMING_STATE
          ? state.constructor_payload_ref
          : state.challenger_payload_ref;
      const disclosureRef =
        priorState === SCA_P05_FORMING_STATE
          ? state.constructor_disclosure_ref
          : state.challenger_disclosure_ref;
      const pending = context.pendingDirective;
      const dispatchEvidence =
        pending?.action === "invoke_agent"
          ? [
              this.store.refFor(
                context.identity.run_id,
                pending.state_id,
                null,
                pending.output_artifact.kind,
                pending.output_artifact.operation_id,
                pending.output_artifact.version
              ),
              this.store.refFor(
                context.identity.run_id,
                pending.state_id,
                null,
                "model-dispatch-guard",
                modelDispatchGuardOperationId({
                  run_id: context.identity.run_id,
                  state_id: pending.state_id,
                  branch_id: null,
                  agent: pending.agent,
                  attempt: pending.attempt,
                }),
                1
              ),
              this.store.refFor(
                context.identity.run_id,
                pending.state_id,
                null,
                "model-execution-receipt",
                modelExecutionReceiptOperationId({
                  run_id: context.identity.run_id,
                  state_id: pending.state_id,
                  branch_id: null,
                  agent: pending.agent,
                  attempt: pending.attempt,
                }),
                1
              ),
            ].filter((ref): ref is ArtifactRef => ref !== null)
          : [];
      for (const selectedItemId of cohort.selected_item_ids) {
        if (
          latestSelected(
            context,
            (ref) =>
              ref.kind === "sca-p05-checkpoint" &&
              ref.operation_id === `sca-p05-${selectedItemId}-checkpoint`
          ) !== undefined
        ) {
          continue;
        }
        this.persistCheckpoint(context, {
          selected_item_id: selectedItemId,
          stage,
          reason_code: reason.startsWith("model call outcome remote_unknown")
            ? "remote_model_outcome_unknown"
            : reason.startsWith("model outcome persisted but not committed")
              ? "uncommitted_model_outcome_quarantined"
              : reason.startsWith("pre-dispatch policy denied")
                ? "pre_dispatch_policy_denied"
                : "caller_cancelled",
          evidence_refs: uniqueRefs([
            state.accepted_cohort_ref,
            ...(payloadRef ? [payloadRef] : []),
            ...(disclosureRef ? [disclosureRef] : []),
            ...dispatchEvidence,
          ]),
          missing_evidence_need:
            "A confirmed complete model outcome for this stage is unavailable.",
          stop_condition:
            "Stop before treating the interrupted stage as complete or replaying an unknown dispatch.",
          reopen_condition:
            "Reopen only through an explicit fresh run or an operator-admitted exact recovered outcome.",
        });
      }
    }
    context.previousState = priorState;
    context.stateId = "sca_p05_cancelled";
    context.status = "cancelled";
    context.met = false;
    return this.terminal(context, "cancelled", false, [
      reason.startsWith("model call outcome remote_unknown")
        ? "remote_model_outcome_unknown"
        : reason.startsWith("model outcome persisted but not committed")
          ? "uncommitted_model_outcome_quarantined"
          : reason.startsWith("pre-dispatch policy denied")
            ? "pre_dispatch_policy_denied"
            : "caller_cancelled",
    ]);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (
      (context.stateId === SCA_P05_FORMING_STATE ||
        context.stateId === SCA_P05_CHALLENGING_STATE) &&
      pending?.action === "invoke_agent"
    ) {
      const coordinate = {
        run_id: context.identity.run_id,
        state_id: pending.state_id,
        branch_id: null,
        agent: pending.agent,
        attempt: pending.attempt,
      };
      const guardRef = this.store.refFor(
        context.identity.run_id,
        pending.state_id,
        null,
        "model-dispatch-guard",
        modelDispatchGuardOperationId(coordinate),
        1
      );
      if (guardRef !== null) {
        const outputRef = this.store.refFor(
          context.identity.run_id,
          pending.state_id,
          null,
          pending.output_artifact.kind,
          pending.output_artifact.operation_id,
          pending.output_artifact.version
        );
        const receiptRef = this.store.refFor(
          context.identity.run_id,
          pending.state_id,
          null,
          "model-execution-receipt",
          modelExecutionReceiptOperationId(coordinate),
          1
        );
        let completeBoundOutcome = false;
        if (
          outputRef !== null &&
          receiptRef !== null &&
          ((pending.state_id === SCA_P05_FORMING_STATE && pending.agent === "ida") ||
            (pending.state_id === SCA_P05_CHALLENGING_STATE && pending.agent === "annie"))
        ) {
          try {
            this.executionEvidence(context, pending.state_id, pending.agent, outputRef);
            completeBoundOutcome = true;
          } catch {
            completeBoundOutcome = false;
          }
        }
        return this.cancel(
          context,
          completeBoundOutcome
            ? "model outcome persisted but not committed; durable fencing prohibits implicit acceptance or replay"
            : "model call outcome remote_unknown; durable dispatch fencing prohibits automatic replay"
        );
      }
    }
    return pending;
  }

  terminalizeLiveness(
    context: RunContext,
    reason: LivenessTerminalReason,
    _snapshot: LivenessSnapshotV1
  ): Directive {
    if (
      context.stateId === SCA_P05_FORMING_STATE ||
      context.stateId === SCA_P05_CHALLENGING_STATE
    ) {
      const state = data(context);
      const cohort = validateScaP05AcceptedCohortV1(
        exactJson(this.store, state.accepted_cohort_ref, "P05 liveness cohort")
      );
      const constructorStage = context.stateId === SCA_P05_FORMING_STATE;
      const stage = constructorStage ? "constructor" : "challenger";
      const payloadRef = constructorStage
        ? state.constructor_payload_ref
        : state.challenger_payload_ref;
      const disclosureRef = constructorStage
        ? state.constructor_disclosure_ref
        : state.challenger_disclosure_ref;
      const agent = constructorStage ? "ida" : "annie";
      const outputKind = constructorStage
        ? "sca-p05-constructor-output"
        : "sca-p05-challenger-output";
      const outputRef = latestSelected(context, (ref) => ref.kind === outputKind);
      const coordinate = {
        run_id: context.identity.run_id,
        state_id: context.stateId,
        branch_id: null,
        agent,
        attempt: 1,
      };
      const guardRef = this.store.refFor(
        context.identity.run_id,
        context.stateId,
        null,
        "model-dispatch-guard",
        modelDispatchGuardOperationId(coordinate),
        1
      );
      const receiptRef = this.store.refFor(
        context.identity.run_id,
        context.stateId,
        null,
        "model-execution-receipt",
        modelExecutionReceiptOperationId(coordinate),
        1
      );
      const evidenceRefs = uniqueRefs([
        state.accepted_cohort_ref,
        ...(payloadRef ? [payloadRef] : []),
        ...(disclosureRef ? [disclosureRef] : []),
        ...(outputRef ? [outputRef] : []),
        ...(guardRef ? [guardRef] : []),
        ...(receiptRef ? [receiptRef] : []),
      ]);
      for (const selectedItemId of cohort.selected_item_ids) {
        if (
          latestSelected(
            context,
            (ref) =>
              ref.kind === "sca-p05-checkpoint" &&
              ref.operation_id === `sca-p05-${selectedItemId}-checkpoint`
          ) === undefined
        ) {
          this.persistCheckpoint(context, {
            selected_item_id: selectedItemId,
            stage,
            reason_code: `liveness_${reason}`,
            evidence_refs: evidenceRefs,
            missing_evidence_need:
              "A schema-valid exhaustive semantic result for this stage is unavailable.",
            stop_condition:
              "Stop without retrying or treating malformed/incomplete semantic output as evidence.",
            reopen_condition:
              "Reopen only through an explicit fresh run with a newly admitted model dispatch.",
          });
        }
      }
    }
    context.transition(SCA_P05_FINAL_STATE);
    return this.terminal(context, "blocked", false, [`liveness_${reason}`]);
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    if (context.stateId === SCA_P05_FORMING_STATE) {
      const state = data(context);
      let result: ScaP05ConstructorResultV1;
      let payload: ScaP05CognitivePayloadV1;
      try {
        result = validateScaP05ConstructorResultV1(details);
        payload = validateScaP05CognitivePayloadV1(
          exactJson(this.store, state.constructor_payload_ref, "P05 constructor payload")
        );
        if (
          result.payload_sha256 !== state.constructor_payload_ref.content_digest ||
          !same(result.assigned_item_ids, payload.assigned_item_ids)
        ) {
          throw new Error("SCA P05 constructor result payload or assignment binding mismatch");
        }
        for (const item of result.items) {
          if (item.disposition === "formed") {
            validateScaP05HypothesisAgainstPayload(item.hypothesis, payload);
          }
        }
      } catch (error) {
        return this.semanticRejection(context, "constructor", error);
      }
      const outputRef = latestSelected(context, (ref) => ref.kind === "sca-p05-constructor-output");
      if (outputRef === undefined) throw new Error("SCA P05 constructor output ref is absent");
      for (const item of result.items) {
        if (item.disposition === "formed") {
          this.persistRevision(
            context,
            item.hypothesis,
            1,
            null,
            state.constructor_payload_ref,
            outputRef,
            ["initial_constructor"],
            []
          );
        } else {
          this.persistCheckpoint(context, {
            selected_item_id: item.selected_item_id,
            stage: "constructor",
            reason_code: item.reason_code,
            evidence_refs: [state.constructor_payload_ref, outputRef],
            missing_evidence_need: item.missing_evidence_need,
            stop_condition: item.stop_condition,
            reopen_condition: item.reopen_condition,
          });
        }
      }
      const formed = result.items.filter((item) => item.disposition === "formed");
      if (formed.length === 0) {
        context.transition(SCA_P05_FINAL_STATE);
        return this.finalize(context, result, null);
      }
      const request = validateScaP05RequestV1(
        exactJson(this.store, state.request_ref, "P05 request")
      );
      const admission = admitScaP05Candidate({
        store: this.store,
        request,
        input_artifacts: scaP05InputArtifacts(request),
        trusted_clock: this.trustedClock,
      });
      const challengerPayload = buildPayload({
        store: this.store,
        admission,
        accepted_cohort_ref: state.accepted_cohort_ref,
        role: SCA_P05_CHALLENGER_ROLE,
        constructor_result_ref: outputRef,
        constructor_result: result,
      });
      const challengerPayloadRef = persistJson({
        store: this.store,
        run_id: context.identity.run_id,
        kind: "sca-p05-cognitive-payload",
        operation_id: "sca-p05-challenger-payload",
        schema_id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
        value: challengerPayload,
        upstream_refs: [state.accepted_cohort_ref, outputRef, request.disclosure_scope_ref],
        context,
      });
      const challengerDisclosure = buildDisclosure({
        admission,
        payload: challengerPayload,
        payload_ref: challengerPayloadRef,
      });
      const challengerDisclosureRef = persistJson({
        store: this.store,
        run_id: context.identity.run_id,
        kind: "sca-p05-disclosure-admission",
        operation_id: "sca-p05-challenger-disclosure",
        schema_id: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
        value: challengerDisclosure,
        upstream_refs: [challengerPayloadRef, request.disclosure_scope_ref],
        context,
      });
      Object.assign(context.playbookData, {
        challenger_payload_ref: challengerPayloadRef,
        challenger_disclosure_ref: challengerDisclosureRef,
      });
      if (challengerDisclosure.decision !== "allow") {
        for (const item of formed) {
          this.persistCheckpoint(context, {
            selected_item_id: item.selected_item_id,
            stage: "challenger",
            reason_code: "challenger_disclosure_denied",
            evidence_refs: [challengerPayloadRef, challengerDisclosureRef],
            missing_evidence_need: "An authorized challenger payload is required.",
            stop_condition: "Stop before provider dispatch.",
            reopen_condition: "Reopen after a valid disclosure scope authorizes the exact payload.",
          });
        }
        context.transition(SCA_P05_FINAL_STATE);
        return this.finalize(context, result, null);
      }
      context.transition(SCA_P05_CHALLENGING_STATE);
      return this.dispatch(context);
    }
    if (context.stateId === SCA_P05_CHALLENGING_STATE) {
      const state = data(context);
      let challenger: ScaP05ChallengerResultV1;
      let payload: ScaP05CognitivePayloadV1;
      try {
        challenger = validateScaP05ChallengerResultV1(details);
        if (state.challenger_payload_ref === null) throw new Error("P05 challenger payload absent");
        payload = validateScaP05CognitivePayloadV1(
          exactJson(this.store, state.challenger_payload_ref, "P05 challenger payload")
        );
        if (
          challenger.payload_sha256 !== state.challenger_payload_ref.content_digest ||
          !same(challenger.assigned_item_ids, payload.assigned_item_ids)
        ) {
          throw new Error("SCA P05 challenger result payload or assignment binding mismatch");
        }
      } catch (error) {
        return this.semanticRejection(context, "challenger", error);
      }
      const constructorRef = latestSelected(
        context,
        (ref) => ref.kind === "sca-p05-constructor-output"
      );
      const challengerRef = latestSelected(
        context,
        (ref) => ref.kind === "sca-p05-challenger-output"
      );
      if (!constructorRef || !challengerRef) throw new Error("P05 semantic output refs absent");
      const constructor = validateScaP05ConstructorResultV1(
        this.parsePersistedPhaseOutput(constructorRef)
      );
      const formed = new Map(
        constructor.items
          .filter((entry) => entry.disposition === "formed")
          .map((entry) => [entry.selected_item_id, entry.hypothesis])
      );
      try {
        for (const item of challenger.items) {
          const original = formed.get(item.selected_item_id);
          if (original === undefined || original.hypothesis_id !== item.hypothesis_id) {
            throw new Error("SCA P05 challenger item is outside constructor output");
          }
          if (item.decision === "revise_for_investigation") {
            validateScaP05HypothesisAgainstPayload(item.replacement_hypothesis, payload);
          }
        }
      } catch (error) {
        return this.semanticRejection(context, "challenger", error);
      }
      for (const item of challenger.items) {
        const original = formed.get(item.selected_item_id);
        if (original === undefined) {
          return this.semanticRejection(
            context,
            "challenger",
            new Error("SCA P05 challenger item is outside constructor output")
          );
        }
        if (item.decision === "revise_for_investigation") {
          const computedChangedFields = changedHypothesisFields(
            original,
            item.replacement_hypothesis
          );
          if (!same(computedChangedFields, item.changed_fields)) {
            this.persistCheckpoint(context, {
              selected_item_id: item.selected_item_id,
              stage: "challenger",
              reason_code: "revision_change_set_mismatch",
              evidence_refs: [state.challenger_payload_ref, challengerRef],
              missing_evidence_need:
                "The challenger revision must declare the exact host-computed changed field set.",
              stop_condition: "Stop before accepting an inaccurate revision audit record.",
              reopen_condition:
                "Reopen in a fresh run when the challenger returns an exact complete changed field set.",
            });
            continue;
          }
          const parent = this.revisionRef(context, item.selected_item_id, 1);
          this.persistRevision(
            context,
            item.replacement_hypothesis,
            2,
            parent,
            state.challenger_payload_ref,
            challengerRef,
            ["challenger_revision"],
            computedChangedFields
          );
        } else if (item.decision === "refute_with_existing_control") {
          const atoms = new Map(payload.evidence_atoms.map((entry) => [entry.atom_id, entry]));
          const originalAtomIds = new Set(evidenceAtomIds(original));
          if (
            item.control_atom_ids.some((id) => {
              const atom = atoms.get(id);
              return (
                atom?.atom_kind !== "control_record" ||
                atom.selected_item_id !== item.selected_item_id ||
                !originalAtomIds.has(id)
              );
            })
          ) {
            this.persistCheckpoint(context, {
              selected_item_id: item.selected_item_id,
              stage: "challenger",
              reason_code: "refutation_control_binding_mismatch",
              evidence_refs: [state.challenger_payload_ref, challengerRef],
              missing_evidence_need:
                "A same-item typed existing-control atom cited by the challenged hypothesis is required.",
              stop_condition: "Stop before accepting an unbound control refutation.",
              reopen_condition:
                "Reopen in a fresh run after exact same-item control evidence is admitted and cited.",
            });
            continue;
          }
        } else if (item.decision === "unable_to_validate") {
          this.persistCheckpoint(context, {
            selected_item_id: item.selected_item_id,
            stage: "challenger",
            reason_code: item.reason_code,
            evidence_refs: [state.challenger_payload_ref, challengerRef],
            missing_evidence_need: item.missing_evidence_need,
            stop_condition: item.stop_condition,
            reopen_condition: item.reopen_condition,
          });
        }
      }
      context.transition(SCA_P05_FINAL_STATE);
      return this.finalize(context, constructor, challenger);
    }
    throw new Error(`unexpected SCA P05 summary in '${context.stateId}'`);
  }

  private semanticRejection(
    context: RunContext,
    stage: "constructor" | "challenger",
    cause: unknown
  ): Directive {
    const state = data(context);
    const cohort = validateScaP05AcceptedCohortV1(
      exactJson(this.store, state.accepted_cohort_ref, "P05 semantic-rejection cohort")
    );
    const payloadRef =
      stage === "constructor" ? state.constructor_payload_ref : state.challenger_payload_ref;
    const disclosureRef =
      stage === "constructor" ? state.constructor_disclosure_ref : state.challenger_disclosure_ref;
    if (payloadRef === null || disclosureRef === null) {
      throw new Error("P05 semantic rejection lacks exact stage inputs", { cause });
    }
    const outputRef = latestSelected(
      context,
      (ref) =>
        ref.kind ===
        (stage === "constructor" ? "sca-p05-constructor-output" : "sca-p05-challenger-output")
    );
    if (outputRef === undefined) {
      throw new Error("P05 semantic rejection lacks durable model output", { cause });
    }
    const execution = this.executionEvidence(
      context,
      stage === "constructor" ? SCA_P05_FORMING_STATE : SCA_P05_CHALLENGING_STATE,
      stage === "constructor" ? "ida" : "annie",
      outputRef
    );
    const evidenceRefs = uniqueRefs([
      state.accepted_cohort_ref,
      payloadRef,
      disclosureRef,
      outputRef,
      execution.guard_ref,
      execution.receipt_ref,
    ]);
    for (const selectedItemId of cohort.selected_item_ids) {
      if (
        latestSelected(
          context,
          (ref) =>
            ref.kind === "sca-p05-checkpoint" &&
            ref.operation_id === `sca-p05-${selectedItemId}-checkpoint`
        ) !== undefined
      ) {
        continue;
      }
      this.persistCheckpoint(context, {
        selected_item_id: selectedItemId,
        stage,
        reason_code: "semantic_output_rejected",
        evidence_refs: evidenceRefs,
        missing_evidence_need:
          "A schema-valid result satisfying exact payload, identity, evidence, and cross-stage semantics is required.",
        stop_condition: "Stop without retrying or accepting the rejected semantic output.",
        reopen_condition:
          "Reopen only through a fresh run with a newly admitted model dispatch and corrected semantic result.",
      });
    }
    context.transition(SCA_P05_FINAL_STATE);
    if (stage === "constructor") {
      const result = validateScaP05ConstructorResultV1({
        schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
        schema_version: 1,
        role: SCA_P05_CONSTRUCTOR_ROLE,
        payload_sha256: state.constructor_payload_ref.content_digest,
        assigned_item_ids: [...cohort.selected_item_ids],
        items: cohort.selected_item_ids.map((selectedItemId) => ({
          selected_item_id: selectedItemId,
          disposition: "checkpointed_incomplete" as const,
          hypothesis: null,
          reason_code: "unsupported_surface" as const,
          missing_evidence_need:
            "A constructor result satisfying exact deterministic semantic bindings is required.",
          stop_condition:
            "Stop without retrying or constructing a hypothesis from rejected output.",
          reopen_condition: "Reopen only in a fresh run with corrected semantic output.",
          vulnerability_adjudication: "not_performed" as const,
          safe_claim: false as const,
        })),
        complete: true,
      });
      return this.finalize(context, result, null);
    }
    const constructorRef = latestSelected(
      context,
      (ref) => ref.kind === "sca-p05-constructor-output"
    );
    if (constructorRef === undefined) {
      throw new Error("P05 challenger semantic rejection lacks constructor output", { cause });
    }
    const constructor = validateScaP05ConstructorResultV1(
      this.parsePersistedPhaseOutput(constructorRef)
    );
    return this.finalize(context, constructor, null);
  }

  private parsePersistedPhaseOutput(ref: ArtifactRef): unknown {
    const text = exactBytes(this.store, ref, "P05 model output").toString("utf8").trim();
    const json = text.startsWith("SUMMARY:") ? text.slice("SUMMARY:".length) : text;
    const parsed: unknown = JSON.parse(json);
    return parsed;
  }

  private revisionRef(context: RunContext, selectedId: string, revision: 1 | 2): ArtifactRef {
    const ref = latestSelected(
      context,
      (candidate) =>
        candidate.kind === "sca-p05-hypothesis-revision" &&
        candidate.operation_id === `sca-p05-${selectedId}-revision-${revision}`
    );
    if (ref === undefined) throw new Error("P05 hypothesis revision ref is absent");
    return ref;
  }

  private persistRevision(
    context: RunContext,
    body: ScaP05HypothesisBodyV1,
    revision: 1 | 2,
    parent: ArtifactRef | null,
    payloadRef: ArtifactRef,
    outputRef: ArtifactRef,
    changeReasonCodes: readonly string[],
    changedFields: readonly string[]
  ): ArtifactRef {
    const cohort = validateScaP05AcceptedCohortV1(
      exactJson(this.store, data(context).accepted_cohort_ref, "P05 cohort")
    );
    if (revision === 2) {
      if (parent === null) throw new Error("P05 revision 2 requires an exact parent");
      const parentRevision = validateScaP05HypothesisRevisionV1(
        exactJson(this.store, parent, "P05 parent hypothesis revision")
      );
      if (
        parentRevision.revision !== 1 ||
        parentRevision.hypothesis_id !== body.hypothesis_id ||
        parentRevision.selected_item_id !== body.selected_item_id ||
        !same(parentRevision.source_snapshot_ref, cohort.source_snapshot_ref) ||
        parentRevision.source_snapshot_sha256 !== cohort.source_snapshot_sha256 ||
        !same(parentRevision.p04_transition_ref, cohort.p04_transition_ref) ||
        !same(changedHypothesisFields(parentRevision.body, body), [...changedFields].sort())
      ) {
        throw new Error("P05 revision parent lineage or exact change set mismatch");
      }
    }
    const now = this.trustedClock();
    if (!Number.isFinite(now.getTime())) throw new Error("P05 trusted clock is invalid");
    const revisionValue = validateScaP05HypothesisRevisionV1(
      withSelfDigest(
        {
          schema_id: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
          schema_version: 1 as const,
          hypothesis_id: body.hypothesis_id,
          revision,
          parent_revision_ref: parent,
          parent_revision_sha256: parent?.content_digest ?? null,
          body,
          body_sha256: sha256(canonicalJson(body)),
          source_snapshot_ref: cohort.source_snapshot_ref,
          source_snapshot_sha256: cohort.source_snapshot_sha256,
          p04_transition_ref: cohort.p04_transition_ref,
          selected_item_id: body.selected_item_id,
          cognitive_payload_ref: payloadRef,
          model_output_ref: outputRef,
          evidence_atom_ids: [...new Set(evidenceAtomIds(body))].sort(),
          change_reason_codes: [...new Set(changeReasonCodes)].sort(),
          changed_fields: [...new Set(changedFields)].sort(),
          created_at: now.toISOString(),
        },
        "revision_sha256"
      )
    );
    return persistJson({
      store: this.store,
      run_id: context.identity.run_id,
      kind: "sca-p05-hypothesis-revision",
      operation_id: `sca-p05-${body.selected_item_id}-revision-${revision}`,
      schema_id: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
      value: revisionValue,
      upstream_refs: [
        data(context).accepted_cohort_ref,
        payloadRef,
        outputRef,
        ...(parent ? [parent] : []),
      ],
      parent_ref: parent,
      context,
    });
  }

  private persistCheckpoint(
    context: RunContext,
    input: {
      readonly selected_item_id: string;
      readonly stage: "host_context" | "constructor" | "challenger";
      readonly reason_code: string;
      readonly evidence_refs: readonly ArtifactRef[];
      readonly missing_evidence_need: string;
      readonly stop_condition: string;
      readonly reopen_condition: string;
    }
  ): ArtifactRef {
    const checkpoint = validateScaP05CheckpointV1(
      withSelfDigest(
        {
          schema_id: SCA_P05_CHECKPOINT_V1_SCHEMA,
          schema_version: 1 as const,
          phase_id: PHASE,
          selected_item_id: input.selected_item_id,
          stage: input.stage,
          reason_code: input.reason_code,
          evidence_refs: uniqueRefs(input.evidence_refs),
          missing_evidence_need: input.missing_evidence_need,
          stop_condition: input.stop_condition,
          reopen_condition: input.reopen_condition,
          vulnerability_adjudication: "not_performed" as const,
          safe_claim: false as const,
        },
        "checkpoint_sha256"
      )
    );
    return persistJson({
      store: this.store,
      run_id: context.identity.run_id,
      kind: "sca-p05-checkpoint",
      operation_id: `sca-p05-${input.selected_item_id}-checkpoint`,
      schema_id: SCA_P05_CHECKPOINT_V1_SCHEMA,
      value: checkpoint,
      upstream_refs: input.evidence_refs,
      context,
    });
  }

  private finalize(
    context: RunContext,
    constructor: ScaP05ConstructorResultV1,
    challenger: ScaP05ChallengerResultV1 | null
  ): Directive {
    const state = data(context);
    const cohort = validateScaP05AcceptedCohortV1(
      exactJson(this.store, state.accepted_cohort_ref, "P05 cohort")
    );
    const constructorOutputRef = latestSelected(
      context,
      (ref) => ref.kind === "sca-p05-constructor-output"
    );
    const constructorExecution =
      constructorOutputRef === undefined
        ? null
        : this.executionEvidence(context, SCA_P05_FORMING_STATE, "ida", constructorOutputRef);
    const constructorGuardRef = constructorExecution?.guard_ref;
    const constructorReceiptRef = constructorExecution?.receipt_ref;
    const challengerOutputRef = latestSelected(
      context,
      (ref) => ref.kind === "sca-p05-challenger-output"
    );
    const challengerExecution =
      challengerOutputRef === undefined
        ? null
        : this.executionEvidence(context, SCA_P05_CHALLENGING_STATE, "annie", challengerOutputRef);
    const challengerGuardRef = challengerExecution?.guard_ref;
    const challengerReceiptRef = challengerExecution?.receipt_ref;
    const challengerById = new Map(
      challenger?.items.map((entry) => [entry.selected_item_id, entry])
    );
    const rows: ScaP05TraceabilityRowV1[] = [];
    const activeIds: string[] = [];
    const refutedIds: string[] = [];
    const checkpointedIds: string[] = [];
    for (const item of constructor.items) {
      const checkpointRef = latestSelected(
        context,
        (ref) =>
          ref.kind === "sca-p05-checkpoint" &&
          ref.operation_id === `sca-p05-${item.selected_item_id}-checkpoint`
      );
      if (item.disposition === "checkpointed_incomplete") {
        if (!checkpointRef) throw new Error("P05 constructor checkpoint artifact absent");
        checkpointedIds.push(item.selected_item_id);
        rows.push({
          selected_item_id: item.selected_item_id,
          disposition: "checkpointed_incomplete",
          hypothesis_id: null,
          constructor_output_ref: constructorOutputRef ?? null,
          constructor_guard_ref: constructorGuardRef ?? null,
          constructor_receipt_ref: constructorReceiptRef ?? null,
          initial_revision_ref: null,
          challenger_output_ref: null,
          challenger_guard_ref: null,
          challenger_receipt_ref: null,
          final_revision_ref: null,
          checkpoint_ref: checkpointRef,
          safe_claim: false,
        });
        continue;
      }
      if (!constructorOutputRef || !constructorGuardRef || !constructorReceiptRef) {
        throw new Error("P05 formed hypothesis lacks constructor dispatch evidence");
      }
      const initial = this.revisionRef(context, item.selected_item_id, 1);
      const challenge = challengerById.get(item.selected_item_id);
      if (checkpointRef && challenger === null) {
        checkpointedIds.push(item.selected_item_id);
        rows.push({
          selected_item_id: item.selected_item_id,
          disposition: "checkpointed_incomplete",
          hypothesis_id: item.hypothesis.hypothesis_id,
          constructor_output_ref: constructorOutputRef,
          constructor_guard_ref: constructorGuardRef,
          constructor_receipt_ref: constructorReceiptRef,
          initial_revision_ref: initial,
          challenger_output_ref: null,
          challenger_guard_ref: null,
          challenger_receipt_ref: null,
          final_revision_ref: null,
          checkpoint_ref: checkpointRef,
          safe_claim: false,
        });
        continue;
      }
      if (!challenge || !challengerOutputRef || !challengerGuardRef || !challengerReceiptRef) {
        throw new Error("P05 formed hypothesis lacks challenger evidence");
      }
      if (challenge.decision === "unable_to_validate" && !checkpointRef) {
        throw new Error("P05 challenger checkpoint artifact absent");
      }
      if (checkpointRef) {
        checkpointedIds.push(item.selected_item_id);
        rows.push({
          selected_item_id: item.selected_item_id,
          disposition: "checkpointed_incomplete",
          hypothesis_id: item.hypothesis.hypothesis_id,
          constructor_output_ref: constructorOutputRef,
          constructor_guard_ref: constructorGuardRef,
          constructor_receipt_ref: constructorReceiptRef,
          initial_revision_ref: initial,
          challenger_output_ref: challengerOutputRef,
          challenger_guard_ref: challengerGuardRef,
          challenger_receipt_ref: challengerReceiptRef,
          final_revision_ref: null,
          checkpoint_ref: checkpointRef,
          safe_claim: false,
        });
        continue;
      }
      const finalRevision =
        challenge.decision === "revise_for_investigation"
          ? this.revisionRef(context, item.selected_item_id, 2)
          : initial;
      const disposition =
        challenge.decision === "refute_with_existing_control"
          ? ("refuted_by_existing_control" as const)
          : ("active_hypothesis" as const);
      (disposition === "active_hypothesis" ? activeIds : refutedIds).push(
        scaP05HypothesisId(cohort.source_snapshot_sha256, item.selected_item_id)
      );
      rows.push({
        selected_item_id: item.selected_item_id,
        disposition,
        hypothesis_id: item.hypothesis.hypothesis_id,
        constructor_output_ref: constructorOutputRef,
        constructor_guard_ref: constructorGuardRef,
        constructor_receipt_ref: constructorReceiptRef,
        initial_revision_ref: initial,
        challenger_output_ref: challengerOutputRef,
        challenger_guard_ref: challengerGuardRef,
        challenger_receipt_ref: challengerReceiptRef,
        final_revision_ref: finalRevision,
        checkpoint_ref: null,
        safe_claim: false,
      });
    }
    rows.sort((a, b) => a.selected_item_id.localeCompare(b.selected_item_id));
    const traceability = validateScaP05TraceabilityV1(
      withSelfDigest(
        {
          schema_id: SCA_P05_TRACEABILITY_V1_SCHEMA,
          schema_version: 1 as const,
          phase_id: PHASE,
          selected_item_ids: [...cohort.selected_item_ids],
          rows,
          active_hypothesis_ids: activeIds.sort(),
          refuted_hypothesis_ids: refutedIds.sort(),
          checkpointed_item_ids: checkpointedIds.sort(),
          exhaustive: true as const,
        },
        "traceability_sha256"
      )
    );
    const traceabilityRef = persistJson({
      store: this.store,
      run_id: context.identity.run_id,
      kind: "sca-p05-traceability",
      operation_id: "sca-p05-traceability",
      schema_id: SCA_P05_TRACEABILITY_V1_SCHEMA,
      value: traceability,
      upstream_refs: rows.flatMap((row) =>
        [
          row.constructor_output_ref,
          row.constructor_guard_ref,
          row.constructor_receipt_ref,
          row.initial_revision_ref,
          row.challenger_output_ref,
          row.challenger_guard_ref,
          row.challenger_receipt_ref,
          row.final_revision_ref,
          row.checkpoint_ref,
        ].filter((ref): ref is ArtifactRef => ref !== null)
      ),
      context,
    });
    const request = validateScaP05RequestV1(
      exactJson(this.store, state.request_ref, "P05 finalization request")
    );
    const disclosureScope = validateScaP05DisclosureScopeV1(
      exactJson(this.store, request.disclosure_scope_ref, "P05 finalization disclosure scope")
    );
    const evidenceRefs = uniqueRefs([
      state.request_ref,
      state.accepted_cohort_ref,
      request.p04_transition_ref,
      request.implementation_identity_ref,
      request.runtime_policy_ref,
      request.disclosure_scope_ref,
      cohort.p04_gate_ref,
      cohort.p04_successor_ledger_ref,
      cohort.p04_selection_dossier_ref,
      cohort.source_snapshot_ref,
      disclosureScope.authority_ref,
      ...disclosureScope.source_segments.map((entry) => entry.origin_ref),
      ...disclosureScope.evidence_permissions.map((entry) => entry.origin_ref),
      state.constructor_payload_ref,
      state.constructor_disclosure_ref,
      ...(state.challenger_payload_ref ? [state.challenger_payload_ref] : []),
      ...(state.challenger_disclosure_ref ? [state.challenger_disclosure_ref] : []),
      traceabilityRef,
      ...rows.flatMap((row) =>
        [
          row.constructor_output_ref,
          row.constructor_guard_ref,
          row.constructor_receipt_ref,
          row.initial_revision_ref,
          row.challenger_output_ref,
          row.challenger_guard_ref,
          row.challenger_receipt_ref,
          row.final_revision_ref,
          row.checkpoint_ref,
        ].filter((ref): ref is ArtifactRef => ref !== null)
      ),
    ]);
    const manifest = validateScaP05EvidenceManifestV1(
      withSelfDigest(
        {
          schema_id: SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA,
          schema_version: 1 as const,
          phase_id: PHASE,
          source_snapshot_ref: cohort.source_snapshot_ref,
          source_snapshot_sha256: cohort.source_snapshot_sha256,
          evidence_refs: evidenceRefs,
          artifact_ids: evidenceRefs.map((ref) => ref.artifact_id).sort(),
        },
        "manifest_sha256"
      )
    );
    const manifestRef = persistJson({
      store: this.store,
      run_id: context.identity.run_id,
      kind: "sca-p05-evidence-manifest",
      operation_id: "sca-p05-evidence-manifest",
      schema_id: SCA_P05_EVIDENCE_MANIFEST_V1_SCHEMA,
      value: manifest,
      upstream_refs: evidenceRefs,
      context,
    });
    const noCheckpoints = checkpointedIds.length === 0;
    const obligations = SCA_P05_OBLIGATION_IDS.map((obligationId) => ({
      obligation_id: obligationId,
      class: "required-result" as const,
      status:
        obligationId !== "SCA-OBL-OUTPUT-P05-HYPOTHESIS-TRACEABILITY" && !noCheckpoints
          ? ("pending" as const)
          : ("satisfied" as const),
      evidence_refs: [traceabilityRef, manifestRef],
      blocker_codes:
        obligationId !== "SCA-OBL-OUTPUT-P05-HYPOTHESIS-TRACEABILITY" && !noCheckpoints
          ? ["checkpointed_incomplete"]
          : [],
    }));
    const ledger = validateScaP05SuccessorLedgerV1(
      withSelfDigest(
        {
          schema_id: SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
          schema_version: 1 as const,
          phase_id: PHASE,
          run_id: context.identity.run_id,
          predecessor_ledger_ref: cohort.p04_successor_ledger_ref,
          predecessor_ledger_sha256: cohort.p04_successor_ledger_ref.content_digest,
          obligations,
          all_required_satisfied: noCheckpoints,
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
    const ledgerRef = persistJson({
      store: this.store,
      run_id: context.identity.run_id,
      kind: "sca-p05-successor-ledger",
      operation_id: "sca-p05-successor-ledger",
      schema_id: SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
      value: ledger,
      upstream_refs: [cohort.p04_successor_ledger_ref, traceabilityRef, manifestRef],
      context,
    });
    const blockers = noCheckpoints ? [] : ["checkpointed_incomplete"];
    const now = this.trustedClock();
    const gate = validateScaP05GateV1(
      withSelfDigest(
        {
          schema_id: SCA_P05_GATE_V1_SCHEMA,
          schema_version: 1 as const,
          phase_id: PHASE,
          criterion_id: "AC-P05" as const,
          verdict: noCheckpoints ? ("pass" as const) : ("blocked" as const),
          p04_gate_ref: cohort.p04_gate_ref,
          traceability_ref: traceabilityRef,
          evidence_manifest_ref: manifestRef,
          successor_ledger_ref: ledgerRef,
          exhaustive_accounting: true,
          immutable_revisions_valid: true,
          disclosure_and_model_evidence_valid: true,
          checkpoint_count: checkpointedIds.length,
          blocker_codes: blockers,
          evaluated_at: now.toISOString(),
        },
        "gate_sha256"
      )
    );
    const gateRef = persistJson({
      store: this.store,
      run_id: context.identity.run_id,
      kind: "sca-p05-gate",
      operation_id: "sca-p05-gate",
      schema_id: SCA_P05_GATE_V1_SCHEMA,
      value: gate,
      upstream_refs: [traceabilityRef, manifestRef, ledgerRef, cohort.p04_gate_ref],
      context,
    });
    let transitionRef: ArtifactRef | null = null;
    if (noCheckpoints) {
      const transition = validateScaP05ToP06TransitionV1(
        withSelfDigest(
          {
            schema_id: SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
            schema_version: 1 as const,
            source_phase_id: PHASE,
            target_phase_id: "SCA-P06" as const,
            authorized: true as const,
            qualification_scope: "live_qualified" as const,
            p05_request_ref: state.request_ref,
            accepted_cohort_ref: state.accepted_cohort_ref,
            traceability_ref: traceabilityRef,
            evidence_manifest_ref: manifestRef,
            successor_ledger_ref: ledgerRef,
            p05_gate_ref: gateRef,
            active_hypothesis_ids: activeIds.sort(),
            refuted_hypothesis_ids: refutedIds.sort(),
            release_eligible: false as const,
            campaign_complete: false as const,
          },
          "transition_sha256"
        )
      );
      transitionRef = persistJson({
        store: this.store,
        run_id: context.identity.run_id,
        kind: "sca-p05-to-p06-transition",
        operation_id: "sca-p05-to-p06-transition",
        schema_id: SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
        value: transition,
        upstream_refs: [
          state.request_ref,
          state.accepted_cohort_ref,
          traceabilityRef,
          manifestRef,
          ledgerRef,
          gateRef,
        ],
        context,
      });
    }
    return this.terminal(
      context,
      noCheckpoints ? "candidate_complete" : "blocked",
      noCheckpoints,
      blockers,
      gateRef,
      transitionRef
    );
  }

  private executionEvidence(
    context: RunContext,
    stateId: typeof SCA_P05_FORMING_STATE | typeof SCA_P05_CHALLENGING_STATE,
    agent: "ida" | "annie",
    outputRef: ArtifactRef
  ): { readonly guard_ref: ArtifactRef; readonly receipt_ref: ArtifactRef } {
    const coordinate = {
      run_id: context.identity.run_id,
      state_id: stateId,
      branch_id: null,
      agent,
      attempt: 1,
    };
    const guardRef = this.store.refFor(
      context.identity.run_id,
      stateId,
      null,
      "model-dispatch-guard",
      modelDispatchGuardOperationId(coordinate),
      1
    );
    const receiptRef = this.store.refFor(
      context.identity.run_id,
      stateId,
      null,
      "model-execution-receipt",
      modelExecutionReceiptOperationId(coordinate),
      1
    );
    if (guardRef === null || receiptRef === null) {
      throw new Error(`P05 '${stateId}' durable model identity evidence is absent`);
    }
    const state = data(context);
    const payloadRef =
      stateId === SCA_P05_FORMING_STATE
        ? state.constructor_payload_ref
        : state.challenger_payload_ref;
    const disclosureRef =
      stateId === SCA_P05_FORMING_STATE
        ? state.constructor_disclosure_ref
        : state.challenger_disclosure_ref;
    if (payloadRef === null || disclosureRef === null) {
      throw new Error(`P05 '${stateId}' execution input refs are absent`);
    }
    const expectedInputArtifacts = {
      schema_version: 2 as const,
      artifacts: [
        { slot: "cognitive_payload", ref: payloadRef },
        { slot: "disclosure_admission", ref: disclosureRef },
      ],
    };
    const guard = validateModelDispatchGuardV1(
      exactJson(this.store, guardRef, "P05 model dispatch guard")
    );
    if (
      !same(guard.coordinate, coordinate) ||
      guard.input_artifacts_sha256 !== sha256(canonicalJson(expectedInputArtifacts)) ||
      guard.provider_opening_guard !== SCA_P05_PROVIDER_OPENING_GUARD ||
      !same(guard.requested_model, SCA_P05_REQUIRED_MODEL) ||
      guard.serialized_opening_byte_length <= 0
    ) {
      throw new Error("P05 model dispatch guard exact invocation binding mismatch");
    }
    const wrapper = validateModelExecutionReceiptV1(
      exactJson(this.store, receiptRef, "P05 model execution receipt")
    );
    const receipt = wrapper.execution_receipt;
    if (
      !same(wrapper.dispatch_guard_ref, guardRef) ||
      receipt.run_id !== coordinate.run_id ||
      receipt.state_id !== coordinate.state_id ||
      receipt.branch_id !== null ||
      receipt.agent !== coordinate.agent ||
      receipt.attempt !== coordinate.attempt ||
      !same(receipt.requested_model, SCA_P05_REQUIRED_MODEL) ||
      receipt.observed_model === undefined ||
      !same(receipt.output_artifact_ref, outputRef) ||
      receipt.output_digest !== outputRef.content_digest
    ) {
      throw new Error("P05 model execution receipt exact invocation/output binding mismatch");
    }
    assertResolvedModelIdentity(
      SCA_P05_REQUIRED_MODEL,
      receipt.observed_model,
      "P05 observed model"
    );
    return { guard_ref: guardRef, receipt_ref: receiptRef };
  }

  private terminal(
    context: RunContext,
    status: "candidate_complete" | "blocked" | "cancelled",
    p06Authorized: boolean,
    blockerCodes: readonly string[],
    gateRef: ArtifactRef | null = null,
    transitionRef: ArtifactRef | null = null
  ): Directive {
    context.stateId = status === "cancelled" ? "sca_p05_cancelled" : SCA_P05_FINAL_STATE;
    context.status = status === "cancelled" ? "cancelled" : "incomplete";
    context.met = false;
    const terminal = validateScaP05TerminalV1({
      schema_id: SCA_P05_TERMINAL_V1_SCHEMA,
      schema_version: 1,
      phase_id: PHASE,
      status,
      gate_ref: gateRef,
      p06_transition_ref: transitionRef,
      p06_authorized: p06Authorized,
      selected_artifact_refs: this.terminalArtifacts(context),
      blocker_codes: [...new Set(blockerCodes)].sort(),
      release_eligible: false,
      campaign_complete: false,
      nonterminal_campaign: true,
    });
    const directive = validateDirective({
      schema_version: 2,
      action: status === "cancelled" ? "cancelled" : "incomplete",
      identity: context.identity,
      status: status === "cancelled" ? "cancelled" : "incomplete",
      met: false,
      result: terminal,
      artifacts: this.terminalArtifacts(context),
      unresolved:
        status === "candidate_complete"
          ? ["SCA-P06 remains a separately admitted nonterminal phase."]
          : terminal.blocker_codes,
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private terminalArtifacts(context: RunContext): ArtifactRef[] {
    const terminalKinds = new Set([
      "sca-p05-request",
      "sca-p05-accepted-cohort",
      "sca-p05-evidence-manifest",
      "sca-p05-traceability",
      "sca-p05-successor-ledger",
      "sca-p05-gate",
      "sca-p05-to-p06-transition",
    ]);
    const core = context.selectedArtifacts.filter(
      (ref) => ref.run_id === context.identity.run_id && terminalKinds.has(ref.kind)
    );
    const latestCheckpoint = [...context.selectedArtifacts]
      .reverse()
      .find((ref) => ref.run_id === context.identity.run_id && ref.kind === "sca-p05-checkpoint");
    return uniqueRefs(latestCheckpoint === undefined ? core : [...core, latestCheckpoint]).slice(
      0,
      128
    );
  }
}

function port(input: {
  readonly name: string;
  readonly kind: string;
  readonly schema: string;
  readonly direction: "input" | "output";
  readonly min?: number;
  readonly max?: number;
}) {
  return {
    schema_version: 1 as const,
    name: input.name,
    direction: input.direction,
    transport: "artifact" as const,
    schema_id: input.schema,
    schema_version_required: 1 as const,
    artifact_kind: input.kind,
    source: input.direction === "input" ? ("caller" as const) : ("skill" as const),
    min_items: input.min ?? 1,
    max_items: input.max ?? 1,
    semantic_product: input.direction === "output",
  };
}

export const SCA_P05_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Create exhaustive evidence-bound falsifiable hypothesis revisions from an exact live-qualified P04 selection cohort without adjudicating vulnerabilities.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: SCA_P05_START_V1_SCHEMA,
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [
      port({
        name: "p04_transition",
        kind: "sca-p04-to-p05-transition",
        schema: "penny.sca-p04-to-p05-transition.v1",
        direction: "input",
      }),
      port({
        name: "implementation_identity",
        kind: "sca-p05-implementation-identity",
        schema: "penny.sca-p05-implementation-identity.v1",
        direction: "input",
      }),
      port({
        name: "runtime_policy",
        kind: "sca-p05-runtime-policy",
        schema: "penny.sca-p05-runtime-policy.v1",
        direction: "input",
      }),
      port({
        name: "disclosure_scope",
        kind: "sca-p05-disclosure-scope",
        schema: "penny.sca-p05-disclosure-scope.v1",
        direction: "input",
      }),
    ],
    active_output_ports: [
      port({
        name: "traceability",
        kind: "sca-p05-traceability",
        schema: SCA_P05_TRACEABILITY_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "gate",
        kind: "sca-p05-gate",
        schema: SCA_P05_GATE_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p06_transition",
        kind: "sca-p05-to-p06-transition",
        schema: SCA_P05_TO_P06_TRANSITION_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
    ],
  },
  behavior: {
    side_effects: {
      external_reads: "host_policy_only",
      external_mutations: "forbidden",
      filesystem_writes: "host_policy_only",
      allowed_relative_paths: [],
    },
    approval: { policy: "caller_skill_request", additional_approval_required: false },
    stopping: {
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "incomplete",
    },
    escalation: { out_of_scope_effect: "non_positive", sandbox_prevention_claim: false },
    violation_terminal: "incomplete",
  },
  guidance: {
    skill_root: ".pi/skills/sca/assets/prompts",
    resolution: "per_agent_phase",
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.sca-p05-candidate-budget.v1",
    resolver_id: "scaP05CandidateLeaseResolver",
    admission_id: "scaP05CandidateAdmission",
    snapshot_id: "scaP05CandidateSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [SCA_P05_FINAL_STATE],
    required_visited_states: [SCA_P05_FINAL_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: SCA_P05_TERMINAL_V1_SCHEMA,
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

export const SCA_P05_CANDIDATE_REGISTRATION: PlaybookRegistration = {
  name: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
  contract: SCA_P05_CANDIDATE_SKILL_CONTRACT,
  ingress: "skill",
  start_admission: START_ADMISSION,
  caller_documentation: {
    constraints_schema: ScaP05StartConstraintsV1Schema,
    example: { goal: "Run inactive P05 hypothesis candidate.", constraints: { p05_request: {} } },
    semantic_caveat:
      "P05 creates and challenges falsifiable hypotheses. It does not adjudicate vulnerabilities, execute evidence actions, report, release, or complete a campaign.",
  },
  liveness: {
    resolver_id: SCA_P05_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
    resolve: () => undefined,
    thinking_policy: "agent_ssot",
  },
  worker: {
    kind: "catalog-agent",
    workflow_name: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
    guidance: SCA_P05_CANDIDATE_SKILL_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: new Map([
      [
        SCA_P05_FORMING_STATE,
        {
          agent: "ida",
          result_schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
          result_schema_version: 1 as const,
          schema: ScaP05ConstructorResultV1Schema,
          allowed_tools: [],
          required_model: SCA_P05_REQUIRED_MODEL,
          provider_opening_guard: SCA_P05_PROVIDER_OPENING_GUARD,
        },
      ],
      [
        SCA_P05_CHALLENGING_STATE,
        {
          agent: "annie",
          result_schema_id: SCA_P05_CHALLENGER_RESULT_V1_SCHEMA,
          result_schema_version: 1 as const,
          schema: ScaP05ChallengerResultV1Schema,
          allowed_tools: [],
          required_model: SCA_P05_REQUIRED_MODEL,
          provider_opening_guard: SCA_P05_PROVIDER_OPENING_GUARD,
        },
      ],
    ]),
  },
  host_states: [SCA_P05_FINAL_STATE],
  completionReceiptPredicates: new Map(),
  construct: (options) => {
    if (options.artifactStore === undefined) throw new Error("P05 candidate needs artifact store");
    return new ScaP05CandidatePlaybook(
      options.artifactStore,
      options.trustedClock ?? (() => new Date())
    );
  },
};
