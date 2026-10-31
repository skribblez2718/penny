import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  type InputArtifacts,
  validateContract,
} from "../contracts.js";
import type {
  ProviderOpeningAuthorizationV1,
  ProviderOpeningGuardAdapter,
  ProviderOpeningGuardAssignmentV1,
} from "../provider-opening-guard.js";
import {
  SCA_P08_ASSESSING_STATE,
  SCA_P08_ASSESSOR_AGENT,
  SCA_P08_ASSESSOR_ROLE,
  SCA_P08_PROVIDER_OPENING_GUARD,
  SCA_P08_REQUIRED_MODEL,
  SCA_P08_REVIEWING_STATE,
  SCA_P08_REVIEWER_AGENT,
  SCA_P08_REVIEWER_ROLE,
  ScaP08CognitivePayloadV1Schema,
  ScaP08DisclosureAdmissionV1Schema,
  isScaP08ScopeDecisionKind,
  validateScaP08CognitivePayloadV1,
  validateScaP08DisclosureAdmissionV1,
  validateScaP08DisclosureScopeV1,
  type ScaP08CognitivePayloadV1,
  type ScaP08DisclosureAdmissionV1,
} from "./p08-contracts.js";

export const SCA_P08_INLINE_OPENING_PREFIX = "P08 INLINE COGNITIVE INPUT (host-verified):\n";
export const SCA_P08_SERIALIZED_OPENING_MAX_BYTES = 786_432 as const;
export const SCA_P08_SERIALIZED_OPENING_RESERVE_BYTES = 65_536 as const;
const INLINE_SCHEMA = "penny.sca-p08-inline-opening-envelope.v1" as const;

const RoleSchema = Type.Union([
  Type.Literal(SCA_P08_ASSESSOR_ROLE),
  Type.Literal(SCA_P08_REVIEWER_ROLE),
]);
const AgentSchema = Type.Union([
  Type.Literal(SCA_P08_ASSESSOR_AGENT),
  Type.Literal(SCA_P08_REVIEWER_AGENT),
]);

const InlineEnvelopeSchema = Type.Object(
  {
    schema_id: Type.Literal(INLINE_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 512 }),
    state_id: Type.Union([
      Type.Literal(SCA_P08_ASSESSING_STATE),
      Type.Literal(SCA_P08_REVIEWING_STATE),
    ]),
    branch_id: Type.Null(),
    role: RoleSchema,
    agent: AgentSchema,
    task_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    input_artifacts_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    payload_ref: ArtifactRefSchema,
    disclosure_ref: ArtifactRefSchema,
    payload: ScaP08CognitivePayloadV1Schema,
    disclosure: ScaP08DisclosureAdmissionV1Schema,
  },
  { additionalProperties: false, $id: INLINE_SCHEMA }
);
type InlineEnvelope = Readonly<Static<typeof InlineEnvelopeSchema>>;

interface RoleBinding {
  readonly state_id: string;
  readonly role: string;
  readonly agent: string;
}

