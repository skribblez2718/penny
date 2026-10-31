import { Type, type Static, type TSchema } from "typebox";
import { canonicalJson } from "../canonical-json.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { assertBoundedJson, type FoundationLimitsV1 } from "./bounds.js";
import { avRefuse, type AvLayoutV1, type AvTrackV1 } from "./av-media-container.js";

const closed = { additionalProperties: false } as const;
const int = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const digits = Type.String({ pattern: "^(0|[1-9][0-9]{0,15})$" });
const text = Type.String({ maxLength: 256 });
const side = Type.Optional(Type.Array(Type.Unknown(), { maxItems: 0 }));
const tags = Type.Optional(Type.Record(text, text));
const Stream = Type.Object(
  {
    index: int,
    id: Type.Optional(text),
    codec_name: text,
    profile: text,
    codec_type: text,
    width: Type.Optional(int),
    height: Type.Optional(int),
    pix_fmt: Type.Optional(text),
    has_b_frames: Type.Optional(int),
    time_base: text,
    start_pts: int,
    duration_ts: int,
    nb_frames: digits,
    sample_rate: Type.Optional(digits),
    channels: Type.Optional(int),
    channel_layout: Type.Optional(text),
    sample_fmt: Type.Optional(text),
    tags,
    disposition: Type.Record(text, Type.Integer({ minimum: 0, maximum: 1 })),
    side_data_list: side,
  },
  closed
);
const Packet = Type.Object(
  {
    stream_index: int,
    pts: int,
    dts: int,
    duration: int,
    pos: digits,
    size: digits,
    side_data_list: side,
  },
  closed
);
export const AvProbeSchema = Type.Object(
  {
    programs: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 0 })),
    streams: Type.Array(Stream, { minItems: 2, maxItems: 2 }),
    packets: Type.Array(Packet, { minItems: 2, maxItems: 107657 }),
    format: Type.Object({ format_name: text, tags }, closed),
  },
  closed
);
export const AvFramesSchema = Type.Object(
  {
    frames: Type.Array(
      Type.Object(
        {
          media_type: text,
          stream_index: int,
          pts: Type.Optional(int),
          pkt_pts: Type.Optional(int),
          pkt_dts: int,
          best_effort_timestamp: int,
          pkt_duration: int,
          pkt_pos: digits,
          pkt_size: digits,
          width: Type.Optional(int),
          height: Type.Optional(int),
          pix_fmt: Type.Optional(text),
          pict_type: Type.Optional(text),
          interlaced_frame: Type.Optional(int),
          repeat_pict: Type.Optional(int),
          nb_samples: Type.Optional(int),
          channels: Type.Optional(int),
          channel_layout: Type.Optional(text),
          sample_fmt: Type.Optional(text),
          side_data_list: side,
        },
        closed
      ),
      { minItems: 2, maxItems: 107657 }
    ),
  },
  closed
);
/** ffprobe JSON is not canonical. Parse with duplicate-key rejection BEFORE schema traversal.
 * Bound byte count before UTF-8 and bound depth/nodes/collections during parsing, not after. */
