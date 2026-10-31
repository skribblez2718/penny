import { sha256 } from "./canonical-json.js";

const CONTAINER_TYPES = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
const VIDEO_SAMPLE_ENTRIES = new Set(["avc1", "avc3", "hvc1", "hev1"]);
const COMPATIBLE_BRANDS = new Set(["isom", "iso2", "mp41", "mp42", "avc1"]);

export interface ExpectedMp4VideoV1 {
  readonly width: number;
  readonly height: number;
  readonly frame_count: number;
  readonly fps: number;
  readonly max_bytes: number;
}

export interface Mp4VideoMetadataV1 {
  readonly container: "iso-bmff";
  readonly codec: "h264" | "hevc";
  readonly width: number;
  readonly height: number;
  readonly frame_count: number;
  readonly fps: number;
  readonly duration_seconds: number;
  readonly major_brand: string;
  readonly compatible_brands: readonly string[];
  readonly byte_length: number;
  readonly sha256: string;
}

export type Mp4ValidationResultV1 =
  | { readonly status: "valid"; readonly metadata: Mp4VideoMetadataV1 }
  | {
      readonly status: "invalid";
      readonly reason_code:
        | "empty_media"
        | "media_too_large"
        | "malformed_iso_bmff"
        | "unsupported_brand"
        | "required_box_missing"
        | "video_track_cardinality_invalid"
        | "unsupported_video_codec"
        | "video_metadata_missing"
        | "dimensions_mismatch"
        | "frame_count_mismatch"
        | "frame_rate_mismatch"
        | "duration_mismatch";
      readonly detail: string;
      readonly byte_length: number;
      readonly sha256: string;
    };

interface BoxV1 {
  readonly type: string;
  readonly start: number;
  readonly payload_start: number;
  readonly end: number;
}

interface TrackV1 {
  readonly handler: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly timescale: number | null;
  readonly duration: number | null;
  readonly sample_count: number | null;
  readonly timing_sample_count: number | null;
  readonly sample_duration: number | null;
  readonly codec: string | null;
  readonly nal_length_bytes: number | null;
  readonly sample_sizes: readonly number[] | null;
  readonly chunk_offsets: readonly number[] | null;
  readonly samples_per_chunk:
    | readonly {
        readonly first_chunk: number;
        readonly samples_per_chunk: number;
      }[]
    | null;
}

class Mp4ParseError extends Error {}

