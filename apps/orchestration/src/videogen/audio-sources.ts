import { realpathSync } from "node:fs";
import { pennyStatePaths, projectStatePaths } from "../state/paths.js";
import { MediaEvidenceCustody, type MediaEvidenceCustodyBindingsV1 } from "./media-evidence.js";
import { RAW_MEDIA_RESULT_CONTRACT, RawMediaDecodeResultV1Schema } from "./media-contracts.js";
import type { RightsHostV1 } from "./rights-ledger.js";
import { Type, type Static } from "typebox";
import {
  AudioStemRoleSchema,
  checkAudioProviderContract,
  checkAudioRights,
  type AudioSourceHostV1,
} from "./audio-source-admission.js";
export { AudioStemRoleSchema } from "./audio-source-admission.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import {
  HostOperationReceiptV1Schema,
  validateHostOperationReceipt,
} from "../host-operations/contracts.js";
import { OpaqueIdSchema as Id, assertRfc3339Utc, assertUnique } from "../skill-contracts/common.js";
import {
  readExact,
  readSemantic,
  sameRef,
  validateFoundation,
  type FoundationLimitsV1,
} from "./bounds.js";
import {
  RationalRateSchema,
  RationalTimeSchema,
  addTime,
  compareTime,
  rationalTime,
  validateRationalRate,
  validateRationalTime,
} from "./rational-time.js";
import { ProvenanceBindingV1Schema, checkRights, type RightsUse } from "./rights-ledger.js";

const closed = { additionalProperties: false } as const;
/** Receipt-shaped metadata is required syntax, not proof of signed journal custody. */
const AudioDecodeReceiptRefSchema = Type.Object(
  {
    ...ArtifactRefSchema.properties,
    content_schema: Type.Object(
      {
        schema_id: Type.Literal("penny.host-operation-receipt.v1"),
        schema_version: Type.Literal(1),
      },
      closed
    ),
  },
  closed
);
const sourceFields = {
  schema_id: Type.Literal("penny.videogen-audio-source.v1"),
  schema_version: Type.Literal(1),
  media_ref: ArtifactRefSchema,
  rights_ref: ArtifactRefSchema,
  consent_ref: Type.Optional(ArtifactRefSchema),
  role: AudioStemRoleSchema,
  placement: RationalTimeSchema,
  duration: RationalTimeSchema,
  decoded_audio_ref: AudioDecodeReceiptRefSchema,
  channels: Type.Union([Type.Literal("mono"), Type.Literal("stereo")]),
  sample_rate: RationalRateSchema,
  codec: Type.Literal("canonical_pcm"),
  provenance_ref: ArtifactRefSchema,
};
/** CONTRACTS.md is the sole semantic field authority. No pre-capture or TimingV1 variant. */
export const AudioSourceV1Schema = Type.Union([
  Type.Object(
    { ...sourceFields, source_kind: Type.Literal("voice_studio"), consent_ref: ArtifactRefSchema },
    closed
  ),
  Type.Object({ ...sourceFields, source_kind: Type.Literal("supplied") }, closed),
  Type.Object({ ...sourceFields, source_kind: Type.Literal("public_licensed") }, closed),
  Type.Object(
    {
      ...sourceFields,
      source_kind: Type.Literal("registered_generator"),
      registered_provider_id: Id,
    },
    closed
  ),
]);
export type AudioSourceV1 = Static<typeof AudioSourceV1Schema>;
export const AudioMeasurementV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-audio-measurement.v1"),
    schema_version: Type.Literal(1),
    source_ref: ArtifactRefSchema,
    source_track_ids: Type.Array(Id, { minItems: 1, uniqueItems: true }),
    track_codecs: Type.Array(Id, { minItems: 1 }),
    decoded_sample_count: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    sample_rate: RationalRateSchema,
    channels: Type.Union([Type.Literal("mono"), Type.Literal("stereo")]),
    measured_sync_offsets: Type.Array(
      Type.Object({ line_id: Id, offset: RationalTimeSchema }, closed)
    ),
    decode_receipt_ref: AudioDecodeReceiptRefSchema,
  },
  closed
);
export type AudioMeasurementV1 = Static<typeof AudioMeasurementV1Schema>;
export const SourceClipAudioPolicySchema = Type.Union([
  Type.Literal("strip_source_audio"),
  Type.Literal("retain_as_sole_speech"),
  Type.Literal("mix_with_stems"),
]);
export type SourceClipAudioPolicy = Static<typeof SourceClipAudioPolicySchema>;

