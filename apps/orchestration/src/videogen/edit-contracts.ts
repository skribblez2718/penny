import { Type, type Static } from "typebox";
import { ArtifactRefSchema } from "../contracts.js";
import { OpaqueIdSchema as Id, Sha256Schema } from "../skill-contracts/common.js";
import { SourceClipAudioPolicySchema } from "./audio-sources.js";
import { RationalTimeSchema as Time, RationalRateSchema as Rate } from "./rational-time.js";

const closed = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const text = Type.String({ minLength: 1 });
const refs = Type.Array(ArtifactRefSchema, { uniqueItems: true });
const channels = Type.Union([Type.Literal("mono"), Type.Literal("stereo")]);
// The foundation representation is integral. Fractional dB and automation remain unsupported,
// rather than rounding or silently discarding them in a native writer that does not yet exist.
export const GainPointSchema = Type.Object(
  { sample_index: count, gain_db: Type.Integer() },
  closed
);
const gain = Type.Array(GainPointSchema, { minItems: 1 });
export const ClipV1Schema = Type.Object(
  {
    kind: Type.Literal("clip"),
    item_id: Id,
    source_ref: ArtifactRefSchema,
    source_in: Time,
    source_out: Time,
    timeline_start: Time,
    timeline_end: Time,
    speed_map: Type.Optional(
      Type.Array(Type.Object({ source_time: Time, timeline_time: Time }, closed), { minItems: 2 })
    ),
    frame_in: count,
    frame_out: count,
    sample_in: Type.Optional(count),
    sample_out: Type.Optional(count),
    gain_envelope: Type.Optional(gain),
    effect_ids: Type.Array(Id, { uniqueItems: true }),
  },
  closed
);
export const GapV1Schema = Type.Object(
  { kind: Type.Literal("gap"), item_id: Id, timeline_start: Time, timeline_end: Time },
  closed
);
export const CaptionV1Schema = Type.Object(
  {
    kind: Type.Literal("caption"),
    item_id: Id,
    text_source_ref: ArtifactRefSchema,
    language: Id,
    timeline_start: Time,
    timeline_end: Time,
    style_ref: ArtifactRefSchema,
  },
  closed
);
/** A typed extension, deliberately NOT admitted in the base track union. */
export const TransitionV1Schema = Type.Object(
  {
    kind: Type.Literal("transition"),
    from_id: Id,
    to_id: Id,
    span: Type.Object({ start: Time, end: Time }, closed),
    parameters_ref: ArtifactRefSchema,
  },
  closed
);
export const EditDecisionV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-edit-decision.v1"),
    schema_version: Type.Literal(1),
    canvas: Type.Object(
      {
        width: positive,
        height: positive,
        fps: Rate,
        color_space: Id,
        audio_sample_rate: Rate,
        channels,
        video_codec: Id,
        audio_codec: Id,
      },
      closed
    ),
    tracks: Type.Array(
      Type.Object(
        {
          track_id: Id,
          kind: Type.Union([
            Type.Literal("video"),
            Type.Literal("voice"),
            Type.Literal("audio"),
            Type.Literal("caption"),
          ]),
          order: count,
          items: Type.Array(Type.Union([ClipV1Schema, GapV1Schema, CaptionV1Schema]), {
            minItems: 1,
          }),
        },
        closed
      ),
      { minItems: 1 }
    ),
    mix_buses: Type.Array(
      Type.Object(
        {
          bus_id: Id,
          source_track_ids: Type.Array(Id, { minItems: 1, uniqueItems: true }),
          gain_envelope: gain,
          loudness_target_lufs: Type.Integer(),
        },
        closed
      )
    ),
    end_time: Time,
    cut_boundaries: Type.Array(Time),
    effect_registry_refs: refs,
    source_dependency_ledger_ref: ArtifactRefSchema,
    decision_notes_ref: ArtifactRefSchema,
    audio_policy: SourceClipAudioPolicySchema,
  },
  closed
);
export type EditDecisionV1 = Static<typeof EditDecisionV1Schema>;
export type ClipV1 = Static<typeof ClipV1Schema>;