function roleBinding(stateId: string, agent: string): RoleBinding {
  if (stateId === SCA_P08_ASSESSING_STATE && agent === SCA_P08_ASSESSOR_AGENT) {
    return { state_id: stateId, role: SCA_P08_ASSESSOR_ROLE, agent };
  }
  if (stateId === SCA_P08_REVIEWING_STATE && agent === SCA_P08_REVIEWER_AGENT) {
    return { state_id: stateId, role: SCA_P08_REVIEWER_ROLE, agent };
  }
  throw new Error("P08 provider opening state/agent binding mismatch");
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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
    throw new Error("P08 provider opening requires exact ordered payload/disclosure bindings");
  }
  const payloadRef = input.artifacts[0]?.ref;
  const disclosureRef = input.artifacts[1]?.ref;
  if (payloadRef === undefined || disclosureRef === undefined) {
    throw new Error("P08 provider opening payload/disclosure refs are absent");
  }
  return { payload_ref: payloadRef, disclosure_ref: disclosureRef };
}
function expectedAuthorizedRefs(payload: ScaP08CognitivePayloadV1): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of payload.scope_decision_refs) byId.set(ref.artifact_id, ref);
  for (const item of payload.items) {
    byId.set(item.primary_ref.artifact_id, item.primary_ref);
    for (const ref of item.p07_evidence_refs) byId.set(ref.artifact_id, ref);
    for (const ref of item.equivalence_proof_refs) byId.set(ref.artifact_id, ref);
    if (item.prior_disposition_ref !== null) {
      byId.set(item.prior_disposition_ref.artifact_id, item.prior_disposition_ref);
    }
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
  readonly payload: ScaP08CognitivePayloadV1;
  readonly disclosure: ScaP08DisclosureAdmissionV1;
  readonly binding: RoleBinding;
} {
  if (input.assignment.registration_name !== "sca-p08-candidate") {
    throw new Error("P08 provider opening registration binding mismatch");
  }
  const binding = roleBinding(input.assignment.state_id, input.assignment.agent);
  if (input.assignment.branch_id !== null) {
    throw new Error("P08 provider opening branch binding mismatch");
  }
  const refs = orderedBindings(input.assignment.input_artifacts);
  const payload = exactJson(
    input.store,
    refs.payload_ref,
    "P08 cognitive payload",
    validateScaP08CognitivePayloadV1
  );
  const disclosure = exactJson(
    input.store,
    refs.disclosure_ref,
    "P08 disclosure admission",
    validateScaP08DisclosureAdmissionV1
  );
  if (
    payload.run_id !== input.assignment.run_id ||
    disclosure.run_id !== input.assignment.run_id ||
    payload.role !== binding.role ||
    disclosure.role !== binding.role ||
    disclosure.call_id !== payload.call_id ||
    disclosure.purpose !== payload.purpose ||
    !same(payload.disclosure_scope_ref, disclosure.disclosure_scope_ref) ||
    !same(disclosure.payload_ref, refs.payload_ref) ||
    disclosure.payload_sha256 !== refs.payload_ref.content_digest ||
    disclosure.payload_byte_length !== refs.payload_ref.byte_length ||
    !same(payload.required_model, SCA_P08_REQUIRED_MODEL) ||
    !same(disclosure.required_model, SCA_P08_REQUIRED_MODEL)
  ) {
    throw new Error("P08 provider opening payload/disclosure/model binding mismatch");
  }
  if (
    !same(
      expectedAuthorizedRefs(payload).map((ref) => ref.artifact_id),
      disclosure.authorized_refs.map((ref) => ref.artifact_id)
    )
  ) {
    throw new Error("P08 disclosure authorized refs differ from the serialized payload");
  }
  // The payload's declared scope-decision refs must be exactly the allowlisted members of the
  // authorized disclosure set: the zero-tool assessor can cite only records the host disclosed
  // and that the closed allowlist still calls a campaign/source scope decision.
  const authorizedScopeDecisionIds = disclosure.authorized_refs
    .filter((ref) => isScaP08ScopeDecisionKind(ref.kind))
    .map((ref) => ref.artifact_id);
  if (
    !same(
      payload.scope_decision_refs.map((ref) => ref.artifact_id),
      authorizedScopeDecisionIds
    )
  ) {
    throw new Error("P08 payload scope-decision projection differs from the authorized disclosure");
  }
  return { ...refs, payload, disclosure, binding };
}

export function buildScaP08InlineOpeningAppendix(input: {
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
      state_id: bound.binding.state_id,
      branch_id: null,
      role: bound.binding.role,
      agent: bound.binding.agent,
      task_sha256: sha256(input.assignment.task),
      input_artifacts_sha256: sha256(canonicalJson(input.assignment.input_artifacts)),
      payload_ref: bound.payload_ref,
      disclosure_ref: bound.disclosure_ref,
      payload: bound.payload,
      disclosure: bound.disclosure,
    },
    "P08 inline opening envelope"
  );
  return `${SCA_P08_INLINE_OPENING_PREFIX}${canonicalJson(envelope)}`;
}