function isSpeech(role: AudioSourceV1["role"]): boolean {
  return role === "dialogue" || role === "narration";
}
function captureRefs(source: AudioSourceV1): ArtifactRef[] {
  return [
    source.media_ref,
    source.rights_ref,
    source.provenance_ref,
    source.decoded_audio_ref,
    ...(source.consent_ref === undefined ? [] : [source.consent_ref]),
  ];
}
export function validateAudioSource(value: unknown, limits: FoundationLimitsV1): AudioSourceV1 {
  const source = validateFoundation(AudioSourceV1Schema, value, limits);
  validateRationalTime(source.placement);
  validateRationalTime(source.duration);
  validateRationalRate(source.sample_rate);
  if (source.placement.numerator < 0 || source.duration.numerator <= 0)
    throw new Error("positive source duration and nonnegative placement required");
  const end = addTime(source.placement, source.duration);
  if (end.numerator > limits.max_integer || end.denominator > limits.max_integer)
    throw new Error("source end exceeds representation policy");
  if (
    (source.source_kind === "voice_studio" || isSpeech(source.role)) &&
    source.consent_ref === undefined
  )
    throw new Error("performed voice consent required");
  if (
    captureRefs(source).some(
      (ref) =>
        ref.content_schema?.schema_id === "penny.videogen-audio-source.v1" ||
        ref.content_schema?.schema_id === "penny.videogen-timing.v1"
    )
  )
    throw new Error("capture cannot depend on TimingV1 or another/self AudioSource");
  return source;
}
export function validateAudioMeasurement(
  value: unknown,
  limits: FoundationLimitsV1
): AudioMeasurementV1 {
  const measurement = validateFoundation(AudioMeasurementV1Schema, value, limits);
  validateRationalRate(measurement.sample_rate);
  if (measurement.source_track_ids.length !== measurement.track_codecs.length)
    throw new Error("audio track/codec coverage mismatch");
  assertUnique(
    measurement.measured_sync_offsets.map((x) => x.line_id),
    "sync line IDs"
  );
  for (const item of measurement.measured_sync_offsets) validateRationalTime(item.offset);
  return measurement;
}

export type AudioSourceRefusalReason =
  | "invalid_input"
  | "missing_host"
  | "unsupported_generator"
  | "rights_or_consent"
  | "captured_media_or_decode_drift";
const noProduction = { production_admission: "blocked", effect_permission: "none" } as const;
type AudioSourceRefusal = {
  readonly status: "refused";
  readonly reason: AudioSourceRefusalReason;
} & typeof noProduction;
export type AudioSourceCheck =
  | AudioSourceRefusal
  | ({
      readonly status: "protocol_checked";
      readonly source_admission: "unverified";
      readonly source: AudioSourceV1;
      readonly measurement: AudioMeasurementV1;
      readonly unverified: readonly [
        "decode_receipt_authority",
        "capture_journal_order",
        "speech_playback_and_timing",
      ];
    } & typeof noProduction)
  | ({
      readonly status: "protocol_checked";
      readonly source_admission: "admitted";
      readonly source: AudioSourceV1;
      readonly measurement: AudioMeasurementV1;
      readonly unverified: readonly [
        "gated_effect_intent_integration",
        "capture_journal_order",
        "decoder_deployment_qualification",
        "speech_playback_and_timing",
      ];
    } & typeof noProduction);
export type CapturedAudioSourceCheck =
  | AudioSourceRefusal
  | (Exclude<AudioSourceCheck, AudioSourceRefusal> & {
      readonly source_ref: ArtifactRef;
      readonly measurement_ref: ArtifactRef;
    });
function refused(reason: AudioSourceRefusalReason): AudioSourceRefusal {
  return { status: "refused", reason, ...noProduction };
}

/**
 * Host-internal READ-ONLY preflight, not an ingress, receipt issuer or production grant.
 * Reuses WP-003's exact RightsHostV1 trust boundary, current index and project-bound readback.
 * Callers must not construct that host from worker/caller claims. This helper authenticates nobody.
 *
 * Capture ordering: every operand, including media, receipt and decoded facts, must already exist.
 * No future receipt/TimingV1/self AudioSource is an operand. Persist/read back the returned source
 * separately through the existing owner. Later timing/evidence must cite that EXACT persisted ref.
 * A separately injected concrete custody capability can admit the captured source against existing
 * settled raw-media records and an already materialized measurement. Without it the result is only
 * protocol_checked. Neither path certifies capture wrapper journal order, deployed decoder quality,
 * speech or production. No media is decoded, normalized, written, played or sent to a provider here.
 */
