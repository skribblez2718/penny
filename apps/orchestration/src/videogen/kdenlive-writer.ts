import { ConfinedNativeRunner } from "../host-operations/confined-native-runner.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { validateFoundation, type FoundationLimitsV1 } from "./bounds.js";
import { validateEditDecision } from "./edit-decision.js";
import { EditCaptionStyleV1Schema, type EditDecisionV1 } from "./edit-contracts.js";
import { quantizeBoundary, type RationalTime } from "./rational-time.js";
import { validatePortablePath } from "./portable-package.js";
import {
  checkNativeStructure,
  KdenliveFixtureRegistry,
  nativeFps,
  nativeFrame,
  nativeSequence,
  nativeTrackPlaylists,
} from "./kdenlive-registry.js";
import {
  nativeProperty as prop,
  setNativeProperty as set,
  nativeRefuse,
  nativeRequired,
  nativeWalk,
  parseNativeXml,
  serializeNativeXml,
  type NativeElement,
} from "./native-xml.js";

export interface NativeAssetBinding {
  readonly source_ref: ArtifactRef;
  readonly relative_path: string;
  readonly bytes: Uint8Array;
  readonly duration_frames: number;
}
export interface NativeWriteInput {
  readonly registry: KdenliveFixtureRegistry;
  readonly fixture_digest: string;
  readonly edit: unknown;
  readonly assets: readonly NativeAssetBinding[];
  readonly limits: FoundationLimitsV1;
  readonly max_frames: number;
}
export interface NativeReadback {
  readonly canvas: { width: number; height: number; fps: number };
  readonly duration_frames: number;
  readonly tracks: readonly {
    readonly native_track: number;
    readonly kind: "video" | "voice";
    readonly items: readonly {
      readonly kind: "clip" | "gap";
      readonly start: number;
      readonly end: number;
      readonly source_in: number;
      readonly resource: string | null;
      readonly gain_db: number;
    }[];
  }[];
  readonly caption_path: string | null;
}
export interface WrittenNativeProject {
  readonly bytes: Buffer;
  readonly readback: NativeReadback;
  readonly required_paths: readonly string[];
  readonly registry_digest: string;
  readonly status: "constructed_unqualified";
}
function refKey(ref: ArtifactRef): string {
  return canonicalJson(ref);
}
function index(time: RationalTime, edit: EditDecisionV1, cap: number): number {
  const chosen = quantizeBoundary(time, edit.canvas.fps, cap);
  if (chosen.residual.numerator !== 0)
    nativeRefuse("sample-only or fractional-frame native placement lacks mapping");
  return chosen.index;
}
function uuid(seed: string): string {
  const h = sha256(seed);
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}}`;
}
function timestamp(frames: number, fps: number): string {
  const ms = frames * (1000 / fps);
  if (!Number.isSafeInteger(ms) || ms < 0) nativeRefuse("native timestamp overflow");
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
/** Independent structural/timeline reconstruction; no caller PASS record or cached edit is read. */
export function readNativeTimeline(
  bytes: Uint8Array,
  registry: KdenliveFixtureRegistry
): NativeReadback {
  const root = parseNativeXml(bytes, registry.limits);
  checkNativeStructure(root, "internal");
  if (root.attrs.root !== ".") nativeRefuse("external project root");
  const fps = nativeFps(root),
    nodes = new Map(root.children.map((n) => [n.attrs.id, n]));
  const profile = nativeRequired(
    root.children.find((n) => n.name === "profile"),
    "profile"
  );
  const sequence = nativeSequence(root);
  const tracks = nativeTrackPlaylists(root).map((t, native_track) => {
    let cursor = 0;
    const items = t.playlist.children
      .filter((n) => n.name !== "property")
      .map((e) => {
        if (e.name === "blank") {
          const length = nativeFrame(nativeRequired(e.attrs.length, "gap length"), fps),
            start = cursor;
          if (length < 1) nativeRefuse("zero gap");
          cursor += length;
          return {
            kind: "gap" as const,
            start,
            end: cursor,
            source_in: 0,
            resource: null,
            gain_db: 0,
          };
        }
        const chain = nativeRequired(nodes.get(e.attrs.producer), "placement chain");
        const sourceIn = nativeFrame(nativeRequired(e.attrs.in, "in"), fps),
          sourceOut = nativeFrame(nativeRequired(e.attrs.out, "out"), fps) + 1;
        if (sourceOut <= sourceIn || sourceOut > Number(prop(chain, "length")))
          nativeRefuse("source bounds drift");
        if (t.kind === "video" && prop(chain, "set.test_audio") !== "1")
          nativeRefuse("source audio not stripped");
        const gains = chain.children.filter(
          (n) =>
            n.name === "filter" && prop(n, "mlt_service") === "volume" && prop(n, "disable") !== "1"
        );
        if (gains.length > 1) nativeRefuse("multiple gains unsupported");
        const gain = gains[0],
          rawGain = gain === undefined ? "0dB" : prop(gain, "level");
        if (rawGain === undefined || !/^-?\d+dB$/u.test(rawGain))
          nativeRefuse("gain expression unsupported");
        const start = cursor;
        cursor += sourceOut - sourceIn;
        return {
          kind: "clip" as const,
          start,
          end: cursor,
          source_in: sourceIn,
          resource: validatePortablePath(nativeRequired(prop(chain, "resource"), "resource")),
          gain_db: Number(rawGain.slice(0, -2)),
        };
      });
    return { native_track, kind: t.kind, items };
  });
  const captions = sequence.children.filter(
    (n) =>
      n.name === "filter" &&
      prop(n, "mlt_service") === "avfilter.subtitles" &&
      prop(n, "disable") !== "1"
  );
  if (captions.length > 1) nativeRefuse("multiple active captions");
  const caption = captions[0],
    captionPath =
      caption === undefined
        ? null
        : validatePortablePath(nativeRequired(prop(caption, "av.filename"), "caption path"));
  if (captionPath !== null) {
    const expected = [{ file: captionPath, id: 0, name: "Subtitles" }];
    const list: unknown = JSON.parse(
      nativeRequired(prop(sequence, "kdenlive:sequenceproperties.subtitlesList"), "subtitle list")
    );
    if (canonicalJson(list) !== canonicalJson(expected))
      nativeRefuse("active caption/list mismatch");
  } else if (prop(sequence, "kdenlive:sequenceproperties.subtitlesList") !== undefined)
    nativeRefuse("inactive subtitle source");
  return {
    canvas: { width: Number(profile.attrs.width), height: Number(profile.attrs.height), fps },
    duration_frames: nativeFrame(nativeRequired(sequence.attrs.out, "sequence out"), fps) + 1,
    tracks,
    caption_path: captionPath,
  };
}
function safeAsset(input: NativeWriteInput, ref: ArtifactRef): NativeAssetBinding {
  const a = nativeRequired(
    input.assets.find((a) => refKey(a.source_ref) === refKey(ref)),
    "exact asset binding"
  );
  validatePortablePath(a.relative_path);
  if (
    a.bytes.byteLength !== ref.byte_length ||
    sha256(a.bytes) !== ref.content_digest ||
    !Number.isSafeInteger(a.duration_frames) ||
    a.duration_frames < 0 ||
    a.duration_frames > input.max_frames
  )
    nativeRefuse("asset digest/duration mismatch");
  return a;
}
/** Exact ASS source admission, not subtitle generation. No drawings/overrides, attachments,
 * secondary styles, embedded executable/resource fields or font fallback claim. */
function checkCaption(
  bytes: Uint8Array,
  spans: readonly { start: number; end: number }[],
  fps: number,
  width: number,
  height: number,
  size: number
): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /[{}\\]/u.test(text) ||
    text.includes(String.fromCharCode(0)) ||
    text.includes("\r") ||
    text.includes("[Fonts]") ||
    text.includes("[Graphics]")
  )
    nativeRefuse("unsupported caption markup/dependency");
  const style = text.split("\n").filter((l) => l.startsWith("Style: "));
  if (
    style.length !== 1 ||
    !new RegExp(
      `^Style: Default,[A-Za-z0-9 -]{1,64},${size.toFixed(2).replace(".", "\\.")},&H00FFFFFF,`,
      "u"
    ).test(nativeRequired(style[0], "caption style"))
  )
    nativeRefuse("unmapped caption/font style");
  for (const [key, n] of [
    ["PlayResX", width],
    ["PlayResY", height],
  ] as const)
    if (!text.split("\n").includes(`${key}: ${n}`)) nativeRefuse("caption canvas mismatch");
  const lines = text.split("\n").filter((l) => l.startsWith("Dialogue: "));
  if (lines.length !== spans.length) nativeRefuse("caption cue coverage");
  for (const [i, l] of lines.entries()) {
    const m =
      /^Dialogue: 0,(\d{2}:[0-5]\d:[0-5]\d\.\d{2}),(\d{2}:[0-5]\d:[0-5]\d\.\d{2}),Default,,0,0,0,,([^\n]+)$/u.exec(
        l
      );
    if (m === null) nativeRefuse("caption cue syntax");
    const t = (s: string) => nativeFrame(`${s}0`, fps);
    const span = nativeRequired(spans[i], "caption span");
    if (
      t(nativeRequired(m[1], "caption start")) !== span.start ||
      t(nativeRequired(m[2], "caption end")) !== span.end
    )
      nativeRefuse("caption timing drift");
  }
}
export function writeNativeProject(input: NativeWriteInput): WrittenNativeProject {
  const edit = validateEditDecision(input.edit, input.limits),
    r = input.registry;
  if (
    !Number.isSafeInteger(input.max_frames) ||
    input.max_frames < 1 ||
    input.assets.length > input.limits.max_collection_items
  )
    nativeRefuse("native asset/frame limit");
  const root = r.fixture(input.fixture_digest),
    fps = nativeFps(root);
  const profile = nativeRequired(
    root.children.find((n) => n.name === "profile"),
    "profile"
  );
  if (
    edit.canvas.width !== Number(profile.attrs.width) ||
    edit.canvas.height !== Number(profile.attrs.height) ||
    edit.canvas.fps.numerator !== fps ||
    edit.canvas.fps.denominator !== 1 ||
    (edit.canvas.color_space !== profile.attrs.colorspace &&
      edit.canvas.color_space !==
        (profile.attrs.colorspace === "709"
          ? "rec709"
          : profile.attrs.colorspace === "601"
            ? "rec601"
            : undefined))
  )
    nativeRefuse("canvas has no saved mapping");
  if (edit.mix_buses.length) nativeRefuse("bus gain mapping absent");
  if (
    new Set(input.assets.map((a) => a.relative_path.toLowerCase())).size !== input.assets.length ||
    new Set(input.assets.map((a) => refKey(a.source_ref))).size !== input.assets.length
  )
    nativeRefuse("duplicate asset/path binding");
  const duration = index(edit.end_time, edit, input.max_frames),
    slots = nativeTrackPlaylists(root);
  const usedSlots = new Set<number>(),
    usedAssets = new Set<string>(),
    added: NativeElement[] = [];
  const bin = nativeRequired(
      root.children.find((n) => n.attrs.id === "main_bin"),
      "bin"
    ),
    sequence = nativeSequence(root);
  const nodes = new Map(root.children.map((n) => [n.attrs.id, n]));
  const binTemplate = nativeRequired(
    bin.children.find((n) => n.name === "entry" && nodes.get(n.attrs.producer)?.name === "chain"),
    "bin source template"
  );
  const sourceTemplate = nativeRequired(nodes.get(binTemplate.attrs.producer), "bin chain");
  const originalChains = new Set(
    root.children.filter((n) => n.name === "chain").map((n) => n.attrs.id)
  );
  for (const slot of slots)
    slot.playlist.children = slot.playlist.children.filter((n) => n.name === "property");
  bin.children = bin.children.filter(
    (n) => n.name !== "entry" || !originalChains.has(n.attrs.producer)
  );
  let captionPath: string | null = null;
  const captions: { start: number; end: number }[] = [];
  let captionRef: ArtifactRef | undefined, styleRef: ArtifactRef | undefined;
  for (const track of edit.tracks) {
    if (track.kind === "caption") {
      for (const item of track.items)
        if (item.kind === "caption") {
          r.require("active_caption");
          captionRef = item.text_source_ref;
          styleRef = item.style_ref;
          captions.push({
            start: index(item.timeline_start, edit, input.max_frames),
            end: index(item.timeline_end, edit, input.max_frames),
          });
        }
      continue;
    }
    const kind = track.kind === "video" ? "video" : "voice";
    const slotIndex = slots.findIndex((s, i) => s.kind === kind && !usedSlots.has(i));
    if (slotIndex < 0) nativeRefuse("track order/count has no saved slot");
    const slot = nativeRequired(slots[slotIndex], "track slot");
    usedSlots.add(slotIndex);
    if (kind === "voice") r.require("voice");
    else r.require("clips");
    if (track.items.filter((i) => i.kind === "clip").length > 1) r.require("order");
    for (const item of track.items) {
      const start = index(item.timeline_start, edit, input.max_frames),
        end = index(item.timeline_end, edit, input.max_frames);
      if (item.kind === "gap") {
        r.require("gaps");
        slot.playlist.children.push({
          name: "blank",
          attrs: { length: timestamp(end - start, fps) },
          children: [],
          text: "",
        });
        continue;
      }
      if (item.kind !== "clip") nativeRefuse("caption in media slot");
      const a = safeAsset(input, item.source_ref);
      usedAssets.add(refKey(a.source_ref));
      const sourceIn = index(item.source_in, edit, input.max_frames),
        sourceOut = index(item.source_out, edit, input.max_frames);
      if (sourceOut > a.duration_frames) nativeRefuse("trim exceeds source");
      if (sourceIn !== 0 || sourceOut !== a.duration_frames) r.require("trims");
      const gain = item.gain_envelope?.[0];
      if (
        item.gain_envelope !== undefined &&
        (item.gain_envelope.length !== 1 || gain?.sample_index !== item.sample_in)
      )
        nativeRefuse("unmapped gain automation");
      let template = sourceTemplate;
      if (kind === "voice" || gain !== undefined) {
        const evidence = r.require(gain === undefined ? "voice" : "voice_gain");
        const evidenceSlot = nativeRequired(
          nativeTrackPlaylists(evidence).find(
            (s) => s.kind === "voice" && s.playlist.children.some((n) => n.name === "entry")
          ),
          "voice fixture placement"
        );
        const e = nativeRequired(
          evidenceSlot.playlist.children.find((n) => n.name === "entry"),
          "voice entry"
        );
        template = nativeRequired(
          evidence.children.find((n) => n.attrs.id === e.attrs.producer),
          "voice source"
        );
      }
      const chain = structuredClone(template),
        id = `vg_${sha256(item.item_id).slice(0, 24)}`,
        binId = `${id}_bin`;
      chain.attrs = { id, out: timestamp(a.duration_frames - 1, fps) };
      chain.children = chain.children.filter(
        (n) =>
          !(
            n.name === "property" &&
            ((n.attrs.name ?? "").startsWith("meta.") ||
              (n.attrs.name ?? "").startsWith("kdenlive:meta."))
          )
      );
      for (const [i, n] of [...nativeWalk(chain)].entries())
        if (n !== chain && n.attrs.id !== undefined) n.attrs.id = `${id}_node_${i}`;
      set(chain, "resource", a.relative_path);
      set(chain, "length", String(a.duration_frames));
      const numericId = String(1000 + added.length);
      set(chain, "kdenlive:id", numericId);
      set(chain, "kdenlive:control_uuid", uuid(item.item_id));
      set(chain, "kdenlive:file_size", String(a.bytes.byteLength));
      set(chain, "kdenlive:file_hash", "");
      set(chain, "audio_index", kind === "video" ? "-1" : "0");
      set(chain, "video_index", kind === "video" ? "0" : "-1");
      set(chain, "set.test_audio", kind === "video" ? "1" : "0");
      set(chain, "set.test_image", kind === "video" ? "0" : "1");
      if (gain === undefined && kind === "voice")
        chain.children = chain.children.filter(
          (n) =>
            !(
              n.name === "filter" &&
              prop(n, "mlt_service") === "volume" &&
              prop(n, "disable") !== "1"
            )
        );
      if (gain !== undefined) {
        const filter = nativeRequired(
          chain.children.find(
            (n) =>
              n.name === "filter" &&
              prop(n, "mlt_service") === "volume" &&
              prop(n, "disable") !== "1"
          ),
          "gain filter"
        );
        set(filter, "level", `${gain.gain_db}dB`);
        filter.attrs.id = `${id}_gain`;
        filter.attrs.out = timestamp(a.duration_frames - 1, fps);
      }
      const binChain = structuredClone(chain);
      binChain.attrs.id = binId;
      // Clip effect belongs to the placement, never to a second global bin effect.
      binChain.children = binChain.children.filter((n) => n.name !== "filter");
      added.push(chain, binChain);
      slot.playlist.children.push({
        name: "entry",
        attrs: { producer: id, in: timestamp(sourceIn, fps), out: timestamp(sourceOut - 1, fps) },
        children: [
          { name: "property", attrs: { name: "kdenlive:id" }, children: [], text: numericId },
        ],
        text: "",
      });
      bin.children.push({
        name: "entry",
        attrs: {
          producer: binId,
          in: timestamp(0, fps),
          out: timestamp(a.duration_frames - 1, fps),
        },
        children: [],
        text: "",
      });
    }
    slot.tractor.attrs.out = timestamp(duration - 1, fps);
  }
  if (captionRef !== undefined && styleRef !== undefined) {
    const a = safeAsset(input, captionRef),
      styleAsset = safeAsset(input, styleRef);
    const styleValue: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(styleAsset.bytes)
    );
    const style = validateFoundation(EditCaptionStyleV1Schema, styleValue, input.limits);
    const font = safeAsset(input, style.font_ref);
    if (
      !["font/ttf", "font/otf"].includes(font.source_ref.media_type) ||
      style.color_rgba !== "ffffffff"
    )
      nativeRefuse("unmapped caption style/font");
    checkCaption(a.bytes, captions, fps, edit.canvas.width, edit.canvas.height, style.size_px);
    captionPath = a.relative_path;
    const evidence = r.require("active_caption");
    const filter = structuredClone(
      nativeRequired(
        nativeSequence(evidence).children.find(
          (n) => n.name === "filter" && prop(n, "mlt_service") === "avfilter.subtitles"
        ),
        "active caption filter"
      )
    );
    filter.attrs.id = "vg_active_caption";
    set(filter, "av.filename", captionPath);
    sequence.children = sequence.children.filter(
      (n) => !(n.name === "filter" && prop(n, "mlt_service") === "avfilter.subtitles")
    );
    sequence.children.push(filter);
    set(
      sequence,
      "kdenlive:sequenceproperties.subtitlesList",
      canonicalJson([{ file: captionPath, id: 0, name: "Subtitles" }])
    );
    for (const x of [a, styleAsset, font]) usedAssets.add(refKey(x.source_ref));
  } else {
    sequence.children = sequence.children.filter(
      (n) =>
        !(n.name === "filter" && prop(n, "mlt_service") === "avfilter.subtitles") &&
        n.attrs.name !== "kdenlive:sequenceproperties.subtitlesList"
    );
  }
  for (const black of root.children.filter(
    (n) =>
      n.name === "producer" && prop(n, "mlt_service") === "color" && prop(n, "resource") === "black"
  )) {
    const oldDuration = Number(
      nativeRequired(prop(sequence, "kdenlive:maxduration"), "fixture duration")
    );
    const horizon =
      nativeFrame(nativeRequired(black.attrs.out, "black horizon"), fps) - oldDuration;
    if (!Number.isSafeInteger(horizon) || horizon < 0)
      nativeRefuse("invalid fixture black horizon");
    black.attrs.out = timestamp(duration + horizon, fps);
  }
  root.children = root.children.filter((n) => n.name !== "chain");
  root.children.splice(1, 0, ...added);
  root.attrs.root = ".";
  sequence.attrs.out = timestamp(duration - 1, fps);
  set(sequence, "kdenlive:duration", timestamp(duration, fps));
  set(sequence, "kdenlive:maxduration", String(duration));
  const seqId = nativeRequired(sequence.attrs.id, "sequence ID");
  for (const n of nativeWalk(root)) {
    if (["track", "entry"].includes(n.name) && n.attrs.producer === seqId) {
      n.attrs.in = timestamp(0, fps);
      n.attrs.out = timestamp(duration - 1, fps);
    }
    if (
      n.name === "tractor" &&
      n !== sequence &&
      n.children.some((c) => c.name === "track" && c.attrs.producer === seqId)
    )
      n.attrs.out = timestamp(duration - 1, fps);
    if (
      n.name === "property" &&
      ["kdenlive:docproperties.browserurl", "kdenlive:docproperties.storagefolder"].includes(
        n.attrs.name ?? ""
      )
    )
      n.text = ".";
    if (n.name === "property" && n.attrs.name === "kdenlive:docproperties.layout") n.text = "{}";
  }
  if (usedAssets.size !== input.assets.length) nativeRefuse("unused native asset");
  const bytes = serializeNativeXml(root);
  const readback = readNativeTimeline(bytes, r);
  const actual = readback.tracks.filter((t) => t.items.length > 0);
  const expected = edit.tracks.filter((t) => t.kind !== "caption");
  if (
    actual.length !== expected.length ||
    readback.duration_frames !== duration ||
    readback.caption_path !== captionPath
  )
    nativeRefuse("native construction/readback drift");
  for (const t of expected) {
    const slotIndex = [...usedSlots][expected.indexOf(t)],
      observed = nativeRequired(
        readback.tracks.find((x) => x.native_track === slotIndex),
        "readback track"
      );
    if (observed.items.length !== t.items.length) nativeRefuse("native item coverage drift");
    t.items.forEach((item, i) => {
      const got = nativeRequired(observed.items[i], "readback item");
      if (
        got.kind !== item.kind ||
        got.start !== index(item.timeline_start, edit, input.max_frames) ||
        got.end !== index(item.timeline_end, edit, input.max_frames) ||
        (item.kind === "clip" &&
          (got.source_in !== index(item.source_in, edit, input.max_frames) ||
            got.resource !== safeAsset(input, item.source_ref).relative_path ||
            got.gain_db !== (item.gain_envelope?.[0]?.gain_db ?? 0)))
      )
        nativeRefuse("native semantic roundtrip drift");
    });
  }
  return {
    bytes,
    readback,
    required_paths: input.assets.map((a) => a.relative_path),
    registry_digest: r.digest,
    status: "constructed_unqualified",
  };
}
/** Editor output is admitted only against the exact expected generated structure. This initial
 * mapping permits whitespace/property/attribute order normalization, not invented editor changes.
 * A future real normalization differential must explicitly extend it before use. */
export function verifyNormalizedNative(
  expected: WrittenNativeProject,
  bytes: Uint8Array,
  registry: KdenliveFixtureRegistry
): NativeReadback {
  const actual = parseNativeXml(bytes, registry.limits),
    before = parseNativeXml(expected.bytes, registry.limits);
  checkNativeStructure(actual, "internal");
  checkNativeStructure(before, "internal");
  function normalized(n: NativeElement): unknown {
    const properties = n.children
      .filter((c) => c.name === "property")
      .sort((a, b) => (a.attrs.name ?? "").localeCompare(b.attrs.name ?? ""));
    const other = n.children.filter((c) => c.name !== "property");
    return {
      name: n.name,
      attrs: n.attrs,
      text: n.name === "property" ? n.text : "",
      children: [...properties, ...other].map(normalized),
    };
  }
  if (canonicalJson(normalized(actual)) !== canonicalJson(normalized(before))) {
    function first(a: NativeElement, b: NativeElement): string {
      const label = `${a.name}:${a.attrs.id ?? a.attrs.name ?? ""}`;
      if (
        canonicalJson(a.attrs) !== canonicalJson(b.attrs) ||
        (a.name === "property" && a.text !== b.text)
      )
        return label;
      const ordered = (n: NativeElement) => [
        ...n.children
          .filter((c) => c.name === "property")
          .sort((x, y) => (x.attrs.name ?? "").localeCompare(y.attrs.name ?? "")),
        ...n.children.filter((c) => c.name !== "property"),
      ];
      const aa = ordered(a),
        bb = ordered(b);
      if (aa.length !== bb.length) return `${label}:children`;
      for (let i = 0; i < aa.length; i++) {
        const x = nativeRequired(aa[i], "actual child"),
          y = nativeRequired(bb[i], "expected child");
        if (canonicalJson(normalized(x)) !== canonicalJson(normalized(y)))
          return `${label}/${first(x, y)}`;
      }
      return label;
    }
    nativeRefuse(
      `unmapped editor normalization/resource/property change at ${first(actual, before)}`
    );
  }
  const readback = readNativeTimeline(bytes, registry);
  if (canonicalJson(readback) !== canonicalJson(expected.readback))
    nativeRefuse("independent native readback drift");
  return readback;
}
/** The pinned editor serializes its UI end marker one frame beyond maxduration.
 * This narrowly observed differential is not a timing tolerance: placements and maxduration
 * must still equal the exact edit. Only these specific UI fields are canonicalized. */
export function normalizeObservedNative(
  expected: WrittenNativeProject,
  observation: import("./native-phase-protocol.js").NativePhaseObservation,
  registry: KdenliveFixtureRegistry
): Buffer {
  if (!ConfinedNativeRunner.isObserved(observation) || observation.header.verb === "render_compare")
    nativeRefuse("live confined editor observation required");
  const root = parseNativeXml(observation.bytes, registry.limits);
  const prefix =
    observation.header.verb === "relocate_reopen_readback" ? "/work/relocated" : "/work/session";
  if (root.attrs.root !== prefix) nativeRefuse("editor saved outside confined project root");
  const before = parseNativeXml(expected.bytes, registry.limits);
  const expectedSequence = nativeSequence(before);
  const sequence = nativeSequence(root);
  const count = expected.readback.duration_frames;
  const fps = nativeFps(before);
  const expectedWrapper = nativeRequired(
    before.children.find((n) => n.name === "tractor" && prop(n, "kdenlive:projectTractor") === "1"),
    "expected wrapper"
  );
  const wrapper = nativeRequired(
    root.children.find((n) => n.name === "tractor" && prop(n, "kdenlive:projectTractor") === "1"),
    "saved wrapper"
  );
  const rename = new Map([
    [
      nativeRequired(sequence.attrs.id, "sequence id"),
      nativeRequired(expectedSequence.attrs.id, "expected sequence id"),
    ],
    [
      nativeRequired(wrapper.attrs.id, "wrapper id"),
      nativeRequired(expectedWrapper.attrs.id, "expected wrapper id"),
    ],
  ]);
  for (const n of nativeWalk(root))
    for (const key of ["id", "producer"]) {
      const old = n.attrs[key];
      if (old !== undefined && rename.has(old))
        n.attrs[key] = nativeRequired(rename.get(old), "mapped id");
    }
  const captions = sequence.children.filter(
      (n) => n.name === "filter" && prop(n, "mlt_service") === "avfilter.subtitles"
    ),
    priorCaptions = expectedSequence.children.filter(
      (n) => n.name === "filter" && prop(n, "mlt_service") === "avfilter.subtitles"
    );
  if (captions.length !== priorCaptions.length) nativeRefuse("active caption filter coverage");
  if (captions[0] && priorCaptions[0])
    captions[0].attrs.id = nativeRequired(priorCaptions[0].attrs.id, "caption filter id");
  const numericIds = new Map<string, string>();
  for (const n of root.children.filter((c) => c.name === "chain")) {
    const prior = nativeRequired(
      before.children.find((p) => p.name === n.name && p.attrs.id === n.attrs.id),
      "expected chain"
    );
    const current = nativeRequired(prop(n, "kdenlive:id"), "saved bin id"),
      old = nativeRequired(prop(prior, "kdenlive:id"), "expected bin id");
    if (
      !/^[1-9][0-9]*$/u.test(current) ||
      (numericIds.has(current) && numericIds.get(current) !== old)
    )
      nativeRefuse("inconsistent editor bin id");
    numericIds.set(current, old);
  }
  if (new Set(numericIds.values()).size !== numericIds.size) nativeRefuse("aliased editor bin id");
  for (const n of nativeWalk(root))
    if (n.name === "property" && n.attrs.name === "kdenlive:id" && numericIds.has(n.text))
      n.text = nativeRequired(numericIds.get(n.text), "mapped bin id");
  for (const n of root.children) {
    const prior = before.children.find((p) => p.name === n.name && p.attrs.id === n.attrs.id);
    if (prior === undefined && n.name !== "profile") nativeRefuse("unmapped editor graph node");
    if (prior === undefined) continue;
    if (n.name === "chain") {
      n.children = n.children.filter(
        (p) =>
          !(
            p.name === "property" &&
            (p.attrs.name?.startsWith("meta.media.") || p.attrs.name?.startsWith("meta.attr."))
          )
      );
      if (
        prop(prior, "astream") === undefined &&
        prop(n, "astream") === "-1" &&
        prop(n, "audio_index") === "-1"
      )
        n.children = n.children.filter(
          (p) => !(p.name === "property" && p.attrs.name === "astream")
        );
      for (const name of ["format", "kdenlive:id", "kdenlive:file_hash"]) {
        const old = prop(prior, name),
          current = prop(n, name);
        if (name === "kdenlive:id" && !/^[1-9][0-9]*$/u.test(current ?? ""))
          nativeRefuse("invalid editor bin id");
        if (
          name === "kdenlive:file_hash" &&
          current !== undefined &&
          current !== "" &&
          !/^[a-f0-9]{32}$/u.test(current)
        )
          nativeRefuse("invalid media cache hash");
        if (name === "format" && current !== undefined && current !== old)
          nativeRefuse("media format drift");
        if (old !== undefined) set(n, name, old);
      }
    }
    if (n === sequence) {
      const hash = prop(n, "kdenlive:file_hash");
      if (hash !== undefined && !/^[a-f0-9]{32}$/u.test(hash)) nativeRefuse("sequence cache hash");
      if (prop(n, "kdenlive:description") !== undefined && prop(n, "kdenlive:description") !== "")
        nativeRefuse("unexpected sequence description");
      n.children = n.children.filter(
        (p) =>
          !(
            p.name === "property" &&
            ["kdenlive:file_hash", "kdenlive:description"].includes(p.attrs.name ?? "") &&
            prop(prior, p.attrs.name ?? "") === undefined
          )
      );
      if (prop(n, "kdenlive:file_size") === undefined && prop(prior, "kdenlive:file_size") === "0")
        set(n, "kdenlive:file_size", "0");
    }
    if (n.name === "playlist" && n.attrs.id !== "main_bin") {
      const priorItems = prior.children.filter((c) => c.name !== "property"),
        items = n.children.filter((c) => c.name !== "property"),
        tail = priorItems.at(-1);
      if (
        tail?.name === "blank" &&
        items.length + 1 === priorItems.length &&
        nativeFrame(nativeRequired(tail.attrs.length, "terminal gap"), fps) > 0
      ) {
        // Native saves omit an empty tail; restore only the exact declared terminal silence.
        // Actual saved (not repaired) XML is rendered separately for the full comparison.
        n.children.push(structuredClone(tail));
        for (const t of root.children.filter(
          (c) =>
            c.name === "tractor" &&
            c.children.some((c) => c.name === "track" && c.attrs.producer === n.attrs.id)
        )) {
          const previous = nativeRequired(
            before.children.find((c) => c.attrs.id === t.attrs.id),
            "prior track"
          );
          t.attrs.out = nativeRequired(previous.attrs.out, "prior terminal track bound");
        }
      }
    }
    if (n.attrs.id === "main_bin") {
      const name = "kdenlive:docproperties.sessionid";
      if (!/^\{[a-f0-9-]{36}\}$/iu.test(prop(n, name) ?? ""))
        nativeRefuse("invalid editor session id");
      set(n, name, nativeRequired(prop(prior, name), "prior session id"));
      const entries = n.children.filter((p) => p.name === "entry");
      const order = prior.children.filter((p) => p.name === "entry").map((p) => p.attrs.producer);
      if (
        entries.length !== order.length ||
        new Set(entries.map((p) => p.attrs.producer)).size !== entries.length
      )
        nativeRefuse("bin entry coverage");
      n.children = [
        ...n.children.filter((p) => p.name !== "entry"),
        ...order.map((id) =>
          nativeRequired(
            entries.find((p) => p.attrs.producer === id),
            "bin entry"
          )
        ),
      ];
    }
  }
  if (root.children.length !== before.children.length) nativeRefuse("editor graph coverage");
  const top = [...root.children];
  root.children = before.children.map((p) =>
    nativeRequired(
      top.find((n) => n.name === p.name && n.attrs.id === p.attrs.id),
      "editor topological node"
    )
  );
  const resource = (raw: string): string => {
    let p = raw.startsWith(`${prefix}/`) ? raw.slice(prefix.length + 1) : raw;
    while (p.startsWith("./")) p = p.slice(2);
    validatePortablePath(p);
    if (!expected.required_paths.includes(p)) nativeRefuse("editor resource escaped or changed");
    return p;
  };
  root.attrs.root = ".";
  for (const n of nativeWalk(root)) {
    for (const p of n.children.filter((c) => c.name === "property")) {
      const name = p.attrs.name;
      if (name === "av.filename") {
        let value = p.text;
        for (const s of [`${prefix}/`, "./"])
          value = value.startsWith(s) ? value.slice(s.length) : value;
        const sidecar =
          observation.header.verb === "close_reopen_readback"
            ? "saved-second.kdenlive.ass"
            : "saved.kdenlive.ass";
        if (value === sidecar) {
          const caption = observation.header.caption;
          if (
            caption === null ||
            caption.relative_path !== expected.readback.caption_path ||
            caption.sha256 !== caption.sidecar_sha256
          )
            nativeRefuse("unbound saved caption alias");
          p.text = caption.relative_path;
        } else p.text = resource(p.text);
      }
      if (name === "resource" && p.text !== "black") p.text = resource(p.text);
      if (name === "kdenlive:sequenceproperties.subtitlesList") {
        const paths: unknown = JSON.parse(p.text);
        if (!Array.isArray(paths) || paths.length !== 1)
          nativeRefuse("saved caption list coverage");
        const item: unknown = paths[0];
        if (
          typeof item !== "object" ||
          item === null ||
          !("file" in item) ||
          typeof item.file !== "string" ||
          !("id" in item) ||
          item.id !== 0 ||
          !("name" in item) ||
          item.name !== "Subtitles" ||
          Object.keys(item).sort().join(",") !== "file,id,name"
        )
          nativeRefuse("saved caption list shape");
        p.text = canonicalJson([{ file: resource(item.file), id: 0, name: "Subtitles" }]);
      }
      if (
        ["kdenlive:docproperties.browserurl", "kdenlive:docproperties.storagefolder"].includes(
          name ?? ""
        )
      ) {
        if (
          ![
            "",
            ".",
            ...(name === "kdenlive:docproperties.browserurl" ? ["/work/home/Videos/"] : []),
          ].includes(p.text)
        )
          nativeRefuse("editor browser/storage path escaped");
        p.text = ".";
      }
      if (name === "kdenlive:docproperties.layout")
        p.text =
          prop(
            nativeRequired(
              before.children.find((c) => c.attrs.id === "main_bin"),
              "expected bin"
            ),
            name
          ) ?? "{}";
      if (
        name === "kdenlive:sequenceproperties.globalSubtitleStyles" &&
        prop(expectedSequence, name) === undefined
      ) {
        const value: unknown = JSON.parse(p.text);
        if (!Array.isArray(value) || value.length !== 0)
          nativeRefuse("unmapped global caption style");
        n.children = n.children.filter((c) => c !== p);
      }
      if (name === "kdenlive:sequenceproperties.hidesubtitle") {
        if (p.text !== "0") nativeRefuse("editor hid captions");
        n.children = n.children.filter((c) => c !== p);
      }
    }
  }
  if (prop(sequence, "kdenlive:maxduration") !== String(count))
    nativeRefuse("editor content duration drift");
  const seqId = nativeRequired(sequence.attrs.id, "saved sequence");
  for (const n of nativeWalk(root)) {
    if (
      n === sequence ||
      (n.name === "tractor" && prop(n, "kdenlive:projectTractor") === "1") ||
      (["entry", "track"].includes(n.name) && n.attrs.producer === seqId)
    ) {
      const end = nativeFrame(nativeRequired(n.attrs.out, "saved endpoint"), fps);
      if (end !== count - 1 && end !== count) nativeRefuse("unmapped saved endpoint drift");
      n.attrs.out = timestamp(count - 1, fps);
    }
  }
  const duration = nativeRequired(prop(sequence, "kdenlive:duration"), "saved UI duration");
  const clock = /^(\d{2,}):([0-5]\d):([0-5]\d):([0-9]{2})$/u.exec(duration);
  const durationFrames =
    clock === null
      ? nativeFrame(duration, fps)
      : (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * fps +
        Number(clock[4]);
  if (durationFrames !== count && durationFrames !== count + 1)
    nativeRefuse("unmapped saved UI duration");
  set(
    sequence,
    "kdenlive:duration",
    nativeRequired(prop(expectedSequence, "kdenlive:duration"), "expected duration")
  );
  const bytes = serializeNativeXml(root);
  // Whole closed graph equality remains required, not only a caller-selected timeline projection.
  try {
    verifyNormalizedNative(expected, bytes, registry);
  } catch (error) {
    throw new Error("native boundary: observed normalization refused", {
      cause: { reason: String(error), canonical_project: bytes, phase: observation.header },
    });
  }
  return bytes;
}
