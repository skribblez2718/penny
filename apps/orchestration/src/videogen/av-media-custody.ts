import { realpathSync } from "node:fs";
import { canonicalJson } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { validateCanonicalPng } from "../png-media.js";
import { pennyStatePaths, projectStatePaths } from "../state/paths.js";
import { readExact, sameRef } from "./bounds.js";
import {
  AvMediaPolicyV1Schema,
  AvMediaRequestV1Schema,
  avMediaResultSchema,
  avMediaPngLimits,
  validateAvMediaResult,
  AV_MEDIA_RESULT_CONTRACT,
  validateAvMediaPolicy,
  validateAvMediaRequest,
} from "./av-media-contracts.js";
import { avRefuse, inspectAvMediaMp4 } from "./av-media-container.js";
import { avSampleIndex } from "./av-media-decode.js";
import { MediaFrameSelectionV1Schema, validateMediaSelection } from "./media-contracts.js";
import { inspectCanonicalPcmWav, measurePcm16, selectMediaFrames } from "./media-decode.js";
import { MediaEvidenceCustody, type MediaEvidenceCustodyBindingsV1 } from "./media-evidence.js";
import { compareTime, rationalTime } from "./rational-time.js";

export interface AvMediaCustodyBindingsV1 extends MediaEvidenceCustodyBindingsV1 {
  readonly state_root: string;
}
function eq(a: unknown, b: unknown, reason: string): void {
  if (canonicalJson(a) !== canonicalJson(b)) avRefuse(`custody ${reason}`);
}
/** Read-only AV custody projection. Takes the original store/checkpointer/lease authority;
 * never opens, provisions, reconstructs or signs anything. Explicit canonical project paths
 * prevent a same-project shadow artifact store from becoming another evidence authority.
 * No AudioMeasurement wrapper: AAC encoder delay is unknown and used spans are NOT a performance. */
