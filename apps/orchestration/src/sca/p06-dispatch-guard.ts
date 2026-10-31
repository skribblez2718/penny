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
  SCA_P06_DECIDER_ROLE,
  SCA_P06_DECIDING_STATE,
  SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  SCA_P06_PROVIDER_OPENING_GUARD,
  SCA_P06_REQUIRED_MODEL,
  ScaP06CognitivePayloadV1Schema,
  ScaP06DisclosureAdmissionV1Schema,
  validateScaP06ActionAuthorityV1,
  validateScaP06CognitivePayloadV1,
  validateScaP06DisclosureAdmissionV1,
  validateScaP06DisclosureAuthorityV1,
  validateScaP06DisclosureScopeV1,
  validateScaP06ResourcePolicyV1,
  type ScaP06CognitivePayloadV1,
  type ScaP06DisclosureAdmissionV1,
} from "./p06-contracts.js";

export const SCA_P06_INLINE_OPENING_PREFIX = "P06 INLINE COGNITIVE INPUT (host-verified):\n";
export const SCA_P06_SERIALIZED_OPENING_MAX_BYTES = 786_432 as const;
export const SCA_P06_SERIALIZED_OPENING_RESERVE_BYTES = 65_536 as const;
const INLINE_SCHEMA = "penny.sca-p06-inline-opening-envelope.v1" as const;

const InlineEnvelopeSchema = Type.Object(
  {
    schema_id: Type.Literal(INLINE_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 512 }),
    state_id: Type.Literal(SCA_P06_DECIDING_STATE),
    branch_id: Type.Null(),
    role: Type.Literal(SCA_P06_DECIDER_ROLE),
    agent: Type.Literal("demetri"),
    task_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    input_artifacts_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    payload_ref: ArtifactRefSchema,
    disclosure_ref: ArtifactRefSchema,
    payload: ScaP06CognitivePayloadV1Schema,
    disclosure: ScaP06DisclosureAdmissionV1Schema,
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
    throw new Error("P06 provider opening requires exact ordered payload/disclosure bindings");
  }
  const payloadRef = input.artifacts[0]?.ref;
  const disclosureRef = input.artifacts[1]?.ref;
  if (payloadRef === undefined || disclosureRef === undefined) {
    throw new Error("P06 provider opening payload/disclosure refs are absent");
  }
  return { payload_ref: payloadRef, disclosure_ref: disclosureRef };
}
function bind(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
}): {
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
  readonly payload: ScaP06CognitivePayloadV1;
  readonly disclosure: ScaP06DisclosureAdmissionV1;
} {
  if (
    input.assignment.registration_name !== "sca-p06-candidate" ||
    input.assignment.state_id !== SCA_P06_DECIDING_STATE ||
    input.assignment.branch_id !== null ||
    input.assignment.agent !== "demetri"
  ) {
    throw new Error("P06 provider opening state/agent/registration binding mismatch");
  }
  const refs = orderedBindings(input.assignment.input_artifacts);
  const payload = exactJson(
    input.store,
    refs.payload_ref,
    "P06 cognitive payload",
    validateScaP06CognitivePayloadV1
  );
  const disclosure = exactJson(
    input.store,
    refs.disclosure_ref,
    "P06 disclosure admission",
    validateScaP06DisclosureAdmissionV1
  );
  if (
    payload.run_id !== input.assignment.run_id ||
    disclosure.run_id !== input.assignment.run_id ||
    payload.role !== SCA_P06_DECIDER_ROLE ||
    disclosure.role !== SCA_P06_DECIDER_ROLE ||
    disclosure.call_id !== payload.call_id ||
    disclosure.purpose !== payload.purpose ||
    !same(payload.disclosure_scope_ref, disclosure.disclosure_scope_ref) ||
    !same(disclosure.payload_ref, refs.payload_ref) ||
    disclosure.payload_sha256 !== refs.payload_ref.content_digest ||
    disclosure.payload_byte_length !== refs.payload_ref.byte_length ||
    !same(payload.required_model, SCA_P06_REQUIRED_MODEL) ||
    !same(disclosure.required_model, SCA_P06_REQUIRED_MODEL)
  ) {
    throw new Error("P06 provider opening payload/disclosure/model binding mismatch");
  }
  return { ...refs, payload, disclosure };
}

export function buildScaP06InlineOpeningAppendix(input: {
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
      state_id: SCA_P06_DECIDING_STATE,
      branch_id: null,
      role: SCA_P06_DECIDER_ROLE,
      agent: "demetri",
      task_sha256: sha256(input.assignment.task),
      input_artifacts_sha256: sha256(canonicalJson(input.assignment.input_artifacts)),
      payload_ref: bound.payload_ref,
      disclosure_ref: bound.disclosure_ref,
      payload: bound.payload,
      disclosure: bound.disclosure,
    },
    "P06 inline opening envelope"
  );
  return `${SCA_P06_INLINE_OPENING_PREFIX}${canonicalJson(envelope)}`;
}

