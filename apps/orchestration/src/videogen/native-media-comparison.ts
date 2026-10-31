import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateSkillSchema, Sha256Schema } from "../skill-contracts/common.js";
import { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import {
  AvProbeSchema,
  AvFramesSchema,
  parseAvJson,
  validateAvDecodeLog,
} from "./av-media-evidence.js";
import { validateMediaPolicy, type MediaDecodePolicyV1 } from "./media-contracts.js";
import type { FoundationLimitsV1 } from "./bounds.js";
import type { AvTrackV1 } from "./av-media-container.js";
import { rationalTime, type RationalRate } from "./rational-time.js";
const closed = { additionalProperties: false } as const;
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const signed = Type.Integer({ minimum: -1024, maximum: Number.MAX_SAFE_INTEGER });
const Skip = Type.Object(
  {
    side_data_type: Type.Literal("Skip Samples"),
    skip_samples: Type.Literal(1024),
    discard_padding: Type.Literal(0),
    skip_reason: Type.Literal(0),
    discard_reason: Type.Literal(0),
  },
  closed
);
const Probe = Type.Object(
  {
    ...AvProbeSchema.properties,
    packets: Type.Array(
      Type.Object(
        {
          ...AvProbeSchema.properties.packets.items.properties,
          pts: signed,
          dts: signed,
          side_data_list: Type.Optional(Type.Array(Skip, { maxItems: 1 })),
        },
        closed
      ),
      { minItems: 2, maxItems: 107657 }
    ),
  },
  closed
);
const Frames = Type.Object(
  {
    frames: Type.Array(
      Type.Object(
        {
          ...AvFramesSchema.properties.frames.items.properties,
          side_data_list: Type.Optional(
            Type.Array(
              Type.Object(
                { side_data_type: Type.Literal("H.26[45] User Data Unregistered SEI message") },
                closed
              ),
              { maxItems: 1 }
            )
          ),
        },
        closed
      ),
      { minItems: 2, maxItems: 107657 }
    ),
  },
  closed
);
export const NativeMediaComparisonV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-media-comparison.v1"),
    schema_version: Type.Literal(1),
    master_sha256: Sha256Schema,
    render_sha256: Sha256Schema,
    decoder_runtime_sha256: Sha256Schema,
    width: positive,
    height: positive,
    video_frames: positive,
    video_timescale: positive,
    video_step: positive,
    audio_samples: positive,
    sample_rate: Type.Literal(48000),
    channels: Type.Literal(1),
    rgba_sha256: Sha256Schema,
    pcm_sha256: Sha256Schema,
    timing_sha256: Sha256Schema,
    status: Type.Literal("exact_full_decode_match"),
  },
  closed
);
export type NativeMediaComparisonV1 = Static<typeof NativeMediaComparisonV1Schema>;
const comparisons = new WeakSet<object>();
function refuse(s: string): never {
  throw new Error(`native comparison: ${s}`);
}
/** Comparison-only profile: explicitly models native MP4 AAC priming/last packet and x264
 * informational SEI. This does NOT relax AV media admission or assert AAC alignment.
 * Every frame and decoded mono s16 sample must be bit-identical, with equal complete PTS.
 * No sampled frames, drift tolerance, transcoding, metadata stripping or audio padding. */
