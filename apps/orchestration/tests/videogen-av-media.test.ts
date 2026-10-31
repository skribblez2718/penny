import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  AvMediaRequestV1Schema,
  AvMediaPolicyV1Schema,
  avVideoStep,
  validateAvMediaResult,
  avMediaPngLimits,
  type AvMediaResultV1,
  validateAvMediaPolicy,
  validateAvMediaRequest,
} from "../dist/videogen/av-media-contracts.js";
import { avSampleIndex, decodeAvMediaBytes } from "../dist/videogen/av-media-decode.js";
import {
  AvProbeSchema,
  AvFramesSchema,
  parseAvJson,
  validateAvProbe,
  validateAvFrames,
  validateAvDecodeLog,
} from "../dist/videogen/av-media-evidence.js";
import type { AvLayoutV1 } from "../dist/videogen/av-media-container.js";
import { inspectAvMediaMp4 } from "../dist/videogen/av-media-container.js";
import {
  parseMediaJson,
  validateMediaPolicy,
  validateMediaRequest,
} from "../dist/videogen/media-contracts.js";
import { selectMediaFrames } from "../dist/videogen/media-decode.js";
import { rationalTime } from "../dist/videogen/rational-time.js";
import { AV_POLICY, avRequest, avFixturePolicy } from "./helpers/av-media-fixtures.js";
import {
  MEDIA_LIMITS,
  MEDIA_SELECTION,
  MediaFixture,
  required,
} from "./helpers/videogen-media-fixtures.js";
import { AvOwnerFixture } from "./helpers/av-media-owner-fixture.js";

const layout: AvLayoutV1 = {
  width: 32,
  height: 24,
  video: {
    id: 1,
    timescale: 16384,
    duration_ticks: 4096,
    duration: { numerator: 1, denominator: 4 },
    step: 2048,
    samples: [
      { pos: 48, size: 10, pts: 0, duration: 2048 },
      { pos: 78, size: 10, pts: 2048, duration: 2048 },
    ],
  },
  audio: {
    id: 2,
    timescale: 48000,
    duration_ticks: 2048,
    duration: { numerator: 16, denominator: 375 },
    step: 1024,
    samples: [
      { pos: 58, size: 20, pts: 0, duration: 1024 },
      { pos: 88, size: 20, pts: 1024, duration: 1024 },
    ],
  },
};
function probeFixture() {
  return {
    streams: [0, 1].map((i) => {
      const video = i === 0,
        track = video ? layout.video : layout.audio;
      return {
        index: i,
        id: `0x${i + 1}`,
        codec_name: video ? "h264" : "aac",
        codec_type: video ? "video" : "audio",
        profile: video ? "Constrained Baseline" : "LC",
        time_base: `1/${track.timescale}`,
        start_pts: 0,
        duration_ts: track.duration_ticks,
        nb_frames: "2",
        disposition: { default: 1, attached_pic: 0 },
        tags: {
          language: "und",
          handler_name: video ? "VideoHandler" : "SoundHandler",
          vendor_id: "[0][0][0][0]",
        },
        ...(video
          ? { width: 32, height: 24, pix_fmt: "yuv420p", has_b_frames: 0 }
          : { channels: 1, sample_rate: "48000", sample_fmt: "fltp", channel_layout: "mono" }),
      };
    }),
    packets: [layout.video, layout.audio].flatMap((t, i) =>
      t.samples.map((s) => ({
        stream_index: i,
        pts: s.pts,
        dts: s.pts,
        duration: s.duration,
        pos: String(s.pos),
        size: String(s.size),
      }))
    ),
    format: {
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      tags: { major_brand: "isom", minor_version: "512", compatible_brands: "isomiso2avc1mp41" },
    },
  };
}
function framesFixture() {
  return {
    frames: [layout.video, layout.audio].flatMap((t, i) =>
      t.samples.map((s) => ({
        media_type: i === 0 ? "video" : "audio",
        stream_index: i,
        pkt_pts: s.pts,
        pkt_dts: s.pts,
        best_effort_timestamp: s.pts,
        pkt_duration: s.duration,
        pkt_pos: String(s.pos),
        pkt_size: String(s.size),
        ...(i === 0
          ? {
              width: 32,
              height: 24,
              pix_fmt: "yuv420p",
              pict_type: "I",
              interlaced_frame: 0,
              repeat_pict: 0,
            }
          : { channels: 1, channel_layout: "mono", sample_fmt: "fltp", nb_samples: 1024 }),
      }))
    ),
  };
}
const json = (v: unknown) => Buffer.from(JSON.stringify(v));
const probe = (v: unknown) => parseAvJson(AvProbeSchema, json(v), MEDIA_LIMITS, 1048576);
const frames = (v: unknown) => parseAvJson(AvFramesSchema, json(v), MEDIA_LIMITS, 1048576);

