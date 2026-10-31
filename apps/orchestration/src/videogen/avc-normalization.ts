import { canonicalJson, sha256 } from "../canonical-json.js";
import { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import { validateMp4Video, type ExpectedMp4VideoV1 } from "../mp4-media.js";
import { inspectImportAvcMp4, inspectStrictAvcMp4 } from "./media-decode.js";
import { validateMediaPolicy, type MediaDecodePolicyV1 } from "./media-contracts.js";

interface Box {
  type: string;
  start: number;
  payload: number;
  end: number;
}
function refuse(message: string): never {
  throw new Error(`AVC normalization refused: ${message}`);
}
function boxes(bytes: Buffer, start = 0, end = bytes.length): Box[] {
  const result: Box[] = [];
  for (let at = start; at < end; ) {
    if (at + 8 > end) refuse("box header");
    const size = bytes.readUInt32BE(at);
    if (size < 8 || at + size > end) refuse("box extent");
    result.push({
      type: bytes.toString("latin1", at + 4, at + 8),
      start: at,
      payload: at + 8,
      end: at + size,
    });
    at += size;
  }
  return result;
}
function one(items: readonly Box[], name: string): Box {
  const matches = items.filter((b) => b.type === name);
  if (matches.length !== 1) refuse(`required singleton ${name}`);
  return matches[0] ?? refuse(name);
}
/** Independent table/PTS inspection before any decoder. B-frame decode order may differ, but
 * the single unit-rate edit must expose every picture exactly once on a zero-based CFR grid. */
export function inspectImportedAvc(
  bytes: Buffer,
  policy: MediaDecodePolicyV1,
  expected: ExpectedMp4VideoV1
) {
  const imported = inspectImportAvcMp4(bytes, policy);
  const result = validateMp4Video(bytes, expected);
  if (result.status !== "valid") refuse(result.reason_code);
  if (
    expected.width > policy.max_width ||
    expected.height > policy.max_height ||
    expected.width * expected.height > policy.max_pixels ||
    expected.frame_count > policy.max_frames ||
    expected.width * expected.height * 4 * expected.frame_count > policy.max_decoded_bytes ||
    result.metadata.duration_seconds >
      policy.max_duration.numerator / policy.max_duration.denominator
  )
    refuse("decode representation bounds");
  const top = boxes(bytes),
    movie = boxes(bytes, one(top, "moov").payload, one(top, "moov").end);
  const trak = one(movie, "trak"),
    track = boxes(bytes, trak.payload, trak.end);
  const mdia = one(track, "mdia"),
    media = boxes(bytes, mdia.payload, mdia.end);
  const mdhd = one(media, "mdhd"),
    scale = bytes.readUInt32BE(mdhd.payload + 12);
  const minf = one(media, "minf"),
    stbl = one(boxes(bytes, minf.payload, minf.end), "stbl");
  const tables = boxes(bytes, stbl.payload, stbl.end),
    stts = one(tables, "stts");
  if (
    bytes.readUInt32BE(stts.payload + 4) !== 1 ||
    bytes.readUInt32BE(stts.payload + 8) !== expected.frame_count
  )
    refuse("single CFR timing run required");
  const step = bytes.readUInt32BE(stts.payload + 12);
  let editOffset = 0;
  const edts = track.find((b) => b.type === "edts");
  if (edts) {
    const elst = one(boxes(bytes, edts.payload, edts.end), "elst");
    editOffset = bytes.readInt32BE(elst.payload + 12);
    const mvhd = one(movie, "mvhd"),
      tkhd = one(track, "tkhd");
    const movieScale = bytes.readUInt32BE(mvhd.payload + 12);
    const movieTicks = Math.ceil((expected.frame_count * step * movieScale) / scale);
    if (
      bytes.readUInt32BE(elst.payload + 8) !== movieTicks ||
      bytes.readUInt32BE(mvhd.payload + 16) !== movieTicks ||
      bytes.readUInt32BE(tkhd.payload + 20) !== movieTicks
    )
      refuse("edit/movie extent");
  }
  const offsets: number[] = [];
  const ctts = tables.find((b) => b.type === "ctts");
  if (ctts) {
    for (let at = ctts.payload + 8; at < ctts.end; at += 8) {
      const n = bytes.readUInt32BE(at),
        offset = bytes.readUInt32BE(at + 4);
      if (!n || n > expected.frame_count - offsets.length || offset > expected.frame_count * step)
        refuse("composition run bound");
      for (let i = 0; i < n; i++) offsets.push(offset);
    }
    if (offsets.length !== expected.frame_count) refuse("composition sample count");
  } else offsets.push(...Array.from({ length: expected.frame_count }, () => 0));
  // Reconstruct every sample independently of ffprobe. No overlapping, hidden or unreferenced
  // media bytes may be smuggled through a successful decoder/normalizer.
  const stsz = one(tables, "stsz"),
    stsc = one(tables, "stsc");
  const chunkBox =
    tables.find((b) => b.type === "stco" || b.type === "co64") ?? refuse("chunk offsets");
  const chunkCount = bytes.readUInt32BE(chunkBox.payload + 4),
    maps: { first: number; count: number }[] = [];
  for (let at = stsc.payload + 8; at < stsc.end; at += 12)
    maps.push({ first: bytes.readUInt32BE(at), count: bytes.readUInt32BE(at + 4) });
  const fixed = bytes.readUInt32BE(stsz.payload + 4),
    ranges: { start: number; end: number }[] = [];
  let sample = 0,
    mapping = 0;
  for (let i = 1; i <= chunkCount; i++) {
    if (maps[mapping + 1]?.first === i) mapping++;
    const at = chunkBox.payload + 8 + (i - 1) * (chunkBox.type === "co64" ? 8 : 4);
    const offset =
      chunkBox.type === "co64" ? Number(bytes.readBigUInt64BE(at)) : bytes.readUInt32BE(at);
    let pos = offset;
    const count = maps[mapping]?.count ?? refuse("chunk map");
    if (count > expected.frame_count - sample) refuse("sample map extent");
    for (let j = 0; j < count; j++, sample++) {
      const size = fixed || bytes.readUInt32BE(stsz.payload + 12 + sample * 4);
      ranges.push({ start: pos, end: pos + size });
      pos += size;
    }
  }
  if (sample !== expected.frame_count) refuse("sample count");
  const idrs: number[] = [];
  for (const [i, range] of ranges.entries()) {
    let at = range.start,
      idr = false;
    while (at < range.end) {
      if (at + imported.nal_length > range.end) refuse("sample NAL header");
      const size = bytes.readUIntBE(at, imported.nal_length);
      at += imported.nal_length;
      if (!size || at + size > range.end) refuse("sample NAL extent");
      if (((bytes[at] ?? 0) & 31) === 5) idr = true;
      at += size;
    }
    if (idr) idrs.push(i + 1);
  }
  const sync = tables.find((b) => b.type === "stss");
  if (
    idrs[0] !== 1 ||
    (sync
      ? bytes.readUInt32BE(sync.payload + 4) !== idrs.length ||
        idrs.some((index, i) => bytes.readUInt32BE(sync.payload + 8 + i * 4) !== index)
      : idrs.length !== sample)
  )
    refuse("sync sample disagreement");
  let covered = one(top, "mdat").payload;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    if (range.start !== covered) refuse("overlapping/unreferenced media");
    covered = range.end;
  }
  if (covered !== one(top, "mdat").end) refuse("unreferenced media tail");
  const pts = offsets.map((o, i) => i * step + o - editOffset).sort((a, b) => a - b);
  if (pts.some((p, i) => p !== i * step))
    refuse("edits/composition omit, duplicate or retime pictures");
  return { metadata: result.metadata, timescale: scale, step, pts };
}
/** FFmpeg adds known informational encoder tags even in bitexact mode. Remove only those
 * parsed fields from a disposable re-encode with moov AFTER media, so stco/co64 never move. */
