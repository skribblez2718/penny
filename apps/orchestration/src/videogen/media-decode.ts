import { Type, type Static } from "typebox";
import { inspectAvcImportMetadata, inspectAvcImportSei } from "./avc-import-metadata.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import type {
  HostOperationAdapterV1,
  HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import { isCanonicalHostOperationExecutionContextV1 } from "../host-operations/owner.js";
import { validateMp4Video } from "../mp4-media.js";
import { encodeCanonicalPng, resolvePngMediaLimits, validateCanonicalPng } from "../png-media.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { assertBoundedJson, sameRef, type FoundationLimitsV1 } from "./bounds.js";
import {
  MEDIA_FRAME_CONTRACT,
  MEDIA_PCM_CONTRACT,
  RAW_MEDIA_REQUEST_CONTRACT,
  RAW_MEDIA_RESULT_CONTRACT,
  MediaDecodePolicyV1Schema,
  MediaFrameSelectionV1Schema,
  RawMediaDecodeRequestV1Schema,
  RawMediaDecodeResultV1Schema,
  parseMediaJson,
  validateMediaPolicy,
  validateMediaRequest,
  validateMediaSelection,
  type MediaDecodePolicyV1,
  type MediaFrameSelectionV1,
  type RawMediaDecodeRequestV1,
  type RawMediaDecodeResultV1,
} from "./media-contracts.js";
import {
  addTime,
  compareTime,
  rationalTime,
  subtractTime,
  type RationalTime,
} from "./rational-time.js";

const closed = { additionalProperties: false } as const;
const integer = Type.Integer({
  minimum: -Number.MAX_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
});
const digits = Type.String({ pattern: "^[0-9]{1,16}$" });
const tags = Type.Optional(Type.Record(Type.String(), Type.String()));
const sideData = Type.Optional(Type.Array(Type.Unknown(), { maxItems: 0 }));
const ProbeSchema = Type.Object(
  {
    programs: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 0 })),
    streams: Type.Array(
      Type.Object(
        {
          index: integer,
          codec_name: Type.String(),
          codec_type: Type.String(),
          width: Type.Optional(integer),
          height: Type.Optional(integer),
          pix_fmt: Type.Optional(Type.String()),
          time_base: Type.String(),
          duration_ts: Type.Optional(integer),
          nb_frames: Type.Optional(digits),
          sample_rate: Type.Optional(digits),
          channels: Type.Optional(integer),
          tags,
          disposition: Type.Optional(
            Type.Record(Type.String(), Type.Integer({ minimum: 0, maximum: 1 }))
          ),
          side_data_list: sideData,
        },
        closed
      ),
      { minItems: 1, maxItems: 1 }
    ),
    packets: Type.Array(
      Type.Object(
        {
          stream_index: integer,
          pts: integer,
          dts: integer,
          duration: integer,
          pos: digits,
          size: digits,
          side_data_list: sideData,
        },
        closed
      ),
      { minItems: 1, maxItems: 100_000_000 }
    ),
    format: Type.Object({ format_name: Type.String(), tags }, closed),
  },
  closed
);
type Probe = Static<typeof ProbeSchema>;
interface Box {
  readonly type: string;
  readonly start: number;
  readonly payload: number;
  readonly end: number;
}
interface VideoLayout {
  readonly nal_length: number;
  readonly media_ranges: readonly Box[];
}
interface WavLayout {
  readonly channels: 1 | 2;
  readonly sample_rate: number;
  readonly samples: number;
  readonly data: Buffer;
}
export interface RawDecodedMediaV1 {
  readonly result: RawMediaDecodeResultV1;
  readonly outputs: readonly {
    readonly slot: string;
    readonly media_type: "image/png" | "audio/wav";
    readonly bytes: Uint8Array;
  }[];
}

function fail(message: string): never {
  throw new Error(`media refused: ${message}`);
}
function positive(value: number, cap: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > cap) fail(name);
  return value;
}
/** Additive STRICT metadata policy, not a replacement general MP4 parser. Unknown boxes refuse.
 * Only nonfragmented baseline AVC, CFR, no edit list, no B frames, no embedded audio is supported.
 * No opaque raw clip is thereby declared deliverable. */
export function inspectStrictAvcMp4(bytes: Buffer, policy: MediaDecodePolicyV1): VideoLayout {
  return inspectAvcMp4(bytes, policy, false);
}
/** Broader read-only import subset, NEVER canonical evidence. Requires CPU normalization and
 * complete decode before use. The strict raw decode policy remains unchanged. */
