import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../../dist/canonical-json.js";
import type { MediaExecutableBindingV1 } from "../../dist/host-operations/confined-media-runner.js";
import {
  validateAvMediaPolicy,
  type AvMediaPolicyV1,
  type AvMediaRequestV1,
} from "../../dist/videogen/av-media-contracts.js";
import type { RationalRate } from "../../dist/videogen/rational-time.js";
import { MEDIA_POLICY, MediaFixture } from "./videogen-media-fixtures.js";

export const AV_POLICY: AvMediaPolicyV1 = {
  schema_id: "penny.videogen-av-media-policy.v1",
  schema_version: 1,
  limits: { ...MEDIA_POLICY, max_samples: 192000, max_sample_rate: 48000 },
  profile: {
    profile_id: "synthetic-small",
    profile_version: 1,
    width: 32,
    height: 24,
    frame_rate: { numerator: 8, denominator: 1 },
    video: {
      codec: "h264",
      profile: "constrained_baseline",
      pixel_format: "yuv420p",
      level_idc: 10,
    },
    audio: { codec: "aac_lc", sample_rate: 48000, channels: 1, samples_per_access_unit: 1024 },
  },
  metadata_policy: "closed_nonfragmented_avc_aac_v1",
  timing_policy: "zero_based_cfr_no_edits_no_composition_untrimmed_aac",
};
/** Test budgets only. Nothing in production imports this helper or chooses profiles by name. */
export function avFixturePolicy(
  profile_id: string,
  width: number,
  height: number,
  frame_rate: RationalRate,
  level_idc: number
): AvMediaPolicyV1 {
  return validateAvMediaPolicy({
    ...AV_POLICY,
    limits: {
      ...AV_POLICY.limits,
      max_width: width,
      max_height: height,
      max_pixels: width * height,
      max_frames: 64,
      max_decoded_bytes: 33554432,
      max_output_bytes: 8388608,
    },
    profile: {
      ...AV_POLICY.profile,
      profile_id,
      width,
      height,
      frame_rate,
      video: { ...AV_POLICY.profile.video, level_idc },
    },
  });
}
export function avRequest(f: MediaFixture, bytes: Buffer, policy = AV_POLICY): AvMediaRequestV1 {
  return {
    schema_id: "penny.videogen-av-media-request.v1",
    schema_version: 1,
    operation_id: "av-operation",
    media_ref: f.raw(bytes, "video/mp4"),
    decode_policy_ref: f.json(policy, policy.schema_id),
    frame_selection_ref: f.selection_ref,
    required_spans: [
      { start: { numerator: 0, denominator: 1 }, end: { numerator: 1, denominator: 1 } },
    ],
    audio_policy: "decode_untrimmed_coded_timeline_not_alignment",
  };
}
/** Real finite synthetic mux. Elementary AAC deliberately has no edit/skip/priming information.
 * Fixture-only metadata removal is not a runtime normalization path. moov follows mdat so sample
 * offsets remain unchanged; the unscrubbed file is retained for negative admission tests. */
export function syntheticAv(
  f: Pick<MediaFixture, "root">,
  b: MediaExecutableBindingV1,
  policy = AV_POLICY,
  frameCount = 8,
  audioSeconds = 1
): Buffer {
  validateAvMediaPolicy(policy);
  if (
    !Number.isSafeInteger(frameCount) ||
    frameCount < 1 ||
    frameCount > policy.limits.max_frames ||
    !Number.isFinite(audioSeconds) ||
    audioSeconds <= 0 ||
    audioSeconds > 2
  )
    throw new Error("finite synthetic source required");
  const profile = policy.profile,
    rate = `${profile.frame_rate.numerator}/${profile.frame_rate.denominator}`;
  const ffmpeg = b.path;
  if (sha256(readFileSync(ffmpeg)) !== b.sha256) throw new Error("fixture encoder pin drift");
  const run = (args: string[]) =>
    execFileSync(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-v", "error", "-threads", "1", "-filter_threads", "1", ...args],
      { env: {}, timeout: 15000, maxBuffer: 1048576 }
    );
  const video = path.join(f.root, "av.h264"),
    audio = path.join(f.root, "av.aac"),
    mux = path.join(f.root, "av-raw.mp4");
  run([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${profile.width}x${profile.height}:rate=${rate}:duration=2`,
    "-an",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-profile:v",
    "baseline",
    "-level:v",
    String(profile.video.level_idc / 10),
    "-frames:v",
    String(frameCount),
    "-bf",
    "0",
    "-g",
    String(frameCount),
    "-pix_fmt",
    "yuv420p",
    "-bsf:v",
    "filter_units=remove_types=6",
    "-f",
    "h264",
    video,
  ]);
  run([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${audioSeconds}`,
    "-vn",
    "-c:a",
    "aac",
    "-threads",
    "1",
    "-flags:a",
    "+bitexact",
    "-f",
    "adts",
    audio,
  ]);
  run([
    "-r",
    rate,
    "-i",
    video,
    "-i",
    audio,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy",
    "-use_editlist",
    "0",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-f",
    "mp4",
    mux,
  ]);
  return stripFixtureMetadata(readFileSync(mux));
}
export function locateAvBox(
  bytes: Buffer,
  type: string,
  occurrence = 0
): { start: number; p: number; end: number } {
  const found: { start: number; p: number; end: number }[] = [];
  const walk = (start: number, end: number): void => {
    for (let at = start; at < end; ) {
      const n = bytes.readUInt32BE(at),
        name = bytes.toString("ascii", at + 4, at + 8);
      if (n < 8 || at + n > end) throw new Error("fixture box extent");
      if (name === type) found.push({ start: at, p: at + 8, end: at + n });
      if (["moov", "trak", "mdia", "minf", "stbl", "dinf"].includes(name)) walk(at + 8, at + n);
      if (["stsd", "dref"].includes(name)) walk(at + 16, at + n);
      if (name === "avc1") walk(at + 86, at + n);
      if (name === "mp4a") walk(at + 36, at + n);
      at += n;
    }
  };
  walk(0, bytes.length);
  const result = found[occurrence];
  if (!result) throw new Error("fixture box missing");
  return result;
}
export function stripFixtureMetadata(bytes: Buffer): Buffer {
  const visit = (start: number, end: number): Buffer => {
    const parts: Buffer[] = [];
    for (let at = start; at < end; ) {
      const n = bytes.readUInt32BE(at),
        name = bytes.toString("ascii", at + 4, at + 8);
      if (n < 8 || at + n > end) throw new Error("fixture box extent");
      // The admitted synthetic fixture intentionally has no roll/recovery sample groups.
      // Preserve the original mux as a refusal oracle. This is not runtime normalization.
      if (!["udta", "sgpd", "sbgp"].includes(name)) {
        let body: Buffer = Buffer.from(bytes.subarray(at + 8, at + n));
        if (["moov", "trak", "mdia", "minf", "stbl"].includes(name)) body = visit(at + 8, at + n);
        if (name === "stsd" && body.toString("ascii", 12, 16) === "avc1") body.fill(0, 58, 90);
        const h = Buffer.alloc(8);
        h.writeUInt32BE(body.length + 8);
        h.write(name, 4);
        parts.push(h, body);
      }
      at += n;
    }
    return Buffer.concat(parts);
  };
  return visit(0, bytes.length);
}
