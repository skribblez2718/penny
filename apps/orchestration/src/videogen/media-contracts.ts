import { Type, type Static, type TSchema } from "typebox";
import { canonicalJson } from "../canonical-json.js";
import { ArtifactRefSchema, type HostOperationArtifactContractV1 } from "../contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { assertBoundedJson, type FoundationLimitsV1 } from "./bounds.js";
import { RationalTimeSchema, validateRationalTime, compareTime } from "./rational-time.js";

const closed = { additionalProperties: false } as const;
const positive = (maximum: number) => Type.Integer({ minimum: 1, maximum });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const semantic = <N extends string>(name: N) => ({
  schema_id: Type.Literal(`penny.videogen-${name}.v1`),
  schema_version: Type.Literal(1),
});
export const MediaSpanSchema = Type.Object(
  { start: RationalTimeSchema, end: RationalTimeSchema },
  closed
);
/** Host-selected finite policy; these maxima are process-safety ceilings, not deployment defaults. */
export const MediaDecodePolicyV1Schema = Type.Object(
  {
    ...semantic("media-decode-policy"),
    max_input_bytes: positive(268_435_456),
    max_output_bytes: positive(268_435_456),
    max_probe_bytes: positive(16_777_216),
    max_diagnostic_bytes: positive(16_777_216),
    max_width: positive(8192),
    max_height: positive(8192),
    max_pixels: positive(16_777_216),
    max_frames: positive(10_000),
    max_samples: positive(100_000_000),
    max_sample_rate: positive(192_000),
    max_duration: RationalTimeSchema,
    max_spans: positive(128),
    max_selected_frames: positive(512),
    max_boxes: positive(20_000),
    max_decoded_bytes: positive(268_435_456),
    max_elapsed_ms: positive(2_147_483_647),
    inactivity_ms: positive(2_147_483_647),
    cpu_seconds: positive(3600),
    address_space_bytes: positive(17_179_869_184),
    max_processes: positive(4096),
    max_open_files: positive(1024),
    metadata_policy: Type.Literal("baseline_avc_or_pcm_no_unapproved_metadata_v1"),
  },
  closed
);
export type MediaDecodePolicyV1 = Static<typeof MediaDecodePolicyV1Schema>;
export const MediaFrameSelectionV1Schema = Type.Object(
  {
    ...semantic("media-frame-selection"),
    selection_rule_id: Type.Literal("span-boundaries-and-nearest-even-v1"),
    timepoints: Type.Array(RationalTimeSchema, { maxItems: 512 }),
    midpoint_count: Type.Integer({ minimum: 0, maximum: 510 }),
  },
  closed
);
export type MediaFrameSelectionV1 = Static<typeof MediaFrameSelectionV1Schema>;
/** A raw host primitive, deliberately NOT the planned gated EffectIntent operation request. */
export const RawMediaDecodeRequestV1Schema = Type.Object(
  {
    ...semantic("raw-media-decode-request"),
    operation_id: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    }),
    media_ref: ArtifactRefSchema,
    decode_policy_ref: ArtifactRefSchema,
    required_spans: Type.Array(MediaSpanSchema, { minItems: 1, maxItems: 128 }),
    frame_selection_ref: ArtifactRefSchema,
    audio_policy: Type.Union([Type.Literal("forbid"), Type.Literal("measure_pcm")]),
  },
  closed
);
export type RawMediaDecodeRequestV1 = Static<typeof RawMediaDecodeRequestV1Schema>;
const output = Type.Object(
  {
    slot: Type.String({ pattern: "^(frame|pcm)-[0-9]+$" }),
    media_type: Type.Union([Type.Literal("image/png"), Type.Literal("audio/wav")]),
    sha256: digest,
    byte_length: count,
  },
  closed
);
const video = Type.Object(
  {
    codec: Type.Literal("h264"),
    width: positive(8192),
    height: positive(8192),
    decoded_frame_count: positive(10_000),
    time_base: RationalTimeSchema,
    duration: RationalTimeSchema,
    frames: Type.Array(
      Type.Object(
        { index: count, pts: RationalTimeSchema, slot: Type.String({ pattern: "^frame-[0-9]+$" }) },
        closed
      ),
      { maxItems: 512 }
    ),
  },
  closed
);
const audio = Type.Object(
  {
    codec: Type.Literal("canonical_pcm"),
    channels: Type.Union([Type.Literal("mono"), Type.Literal("stereo")]),
    sample_rate: positive(192_000),
    decoded_sample_count: positive(100_000_000),
    duration: RationalTimeSchema,
    spans: Type.Array(
      Type.Object(
        {
          start_sample: count,
          end_sample: count,
          slot: Type.String({ pattern: "^pcm-[0-9]+$" }),
          peak_abs_s16: Type.Integer({ minimum: 0, maximum: 32768 }),
          sum_squares: Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" }),
        },
        closed
      ),
      { maxItems: 128 }
    ),
  },
  closed
);
export const RawMediaDecodeResultV1Schema = Type.Object(
  {
    ...semantic("raw-media-decode-result"),
    operation_id: Type.String({ minLength: 1, maxLength: 256 }),
    source_ref: ArtifactRefSchema,
    request_sha256: digest,
    policy_sha256: digest,
    selection_sha256: digest,
    required_spans: Type.Array(MediaSpanSchema, { minItems: 1, maxItems: 128 }),
    decode_scope: Type.Literal("entire_source_including_preroll"),
    container_policy: Type.Literal("baseline_avc_or_pcm_no_unapproved_metadata_v1"),
    video: Type.Union([video, Type.Null()]),
    audio: Type.Union([audio, Type.Null()]),
    outputs: Type.Array(output, { maxItems: 640 }),
    qualification: Type.Literal("raw_decode_only_not_playback_or_production"),
  },
  closed
);
export type RawMediaDecodeResultV1 = Static<typeof RawMediaDecodeResultV1Schema>;
export const VideoEvidenceV1Schema = Type.Object(
  {
    ...semantic("video-evidence"),
    source_clip_ref: ArtifactRefSchema,
    decode_profile_ref: ArtifactRefSchema,
    container_validation_ref: ArtifactRefSchema,
    full_decode_ref: ArtifactRefSchema,
    frames: Type.Array(
      Type.Object({ index: count, pts: RationalTimeSchema, png_ref: ArtifactRefSchema }, closed),
      { maxItems: 512 }
    ),
    limits: Type.Object(
      {
        max_frames: positive(512),
        max_bytes: positive(268_435_456),
        selection_rule_id: Type.Literal("span-boundaries-and-nearest-even-v1"),
      },
      closed
    ),
    unassessed: Type.Tuple([
      Type.Literal("motion"),
      Type.Literal("speech"),
      Type.Literal("sound"),
      Type.Literal("sync"),
    ]),
  },
  closed
);
export type VideoEvidenceV1 = Static<typeof VideoEvidenceV1Schema>;

