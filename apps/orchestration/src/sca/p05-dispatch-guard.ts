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
  SCA_P05_CHALLENGER_ROLE,
  SCA_P05_CHALLENGING_STATE,
  SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  SCA_P05_CONSTRUCTOR_ROLE,
  SCA_P05_FORMING_STATE,
  SCA_P05_PROVIDER_OPENING_GUARD,
  SCA_P05_REQUIRED_MODEL,
  ScaP05CognitivePayloadV1Schema,
  ScaP05DisclosureAdmissionV1Schema,
  validateScaP05CognitivePayloadV1,
  validateScaP05DisclosureAdmissionV1,
  validateScaP05DisclosureAuthorityV1,
  validateScaP05DisclosureScopeV1,
  type ScaP05CognitivePayloadV1,
  type ScaP05DisclosureAdmissionV1,
} from "./p05-contracts.js";

export const SCA_P05_INLINE_OPENING_PREFIX = "P05 INLINE COGNITIVE INPUT (host-verified):\n";
export const SCA_P05_SERIALIZED_OPENING_MAX_BYTES = 786_432 as const;
export const SCA_P05_SERIALIZED_OPENING_RESERVE_BYTES = 65_536 as const;
const INLINE_SCHEMA = "penny.sca-p05-inline-opening-envelope.v1" as const;

const InlineEnvelopeSchema = Type.Object(
  {
    schema_id: Type.Literal(INLINE_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 512 }),
    state_id: Type.Union([
      Type.Literal(SCA_P05_FORMING_STATE),
      Type.Literal(SCA_P05_CHALLENGING_STATE),
    ]),
    branch_id: Type.Null(),
    role: Type.Union([
      Type.Literal(SCA_P05_CONSTRUCTOR_ROLE),
      Type.Literal(SCA_P05_CHALLENGER_ROLE),
    ]),
    agent: Type.Union([Type.Literal("ida"), Type.Literal("annie")]),
    task_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    input_artifacts_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    payload_ref: ArtifactRefSchema,
    disclosure_ref: ArtifactRefSchema,
    payload: ScaP05CognitivePayloadV1Schema,
    disclosure: ScaP05DisclosureAdmissionV1Schema,
  },
  { additionalProperties: false, $id: INLINE_SCHEMA }
);
type InlineEnvelope = Readonly<Static<typeof InlineEnvelopeSchema>>;

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
  const bytes = exactBytes(store, ref, label);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
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
    throw new Error("P05 provider opening requires exact ordered payload/disclosure bindings");
  }
  const payloadRef = input.artifacts[0]?.ref;
  const disclosureRef = input.artifacts[1]?.ref;
  if (payloadRef === undefined || disclosureRef === undefined) {
    throw new Error("P05 provider opening payload/disclosure refs are absent");
  }
  return { payload_ref: payloadRef, disclosure_ref: disclosureRef };
}
function roleFor(assignment: ProviderOpeningGuardAssignmentV1): {
  readonly role: typeof SCA_P05_CONSTRUCTOR_ROLE | typeof SCA_P05_CHALLENGER_ROLE;
  readonly agent: "ida" | "annie";
} {
  if (assignment.state_id === SCA_P05_FORMING_STATE && assignment.agent === "ida") {
    return { role: SCA_P05_CONSTRUCTOR_ROLE, agent: "ida" };
  }
  if (assignment.state_id === SCA_P05_CHALLENGING_STATE && assignment.agent === "annie") {
    return { role: SCA_P05_CHALLENGER_ROLE, agent: "annie" };
  }
  throw new Error("P05 provider opening state/agent binding mismatch");
}
function bind(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
}): {
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
  readonly payload: ScaP05CognitivePayloadV1;
  readonly disclosure: ScaP05DisclosureAdmissionV1;
} {
  if (
    input.assignment.registration_name !== "sca-p05-candidate" ||
    input.assignment.branch_id !== null
  ) {
    throw new Error("P05 provider opening requires exact candidate registration and null branch");
  }
  const expected = roleFor(input.assignment);
  const refs = orderedBindings(input.assignment.input_artifacts);
  const payload = exactJson(
    input.store,
    refs.payload_ref,
    "P05 cognitive payload",
    validateScaP05CognitivePayloadV1
  );
  const disclosure = exactJson(
    input.store,
    refs.disclosure_ref,
    "P05 disclosure admission",
    validateScaP05DisclosureAdmissionV1
  );
  if (
    payload.run_id !== input.assignment.run_id ||
    payload.role !== expected.role ||
    disclosure.role !== expected.role ||
    disclosure.run_id !== input.assignment.run_id ||
    disclosure.call_id !== payload.call_id ||
    disclosure.purpose !== payload.purpose ||
    !same(payload.disclosure_scope_ref, disclosure.disclosure_scope_ref) ||
    !same(disclosure.payload_ref, refs.payload_ref) ||
    disclosure.payload_sha256 !== refs.payload_ref.content_digest ||
    disclosure.payload_byte_length !== refs.payload_ref.byte_length ||
    !same(payload.required_model, SCA_P05_REQUIRED_MODEL) ||
    !same(disclosure.required_model, SCA_P05_REQUIRED_MODEL)
  ) {
    throw new Error("P05 provider opening payload/disclosure/model binding mismatch");
  }
  return { ...refs, payload, disclosure };
}

