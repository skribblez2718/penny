import { Type, type Static } from "typebox";
import { ArtifactRefSchema, JsonValueSchema } from "../contracts.js";
import { OpaqueIdSchema as Id, Sha256Schema as Digest } from "../skill-contracts/common.js";
import { ExecutionPolicyRefsV1Schema, MeterSchema } from "./foundation-contracts.js";
import { RationalTimeSchema, RationalRateSchema } from "./rational-time.js";
import { mediaArtifactContract } from "./media-contracts.js";

const closed = { additionalProperties: false } as const;
const positive = (maximum = Number.MAX_SAFE_INTEGER) => Type.Integer({ minimum: 1, maximum });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const voiceSemantic = <N extends string>(name: N) => ({
  schema_id: Type.Literal(`penny.videogen-${name}.v1`),
  schema_version: Type.Literal(1),
});
export const VoiceStudioLimitsV1Schema = Type.Object(
  {
    max_text_bytes: positive(2_000_000),
    max_chunks: positive(1000),
    max_json_bytes: positive(16_777_216),
    max_wav_bytes: positive(268_435_456),
    max_sample_bytes: positive(16_777_216),
    max_request_bytes: positive(16_777_216),
    connect_ms: positive(2_147_483_647),
    silence_ms: positive(2_147_483_647),
    poll_ms: positive(2_147_483_647),
    cancel_observations: positive(1000),
  },
  closed
);
export type VoiceStudioLimitsV1 = Static<typeof VoiceStudioLimitsV1Schema>;
/** Private construction-only endpoint. No URL, CA, or address is accepted in a job request. */
export const VoiceStudioTransportV1Schema = Type.Union([
  Type.Object(
    { origin: Type.String({ maxLength: 2048 }), mode: Type.Literal("isolated_loopback") },
    closed
  ),
  Type.Object(
    {
      origin: Type.String({ maxLength: 2048 }),
      mode: Type.Literal("trusted_tls"),
      servername: Type.String({ minLength: 1, maxLength: 253 }),
      ca_pem: Type.String({ minLength: 1, maxLength: 65536 }),
      peer_cert_sha256: Digest,
    },
    closed
  ),
]);
export type VoiceStudioTransportV1 = Static<typeof VoiceStudioTransportV1Schema>;
/** Public projection of PRIVATE host bindings; contains no endpoint or credentials. */
export const VoiceStudioProfileV1Schema = Type.Object(
  {
    ...voiceSemantic("voice-studio-profile"),
    profile_id: Id,
    backend_binding_id: Id,
    process_worker_id: Id,
    gpu_resource_ids: Type.Array(Id, { minItems: 1, maxItems: 16, uniqueItems: true }),
    service_build_ref: ArtifactRefSchema,
    model_sha256: Digest,
    voice_id: Type.String({ pattern: "^[a-f0-9]{12}$" }),
    voice_sha256: Digest,
    sample_sha256: Digest,
    engine: Id,
    media_policy_ref: ArtifactRefSchema,
    limits: VoiceStudioLimitsV1Schema,
  },
  closed
);
export type VoiceStudioProfileV1 = Static<typeof VoiceStudioProfileV1Schema>;
/** Trusted host observation, NOT a service health response or self-issued qualification. */
export const VoiceStudioReadinessV1Schema = Type.Object(
  {
    ...voiceSemantic("voice-studio-readiness"),
    profile_sha256: Digest,
    service_build_ref: ArtifactRefSchema,
    model_sha256: Digest,
    process_worker_id: Id,
    process_epoch: Id,
    engine: Id,
    observed_at_ms: count,
    expires_at_ms: positive(),
    isolation: Type.Union([Type.Literal("isolated_loopback"), Type.Literal("trusted_tls")]),
    external_work: Type.Literal("excluded"),
    synthesis: Type.Literal("model_loaded_and_verified"),
  },
  closed
);
export type VoiceStudioReadinessV1 = Static<typeof VoiceStudioReadinessV1Schema>;
export const VoiceStudioChunkPlanV1Schema = Type.Object(
  {
    ...voiceSemantic("voice-studio-chunk-plan"),
    script_ref: ArtifactRefSchema,
    source_text: Type.String({ minLength: 1, maxLength: 500000 }),
    chunks: Type.Array(
      Type.Object(
        {
          chunk_id: Id,
          line_ids: Type.Array(Id, { minItems: 1, maxItems: 1000, uniqueItems: true }),
          text: Type.String({ minLength: 1, maxLength: 500000 }),
        },
        closed
      ),
      { minItems: 1, maxItems: 1000 }
    ),
  },
  closed
);
export type VoiceStudioChunkPlanV1 = Static<typeof VoiceStudioChunkPlanV1Schema>;
export const VoiceStudioJobRequestV1Schema = Type.Object(
  {
    ...voiceSemantic("voice-job-request"),
    operation_id: Id,
    gate_decision_ref: ArtifactRefSchema,
    selected_ledger_ref: ArtifactRefSchema,
    budget_reservation_ref: ArtifactRefSchema,
    policy_refs: ExecutionPolicyRefsV1Schema,
    limits: Type.Object(
      {
        max_input_bytes: positive(),
        max_output_bytes: positive(),
        max_elapsed_ms: Type.Optional(positive()),
      },
      closed
    ),
    asset_intent_ref: ArtifactRefSchema,
    profile_ref: ArtifactRefSchema,
    script_ref: ArtifactRefSchema,
    script_rights_ref: ArtifactRefSchema,
    chunk_plan_ref: ArtifactRefSchema,
    voice_ref: ArtifactRefSchema,
    voice_rights_ref: ArtifactRefSchema,
    voice_id: Type.String({ pattern: "^[a-f0-9]{12}$" }),
    service_build_ref: ArtifactRefSchema,
    consent_ref: ArtifactRefSchema,
    expected_chunk_ids: Type.Array(Id, { minItems: 1, maxItems: 1000, uniqueItems: true }),
    capture_format: Type.Literal("canonical_pcm"),
    scope: Type.Union([Type.Literal("preview"), Type.Literal("performance")]),
    role: Type.Union([Type.Literal("dialogue"), Type.Literal("narration")]),
    placement: RationalTimeSchema,
  },
  closed
);
export type VoiceStudioJobRequestV1 = Static<typeof VoiceStudioJobRequestV1Schema>;
/** Voice Studio 2.x emits Unix epoch seconds (including fractional seconds), not dates.
 * Preserve the number: stringification/date conversion would change canonical record identity. */
