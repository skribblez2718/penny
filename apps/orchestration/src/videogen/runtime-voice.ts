import { canonicalJson, sha256 } from "../canonical-json.js";
import type { RunContext } from "../context.js";
import type { VideogenRuntime } from "./runtime.js";
import { SettledEvidenceCustody } from "./settled-evidence-custody.js";
import {
  VoiceApiRawResultSchema,
  VoiceApiCoverageSchema,
  VoiceApiProfileSchema,
  VOICE_API_RAW_RESULT,
} from "./voice-api-contracts.js";
import {
  VoiceStudioJobRequestV1Schema,
  VoiceStudioChunkPlanV1Schema,
} from "./voice-studio-contracts.js";
import { MediaDecodePolicyV1Schema } from "./media-contracts.js";
import { AudioSourceV1Schema, AudioMeasurementV1Schema } from "./audio-sources.js";
import { AudioEvidenceV1Schema } from "./stage-contracts.js";
import { inspectCanonicalPcmWav, measurePcm16 } from "./media-decode.js";
import { sameRef } from "./bounds.js";
import { executionState, setSlot } from "./execution-state.js";
import { VoiceApiCorrelationSchema } from "./voice-api-contracts.js";
/** Normal API producer custody is sufficient for nonsync source use. It never supplies resolved
 * voice identity, word alignment, independent physical exclusion, playback or quality approval. */