export function prepareAudioSourceCapture(input: {
  readonly host?: AudioSourceHostV1;
  readonly source: unknown;
  readonly measurement_ref: ArtifactRef;
  readonly use: RightsUse;
}): AudioSourceCheck {
  const host = input.host;
  if (host === undefined) return refused("missing_host");
  let source: AudioSourceV1;
  try {
    source = validateAudioSource(input.source, host.limits);
  } catch {
    return refused("invalid_input");
  }
  // A request provider ID is only a selector; the trusted host separately selects exact contracts.
  try {
    checkAudioProviderContract(host, source, input.use);
  } catch {
    return refused("unsupported_generator");
  }
  try {
    if (!isSpeech(source.role) && source.source_kind !== "voice_studio") {
      checkAudioRights(host, source, input.use);
    } else {
      const rights = checkRights(host, source.media_ref, source.rights_ref, input.use);
      const consent = source.consent_ref;
      if (
        consent === undefined ||
        !["voice", "performer"].includes(rights.subject_kind) ||
        !rights.consent_refs.some((ref) => sameRef(ref, consent)) ||
        !sameRef(rights.provenance_ref, source.provenance_ref)
      )
        return refused("rights_or_consent");
    }
  } catch {
    return refused("rights_or_consent");
  }
  try {
    // WAV-only readback is this slice's supported container, not a new AudioSource union field.
    if (
      source.media_ref.media_type !== "audio/wav" ||
      source.media_ref.byte_length === 0 ||
      source.media_ref.content_schema !== undefined
    )
      return refused("captured_media_or_decode_drift");
    readExact(host.store, host.project_id, source.media_ref, host.limits.max_integer);
    const measurement = validateAudioMeasurement(
      readSemantic({
        ...host,
        ref: input.measurement_ref,
        schema: AudioMeasurementV1Schema,
        schema_id: "penny.videogen-audio-measurement.v1",
      }),
      host.limits
    );
    const duration = rationalTime(
      BigInt(measurement.decoded_sample_count) * BigInt(measurement.sample_rate.denominator),
      BigInt(measurement.sample_rate.numerator)
    );
    if (
      !sameRef(measurement.source_ref, source.media_ref) ||
      !sameRef(measurement.decode_receipt_ref, source.decoded_audio_ref) ||
      measurement.channels !== source.channels ||
      compareTime(duration, source.duration) !== 0 ||
      measurement.sample_rate.numerator !== source.sample_rate.numerator ||
      measurement.sample_rate.denominator !== source.sample_rate.denominator ||
      measurement.track_codecs.length !== 1 ||
      measurement.track_codecs[0] !== "canonical_pcm"
    )
      return refused("captured_media_or_decode_drift");
    // Syntax/readback only: even a completed receipt-shaped artifact is not journal custody proof.
    const receipt = validateHostOperationReceipt(
      readSemantic({
        ...host,
        ref: source.decoded_audio_ref,
        schema: HostOperationReceiptV1Schema,
        schema_id: "penny.host-operation-receipt.v1",
      })
    );
    assertRfc3339Utc(receipt.started_at, "decode receipt start");
    assertRfc3339Utc(receipt.ended_at, "decode receipt end");
    if (
      Date.parse(receipt.started_at) > Date.parse(receipt.ended_at) ||
      Date.parse(receipt.ended_at) > Date.parse(host.now_utc) ||
      receipt.operation_kind !== "media_decode_extract" ||
      receipt.disposition.outcome !== "completed" ||
      receipt.identity.run_id !== source.decoded_audio_ref.run_id
    )
      return refused("captured_media_or_decode_drift");
    const provenance = readSemantic({
      ...host,
      ref: source.provenance_ref,
      schema: ProvenanceBindingV1Schema,
      schema_id: "penny.videogen-provenance-binding.v1",
    });
    if (!sameRef(provenance.subject_ref, source.media_ref))
      return refused("captured_media_or_decode_drift");
    if (host.audio_decode_custody !== undefined) {
      if (!(host.audio_decode_custody instanceof AudioSourceDecodeCustody))
        return refused("captured_media_or_decode_drift");
      host.audio_decode_custody.inspect(host, source, input.measurement_ref);
      return {
        status: "protocol_checked",
        source_admission: "admitted",
        source,
        measurement,
        ...noProduction,
        unverified: [
          "gated_effect_intent_integration",
          "capture_journal_order",
          "decoder_deployment_qualification",
          "speech_playback_and_timing",
        ],
      };
    }
    return {
      status: "protocol_checked",
      source_admission: "unverified",
      source,
      measurement,
      ...noProduction,
      unverified: [
        "decode_receipt_authority",
        "capture_journal_order",
        "speech_playback_and_timing",
      ],
    };
  } catch {
    return refused("captured_media_or_decode_drift");
  }
}