function canonicalizeEncodedMp4(bytes: Buffer, policy: MediaDecodePolicyV1): Buffer {
  inspectImportAvcMp4(bytes, policy);
  const top = boxes(bytes),
    movie = one(top, "moov");
  if (movie.end !== bytes.length || top.some((b) => b.type === "mdat" && b.start > movie.start))
    refuse("encoder box order");
  const rewrite = (start: number, end: number): Buffer => {
    const result: Buffer[] = [];
    for (const b of boxes(bytes, start, end)) {
      if (b.type === "udta") continue;
      let body: Buffer = Buffer.from(bytes.subarray(b.payload, b.end));
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(b.type))
        body = rewrite(b.payload, b.end);
      if (b.type === "stsd") {
        const entry = one(boxes(bytes, b.payload + 8, b.end), "avc1");
        body.fill(0, entry.payload + 42 - b.payload, entry.payload + 74 - b.payload);
      }
      const h = Buffer.alloc(8);
      h.writeUInt32BE(body.length + 8);
      h.write(b.type, 4, "latin1");
      result.push(h, body);
    }
    return Buffer.concat(result);
  };
  const result = rewrite(0, bytes.length);
  inspectStrictAvcMp4(result, policy);
  return result;
}
export interface AvcNormalizationReceiptV1 {
  readonly schema_id: "penny.videogen-avc-normalization.v1";
  readonly schema_version: 1;
  readonly transform: "cpu_h264_baseline_lossy_reencode_metadata_removed";
  readonly raw_sha256: string;
  readonly raw_bytes: number;
  readonly normalized_sha256: string;
  readonly normalized_bytes: number;
  readonly byte_equal: boolean;
  readonly lossless: false;
  readonly runtime_sha256: string;
  readonly width: number;
  readonly height: number;
  readonly decoded_frame_count: number;
  readonly fps: number;
  readonly qualification: "media_compatibility_only_not_job_custody_rights_or_playback";
}
/** Caller must retain the ORIGINAL accepted-job artifact and attach this raw→canonical delta
 * as provenance. This utility cannot establish API acceptance or replace a shot result in place. */
