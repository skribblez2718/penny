import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { HARD_PNG_MEDIA_LIMITS, resolvePngMediaLimits } from "../png-media.js";
import { ArtifactRefSchema } from "../contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import {
  MediaDecodePolicyV1Schema,
  MediaSpanSchema,
  mediaArtifactContract,
  validateMediaPolicy,
  validateMediaRequest,
} from "./media-contracts.js";
import {
  RationalTimeSchema,
  RationalRateSchema,
  validateRationalRate,
  validateRationalTime,
  compareTime,
  rationalTime,
} from "./rational-time.js";

const closed = { additionalProperties: false } as const;
const semantic = <N extends string>(name: N) => ({
  schema_id: Type.Literal(`penny.videogen-${name}.v1`),
  schema_version: Type.Literal(1),
});
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positive = (maximum: number) => Type.Integer({ minimum: 1, maximum });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
/** Host-injected exact raw profile, not a codec/deployment qualification or a size catalog.
 * No profile name selects behavior. All constraints are explicit and digest-bound. */
export const AvMediaProfileV1Schema = Type.Object(
  {
    profile_id: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    }),
    profile_version: Type.Literal(1),
    width: MediaDecodePolicyV1Schema.properties.max_width,
    height: MediaDecodePolicyV1Schema.properties.max_height,
    frame_rate: RationalRateSchema,
    video: Type.Object(
      {
        codec: Type.Literal("h264"),
        profile: Type.Literal("constrained_baseline"),
        pixel_format: Type.Literal("yuv420p"),
        // ISO AVC level_idc values only; this is an exact header constraint, not qualification.
        // Level 1b (constraint_set3) remains unsupported by the existing c0/e0 grammar.
        level_idc: Type.Union([
          Type.Literal(10),
          Type.Literal(11),
          Type.Literal(12),
          Type.Literal(13),
          Type.Literal(20),
          Type.Literal(21),
          Type.Literal(22),
          Type.Literal(30),
          Type.Literal(31),
          Type.Literal(32),
          Type.Literal(40),
          Type.Literal(41),
          Type.Literal(42),
          Type.Literal(50),
          Type.Literal(51),
          Type.Literal(52),
        ]),
      },
      closed
    ),
    audio: Type.Object(
      {
        codec: Type.Literal("aac_lc"),
        sample_rate: Type.Literal(48000),
        channels: Type.Literal(1),
        samples_per_access_unit: Type.Literal(1024),
      },
      closed
    ),
  },
  closed
);
export type AvMediaProfileV1 = Static<typeof AvMediaProfileV1Schema>;
/** Additive authority, never a relaxation of baseline AVC/PCM V1. */
export const AvMediaPolicyV1Schema = Type.Object(
  {
    ...semantic("av-media-policy"),
    limits: MediaDecodePolicyV1Schema,
    profile: AvMediaProfileV1Schema,
    metadata_policy: Type.Literal("closed_nonfragmented_avc_aac_v1"),
    timing_policy: Type.Literal("zero_based_cfr_no_edits_no_composition_untrimmed_aac"),
  },
  closed
);
export type AvMediaPolicyV1 = Static<typeof AvMediaPolicyV1Schema>;
export const AvMediaRequestV1Schema = Type.Object(
  {
    ...semantic("av-media-request"),
    operation_id: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    }),
    media_ref: ArtifactRefSchema,
    decode_policy_ref: ArtifactRefSchema,
    frame_selection_ref: ArtifactRefSchema,
    required_spans: Type.Array(MediaSpanSchema, { minItems: 1, maxItems: 128 }),
    audio_policy: Type.Literal("decode_untrimmed_coded_timeline_not_alignment"),
  },
  closed
);
export type AvMediaRequestV1 = Static<typeof AvMediaRequestV1Schema>;
export const AvMediaResultV1Schema = Type.Object(
  {
    ...semantic("av-media-result"),
    operation_id: Type.String({ minLength: 1, maxLength: 256 }),
    source_ref: ArtifactRefSchema,
    request_sha256: digest,
    policy_sha256: digest,
    selection_sha256: digest,
    required_spans: Type.Array(MediaSpanSchema, { minItems: 1, maxItems: 128 }),
    decode_scope: Type.Literal("entire_exact_muxed_source"),
    container_policy: Type.Literal("closed_nonfragmented_avc_aac_v1"),
    profile: AvMediaProfileV1Schema,
    video: Type.Object(
      {
        stream_index: Type.Literal(0),
        track_id: Type.Literal(1),
        codec: Type.Literal("h264"),
        width: AvMediaProfileV1Schema.properties.width,
        height: AvMediaProfileV1Schema.properties.height,
        time_base: RationalTimeSchema,
        frame_step: positive(0xffffffff),
        decoded_frame_count: MediaDecodePolicyV1Schema.properties.max_frames,
        duration: RationalTimeSchema,
        frames: Type.Array(
          Type.Object(
            {
              index: count,
              pts: RationalTimeSchema,
              slot: Type.String({ pattern: "^frame-[0-9]+$" }),
            },
            closed
          ),
          { minItems: 1, maxItems: 512 }
        ),
      },
      closed
    ),
    audio: Type.Object(
      {
        stream_index: Type.Literal(1),
        track_id: Type.Literal(2),
        source_codec: Type.Literal("aac_lc"),
        codec: Type.Literal("canonical_pcm"),
        sample_rate: Type.Literal(48000),
        channels: Type.Literal("mono"),
        decoded_access_units: MediaDecodePolicyV1Schema.properties.max_samples,
        decoded_sample_count: MediaDecodePolicyV1Schema.properties.max_samples,
        duration: RationalTimeSchema,
        timing: Type.Literal("untrimmed_coded_samples_priming_unknown_no_alignment_claim"),
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
          { minItems: 1, maxItems: 128 }
        ),
      },
      closed
    ),
    outputs: Type.Array(
      Type.Object(
        {
          slot: Type.String({ pattern: "^(frame|pcm)-[0-9]+$" }),
          media_type: Type.Union([Type.Literal("image/png"), Type.Literal("audio/wav")]),
          sha256: digest,
          byte_length: count,
        },
        closed
      ),
      { minItems: 2, maxItems: 640 }
    ),
    qualification: Type.Literal("raw_av_decode_only_not_playback_or_production"),
    unassessed: Type.Tuple([
      Type.Literal("motion"),
      Type.Literal("speech"),
      Type.Literal("intelligibility"),
      Type.Literal("sync"),
      Type.Literal("playback"),
      Type.Literal("aac_ancillary_payloads"),
    ]),
  },
  closed
);
export type AvMediaResultV1 = Static<typeof AvMediaResultV1Schema>;
export const AV_MEDIA_REQUEST_CONTRACT = mediaArtifactContract("request", "av-media-request");
export const AV_MEDIA_RESULT_CONTRACT = mediaArtifactContract("result", "av-media-result");
export function validateAvMediaPolicy(value: unknown): AvMediaPolicyV1 {
  const policy = validateSkillSchema(AvMediaPolicyV1Schema, value, "AV media policy");
  validateMediaPolicy(policy.limits);
  const p = policy.limits,
    profile = policy.profile;
  validateRationalRate(profile.frame_rate);
  if (
    profile.width % 2 ||
    profile.height % 2 ||
    profile.width > p.max_width ||
    profile.height > p.max_height ||
    BigInt(profile.width) * BigInt(profile.height) > BigInt(p.max_pixels) ||
    p.max_sample_rate < profile.audio.sample_rate ||
    p.max_samples < profile.audio.samples_per_access_unit ||
    BigInt(profile.width) * BigInt(profile.height) * 4n + 2048n > BigInt(p.max_decoded_bytes)
  )
    throw new Error("AV profile exceeds dimensions/sample/decoded representation policy");
  // Reduced rates must have at least one uint32 timescale/step representation.
  if (
    profile.frame_rate.numerator > 0xffffffff ||
    profile.frame_rate.denominator > 0xffffffff ||
    compareTime(
      rationalTime(BigInt(profile.frame_rate.denominator), BigInt(profile.frame_rate.numerator)),
      p.max_duration
    ) > 0
  )
    throw new Error("AV rate cannot be represented within container/duration policy");
  return policy;
}
/** Exact uint32 CFR step; no floating-point fps multiplication, rounding or coercion. */
export function avVideoStep(profile: AvMediaProfileV1, timescale: number): number {
  validateRationalRate(profile.frame_rate);
  if (!Number.isSafeInteger(timescale) || timescale < 1 || timescale > 0xffffffff)
    throw new Error("AV container timescale bounds");
  const n = BigInt(timescale) * BigInt(profile.frame_rate.denominator),
    d = BigInt(profile.frame_rate.numerator);
  if (n % d || n / d < 1n || n / d > 0xffffffffn)
    throw new Error("AV CFR step must be integral uint32 ticks");
  return Number(n / d);
}
/** Policy-specific schema shared by the decoder and read-only custody. Static schema above
 * describes safety ceilings only; it is never the authority for a bound result. */
