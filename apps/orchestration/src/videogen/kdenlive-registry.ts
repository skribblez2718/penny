import { NATIVE_PROPERTY_CONTEXTS } from "./native-property-policy.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  nativeProperty as prop,
  nativeRefuse,
  nativeRequired,
  nativeWalk,
  parseNativeXml,
  type NativeElement,
  type NativeXmlLimits,
} from "./native-xml.js";
import { validatePortablePath } from "./portable-package.js";

export type NativeFeature =
  | "clips"
  | "order"
  | "trims"
  | "gaps"
  | "voice"
  | "voice_gain"
  | "active_caption";
export interface NativeFixtureSource {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}
export interface NativeRegistryBinding {
  readonly editor_build_digest: string;
  readonly mlt_build_digest: string;
  readonly fixtures: readonly NativeFixtureSource[];
  readonly limits: NativeXmlLimits;
}
const attributes: Readonly<Record<string, readonly string[]>> = {
  mlt: ["LC_NUMERIC", "producer", "root", "version"],
  profile: [
    "colorspace",
    "description",
    "display_aspect_den",
    "display_aspect_num",
    "frame_rate_den",
    "frame_rate_num",
    "height",
    "progressive",
    "sample_aspect_den",
    "sample_aspect_num",
    "width",
  ],
  producer: ["id", "in", "out"],
  chain: ["id", "in", "out"],
  playlist: ["id"],
  tractor: ["id", "in", "out"],
  track: ["producer", "hide", "in", "out"],
  entry: ["producer", "in", "out"],
  blank: ["length"],
  filter: ["id", "in", "out"],
  transition: ["id", "in", "out"],
  property: ["name"],
};
const children: Readonly<Record<string, readonly string[]>> = {
  mlt: ["profile", "producer", "chain", "playlist", "tractor"],
  profile: [],
  producer: ["property", "filter"],
  chain: ["property", "filter"],
  playlist: ["property", "entry", "blank"],
  tractor: ["property", "track", "filter", "transition"],
  track: [],
  entry: ["property"],
  blank: [],
  filter: ["property"],
  transition: ["property"],
  property: [],
};
/** Independent interpreter allowlist. A fixture cannot register a new executable service. */
export function checkNativeStructure(root: NativeElement, resources: "fixture" | "internal"): void {
  if (root.name !== "mlt" || root.attrs.version !== "7.41.0" || root.attrs.producer !== "main_bin")
    nativeRefuse("unsupported pinned native format");
  const ids = new Set<string>();
  for (const n of nativeWalk(root)) {
    const attrs = attributes[n.name],
      nested = children[n.name];
    if (
      attrs === undefined ||
      nested === undefined ||
      Object.keys(n.attrs).some((a) => !attrs.includes(a)) ||
      n.children.some((c) => !nested.includes(c.name))
    )
      nativeRefuse("unknown XML node/attribute/context");
    if (n.name !== "property" && n.text.trim() !== "") nativeRefuse("mixed native content");
    n.text = n.name === "property" ? n.text : "";
    if (n.attrs.id !== undefined) {
      if (ids.has(n.attrs.id)) nativeRefuse("duplicate native ID");
      ids.add(n.attrs.id);
    }
    const names = n.children.filter((c) => c.name === "property").map((p) => p.attrs.name);
    if (names.some((k) => k === undefined) || new Set(names).size !== names.length)
      nativeRefuse("duplicate/absent native property");
    const service = prop(n, "mlt_service");
    if (service !== undefined) {
      const allowed =
        n.name === "chain"
          ? ["avformat", "avformat-novalidate"]
          : n.name === "producer"
            ? ["color"]
            : n.name === "transition"
              ? ["mix", "qtblend"]
              : n.name === "filter"
                ? ["volume", "panner", "audiolevel", "avfilter.subtitles"]
                : [];
      if (!allowed.includes(service)) nativeRefuse("unsupported native service/plugin");
      if (["panner", "audiolevel"].includes(service) && prop(n, "disable") !== "1")
        nativeRefuse("enabled nonbase filter");
      if (n.name === "producer" && (prop(n, "resource") !== "black" || service !== "color"))
        nativeRefuse("nonblack producer");
    } else if (["filter", "transition", "chain", "producer"].includes(n.name))
      nativeRefuse("service absent");
    for (const p of n.children.filter((c) => c.name === "property")) {
      const key = nativeRequired(p.attrs.name, "property name");
      if (!NATIVE_PROPERTY_CONTEXTS.has(`${n.name}|${service ?? ""}|${key}`))
        nativeRefuse("unknown native property/context");
      if (
        (key === "xml" && p.text !== "was here") ||
        (key === "xml_retain" && p.text !== "1") ||
        (["kdenlive:docproperties.browserurl", "kdenlive:docproperties.storagefolder"].includes(
          key
        ) &&
          p.text !== "." &&
          !(
            resources === "fixture" &&
            (p.text === "" ||
              (p.text.startsWith("/") &&
                !/[:\\]/u.test(p.text) &&
                !p.text.split("/").includes("..")))
          ))
      )
        nativeRefuse("unsafe metadata/resource marker");
      if (key.endsWith("parameters") && p.text !== "")
        nativeRefuse("executable parameters unsupported");
      if (
        /xml|resource|filename|url|path|folder|proxy|command|script|template|luma|lut|font/iu.test(
          key
        )
      ) {
        const inert = [
          "xml",
          "xml_retain",
          "kdenlive:description",
          "kdenlive:folderid",
          "kdenlive:sequenceFolder",
          "kdenlive:expandedFolders",
          "kdenlive:docproperties.browserurl",
          "kdenlive:docproperties.storagefolder",
          "kdenlive:docproperties.enableexternalproxy",
          "kdenlive:docproperties.enableproxy",
          "kdenlive:docproperties.generateimageproxy",
          "kdenlive:docproperties.generateproxy",
          "kdenlive:docproperties.externalproxyparams",
          "kdenlive:docproperties.proxyparams",
          "kdenlive:docproperties.proxyextension",
          "kdenlive:docproperties.proxyimageminsize",
          "kdenlive:docproperties.proxyimagesize",
          "kdenlive:docproperties.proxyminsize",
          "kdenlive:docproperties.proxyresize",
        ];
        if (key === "resource" && n.name === "producer" && p.text === "black") continue;
        if (
          (key === "resource" && n.name === "chain") ||
          (key === "av.filename" && service === "avfilter.subtitles")
        ) {
          if (resources === "internal") validatePortablePath(p.text);
          else if (
            p.text.includes(":") ||
            p.text.includes("\\") ||
            p.text.split("/").includes("..")
          )
            nativeRefuse("unsafe fixture resource");
        } else if (key.startsWith("kdenlive:folder.")) {
          if (!/^kdenlive:folder\.-?\d+\.\d+$/u.test(key)) nativeRefuse("invalid bin folder");
        } else if (!inert.includes(key)) nativeRefuse(`unknown resource-bearing property ${key}`);
        if (/enable.*proxy|generate.*proxy/u.test(key) && p.text !== "0")
          nativeRefuse("proxies unsupported");
        if (
          [
            "kdenlive:docproperties.externalproxyparams",
            "kdenlive:docproperties.proxyparams",
            "kdenlive:docproperties.proxyextension",
          ].includes(key) &&
          p.text !== ""
        )
          nativeRefuse("proxy commands unsupported");
      }
    }
  }
  for (const n of nativeWalk(root))
    if (n.attrs.producer !== undefined && n !== root && !ids.has(n.attrs.producer))
      nativeRefuse("dangling native producer");
  if (
    root.children.filter((n) => n.name === "profile").length !== 1 ||
    prop(
      nativeRequired(
        root.children.find((n) => n.attrs.id === "main_bin"),
        "main bin"
      ),
      "kdenlive:docproperties.kdenliveversion"
    ) !== "26.08.1"
  )
    nativeRefuse("editor/profile identity mismatch");
}
export function nativeFrame(value: string, fps: number): number {
  if (/^\d+$/u.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) nativeRefuse("native index overflow");
    return n;
  }
  const parts = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/u.exec(value);
  if (parts === null) nativeRefuse("unsupported native time");
  const ms =
    BigInt(nativeRequired(parts[1], "hour")) * 3600000n +
    BigInt(nativeRequired(parts[2], "minute")) * 60000n +
    BigInt(nativeRequired(parts[3], "second")) * 1000n +
    BigInt(nativeRequired(parts[4], "millisecond"));
  const frames = ms * BigInt(fps);
  if (frames % 1000n !== 0n || frames / 1000n > BigInt(Number.MAX_SAFE_INTEGER))
    nativeRefuse("native time not frame exact");
  return Number(frames / 1000n);
}
export function nativeSequence(root: NativeElement): NativeElement {
  return nativeRequired(
    root.children.find((n) => n.name === "tractor" && prop(n, "kdenlive:uuid") !== undefined),
    "sequence"
  );
}
export function nativeFps(root: NativeElement): number {
  const p = nativeRequired(
    root.children.find((n) => n.name === "profile"),
    "profile"
  );
  const fps = Number(p.attrs.frame_rate_num);
  if (p.attrs.frame_rate_den !== "1" || !Number.isSafeInteger(fps) || fps < 1 || 1000 % fps !== 0)
    nativeRefuse("unmapped native timebase");
  return fps;
}
export function nativeTrackPlaylists(
  root: NativeElement
): { tractor: NativeElement; playlist: NativeElement; kind: "voice" | "video" }[] {
  const nodes = new Map(root.children.map((n) => [n.attrs.id, n]));
  return nativeSequence(root)
    .children.filter((n) => n.name === "track")
    .slice(1)
    .map((t) => {
      const tractor = nativeRequired(nodes.get(t.attrs.producer), "track tractor");
      const tracks = tractor.children.filter((n) => n.name === "track");
      if (tracks.length !== 2 || tracks.some((n) => n.attrs.hide !== tracks[0]?.attrs.hide))
        nativeRefuse("unmapped track layout");
      const playlist = nativeRequired(
        nodes.get(nativeRequired(tracks[0], "primary track").attrs.producer),
        "playlist"
      );
      const secondary = nativeRequired(
        nodes.get(nativeRequired(tracks[1], "secondary track").attrs.producer),
        "secondary playlist"
      );
      if (secondary.children.some((n) => n.name !== "property"))
        nativeRefuse("secondary timeline/mix unsupported");
      return {
        tractor,
        playlist,
        kind: prop(tractor, "kdenlive:audio_track") === "1" ? "voice" : "video",
      };
    });
}
/** The registry records demonstrated syntax, NOT editor automation or production qualification.
 * No qualify(callback)/PASS flag exists. Missing differential dimensions stay unavailable. */