export class AvMediaCustody {
  private readonly b: AvMediaCustodyBindingsV1;
  private readonly shared: MediaEvidenceCustody;
  constructor(bindings: AvMediaCustodyBindingsV1) {
    const paths = projectStatePaths(pennyStatePaths(bindings.state_root), bindings.project_id);
    if (
      bindings.store.root !== paths.artifacts.root ||
      realpathSync(bindings.store.root) !== paths.artifacts.root ||
      bindings.checkpointer.dbPath !== paths.orchestration.database ||
      realpathSync(bindings.checkpointer.dbPath) !== paths.orchestration.database
    )
      avRefuse("exact canonical project store/journal required");
    this.b = {
      ...bindings,
      limits: structuredClone(bindings.limits),
      declaration: structuredClone(bindings.declaration),
      policy_ref: structuredClone(bindings.policy_ref),
    };
    this.shared = new MediaEvidenceCustody(this.b);
  }
  inspect(operationRecordId: string) {
    const b = this.b;
    const { record, rawRef, receiptRef, plan, read } = this.shared.verifySettled(
      operationRecordId,
      AV_MEDIA_RESULT_CONTRACT
    );
    const request = read(
      record.request_ref,
      AvMediaRequestV1Schema,
      "penny.videogen-av-media-request.v1"
    );
    if (!sameRef(b.policy_ref, request.decode_policy_ref)) avRefuse("custody current policy");
    const policy = validateAvMediaPolicy(
      read(b.policy_ref, AvMediaPolicyV1Schema, "penny.videogen-av-media-policy.v1")
    );
    const raw = validateAvMediaResult(
      read(rawRef, avMediaResultSchema(policy), "penny.videogen-av-media-result.v1"),
      policy
    );
    validateAvMediaRequest(request, policy);
    const selection = validateMediaSelection(
      read(
        request.frame_selection_ref,
        MediaFrameSelectionV1Schema,
        "penny.videogen-media-frame-selection.v1"
      ),
      policy.limits
    );
    eq(
      record.input_artifacts.artifacts,
      [
        { slot: "media", ref: request.media_ref },
        { slot: "decode-policy", ref: request.decode_policy_ref },
        { slot: "frame-selection", ref: request.frame_selection_ref },
      ],
      "input slots"
    );
    if (
      !sameRef(raw.source_ref, request.media_ref) ||
      raw.request_sha256 !== record.request_sha256 ||
      raw.operation_id !== record.operation_id ||
      request.operation_id !== record.operation_id ||
      raw.policy_sha256 !== b.policy_ref.content_digest ||
      raw.selection_sha256 !== request.frame_selection_ref.content_digest
    )
      avRefuse("custody source/operation operands");
    eq(raw.required_spans, request.required_spans, "spans");
    eq(plan.disposition, record.disposition, "plan outcome");
    const layout = inspectAvMediaMp4(
      readExact(b.store, b.project_id, raw.source_ref, policy.limits.max_input_bytes),
      policy
    );
    if (
      request.required_spans.some(
        (s) =>
          compareTime(s.end, layout.video.duration) > 0 ||
          compareTime(s.end, layout.audio.duration) > 0
      )
    )
      avRefuse("custody span exceeds decoded track");
    if (
      BigInt(layout.video.samples.length) * BigInt(layout.width) * BigInt(layout.height) * 4n +
        BigInt(layout.audio.samples.length) * 2048n >
      BigInt(policy.limits.max_decoded_bytes)
    )
      avRefuse("custody decoded aggregate limit");
    const { frames, ...video } = raw.video,
      { spans, ...audio } = raw.audio;
    eq(
      video,
      {
        stream_index: 0,
        track_id: 1,
        codec: "h264",
        width: layout.width,
        height: layout.height,
        time_base: rationalTime(1n, BigInt(layout.video.timescale)),
        frame_step: layout.video.step,
        decoded_frame_count: layout.video.samples.length,
        duration: layout.video.duration,
      },
      "video summary"
    );
    eq(
      audio,
      {
        stream_index: 1,
        track_id: 2,
        source_codec: "aac_lc",
        codec: "canonical_pcm",
        sample_rate: 48000,
        channels: "mono",
        decoded_access_units: layout.audio.samples.length,
        decoded_sample_count: layout.audio.samples.length * 1024,
        duration: layout.audio.duration,
        timing: "untrimmed_coded_samples_priming_unknown_no_alignment_claim",
      },
      "audio summary"
    );
    const pts = layout.video.samples.map((s) =>
      rationalTime(BigInt(s.pts), BigInt(layout.video.timescale))
    );
    const chosen = selectMediaFrames(
      pts,
      request.required_spans,
      selection,
      policy.limits.max_selected_frames
    );
    eq(
      frames,
      chosen.map((index) => ({ index, pts: pts[index], slot: `frame-${index}` })),
      "rational selected frame coverage"
    );
    if (
      spans.length !== request.required_spans.length ||
      raw.outputs.length !== frames.length + spans.length ||
      record.output_artifacts.length !== raw.outputs.length ||
      plan.outputs.length !== raw.outputs.length ||
      new Set(raw.outputs.map((o) => o.slot)).size !== raw.outputs.length
    )
      avRefuse("custody output coverage");
    const refs = [rawRef, ...record.output_artifacts],
      plans = [plan.operation_result, ...plan.outputs];
    if (refs.reduce((n, r) => n + r.byte_length, 0) > policy.limits.max_output_bytes)
      avRefuse("custody output byte policy");
    refs.forEach((ref, i) => {
      const p = plans[i];
      if (
        !p ||
        ref.content_digest !== p.content_sha256 ||
        ref.byte_length !== p.byte_length ||
        ref.kind !== p.artifact_kind ||
        ref.media_type !== p.media_type ||
        ref.content_schema?.schema_id !== p.schema_id ||
        ref.content_schema.schema_version !== p.schema_version_required ||
        ref.operation_id !== p.operation_id ||
        ref.version !== p.version ||
        ref.producer !== `host:${b.declaration.adapter_id}` ||
        ref.run_id !== record.identity.run_id ||
        ref.phase !== record.state_id
      )
        avRefuse("custody raw persistence plan");
    });
    const outputRef = (i: number, slot: string, media: string): ArtifactRef => {
      const d = raw.outputs[i],
        ref = record.output_artifacts[i];
      if (
        !d ||
        !ref ||
        d.slot !== slot ||
        d.media_type !== media ||
        d.sha256 !== ref.content_digest ||
        d.byte_length !== ref.byte_length ||
        ref.media_type !== media
      )
        avRefuse("custody descriptor order/digest");
      return ref;
    };
    const frameRefs = frames.map((frame, i) => {
      const ref = outputRef(i, frame.slot, "image/png");
      const info = validateCanonicalPng(
        readExact(b.store, b.project_id, ref, policy.limits.max_output_bytes),
        avMediaPngLimits(policy)
      );
      if (info.width !== layout.width || info.height !== layout.height)
        avRefuse("custody canonical PNG dimensions");
      return { ...frame, png_ref: ref };
    });
    const pcmRefs = spans.map((span, i) => {
      const s = request.required_spans[i];
      if (!s) avRefuse("custody span absent");
      eq(
        [span.start_sample, span.end_sample, span.slot],
        [
          avSampleIndex(s.start.numerator, s.start.denominator, raw.audio.decoded_sample_count),
          avSampleIndex(s.end.numerator, s.end.denominator, raw.audio.decoded_sample_count),
          `pcm-${i}`,
        ],
        "sample ranges"
      );
      const ref = outputRef(frames.length + i, span.slot, "audio/wav");
      const pcm = inspectCanonicalPcmWav(
        readExact(b.store, b.project_id, ref, policy.limits.max_output_bytes),
        { ...policy.limits, max_input_bytes: policy.limits.max_output_bytes }
      );
      if (
        pcm.channels !== 1 ||
        pcm.sample_rate !== 48000 ||
        pcm.samples !== span.end_sample - span.start_sample
      )
        avRefuse("custody canonical PCM range");
      eq(
        measurePcm16(pcm.data),
        { peak_abs_s16: span.peak_abs_s16, sum_squares: span.sum_squares },
        "PCM measurements"
      );
      return { ...span, pcm_ref: ref };
    });
    return {
      raw_ref: rawRef,
      receipt_ref: receiptRef,
      result: raw,
      frames: frameRefs,
      pcm_spans: pcmRefs,
      production_admission: "blocked" as const,
      missing_qualification: [
        "gated_effect_intent_integration",
        "independent_playback_motion_speech_sync",
        "decoder_deployment_qualification",
        "AAC_priming_and_alignment_unknown",
        "AAC_ancillary_payload_metadata_unqualified",
      ] as const,
    };
  }
}