export function avMediaResultSchema(value: AvMediaPolicyV1) {
  const policy = validateAvMediaPolicy(value),
    p = policy.limits;
  const v = AvMediaResultV1Schema.properties.video.properties,
    a = AvMediaResultV1Schema.properties.audio.properties;
  return Type.Object(
    {
      ...AvMediaResultV1Schema.properties,
      profile: Type.Object(
        {
          ...AvMediaProfileV1Schema.properties,
          profile_id: Type.Literal(policy.profile.profile_id),
          width: Type.Literal(policy.profile.width),
          height: Type.Literal(policy.profile.height),
          frame_rate: Type.Object(
            {
              numerator: Type.Literal(policy.profile.frame_rate.numerator),
              denominator: Type.Literal(policy.profile.frame_rate.denominator),
            },
            closed
          ),
          video: Type.Object(
            {
              ...AvMediaProfileV1Schema.properties.video.properties,
              level_idc: Type.Literal(policy.profile.video.level_idc),
            },
            closed
          ),
        },
        closed
      ),
      policy_sha256: Type.Literal(sha256(canonicalJson(policy))),
      required_spans: Type.Array(MediaSpanSchema, { minItems: 1, maxItems: p.max_spans }),
      video: Type.Object(
        {
          ...v,
          width: Type.Literal(policy.profile.width),
          height: Type.Literal(policy.profile.height),
          decoded_frame_count: positive(p.max_frames),
          frames: Type.Array(
            Type.Object(
              {
                ...v.frames.items.properties,
                index: Type.Integer({ minimum: 0, maximum: p.max_frames - 1 }),
              },
              closed
            ),
            { minItems: 1, maxItems: Math.min(p.max_frames, p.max_selected_frames) }
          ),
        },
        closed
      ),
      audio: Type.Object(
        {
          ...a,
          decoded_access_units: positive(Math.floor(p.max_samples / 1024)),
          decoded_sample_count: positive(p.max_samples),
          spans: Type.Array(
            Type.Object(
              {
                ...a.spans.items.properties,
                start_sample: Type.Integer({ minimum: 0, maximum: p.max_samples - 1 }),
                end_sample: positive(p.max_samples),
              },
              closed
            ),
            { minItems: 1, maxItems: p.max_spans }
          ),
        },
        closed
      ),
      outputs: Type.Array(
        Type.Object(
          {
            ...AvMediaResultV1Schema.properties.outputs.items.properties,
            byte_length: positive(p.max_output_bytes),
          },
          closed
        ),
        { minItems: 2, maxItems: p.max_selected_frames + p.max_spans }
      ),
    },
    closed
  );
}
export function validateAvMediaResult(value: unknown, policy: AvMediaPolicyV1): AvMediaResultV1 {
  const r = validateSkillSchema(avMediaResultSchema(policy), value, "policy-bound raw AV result"),
    p = policy.limits;
  validateRationalTime(r.video.time_base);
  if (
    r.video.time_base.numerator !== 1 ||
    r.video.frame_step !== avVideoStep(policy.profile, r.video.time_base.denominator) ||
    r.audio.decoded_sample_count !== r.audio.decoded_access_units * 1024 ||
    compareTime(
      r.video.duration,
      rationalTime(
        BigInt(r.video.frame_step) * BigInt(r.video.decoded_frame_count),
        BigInt(r.video.time_base.denominator)
      )
    ) !== 0 ||
    compareTime(r.audio.duration, rationalTime(BigInt(r.audio.decoded_sample_count), 48000n)) !==
      0 ||
    compareTime(r.video.duration, p.max_duration) > 0 ||
    compareTime(r.audio.duration, p.max_duration) > 0 ||
    BigInt(r.video.width) * BigInt(r.video.height) * 4n * BigInt(r.video.decoded_frame_count) +
      BigInt(r.audio.decoded_sample_count) * 2n >
      BigInt(p.max_decoded_bytes) ||
    BigInt(Buffer.byteLength(canonicalJson(r))) +
      r.outputs.reduce((n, o) => n + BigInt(o.byte_length), 0n) >
      BigInt(p.max_output_bytes)
  )
    throw new Error("AV result timing/count/byte policy mismatch");
  let previousFrame = -1,
    previousSample = 0;
  for (const frame of r.video.frames) {
    if (
      frame.index <= previousFrame ||
      frame.index >= r.video.decoded_frame_count ||
      frame.slot !== `frame-${frame.index}` ||
      compareTime(
        frame.pts,
        rationalTime(
          BigInt(frame.index) * BigInt(r.video.frame_step),
          BigInt(r.video.time_base.denominator)
        )
      ) !== 0
    )
      throw new Error("AV result frame index/PTS coverage");
    previousFrame = frame.index;
  }
  if (r.required_spans.length !== r.audio.spans.length) throw new Error("AV result span coverage");
  for (const [i, span] of r.audio.spans.entries()) {
    const required = r.required_spans[i];
    if (
      !required ||
      span.start_sample < previousSample ||
      span.start_sample >= span.end_sample ||
      span.end_sample > r.audio.decoded_sample_count ||
      span.slot !== `pcm-${i}` ||
      compareTime(required.start, rationalTime(BigInt(span.start_sample), 48000n)) !== 0 ||
      compareTime(required.end, rationalTime(BigInt(span.end_sample), 48000n)) !== 0 ||
      compareTime(required.end, r.video.duration) > 0
    )
      throw new Error("AV result sample/span coverage");
    previousSample = span.end_sample;
  }
  const descriptors = [
    ...r.video.frames.map((f) => ({ slot: f.slot, media_type: "image/png" })),
    ...r.audio.spans.map((s) => ({ slot: s.slot, media_type: "audio/wav" })),
  ];
  if (
    r.outputs.length !== descriptors.length ||
    r.outputs.some(
      (o, i) => o.slot !== descriptors[i]?.slot || o.media_type !== descriptors[i]?.media_type
    )
  )
    throw new Error("AV result output coverage");
  return r;
}
/** Canonical PNG caps come from the same host policy in decode and custody, not image defaults. */
export function avMediaPngLimits(policy: AvMediaPolicyV1) {
  const p = policy.limits;
  return resolvePngMediaLimits(
    {},
    {
      maxWidth: p.max_width,
      maxHeight: p.max_height,
      maxPixels: p.max_pixels,
      maxSourceBytes: Math.min(p.max_output_bytes, HARD_PNG_MEDIA_LIMITS.maxSourceBytes),
      maxCompressedBytes: Math.min(p.max_output_bytes, HARD_PNG_MEDIA_LIMITS.maxCompressedBytes),
      maxDecompressedBytes: Math.min(
        p.max_decoded_bytes,
        HARD_PNG_MEDIA_LIMITS.maxDecompressedBytes
      ),
      maxAncillaryBytes: 1,
      maxAncillaryChunkBytes: 1, // canonical outputs have no ancillary chunks
    }
  );
}
export function validateAvMediaRequest(value: unknown, policy: AvMediaPolicyV1): AvMediaRequestV1 {
  validateAvMediaPolicy(policy);
  const request = validateSkillSchema(AvMediaRequestV1Schema, value, "AV media request");
  // Reuse span/ref resource checks, not the baseline codec admission path.
  validateMediaRequest(
    { ...request, schema_id: "penny.videogen-raw-media-decode-request.v1", audio_policy: "forbid" },
    policy.limits
  );
  if (request.media_ref.media_type !== "video/mp4") throw new Error("AV requires exact muxed MP4");
  for (const [ref, schemaId] of [
    [request.decode_policy_ref, "penny.videogen-av-media-policy.v1"],
    [request.frame_selection_ref, "penny.videogen-media-frame-selection.v1"],
  ] as const) {
    if (
      ref.media_type !== "application/json" ||
      ref.content_schema?.schema_id !== schemaId ||
      ref.content_schema.schema_version !== 1
    )
      throw new Error("AV semantic operand ref schema");
  }
  return request;
}