describe("additive raw AV contracts (pure evidence fixtures, not codec qualification)", () => {
  it("keeps baseline request/policy authority distinct and strictly closed", () => {
    using f = new MediaFixture();
    const r = avRequest(f, Buffer.from("fixture"));
    expect(validateAvMediaPolicy(AV_POLICY)).toEqual(AV_POLICY);
    expect(validateAvMediaRequest(r, AV_POLICY)).toEqual(r);
    expect(() => validateMediaPolicy(AV_POLICY)).toThrow();
    expect(() => validateMediaRequest(r, f.policy)).toThrow();
    expect(() => validateAvMediaPolicy(f.policy)).toThrow();
    expect(() => validateAvMediaRequest(f.request(Buffer.from("fixture")), AV_POLICY)).toThrow();
    expect(
      parseMediaJson(AvMediaRequestV1Schema, Buffer.from(canonicalJson(r)), MEDIA_LIMITS)
    ).toEqual(r);
  });
  it.each([
    { schema_version: 2 },
    { command: "not authority" },
    { flags: ["-c", "copy"] },
    { audio_policy: "forbid" },
    { audio_policy: "strip_source_audio" },
    { normalize: true },
    { required_spans: [] },
    { operation_id: "../not-authority" },
  ])("refuses invalid or executable AV request fields %#", (change) => {
    using f = new MediaFixture();
    const r = avRequest(f, Buffer.from("fixture"));
    expect(() => validateAvMediaRequest({ ...r, ...change }, AV_POLICY)).toThrow();
  });
  it.each([
    { profile: "arbitrary_h264_aac" },
    { profile: "hevc" },
    { schema_version: 2 },
    { timing_policy: "assume_zero_priming" },
    { metadata_policy: "normalize" },
    { executable: "ignored" },
    { limits: { ...AV_POLICY.limits, max_sample_rate: 16000 } },
  ])("refuses untested AV policy fields %#", (change) => {
    expect(() => validateAvMediaPolicy({ ...AV_POLICY, ...change })).toThrow();
  });
  it("refuses noncanonical/duplicate/unknown semantic bytes and resource overflow", () => {
    expect(() => parseMediaJson(AvMediaPolicyV1Schema, json(AV_POLICY), MEDIA_LIMITS)).toThrow(
      /noncanonical/
    );
    const text = canonicalJson(AV_POLICY);
    expect(() =>
      parseMediaJson(
        AvMediaPolicyV1Schema,
        Buffer.from(text.replace('"schema_version":1', '"schema_version":1,"schema_version":1')),
        MEDIA_LIMITS
      )
    ).toThrow();
    expect(() =>
      validateAvMediaPolicy({
        ...AV_POLICY,
        limits: { ...AV_POLICY.limits, max_samples: Infinity },
      })
    ).toThrow();
    expect(() =>
      validateAvMediaPolicy({
        ...AV_POLICY,
        limits: { ...AV_POLICY.limits, max_frames: Number.MAX_SAFE_INTEGER },
      })
    ).toThrow();
  });
  it("selects rational nearest-even indices and exact absolute sample boundaries, never concatenated-duration rounding", () => {
    const pts = Array.from({ length: 8 }, (_, i) => rationalTime(BigInt(i), 8n));
    const spans = [{ start: rationalTime(0n, 1n), end: rationalTime(1n, 1n) }];
    expect(
      selectMediaFrames(
        pts,
        spans,
        { ...MEDIA_SELECTION, midpoint_count: 0, timepoints: [rationalTime(3n, 16n)] },
        8
      )
    ).toEqual([0, 2, 7]);
    expect(avSampleIndex(1, 4, 49152)).toBe(12000);
    expect(() => avSampleIndex(1, 7, 49152)).toThrow(/sample grid/);
    expect(() => avSampleIndex(Number.MAX_SAFE_INTEGER, 1, 49152)).toThrow();
    using f = new MediaFixture();
    const request = avRequest(f, Buffer.from("fixture"));
    expect(() =>
      validateAvMediaRequest({ ...request, decode_policy_ref: f.policy_ref }, AV_POLICY)
    ).toThrow(/schema/);
  });
  it("requires real concrete runners and never discovers missing custody", async () => {
    using f = new AvOwnerFixture();
    expect(() => f.evidence().inspect("orphan")).toThrow(/missing journal/);
    expect(() => inspectAvMediaMp4(Buffer.from("not MP4"), AV_POLICY)).toThrow();
    // The runtime brand, rather than a structural run() method, is authoritative.
    const input = {
      runner: {
        run: () => {
          throw new Error("must not execute");
        },
      },
      request: f.request(Buffer.from("bad")),
      bytes: Buffer.from("bad"),
      policy: AV_POLICY,
      selection: MEDIA_SELECTION,
      limits: MEDIA_LIMITS,
      signal: new AbortController().signal,
    };
    const result: unknown = Reflect.apply(decodeAvMediaBytes, undefined, [input]);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow(/concrete/);
  });
});
describe("generic host profile authority (structural policy, not arbitrary-size qualification)", () => {
  it("uses explicit dimensions/rational CFR independently of the opaque name", () => {
    for (const [width, height, numerator, denominator] of [
      [2, 2, 1, 1],
      [50, 34, 25, 2],
      [512, 288, 25, 1],
      [80, 48, 30000, 1001],
    ] as const) {
      const policy = avFixturePolicy(
        "one-name-no-routing",
        width,
        height,
        { numerator: required(numerator), denominator: required(denominator) },
        21
      );
      expect(validateAvMediaPolicy(policy)).toEqual(policy);
    }
    const renamed = { ...AV_POLICY, profile: { ...AV_POLICY.profile, profile_id: "not-a-preset" } };
    expect(validateAvMediaPolicy(renamed)).toEqual(renamed);
    expect(avVideoStep(renamed.profile, 16384)).toBe(2048);
    expect(sha256(canonicalJson(renamed))).not.toBe(sha256(canonicalJson(AV_POLICY)));
  });
  it.each([
    {},
    { profile_id: "../bad" },
    { profile_version: 2 },
    { width: 0 },
    { height: 3 },
    { width: 8194 },
    { width: 130 },
    { height: 130 },
    { width: 1.5 },
    { command: "ignored" },
    { frame_rate: { numerator: 0, denominator: 1 } },
    { frame_rate: { numerator: 25, denominator: 0 } },
    { frame_rate: { numerator: 50, denominator: 2 } },
    { frame_rate: { numerator: 25.5, denominator: 1 } },
    { frame_rate: { numerator: Infinity, denominator: 1 } },
    { frame_rate: { numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1 } },
    { frame_rate: { numerator: 4294967296, denominator: 1 } },
    { frame_rate: { numerator: 1, denominator: 4294967296 } },
    { frame_rate: { numerator: 1, denominator: 3 } },
    { video: { ...AV_POLICY.profile.video, codec: "hevc" } },
    { video: { ...AV_POLICY.profile.video, profile: "high" } },
    { video: { ...AV_POLICY.profile.video, pixel_format: "yuv444p" } },
    { video: { ...AV_POLICY.profile.video, level_idc: 99 } },
    { audio: { ...AV_POLICY.profile.audio, codec: "opus" } },
    { audio: { ...AV_POLICY.profile.audio, sample_rate: 44100 } },
    { audio: { ...AV_POLICY.profile.audio, channels: 2 } },
    { audio: { ...AV_POLICY.profile.audio, samples_per_access_unit: 960 } },
  ])("refuses absent/unknown/unsafe profile constraints %#", (change) => {
    const profile = Object.keys(change).length === 0 ? {} : { ...AV_POLICY.profile, ...change };
    expect(() => validateAvMediaPolicy({ ...AV_POLICY, profile })).toThrow();
  });
  it("refuses insufficient pixel/sample/representation budgets and never supplies a profile", () => {
    const { profile: _profile, ...missing } = AV_POLICY;
    expect(() => validateAvMediaPolicy(missing)).toThrow();
    for (const limits of [{ max_pixels: 767 }, { max_samples: 1023 }, { max_decoded_bytes: 5119 }])
      expect(() =>
        validateAvMediaPolicy({ ...AV_POLICY, limits: { ...AV_POLICY.limits, ...limits } })
      ).toThrow();
    expect(avMediaPngLimits(AV_POLICY)).toMatchObject({
      maxWidth: 128,
      maxHeight: 128,
      maxPixels: 16384,
    });
  });
  it("computes integral uint32 timebase/step with exact products beyond Number precision", () => {
    const profile = {
      ...AV_POLICY.profile,
      frame_rate: { numerator: 4294967291, denominator: 4294967295 },
    };
    expect(avVideoStep(profile, 4294967291)).toBe(4294967295);
    expect(
      avVideoStep(
        { ...AV_POLICY.profile, frame_rate: { numerator: 30000, denominator: 1001 } },
        30000
      )
    ).toBe(1001);
    expect(() => avVideoStep(profile, 4294967290)).toThrow(/integral/);
    expect(() =>
      avVideoStep({ ...profile, frame_rate: { numerator: 1, denominator: 4294967295 } }, 4294967295)
    ).toThrow(/uint32/);
    for (const scale of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER, 4294967296])
      expect(() => avVideoStep(AV_POLICY.profile, scale)).toThrow();
    expect(() => avSampleIndex(Number.MAX_SAFE_INTEGER + 1, 1, 49152)).toThrow(/safe/);
    expect(() => avSampleIndex(0, 1, Infinity)).toThrow(/safe/);
  });
  it("binds result schemas and timing/count/bytes to the entire exact policy", () => {
    using f = new MediaFixture();
    const request = avRequest(f, Buffer.from("pure schema fixture, not actual encoded media"));
    const result: AvMediaResultV1 = {
      schema_id: "penny.videogen-av-media-result.v1",
      schema_version: 1,
      operation_id: request.operation_id,
      source_ref: request.media_ref,
      request_sha256: sha256(canonicalJson(request)),
      policy_sha256: sha256(canonicalJson(AV_POLICY)),
      selection_sha256: request.frame_selection_ref.content_digest,
      profile: AV_POLICY.profile,
      required_spans: [{ start: rationalTime(0n, 1n), end: rationalTime(1n, 50n) }],
      decode_scope: "entire_exact_muxed_source",
      container_policy: AV_POLICY.metadata_policy,
      video: {
        stream_index: 0,
        track_id: 1,
        codec: "h264",
        width: 32,
        height: 24,
        time_base: rationalTime(1n, 16384n),
        frame_step: 2048,
        decoded_frame_count: 2,
        duration: rationalTime(1n, 4n),
        frames: [{ index: 0, pts: rationalTime(0n, 1n), slot: "frame-0" }],
      },
      audio: {
        stream_index: 1,
        track_id: 2,
        source_codec: "aac_lc",
        codec: "canonical_pcm",
        sample_rate: 48000,
        channels: "mono",
        decoded_access_units: 2,
        decoded_sample_count: 2048,
        duration: rationalTime(16n, 375n),
        timing: "untrimmed_coded_samples_priming_unknown_no_alignment_claim",
        spans: [
          { start_sample: 0, end_sample: 960, slot: "pcm-0", peak_abs_s16: 0, sum_squares: "0" },
        ],
      },
      outputs: [
        {
          slot: "frame-0",
          media_type: "image/png",
          sha256: sha256("schema-only"),
          byte_length: 64,
        },
        {
          slot: "pcm-0",
          media_type: "audio/wav",
          sha256: sha256("schema-only"),
          byte_length: 1964,
        },
      ],
      qualification: "raw_av_decode_only_not_playback_or_production",
      unassessed: [
        "motion",
        "speech",
        "intelligibility",
        "sync",
        "playback",
        "aac_ancillary_payloads",
      ],
    };
    expect(validateAvMediaResult(result, AV_POLICY)).toEqual(result);
    for (const change of [
      { profile: { ...result.profile, profile_id: "drift" } },
      { policy_sha256: sha256("wrong") },
      { video: { ...result.video, width: 64 } },
      { video: { ...result.video, frames: [{ ...required(result.video.frames[0]), index: 2 }] } },
      {
        video: {
          ...result.video,
          frames: [{ ...required(result.video.frames[0]), pts: rationalTime(1n, 8n) }],
        },
      },
      {
        audio: {
          ...result.audio,
          spans: [{ ...required(result.audio.spans[0]), end_sample: 961 }],
        },
      },
      { outputs: result.outputs.slice(1) },
      { video: { ...result.video, frame_step: 2049 } },
      { video: { ...result.video, time_base: { numerator: 1, denominator: 16000 } } },
      { video: { ...result.video, duration: rationalTime(1n, 2n) } },
      { audio: { ...result.audio, decoded_sample_count: 2049 } },
      { unassessed: ["motion", "speech", "intelligibility", "sync", "playback"] },
    ])
      expect(() => validateAvMediaResult({ ...result, ...change }, AV_POLICY)).toThrow();
    for (const limits of [
      { max_frames: 1 },
      { max_samples: 2047 },
      { max_output_bytes: 1000 },
      { max_decoded_bytes: 6144 },
      { max_duration: rationalTime(1n, 8n) },
    ]) {
      const policy = { ...AV_POLICY, limits: { ...AV_POLICY.limits, ...limits } };
      // Update the digest so these are real policy-limit tests, not merely digest negatives.
      expect(() =>
        validateAvMediaResult({ ...result, policy_sha256: sha256(canonicalJson(policy)) }, policy)
      ).toThrow();
    }
  });
});
describe("bounded hostile decoder JSON", () => {
  const schema = Type.Object({ x: Type.Integer() }, { additionalProperties: false });
  it.each([
    '{"x":1,"x":1}',
    '{"x":1,"\\u0078":1}',
    '{"x":1e999}',
    '{"x":9007199254740992}',
    '{"x":NaN}',
    '{"x":1,"unknown":0}',
    '{"x":1}{}',
    '{"x":1,}',
    '{"x":"\\uD800"}',
    '{"x":',
    "[1]",
    "null",
  ])("refuses %s", (text) => {
    expect(() => parseAvJson(schema, Buffer.from(text), MEDIA_LIMITS, 1048576)).toThrow();
  });
  it("allows noncanonical whitespace, but bounds bytes, UTF-8, depth, nodes, collections and text", () => {
    expect(parseAvJson(schema, Buffer.from(' { "x" : 1 }\n'), MEDIA_LIMITS, 1048576)).toEqual({
      x: 1,
    });
    expect(() => parseAvJson(schema, Buffer.from([0xff]), MEDIA_LIMITS, 10)).toThrow();
    expect(() => parseAvJson(schema, Buffer.from('{"x":1}'), MEDIA_LIMITS, 3)).toThrow();
    for (const limits of [
      { ...MEDIA_LIMITS, max_depth: 1 },
      { ...MEDIA_LIMITS, max_nodes: 2 },
      { ...MEDIA_LIMITS, max_collection_items: 1 },
      { ...MEDIA_LIMITS, max_text_bytes: 1 },
    ]) {
      expect(() =>
        parseAvJson(Type.Unknown(), Buffer.from('{"deep":[[1,2]]}'), limits, 1048576)
      ).toThrow();
    }
  });
});
describe("complete AV evidence cross-checks", () => {
  it("cross-checks every synthetic packet/frame without claiming actual codec execution", () => {
    expect(() => validateAvProbe(probe(probeFixture()), layout)).not.toThrow();
    expect(() => validateAvFrames(frames(framesFixture()), layout)).not.toThrow();
  });
  it.each([
    "codec_name",
    "profile",
    "time_base",
    "duration_ts",
    "index",
    "id",
    "start_pts",
    "nb_frames",
  ])("rejects probe identity drift %s", (field) => {
    const p = probe(probeFixture());
    Object.defineProperty(required(p.streams[0]), field, { value: "wrong" });
    expect(() => validateAvProbe(p, layout)).toThrow();
  });
  it.each(["attached_pic", "metadata", "subtitle", "unknown"])(
    "rejects forbidden/unknown disposition %s",
    (key) => {
      const p = probe(probeFixture());
      required(p.streams[1]).disposition[key] = 1;
      expect(() => validateAvProbe(p, layout)).toThrow();
    }
  );
  it("rejects missing, extra, duplicated and skip/metadata-bearing frame evidence", () => {
    const f = frames(framesFixture());
    expect(() => validateAvFrames({ frames: f.frames.slice(1) }, layout)).toThrow();
    expect(() =>
      validateAvFrames({ frames: [...f.frames, required(f.frames[0])] }, layout)
    ).toThrow();
    expect(() =>
      validateAvFrames(
        { frames: [required(f.frames[0]), required(f.frames[0]), ...f.frames.slice(2)] },
        layout
      )
    ).toThrow();
    expect(() =>
      frames({
        frames: f.frames.map((x) => ({
          ...x,
          side_data_list: [{ side_data_type: "Skip Samples" }],
        })),
      })
    ).toThrow();
    expect(() => probe({ ...probeFixture(), chapters: [] })).toThrow();
    const p = probe(probeFixture());
    required(p.streams[0]).tags = { path: "not-authority" };
    expect(() => validateAvProbe(p, layout)).toThrow();
  });
  it("requires second decode PTS/timebase/sample evidence and no diagnostics", () => {
    const v = Buffer.from(
      "config in time_base: 1/16384\nn: 0 pts: 0 pts_time:0\nn: 1 pts: 2048 pts_time:0.125\n"
    );
    expect(() => validateAvDecodeLog(v, layout.video, true)).not.toThrow();
    expect(() =>
      validateAvDecodeLog(Buffer.concat([v, Buffer.from("[error] bad")]), layout.video, true)
    ).toThrow();
    expect(() =>
      validateAvDecodeLog(Buffer.from(v.toString().replace("2048", "2049")), layout.video, true)
    ).toThrow();
    expect(() =>
      validateAvDecodeLog(Buffer.from(v.toString().replace("16384", "16385")), layout.video, true)
    ).toThrow();
    expect(() => validateAvDecodeLog(Buffer.from(""), layout.audio, false)).toThrow();
  });
});