export async function normalizeImportedAvc(input: {
  readonly runner: ConfinedMediaRunner;
  readonly bytes: Uint8Array;
  readonly policy: MediaDecodePolicyV1;
  readonly expected: ExpectedMp4VideoV1;
  readonly signal: AbortSignal;
}): Promise<{ readonly bytes: Buffer; readonly receipt: AvcNormalizationReceiptV1 }> {
  if (!ConfinedMediaRunner.isTrusted(input.runner)) refuse("concrete CPU runner required");
  const policy = validateMediaPolicy(structuredClone(input.policy));
  const bytes = Buffer.from(input.bytes),
    expected = structuredClone(input.expected);
  const layout = inspectImportedAvc(bytes, policy, expected);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(policy.max_elapsed_ms)]);
  const run = (verb: Parameters<ConfinedMediaRunner["run"]>[0]["verb"], media: Buffer) =>
    input.runner.run({ verb, bytes: media, policy, signal });
  const verifyDecode = async (media: Buffer): Promise<void> => {
    const decoded = await run("video_rgba", media);
    if (decoded.stdout.length !== expected.width * expected.height * 4 * expected.frame_count)
      refuse("full decoded frame count");
    const log = decoded.stderr.toString("utf8");
    // The fixed runner uses -xerror/-err_detect explode and requires exit 0. Do not
    // classify producer prompt text in ffmpeg's info log as decoder diagnostics.
    const tb = /config in time_base: ([0-9]+)\/([0-9]+)/u.exec(log);
    if (!tb) refuse("decoded timebase");
    const n = BigInt(tb[1] ?? refuse("timebase")),
      d = BigInt(tb[2] ?? refuse("timebase"));
    const observed = [...log.matchAll(/\bn:\s*([0-9]+)\s+pts:\s*(-?[0-9]+)\s+pts_time:/gu)];
    const pictures = log.split("\n").filter((line) => /\bn:\s*[0-9]+\s+pts:/u.test(line));
    if (
      pictures.some(
        (line) =>
          !line.includes(`s:${expected.width}x${expected.height} `) ||
          !line.includes("fmt:yuv420p ")
      )
    )
      refuse("decoded frame dimensions/format drift");
    if (
      observed.length !== expected.frame_count ||
      observed.some(
        (m, i) =>
          Number(m[1]) !== i ||
          BigInt(m[2] ?? refuse("PTS")) * n * BigInt(layout.timescale) !==
            BigInt(i * layout.step) * d
      )
    )
      refuse("complete decoded zero-based CFR PTS");
  };
  await verifyDecode(bytes);
  const encoded = await run("normalize_avc", bytes);
  const canonical = canonicalizeEncodedMp4(encoded.stdout, policy);
  const result = validateMp4Video(canonical, {
    ...expected,
    max_bytes: Math.min(expected.max_bytes, policy.max_output_bytes),
  });
  if (result.status !== "valid") refuse("canonical profile mismatch");
  await verifyDecode(canonical);
  const receipt: AvcNormalizationReceiptV1 = {
    schema_id: "penny.videogen-avc-normalization.v1",
    schema_version: 1,
    transform: "cpu_h264_baseline_lossy_reencode_metadata_removed",
    raw_sha256: sha256(bytes),
    raw_bytes: bytes.length,
    normalized_sha256: sha256(canonical),
    normalized_bytes: canonical.length,
    byte_equal: bytes.equals(canonical),
    lossless: false,
    runtime_sha256: input.runner.runtimeDigest,
    width: expected.width,
    height: expected.height,
    decoded_frame_count: expected.frame_count,
    fps: expected.fps,
    qualification: "media_compatibility_only_not_job_custody_rights_or_playback",
  };
  // Ensure the public receipt remains finite JSON before it can be persisted by a caller.
  canonicalJson(receipt);
  signal.throwIfAborted();
  return { bytes: canonical, receipt };
}