/** Bounded canonical JSON parser. Byte limits apply BEFORE UTF-8, JSON and schema decoding. */
export function parseMediaJson<T extends TSchema>(
  schema: T,
  bytes: Uint8Array,
  limits: FoundationLimitsV1
): Static<T> {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.max_json_bytes)
    throw new Error("media JSON byte limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  assertBoundedJson(value, limits);
  const result = validateSkillSchema(schema, value, "media JSON");
  if (canonicalJson(result) !== text) throw new Error("noncanonical or duplicate-key media JSON");
  return result;
}
export function validateMediaPolicy(value: unknown): MediaDecodePolicyV1 {
  const p = validateSkillSchema(MediaDecodePolicyV1Schema, value, "media decode policy");
  validateRationalTime(p.max_duration);
  if (p.max_duration.numerator <= 0 || p.inactivity_ms > p.max_elapsed_ms)
    throw new Error("invalid media duration/inactivity policy");
  return p;
}
export function validateMediaSelection(
  value: unknown,
  policy: MediaDecodePolicyV1
): MediaFrameSelectionV1 {
  const selection = validateSkillSchema(
    MediaFrameSelectionV1Schema,
    value,
    "media frame selection"
  );
  for (const point of selection.timepoints) {
    validateRationalTime(point);
    if (point.numerator < 0 || compareTime(point, policy.max_duration) > 0)
      throw new Error("media selection timepoint bounds");
  }
  if (
    new Set(selection.timepoints.map((point) => canonicalJson(point))).size !==
    selection.timepoints.length
  )
    throw new Error("duplicate media selection timepoint");
  return selection;
}
export function validateMediaRequest(
  value: unknown,
  policy: MediaDecodePolicyV1
): RawMediaDecodeRequestV1 {
  const r = validateSkillSchema(RawMediaDecodeRequestV1Schema, value, "raw media decode request");
  if (
    r.required_spans.length > policy.max_spans ||
    r.media_ref.byte_length < 1 ||
    r.media_ref.byte_length > policy.max_input_bytes
  )
    throw new Error("media input/span limit");
  let last = { numerator: 0, denominator: 1 };
  for (const s of r.required_spans) {
    validateRationalTime(s.start);
    validateRationalTime(s.end);
    if (
      compareTime(s.start, last) < 0 ||
      compareTime(s.start, s.end) >= 0 ||
      compareTime(s.end, policy.max_duration) > 0
    )
      throw new Error("unordered, overlapping or excessive media span");
    last = s.end;
  }
  return r;
}
export function mediaArtifactContract(port: string, name: string): HostOperationArtifactContractV1 {
  return {
    schema_version: 1,
    port_name: port,
    artifact_kind: `videogen-${name}`,
    schema_id: `penny.videogen-${name}.v1`,
    schema_version_required: 1,
  };
}
export const RAW_MEDIA_REQUEST_CONTRACT = mediaArtifactContract(
  "request",
  "raw-media-decode-request"
);
export const RAW_MEDIA_RESULT_CONTRACT = mediaArtifactContract("result", "raw-media-decode-result");
export const MEDIA_FRAME_CONTRACT = mediaArtifactContract("frame", "decoded-frame");
export const MEDIA_PCM_CONTRACT = mediaArtifactContract("pcm", "decoded-pcm");