/** Read an existing exact source. Never reconstruct a missing capture or upgrade it to authority. */
export function inspectCapturedAudioSource(input: {
  readonly host: AudioSourceHostV1;
  readonly source_ref: ArtifactRef;
  readonly measurement_ref: ArtifactRef;
  readonly use: RightsUse;
}): CapturedAudioSourceCheck {
  try {
    if (input.source_ref.run_id !== input.host.run_id) return refused("invalid_input");
    const source = readSemantic({
      ...input.host,
      ref: input.source_ref,
      schema: AudioSourceV1Schema,
      schema_id: "penny.videogen-audio-source.v1",
    });
    if (
      [...captureRefs(source), input.measurement_ref].some((ref) => sameRef(ref, input.source_ref))
    )
      return refused("invalid_input");
    // Existing artifact bytes alone cannot establish historical capture-before-receipt ordering.
    const checked = prepareAudioSourceCapture({ ...input, source });
    if (checked.status === "refused") return checked;
    return { ...checked, source_ref: input.source_ref, measurement_ref: input.measurement_ref };
  } catch {
    return refused("invalid_input");
  }
}

const DispositionInputSchema = Type.Object(
  {
    audio_policy: SourceClipAudioPolicySchema,
    source_measurements: Type.Array(AudioMeasurementV1Schema),
    stems: Type.Array(AudioSourceV1Schema),
  },
  closed
);
export type AudioDispositionCheck =
  | { readonly status: "refused"; readonly reason: "invalid_input" | "duplicate_speech" }
  | {
      readonly status: "blocked";
      readonly reason: "source_speech_clearance_unverified" | "mix_gain_and_qc_unverified";
    }
  | { readonly status: "protocol_checked"; readonly required_action: "strip_before_stems" };
/**
 * Pure conservative edit-policy check, NOT clearance or a strip/mix implementation.
 * Measurements are untrusted facts here, never authority. Without qualified track-role/AV evidence,
 * every embedded source track is potential speech. Retain/mix cannot bypass missing clearance/QC.
 */
export function checkSourceClipAudioDisposition(
  value: unknown,
  limits: FoundationLimitsV1
): AudioDispositionCheck {
  try {
    const input = validateFoundation(DispositionInputSchema, value, limits);
    const stems = input.stems.map((source) => validateAudioSource(source, limits));
    const measurements = input.source_measurements.map((m) => validateAudioMeasurement(m, limits));
    assertUnique(
      measurements.map((m) => m.source_ref.artifact_id),
      "source clips"
    );
    const speech = stems.filter((source) => isSpeech(source.role));
    if (new Set(speech.map((s) => s.media_ref.content_digest)).size !== speech.length)
      return { status: "refused", reason: "duplicate_speech" };
    if (input.audio_policy !== "strip_source_audio" && measurements.length > 0 && speech.length > 0)
      return { status: "refused", reason: "duplicate_speech" };
    if (input.audio_policy === "retain_as_sole_speech") {
      if (measurements.length === 0) return { status: "refused", reason: "invalid_input" };
      return { status: "blocked", reason: "source_speech_clearance_unverified" };
    }
    if (input.audio_policy === "mix_with_stems")
      return { status: "blocked", reason: "mix_gain_and_qc_unverified" };
    return { status: "protocol_checked", required_action: "strip_before_stems" };
  } catch {
    return { status: "refused", reason: "invalid_input" };
  }
}