export function parseAvJson<T extends TSchema>(
  schema: T,
  bytes: Buffer,
  limits: FoundationLimitsV1,
  byteCap: number
): Static<T> {
  if (!bytes.length || bytes.length > Math.min(byteCap, limits.max_json_bytes))
    avRefuse("JSON bytes");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0,
    nodes = 0;
  const ws = () => {
    while ([" ", "\t", "\n", "\r"].includes(text[at] ?? "!")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") {
        at++;
        continue;
      }
      if (c === '"') {
        const value: unknown = JSON.parse(text.slice(start, at));
        if (typeof value !== "string" || Buffer.byteLength(value) > limits.max_text_bytes)
          avRefuse("JSON string");
        return value;
      }
    }
    return avRefuse("JSON unterminated string");
  };
  const value = (depth: number): unknown => {
    if (++nodes > limits.max_nodes || depth > limits.max_depth) avRefuse("JSON complexity");
    ws();
    const c = text[at];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      const object = c === "{";
      at++;
      ws();
      const result: Record<string, unknown> = {};
      const array: unknown[] = [];
      const keys = new Set<string>();
      let count = 0;
      const close = object ? "}" : "]";
      if (text[at] === close) {
        at++;
        return object ? result : array;
      }
      while (at < text.length) {
        if (++count > limits.max_collection_items) avRefuse("JSON collection limit");
        ws();
        if (object) {
          if (text[at] !== '"') avRefuse("JSON key");
          const key = string();
          if (keys.has(key)) avRefuse("duplicate JSON key");
          keys.add(key);
          ws();
          if (text[at++] !== ":") avRefuse("JSON colon");
          Object.defineProperty(result, key, {
            value: value(depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        } else array.push(value(depth + 1));
        ws();
        const separator = text[at++];
        if (separator === close) return object ? result : array;
        if (separator !== ",") avRefuse("JSON separator");
      }
      return avRefuse("JSON unterminated collection");
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
      text.slice(at)
    )?.[0];
    if (token === undefined) avRefuse("JSON token");
    at += token.length;
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    const n = Number(token);
    if (!Number.isSafeInteger(n) || Math.abs(n) > limits.max_integer)
      avRefuse("JSON numeric overflow/nonfinite");
    return n;
  };
  const parsed = value(0);
  ws();
  if (at !== text.length) avRefuse("JSON trailing bytes");
  assertBoundedJson(parsed, limits);
  return validateSkillSchema(schema, parsed, "AV decoder evidence");
}
function eq(a: unknown, b: unknown, reason: string): void {
  if (canonicalJson(a) !== canonicalJson(b)) avRefuse(reason);
}
const DISPOSITIONS = [
  "default",
  "dub",
  "original",
  "comment",
  "lyrics",
  "karaoke",
  "forced",
  "hearing_impaired",
  "visual_impaired",
  "clean_effects",
  "attached_pic",
  "timed_thumbnails",
  "captions",
  "descriptions",
  "metadata",
  "dependent",
  "still_image",
  "non_diegetic",
  "multilayer",
];
export function validateAvProbe(probe: Static<typeof AvProbeSchema>, layout: AvLayoutV1): void {
  if (probe.format.format_name !== "mov,mp4,m4a,3gp,3g2,mj2") avRefuse("probe container");
  eq(
    probe.format.tags,
    { major_brand: "isom", minor_version: "512", compatible_brands: "isomiso2avc1mp41" },
    "unknown container metadata"
  );
  for (const [i, stream] of probe.streams.entries()) {
    const video = i === 0,
      track = video ? layout.video : layout.audio;
    if (
      stream.index !== i ||
      (stream.id !== undefined && stream.id !== `0x${i + 1}`) ||
      stream.codec_type !== (video ? "video" : "audio") ||
      stream.codec_name !== (video ? "h264" : "aac") ||
      stream.profile !== (video ? "Constrained Baseline" : "LC") ||
      stream.time_base !== `1/${track.timescale}` ||
      stream.duration_ts !== track.duration_ticks ||
      stream.start_pts !== 0 ||
      Number(stream.nb_frames) !== track.samples.length
    )
      avRefuse("probe stream identity/time/count");
    eq(
      stream.tags,
      {
        language: "und",
        handler_name: video ? "VideoHandler" : "SoundHandler",
        vendor_id: "[0][0][0][0]",
      },
      "unknown stream metadata"
    );
    if (
      Object.entries(stream.disposition).some(
        ([k, v]) => !DISPOSITIONS.includes(k) || v !== (k === "default" ? 1 : 0)
      )
    )
      avRefuse("unknown/nondefault stream disposition");
    if (video) {
      if (
        stream.width !== layout.width ||
        stream.height !== layout.height ||
        stream.pix_fmt !== "yuv420p" ||
        stream.has_b_frames !== 0 ||
        stream.sample_rate !== undefined ||
        stream.channels !== undefined ||
        stream.sample_fmt !== undefined ||
        stream.channel_layout !== undefined
      )
        avRefuse("probe video shape");
    } else if (
      stream.sample_rate !== "48000" ||
      stream.channels !== 1 ||
      stream.channel_layout !== "mono" ||
      stream.sample_fmt !== "fltp" ||
      stream.width !== undefined ||
      stream.height !== undefined ||
      stream.pix_fmt !== undefined ||
      stream.has_b_frames !== undefined
    )
      avRefuse("probe AAC shape");
  }
  for (const index of [0, 1]) {
    const track = index === 0 ? layout.video : layout.audio;
    const packets = probe.packets.filter((p) => p.stream_index === index);
    if (packets.length !== track.samples.length) avRefuse("packet count");
    packets.forEach((p, i) => {
      const s = track.samples[i];
      if (
        !s ||
        p.pts !== s.pts ||
        p.dts !== s.pts ||
        p.duration !== s.duration ||
        Number(p.pos) !== s.pos ||
        Number(p.size) !== s.size
      )
        avRefuse("packet/table evidence mismatch");
    });
  }
  if (probe.packets.some((p) => p.stream_index !== 0 && p.stream_index !== 1))
    avRefuse("extra packet stream");
}
export function validateAvFrames(frames: Static<typeof AvFramesSchema>, layout: AvLayoutV1): void {
  for (const index of [0, 1]) {
    const video = index === 0,
      track = video ? layout.video : layout.audio;
    const selected = frames.frames.filter((f) => f.stream_index === index);
    if (selected.length !== track.samples.length)
      avRefuse("complete decoded frame/access-unit count");
    selected.forEach((f, i) => {
      const s = track.samples[i];
      if (
        !s ||
        (f.pts === undefined && f.pkt_pts === undefined) ||
        (f.pts !== undefined && f.pts !== s.pts) ||
        (f.pkt_pts !== undefined && f.pkt_pts !== s.pts) ||
        f.pkt_dts !== s.pts ||
        f.best_effort_timestamp !== s.pts ||
        f.pkt_duration !== s.duration ||
        Number(f.pkt_pos) !== s.pos ||
        Number(f.pkt_size) !== s.size ||
        f.media_type !== (video ? "video" : "audio")
      )
        avRefuse("decoded frame PTS/packet mismatch");
      if (video) {
        if (
          f.width !== layout.width ||
          f.height !== layout.height ||
          f.pix_fmt !== "yuv420p" ||
          !["I", "P"].includes(f.pict_type ?? "") ||
          f.interlaced_frame !== 0 ||
          f.repeat_pict !== 0 ||
          f.nb_samples !== undefined ||
          f.sample_fmt !== undefined ||
          f.channels !== undefined ||
          f.channel_layout !== undefined
        )
          avRefuse("decoded video frame shape");
      } else if (
        f.nb_samples !== 1024 ||
        f.channels !== 1 ||
        f.channel_layout !== "mono" ||
        f.sample_fmt !== "fltp" ||
        f.width !== undefined ||
        f.height !== undefined ||
        f.pix_fmt !== undefined ||
        f.pict_type !== undefined ||
        f.repeat_pict !== undefined ||
        f.interlaced_frame !== undefined
      )
        avRefuse("decoded AAC sample evidence; skip/partial samples unsupported");
    });
  }
  if (frames.frames.some((f) => f.stream_index !== 0 && f.stream_index !== 1))
    avRefuse("extra decoded stream");
}
/** The second full decode must independently agree with every frame PTS, not only byte totals.
 * showinfo output is trusted decoder evidence, not a progress/quality PASS callback. */
export function validateAvDecodeLog(bytes: Buffer, track: AvTrackV1, video: boolean): void {
  const log = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /\[(?:warning|error|fatal|panic)\]/u.test(log) ||
    /\b(?:Error|corrupt|Invalid|conceal)/iu.test(log)
  )
    avRefuse("decoder diagnostics");
  const records = [
    ...log.matchAll(
      video
        ? /\bn:\s*([0-9]+)\s+pts:\s*(-?[0-9]+)\s+pts_time:/gu
        : /\bn:([0-9]+)\s+pts:(-?[0-9]+)\s+pts_time:/gu
    ),
  ];
  if (
    records.length !== track.samples.length ||
    records.some((m, i) => Number(m[1]) !== i || Number(m[2]) !== track.samples[i]?.pts)
  )
    avRefuse("second decoder complete PTS/count mismatch");
  if (video) {
    const configs = [...log.matchAll(/config in time_base: ([0-9]+)\/([0-9]+)/gu)];
    if (
      configs.length !== 1 ||
      configs[0]?.[1] !== "1" ||
      configs[0]?.[2] !== String(track.timescale)
    )
      avRefuse("second decoder timebase");
  } else {
    const audio = [
      ...log.matchAll(/fmt:s16 channels:1 chlayout:mono rate:48000 nb_samples:1024\b/gu),
    ];
    if (audio.length !== track.samples.length) avRefuse("second decoder AAC sample/rate mismatch");
  }
}
