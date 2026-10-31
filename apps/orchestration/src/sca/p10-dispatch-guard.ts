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
  SCA_P10_CANDIDATE_PLAYBOOK_NAME,
  SCA_P10_PROPOSAL_CALL_ID,
  SCA_P10_PROPOSING_STATE,
  SCA_P10_PROPOSER_AGENT,
  SCA_P10_PROPOSER_ROLE,
  SCA_P10_PROVIDER_OPENING_GUARD,
  SCA_P10_REQUIRED_MODEL,
  ScaP10CognitivePayloadV1Schema,
  ScaP10DisclosureAdmissionV1Schema,
  validateScaP10CognitivePayloadV1,
  validateScaP10DisclosureAdmissionV1,
  validateScaP10DisclosureScopeV1,
  type ScaP10CognitivePayloadV1,
  type ScaP10DisclosureAdmissionV1,
} from "./p10-contracts.js";

export const SCA_P10_INLINE_OPENING_PREFIX = "P10 INLINE COGNITIVE INPUT (host-verified):\n";
export const SCA_P10_SERIALIZED_OPENING_MAX_BYTES = 786_432 as const;
export const SCA_P10_SERIALIZED_OPENING_RESERVE_BYTES = 65_536 as const;
const INLINE_SCHEMA = "penny.sca-p10-inline-opening-envelope.v1" as const;

const InlineEnvelopeSchema = Type.Object(
  {
    schema_id: Type.Literal(INLINE_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 512 }),
    state_id: Type.Literal(SCA_P10_PROPOSING_STATE),
    branch_id: Type.Null(),
    role: Type.Literal(SCA_P10_PROPOSER_ROLE),
    agent: Type.Literal(SCA_P10_PROPOSER_AGENT),
    task_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    input_artifacts_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    payload_ref: ArtifactRefSchema,
    disclosure_ref: ArtifactRefSchema,
    payload: ScaP10CognitivePayloadV1Schema,
    disclosure: ScaP10DisclosureAdmissionV1Schema,
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
    throw new Error("P10 provider opening requires exact ordered payload/disclosure bindings");
  }
  const payloadRef = input.artifacts[0]?.ref;
  const disclosureRef = input.artifacts[1]?.ref;
  if (payloadRef === undefined || disclosureRef === undefined) {
    throw new Error("P10 provider opening payload/disclosure refs are absent");
  }
  return { payload_ref: payloadRef, disclosure_ref: disclosureRef };
}
function expectedAuthorizedRefs(payload: ScaP10CognitivePayloadV1): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  byId.set(
    payload.p09_reconciliation_ledger_ref.artifact_id,
    payload.p09_reconciliation_ledger_ref
  );
  byId.set(payload.eligibility_ledger_ref.artifact_id, payload.eligibility_ledger_ref);
  byId.set(payload.baseline_evidence_ref.artifact_id, payload.baseline_evidence_ref);
  byId.set(payload.frozen_rule_release_ref.artifact_id, payload.frozen_rule_release_ref);
  for (const item of payload.items) {
    byId.set(item.primary_ref.artifact_id, item.primary_ref);
    byId.set(item.p08_disposition_ref.artifact_id, item.p08_disposition_ref);
    for (const ref of item.root_cause_evidence_refs) byId.set(ref.artifact_id, ref);
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
  readonly payload: ScaP10CognitivePayloadV1;
  readonly disclosure: ScaP10DisclosureAdmissionV1;
} {
  if (input.assignment.registration_name !== SCA_P10_CANDIDATE_PLAYBOOK_NAME) {
    throw new Error("P10 provider opening registration binding mismatch");
  }
  if (
    input.assignment.state_id !== SCA_P10_PROPOSING_STATE ||
    input.assignment.agent !== SCA_P10_PROPOSER_AGENT ||
    input.assignment.branch_id !== null
  ) {
    throw new Error("P10 provider opening state/agent/branch binding mismatch");
  }
  const refs = orderedBindings(input.assignment.input_artifacts);
  const payload = exactJson(
    input.store,
    refs.payload_ref,
    "P10 cognitive payload",
    validateScaP10CognitivePayloadV1
  );
  const disclosure = exactJson(
    input.store,
    refs.disclosure_ref,
    "P10 disclosure admission",
    validateScaP10DisclosureAdmissionV1
  );
  if (
    payload.run_id !== input.assignment.run_id ||
    disclosure.run_id !== input.assignment.run_id ||
    payload.call_id !== SCA_P10_PROPOSAL_CALL_ID ||
    disclosure.call_id !== SCA_P10_PROPOSAL_CALL_ID ||
    disclosure.purpose !== payload.purpose ||
    !same(payload.disclosure_scope_ref, disclosure.disclosure_scope_ref) ||
    !same(disclosure.payload_ref, refs.payload_ref) ||
    disclosure.payload_sha256 !== refs.payload_ref.content_digest ||
    disclosure.payload_byte_length !== refs.payload_ref.byte_length ||
    !same(payload.required_model, SCA_P10_REQUIRED_MODEL) ||
    !same(disclosure.required_model, SCA_P10_REQUIRED_MODEL)
  ) {
    throw new Error("P10 provider opening payload/disclosure/model binding mismatch");
  }
  if (
    !same(
      expectedAuthorizedRefs(payload).map((ref) => ref.artifact_id),
      disclosure.authorized_refs.map((ref) => ref.artifact_id)
    )
  ) {
    throw new Error("P10 disclosure authorized refs differ from the serialized payload");
  }
  return { ...refs, payload, disclosure };
}