export function buildScaP05InlineOpeningAppendix(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
}): string {
  const bound = bind(input);
  const role = roleFor(input.assignment);
  const envelope: InlineEnvelope = validateContract(
    InlineEnvelopeSchema,
    {
      schema_id: INLINE_SCHEMA,
      schema_version: 1,
      run_id: input.assignment.run_id,
      state_id: input.assignment.state_id,
      branch_id: null,
      role: role.role,
      agent: role.agent,
      task_sha256: sha256(input.assignment.task),
      input_artifacts_sha256: sha256(canonicalJson(input.assignment.input_artifacts)),
      payload_ref: bound.payload_ref,
      disclosure_ref: bound.disclosure_ref,
      payload: bound.payload,
      disclosure: bound.disclosure,
    },
    "P05 inline opening envelope"
  );
  return `${SCA_P05_INLINE_OPENING_PREFIX}${canonicalJson(envelope)}`;
}

function parseEnvelope(opening: string): InlineEnvelope {
  const marker = `\n\n${SCA_P05_INLINE_OPENING_PREFIX}`;
  const start = opening.lastIndexOf(marker);
  if (start < 0 || opening.indexOf(marker) !== start) {
    throw new Error("P05 serialized opening must contain exactly one inline envelope");
  }
  const after = opening.slice(start + marker.length);
  const endMarker = "\n\nReturn the complete stage output";
  const end = after.indexOf(endMarker);
  if (end < 0) throw new Error("P05 serialized opening envelope terminator is absent");
  const json = after.slice(0, end);
  const raw: unknown = JSON.parse(json);
  const parsed = validateContract(InlineEnvelopeSchema, raw, "P05 serialized inline envelope");
  if (canonicalJson(parsed) !== json) throw new Error("P05 inline envelope is not canonical JSON");
  return parsed;
}