export const VoiceStudioEpochSecondsSchema = Type.Number({ minimum: 0, maximum: 253402300799 });
export const VoiceStudioHealthV1Schema = Type.Object(
  {
    status: Id,
    version: Type.String({ minLength: 1, maxLength: 64 }),
    models_loaded: Type.Boolean(),
    gpu_available: Type.Boolean(),
    engine: Id,
  },
  closed
);
export type VoiceStudioHealthV1 = Static<typeof VoiceStudioHealthV1Schema>;
export const VoiceStudioGpuV1Schema = Type.Object(
  {
    available: Type.Boolean(),
    device_count: Type.Integer({ minimum: 0, maximum: 64 }),
    devices: Type.Array(
      Type.Object(
        {
          id: Type.Integer({ minimum: 0, maximum: 63 }),
          name: Type.String({ maxLength: 256 }),
          free_mb: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          total_mb: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        },
        closed
      ),
      { maxItems: 64 }
    ),
    selected_device: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    vram_used_mb: Type.Union([
      Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      Type.Null(),
    ]),
    vram_total_mb: Type.Union([
      Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      Type.Null(),
    ]),
  },
  closed
);
export type VoiceStudioGpuV1 = Static<typeof VoiceStudioGpuV1Schema>;
export const VoiceStudioVoiceV1Schema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-f0-9]{12}$" }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    source: Id,
    is_builtin: Type.Boolean(),
    meta: Type.Record(Type.String({ maxLength: 256 }), JsonValueSchema),
    created_at: VoiceStudioEpochSecondsSchema,
  },
  closed
);
export type VoiceStudioVoiceV1 = Static<typeof VoiceStudioVoiceV1Schema>;
export const VoiceStudioNarrationV1Schema = Type.Object(
  {
    id: Id,
    title: Type.String({ maxLength: 256 }),
    source_text: Type.String({ maxLength: 500000 }),
    instruct: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
    voice_profile_id: Type.Union([Id, Type.Null()]),
    status: Id,
    created_at: VoiceStudioEpochSecondsSchema,
    chunk_count: Type.Integer({ minimum: 0, maximum: 1000 }),
    char_count: Type.Integer({ minimum: 0, maximum: 500000 }),
  },
  closed
);
export type VoiceStudioNarrationV1 = Static<typeof VoiceStudioNarrationV1Schema>;
export const VoiceStudioJobV1Schema = Type.Object(
  {
    job_id: Id,
    narration_item_id: Id,
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("completed_with_errors"),
      Type.Literal("cancelled"),
      Type.Literal("failed"),
    ]),
    total_chunks: count,
    completed: count,
    errored: count,
    percent: Type.Number({ minimum: 0, maximum: 100 }),
  },
  closed
);
export type VoiceStudioJobV1 = Static<typeof VoiceStudioJobV1Schema>;
export const VoiceStudioCorrelationV1Schema = Type.Object(
  {
    ...voiceSemantic("voice-studio-correlation"),
    request_sha256: Digest,
    profile_sha256: Digest,
    process_epoch: Id,
    job_id: Id,
    narration_item_id: Id,
  },
  closed
);
export type VoiceStudioCorrelationV1 = Static<typeof VoiceStudioCorrelationV1Schema>;
/** Selected by a trusted local collector with access to actual chunk state. HTTP aggregates and
 * SSE audio_path/duration alone cannot populate this record. This module exposes no collector tool. */
