import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  type ArtifactRef,
  type InputArtifacts,
} from "../contracts.js";
import type {
  ProviderOpeningAuthorizationV1,
  ProviderOpeningGuardAdapter,
  ProviderOpeningGuardAssignmentV1,
} from "../provider-opening-guard.js";
import {
  SCA_P11_CANDIDATE_PLAYBOOK_NAME,
  SCA_P11_PROVIDER_OPENING_GUARD,
  SCA_P11_REPAIRING_STATE,
  SCA_P11_REPAIR_CALL_ID,
  SCA_P11_REQUIRED_MODEL,
  SCA_P11_REVIEWER_AGENT,
  SCA_P11_REVIEWING_STATE,
  SCA_P11_REVIEW_CALL_ID,
  ScaP11CognitivePayloadV1Schema,
  ScaP11DisclosureAdmissionV1Schema,
  validateScaP11CognitivePayloadV1,
  validateScaP11DisclosureAdmissionV1,
  validateScaP11DisclosureScopeV1,
  type ScaP11CognitivePayloadV1,
  type ScaP11DisclosureAdmissionV1,
} from "./p11-contracts.js";

export const SCA_P11_INLINE_OPENING_PREFIX = "P11 INLINE COGNITIVE INPUT (host-verified):\n";
export const SCA_P11_SERIALIZED_OPENING_MAX_BYTES = 786_432 as const;
export const SCA_P11_SERIALIZED_OPENING_RESERVE_BYTES = 65_536 as const;
const INLINE_SCHEMA = "penny.sca-p11-inline-opening-envelope.v1" as const;