export type VoiceOnlyPolicyCheck = {
  readonly status: "refused" | "blocked";
  readonly reason: "invalid_input" | "nonvoice_stem" | "speech_required" | "speech_proof_missing";
  readonly production_admission: "blocked";
};
/** No signal-energy/fixture/count boolean can attest audible, intelligible or correctly timed speech.
 * Even a well-shaped speech source blocks until qualified decode + exact-target playback/timing.
 * Silent nonempty PCM and invented dialogue labels therefore cannot produce a positive verdict.
 */
export function checkVoiceOnlyProductionAudio(
  value: unknown,
  limits: FoundationLimitsV1
): VoiceOnlyPolicyCheck {
  try {
    const sources = validateFoundation(Type.Array(AudioSourceV1Schema), value, limits).map((s) =>
      validateAudioSource(s, limits)
    );
    if (sources.some((s) => !isSpeech(s.role)))
      return { status: "refused", reason: "nonvoice_stem", production_admission: "blocked" };
    if (sources.length === 0)
      return { status: "refused", reason: "speech_required", production_admission: "blocked" };
    return { status: "blocked", reason: "speech_proof_missing", production_admission: "blocked" };
  } catch {
    return { status: "refused", reason: "invalid_input", production_admission: "blocked" };
  }
}

/** Concrete read-only capability, not an arbitrary evidence callback or qualification issuer.
 * Reuses raw-media custody verbatim. Requires the ALREADY materialized exact full-PCM wrapper
 * before calling its idempotent adopter, so admission cannot write a missing wrapper. No decode,
 * process, scan, journal mutation, receipt signing, playback or production grant occurs here. */
export class AudioSourceDecodeCustody {
  readonly #bindings: MediaEvidenceCustodyBindingsV1;
  readonly #custody: MediaEvidenceCustody;
  constructor(bindings: MediaEvidenceCustodyBindingsV1 & { readonly state_root: string }) {
    const paths = projectStatePaths(pennyStatePaths(bindings.state_root), bindings.project_id);
    if (
      bindings.store.root !== paths.artifacts.root ||
      realpathSync(bindings.store.root) !== paths.artifacts.root ||
      bindings.checkpointer.dbPath !== paths.orchestration.database ||
      realpathSync(bindings.checkpointer.dbPath) !== paths.orchestration.database
    )
      throw new Error("exact canonical audio project store/journal required");
    this.#bindings = {
      ...bindings,
      limits: structuredClone(bindings.limits),
      declaration: structuredClone(bindings.declaration),
      policy_ref: structuredClone(bindings.policy_ref),
    };
    this.#custody = new MediaEvidenceCustody(this.#bindings);
  }
  inspect(host: RightsHostV1, source: AudioSourceV1, measurementRef: ArtifactRef): void {
    const b = this.#bindings;
    if (host.store !== b.store || host.project_id !== b.project_id)
      throw new Error("audio custody host drift");
    const receipt = readSemantic({
      ...host,
      ref: source.decoded_audio_ref,
      schema: HostOperationReceiptV1Schema,
      schema_id: "penny.host-operation-receipt.v1",
    });
    const { record, receiptRef, rawRef, read } = this.#custody.verifySettled(
      receipt.operation_record_id,
      RAW_MEDIA_RESULT_CONTRACT
    );
    if (!sameRef(receiptRef, source.decoded_audio_ref))
      throw new Error("audio receipt journal mismatch");
    const raw = read(
      rawRef,
      RawMediaDecodeResultV1Schema,
      "penny.videogen-raw-media-decode-result.v1"
    );
    // Never enter materialize's video-writing branch, even if an unrelated audio coordinate exists.
    if (raw.video !== null || raw.audio === null || !sameRef(raw.source_ref, source.media_ref))
      throw new Error("audio-only exact source custody required");
    const expected = b.store.refFor(
      record.identity.run_id,
      record.state_id,
      null,
      "videogen-audio-measurement",
      `media-evidence:${record.operation_record_id}:audio-measurement`,
      1
    );
    if (!expected || !sameRef(expected, measurementRef))
      throw new Error("existing exact audio wrapper required");
    const evidence = this.#custody.materialize(record.operation_record_id);
    if (!evidence.audio_measurement_ref || !sameRef(evidence.audio_measurement_ref, measurementRef))
      throw new Error("audio full-source measurement custody");
    // materialize checks the exact raw request/source, policy, full PCM bytes and measurement.
    // Source identity is also compared with the wrapper by prepareAudioSourceCapture.
  }
}
