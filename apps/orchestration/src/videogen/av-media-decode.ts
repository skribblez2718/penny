import { canonicalJson, sha256 } from "../canonical-json.js";
import { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import { encodeCanonicalPng, validateCanonicalPng } from "../png-media.js";
import type { FoundationLimitsV1 } from "./bounds.js";
import {
  validateAvMediaResult,
  avMediaPngLimits,
  validateAvMediaPolicy,
  validateAvMediaRequest,
  type AvMediaPolicyV1,
  type AvMediaRequestV1,
  type AvMediaResultV1,
} from "./av-media-contracts.js";
import { avRefuse, inspectAvMediaMp4 } from "./av-media-container.js";
import {
  AvProbeSchema,
  AvFramesSchema,
  parseAvJson,
  validateAvProbe,
  validateAvFrames,
  validateAvDecodeLog,
} from "./av-media-evidence.js";
import { validateMediaSelection, type MediaFrameSelectionV1 } from "./media-contracts.js";
import { canonicalPcmWav, measurePcm16, selectMediaFrames } from "./media-decode.js";
import { compareTime, rationalTime } from "./rational-time.js";

export interface DecodedAvMediaV1 {
  readonly result: AvMediaResultV1;
  readonly outputs: readonly {
    readonly slot: string;
    readonly media_type: "image/png" | "audio/wav";
    readonly bytes: Uint8Array;
  }[];
}
export function avSampleIndex(numerator: number, denominator: number, cap: number): number {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    !Number.isSafeInteger(cap) ||
    cap < 1
  )
    avRefuse("safe integer sample grid required");
  const n = BigInt(numerator) * 48000n,
    d = BigInt(denominator);
  if (d <= 0n || n < 0n || n % d || n / d > BigInt(cap))
    avRefuse("span boundary not on exact AAC decoded sample grid");
  return Number(n / d);
}
/** Bounded raw decoding only. Exact source is never normalized, rewritten or silently trimmed.
 * No edit lists, negative PTS, ctts, reordering, partial AAC units or skip side data are supported.
 * Absence of priming metadata means UNKNOWN priming, not zero delay or synchronized speech.
 * AAC DSE/FIL ancillary-payload absence is NOT established by the codec decoder. This remains
 * unassessed, blocks strict production admission, and must not be promoted to metadata clearance. */