/** Host-internal measured fact record, not a decode receipt or interoperability certificate. */
export const MeasuredEditSourceV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-edit-source.v1"),
    schema_version: Type.Literal(1),
    source_ref: ArtifactRefSchema,
    measured_ticks: positive,
    timebase: Time,
    decoded_duration: Time,
    source_frame_rate: Rate,
    decode_record_ref: ArtifactRefSchema,
    audio_measurement_ref: Type.Optional(ArtifactRefSchema),
    transformation_ref: Type.Optional(ArtifactRefSchema),
  },
  closed
);
export type MeasuredEditSourceV1 = Static<typeof MeasuredEditSourceV1Schema>;
export const EditReviewBindingV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-review-binding.v1"),
    schema_version: Type.Literal(1),
    worker_result_ref: ArtifactRefSchema,
    target_ref: ArtifactRefSchema,
    evidence_refs: refs,
    model_capability_ref: ArtifactRefSchema,
    disposition: Type.Union([
      Type.Literal("pass"),
      Type.Literal("repair"),
      Type.Literal("blocked"),
    ]),
  },
  closed
);
/** Original and processed bytes stay separate. These prior records do not certify review authority. */
export const EditTransformationV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-edit-transformation.v1"),
    schema_version: Type.Literal(1),
    original_ref: ArtifactRefSchema,
    processed_ref: ArtifactRefSchema,
    kind: Type.Union([
      Type.Literal("normalize"),
      Type.Literal("grade"),
      Type.Literal("interpolate"),
      Type.Literal("upscale"),
    ]),
    parameters_ref: ArtifactRefSchema,
    measurement_ref: ArtifactRefSchema,
    review_binding_ref: ArtifactRefSchema,
  },
  closed
);
export type EditTransformationV1 = Static<typeof EditTransformationV1Schema>;
/** Inert caption/font intent; no template, filter, XML, URL or executable style input. */
export const EditCaptionStyleV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-edit-caption-style.v1"),
    schema_version: Type.Literal(1),
    font_ref: ArtifactRefSchema,
    size_px: positive,
    color_rgba: Type.String({ pattern: "^[0-9a-f]{8}$" }),
  },
  closed
);
export const EditFeatureSubsetV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-edit-feature-subset.v1"),
    schema_version: Type.Literal(1),
    features: Type.Array(
      Type.Union([
        Type.Literal("hard_cuts"),
        Type.Literal("ordered_clips"),
        Type.Literal("trims"),
        Type.Literal("gaps"),
        Type.Literal("voice_gain"),
        Type.Literal("captions"),
      ]),
      { minItems: 1, uniqueItems: true }
    ),
  },
  closed
);
/** Persist separately through the canonical owner, never add a self digest to EditDecisionV1. */
export const EditQuantizationV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-edit-quantization.v1"),
    schema_version: Type.Literal(1),
    edit_ref: ArtifactRefSchema,
    total_frames: count,
    total_samples: count,
    boundaries: Type.Array(
      Type.Object(
        {
          item_id: Id,
          frame_in: count,
          frame_out: count,
          sample_in: count,
          sample_out: count,
          frame_residuals: Type.Array(Time, { minItems: 2, maxItems: 2 }),
          sample_residuals: Type.Array(Time, { minItems: 2, maxItems: 2 }),
        },
        closed
      )
    ),
  },
  closed
);
export type EditQuantizationV1 = Static<typeof EditQuantizationV1Schema>;

const role = Type.Union([
  Type.Literal("original_video"),
  Type.Literal("original_audio"),
  Type.Literal("voice_stem"),
  Type.Literal("reference"),
  Type.Literal("reference_revision"),
  Type.Literal("script"),
  Type.Literal("caption_source"),
  Type.Literal("title_asset"),
  Type.Literal("proxy"),
  Type.Literal("license"),
  Type.Literal("credit"),
  Type.Literal("provenance"),
  Type.Literal("documentation"),
  Type.Literal("project"),
  Type.Literal("master"),
]);
export const PortableManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-portable-package.v1"),
    schema_version: Type.Literal(1),
    package_id: Id,
    accepted_master: Type.Object(
      { relative_path: text, sha256: Sha256Schema, bytes: count, format: Id, duration: Time },
      closed
    ),
    native_project: Type.Object(
      {
        relative_path: text,
        sha256: Sha256Schema,
        bytes: count,
        kdenlive_version: text,
        mlt_version: text,
      },
      closed
    ),
    edit_decision_ref: ArtifactRefSchema,
    files: Type.Array(
      Type.Object(
        {
          relative_path: text,
          role,
          sha256: Sha256Schema,
          bytes: count,
          media_type: text,
          producer_ref: ArtifactRefSchema,
          license_ref: Type.Optional(ArtifactRefSchema),
          used_by: Type.Array(Id, { uniqueItems: true }),
        },
        closed
      ),
      { minItems: 1 }
    ),
    reference_graph: Type.Array(Type.Object({ from: text, to: text }, closed)),
    clip_to_timeline: Type.Array(
      Type.Object({ clip_id: Id, track_id: Id, start: Time, end: Time }, closed)
    ),
    rights_ledger_ref: ArtifactRefSchema,
    credits_ref: ArtifactRefSchema,
    provenance_ref: ArtifactRefSchema,
    environment: Type.Object(
      {
        editor_build: Id,
        mlt_build: Id,
        os_arch: Id,
        decoder_build: Id,
        encoder_build: Id,
        dependencies: Type.Array(
          Type.Object({ id: Id, digest: Sha256Schema, packaged: Type.Boolean() }, closed)
        ),
        config_digest: Sha256Schema,
      },
      closed
    ),
    feature_subset_ref: ArtifactRefSchema,
    known_losses: Type.Array(text),
    instructions_relative_path: text,
  },
  closed
);
export type PortableManifestV1 = Static<typeof PortableManifestV1Schema>;
export const PortablePackageManifestV1Schema = PortableManifestV1Schema;
export type PortablePackageManifestV1 = PortableManifestV1;
