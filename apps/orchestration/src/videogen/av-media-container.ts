import { avVideoStep, validateAvMediaPolicy, type AvMediaPolicyV1 } from "./av-media-contracts.js";
import { compareTime, rationalTime, type RationalTime } from "./rational-time.js";

export interface AvSampleV1 {
  readonly pos: number;
  readonly size: number;
  readonly pts: number;
  readonly duration: number;
}
export interface AvTrackV1 {
  readonly id: 1 | 2;
  readonly timescale: number;
  readonly duration_ticks: number;
  readonly duration: RationalTime;
  readonly step: number;
  readonly samples: readonly AvSampleV1[];
}
export interface AvLayoutV1 {
  readonly video: AvTrackV1;
  readonly audio: AvTrackV1;
  readonly width: number;
  readonly height: number;
}
interface Box {
  type: string;
  start: number;
  p: number;
  end: number;
}
export function avRefuse(reason: string): never {
  throw new Error(`AV media refused: ${reason}`);
}
function need<T>(value: T | undefined): T {
  return value ?? avRefuse("missing required structure");
}
/** Closed, nonfragmented ISO BMFF grammar. No edits/ctts/sgpd/sbgp/udta/meta/uuid,
 * external resources, extra tracks, transforms, captions, SEI, encryption or unknown boxes.
 * Media ranges are reconstructed independently of ffprobe and must partition the whole mdat.
 * AAC is the untrimmed coded timeline: encoder delay is unknown, NOT measured alignment. */