export function buildScaP10InlineOpeningAppendix(input: {
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
      state_id: SCA_P10_PROPOSING_STATE,
      branch_id: null,
      role: SCA_P10_PROPOSER_ROLE,
      agent: SCA_P10_PROPOSER_AGENT,
      task_sha256: sha256(input.assignment.task),
      input_artifacts_sha256: sha256(canonicalJson(input.assignment.input_artifacts)),
      payload_ref: bound.payload_ref,
      disclosure_ref: bound.disclosure_ref,
      payload: bound.payload,
      disclosure: bound.disclosure,
    },
    "P10 inline opening envelope"
  );
  return `${SCA_P10_INLINE_OPENING_PREFIX}${canonicalJson(envelope)}`;
}

function parseEnvelope(opening: string): InlineEnvelope {
  const marker = `\n\n${SCA_P10_INLINE_OPENING_PREFIX}`;
  const start = opening.lastIndexOf(marker);
  if (start < 0 || opening.indexOf(marker) !== start) {
    throw new Error("P10 serialized opening must contain exactly one inline envelope");
  }
  const after = opening.slice(start + marker.length);
  const endMarker = "\n\nReturn the complete stage output";
  const end = after.indexOf(endMarker);
  if (end < 0) throw new Error("P10 serialized opening envelope terminator is absent");
  const json = after.slice(0, end);
  const raw: unknown = JSON.parse(json);
  const parsed = validateContract(InlineEnvelopeSchema, raw, "P10 serialized inline envelope");
  if (canonicalJson(parsed) !== json) throw new Error("P10 inline envelope is not canonical JSON");
  return parsed;
}

export function authorizeScaP10SerializedOpening(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: ProviderOpeningGuardAssignmentV1;
  readonly opening: string;
}): ProviderOpeningAuthorizationV1 {
  const bound = bind(input);
  const envelope = parseEnvelope(input.opening);
  const appendix = buildScaP10InlineOpeningAppendix({
    store: input.store,
    assignment: input.assignment,
  });
  if (!input.opening.includes(`\n\n${appendix}\n\n`)) {
    throw new Error("P10 inline envelope differs from exact host projection");
  }
  if (
    !same(envelope.payload_ref, bound.payload_ref) ||
    !same(envelope.disclosure_ref, bound.disclosure_ref) ||
    !same(envelope.payload, bound.payload) ||
    !same(envelope.disclosure, bound.disclosure) ||
    envelope.task_sha256 !== sha256(input.assignment.task) ||
    envelope.input_artifacts_sha256 !== sha256(canonicalJson(input.assignment.input_artifacts))
  ) {
    throw new Error("P10 serialized opening bytes or assignment binding were substituted");
  }
  if (bound.disclosure.decision !== "allow" || bound.disclosure.blocker_codes.length !== 0) {
    throw new Error("P10 serialized opening disclosure is not allowed");
  }
  const scope = exactJson(
    input.store,
    bound.disclosure.disclosure_scope_ref,
    "P10 disclosure scope",
    validateScaP10DisclosureScopeV1
  );
  if (
    scope.run_id !== input.assignment.run_id ||
    scope.phase_id !== "SCA-P10" ||
    scope.purpose !== bound.payload.purpose ||
    !same(scope.required_model, SCA_P10_REQUIRED_MODEL) ||
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
    throw new Error("P10 disclosure scope/payload policy mismatch");
  }
  for (const ref of bound.disclosure.authorized_refs) {
    exactBytes(input.store, ref, "P10 authorized payload identity");
  }
  const max = Math.min(
    bound.disclosure.serialized_opening_byte_limit,
    scope.max_payload_bytes_per_call,
    SCA_P10_SERIALIZED_OPENING_MAX_BYTES
  );
  const payloadCapacity = Math.max(0, max - SCA_P10_SERIALIZED_OPENING_RESERVE_BYTES);
  if (bound.payload_ref.byte_length > payloadCapacity) {
    throw new Error("P10 payload exceeds admitted post-framing capacity");
  }
  const openingBytes = Buffer.byteLength(input.opening, "utf8");
  if (openingBytes > max) throw new Error("P10 complete serialized opening exceeds admitted limit");
  return {
    serialized_opening_sha256: sha256(input.opening),
    serialized_opening_byte_length: openingBytes,
    payload_ref: bound.payload_ref,
    disclosure_ref: bound.disclosure_ref,
  };
}

export const SCA_P10_PROVIDER_OPENING_ADAPTER = Object.freeze({
  id: SCA_P10_PROVIDER_OPENING_GUARD,
  resultRoutingPolicy: "exact_summary_or_phase_json",
  matches: (registrationName, stateId, agent) =>
    registrationName === SCA_P10_CANDIDATE_PLAYBOOK_NAME &&
    stateId === SCA_P10_PROPOSING_STATE &&
    agent === SCA_P10_PROPOSER_AGENT,
  buildAppendix: ({ store, assignment }) => buildScaP10InlineOpeningAppendix({ store, assignment }),
  authorizeSerializedOpening: ({ store, assignment, opening }) =>
    authorizeScaP10SerializedOpening({ store, assignment, opening }),
} satisfies ProviderOpeningGuardAdapter);