function parseEnvelope(opening: string): InlineEnvelope {
  const marker = `\n\n${SCA_P06_INLINE_OPENING_PREFIX}`;
  const start = opening.lastIndexOf(marker);
  if (start < 0 || opening.indexOf(marker) !== start) {
    throw new Error("P06 serialized opening must contain exactly one inline envelope");
  }
  const after = opening.slice(start + marker.length);
  const endMarker = "\n\nReturn the complete stage output";
  const end = after.indexOf(endMarker);
  if (end < 0) throw new Error("P06 serialized opening envelope terminator is absent");
  const json = after.slice(0, end);
  const raw: unknown = JSON.parse(json);
  const parsed = validateContract(InlineEnvelopeSchema, raw, "P06 serialized inline envelope");
  if (canonicalJson(parsed) !== json) throw new Error("P06 inline envelope is not canonical JSON");
  return parsed;
}

export function authorizeScaP06SerializedOpening(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
  readonly opening: string;
}): ProviderOpeningAuthorizationV1 {
  const bound = bind(input);
  const envelope = parseEnvelope(input.opening);
  const appendix = buildScaP06InlineOpeningAppendix({
    store: input.store,
    assignment: input.assignment,
  });
  if (!input.opening.includes(`\n\n${appendix}\n\n`)) {
    throw new Error("P06 inline envelope differs from exact host projection");
  }
  if (
    !same(envelope.payload_ref, bound.payload_ref) ||
    !same(envelope.disclosure_ref, bound.disclosure_ref) ||
    !same(envelope.payload, bound.payload) ||
    !same(envelope.disclosure, bound.disclosure) ||
    envelope.task_sha256 !== sha256(input.assignment.task) ||
    envelope.input_artifacts_sha256 !== sha256(canonicalJson(input.assignment.input_artifacts))
  ) {
    throw new Error("P06 serialized opening bytes or assignment binding were substituted");
  }
  if (bound.disclosure.decision !== "allow" || bound.disclosure.blocker_codes.length !== 0) {
    throw new Error("P06 serialized opening disclosure is not allowed");
  }
  const scope = exactJson(
    input.store,
    bound.disclosure.disclosure_scope_ref,
    "P06 disclosure scope",
    validateScaP06DisclosureScopeV1
  );
  const authorityRef = scope.authority_ref;
  if (
    authorityRef.run_id !== input.assignment.run_id ||
    authorityRef.phase !== "SCA-P06" ||
    authorityRef.branch_id !== null ||
    authorityRef.kind !== "sca-p06-disclosure-authority" ||
    authorityRef.operation_id !== "sca-p06-disclosure-authority" ||
    authorityRef.producer !== "host:sca-p06-candidate" ||
    authorityRef.media_type !== "application/json" ||
    authorityRef.content_schema?.schema_id !== SCA_P06_DISCLOSURE_AUTHORITY_V1_SCHEMA ||
    authorityRef.content_schema.schema_version !== 1
  ) {
    throw new Error("P06 disclosure authority ref lacks exact trusted host metadata");
  }
  const authority = exactJson(
    input.store,
    authorityRef,
    "P06 disclosure authority",
    validateScaP06DisclosureAuthorityV1
  );
  const actionAuthority = exactJson(
    input.store,
    scope.action_authority_ref,
    "P06 action authority",
    validateScaP06ActionAuthorityV1
  );
  const resourcePolicy = exactJson(
    input.store,
    scope.resource_policy_ref,
    "P06 resource policy",
    validateScaP06ResourcePolicyV1
  );
  if (
    authority.run_id !== input.assignment.run_id ||
    scope.run_id !== input.assignment.run_id ||
    !same(bound.payload.source_snapshot_ref, scope.source_snapshot_ref) ||
    bound.payload.source_snapshot_sha256 !== scope.source_snapshot_sha256 ||
    authority.source_snapshot_sha256 !== scope.source_snapshot_sha256 ||
    actionAuthority.source_snapshot_sha256 !== scope.source_snapshot_sha256 ||
    resourcePolicy.source_snapshot_sha256 !== scope.source_snapshot_sha256 ||
    !same(bound.payload.p05_transition_ref, scope.p05_transition_ref) ||
    !same(actionAuthority.p05_transition_ref, scope.p05_transition_ref) ||
    !same(resourcePolicy.p05_transition_ref, scope.p05_transition_ref) ||
    !same(bound.payload.action_authority_ref, scope.action_authority_ref) ||
    !same(bound.payload.resource_policy_ref, scope.resource_policy_ref) ||
    !same(bound.disclosure.action_authority_ref, scope.action_authority_ref) ||
    !same(bound.disclosure.resource_policy_ref, scope.resource_policy_ref) ||
    !same(authority.required_model, scope.required_model) ||
    authority.destination_class !== scope.destination_class ||
    authority.purpose !== scope.purpose ||
    !same(authority.allowed_data_classes, scope.allowed_data_classes) ||
    authority.provider_retention_status !== scope.provider_retention_status ||
    authority.provider_retention_days !== scope.provider_retention_days ||
    authority.provider_logging_status !== scope.provider_logging_status ||
    authority.provider_logging_days !== scope.provider_logging_days ||
    authority.provider_training_use !== scope.provider_training_use ||
    authority.max_payload_bytes_per_call !== scope.max_payload_bytes_per_call ||
    authority.max_provider_calls !== scope.max_provider_calls
  ) {
    throw new Error("P06 disclosure/policy authority differs from exact call scope");
  }
  if (
    scope.scope_sha256 !== bound.disclosure.disclosure_scope_sha256 ||
    scope.decision !== "allow" ||
    scope.blocker_codes.length !== 0 ||
    authority.decision !== "approved" ||
    authority.blocker_codes.length !== 0 ||
    !same(scope.required_model, SCA_P06_REQUIRED_MODEL) ||
    bound.disclosure.retention_days !== scope.provider_retention_days ||
    bound.disclosure.logging_status !== scope.provider_logging_status ||
    bound.disclosure.logging_days !== scope.provider_logging_days ||
    bound.disclosure.destination !== scope.destination_class ||
    bound.disclosure.training !== scope.provider_training_use ||
    bound.disclosure.serialized_opening_byte_limit > scope.max_payload_bytes_per_call
  ) {
    throw new Error("P06 disclosure scope/payload policy mismatch");
  }
  const permissions = new Map(
    scope.revision_permissions.map((entry) => [entry.hypothesis_id, entry])
  );
  for (const item of bound.payload.items) {
    const permission = permissions.get(item.hypothesis_id);
    if (
      permission === undefined ||
      !same(permission.revision_ref, item.final_revision_ref) ||
      permission.revision_sha256 !== item.revision_sha256 ||
      permission.body_sha256 !== item.body_sha256 ||
      sha256(canonicalJson(item.hypothesis)) !== item.body_sha256
    ) {
      throw new Error(`P06 hypothesis '${item.hypothesis_id}' is not exactly authorized`);
    }
    exactBytes(
      input.store,
      item.final_revision_ref,
      `P06 hypothesis '${item.hypothesis_id}' revision`
    );
    exactBytes(
      input.store,
      item.base_obligation_ref,
      `P06 hypothesis '${item.hypothesis_id}' obligation`
    );
  }
  if (
    !same(
      bound.disclosure.authorized_revision_refs.map((ref) => ref.artifact_id).sort(),
      bound.payload.items.map((entry) => entry.final_revision_ref.artifact_id).sort()
    )
  ) {
    throw new Error("P06 disclosure revision set differs from serialized payload");
  }
  exactBytes(input.store, scope.source_snapshot_ref, "P06 authorized source snapshot identity");
  exactBytes(input.store, scope.action_authority_ref, "P06 authorized action policy");
  exactBytes(input.store, scope.resource_policy_ref, "P06 authorized resource policy");
  const max = Math.min(
    bound.disclosure.serialized_opening_byte_limit,
    scope.max_payload_bytes_per_call,
    authority.max_payload_bytes_per_call,
    SCA_P06_SERIALIZED_OPENING_MAX_BYTES
  );
  const payloadCapacity = Math.max(0, max - SCA_P06_SERIALIZED_OPENING_RESERVE_BYTES);
  if (bound.payload_ref.byte_length > payloadCapacity) {
    throw new Error("P06 payload exceeds admitted post-framing capacity");
  }
  const openingBytes = Buffer.byteLength(input.opening, "utf8");
  if (openingBytes > max) throw new Error("P06 complete serialized opening exceeds admitted limit");
  return {
    serialized_opening_sha256: sha256(input.opening),
    serialized_opening_byte_length: openingBytes,
    payload_ref: bound.payload_ref,
    disclosure_ref: bound.disclosure_ref,
  };
}

export const SCA_P06_PROVIDER_OPENING_ADAPTER = Object.freeze({
  id: SCA_P06_PROVIDER_OPENING_GUARD,
  resultRoutingPolicy: "exact_summary_only",
  matches: (registrationName, stateId, agent) =>
    registrationName === "sca-p06-candidate" &&
    stateId === SCA_P06_DECIDING_STATE &&
    agent === "demetri",
  buildAppendix: ({ store, assignment }) => buildScaP06InlineOpeningAppendix({ store, assignment }),
  authorizeSerializedOpening: ({ store, assignment, opening }) =>
    authorizeScaP06SerializedOpening({ store, assignment, opening }),
} satisfies ProviderOpeningGuardAdapter);
