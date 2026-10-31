import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  KdenliveFixtureRegistry,
  checkNativeStructure,
  nativeSequence,
} from "../dist/videogen/kdenlive-registry.js";
import {
  nativeWalk,
  parseNativeXml,
  serializeNativeXml,
  setNativeProperty,
} from "../dist/videogen/native-xml.js";
import {
  readNativeTimeline,
  writeNativeProject,
  verifyNormalizedNative,
} from "../dist/videogen/kdenlive-writer.js";
import { FoundationFixture } from "./helpers/videogen-foundation-fixtures.js";
import { time } from "./helpers/videogen-edit-fixtures.js";
import { nativeInput, registry, saved, XML_LIMITS } from "./helpers/videogen-native-fixtures.js";
describe("real saved differential fixture-derived native boundary (not editor qualification)", () => {
  it("parses actual saved graph, distinguishes imported audio from voice placement, and freezes registry", () => {
    const r = registry();
    expect(r.available()).toEqual(["active_caption", "clips", "order"]);
    expect(() => r.require("voice_gain")).toThrow("saved differential mapping voice_gain");
    const tree = parseNativeXml(saved("single.kdenlive"), XML_LIMITS);
    checkNativeStructure(tree, "internal");
    expect(
      readNativeTimeline(serializeNativeXml(tree), r)
        .tracks.flatMap((t) => t.items)
        .filter((i) => i.kind === "clip")
    ).toHaveLength(1);
    expect(
      () =>
        new KdenliveFixtureRegistry({
          editor_build_digest: sha256("a"),
          mlt_build_digest: sha256("b"),
          limits: XML_LIMITS,
          fixtures: [{ bytes: saved("single.kdenlive"), sha256: sha256("wrong") }],
        })
    ).toThrow("fixture digest");
  });
  it("constructs deterministic native project from an actual saved fixture and independently reads exact source/order/ranges", () => {
    using f = new FoundationFixture();
    const input = nativeInput(f),
      result = writeNativeProject(input);
    expect(result.status).toBe("constructed_unqualified");
    expect(result.bytes.equals(writeNativeProject(input).bytes)).toBe(true);
    expect(result.readback.duration_frames).toBe(50);
    expect(result.readback.tracks.flatMap((t) => t.items)).toEqual([
      { kind: "clip", start: 0, end: 50, source_in: 0, resource: "assets/video.mp4", gain_db: 0 },
    ]);
    expect(verifyNormalizedNative(result, result.bytes, input.registry)).toEqual(result.readback);
    const tree = parseNativeXml(result.bytes, XML_LIMITS);
    tree.attrs.root = "/external";
    expect(() =>
      verifyNormalizedNative(result, serializeNativeXml(tree), input.registry)
    ).toThrow();
    expect(result.bytes.toString()).not.toContain("/work/");
    expect(result.bytes.toString()).not.toContain("/home/");
  });
  it("keeps the actual saved active subtitle graph and exact ASS asset without claiming font/render qualification", () => {
    using f = new FoundationFixture();
    const input = nativeInput(f),
      track = input.edit.tracks[0],
      clip = track?.items[0];
    if (track === undefined || clip?.kind !== "clip") throw new Error("clip missing");
    const caption = f.raw(
        saved("caption.ass")
          .toString()
          .replace("00:00:02.00,00:00:07.00", "00:00:00.00,00:00:08.00"),
        "text/x-ass"
      ),
      font = f.opaque("synthetic font bytes NOT qualified", "font/ttf");
    const style = f.json(
      {
        schema_id: "penny.videogen-edit-caption-style.v1",
        schema_version: 1,
        font_ref: font,
        size_px: 16,
        color_rgba: "ffffffff",
      },
      "penny.videogen-edit-caption-style.v1"
    );
    const result = writeNativeProject({
      ...input,
      edit: {
        ...input.edit,
        end_time: time(8),
        tracks: [
          {
            ...track,
            items: [{ ...clip, source_out: time(8), timeline_end: time(8), frame_out: 200 }],
          },
          {
            track_id: "captions",
            kind: "caption",
            order: 1,
            items: [
              {
                kind: "caption",
                item_id: "caption",
                text_source_ref: caption,
                style_ref: style,
                language: "en",
                timeline_start: time(0),
                timeline_end: time(8),
              },
            ],
          },
        ],
      },
      assets: [
        ...input.assets.map((a) => ({ ...a, duration_frames: 200 })),
        ...[
          { ref: caption, p: "captions/caption.ass" },
          { ref: style, p: "captions/style.json" },
          { ref: font, p: "fonts/font.ttf" },
        ].map(({ ref, p }) => ({
          source_ref: ref,
          relative_path: p,
          bytes: f.store.read(ref),
          duration_frames: 0,
        })),
      ],
    });
    expect(result.readback.caption_path).toBe("captions/caption.ass");
    expect(result.bytes.toString()).toContain("avfilter.subtitles");
    expect(verifyNormalizedNative(result, result.bytes, input.registry)).toEqual(result.readback);
  });
  it("rejects missing trim/gap/gain/voice mappings rather than dropping edit features", () => {
    using f = new FoundationFixture();
    const input = nativeInput(f),
      track = input.edit.tracks[0],
      clip = track?.items[0];
    if (track === undefined || clip?.kind !== "clip") throw new Error("missing fixture");
    const changed = {
      ...input,
      edit: {
        ...input.edit,
        tracks: [{ ...track, items: [{ ...clip, source_in: time(1), source_out: time(3) }] }],
      },
      assets: input.assets.map((a) => ({ ...a, duration_frames: 100 })),
    };
    expect(() => writeNativeProject(changed)).toThrow("mapping trims");
    expect(() =>
      writeNativeProject({
        ...input,
        edit: {
          ...input.edit,
          tracks: [
            {
              ...track,
              kind: "voice",
              items: [
                {
                  ...clip,
                  sample_in: 0,
                  sample_out: 16000,
                  gain_envelope: [{ sample_index: 0, gain_db: -6 }],
                },
              ],
            },
          ],
        },
      })
    ).toThrow("mapping voice");
    expect(() =>
      writeNativeProject({
        ...input,
        edit: {
          ...input.edit,
          tracks: [
            {
              ...track,
              items: [
                { kind: "gap", item_id: "gap", timeline_start: time(0), timeline_end: time(2) },
              ],
            },
          ],
        },
      })
    ).toThrow("mapping gaps");
  });
  it("writes demonstrated repeated ordered clips, without fabricating original duration", () => {
    using f = new FoundationFixture();
    const input = nativeInput(f),
      track = input.edit.tracks[0],
      clip = track?.items[0];
    if (track === undefined || clip?.kind !== "clip") throw new Error("missing fixture");
    const result = writeNativeProject({
      ...input,
      edit: {
        ...input.edit,
        end_time: time(4),
        cut_boundaries: [time(2)],
        tracks: [
          {
            ...track,
            items: [
              clip,
              {
                ...clip,
                item_id: "second",
                timeline_start: time(2),
                timeline_end: time(4),
                frame_in: 50,
                frame_out: 100,
              },
            ],
          },
        ],
      },
    });
    expect(result.readback.tracks.flatMap((t) => t.items).map((i) => [i.start, i.end])).toEqual([
      [0, 50],
      [50, 100],
    ]);
    expect(() =>
      writeNativeProject({
        ...input,
        assets: input.assets.map((a) => ({ ...a, bytes: Buffer.from("wrong") })),
      })
    ).toThrow("asset digest");
  });
  it.each([
    "<!DOCTYPE mlt [<!ENTITY x SYSTEM 'file:///secret'>]><mlt/>",
    "<mlt><xi:include/></mlt>",
    "<mlt a='1' a='2'/>",
    "<mlt>&unknown;</mlt>",
    "<mlt/><?x test?>",
    "<mlt/><mlt/>",
    "<mlt><chain></mlt>",
    "<mlt>&#0;</mlt>",
    "<mlt><![CDATA[x]]></mlt>",
  ])("rejects hostile/unsupported XML before native open: %s", (xml) => {
    expect(() => parseNativeXml(Buffer.from(xml), XML_LIMITS)).toThrow();
  });
  it("rejects unknown service, resource-bearing property, attribute and normalized byte/property drift", () => {
    using f = new FoundationFixture();
    const input = nativeInput(f),
      result = writeNativeProject(input);
    for (const mutate of [
      (tree: ReturnType<typeof parseNativeXml>) =>
        setNativeProperty(nativeSequence(tree), "command", "malicious"),
      (tree: ReturnType<typeof parseNativeXml>) => {
        const chain = tree.children.find((n) => n.name === "chain");
        if (chain === undefined) throw new Error("missing chain");
        setNativeProperty(chain, "resource", "../secret");
      },
      (tree: ReturnType<typeof parseNativeXml>) => {
        const filter = nativeWalk(tree).find((n) => n.name === "filter");
        if (filter === undefined) throw new Error("missing filter");
        setNativeProperty(filter, "mlt_service", "dynamictext");
      },
      (tree: ReturnType<typeof parseNativeXml>) => {
        nativeSequence(tree).attrs.unknown = "x";
      },
      (tree: ReturnType<typeof parseNativeXml>) => {
        setNativeProperty(nativeSequence(tree), "new-property", "surprise");
      },
    ]) {
      const tree = parseNativeXml(result.bytes, XML_LIMITS);
      mutate(tree);
      expect(() =>
        verifyNormalizedNative(result, serializeNativeXml(tree), input.registry)
      ).toThrow();
    }
    expect(() => parseNativeXml(saved("single.kdenlive"), { ...XML_LIMITS, max_nodes: 4 })).toThrow(
      "complexity"
    );
    expect(() => parseNativeXml(saved("single.kdenlive"), { ...XML_LIMITS, max_bytes: 4 })).toThrow(
      "byte limit"
    );
    expect(canonicalJson(result.readback)).not.toContain("qualified");
  });
});