export async function decodeAvMediaBytes(input: {
  readonly runner: ConfinedMediaRunner;
  readonly request: AvMediaRequestV1;
  readonly bytes: Uint8Array;
  readonly policy: AvMediaPolicyV1;
  readonly selection: MediaFrameSelectionV1;
  readonly limits: FoundationLimitsV1;
  readonly signal: AbortSignal;
}): Promise<DecodedAvMediaV1> {
  if (!ConfinedMediaRunner.isTrusted(input.runner)) avRefuse("concrete confined runner required");
  const policy = validateAvMediaPolicy(structuredClone(input.policy)),
    p = policy.limits;
  const request = validateAvMediaRequest(structuredClone(input.request), policy);
  const selection = validateMediaSelection(structuredClone(input.selection), p);
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > p.max_input_bytes)
    avRefuse("input byte limit");
  const bytes = Buffer.from(input.bytes);
  if (
    sha256(canonicalJson(policy)) !== request.decode_policy_ref.content_digest ||
    Buffer.byteLength(canonicalJson(policy)) !== request.decode_policy_ref.byte_length ||
    sha256(canonicalJson(selection)) !== request.frame_selection_ref.content_digest ||
    Buffer.byteLength(canonicalJson(selection)) !== request.frame_selection_ref.byte_length ||
    bytes.length !== request.media_ref.byte_length ||
    sha256(bytes) !== request.media_ref.content_digest
  )
    avRefuse("source/request/policy/selection digest drift");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(p.max_elapsed_ms)]);
  signal.throwIfAborted();
  const layout = inspectAvMediaMp4(bytes, policy),
    v = layout.video,
    a = layout.audio;
  for (const span of request.required_spans)
    if (compareTime(span.end, v.duration) > 0 || compareTime(span.end, a.duration) > 0)
      avRefuse("span exceeds one decoded track");
  const samples = a.samples.length * 1024,
    videoBytes = layout.width * layout.height * 4 * v.samples.length,
    audioBytes = samples * 2;
  if (BigInt(videoBytes) + BigInt(audioBytes) > BigInt(p.max_decoded_bytes))
    avRefuse("aggregate decoded representation limit");
  const pts = v.samples.map((s) => rationalTime(BigInt(s.pts), BigInt(v.timescale)));
  const selected = selectMediaFrames(pts, request.required_spans, selection, p.max_selected_frames);
  // Validate all sample boundaries before any decoder is started.
  const spans = request.required_spans.map((s) => ({
    start: avSampleIndex(s.start.numerator, s.start.denominator, samples),
    end: avSampleIndex(s.end.numerator, s.end.denominator, samples),
  }));
  const pngLimits = avMediaPngLimits(policy);
  const scanlineBytes = BigInt(layout.height) * (BigInt(layout.width) * 4n + 1n);
  // zlib compressBound for the fixed canonical PNG encoder, plus its 57-byte framing.
  const pngBound =
    scanlineBytes +
    (scanlineBytes >> 12n) +
    (scanlineBytes >> 14n) +
    (scanlineBytes >> 25n) +
    13n +
    57n;
  const pcmBytes = spans.reduce((n, s) => n + BigInt(s.end - s.start) * 2n + 44n, 0n);
  if (
    scanlineBytes > BigInt(pngLimits.maxDecompressedBytes) ||
    pngBound > BigInt(pngLimits.maxSourceBytes) ||
    BigInt(selected.length) * pngBound + pcmBytes + BigInt(input.limits.max_json_bytes) >
      BigInt(p.max_output_bytes)
  )
    avRefuse("predecode canonical output byte reservation limit");
  const run = (verb: Parameters<ConfinedMediaRunner["run"]>[0]["verb"]) =>
    input.runner.run({ verb, bytes, policy: p, signal });
  const probe = await run("av_probe");
  if (probe.stderr.length) avRefuse("probe decode diagnostics");
  validateAvProbe(
    parseAvJson(AvProbeSchema, probe.stdout, input.limits, p.max_probe_bytes),
    layout
  );
  const frames = await run("av_frames");
  if (frames.stderr.length) avRefuse("full frame decode diagnostics");
  validateAvFrames(
    parseAvJson(AvFramesSchema, frames.stdout, input.limits, p.max_probe_bytes),
    layout
  );
  const video = await run("av_video_rgba");
  if (video.stdout.length !== videoBytes) avRefuse("complete RGBA decoded byte count");
  validateAvDecodeLog(video.stderr, v, true);
  const audio = await run("av_audio_s16le");
  if (audio.stdout.length !== audioBytes) avRefuse("complete AAC decoded sample/byte count");
  validateAvDecodeLog(audio.stderr, a, false);
  const outputs: { slot: string; media_type: "image/png" | "audio/wav"; bytes: Uint8Array }[] = [];
  const pictures = selected.map((index) => {
    signal.throwIfAborted();
    const slot = `frame-${index}`;
    const png = encodeCanonicalPng({
      width: layout.width,
      height: layout.height,
      rgba: video.stdout.subarray(
        index * layout.width * layout.height * 4,
        (index + 1) * layout.width * layout.height * 4
      ),
      limits: pngLimits,
    });
    validateCanonicalPng(png, pngLimits);
    outputs.push({ slot, media_type: "image/png", bytes: png });
    return { index, pts: pts[index] ?? avRefuse("selected PTS absent"), slot };
  });
  const pcm = spans.map((s, i) => {
    signal.throwIfAborted();
    const slot = `pcm-${i}`,
      data = audio.stdout.subarray(s.start * 2, s.end * 2);
    outputs.push({ slot, media_type: "audio/wav", bytes: canonicalPcmWav(data, 1, 48000) });
    return { start_sample: s.start, end_sample: s.end, slot, ...measurePcm16(data) };
  });
  const result = validateAvMediaResult(
    {
      schema_id: "penny.videogen-av-media-result.v1",
      schema_version: 1,
      operation_id: request.operation_id,
      source_ref: request.media_ref,
      request_sha256: sha256(canonicalJson(request)),
      policy_sha256: request.decode_policy_ref.content_digest,
      selection_sha256: request.frame_selection_ref.content_digest,
      required_spans: request.required_spans,
      decode_scope: "entire_exact_muxed_source",
      container_policy: policy.metadata_policy,
      profile: policy.profile,
      video: {
        stream_index: 0,
        track_id: 1,
        codec: "h264",
        width: layout.width,
        height: layout.height,
        time_base: rationalTime(1n, BigInt(v.timescale)),
        frame_step: v.step,
        decoded_frame_count: v.samples.length,
        duration: v.duration,
        frames: pictures,
      },
      audio: {
        stream_index: 1,
        track_id: 2,
        source_codec: "aac_lc",
        codec: "canonical_pcm",
        sample_rate: 48000,
        channels: "mono",
        decoded_access_units: a.samples.length,
        decoded_sample_count: samples,
        duration: a.duration,
        timing: "untrimmed_coded_samples_priming_unknown_no_alignment_claim",
        spans: pcm,
      },
      outputs: outputs.map((o) => ({
        slot: o.slot,
        media_type: o.media_type,
        sha256: sha256(o.bytes),
        byte_length: o.bytes.length,
      })),
      qualification: "raw_av_decode_only_not_playback_or_production",
      unassessed: [
        "motion",
        "speech",
        "intelligibility",
        "sync",
        "playback",
        "aac_ancillary_payloads",
      ],
    },
    policy
  );
  if (
    Buffer.byteLength(canonicalJson(result)) > input.limits.max_json_bytes ||
    Buffer.byteLength(canonicalJson(result)) + outputs.reduce((n, o) => n + o.bytes.length, 0) >
      p.max_output_bytes
  )
    avRefuse("result/output aggregate byte limit");
  signal.throwIfAborted();
  return { result, outputs };
}