export function inspectAvMediaMp4(bytes: Buffer, value: AvMediaPolicyV1): AvLayoutV1 {
  const policy = validateAvMediaPolicy(value);
  const p = policy.limits;
  const profile = policy.profile;
  if (!bytes.length || bytes.length > p.max_input_bytes) avRefuse("input byte limit");
  let boxCount = 0;
  const boxes = (start: number, end: number): Box[] => {
    const result: Box[] = [];
    for (let at = start; at < end; ) {
      if (++boxCount > p.max_boxes || at + 8 > end) avRefuse("box count/header");
      const n = bytes.readUInt32BE(at);
      if (n < 8 || at + n > end) avRefuse("box extent; extended/zero sizes unsupported");
      result.push({
        type: bytes.toString("latin1", at + 4, at + 8),
        start: at,
        p: at + 8,
        end: at + n,
      });
      at += n;
    }
    return result;
  };
  const children = (b: Box) => boxes(b.p, b.end);
  const grammar = (
    items: Box[],
    required: readonly string[],
    optional: readonly string[] = [],
    repeated: readonly string[] = []
  ): void => {
    for (const type of required)
      if (items.filter((b) => b.type === type).length !== 1) avRefuse(`required singleton ${type}`);
    for (const b of items) {
      if (![...required, ...optional, ...repeated].includes(b.type))
        avRefuse(`unsupported box ${b.type}`);
      if (!repeated.includes(b.type) && items.filter((x) => x.type === b.type).length !== 1)
        avRefuse(`duplicate box ${b.type}`);
    }
  };
  const one = (items: Box[], type: string) => need(items.find((b) => b.type === type));
  const size = (b: Box, n: number) => {
    if (b.end - b.p !== n) avRefuse(`${b.type} length`);
  };
  const zero = (start: number, end: number) => {
    if (bytes.subarray(start, end).some((n) => n !== 0))
      avRefuse("unknown metadata/reserved field");
  };
  const matrix = (at: number) => {
    if (
      [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824].some(
        (n, i) => bytes.readUInt32BE(at + i * 4) !== n
      )
    )
      avRefuse("track transform metadata");
  };
  const full = (b: Box, flags = 0) => {
    if (b.end - b.p < 4 || bytes.readUInt32BE(b.p) !== flags) avRefuse(`${b.type} version/flags`);
  };
  const top = boxes(0, bytes.length);
  grammar(top, ["ftyp", "mdat", "moov"], ["free"]);
  const ftyp = one(top, "ftyp");
  const brand = Buffer.from("isom");
  if (ftyp.end - ftyp.p < 12 || ftyp.end - ftyp.p > 64 || (ftyp.end - ftyp.p) % 4)
    avRefuse("brands extent");
  if (!bytes.subarray(ftyp.p, ftyp.p + 4).equals(brand) || bytes.readUInt32BE(ftyp.p + 4) !== 512)
    avRefuse("brand/version");
  for (let at = ftyp.p + 8; at < ftyp.end; at += 4)
    if (!["isom", "iso2", "avc1", "mp41"].includes(bytes.toString("ascii", at, at + 4)))
      avRefuse("unknown brand");
  const free = top.find((b) => b.type === "free");
  if (free) zero(free.p, free.end);
  const mdat = one(top, "mdat");
  if (mdat.p === mdat.end) avRefuse("empty media");
  const movie = children(one(top, "moov"));
  grammar(movie, ["mvhd"], [], ["trak"]);
  const traks = movie.filter((b) => b.type === "trak");
  if (traks.length !== 2) avRefuse("exactly one video and one AAC track required");
  const mvhd = one(movie, "mvhd");
  size(mvhd, 100);
  full(mvhd);
  zero(mvhd.p + 4, mvhd.p + 12);
  const movieScale = bytes.readUInt32BE(mvhd.p + 12);
  const movieDuration = bytes.readUInt32BE(mvhd.p + 16);
  if (
    movieScale !== 1000 ||
    bytes.readUInt32BE(mvhd.p + 20) !== 65536 ||
    bytes.readUInt16BE(mvhd.p + 24) !== 256 ||
    bytes.readUInt32BE(mvhd.p + 96) !== 3
  )
    avRefuse("movie header profile");
  zero(mvhd.p + 26, mvhd.p + 36);
  matrix(mvhd.p + 36);
  zero(mvhd.p + 72, mvhd.p + 96);
  let width = 0,
    height = 0;
  const track = (trak: Box, index: number): AvTrackV1 => {
    const isVideo = index === 0;
    const id = isVideo ? 1 : 2;
    const t = children(trak);
    grammar(t, ["tkhd", "mdia"]);
    const tkhd = one(t, "tkhd");
    size(tkhd, 84);
    full(tkhd, 3);
    zero(tkhd.p + 4, tkhd.p + 12);
    if (bytes.readUInt32BE(tkhd.p + 12) !== id) avRefuse("track identity/order");
    zero(tkhd.p + 16, tkhd.p + 20);
    zero(tkhd.p + 24, tkhd.p + 34);
    if (
      bytes.readUInt16BE(tkhd.p + 34) !== (isVideo ? 0 : 1) ||
      bytes.readUInt16BE(tkhd.p + 36) !== (isVideo ? 0 : 256)
    )
      avRefuse("track group/volume");
    zero(tkhd.p + 38, tkhd.p + 40);
    matrix(tkhd.p + 40);
    if (
      bytes.readUInt32BE(tkhd.p + 76) !== (isVideo ? profile.width * 65536 : 0) ||
      bytes.readUInt32BE(tkhd.p + 80) !== (isVideo ? profile.height * 65536 : 0)
    )
      avRefuse("track dimensions");
    const mdia = children(one(t, "mdia"));
    grammar(mdia, ["mdhd", "hdlr", "minf"]);
    const mdhd = one(mdia, "mdhd");
    size(mdhd, 24);
    full(mdhd);
    zero(mdhd.p + 4, mdhd.p + 12);
    const scale = bytes.readUInt32BE(mdhd.p + 12),
      duration = bytes.readUInt32BE(mdhd.p + 16);
    if (!scale || !duration || (!isVideo && scale !== 48000)) avRefuse("track timebase/duration");
    if (bytes.readUInt16BE(mdhd.p + 20) !== 0x55c4) avRefuse("language metadata");
    zero(mdhd.p + 22, mdhd.end);
    const hdlr = one(mdia, "hdlr");
    if (hdlr.end - hdlr.p < 25) avRefuse("handler length");
    zero(hdlr.p, hdlr.p + 8);
    zero(hdlr.p + 12, hdlr.p + 24);
    if (
      bytes.toString("ascii", hdlr.p + 8, hdlr.p + 12) !== (isVideo ? "vide" : "soun") ||
      !bytes
        .subarray(hdlr.p + 24, hdlr.end)
        .equals(Buffer.from(isVideo ? "VideoHandler\0" : "SoundHandler\0"))
    )
      avRefuse("unknown/executable handler metadata");
    const minf = children(one(mdia, "minf"));
    grammar(minf, [isVideo ? "vmhd" : "smhd", "dinf", "stbl"]);
    const header = one(minf, isVideo ? "vmhd" : "smhd");
    size(header, isVideo ? 12 : 8);
    full(header, isVideo ? 1 : 0);
    zero(header.p + 4, header.end);
    const dinf = children(one(minf, "dinf"));
    grammar(dinf, ["dref"]);
    const dref = one(dinf, "dref");
    if (dref.end - dref.p < 8) avRefuse("data reference length");
    full(dref);
    if (bytes.readUInt32BE(dref.p + 4) !== 1) avRefuse("data reference count");
    const refs = boxes(dref.p + 8, dref.end);
    grammar(refs, ["url "]);
    const url = one(refs, "url ");
    size(url, 4);
    full(url, 1);
    const stbl = children(one(minf, "stbl"));
    grammar(stbl, ["stsd", "stts", "stsc", "stsz", "stco"], isVideo ? ["stss"] : []);
    const stsd = one(stbl, "stsd");
    full(stsd);
    if (stsd.end - stsd.p < 8 || bytes.readUInt32BE(stsd.p + 4) !== 1)
      avRefuse("sample entry count");
    const entries = boxes(stsd.p + 8, stsd.end);
    grammar(entries, [isVideo ? "avc1" : "mp4a"]);
    const entry = need(entries[0]);
    if (entry.end - entry.p < (isVideo ? 78 : 28)) avRefuse("sample entry length");
    zero(entry.p, entry.p + 6);
    if (bytes.readUInt16BE(entry.p + 6) !== 1) avRefuse("sample data reference");
    let sps: Buffer | undefined, pps: Buffer | undefined;
    if (isVideo) {
      zero(entry.p + 8, entry.p + 24);
      width = bytes.readUInt16BE(entry.p + 24);
      height = bytes.readUInt16BE(entry.p + 26);
      if (
        width !== profile.width ||
        height !== profile.height ||
        width > p.max_width ||
        height > p.max_height ||
        width * height > p.max_pixels
      )
        avRefuse("exact host video profile dimensions");
      if (
        bytes.readUInt32BE(entry.p + 28) !== 0x480000 ||
        bytes.readUInt32BE(entry.p + 32) !== 0x480000 ||
        bytes.readUInt16BE(entry.p + 40) !== 1 ||
        bytes.readUInt16BE(entry.p + 74) !== 24 ||
        bytes.readUInt16BE(entry.p + 76) !== 65535
      )
        avRefuse("visual sample fields");
      zero(entry.p + 36, entry.p + 40);
      zero(entry.p + 42, entry.p + 74);
      const config = boxes(entry.p + 78, entry.end);
      grammar(config, ["avcC"], ["pasp", "btrt"]);
      const avcc = one(config, "avcC");
      if (
        avcc.end - avcc.p < 11 ||
        bytes[avcc.p] !== 1 ||
        bytes[avcc.p + 1] !== 66 ||
        ![0xc0, 0xe0].includes(bytes[avcc.p + 2] ?? -1) ||
        bytes[avcc.p + 3] !== profile.video.level_idc ||
        bytes[avcc.p + 4] !== 255 ||
        bytes[avcc.p + 5] !== 225
      )
        avRefuse("exact constrained baseline AVC configuration");
      let at = avcc.p + 6;
      const parameter = (type: number): Buffer => {
        if (at + 2 > avcc.end) avRefuse("AVC parameter extent");
        const n = bytes.readUInt16BE(at);
        at += 2;
        if (n < 2 || at + n > avcc.end || bytes[at] !== (type === 7 ? 0x67 : 0x68))
          avRefuse("AVC parameter set");
        const result = bytes.subarray(at, at + n);
        at += n;
        return result;
      };
      sps = parameter(7);
      if (!sps.subarray(1, 4).equals(bytes.subarray(avcc.p + 1, avcc.p + 4)) || bytes[at++] !== 1)
        avRefuse("SPS/configuration disagreement");
      pps = parameter(8);
      if (at !== avcc.end) avRefuse("AVC trailing configuration");
      const pasp = config.find((b) => b.type === "pasp");
      if (pasp) {
        size(pasp, 8);
        if (bytes.readUInt32BE(pasp.p) !== 1 || bytes.readUInt32BE(pasp.p + 4) !== 1)
          avRefuse("pixel aspect");
      }
      const btrt = config.find((b) => b.type === "btrt");
      if (btrt) size(btrt, 12);
    } else {
      zero(entry.p + 8, entry.p + 16);
      if (
        ![1, 2].includes(bytes.readUInt16BE(entry.p + 16)) ||
        bytes.readUInt16BE(entry.p + 18) !== 16 ||
        bytes.readUInt32BE(entry.p + 24) !== 48000 * 65536
      )
        avRefuse("AAC sample entry profile");
      // Muxers write either actual mono (1) or the ISO nominal channelcount (2).
      // The exact mono AudioSpecificConfig below and decoded channel evidence remain mandatory.
      zero(entry.p + 20, entry.p + 24);
      const config = boxes(entry.p + 28, entry.end);
      grammar(config, ["esds"], ["btrt"]);
      const esds = one(config, "esds");
      full(esds);
      let at = esds.p + 4;
      const descriptor = (tag: number, end: number): number => {
        if (bytes[at++] !== tag) avRefuse("AAC descriptor tag");
        let n = 0,
          octets = 0,
          c = 0;
        do {
          if (at >= end || ++octets > 4) avRefuse("AAC descriptor length");
          c = bytes[at++] ?? 0;
          n = n * 128 + (c & 127);
        } while (c & 128);
        if (at + n > end) avRefuse("AAC descriptor extent");
        return at + n;
      };
      const esEnd = descriptor(3, esds.end);
      if (at + 3 > esEnd || bytes.readUInt16BE(at) !== id || bytes[at + 2] !== 0)
        avRefuse("AAC ES identity or executable URL/dependency");
      at += 3;
      const decEnd = descriptor(4, esEnd);
      if (at + 13 > decEnd || bytes[at] !== 0x40 || bytes[at + 1] !== 0x15)
        avRefuse("AAC decoder profile");
      at += 13;
      const ascEnd = descriptor(5, decEnd);
      if (!bytes.subarray(at, ascEnd).equals(Buffer.from([0x11, 0x88])))
        avRefuse("only AAC-LC 48000 mono 1024-sample ASC supported");
      at = ascEnd;
      if (at !== decEnd) avRefuse("AAC decoder trailing metadata");
      const slEnd = descriptor(6, esEnd);
      if (slEnd !== at + 1 || bytes[at] !== 2) avRefuse("AAC SL descriptor");
      at = slEnd;
      if (at !== esEnd || at !== esds.end) avRefuse("AAC unknown descriptors");
      const btrt = config.find((b) => b.type === "btrt");
      if (btrt) size(btrt, 12);
    }
    const table = (name: string, row: number, cap: number): { box: Box; n: number } => {
      const b = one(stbl, name);
      full(b);
      if (b.end - b.p < 8) avRefuse("table header");
      const n = bytes.readUInt32BE(b.p + 4);
      if (!n || n > cap) avRefuse("table count limit");
      size(b, 8 + n * row);
      return { box: b, n };
    };
    const cap = isVideo ? p.max_frames : Math.floor(p.max_samples / 1024);
    const stsz = one(stbl, "stsz");
    full(stsz);
    if (stsz.end - stsz.p < 12) avRefuse("sample size header");
    const fixed = bytes.readUInt32BE(stsz.p + 4),
      n = bytes.readUInt32BE(stsz.p + 8);
    if (!n || n > cap) avRefuse("sample count limit");
    size(stsz, 12 + (fixed ? 0 : n * 4));
    const sizes = Array.from(
      { length: n },
      (_, i) => fixed || bytes.readUInt32BE(stsz.p + 12 + i * 4)
    );
    if (sizes.some((n) => !n || n > p.max_input_bytes)) avRefuse("sample sizes");
    const timing = table("stts", 8, 1);
    const step = bytes.readUInt32BE(timing.box.p + 12);
    if (
      bytes.readUInt32BE(timing.box.p + 8) !== n ||
      !step ||
      BigInt(step) * BigInt(n) !== BigInt(duration) ||
      (isVideo ? step !== avVideoStep(profile, scale) : step !== 1024)
    )
      avRefuse("CFR/full AAC unit timing; composition/edit/partial samples unsupported");
    const durationTime = rationalTime(BigInt(duration), BigInt(scale));
    if (
      compareTime(durationTime, p.max_duration) > 0 ||
      (isVideo ? BigInt(n) * BigInt(width) * BigInt(height) * 4n : BigInt(n) * 2048n) >
        BigInt(p.max_decoded_bytes)
    )
      avRefuse("decoded duration/representation limit");
    const movieTicks = (BigInt(duration) * BigInt(movieScale) + BigInt(scale) - 1n) / BigInt(scale);
    if (BigInt(bytes.readUInt32BE(tkhd.p + 20)) !== movieTicks)
      avRefuse("track/movie duration disagreement");
    const offsets = table("stco", 4, n),
      mapping = table("stsc", 12, n);
    const maps = Array.from({ length: mapping.n }, (_, i) => {
      const at = mapping.box.p + 8 + i * 12;
      const first = bytes.readUInt32BE(at),
        count = bytes.readUInt32BE(at + 4);
      if (!count || count > n || bytes.readUInt32BE(at + 8) !== 1 || first < 1 || first > offsets.n)
        avRefuse("sample/chunk mapping");
      return { first, count };
    });
    if (maps[0]?.first !== 1 || maps.some((m, i) => i > 0 && m.first <= need(maps[i - 1]).first))
      avRefuse("chunk mapping order");
    const samples: AvSampleV1[] = [];
    let sample = 0,
      mapIndex = 0;
    for (let i = 1; i <= offsets.n; i++) {
      if (maps[mapIndex + 1]?.first === i) mapIndex++;
      let pos = bytes.readUInt32BE(offsets.box.p + 4 + i * 4);
      for (let j = 0; j < need(maps[mapIndex]).count; j++) {
        const size = need(sizes[sample]);
        if (pos < mdat.p || pos + size > mdat.end) avRefuse("sample outside mdat");
        samples.push({ pos, size, pts: sample * step, duration: step });
        sample++;
        pos += size;
      }
    }
    if (sample !== n) avRefuse("incomplete sample mapping");
    if (isVideo) {
      const idrs: number[] = [];
      for (const [i, s] of samples.entries()) {
        let at = s.pos,
          picture = false;
        while (at < s.pos + s.size) {
          if (at + 4 > s.pos + s.size) avRefuse("NAL header truncation");
          const length = bytes.readUInt32BE(at);
          at += 4;
          if (length < 2 || at + length > s.pos + s.size) avRefuse("NAL extent");
          const h = bytes[at] ?? 0,
            type = h & 31;
          if (h & 128 || ![1, 5, 7, 8].includes(type))
            avRefuse("unknown coded metadata/NAL; SEI unsupported");
          if (type === 7 && !bytes.subarray(at, at + length).equals(sps ?? Buffer.alloc(0)))
            avRefuse("in-band SPS drift");
          if (type === 8 && !bytes.subarray(at, at + length).equals(pps ?? Buffer.alloc(0)))
            avRefuse("in-band PPS drift");
          if (type === 1 || type === 5) {
            if (picture) avRefuse("multiple slices/pictures unsupported");
            picture = true;
            if (type === 5) idrs.push(i + 1);
          }
          at += length;
        }
        if (!picture) avRefuse("missing coded picture");
      }
      if (idrs[0] !== 1) avRefuse("initial IDR missing");
      const sync = stbl.find((b) => b.type === "stss");
      if (sync) {
        const ss = table("stss", 4, n);
        if (
          ss.n !== idrs.length ||
          idrs.some((v, i) => v !== bytes.readUInt32BE(ss.box.p + 8 + i * 4))
        )
          avRefuse("sync sample disagreement");
      } else if (idrs.length !== n) avRefuse("missing sync sample table");
    }
    return {
      id,
      timescale: scale,
      duration_ticks: duration,
      duration: durationTime,
      step,
      samples,
    };
  };
  const video = track(need(traks[0]), 0),
    audio = track(need(traks[1]), 1);
  if (
    BigInt(video.samples.length) * BigInt(width) * BigInt(height) * 4n +
      BigInt(audio.samples.length) * 2048n >
    BigInt(p.max_decoded_bytes)
  )
    avRefuse("aggregate decoded representation limit");
  const all = [...video.samples, ...audio.samples].sort((a, b) => a.pos - b.pos);
  let covered = mdat.p;
  for (const s of all) {
    if (s.pos !== covered) avRefuse("overlap/unreferenced hidden mdat payload");
    covered += s.size;
  }
  if (covered !== mdat.end) avRefuse("unreferenced mdat tail");
  const longest = Math.max(
    bytes.readUInt32BE(one(children(need(traks[0])), "tkhd").p + 20),
    bytes.readUInt32BE(one(children(need(traks[1])), "tkhd").p + 20)
  );
  if (movieDuration !== longest) avRefuse("movie duration disagreement");
  return { video, audio, width, height };
}