export function inspectImportAvcMp4(bytes: Buffer, policy: MediaDecodePolicyV1): VideoLayout {
  return inspectAvcMp4(bytes, policy, true);
}
function inspectAvcMp4(bytes: Buffer, policy: MediaDecodePolicyV1, imported: boolean): VideoLayout {
  if (bytes.length === 0 || bytes.length > policy.max_input_bytes) fail("MP4 input byte limit");
  let count = 0;
  let nalLength = 0;
  let tracks = 0;
  const media: Box[] = [];
  const boxes = (start: number, end: number): Box[] => {
    const result: Box[] = [];
    for (let cursor = start; cursor < end; ) {
      if (++count > policy.max_boxes || cursor + 8 > end) fail("MP4 box count/header");
      const size = bytes.readUInt32BE(cursor);
      if (size < 8 || cursor + size > end) fail("MP4 box size (extended/zero unsupported)");
      result.push({
        type: bytes.toString("latin1", cursor + 4, cursor + 8),
        start: cursor,
        payload: cursor + 8,
        end: cursor + size,
      });
      cursor += size;
    }
    return result;
  };
  const zero = (start: number, end: number): void => {
    if (bytes.subarray(start, end).some((x) => x !== 0)) fail("unapproved MP4 metadata");
  };
  const identityMatrix = (start: number): void => {
    const identity = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
    if (identity.some((value, index) => bytes.readUInt32BE(start + index * 4) !== value))
      fail("unapproved track transform metadata");
  };
  const nal = (start: number, end: number, expected: number): void => {
    if (start >= end || (bytes[start] ?? 0) >> 7 !== 0 || ((bytes[start] ?? 0) & 31) !== expected)
      fail("AVC configuration NAL");
  };
  const inspect = (parent: string, children: readonly Box[], depth: number): void => {
    if (depth > 7) fail("MP4 nesting");
    const permitted: Readonly<Record<string, readonly string[]>> = {
      root: ["ftyp", "free", "mdat", "moov"],
      moov: ["mvhd", "trak", ...(imported ? ["udta"] : [])],
      trak: ["tkhd", "mdia", ...(imported ? ["edts"] : [])],
      mdia: ["mdhd", "hdlr", "minf"],
      minf: ["vmhd", "dinf", "stbl"],
      dinf: ["dref"],
      dref: ["url "],
      stbl: ["stsd", "stts", "stss", "stsc", "stsz", "stco", "co64", ...(imported ? ["ctts"] : [])],
      avc1: ["avcC", "pasp", "btrt", ...(imported ? ["colr"] : [])],
    };
    for (const b of children) {
      if (!(permitted[parent] ?? []).includes(b.type)) fail(`unapproved MP4 box ${b.type}`);
      const body = b.end - b.payload;
      if (imported && b.type === "udta") {
        count += inspectAvcImportMetadata(bytes, b);
        if (count > policy.max_boxes) fail("MP4 metadata box count");
      } else if (imported && b.type === "edts") {
        const edits = boxes(b.payload, b.end);
        const elst = edits[0];
        if (
          edits.length !== 1 ||
          elst?.type !== "elst" ||
          elst.end - elst.payload !== 20 ||
          bytes.readUInt32BE(elst.payload) !== 0 ||
          bytes.readUInt32BE(elst.payload + 4) !== 1 ||
          bytes.readUInt32BE(elst.payload + 8) === 0 ||
          bytes.readInt32BE(elst.payload + 12) < 0 ||
          bytes.readUInt32BE(elst.payload + 16) !== 65536
        )
          fail("unsupported import edit list");
      } else if (imported && b.type === "colr") {
        // The implemented SDR import profile: BT.709 primaries/matrix, sRGB transfer,
        // limited range. Other colour profiles need explicit conversion, not opaque admission.
        if (
          body !== 11 ||
          !bytes.subarray(b.payload, b.end).equals(Buffer.from("6e636c780001000d000100", "hex"))
        )
          fail("unsupported import colour profile");
      } else if (b.type === "mdat") {
        if (body < 1) fail("empty mdat");
        media.push(b);
      } else if (b.type === "free") zero(b.payload, b.end);
      else if (b.type === "ftyp") {
        if (body < 8 || body % 4 !== 0 || body > 64) fail("MP4 brands");
        for (let offset = b.payload; offset < b.end; offset += 4) {
          if (offset === b.payload + 4) continue;
          if (
            !["isom", "iso2", "avc1", "mp41", "mp42"].includes(
              bytes.toString("ascii", offset, offset + 4)
            )
          )
            fail("unapproved MP4 brand");
        }
      } else if (["mvhd", "tkhd", "mdhd"].includes(b.type)) {
        if (body < 20 || bytes[b.payload] !== 0) fail("MP4 header version/size");
        zero(b.payload + 4, b.payload + 12); // creation / modification time
        if (
          (b.type === "mvhd" && body !== 100) ||
          (b.type === "tkhd" && body !== 84) ||
          (b.type === "mdhd" && body !== 24)
        )
          fail("MP4 header length");
        if (b.type === "mvhd") {
          zero(b.payload, b.payload + 4);
          if (
            bytes.readUInt32BE(b.payload + 20) !== 65536 ||
            bytes.readUInt16BE(b.payload + 24) !== 256
          )
            fail("unapproved movie rate/volume");
          zero(b.payload + 26, b.payload + 36);
          identityMatrix(b.payload + 36);
          zero(b.payload + 72, b.payload + 96);
        } else if (b.type === "tkhd") {
          if (bytes.readUInt32BE(b.payload) !== 3) fail("unapproved video track flags");
          zero(b.payload + 16, b.payload + 20);
          zero(b.payload + 24, b.payload + 40);
          identityMatrix(b.payload + 40);
        } else {
          zero(b.payload, b.payload + 4);
          if (bytes.readUInt16BE(b.payload + 20) !== 0x55c4) fail("unapproved track language");
          zero(b.payload + 22, b.payload + 24);
        }
      } else if (b.type === "hdlr") {
        if (body < 25 || bytes.toString("ascii", b.payload + 8, b.payload + 12) !== "vide")
          fail("extra/nonvideo stream");
        zero(b.payload, b.payload + 8);
        zero(b.payload + 12, b.payload + 24);
        const name = bytes.subarray(b.payload + 24, b.end);
        if (!name.equals(Buffer.from("VideoHandler\0")) && name.some((x) => x !== 0))
          fail("MP4 handler metadata");
      } else if (b.type === "dref") {
        if (body < 8 || bytes.readUInt32BE(b.payload + 4) !== 1) fail("MP4 data reference count");
        zero(b.payload, b.payload + 4);
        inspect("dref", boxes(b.payload + 8, b.end), depth + 1);
      } else if (b.type === "url ") {
        if (body !== 4 || bytes.readUInt32BE(b.payload) !== 1) fail("external media reference");
      } else if (b.type === "stsd") {
        if (body < 8 || bytes.readUInt32BE(b.payload + 4) !== 1) fail("MP4 sample entry count");
        zero(b.payload, b.payload + 4);
        const entries = boxes(b.payload + 8, b.end);
        const entry = entries[0];
        if (
          entries.length !== 1 ||
          entry === undefined ||
          entry.type !== "avc1" ||
          entry.end - entry.payload < 78
        )
          fail("only avc1 supported");
        zero(entry.payload, entry.payload + 6);
        if (bytes.readUInt16BE(entry.payload + 6) !== 1) fail("sample data reference");
        zero(entry.payload + 8, entry.payload + 24);
        if (
          bytes.readUInt32BE(entry.payload + 28) !== 0x00480000 ||
          bytes.readUInt32BE(entry.payload + 32) !== 0x00480000 ||
          bytes.readUInt16BE(entry.payload + 40) !== 1 ||
          bytes.readUInt16BE(entry.payload + 74) !== 24 ||
          bytes.readUInt16BE(entry.payload + 76) !== 65535
        )
          fail("unapproved visual sample fields");
        zero(entry.payload + 36, entry.payload + 40);
        if (imported) {
          const n = bytes[entry.payload + 42] ?? 255;
          if (
            n > 31 ||
            !/^[\x20-\x7e]*$/u.test(
              bytes.toString("latin1", entry.payload + 43, entry.payload + 43 + n)
            )
          )
            fail("import compressor metadata");
          zero(entry.payload + 43 + n, entry.payload + 74);
        } else zero(entry.payload + 42, entry.payload + 74); // compressor-name field
        inspect("avc1", boxes(entry.payload + 78, entry.end), depth + 1);
      } else if (b.type === "avcC") {
        if (
          nalLength !== 0 ||
          body < 7 ||
          bytes[b.payload] !== 1 ||
          (bytes[b.payload + 1] !== 66 && !(imported && bytes[b.payload + 1] === 100))
        )
          fail("only baseline AVC configuration supported");
        if (
          ((bytes[b.payload + 4] ?? 0) & 0xfc) !== 0xfc ||
          ((bytes[b.payload + 5] ?? 0) & 0xe0) !== 0xe0
        )
          fail("AVC reserved bits");
        nalLength = ((bytes[b.payload + 4] ?? 0) & 3) + 1;
        let cursor = b.payload + 6;
        const readSets = (n: number, type: number): void => {
          if (n < 1 || n > 32) fail("AVC parameter set count");
          for (let i = 0; i < n; i++) {
            if (cursor + 2 > b.end) fail("AVC parameter length");
            const size = bytes.readUInt16BE(cursor);
            cursor += 2;
            if (cursor + size > b.end) fail("AVC parameter size");
            nal(cursor, cursor + size, type);
            if (
              imported &&
              type === 7 &&
              (size < 4 ||
                !bytes
                  .subarray(cursor + 1, cursor + 4)
                  .equals(bytes.subarray(b.payload + 1, b.payload + 4)))
            )
              fail("import SPS/configuration disagreement");
            cursor += size;
          }
        };
        readSets((bytes[b.payload + 5] ?? 0) & 31, 7);
        const pps = bytes[cursor++];
        if (pps === undefined) fail("AVC PPS count");
        readSets(pps, 8);
        if (imported && bytes[b.payload + 1] === 100 && cursor + 4 === b.end) {
          if (!bytes.subarray(cursor, b.end).equals(Buffer.from([0xfd, 0xf8, 0xf8, 0])))
            fail("unsupported high AVC chroma/bit depth/extension");
          cursor += 4;
        }
        if (cursor !== b.end) fail("AVC configuration trailing metadata");
      } else if (["moov", "trak", "mdia", "minf", "dinf", "stbl"].includes(b.type)) {
        if (b.type === "trak") tracks++;
        const nested = boxes(b.payload, b.end);
        if (imported) {
          const required: Readonly<Record<string, readonly string[]>> = {
            moov: ["mvhd", "trak"],
            trak: ["tkhd", "mdia"],
            mdia: ["mdhd", "hdlr", "minf"],
            minf: ["vmhd", "dinf", "stbl"],
            dinf: ["dref"],
            stbl: ["stsd", "stts", "stsc", "stsz"],
          };
          if (
            (required[b.type] ?? []).some(
              (name) => nested.filter((n) => n.type === name).length !== 1
            )
          )
            fail("missing import structure");
        }
        // No duplicated singleton boxes; a second chunk offset table also refuses.
        if (
          new Set(nested.map((x) => x.type)).size !== nested.length ||
          (nested.some((x) => x.type === "stco") && nested.some((x) => x.type === "co64"))
        )
          fail("duplicate MP4 boxes");
        inspect(b.type, nested, depth + 1);
      } else {
        // Fixed-size/full-box/table lengths prevent hiding arbitrary metadata after valid entries.
        if (b.type === "btrt") {
          if (body !== 12) fail("bitrate box length");
        } else if (b.type === "pasp") {
          if (
            body !== 8 ||
            bytes.readUInt32BE(b.payload) !== 1 ||
            bytes.readUInt32BE(b.payload + 4) !== 1
          )
            fail("pixel aspect ratio");
        } else if (b.type === "vmhd") {
          if (body !== 12 || bytes.readUInt32BE(b.payload) !== 1) fail("vmhd length/flags");
          zero(b.payload + 4, b.end);
        } else if (b.type === "stsz") {
          if (body < 12) fail("sample-size header");
          zero(b.payload, b.payload + 4);
          const n = bytes.readUInt32BE(b.payload + 8);
          positive(n, policy.max_frames, "sample count");
          if (body !== 12 + (bytes.readUInt32BE(b.payload + 4) === 0 ? n * 4 : 0))
            fail("sample-size table length");
        } else {
          if (body < 8) fail("MP4 table header");
          zero(b.payload, b.payload + 4);
          const n = bytes.readUInt32BE(b.payload + 4);
          positive(n, policy.max_frames, "MP4 table count");
          const width =
            b.type === "stts" || b.type === "ctts" || b.type === "co64"
              ? 8
              : b.type === "stsc"
                ? 12
                : 4;
          if (body !== 8 + n * width) fail("MP4 table length");
        }
      }
    }
  };
  const top = boxes(0, bytes.length);
  for (const required of ["ftyp", "moov", "mdat"])
    if (top.filter((b) => b.type === required).length !== 1) fail("MP4 top-level cardinality");
  inspect("root", top, 0);
  if (tracks !== 1 || nalLength === 0 || media.length !== 1)
    fail("MP4 track/configuration cardinality");
  // Reject coded metadata before asking a decoder to inspect a picture. The admitted
  // subset has one contiguous, fully referenced length-prefixed video payload.
  const data = media[0];
  if (data === undefined) fail("missing coded payload");
  let cursor = data.payload;
  while (cursor < data.end) {
    if (cursor + nalLength > data.end) fail("truncated coded metadata");
    const length = bytes.readUIntBE(cursor, nalLength);
    const start = cursor + nalLength;
    if (length < 2 || start + length > data.end) fail("invalid NAL extent");
    const header = bytes[start] ?? 0;
    if (imported && (header & 31) === 6 && (header & 0x80) === 0)
      inspectAvcImportSei(bytes.subarray(start, start + length));
    else if (![1, 5, 7, 8].includes(header & 31) || (header & 0x80) !== 0)
      fail("unapproved coded metadata or NAL type");
    cursor = start + length;
  }
  return { nal_length: nalLength, media_ranges: media };
}
export function inspectCanonicalPcmWav(bytes: Buffer, policy: MediaDecodePolicyV1): WavLayout {
  if (
    bytes.length > policy.max_input_bytes ||
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString("ascii", 8, 16) !== "WAVEfmt " ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.toString("ascii", 36, 40) !== "data" ||
    bytes.readUInt32LE(40) !== bytes.length - 44 ||
    bytes.readUInt16LE(34) !== 16
  )
    fail("only canonical PCM16 WAV supported");
  const channels = bytes.readUInt16LE(22);
  if (channels !== 1 && channels !== 2) fail("PCM channel count");
  const rate = positive(bytes.readUInt32LE(24), policy.max_sample_rate, "PCM sample rate");
  if (bytes.readUInt16LE(32) !== channels * 2 || bytes.readUInt32LE(28) !== rate * channels * 2)
    fail("PCM block/rate mismatch");
  const data = bytes.subarray(44);
  const samples = positive(data.length / (channels * 2), policy.max_samples, "PCM sample count");
  if (compareTime(rationalTime(BigInt(samples), BigInt(rate)), policy.max_duration) > 0)
    fail("PCM duration");
  return { channels, sample_rate: rate, samples, data };
}
export function canonicalPcmWav(data: Buffer, channels: 1 | 2, sampleRate: number): Buffer {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 1 ||
    sampleRate > 192000 ||
    data.length % (channels * 2) !== 0 ||
    data.length > 268_435_456
  )
    fail("PCM encode bounds");
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(data.length + 36, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
export function measurePcm16(data: Buffer): {
  readonly peak_abs_s16: number;
  readonly sum_squares: string;
} {
  if (data.length === 0 || data.length % 2 !== 0 || data.length > 268_435_456)
    fail("PCM measurement bounds");
  let peak = 0;
  let squares = 0n;
  for (let i = 0; i < data.length; i += 2) {
    const value = data.readInt16LE(i);
    peak = Math.max(peak, Math.abs(value));
    squares += BigInt(value) * BigInt(value);
  }
  return { peak_abs_s16: peak, sum_squares: String(squares) };
}
function probeJson(bytes: Buffer, limits: FoundationLimitsV1): Probe {
  if (bytes.length > limits.max_json_bytes) fail("probe JSON byte limit");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assertBoundedJson(value, limits);
  return validateSkillSchema(ProbeSchema, value, "media probe");
}
function parseTimeBase(value: string): RationalTime {
  if (!/^[1-9][0-9]{0,12}\/[1-9][0-9]{0,12}$/u.test(value)) fail("time base");
  const [n, d] = value.split("/");
  if (n === undefined || d === undefined) fail("time base");
  return rationalTime(BigInt(n), BigInt(d));
}
function at(tick: number, tb: RationalTime): RationalTime {
  return rationalTime(BigInt(tick) * BigInt(tb.numerator), BigInt(tb.denominator));
}
function exactIndex(t: RationalTime, rate: number, cap: number): number {
  const n = BigInt(t.numerator) * BigInt(rate);
  const d = BigInt(t.denominator);
  if (n < 0n || n % d !== 0n || n / d > BigInt(cap)) fail("span boundary not on sample grid");
  return Number(n / d);
}
/** Nearest actual decoded PTS within span; ties choose even global frame index. */
export function selectMediaFrames(
  pts: readonly RationalTime[],
  spans: RawMediaDecodeRequestV1["required_spans"],
  selection: MediaFrameSelectionV1,
  cap: number
): number[] {
  const chosen = new Set<number>();
  for (const s of spans) {
    const candidates = pts
      .map((p, i) => ({ p, i }))
      .filter((x) => compareTime(x.p, s.start) >= 0 && compareTime(x.p, s.end) < 0);
    const first = candidates[0];
    const last = candidates[candidates.length - 1];
    if (first === undefined || last === undefined) fail("span has no decoded frames");
    chosen.add(first.i);
    chosen.add(last.i);
    const targets = selection.timepoints.filter(
      (t) => compareTime(t, s.start) >= 0 && compareTime(t, s.end) < 0
    );
    for (let i = 1; i <= selection.midpoint_count; i++) {
      const delta = subtractTime(s.end, s.start);
      targets.push(
        addTime(
          s.start,
          rationalTime(
            BigInt(delta.numerator) * BigInt(i),
            BigInt(delta.denominator) * BigInt(selection.midpoint_count + 1)
          )
        )
      );
    }
    for (const target of targets) {
      let best = first;
      const distance = (p: RationalTime): RationalTime => {
        const d = subtractTime(p, target);
        return { numerator: Math.abs(d.numerator), denominator: d.denominator };
      };
      for (const candidate of candidates) {
        const cmp = compareTime(distance(candidate.p), distance(best.p));
        if (cmp < 0 || (cmp === 0 && candidate.i % 2 === 0 && best.i % 2 !== 0)) best = candidate;
      }
      chosen.add(best.i);
    }
  }
  if (
    selection.timepoints.some(
      (t) => !spans.some((s) => compareTime(t, s.start) >= 0 && compareTime(t, s.end) < 0)
    )
  )
    fail("selection timepoint outside approved spans");
  if (chosen.size > cap) fail("selected frame limit");
  return [...chosen].sort((a, b) => a - b);
}

/** Fully decodes current exact bytes, including bounded preroll/outside-used-span dependencies.
 * Outputs/measurements describe approved half-open spans only. No playback/rights assertion. */
export async function decodeMediaBytes(input: {
  readonly runner: ConfinedMediaRunner;
  readonly request: RawMediaDecodeRequestV1;
  readonly bytes: Uint8Array;
  readonly policy: MediaDecodePolicyV1;
  readonly selection: MediaFrameSelectionV1;
  readonly limits: FoundationLimitsV1;
  readonly signal: AbortSignal;
}): Promise<RawDecodedMediaV1> {
  if (!ConfinedMediaRunner.isTrusted(input.runner)) fail("concrete confined runner required");
  const policy = validateMediaPolicy(input.policy);
  const request = validateMediaRequest(input.request, policy);
  const selection = validateMediaSelection(input.selection, policy);
  if (
    sha256(canonicalJson(policy)) !== request.decode_policy_ref.content_digest ||
    sha256(canonicalJson(selection)) !== request.frame_selection_ref.content_digest
  )
    fail("decode operands drift");
  const bytes = Buffer.from(input.bytes);
  if (
    bytes.length !== request.media_ref.byte_length ||
    sha256(bytes) !== request.media_ref.content_digest ||
    bytes.length > policy.max_input_bytes
  )
    fail("source digest/length");
  const wav =
    request.media_ref.media_type === "audio/wav" ? inspectCanonicalPcmWav(bytes, policy) : null;
  if (wav === null && request.media_ref.media_type !== "video/mp4") fail("unsupported media type");
  const layout = wav === null ? inspectStrictAvcMp4(bytes, policy) : null;
  if (wav !== null && request.audio_policy !== "measure_pcm") fail("unexpected source audio");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(policy.max_elapsed_ms)]);
  const probeOutput = await input.runner.run({ verb: "probe", bytes, policy, signal });
  if (probeOutput.stderr.length !== 0) fail("probe diagnostics");
  const probe = probeJson(probeOutput.stdout, input.limits);
  const stream = probe.streams[0];
  if (
    stream === undefined ||
    stream.index !== 0 ||
    probe.packets.some((p) => p.stream_index !== stream.index)
  )
    fail("stream identity");
  if (
    Object.entries(stream.tags ?? {}).some(
      ([k, v]) =>
        !(
          (k === "language" && v === "und") ||
          (k === "handler_name" && v === "VideoHandler") ||
          (k === "vendor_id" && v === "[0][0][0][0]")
        )
    )
  )
    fail("stream metadata");
  if (
    Object.keys(probe.format.tags ?? {}).some(
      (k) => !["major_brand", "minor_version", "compatible_brands"].includes(k)
    )
  )
    fail("container metadata");
  if (
    Object.entries(stream.disposition ?? {}).some(
      ([key, value]) => key !== "default" && value !== 0
    )
  )
    fail("unsupported stream disposition");
  const outputs: { slot: string; media_type: "image/png" | "audio/wav"; bytes: Uint8Array }[] = [];
  let video: RawMediaDecodeResultV1["video"] = null;
  let audio: RawMediaDecodeResultV1["audio"] = null;
  if (wav !== null) {
    if (
      probe.format.format_name !== "wav" ||
      stream.codec_name !== "pcm_s16le" ||
      stream.codec_type !== "audio" ||
      Number(stream.sample_rate) !== wav.sample_rate ||
      stream.channels !== wav.channels
    )
      fail("PCM probe mismatch");
    const decoded = await input.runner.run({ verb: "audio_s16le", bytes, policy, signal });
    if (
      decoded.stderr.length !== 0 ||
      !decoded.stdout.equals(wav.data) ||
      decoded.stdout.length > policy.max_decoded_bytes
    )
      fail("PCM decode mismatch");
    const duration = rationalTime(BigInt(wav.samples), BigInt(wav.sample_rate));
    audio = {
      codec: "canonical_pcm",
      channels: wav.channels === 1 ? "mono" : "stereo",
      sample_rate: wav.sample_rate,
      decoded_sample_count: wav.samples,
      duration,
      spans: [],
    };
    for (const [i, s] of request.required_spans.entries()) {
      if (compareTime(s.end, duration) > 0) fail("audio span exceeds decoded duration");
      const start = exactIndex(s.start, wav.sample_rate, wav.samples);
      const end = exactIndex(s.end, wav.sample_rate, wav.samples);
      const data = decoded.stdout.subarray(start * wav.channels * 2, end * wav.channels * 2);
      const slot = `pcm-${i}`;
      audio.spans.push({ start_sample: start, end_sample: end, slot, ...measurePcm16(data) });
      outputs.push({
        slot,
        media_type: "audio/wav",
        bytes: canonicalPcmWav(data, wav.channels, wav.sample_rate),
      });
    }
  } else {
    if (
      layout === null ||
      probe.format.format_name !== "mov,mp4,m4a,3gp,3g2,mj2" ||
      stream.codec_type !== "video" ||
      stream.codec_name !== "h264" ||
      stream.pix_fmt !== "yuv420p"
    )
      fail("unsupported video stream");
    const width = positive(stream.width ?? 0, policy.max_width, "video width");
    const height = positive(stream.height ?? 0, policy.max_height, "video height");
    positive(width * height, policy.max_pixels, "pixel count");
    const count = positive(probe.packets.length, policy.max_frames, "video frame count");
    if (Number(stream.nb_frames) !== count || width * height * 4 * count > policy.max_decoded_bytes)
      fail("decoded representation limit/frame count");
    const tb = parseTimeBase(stream.time_base);
    let next = 0;
    let delta: number | undefined;
    const pts: RationalTime[] = [];
    const ranges: { start: number; end: number }[] = [];
    for (const packet of probe.packets) {
      if (
        packet.pts !== next ||
        packet.dts !== packet.pts ||
        packet.duration < 1 ||
        (delta !== undefined && packet.duration !== delta)
      )
        fail("only contiguous zero-based CFR without reordering supported");
      delta = packet.duration;
      next += packet.duration;
      if (!Number.isSafeInteger(next)) fail("video timestamp overflow");
      pts.push(at(packet.pts, tb));
      const start = Number(packet.pos);
      const end = start + Number(packet.size);
      if (
        !Number.isSafeInteger(end) ||
        !layout.media_ranges.some((m) => start >= m.payload && end <= m.end && start < end)
      )
        fail("packet outside mdat");
      let cursor = start;
      let picture = false;
      while (cursor < end) {
        if (cursor + layout.nal_length > end) fail("NAL header truncated");
        const size = bytes.readUIntBE(cursor, layout.nal_length);
        cursor += layout.nal_length;
        if (size < 1 || cursor + size > end) fail("NAL payload bounds");
        const type = (bytes[cursor] ?? 0) & 31;
        if ((bytes[cursor] ?? 0) >> 7 !== 0 || ![1, 5, 7, 8, 9].includes(type))
          fail("unapproved coded metadata/NAL");
        if (type === 1 || type === 5) picture = true;
        cursor += size;
      }
      if (!picture) fail("packet without coded picture");
      ranges.push({ start, end });
    }
    ranges.sort((a, b) => a.start - b.start);
    const media = layout.media_ranges[0];
    if (media === undefined) fail("missing media range");
    let covered = media.payload;
    for (const range of ranges) {
      if (range.start !== covered) fail("unreferenced/overlapping mdat bytes");
      covered = range.end;
    }
    if (covered !== media.end) fail("unreferenced media tail");
    const duration = at(next, tb);
    if (
      stream.duration_ts !== next ||
      compareTime(duration, policy.max_duration) > 0 ||
      request.required_spans.some((s) => compareTime(s.end, duration) > 0)
    )
      fail("video duration/span mismatch");
    const structural = validateMp4Video(bytes, {
      width,
      height,
      frame_count: count,
      fps: (count * duration.denominator) / duration.numerator,
      max_bytes: policy.max_input_bytes,
    });
    if (structural.status !== "valid") fail("retained MP4 structural admission");
    const selected = selectMediaFrames(
      pts,
      request.required_spans,
      selection,
      policy.max_selected_frames
    );
    const decoded = await input.runner.run({ verb: "video_rgba", bytes, policy, signal });
    if (decoded.stdout.length !== width * height * 4 * count)
      fail("full video decode byte/frame count");
    const log = decoded.stderr.toString("utf8");
    const match = /config in time_base: ([0-9]+)\/([0-9]+)/u.exec(log);
    if (match === null || `${match[1]}/${match[2]}` !== `${tb.numerator}/${tb.denominator}`)
      fail("decoder time base mismatch");
    const observed = [...log.matchAll(/\bn:\s*([0-9]+)\s+pts:\s*(-?[0-9]+)\s+pts_time:/gu)];
    if (
      observed.length !== count ||
      observed.some(
        (m, i) =>
          Number(m[1]) !== i ||
          compareTime(at(Number(m[2]), tb), pts[i] ?? fail("missing PTS")) !== 0
      )
    )
      fail("decoded PTS count/identity");
    const pngLimits = resolvePngMediaLimits(
      {},
      {
        maxWidth: policy.max_width,
        maxHeight: policy.max_height,
        maxPixels: policy.max_pixels,
        maxSourceBytes: Math.min(policy.max_output_bytes, 67_108_864),
        maxCompressedBytes: Math.min(policy.max_output_bytes, 67_108_864),
        maxDecompressedBytes: Math.min(policy.max_decoded_bytes, 71_303_168),
      }
    );
    video = {
      codec: "h264",
      width,
      height,
      decoded_frame_count: count,
      time_base: tb,
      duration,
      frames: [],
    };
    for (const index of selected) {
      signal.throwIfAborted();
      const slot = `frame-${index}`;
      const png = encodeCanonicalPng({
        width,
        height,
        rgba: decoded.stdout.subarray(index * width * height * 4, (index + 1) * width * height * 4),
        limits: pngLimits,
      });
      validateCanonicalPng(png, pngLimits);
      video.frames.push({ index, pts: pts[index] ?? fail("missing selected PTS"), slot });
      outputs.push({ slot, media_type: "image/png", bytes: png });
    }
  }
  if (outputs.reduce((n, o) => n + o.bytes.length, 0) > policy.max_output_bytes)
    fail("media output byte limit");
  const result = validateSkillSchema(
    RawMediaDecodeResultV1Schema,
    {
      schema_id: "penny.videogen-raw-media-decode-result.v1",
      schema_version: 1,
      operation_id: request.operation_id,
      source_ref: request.media_ref,
      request_sha256: sha256(canonicalJson(request)),
      policy_sha256: request.decode_policy_ref.content_digest,
      selection_sha256: request.frame_selection_ref.content_digest,
      required_spans: request.required_spans,
      decode_scope: "entire_source_including_preroll",
      container_policy: policy.metadata_policy,
      video,
      audio,
      outputs: outputs.map((o) => ({
        slot: o.slot,
        media_type: o.media_type,
        sha256: sha256(o.bytes),
        byte_length: o.bytes.length,
      })),
      qualification: "raw_decode_only_not_playback_or_production",
    },
    "raw decode result"
  );
  if (
    Buffer.byteLength(canonicalJson(result)) + outputs.reduce((n, o) => n + o.bytes.length, 0) >
    policy.max_output_bytes
  )
    fail("result/output aggregate limit");
  signal.throwIfAborted();
  return { result, outputs };
}