export async function compareNativeMedia(input: {
  readonly runner: ConfinedMediaRunner;
  readonly policy: MediaDecodePolicyV1;
  readonly limits: FoundationLimitsV1;
  readonly master: Buffer;
  readonly render: Buffer;
  readonly width: number;
  readonly height: number;
  readonly frame_rate: RationalRate;
  readonly duration_frames: number;
  readonly signal: AbortSignal;
}): Promise<NativeMediaComparisonV1> {
  if (!ConfinedMediaRunner.isTrusted(input.runner)) refuse("confined CPU runner required");
  const policy = validateMediaPolicy(input.policy);
  const decode = async (bytes: Buffer) => {
    const run = (verb: "av_probe" | "av_frames" | "av_video_rgba" | "av_audio_s16le") =>
      input.runner.run({ verb, bytes, policy, signal: input.signal });
    const probe = parseAvJson(
      Probe,
      (await run("av_probe")).stdout,
      input.limits,
      policy.max_probe_bytes
    );
    const frames = parseAvJson(
      Frames,
      (await run("av_frames")).stdout,
      input.limits,
      policy.max_probe_bytes
    ).frames;
    const v = probe.streams[0],
      a = probe.streams[1];
    if (
      !v ||
      !a ||
      v.index !== 0 ||
      a.index !== 1 ||
      v.codec_name !== "h264" ||
      v.codec_type !== "video" ||
      v.profile !== "Constrained Baseline" ||
      v.has_b_frames !== 0 ||
      v.pix_fmt !== "yuv420p" ||
      v.width !== input.width ||
      v.height !== input.height ||
      v.start_pts !== 0 ||
      a.start_pts !== 0 ||
      a.codec_name !== "aac" ||
      a.codec_type !== "audio" ||
      a.profile !== "LC" ||
      a.sample_fmt !== "fltp" ||
      a.sample_rate !== "48000" ||
      a.channels !== 1 ||
      a.channel_layout !== "mono" ||
      a.time_base !== "1/48000"
    )
      refuse("unsupported native streams/profile");
    for (const s of probe.streams) {
      if (
        Object.entries(s.disposition).some(([k, x]) => x !== (k === "default" ? 1 : 0)) ||
        (s.side_data_list?.length ?? 0)
      )
        refuse("stream disposition/side data");
    }
    const clock = /^1\/([1-9][0-9]*)$/u.exec(v.time_base);
    const scale = Number(clock?.[1]);
    const step = (scale * input.frame_rate.denominator) / input.frame_rate.numerator;
    if (
      !Number.isSafeInteger(scale) ||
      !Number.isSafeInteger(step) ||
      step < 1 ||
      input.duration_frames > policy.max_frames ||
      v.duration_ts !== input.duration_frames * step ||
      Number(v.nb_frames) !== input.duration_frames
    )
      refuse("exact video clock/duration");
    const video = frames.filter((f) => f.media_type === "video"),
      audio = frames.filter((f) => f.media_type === "audio");
    if (
      video.length !== input.duration_frames ||
      !audio.length ||
      video.length + audio.length !== frames.length
    )
      refuse("frame coverage");
    const videoPackets = probe.packets.filter((p) => p.stream_index === 0),
      audioPackets = probe.packets.filter((p) => p.stream_index === 1);
    if (
      videoPackets.length !== video.length ||
      audioPackets.length + videoPackets.length !== probe.packets.length ||
      Number(a.nb_frames) !== audioPackets.length
    )
      refuse("packet coverage");
    const priming = audioPackets[0]?.pts === -1024 ? 1 : 0;
    if (audioPackets.length !== audio.length + priming) refuse("audio priming coverage");
    let audioDuration = 0;
    for (let i = 0; i < audioPackets.length; i++) {
      const p = audioPackets[i];
      if (!p) refuse("missing packet");
      if (
        p.pts !== (i - priming) * 1024 ||
        p.dts !== p.pts ||
        p.duration < 1 ||
        p.duration > 1024 ||
        (i < audioPackets.length - 1 && p.duration !== 1024) ||
        (i === 0 && priming === 1
          ? p.side_data_list?.length !== 1
          : (p.side_data_list?.length ?? 0) !== 0)
      )
        refuse("audio packet clock/skip contract");
      if (i >= priming) audioDuration += p.duration;
    }
    if (a.duration_ts !== audioDuration) refuse("audio container duration");
    const timing: { video: number[]; audio: number[] } = { video: [], audio: [] };
    for (const [list, packets, kind, tick] of [
      [video, videoPackets, "video", step],
      [audio, audioPackets.slice(priming), "audio", 1024],
    ] as const) {
      list.forEach((f, i) => {
        const p = packets[i];
        if (!p) refuse("frame/packet mapping");
        if (
          f.stream_index !== (kind === "video" ? 0 : 1) ||
          (f.pts === undefined && f.pkt_pts === undefined) ||
          (f.pkt_pts !== undefined && f.pkt_pts !== i * tick) ||
          (f.pts !== undefined && f.pts !== i * tick) ||
          f.pkt_dts !== i * tick ||
          f.best_effort_timestamp !== i * tick ||
          f.pkt_duration !== p.duration ||
          f.pkt_pos !== p.pos ||
          f.pkt_size !== p.size ||
          p.pts !== i * tick ||
          p.dts !== p.pts ||
          (kind === "video" &&
            (p.duration !== step ||
              (p.side_data_list?.length ?? 0) ||
              f.width !== input.width ||
              f.height !== input.height ||
              f.pix_fmt !== "yuv420p" ||
              f.interlaced_frame !== 0 ||
              f.repeat_pict !== 0 ||
              !["I", "P"].includes(f.pict_type ?? ""))) ||
          (kind === "audio" &&
            (f.nb_samples !== 1024 ||
              f.channels !== 1 ||
              f.channel_layout !== "mono" ||
              f.sample_fmt !== "fltp" ||
              (f.side_data_list?.length ?? 0)))
        )
          refuse("decoded frame clock/format");
        timing[kind].push(i * tick);
      });
    }
    const samples = audio.length * 1024;
    const videoBytes = input.width * input.height * 4 * video.length,
      audioBytes = samples * 2;
    if (
      !Number.isSafeInteger(videoBytes) ||
      videoBytes + audioBytes > policy.max_decoded_bytes ||
      samples > policy.max_samples
    )
      refuse("full decode bound");
    const vr = await run("av_video_rgba"),
      ar = await run("av_audio_s16le");
    if (vr.stdout.length !== videoBytes || ar.stdout.length !== audioBytes)
      refuse("decoded byte/count mismatch");
    const track = (
      items: typeof frames,
      id: 1 | 2,
      timescale: number,
      stride: number
    ): AvTrackV1 => ({
      id,
      timescale,
      duration_ticks: items.length * stride,
      duration: rationalTime(BigInt(items.length * stride), BigInt(timescale)),
      step: stride,
      samples: items.map((f, i) => ({
        pos: Number(f.pkt_pos),
        size: Number(f.pkt_size),
        pts: i * stride,
        duration: stride,
      })),
    });
    validateAvDecodeLog(vr.stderr, track(video, 1, scale, step), true);
    validateAvDecodeLog(ar.stderr, track(audio, 2, 48000, 1024), false);
    return { rgba: vr.stdout, pcm: ar.stdout, timing, scale, step, samples };
  };
  const master = await decode(input.master),
    render = await decode(input.render);
  if (
    master.scale !== render.scale ||
    master.step !== render.step ||
    master.samples !== render.samples ||
    canonicalJson(master.timing) !== canonicalJson(render.timing) ||
    !master.rgba.equals(render.rgba) ||
    !master.pcm.equals(render.pcm)
  )
    refuse("full frame/sample/timing mismatch");
  const result = Object.freeze(
    validateSkillSchema(
      NativeMediaComparisonV1Schema,
      {
        schema_id: "penny.videogen-native-media-comparison.v1",
        schema_version: 1,
        master_sha256: sha256(input.master),
        render_sha256: sha256(input.render),
        decoder_runtime_sha256: input.runner.runtimeDigest,
        width: input.width,
        height: input.height,
        video_frames: input.duration_frames,
        video_timescale: master.scale,
        video_step: master.step,
        audio_samples: master.samples,
        sample_rate: 48000,
        channels: 1,
        rgba_sha256: sha256(master.rgba),
        pcm_sha256: sha256(master.pcm),
        timing_sha256: sha256(canonicalJson(master.timing)),
        status: "exact_full_decode_match",
      },
      "native comparison"
    )
  );
  comparisons.add(result);
  return result;
}
export function isNativeMediaComparison(value: unknown): value is NativeMediaComparisonV1 {
  return typeof value === "object" && value !== null && comparisons.has(value);
}