export function materializeRuntimeVoice(
  r: VideogenRuntime,
  c: RunContext,
  recordId: string,
  registration: string,
  subject: string
): void {
  const provider = r.providers.effects.get("voice_job"),
    owners = r.providers.host_owners;
  const record = r.checkpointer.hostOperationCall(recordId);
  if (!provider || !owners || !record)
    throw new Error("Voice API concrete settled owners required");
  const custody = new SettledEvidenceCustody({
    project_id: r.project_id,
    store: r.store,
    checkpointer: r.checkpointer,
    leases: owners.leases,
    limits: r.config.limits,
    registration_sha256: registration,
    declaration: provider.declaration,
    backend_key_sha256: record.policy_binding.backend_key_sha256,
  }).verifySettled(recordId, VOICE_API_RAW_RESULT);
  const raw = r.read(custody.rawRef, VoiceApiRawResultSchema),
    request = custody.read(
      record.request_ref,
      VoiceStudioJobRequestV1Schema,
      "penny.videogen-voice-job-request.v1"
    ),
    plan = r.read(request.chunk_plan_ref, VoiceStudioChunkPlanV1Schema),
    profile = r.read(request.profile_ref, VoiceApiProfileSchema),
    coverage = r.read(raw.coverage_ref, VoiceApiCoverageSchema),
    wav = record.output_artifacts[0];
  if (
    !wav ||
    record.output_artifacts.length !== 1 ||
    wav.content_digest !== raw.wav_sha256 ||
    wav.byte_length !== raw.wav_bytes ||
    wav.media_type !== "audio/wav" ||
    raw.operation_id !== record.operation_id ||
    raw.request_sha256 !== record.request_sha256 ||
    raw.correlation.request_sha256 !== record.request_sha256 ||
    raw.correlation.profile_sha256 !== request.profile_ref.content_digest ||
    raw.correlation.backend_binding_id !== profile.backend_binding_id ||
    raw.job.job_id !== raw.correlation.job_id ||
    raw.job.narration_item_id !== raw.correlation.narration_item_id ||
    raw.job.status !== "completed" ||
    raw.job.completed !== raw.job.total_chunks ||
    raw.job.errored !== 0 ||
    raw.job.percent !== 100 ||
    raw.job.completed !== request.expected_chunk_ids.length ||
    !sameRef(coverage.script_ref, request.script_ref) ||
    !sameRef(coverage.chunk_plan_ref, request.chunk_plan_ref) ||
    coverage.request_text !== plan.source_text ||
    coverage.selected_saved_voice.id !== request.voice_id ||
    sha256(canonicalJson(coverage.selected_saved_voice)) !== profile.voice_sha256 ||
    raw.narration.source_text !== plan.source_text ||
    raw.narration.voice_profile_id !== request.voice_id ||
    canonicalJson(coverage.expected_chunk_ids) !== canonicalJson(request.expected_chunk_ids) ||
    canonicalJson(raw.coverage) !== canonicalJson(coverage) ||
    canonicalJson(coverage.narration) !== canonicalJson(raw.narration) ||
    canonicalJson(coverage.job) !== canonicalJson(raw.job) ||
    canonicalJson(coverage.correlation) !== canonicalJson(raw.correlation) ||
    record.remote_correlation_id !== canonicalJson(raw.correlation) ||
    raw.coverage_ref.producer !== "host:videogen-voice-api-observer"
  )
    throw new Error("Voice API exact request/job/output custody drift");
  const pcm = inspectCanonicalPcmWav(
    r.store.read(wav),
    r.read(profile.media_policy_ref, MediaDecodePolicyV1Schema)
  );
  if (
    pcm.samples !== raw.samples ||
    pcm.sample_rate !== raw.sample_rate.numerator ||
    raw.sample_rate.denominator !== 1 ||
    (pcm.channels === 1 ? "mono" : "stereo") !== raw.channels ||
    canonicalJson(measurePcm16(pcm.data)) !==
      canonicalJson({ peak_abs_s16: raw.peak_abs_s16, sum_squares: raw.sum_squares })
  )
    throw new Error("Voice API PCM custody drift");
  const rightsRef = r.inheritRights(
      c,
      wav,
      [request.script_ref, request.voice_ref],
      custody.receiptRef,
      "voice"
    ),
    rights = r.read(rightsRef, RightsBindingV1Schema),
    s = executionState(c);
  const measurement = r.seal(
    c,
    "audio-measurement",
    {
      schema_id: "penny.videogen-audio-measurement.v1",
      schema_version: 1,
      source_ref: wav,
      source_track_ids: ["pcm_track"],
      track_codecs: ["canonical_pcm"],
      decoded_sample_count: pcm.samples,
      sample_rate: raw.sample_rate,
      channels: raw.channels,
      measured_sync_offsets: [],
      decode_receipt_ref: custody.receiptRef,
    },
    [custody.rawRef, custody.receiptRef, wav],
    AudioMeasurementV1Schema
  );
  const source = r.seal(
    c,
    "audio-source",
    {
      schema_id: "penny.videogen-audio-source.v1",
      schema_version: 1,
      source_kind: "voice_studio",
      media_ref: wav,
      rights_ref: rightsRef,
      consent_ref: request.consent_ref,
      role: request.role,
      placement: request.placement,
      duration: raw.duration,
      decoded_audio_ref: custody.receiptRef,
      channels: raw.channels,
      sample_rate: raw.sample_rate,
      codec: "canonical_pcm",
      provenance_ref: rights.provenance_ref,
    },
    [custody.rawRef, custody.receiptRef, raw.coverage_ref, measurement, rightsRef],
    AudioSourceV1Schema
  );
  const evidence = r.seal(
    c,
    "audio-evidence",
    {
      schema_id: "penny.videogen-audio-evidence.v1",
      schema_version: 1,
      audio_ref: wav,
      decode_receipt_ref: custody.receiptRef,
      codec: "canonical_pcm",
      channels: raw.channels,
      sample_rate: raw.sample_rate,
      sample_count: pcm.samples,
      decoded_duration: raw.duration,
      peak_dbfs: 20 * Math.log10(raw.peak_abs_s16 / 32768),
      loudness_lufs: null,
      speech_intervals: [],
      sync_offsets: [],
      unassessed: ["intelligibility", "identity", "word_alignment"],
    },
    [custody.rawRef, custody.receiptRef, raw.coverage_ref, measurement],
    AudioEvidenceV1Schema
  );
  setSlot(c, s, `audio_source-${subject}`, source);
  setSlot(c, s, `audio_measurement-${subject}`, measurement);
  setSlot(c, s, `audio_evidence-${subject}`, evidence);
  setSlot(c, s, `voice_api_coverage-${subject}`, raw.coverage_ref);
  setSlot(c, s, "performance", wav);
  setSlot(
    c,
    s,
    `voice_api_correlation-${subject}`,
    r.seal(
      c,
      "voice-api-correlation",
      raw.correlation,
      [custody.rawRef, custody.receiptRef],
      VoiceApiCorrelationSchema
    )
  );
}
import { RightsBindingV1Schema } from "./rights-ledger.js";