const InlineEnvelopeSchema = Type.Object(
  {
    schema_id: Type.Literal(INLINE_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 512 }),
    state_id: Type.Union([
      Type.Literal(SCA_P11_REVIEWING_STATE),
      Type.Literal(SCA_P11_REPAIRING_STATE),
    ]),
    branch_id: Type.Null(),
    agent: Type.Literal(SCA_P11_REVIEWER_AGENT),
    task_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    input_artifacts_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    payload_ref: ArtifactRefSchema,
    disclosure_ref: ArtifactRefSchema,
    payload: ScaP11CognitivePayloadV1Schema,
    disclosure: ScaP11DisclosureAdmissionV1Schema,
  },
  { additionalProperties: false, $id: INLINE_SCHEMA }
);
type InlineEnvelope = Readonly<Static<typeof InlineEnvelopeSchema>>;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function expectedCallId(stateId: string): string {
  return stateId === SCA_P11_REPAIRING_STATE ? SCA_P11_REPAIR_CALL_ID : SCA_P11_REVIEW_CALL_ID;
}
function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) {
    throw new Error(`${label} full artifact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`${label} exact bytes/digest do not match admitted ref`);
  }
  return bytes;
}
function exactJson<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string,
  validate: (value: unknown) => T
): T {
  const parsed: unknown = JSON.parse(exactBytes(store, ref, label).toString("utf8"));
  return validate(parsed);
}
function orderedBindings(input: InputArtifacts): {
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
} {
  if (
    input.artifacts.length !== 2 ||
    input.artifacts[0]?.slot !== "cognitive_payload" ||
    input.artifacts[1]?.slot !== "disclosure_admission"
  ) {
    throw new Error("P11 provider opening requires exact ordered payload/disclosure bindings");
  }
  const payloadRef = input.artifacts[0]?.ref;
  const disclosureRef = input.artifacts[1]?.ref;
  if (payloadRef === undefined || disclosureRef === undefined) {
    throw new Error("P11 provider opening payload/disclosure refs are absent");
  }
  return { payload_ref: payloadRef, disclosure_ref: disclosureRef };
}
function expectedAuthorizedRefs(payload: ScaP11CognitivePayloadV1): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  byId.set(payload.report_ref.artifact_id, payload.report_ref);
  byId.set(payload.reconciliation_ref.artifact_id, payload.reconciliation_ref);
  if (payload.scoring_records_ref !== null) {
    byId.set(payload.scoring_records_ref.artifact_id, payload.scoring_records_ref);
  }
  for (const assertion of payload.assertions) {
    for (const ref of assertion.evidence_allowlist) byId.set(ref.artifact_id, ref);
  }
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function bind(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
}): {
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
  readonly payload: ScaP11CognitivePayloadV1;
  readonly disclosure: ScaP11DisclosureAdmissionV1;
} {
  const { assignment } = input;
  if (assignment.registration_name !== SCA_P11_CANDIDATE_PLAYBOOK_NAME) {
    throw new Error("P11 provider opening registration binding mismatch");
  }
  if (
    (assignment.state_id !== SCA_P11_REVIEWING_STATE &&
      assignment.state_id !== SCA_P11_REPAIRING_STATE) ||
    assignment.agent !== SCA_P11_REVIEWER_AGENT ||
    assignment.branch_id !== null
  ) {
    throw new Error("P11 provider opening state/agent/branch binding mismatch");
  }
  const refs = orderedBindings(assignment.input_artifacts);
  const payload = exactJson(
    input.store,
    refs.payload_ref,
    "P11 cognitive payload",
    validateScaP11CognitivePayloadV1
  );
  const disclosure = exactJson(
    input.store,
    refs.disclosure_ref,
    "P11 disclosure admission",
    validateScaP11DisclosureAdmissionV1
  );
  const callId = expectedCallId(assignment.state_id);
  if (
    payload.run_id !== assignment.run_id ||
    disclosure.run_id !== assignment.run_id ||
    payload.call_id !== callId ||
    disclosure.call_id !== callId ||
    disclosure.purpose !== payload.purpose ||
    !same(payload.disclosure_scope_ref, disclosure.disclosure_scope_ref) ||
    !same(disclosure.payload_ref, refs.payload_ref) ||
    disclosure.payload_sha256 !== refs.payload_ref.content_digest ||
    disclosure.payload_byte_length !== refs.payload_ref.byte_length ||
    !same(payload.required_model, SCA_P11_REQUIRED_MODEL) ||
    !same(disclosure.required_model, SCA_P11_REQUIRED_MODEL)
  ) {
    throw new Error("P11 provider opening payload/disclosure/model binding mismatch");
  }
  if (
    !same(
      expectedAuthorizedRefs(payload).map((ref) => ref.artifact_id),
      disclosure.authorized_refs.map((ref) => ref.artifact_id)
    )
  ) {
    throw new Error("P11 disclosure authorized refs differ from the serialized payload");
  }
  return { ...refs, payload, disclosure };
}

export function buildScaP11InlineOpeningAppendix(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
}): string {
  const bound = bind(input);
  const envelope: InlineEnvelope = validateContract(
    InlineEnvelopeSchema,
    {
      schema_id: INLINE_SCHEMA,
      schema_version: 1,
      run_id: input.assignment.run_id,
      state_id:
        input.assignment.state_id === SCA_P11_REPAIRING_STATE
          ? SCA_P11_REPAIRING_STATE
          : SCA_P11_REVIEWING_STATE,
      branch_id: null,
      agent: SCA_P11_REVIEWER_AGENT,
      task_sha256: sha256(input.assignment.task),
      input_artifacts_sha256: sha256(canonicalJson(input.assignment.input_artifacts)),
      payload_ref: bound.payload_ref,
      disclosure_ref: bound.disclosure_ref,
      payload: bound.payload,
      disclosure: bound.disclosure,
    },
    "P11 inline opening envelope"
  );
  return `${SCA_P11_INLINE_OPENING_PREFIX}${canonicalJson(envelope)}`;
}

function parseEnvelope(opening: string): InlineEnvelope {
  const marker = `\n\n${SCA_P11_INLINE_OPENING_PREFIX}`;
  const start = opening.lastIndexOf(marker);
  if (start < 0 || opening.indexOf(marker) !== start) {
    throw new Error("P11 serialized opening must contain exactly one inline envelope");
  }
  const after = opening.slice(start + marker.length);
  const endMarker = "\n\nReturn the complete stage output";
  const end = after.indexOf(endMarker);
  if (end < 0) throw new Error("P11 serialized opening envelope terminator is absent");
  const json = after.slice(0, end);
  const raw: unknown = JSON.parse(json);
  const parsed = validateContract(InlineEnvelopeSchema, raw, "P11 serialized inline envelope");
  if (canonicalJson(parsed) !== json) throw new Error("P11 inline envelope is not canonical JSON");
  return parsed;
}

export function authorizeScaP11SerializedOpening(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
  readonly opening: string;
}): ProviderOpeningAuthorizationV1 {
  const bound = bind(input);
  const envelope = parseEnvelope(input.opening);
  const appendix = buildScaP11InlineOpeningAppendix({
    store: input.store,
    assignment: input.assignment,
  });
  if (!input.opening.includes(`\n\n${appendix}\n\n`)) {
    throw new Error("P11 inline envelope differs from exact host projection");
  }
  if (
    !same(envelope.payload_ref, bound.payload_ref) ||
    !same(envelope.disclosure_ref, bound.disclosure_ref) ||
    !same(envelope.payload, bound.payload) ||
    !same(envelope.disclosure, bound.disclosure) ||
    envelope.task_sha256 !== sha256(input.assignment.task) ||
    envelope.input_artifacts_sha256 !== sha256(canonicalJson(input.assignment.input_artifacts))
  ) {
    throw new Error("P11 serialized opening bytes or assignment binding were substituted");
  }
  if (bound.disclosure.decision !== "allow" || bound.disclosure.blocker_codes.length !== 0) {
    throw new Error("P11 serialized opening disclosure is not allowed");
  }
  const scope = exactJson(
    input.store,
    bound.disclosure.disclosure_scope_ref,
    "P11 disclosure scope",
    validateScaP11DisclosureScopeV1
  );
  if (
    // The admitted phase disclosure scope must authorize exactly this per-call purpose. A scope
    // admitted for the review call never silently authorizes the repair call (`P11-R16`).
    scope.purpose !== bound.payload.purpose ||
    scope.run_id !== input.assignment.run_id ||
    scope.phase_id !== "SCA-P11" ||
    !same(scope.required_model, SCA_P11_REQUIRED_MODEL) ||
    scope.decision !== "allow" ||
    scope.blocker_codes.length !== 0 ||
    scope.scope_sha256 !== bound.disclosure.disclosure_scope_sha256 ||
    bound.disclosure.retention_days !== scope.provider_retention_days ||
    bound.disclosure.logging_status !== scope.provider_logging_status ||
    bound.disclosure.logging_days !== scope.provider_logging_days ||
    bound.disclosure.destination !== scope.destination_class ||
    bound.disclosure.training !== scope.provider_training_use ||
    bound.disclosure.serialized_opening_byte_limit > scope.max_payload_bytes_per_call
  ) {
    throw new Error("P11 disclosure scope/payload policy mismatch");
  }
  for (const ref of bound.disclosure.authorized_refs) {
    exactBytes(input.store, ref, "P11 authorized payload identity");
  }
  const max = Math.min(
    bound.disclosure.serialized_opening_byte_limit,
    scope.max_payload_bytes_per_call,
    SCA_P11_SERIALIZED_OPENING_MAX_BYTES
  );
  const payloadCapacity = Math.max(0, max - SCA_P11_SERIALIZED_OPENING_RESERVE_BYTES);
  if (bound.payload_ref.byte_length > payloadCapacity) {
    throw new Error("P11 payload exceeds admitted post-framing capacity");
  }
  const openingBytes = Buffer.byteLength(input.opening, "utf8");
  if (openingBytes > max) throw new Error("P11 complete serialized opening exceeds admitted limit");
  return {
    serialized_opening_sha256: sha256(input.opening),
    serialized_opening_byte_length: openingBytes,
    payload_ref: bound.payload_ref,
    disclosure_ref: bound.disclosure_ref,
  };
}

export const SCA_P11_PROVIDER_OPENING_ADAPTER = Object.freeze({
  id: SCA_P11_PROVIDER_OPENING_GUARD,
  resultRoutingPolicy: "exact_summary_or_phase_json",
  matches: (registrationName, stateId, agent) =>
    registrationName === SCA_P11_CANDIDATE_PLAYBOOK_NAME &&
    (stateId === SCA_P11_REVIEWING_STATE || stateId === SCA_P11_REPAIRING_STATE) &&
    agent === SCA_P11_REVIEWER_AGENT,
  buildAppendix: ({ store, assignment }) => buildScaP11InlineOpeningAppendix({ store, assignment }),
  authorizeSerializedOpening: ({ store, assignment, opening }) =>
    authorizeScaP11SerializedOpening({ store, assignment, opening }),
} satisfies ProviderOpeningGuardAdapter);
