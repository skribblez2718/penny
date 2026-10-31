import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  type InputArtifacts,
  validateContract,
} from "../contracts.js";
import {
  PreDispatchPolicyDeniedError,
  type ProviderOpeningGuardAdapter,
} from "../provider-opening-guard.js";
import { validateScaModelDataPolicyV1 } from "./p01-policy-contracts.js";
import {
  SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P04_PROVIDER_OPENING_GUARD,
  SCA_P04_REQUIRED_MODEL,
  SCA_P04_SCANNER_SPECIALIST,
  SCA_P04_SPECIALIST_STATE,
  SCA_P04_UNDERDETECTED_SPECIALIST,
  ScaP04CognitivePayloadV1Schema,
  ScaP04DisclosureAdmissionV1Schema,
  scaP04SpecialistTask,
  validateScaP04CognitivePayloadV1,
  validateScaP04DisclosureAdmissionV1,
  type ScaP04CognitivePayloadV1,
  type ScaP04DisclosureAdmissionV1,
} from "./p04-contracts.js";

export const SCA_P04_INLINE_OPENING_PREFIX = "P04 INLINE COGNITIVE INPUT (host-verified):\n";
export const SCA_P04_SERIALIZED_OPENING_MAX_BYTES = 786_432 as const;
export const SCA_P04_SERIALIZED_OPENING_RESERVE_BYTES = 65_536 as const;
const INLINE_SCHEMA = "penny.sca-p04-inline-opening-envelope.v1" as const;

export type ScaP04PreDispatchPolicyBlockerCode =
  | "opening_appendix_invalid"
  | "opening_policy_denied";

// Compatibility re-export for existing P04 importers.
export { PreDispatchPolicyDeniedError };

export function assertScaP04SerializedOpeningSize(
  serializedOpening: string,
  admittedMaximumBytes: number
): number {
  const byteLength = Buffer.byteLength(serializedOpening, "utf8");
  const effectiveMaximum = Math.min(admittedMaximumBytes, SCA_P04_SERIALIZED_OPENING_MAX_BYTES);
  if (byteLength > effectiveMaximum) {
    throw new Error(
      `SCA P04 serialized provider opening exceeds admitted maximum (${byteLength} > ${effectiveMaximum})`
    );
  }
  return byteLength;
}

const InlineOpeningEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal(INLINE_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 512 }),
    state_id: Type.Literal(SCA_P04_SPECIALIST_STATE),
    branch_id: Type.Union([
      Type.Literal(SCA_P04_SCANNER_SPECIALIST),
      Type.Literal(SCA_P04_UNDERDETECTED_SPECIALIST),
    ]),
    specialist_id: Type.Union([
      Type.Literal(SCA_P04_SCANNER_SPECIALIST),
      Type.Literal(SCA_P04_UNDERDETECTED_SPECIALIST),
    ]),
    agent: Type.Union([Type.Literal("annie"), Type.Literal("echo")]),
    task_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    input_artifacts_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    payload_ref: ArtifactRefSchema,
    disclosure_ref: ArtifactRefSchema,
    payload: ScaP04CognitivePayloadV1Schema,
    disclosure: ScaP04DisclosureAdmissionV1Schema,
  },
  { additionalProperties: false, $id: INLINE_SCHEMA }
);
type InlineOpeningEnvelopeV1 = Readonly<Static<typeof InlineOpeningEnvelopeV1Schema>>;

export interface P04OpeningAssignmentV1 {
  readonly run_id: string;
  readonly state_id: string;
  readonly branch_id: string | null;
  readonly agent: string;
  readonly task: string;
  readonly input_artifacts: InputArtifacts;
}

export interface ScaP04OpeningAuthorizationV1 {
  readonly serialized_opening_sha256: string;
  readonly serialized_opening_byte_length: number;
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
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
    throw new Error(`${label} exact bytes/digest do not match the admitted ref`);
  }
  return bytes;
}

function deduplicateCanonicalEvidenceRefs(refs: readonly ArtifactRef[]): readonly ArtifactRef[] {
  const byArtifactId = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const prior = byArtifactId.get(ref.artifact_id);
    if (prior !== undefined && !same(prior, ref)) {
      throw new Error(
        `SCA P04 evidence ref '${ref.artifact_id}' has conflicting canonical metadata`
      );
    }
    if (prior === undefined) byArtifactId.set(ref.artifact_id, ref);
  }
  return [...byArtifactId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}

function exactJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const bytes = exactBytes(store, ref, label);
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return parsed;
  } catch (error) {
    throw new Error(`${label} is not canonical JSON input`, { cause: error });
  }
}

function inputRefs(input: InputArtifacts): {
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
} {
  const payload = input.artifacts.filter((binding) => binding.slot === "cognitive_payload");
  const disclosure = input.artifacts.filter((binding) => binding.slot === "disclosure_admission");
  if (
    input.artifacts.length !== 2 ||
    payload.length !== 1 ||
    disclosure.length !== 1 ||
    input.artifacts[0]?.slot !== "cognitive_payload" ||
    input.artifacts[1]?.slot !== "disclosure_admission"
  ) {
    throw new Error("P04 provider opening requires exactly the ordered payload/disclosure refs");
  }
  const payloadBinding = payload[0];
  const disclosureBinding = disclosure[0];
  if (payloadBinding === undefined || disclosureBinding === undefined) {
    throw new Error("P04 provider opening payload/disclosure refs are absent");
  }
  return { payload_ref: payloadBinding.ref, disclosure_ref: disclosureBinding.ref };
}

function expectedAgent(specialistId: string): "annie" | "echo" {
  if (specialistId === SCA_P04_SCANNER_SPECIALIST) return "annie";
  if (specialistId === SCA_P04_UNDERDETECTED_SPECIALIST) return "echo";
  throw new Error(`P04 provider opening has unknown specialist '${specialistId}'`);
}

function assertRefMetadata(
  ref: ArtifactRef,
  input: {
    readonly run_id: string;
    readonly branch_id: string;
    readonly kind: string;
    readonly schema_id: string;
  }
): void {
  if (
    ref.run_id !== input.run_id ||
    ref.phase !== "SCA-P04" ||
    ref.branch_id !== input.branch_id ||
    ref.kind !== input.kind ||
    ref.producer !== "host:sca-p04-candidate" ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== input.schema_id ||
    ref.content_schema.schema_version !== 1
  ) {
    throw new Error(`P04 provider opening '${input.kind}' ref metadata drift`);
  }
}

function readBoundInputs(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: P04OpeningAssignmentV1;
}): {
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
  readonly payload: ScaP04CognitivePayloadV1;
  readonly disclosure: ScaP04DisclosureAdmissionV1;
} {
  const refs = inputRefs(input.assignment.input_artifacts);
  if (input.assignment.branch_id === null) {
    throw new Error("P04 provider opening requires a concrete specialist branch");
  }
  assertRefMetadata(refs.payload_ref, {
    run_id: input.assignment.run_id,
    branch_id: input.assignment.branch_id,
    kind: "sca-p04-cognitive-payload",
    schema_id: SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
  });
  assertRefMetadata(refs.disclosure_ref, {
    run_id: input.assignment.run_id,
    branch_id: input.assignment.branch_id,
    kind: "sca-p04-disclosure-admission",
    schema_id: SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
  });
  const payload = validateScaP04CognitivePayloadV1(
    exactJson(input.store, refs.payload_ref, "P04 cognitive payload")
  );
  const disclosure = validateScaP04DisclosureAdmissionV1(
    exactJson(input.store, refs.disclosure_ref, "P04 disclosure admission")
  );
  return { ...refs, payload, disclosure };
}

export function buildScaP04InlineOpeningAppendix(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: P04OpeningAssignmentV1;
}): string {
  const bound = readBoundInputs(input);
  const envelope: InlineOpeningEnvelopeV1 = validateContract(
    InlineOpeningEnvelopeV1Schema,
    {
      schema_id: INLINE_SCHEMA,
      schema_version: 1,
      run_id: input.assignment.run_id,
      state_id: input.assignment.state_id,
      branch_id: input.assignment.branch_id,
      specialist_id: bound.payload.specialist_id,
      agent: input.assignment.agent,
      task_sha256: sha256(input.assignment.task),
      input_artifacts_sha256: sha256(canonicalJson(input.assignment.input_artifacts)),
      payload_ref: bound.payload_ref,
      disclosure_ref: bound.disclosure_ref,
      payload: bound.payload,
      disclosure: bound.disclosure,
    },
    "P04 inline opening envelope"
  );
  return `${SCA_P04_INLINE_OPENING_PREFIX}${canonicalJson(envelope)}`;
}