function parseEnvelope(opening: string): InlineEnvelope {
  const marker = `\n\n${SCA_P08_INLINE_OPENING_PREFIX}`;
  const start = opening.lastIndexOf(marker);
  if (start < 0 || opening.indexOf(marker) !== start) {
    throw new Error("P08 serialized opening must contain exactly one inline envelope");
  }
  const after = opening.slice(start + marker.length);
  const endMarker = "\n\nReturn the complete stage output";
  const end = after.indexOf(endMarker);
  if (end < 0) throw new Error("P08 serialized opening envelope terminator is absent");
  const json = after.slice(0, end);
  const raw: unknown = JSON.parse(json);
  const parsed = validateContract(InlineEnvelopeSchema, raw, "P08 serialized inline envelope");
  if (canonicalJson(parsed) !== json) throw new Error("P08 inline envelope is not canonical JSON");
  return parsed;
}

export function authorizeScaP08SerializedOpening(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
  readonly opening: string;
}): ProviderOpeningAuthorizationV1 {
  const bound = bind(input);
  const envelope = parseEnvelope(input.opening);
  const appendix = buildScaP08InlineOpeningAppendix({
    store: input.store,
    assignment: input.assignment,
  });
  if (!input.opening.includes(`\n\n${appendix}\n\n`)) {
    throw new Error("P08 inline envelope differs from exact host projection");
  }
  if (
    !same(envelope.payload_ref, bound.payload_ref) ||
    !same(envelope.disclosure_ref, bound.disclosure_ref) ||
    !same(envelope.payload, bound.payload) ||
    !same(envelope.disclosure, bound.disclosure) ||
    envelope.task_sha256 !== sha256(input.assignment.task) ||
    envelope.input_artifacts_sha256 !== sha256(canonicalJson(input.assignment.input_artifacts))
  ) {
    throw new Error("P08 serialized opening bytes or assignment binding were substituted");
  }
  if (bound.disclosure.decision !== "allow" || bound.disclosure.blocker_codes.length !== 0) {
    throw new Error("P08 serialized opening disclosure is not allowed");
  }
  const scope = exactJson(
    input.store,
    bound.disclosure.disclosure_scope_ref,
    "P08 disclosure scope",
    validateScaP08DisclosureScopeV1
  );
  if (
    scope.run_id !== input.assignment.run_id ||
    scope.phase_id !== "SCA-P08" ||
    scope.purpose !== bound.payload.purpose ||
    !same(scope.required_model, SCA_P08_REQUIRED_MODEL) ||
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
    throw new Error("P08 disclosure scope/payload policy mismatch");
  }
  for (const ref of bound.disclosure.authorized_refs) {
    exactBytes(input.store, ref, "P08 authorized payload identity");
  }
  const max = Math.min(
    bound.disclosure.serialized_opening_byte_limit,
    scope.max_payload_bytes_per_call,
    SCA_P08_SERIALIZED_OPENING_MAX_BYTES
  );
  const payloadCapacity = Math.max(0, max - SCA_P08_SERIALIZED_OPENING_RESERVE_BYTES);
  if (bound.payload_ref.byte_length > payloadCapacity) {
    throw new Error("P08 payload exceeds admitted post-framing capacity");
  }
  const openingBytes = Buffer.byteLength(input.opening, "utf8");
  if (openingBytes > max) throw new Error("P08 complete serialized opening exceeds admitted limit");
  return {
    serialized_opening_sha256: sha256(input.opening),
    serialized_opening_byte_length: openingBytes,
    payload_ref: bound.payload_ref,
    disclosure_ref: bound.disclosure_ref,
  };
}

export const SCA_P08_PROVIDER_OPENING_ADAPTER = Object.freeze({
  id: SCA_P08_PROVIDER_OPENING_GUARD,
  resultRoutingPolicy: "exact_summary_only",
  matches: (registrationName, stateId, agent) =>
    registrationName === "sca-p08-candidate" &&
    ((stateId === SCA_P08_ASSESSING_STATE && agent === SCA_P08_ASSESSOR_AGENT) ||
      (stateId === SCA_P08_REVIEWING_STATE && agent === SCA_P08_REVIEWER_AGENT)),
  buildAppendix: ({ store, assignment }) => buildScaP08InlineOpeningAppendix({ store, assignment }),
  authorizeSerializedOpening: ({ store, assignment, opening }) =>
    authorizeScaP08SerializedOpening({ store, assignment, opening }),
} satisfies ProviderOpeningGuardAdapter);