export function authorizeScaP05SerializedOpening(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
  readonly opening: string;
}): ProviderOpeningAuthorizationV1 {
  const bound = bind(input);
  const envelope = parseEnvelope(input.opening);
  const expectedAppendix = buildScaP05InlineOpeningAppendix({
    store: input.store,
    assignment: input.assignment,
  });
  if (!input.opening.includes(`\n\n${expectedAppendix}\n\n`)) {
    throw new Error("P05 inline envelope differs from exact host projection");
  }
  if (
    !same(envelope.payload_ref, bound.payload_ref) ||
    !same(envelope.disclosure_ref, bound.disclosure_ref) ||
    !same(envelope.payload, bound.payload) ||
    !same(envelope.disclosure, bound.disclosure) ||
    envelope.task_sha256 !== sha256(input.assignment.task) ||
    envelope.input_artifacts_sha256 !== sha256(canonicalJson(input.assignment.input_artifacts))
  ) {
    throw new Error("P05 serialized opening bytes or assignment binding were substituted");
  }
  if (bound.disclosure.decision !== "allow" || bound.disclosure.blocker_codes.length !== 0) {
    throw new Error("P05 serialized opening disclosure is not allowed");
  }
  const scope = exactJson(
    input.store,
    bound.disclosure.disclosure_scope_ref,
    "P05 disclosure scope",
    validateScaP05DisclosureScopeV1
  );
  const authorityRef = scope.authority_ref;
  if (
    authorityRef.run_id !== input.assignment.run_id ||
    authorityRef.phase !== "SCA-P05" ||
    authorityRef.branch_id !== null ||
    authorityRef.kind !== "sca-p05-disclosure-authority" ||
    authorityRef.producer !== "host:sca-p05-candidate" ||
    authorityRef.media_type !== "application/json" ||
    authorityRef.content_schema?.schema_id !== SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA ||
    authorityRef.content_schema.schema_version !== 1
  ) {
    throw new Error("P05 disclosure authority ref lacks exact trusted host metadata");
  }
  const authority = exactJson(
    input.store,
    authorityRef,
    "P05 disclosure authority",
    validateScaP05DisclosureAuthorityV1
  );
  if (
    authority.run_id !== input.assignment.run_id ||
    scope.run_id !== input.assignment.run_id ||
    !same(bound.payload.disclosure_scope_ref, bound.disclosure.disclosure_scope_ref) ||
    !same(bound.payload.source_snapshot_ref, scope.source_snapshot_ref) ||
    bound.payload.source_snapshot_sha256 !== scope.source_snapshot_sha256 ||
    scope.source_snapshot_sha256 !== scope.source_snapshot_ref.content_digest ||
    authority.source_snapshot_sha256 !== scope.source_snapshot_sha256 ||
    !same(authority.required_model, scope.required_model) ||
    authority.destination_class !== scope.destination_class ||
    !same(authority.purposes, scope.purposes) ||
    authority.provider_retention_status !== scope.provider_retention_status ||
    authority.provider_retention_days !== scope.provider_retention_days ||
    authority.provider_logging_status !== scope.provider_logging_status ||
    authority.provider_logging_days !== scope.provider_logging_days ||
    authority.provider_training_use !== scope.provider_training_use ||
    authority.max_payload_bytes_per_call !== scope.max_payload_bytes_per_call ||
    authority.max_provider_calls !== scope.max_provider_calls
  ) {
    throw new Error("P05 disclosure authority differs from the exact call scope");
  }
  if (
    scope.scope_sha256 !== bound.disclosure.disclosure_scope_sha256 ||
    scope.decision !== "allow" ||
    scope.blocker_codes.length !== 0 ||
    !same(scope.required_model, SCA_P05_REQUIRED_MODEL) ||
    !scope.purposes.includes(bound.payload.purpose) ||
    bound.disclosure.retention_days !== scope.provider_retention_days ||
    bound.disclosure.logging_status !== scope.provider_logging_status ||
    bound.disclosure.logging_days !== scope.provider_logging_days ||
    bound.disclosure.destination !== scope.destination_class ||
    bound.disclosure.training !== scope.provider_training_use ||
    bound.disclosure.serialized_opening_byte_limit > scope.max_payload_bytes_per_call
  ) {
    throw new Error("P05 disclosure scope/payload policy mismatch");
  }
  const permissions = new Map(scope.evidence_permissions.map((entry) => [entry.atom_id, entry]));
  const selected = new Set(bound.payload.assigned_item_ids);
  for (const atom of bound.payload.evidence_atoms) {
    const permission = permissions.get(atom.atom_id);
    if (
      permission === undefined ||
      !permission.allowed ||
      permission.selected_item_id !== atom.selected_item_id ||
      permission.atom_kind !== atom.atom_kind ||
      !same(permission.origin_ref, atom.origin_ref) ||
      permission.selector !== atom.selector ||
      permission.value_sha256 !== atom.value_sha256 ||
      sha256(canonicalJson(atom.value)) !== atom.value_sha256 ||
      !selected.has(atom.selected_item_id)
    ) {
      throw new Error(`P05 evidence atom '${atom.atom_id}' is not exactly authorized`);
    }
    exactBytes(input.store, atom.origin_ref, `P05 evidence atom '${atom.atom_id}' origin`);
  }
  const atomIds = bound.payload.evidence_atoms.map((entry) => entry.atom_id).sort();
  if (!same(atomIds, bound.disclosure.authorized_atom_ids)) {
    throw new Error("P05 disclosure atom set differs from serialized payload");
  }
  const sourceAtoms = bound.payload.evidence_atoms.filter(
    (entry) => entry.atom_kind === "source_segment"
  );
  const segmentIds = sourceAtoms
    .map((entry) => entry.selector.replace(/^source-segment:/u, ""))
    .sort();
  if (!same(segmentIds, bound.disclosure.authorized_segment_ids)) {
    throw new Error("P05 disclosure segment set differs from serialized payload");
  }
  for (const atom of sourceAtoms) {
    const segmentId = atom.selector.replace(/^source-segment:/u, "");
    const segment = scope.source_segments.find((entry) => entry.segment_id === segmentId);
    if (
      segment === undefined ||
      segment.selected_item_id !== atom.selected_item_id ||
      segment.visible_text_sha256 !== sha256(Buffer.from(String(atom.value), "utf8")) ||
      segment.visible_text_utf8 !== atom.value ||
      segment.secrets_status === undefined ||
      segment.personal_data_status === undefined
    ) {
      throw new Error(`P05 source segment '${segmentId}' is not exactly authorized`);
    }
  }
  exactBytes(input.store, scope.source_snapshot_ref, "P05 authorized source snapshot");
  const max = Math.min(
    bound.disclosure.serialized_opening_byte_limit,
    scope.max_payload_bytes_per_call,
    authority.max_payload_bytes_per_call,
    SCA_P05_SERIALIZED_OPENING_MAX_BYTES
  );
  const payloadCapacity = Math.max(0, max - SCA_P05_SERIALIZED_OPENING_RESERVE_BYTES);
  if (bound.payload_ref.byte_length > payloadCapacity) {
    throw new Error("P05 payload exceeds admitted post-framing capacity");
  }
  const openingBytes = Buffer.byteLength(input.opening, "utf8");
  if (openingBytes > max) throw new Error("P05 complete serialized opening exceeds admitted limit");
  return {
    serialized_opening_sha256: sha256(input.opening),
    serialized_opening_byte_length: openingBytes,
    payload_ref: bound.payload_ref,
    disclosure_ref: bound.disclosure_ref,
  };
}

export const SCA_P05_PROVIDER_OPENING_ADAPTER = Object.freeze({
  id: SCA_P05_PROVIDER_OPENING_GUARD,
  resultRoutingPolicy: "exact_summary_or_phase_json",
  matches: (registrationName, stateId, agent) =>
    registrationName === "sca-p05-candidate" &&
    ((stateId === SCA_P05_FORMING_STATE && agent === "ida") ||
      (stateId === SCA_P05_CHALLENGING_STATE && agent === "annie")),
  buildAppendix: ({ store, assignment }) => buildScaP05InlineOpeningAppendix({ store, assignment }),
  authorizeSerializedOpening: ({ store, assignment, opening }) =>
    authorizeScaP05SerializedOpening({ store, assignment, opening }),
} satisfies ProviderOpeningGuardAdapter);