function parseEnvelopeFromOpening(opening: string): InlineOpeningEnvelopeV1 {
  const first = opening.indexOf(SCA_P04_INLINE_OPENING_PREFIX);
  const last = opening.lastIndexOf(SCA_P04_INLINE_OPENING_PREFIX);
  if (first < 0 || first !== last) {
    throw new Error("P04 serialized opening must contain exactly one inline input envelope");
  }
  const jsonStart = first + SCA_P04_INLINE_OPENING_PREFIX.length;
  const jsonEnd = opening.indexOf("\n", jsonStart);
  const serialized = opening.slice(jsonStart, jsonEnd < 0 ? opening.length : jsonEnd);
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error("P04 serialized opening envelope is not JSON", { cause: error });
  }
  const envelope = validateContract(
    InlineOpeningEnvelopeV1Schema,
    value,
    "P04 serialized opening envelope"
  );
  if (canonicalJson(envelope) !== serialized) {
    throw new Error("P04 serialized opening envelope is not canonical exact JSON");
  }
  return envelope;
}

export function authorizeScaP04SerializedOpening(input: {
  readonly store: ArtifactHostStore;
  readonly assignment: P04OpeningAssignmentV1;
  readonly opening: string;
}): ScaP04OpeningAuthorizationV1 {
  const envelope = parseEnvelopeFromOpening(input.opening);
  const bound = readBoundInputs({ store: input.store, assignment: input.assignment });
  const specialistId = bound.payload.specialist_id;
  const agent = expectedAgent(specialistId);
  if (
    input.assignment.state_id !== SCA_P04_SPECIALIST_STATE ||
    input.assignment.branch_id !== specialistId ||
    input.assignment.agent !== agent ||
    input.assignment.task !== scaP04SpecialistTask(specialistId) ||
    envelope.run_id !== input.assignment.run_id ||
    envelope.state_id !== input.assignment.state_id ||
    envelope.branch_id !== input.assignment.branch_id ||
    envelope.specialist_id !== specialistId ||
    envelope.agent !== input.assignment.agent ||
    envelope.task_sha256 !== sha256(input.assignment.task) ||
    envelope.input_artifacts_sha256 !== sha256(canonicalJson(input.assignment.input_artifacts))
  ) {
    throw new Error("P04 serialized opening branch/agent/task binding mismatch");
  }
  if (
    !same(envelope.payload_ref, bound.payload_ref) ||
    !same(envelope.disclosure_ref, bound.disclosure_ref) ||
    !same(envelope.payload, bound.payload) ||
    !same(envelope.disclosure, bound.disclosure)
  ) {
    throw new Error("P04 serialized opening payload/disclosure bytes or refs were substituted");
  }
  const disclosure = bound.disclosure;
  if (
    bound.payload.run_id !== input.assignment.run_id ||
    bound.payload.phase_id !== "SCA-P04" ||
    bound.payload.call_id !== `sca-p04-${specialistId}` ||
    disclosure.run_id !== input.assignment.run_id ||
    disclosure.phase_id !== "SCA-P04" ||
    disclosure.call_id !== bound.payload.call_id ||
    disclosure.specialist_id !== specialistId ||
    disclosure.agent !== agent ||
    disclosure.directive_state_id !== input.assignment.state_id ||
    !same(disclosure.payload_ref, bound.payload_ref) ||
    disclosure.payload_sha256 !== bound.payload_ref.content_digest ||
    disclosure.payload_byte_length !== bound.payload_ref.byte_length ||
    !same(bound.payload.required_model, SCA_P04_REQUIRED_MODEL) ||
    !same(disclosure.required_model, SCA_P04_REQUIRED_MODEL)
  ) {
    throw new Error("P04 serialized opening model/payload/disclosure binding mismatch");
  }
  const policy = validateScaModelDataPolicyV1(
    exactJson(input.store, disclosure.model_data_policy_ref, "P04 model-data policy")
  );
  if (
    disclosure.model_data_policy_sha256 !== disclosure.model_data_policy_ref.content_digest ||
    policy.status !== "approved" ||
    policy.model_alias !== SCA_P04_REQUIRED_MODEL.alias ||
    policy.provider !== SCA_P04_REQUIRED_MODEL.provider ||
    policy.model !== SCA_P04_REQUIRED_MODEL.model ||
    policy.destination_class !== disclosure.destination ||
    policy.provider_retention_status !== "known" ||
    policy.provider_retention_days !== disclosure.retention_days ||
    policy.provider_training_use !== disclosure.training ||
    disclosure.training !== "prohibited" ||
    disclosure.decision !== "allow"
  ) {
    throw new Error("P04 serialized opening disclosure/model-data policy is not allowed");
  }
  const payloadClasses = [...bound.payload.evidence_data_classes].sort();
  const includedClasses = disclosure.data_class_decisions
    .filter((entry) => entry.included)
    .map((entry) => entry.data_class)
    .sort();
  const policyTreatments = new Map(
    policy.data_classes.map((entry) => [entry.data_class, entry.treatment])
  );
  if (
    canonicalJson(payloadClasses) !== canonicalJson(includedClasses) ||
    disclosure.data_class_decisions.some(
      (entry) =>
        policyTreatments.get(entry.data_class) !== entry.treatment ||
        (entry.included && (entry.treatment === "deny" || entry.minimization === "excluded")) ||
        (!entry.included && entry.minimization !== "excluded")
    ) ||
    bound.payload.minimization.raw_source_embedded ||
    bound.payload.minimization.secrets_embedded ||
    bound.payload.minimization.personal_data_embedded
  ) {
    throw new Error("P04 serialized opening data-class/minimization policy mismatch");
  }
  for (const item of bound.payload.assigned_items) {
    if (!item.assigned_specialists.includes(specialistId)) {
      throw new Error("P04 serialized opening contains a cross-specialist item");
    }
  }
  const evidenceRefs = deduplicateCanonicalEvidenceRefs(
    bound.payload.assigned_items.flatMap((item) => item.evidence_refs)
  );
  for (const ref of evidenceRefs) {
    exactBytes(input.store, ref, `P04 exact evidence '${ref.artifact_id}'`);
  }
  const admittedOpeningLimit = Math.min(
    disclosure.serialized_opening_byte_limit,
    policy.payload_limit_bytes
  );
  const payloadCapacity = Math.max(
    0,
    Math.min(admittedOpeningLimit, SCA_P04_SERIALIZED_OPENING_MAX_BYTES) -
      SCA_P04_SERIALIZED_OPENING_RESERVE_BYTES
  );
  if (bound.payload_ref.byte_length > payloadCapacity) {
    throw new Error("P04 payload exceeds the admitted post-framing byte limit");
  }
  const openingBytes = assertScaP04SerializedOpeningSize(input.opening, admittedOpeningLimit);
  return {
    serialized_opening_sha256: sha256(input.opening),
    serialized_opening_byte_length: openingBytes,
    payload_ref: bound.payload_ref,
    disclosure_ref: bound.disclosure_ref,
  };
}

export function isScaP04ProviderOpeningGuard(value: string | undefined): boolean {
  return value === SCA_P04_PROVIDER_OPENING_GUARD;
}

export const SCA_P04_PROVIDER_OPENING_ADAPTER = Object.freeze({
  id: SCA_P04_PROVIDER_OPENING_GUARD,
  resultRoutingPolicy: "exact_summary_or_phase_json",
  matches: (registrationName, stateId, agent) =>
    registrationName === "sca-p04-candidate" &&
    stateId === SCA_P04_SPECIALIST_STATE &&
    (agent === "annie" || agent === "echo"),
  buildAppendix: ({ store, assignment }) => buildScaP04InlineOpeningAppendix({ store, assignment }),
  authorizeSerializedOpening: ({ store, assignment, opening }) =>
    authorizeScaP04SerializedOpening({ store, assignment, opening }),
} satisfies ProviderOpeningGuardAdapter);