export const VoiceStudioCoverageV1Schema = Type.Object(
  {
    ...voiceSemantic("voice-studio-coverage"),
    correlation: VoiceStudioCorrelationV1Schema,
    script_ref: ArtifactRefSchema,
    chunk_plan_ref: ArtifactRefSchema,
    voice_id: Id,
    observed_at_ms: count,
    narration_sha256: Digest,
    chunks: Type.Array(
      Type.Object(
        {
          chunk_id: Id,
          segment_id: Id,
          text_sha256: Digest,
          voice_id: Id,
          resolved_voice_sha256: Digest,
          fallback_used: Type.Literal(false),
          status: Type.Literal("completed"),
          error: Type.Null(),
        },
        closed
      ),
      { minItems: 1, maxItems: 1000 }
    ),
  },
  closed
);
export type VoiceStudioCoverageV1 = Static<typeof VoiceStudioCoverageV1Schema>;
export const VoiceStudioRawResultV1Schema = Type.Object(
  {
    ...voiceSemantic("voice-studio-raw-result"),
    operation_id: Id,
    request_sha256: Digest,
    correlation: VoiceStudioCorrelationV1Schema,
    coverage_ref: ArtifactRefSchema,
    narration: VoiceStudioNarrationV1Schema,
    job: VoiceStudioJobV1Schema,
    wav_sha256: Digest,
    wav_bytes: positive(268_435_456),
    sample_rate: RationalRateSchema,
    channels: Type.Union([Type.Literal("mono"), Type.Literal("stereo")]),
    samples: positive(100_000_000),
    duration: RationalTimeSchema,
    peak_abs_s16: Type.Integer({ minimum: 1, maximum: 32768 }),
    sum_squares: Type.String({ pattern: "^[1-9][0-9]{0,19}$" }),
  },
  closed
);
export type VoiceStudioRawResultV1 = Static<typeof VoiceStudioRawResultV1Schema>;
/** Cache binds original identities/coverage/descriptor AND complete WAV. Never keyed by digest alone. */
export const VoiceStudioCacheV1Schema = Type.Object(
  {
    raw: VoiceStudioRawResultV1Schema,
    wav_base64: Type.String({ minLength: 1, maxLength: 357_913_944 }),
  },
  closed
);
export const VoiceStudioTimingUnavailableV1Schema = Type.Object(
  {
    ...voiceSemantic("voice-studio-timing-unavailable"),
    performance_ref: ArtifactRefSchema,
    script_ref: ArtifactRefSchema,
    source_sample_rate: RationalRateSchema,
    measured_samples: positive(100_000_000),
    uncertain_line_ids: Type.Array(Id, { minItems: 1, uniqueItems: true }),
    alignment: Type.Literal("unavailable"),
    sync_route: Type.Literal("blocked"),
  },
  closed
);
/** Not TimingEvidenceV1: the shared schema requires real utterance/review records. */
export const VoiceStudioAudioEvidenceV1Schema = Type.Object(
  {
    ...voiceSemantic("audio-evidence"),
    audio_ref: ArtifactRefSchema,
    decode_receipt_ref: ArtifactRefSchema,
    codec: Type.Literal("canonical_pcm"),
    channels: Type.Union([Type.Literal("mono"), Type.Literal("stereo")]),
    sample_rate: RationalRateSchema,
    sample_count: positive(100_000_000),
    decoded_duration: RationalTimeSchema,
    peak_dbfs: Type.Number(),
    loudness_lufs: Type.Number(),
    speech_intervals: Type.Array(
      Type.Object({ start: RationalTimeSchema, end: RationalTimeSchema }, closed),
      { maxItems: 0 }
    ),
    script_ref: ArtifactRefSchema,
    chunk_coverage_ref: ArtifactRefSchema,
    sync_offsets: Type.Array(Type.Object({ line_id: Id, offset: RationalTimeSchema }, closed), {
      maxItems: 0,
    }),
    unassessed: Type.Tuple([
      Type.Literal("intelligibility"),
      Type.Literal("identity"),
      Type.Literal("word_alignment"),
    ]),
  },
  closed
);
export const VoiceStudioJobResultV1Schema = Type.Object(
  {
    ...voiceSemantic("voice-job-result"),
    operation_id: Id,
    input_digests: Type.Array(Digest, { minItems: 1, uniqueItems: true }),
    output_refs: Type.Array(ArtifactRefSchema, { minItems: 1 }),
    measured_meters: Type.Array(
      Type.Object(
        {
          meter: MeterSchema,
          unit: Type.Union([
            Type.Literal("ms"),
            Type.Literal("byte"),
            Type.Literal("microcredit"),
            Type.Literal("count"),
          ]),
          amount: count,
        },
        closed
      ),
      { minItems: 1, maxItems: 7 }
    ),
    receipt_ref: ArtifactRefSchema,
    audio_source_ref: ArtifactRefSchema,
    audio_evidence_ref: ArtifactRefSchema,
    timing_ref: Type.Null(),
    timing_unavailable_ref: ArtifactRefSchema,
    job_correlation_ref: ArtifactRefSchema,
    chunk_status_ref: ArtifactRefSchema,
    sync_route: Type.Literal("alignment_unavailable"),
    /** Complete decoded source admission does not grant playback, G2, sync or production.
     * Ordinary nonsync consumers can inspect the source without requiring word alignment. */
    source_admission: Type.Literal("admitted"),
    production_admission: Type.Literal("blocked"),
  },
  closed
);
export type VoiceStudioJobResultV1 = Static<typeof VoiceStudioJobResultV1Schema>;
export const VOICE_STUDIO_REQUEST = mediaArtifactContract("voice_request", "voice-job-request");
export const VOICE_STUDIO_RAW_RESULT = mediaArtifactContract(
  "voice_result",
  "voice-studio-raw-result"
);
export const VOICE_STUDIO_WAV = mediaArtifactContract("complete_wav", "voice-studio-wav");
export const VOICE_STUDIO_ADAPTER_ID = "videogen.voice-studio-adapter.v1";