export interface RawMediaAdapterBindingV1 {
  readonly adapter_id: string;
  readonly backend_binding_id: string;
  readonly backend_key_sha256: string;
  readonly policy_ref: ArtifactRef;
  readonly policy: MediaDecodePolicyV1;
  readonly runner: ConfinedMediaRunner;
  readonly limits: FoundationLimitsV1;
}
/** Opt-in raw primitive; DOES NOT authorize production/gates/rights or install a registration.
 * Existing owner persists raw result + exact outputs first, then its own settled receipt.
 * Receipt-citing domain wrapping is a separate post-settlement continuation in media-evidence.ts. */
export function createRawMediaDecodeAdapter(
  binding: RawMediaAdapterBindingV1
): HostOperationAdapterV1 {
  if (!ConfinedMediaRunner.isTrusted(binding.runner)) fail("confined runner binding absent");
  const policy = validateMediaPolicy(structuredClone(binding.policy));
  const policyRef = structuredClone(binding.policy_ref);
  const limits = structuredClone(binding.limits);
  if (sha256(canonicalJson(policy)) !== policyRef.content_digest) fail("policy binding digest");
  const parse = (bytes: Uint8Array): RawMediaDecodeRequestV1 =>
    validateMediaRequest(parseMediaJson(RawMediaDecodeRequestV1Schema, bytes, limits), policy);
  const inspect: HostOperationAdapterV1["inspectRequest"] = (input) => {
    const request = parse(input.request_bytes);
    const d = input.directive;
    if (
      d.operation_kind !== "media_decode_extract" ||
      d.operation_id !== request.operation_id ||
      canonicalJson(d.expected_result) !== canonicalJson(RAW_MEDIA_RESULT_CONTRACT) ||
      canonicalJson(input.declaration.request) !== canonicalJson(RAW_MEDIA_REQUEST_CONTRACT) ||
      !sameRef(request.decode_policy_ref, policyRef)
    )
      fail("raw decode registration/request identity");
    const expected = [
      { slot: "media", ref: request.media_ref },
      { slot: "decode-policy", ref: request.decode_policy_ref },
      { slot: "frame-selection", ref: request.frame_selection_ref },
    ];
    if (canonicalJson(d.input_artifacts.artifacts) !== canonicalJson(expected))
      fail("raw decode exact input slots");
    return {
      schema_version: 1,
      operation_kind: "media_decode_extract",
      adapter_id: binding.adapter_id,
      backend_binding_id: binding.backend_binding_id,
      backend_key_sha256: binding.backend_key_sha256,
    };
  };
  return {
    adapter_id: binding.adapter_id,
    inspectRequest: inspect,
    async run(context: HostOperationExecutionContextV1) {
      if (!isCanonicalHostOperationExecutionContextV1(context))
        fail("existing owner execution custody required");
      inspect({
        directive: context.directive,
        declaration: context.declaration,
        request_bytes: context.request_bytes,
        input_artifacts: context.directive.input_artifacts,
      });
      // Exact crash after persist is adopted by the existing owner before adapter re-entry.
      // Earlier local decode is disposable; no remote job or media source is discovered/retried.
      if (context.journal.lifecycle !== "lease_acquired")
        fail("raw decode interrupted before persistence; explicit fresh operation required");
      const request = parse(context.request_bytes);
      const actualPolicy = parseMediaJson(
        MediaDecodePolicyV1Schema,
        context.readInput("decode-policy").bytes,
        limits
      );
      if (canonicalJson(actualPolicy) !== canonicalJson(policy))
        fail("current decode policy drift");
      const selection = parseMediaJson(
        MediaFrameSelectionV1Schema,
        context.readInput("frame-selection").bytes,
        limits
      );
      context.beginSubmission();
      let closed = false;
      context.registerRemoteCancellation(async () =>
        closed
          ? { remote_disposition: "proven_terminal", reason_code: "local_decode_processes_closed" }
          : { remote_disposition: "may_continue", reason_code: "local_decode_cleanup_pending" }
      );
      let decoded: RawDecodedMediaV1;
      try {
        decoded = await decodeMediaBytes({
          runner: binding.runner,
          request,
          bytes: context.readInput("media").bytes,
          policy,
          selection,
          limits,
          signal: context.signal,
        }).finally(() => {
          closed = true;
        });
      } catch {
        // A settled rejection here means every started local subprocess reached close and its
        // staging was reclaimed. No remote target was submitted. If the owner already aborted,
        // keep its conservative cancellation/quarantine path instead of racing late acceptance.
        context.signal.throwIfAborted();
        return {
          disposition: {
            outcome: "failed",
            remote_disposition: "proven_terminal",
            lease_disposition: "released",
            retryable: false,
            reason_code: "media_decode_refused",
          },
          operation_result_ref: null,
          output_artifacts: [],
        };
      }
      context.reportActivity("full_media_decode", 1);
      const text = canonicalJson(decoded.result);
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(text),
        byte_length: Buffer.byteLength(text),
        item_count: decoded.outputs.length,
        poll_count: 0,
      });
      // The generic owner requires terminal proof after its guard even for local-only work.
      // All subprocesses have actually closed; there is no invented remote acceptance/correlation.
      const disposition = {
        outcome: "completed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        retryable: false,
        reason_code: null,
      } as const;
      const persisted = context.persist({
        disposition,
        operation_result: {
          contract: RAW_MEDIA_RESULT_CONTRACT,
          media_type: "application/json",
          content: text,
        },
        outputs: decoded.outputs.map((o) => ({
          contract: o.media_type === "image/png" ? MEDIA_FRAME_CONTRACT : MEDIA_PCM_CONTRACT,
          media_type: o.media_type,
          content: o.bytes,
        })),
      });
      return { disposition, ...persisted };
    },
  };
}