export class KdenliveFixtureRegistry {
  readonly digest: string;
  readonly editor_build_digest: string;
  readonly mlt_build_digest: string;
  readonly limits: NativeXmlLimits;
  private readonly sources: readonly {
    digest: string;
    root: NativeElement;
    features: ReadonlySet<NativeFeature>;
  }[];
  constructor(b: NativeRegistryBinding) {
    if (
      Object.keys(b).sort().join(",") !== "editor_build_digest,fixtures,limits,mlt_build_digest" ||
      ![b.editor_build_digest, b.mlt_build_digest].every((d) => /^[a-f0-9]{64}$/u.test(d)) ||
      b.fixtures.length < 1 ||
      b.fixtures.length > 32
    )
      nativeRefuse("closed fixture/build registry required");
    this.editor_build_digest = b.editor_build_digest;
    this.mlt_build_digest = b.mlt_build_digest;
    this.limits = structuredClone(b.limits);
    this.sources = b.fixtures.map((f) => {
      if (Object.keys(f).sort().join(",") !== "bytes,sha256" || sha256(f.bytes) !== f.sha256)
        nativeRefuse("fixture digest mismatch");
      const root = parseNativeXml(f.bytes, b.limits);
      checkNativeStructure(root, "fixture");
      const fps = nativeFps(root),
        nodes = new Map(root.children.map((n) => [n.attrs.id, n]));
      const features = new Set<NativeFeature>();
      for (const t of nativeTrackPlaylists(root)) {
        const entries = t.playlist.children.filter((n) => n.name === "entry");
        if (entries.length) features.add(t.kind === "video" ? "clips" : "voice");
        if (entries.length > 1) features.add("order");
        if (t.playlist.children.some((n) => n.name === "blank")) features.add("gaps");
        for (const e of entries) {
          const chain = nativeRequired(nodes.get(e.attrs.producer), "entry chain");
          if (
            nativeFrame(nativeRequired(e.attrs.in, "source in"), fps) > 0 ||
            nativeFrame(nativeRequired(e.attrs.out, "source out"), fps) + 1 <
              Number(prop(chain, "length"))
          )
            features.add("trims");
          if (
            t.kind === "voice" &&
            chain.children.some(
              (n) =>
                n.name === "filter" &&
                prop(n, "mlt_service") === "volume" &&
                prop(n, "disable") !== "1" &&
                /^-?\d+dB$/u.test(prop(n, "level") ?? "")
            )
          )
            features.add("voice_gain");
        }
      }
      if (
        nativeSequence(root).children.some(
          (n) =>
            n.name === "filter" &&
            prop(n, "mlt_service") === "avfilter.subtitles" &&
            prop(n, "disable") !== "1"
        ) &&
        prop(nativeSequence(root), "kdenlive:sequenceproperties.subtitlesList") !== undefined
      )
        features.add("active_caption");
      return { digest: f.sha256, root, features };
    });
    if (new Set(this.sources.map((s) => s.digest)).size !== this.sources.length)
      nativeRefuse("duplicate fixture");
    this.digest = sha256(
      canonicalJson({
        editor: b.editor_build_digest,
        mlt: b.mlt_build_digest,
        fixtures: this.sources.map((s) => s.digest),
        mapping: "kdenlive-26.08.1-observed-v1",
      })
    );
  }
  fixture(digest: string): NativeElement {
    return structuredClone(
      nativeRequired(
        this.sources.find((s) => s.digest === digest),
        "registered fixture"
      ).root
    );
  }
  require(feature: NativeFeature): NativeElement {
    return structuredClone(
      nativeRequired(
        this.sources.find((s) => s.features.has(feature)),
        `saved differential mapping ${feature}`
      ).root
    );
  }
  available(): NativeFeature[] {
    return [...new Set(this.sources.flatMap((s) => [...s.features]))].sort();
  }
}