function invalid(
  bytes: Uint8Array,
  reason_code: Exclude<Mp4ValidationResultV1, { readonly status: "valid" }>["reason_code"],
  detail: string
): Mp4ValidationResultV1 {
  return {
    status: "invalid",
    reason_code,
    detail,
    byte_length: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function readU8(bytes: Buffer, offset: number, end: number): number {
  if (offset < 0 || offset + 1 > end) throw new Mp4ParseError("truncated 8-bit field");
  return bytes.readUInt8(offset);
}

function readU32(bytes: Buffer, offset: number, end: number): number {
  if (offset < 0 || offset + 4 > end) throw new Mp4ParseError("truncated 32-bit field");
  return bytes.readUInt32BE(offset);
}

function readU64(bytes: Buffer, offset: number, end: number): number {
  if (offset < 0 || offset + 8 > end) throw new Mp4ParseError("truncated 64-bit field");
  const value = bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Mp4ParseError("64-bit field is too large");
  return Number(value);
}

function fourcc(bytes: Buffer, offset: number, end: number): string {
  if (offset < 0 || offset + 4 > end) throw new Mp4ParseError("truncated box type");
  const value = bytes.toString("latin1", offset, offset + 4);
  if (!/^[\x20-\x7e]{4}$/u.test(value)) throw new Mp4ParseError("box type is not printable ASCII");
  return value;
}

function parseBoxes(
  bytes: Buffer,
  start: number,
  end: number,
  state: { count: number },
  depth = 0
): BoxV1[] {
  if (depth > 8) throw new Mp4ParseError("box nesting exceeds the supported depth");
  const boxes: BoxV1[] = [];
  let offset = start;
  while (offset < end) {
    state.count += 1;
    if (state.count > 20_000) throw new Mp4ParseError("box count exceeds the supported limit");
    if (end - offset < 8) throw new Mp4ParseError("trailing bytes do not form a complete box");
    const size32 = readU32(bytes, offset, end);
    const type = fourcc(bytes, offset + 4, end);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      size = readU64(bytes, offset + 8, end);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      throw new Mp4ParseError(`box '${type}' has an invalid size`);
    }
    const box = { type, start: offset, payload_start: offset + headerSize, end: offset + size };
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

function children(bytes: Buffer, box: BoxV1, state: { count: number }, depth: number): BoxV1[] {
  if (!CONTAINER_TYPES.has(box.type)) return [];
  return parseBoxes(bytes, box.payload_start, box.end, state, depth + 1);
}

function parseTrack(bytes: Buffer, trak: BoxV1, state: { count: number }): TrackV1 {
  let handler: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let timescale: number | null = null;
  let duration: number | null = null;
  let sampleCount: number | null = null;
  let timingSampleCount: number | null = null;
  let sampleDuration: number | null = null;
  let codec: string | null = null;
  let nalLengthBytes: number | null = null;
  let sampleSizes: number[] | null = null;
  let chunkOffsets: number[] | null = null;
  let samplesPerChunk: Array<{
    readonly first_chunk: number;
    readonly samples_per_chunk: number;
  }> | null = null;

  for (const box of children(bytes, trak, state, 1)) {
    if (box.type === "tkhd") {
      const version = bytes[box.payload_start];
      if (version !== 0 && version !== 1) throw new Mp4ParseError("unsupported tkhd version");
      const widthOffset = box.payload_start + (version === 1 ? 88 : 76);
      width = readU32(bytes, widthOffset, box.end) / 65_536;
      height = readU32(bytes, widthOffset + 4, box.end) / 65_536;
      continue;
    }
    if (box.type !== "mdia") continue;
    for (const mdiaBox of children(bytes, box, state, 2)) {
      if (mdiaBox.type === "hdlr") {
        handler = fourcc(bytes, mdiaBox.payload_start + 8, mdiaBox.end);
      } else if (mdiaBox.type === "mdhd") {
        const version = bytes[mdiaBox.payload_start];
        if (version !== 0 && version !== 1) throw new Mp4ParseError("unsupported mdhd version");
        const timescaleOffset = mdiaBox.payload_start + (version === 1 ? 20 : 12);
        timescale = readU32(bytes, timescaleOffset, mdiaBox.end);
        duration =
          version === 1
            ? readU64(bytes, timescaleOffset + 4, mdiaBox.end)
            : readU32(bytes, timescaleOffset + 4, mdiaBox.end);
      } else if (mdiaBox.type === "minf") {
        for (const minfBox of children(bytes, mdiaBox, state, 3)) {
          if (minfBox.type !== "stbl") continue;
          for (const stblBox of children(bytes, minfBox, state, 4)) {
            if (stblBox.type === "stsd") {
              const entryCount = readU32(bytes, stblBox.payload_start + 4, stblBox.end);
              if (entryCount !== 1) throw new Mp4ParseError("video sample-entry count is not one");
              const entryStart = stblBox.payload_start + 8;
              const entrySize = readU32(bytes, entryStart, stblBox.end);
              codec = fourcc(bytes, entryStart + 4, stblBox.end);
              if (entrySize < 86 || entryStart + entrySize > stblBox.end) {
                throw new Mp4ParseError("video sample entry is malformed");
              }
              const codecBoxes = parseBoxes(
                bytes,
                entryStart + 86,
                entryStart + entrySize,
                state,
                6
              );
              const configurationType = codec.startsWith("avc") ? "avcC" : "hvcC";
              const configurations = codecBoxes.filter((box) => box.type === configurationType);
              if (configurations.length !== 1) {
                throw new Mp4ParseError("video codec configuration is missing or duplicated");
              }
              const configuration = configurations[0];
              if (configuration === undefined)
                throw new Mp4ParseError("video codec configuration is absent");
              if (configurationType === "avcC") {
                if (configuration.end - configuration.payload_start < 7) {
                  throw new Mp4ParseError("AVC configuration is truncated");
                }
                nalLengthBytes =
                  (readU8(bytes, configuration.payload_start + 4, configuration.end) & 0x03) + 1;
                const sequenceCount =
                  readU8(bytes, configuration.payload_start + 5, configuration.end) & 0x1f;
                if (sequenceCount < 1)
                  throw new Mp4ParseError("AVC configuration has no sequence set");
              } else {
                if (configuration.end - configuration.payload_start < 23) {
                  throw new Mp4ParseError("HEVC configuration is truncated");
                }
                nalLengthBytes =
                  (readU8(bytes, configuration.payload_start + 21, configuration.end) & 0x03) + 1;
              }
            } else if (stblBox.type === "stsz") {
              const fixedSampleSize = readU32(bytes, stblBox.payload_start + 4, stblBox.end);
              sampleCount = readU32(bytes, stblBox.payload_start + 8, stblBox.end);
              if (sampleCount < 1 || sampleCount > 1_000_000) {
                throw new Mp4ParseError("sample count is outside the supported limit");
              }
              const needed =
                stblBox.payload_start + 12 + (fixedSampleSize === 0 ? sampleCount * 4 : 0);
              if (needed > stblBox.end) throw new Mp4ParseError("sample-size table is truncated");
              sampleSizes = [];
              for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
                const sampleSize =
                  fixedSampleSize === 0
                    ? readU32(bytes, stblBox.payload_start + 12 + sampleIndex * 4, stblBox.end)
                    : fixedSampleSize;
                if (sampleSize < 1) throw new Mp4ParseError("video sample has an empty payload");
                sampleSizes.push(sampleSize);
              }
            } else if (stblBox.type === "stsc") {
              const entryCount = readU32(bytes, stblBox.payload_start + 4, stblBox.end);
              if (entryCount < 1 || entryCount > 100_000) {
                throw new Mp4ParseError("sample-to-chunk entry count is invalid");
              }
              samplesPerChunk = [];
              let previousFirstChunk = 0;
              for (let index = 0; index < entryCount; index += 1) {
                const offset = stblBox.payload_start + 8 + index * 12;
                const firstChunk = readU32(bytes, offset, stblBox.end);
                const count = readU32(bytes, offset + 4, stblBox.end);
                const descriptionIndex = readU32(bytes, offset + 8, stblBox.end);
                if (firstChunk <= previousFirstChunk || count < 1 || descriptionIndex !== 1) {
                  throw new Mp4ParseError("sample-to-chunk entry is invalid");
                }
                previousFirstChunk = firstChunk;
                samplesPerChunk.push({ first_chunk: firstChunk, samples_per_chunk: count });
              }
              if (samplesPerChunk[0]?.first_chunk !== 1) {
                throw new Mp4ParseError("sample-to-chunk table does not begin at chunk one");
              }
            } else if (stblBox.type === "stco" || stblBox.type === "co64") {
              const entryCount = readU32(bytes, stblBox.payload_start + 4, stblBox.end);
              if (entryCount < 1 || entryCount > 1_000_000) {
                throw new Mp4ParseError("chunk-offset entry count is invalid");
              }
              chunkOffsets = [];
              const width = stblBox.type === "stco" ? 4 : 8;
              for (let index = 0; index < entryCount; index += 1) {
                const offset = stblBox.payload_start + 8 + index * width;
                chunkOffsets.push(
                  width === 4
                    ? readU32(bytes, offset, stblBox.end)
                    : readU64(bytes, offset, stblBox.end)
                );
              }
            } else if (stblBox.type === "stts") {
              const entryCount = readU32(bytes, stblBox.payload_start + 4, stblBox.end);
              if (entryCount < 1 || entryCount > 20_000) {
                throw new Mp4ParseError("time-to-sample entry count is invalid");
              }
              let cursor = stblBox.payload_start + 8;
              let totalSamples = 0;
              let totalDuration = 0;
              for (let index = 0; index < entryCount; index += 1) {
                const count = readU32(bytes, cursor, stblBox.end);
                const delta = readU32(bytes, cursor + 4, stblBox.end);
                cursor += 8;
                totalSamples += count;
                totalDuration += count * delta;
                if (!Number.isSafeInteger(totalSamples) || !Number.isSafeInteger(totalDuration)) {
                  throw new Mp4ParseError("time-to-sample totals exceed the safe integer range");
                }
              }
              timingSampleCount = totalSamples;
              sampleDuration = totalDuration;
            }
          }
        }
      }
    }
  }
  return {
    handler,
    width,
    height,
    timescale,
    duration,
    sample_count: sampleCount,
    timing_sample_count: timingSampleCount,
    sample_duration: sampleDuration,
    codec,
    nal_length_bytes: nalLengthBytes,
    sample_sizes: sampleSizes,
    chunk_offsets: chunkOffsets,
    samples_per_chunk: samplesPerChunk,
  };
}

function sampleRanges(
  track: TrackV1
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  if (
    track.sample_sizes === null ||
    track.chunk_offsets === null ||
    track.samples_per_chunk === null
  ) {
    throw new Mp4ParseError("video sample tables are incomplete");
  }
  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  let sampleIndex = 0;
  for (let chunkIndex = 1; chunkIndex <= track.chunk_offsets.length; chunkIndex += 1) {
    let mapping = track.samples_per_chunk[0];
    for (const candidate of track.samples_per_chunk) {
      if (candidate.first_chunk > chunkIndex) break;
      mapping = candidate;
    }
    if (mapping === undefined) throw new Mp4ParseError("chunk has no sample mapping");
    let offset = track.chunk_offsets[chunkIndex - 1];
    if (offset === undefined) throw new Mp4ParseError("chunk offset is absent");
    for (let inChunk = 0; inChunk < mapping.samples_per_chunk; inChunk += 1) {
      const size = track.sample_sizes[sampleIndex];
      if (size === undefined) throw new Mp4ParseError("chunk mapping exceeds the sample table");
      ranges.push({ start: offset, end: offset + size });
      offset += size;
      sampleIndex += 1;
    }
  }
  if (sampleIndex !== track.sample_sizes.length) {
    throw new Mp4ParseError("chunk mapping does not cover every video sample");
  }
  return ranges;
}

function validateNalSamples(
  bytes: Buffer,
  track: TrackV1,
  ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  mediaRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>
): void {
  if (track.codec === null || track.nal_length_bytes === null) {
    throw new Mp4ParseError("video NAL configuration is absent");
  }
  let keyframes = 0;
  for (const range of ranges) {
    if (
      !mediaRanges.some(
        (media) => range.start >= media.start && range.end <= media.end && range.start < range.end
      )
    ) {
      throw new Mp4ParseError("video sample points outside an mdat payload");
    }
    let cursor = range.start;
    let hasVcl = false;
    while (cursor < range.end) {
      if (cursor + track.nal_length_bytes > range.end) {
        throw new Mp4ParseError("NAL length field is truncated");
      }
      let nalSize = 0;
      for (let index = 0; index < track.nal_length_bytes; index += 1) {
        nalSize = nalSize * 256 + readU8(bytes, cursor + index, range.end);
      }
      cursor += track.nal_length_bytes;
      if (nalSize < 1 || cursor + nalSize > range.end) {
        throw new Mp4ParseError("NAL payload length is invalid");
      }
      const header = readU8(bytes, cursor, range.end);
      if (track.codec.startsWith("avc")) {
        const type = header & 0x1f;
        if (type >= 1 && type <= 5) hasVcl = true;
        if (type === 5) keyframes += 1;
      } else {
        const type = (header >> 1) & 0x3f;
        if (type <= 31) hasVcl = true;
        if (type >= 16 && type <= 21) keyframes += 1;
      }
      cursor += nalSize;
    }
    if (!hasVcl) throw new Mp4ParseError("video sample contains no coded picture NAL unit");
  }
  if (keyframes < 1)
    throw new Mp4ParseError("video track contains no independently decodable frame");
}

function assertExpected(expected: ExpectedMp4VideoV1): void {
  for (const [name, value] of Object.entries(expected)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`expected MP4 ${name} is invalid`);
  }
  if (
    !Number.isSafeInteger(expected.width) ||
    !Number.isSafeInteger(expected.height) ||
    !Number.isSafeInteger(expected.frame_count) ||
    !Number.isSafeInteger(expected.max_bytes) ||
    expected.width > 16_384 ||
    expected.height > 16_384 ||
    expected.frame_count > 1_000_000 ||
    expected.max_bytes > 4_294_967_296
  ) {
    throw new Error("expected MP4 constraints exceed the supported limits");
  }
}

export function validateMp4Video(
  input: Uint8Array,
  expected: ExpectedMp4VideoV1
): Mp4ValidationResultV1 {
  assertExpected(expected);
  if (input.byteLength === 0) return invalid(input, "empty_media", "video output is empty");
  if (input.byteLength > expected.max_bytes) {
    return invalid(input, "media_too_large", "video output exceeds the configured byte limit");
  }

  const bytes = Buffer.from(input);
  try {
    const state = { count: 0 };
    const top = parseBoxes(bytes, 0, bytes.byteLength, state);
    const ftypBoxes = top.filter((box) => box.type === "ftyp");
    const moovBoxes = top.filter((box) => box.type === "moov");
    const mdatBoxes = top.filter((box) => box.type === "mdat");
    if (ftypBoxes.length !== 1 || moovBoxes.length !== 1 || mdatBoxes.length < 1) {
      return invalid(
        input,
        "required_box_missing",
        "MP4 must contain exactly one ftyp and moov box and at least one mdat box"
      );
    }
    if (mdatBoxes.every((box) => box.payload_start === box.end)) {
      return invalid(input, "required_box_missing", "MP4 media-data boxes are empty");
    }
    const ftyp = ftypBoxes[0];
    if (
      ftyp === undefined ||
      ftyp.end - ftyp.payload_start < 8 ||
      (ftyp.end - ftyp.payload_start) % 4 !== 0
    ) {
      throw new Mp4ParseError("ftyp box is malformed");
    }
    const majorBrand = fourcc(bytes, ftyp.payload_start, ftyp.end);
    const compatibleBrands: string[] = [];
    for (let offset = ftyp.payload_start + 8; offset < ftyp.end; offset += 4) {
      compatibleBrands.push(fourcc(bytes, offset, ftyp.end));
    }
    if (
      !COMPATIBLE_BRANDS.has(majorBrand) &&
      !compatibleBrands.some((brand) => COMPATIBLE_BRANDS.has(brand))
    ) {
      return invalid(input, "unsupported_brand", "MP4 has no supported ISO base-media brand");
    }

    const moov = moovBoxes[0];
    if (moov === undefined) throw new Mp4ParseError("moov box is absent");
    const tracks = children(bytes, moov, state, 1)
      .filter((box) => box.type === "trak")
      .map((box) => parseTrack(bytes, box, state));
    const videoTracks = tracks.filter((track) => track.handler === "vide");
    if (videoTracks.length !== 1) {
      return invalid(
        input,
        "video_track_cardinality_invalid",
        "MP4 must contain exactly one video track"
      );
    }
    const track = videoTracks[0];
    if (track === undefined) throw new Mp4ParseError("video track is absent");
    if (track.codec === null || !VIDEO_SAMPLE_ENTRIES.has(track.codec)) {
      return invalid(input, "unsupported_video_codec", "video track is not H.264 or HEVC");
    }
    if (
      track.width === null ||
      track.height === null ||
      track.timescale === null ||
      track.timescale <= 0 ||
      track.duration === null ||
      track.duration <= 0 ||
      track.sample_count === null ||
      track.sample_count <= 0 ||
      track.timing_sample_count === null ||
      track.timing_sample_count <= 0 ||
      track.sample_duration === null ||
      track.sample_duration <= 0 ||
      track.sample_sizes === null ||
      track.sample_sizes.length !== track.sample_count ||
      track.chunk_offsets === null ||
      track.samples_per_chunk === null ||
      track.nal_length_bytes === null
    ) {
      return invalid(input, "video_metadata_missing", "required video track metadata is absent");
    }
    if (!Number.isInteger(track.width) || !Number.isInteger(track.height)) {
      return invalid(input, "video_metadata_missing", "video dimensions are not integral pixels");
    }
    if (track.timing_sample_count !== track.sample_count) {
      return invalid(
        input,
        "malformed_iso_bmff",
        "time-to-sample and sample-size tables disagree on frame count"
      );
    }
    if (track.width !== expected.width || track.height !== expected.height) {
      return invalid(input, "dimensions_mismatch", "video dimensions do not match the request");
    }
    if (track.sample_count !== expected.frame_count) {
      return invalid(input, "frame_count_mismatch", "video frame count does not match the request");
    }
    const ranges = sampleRanges(track);
    validateNalSamples(
      bytes,
      track,
      ranges,
      mdatBoxes.map((box) => ({ start: box.payload_start, end: box.end }))
    );
    if (Math.abs(track.duration - track.sample_duration) > 1) {
      return invalid(input, "duration_mismatch", "track and sample-table durations disagree");
    }
    const durationSeconds = track.sample_duration / track.timescale;
    const fps = track.sample_count / durationSeconds;
    const frameDuration = 1 / expected.fps;
    if (Math.abs(fps - expected.fps) > Math.max(0.001, expected.fps * 0.0001)) {
      return invalid(input, "frame_rate_mismatch", "video frame rate does not match the request");
    }
    const expectedDuration = expected.frame_count / expected.fps;
    if (Math.abs(durationSeconds - expectedDuration) > frameDuration / 2) {
      return invalid(input, "duration_mismatch", "video duration does not match the request");
    }
    return {
      status: "valid",
      metadata: {
        container: "iso-bmff",
        codec: track.codec.startsWith("avc") ? "h264" : "hevc",
        width: track.width,
        height: track.height,
        frame_count: track.sample_count,
        fps,
        duration_seconds: durationSeconds,
        major_brand: majorBrand,
        compatible_brands: compatibleBrands,
        byte_length: input.byteLength,
        sha256: sha256(input),
      },
    };
  } catch (error) {
    if (error instanceof Mp4ParseError) {
      return invalid(input, "malformed_iso_bmff", error.message);
    }
    throw error;
  }
}
