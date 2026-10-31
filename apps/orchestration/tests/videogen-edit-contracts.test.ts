import { describe, expect, it } from "vitest";
import { inspectEditDecision, validateEditDecision } from "../dist/videogen/edit-decision.js";
import { canonicalJson } from "../dist/canonical-json.js";
import { quantizeBoundary, rationalTime } from "../dist/videogen/rational-time.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./helpers/videogen-foundation-fixtures.js";
import { editFixture, persistEdit, replaceItem, time } from "./helpers/videogen-edit-fixtures.js";

function fraction(n: number, d: number) {
  return rationalTime(BigInt(n), BigInt(d));
}
describe("canonical EditDecisionV1 bounded hard-cut intermediate", () => {
  it("retains ordered clips, explicit gap, trims, integral voice/bus gain and active caption/font intent", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const checked = inspectEditDecision(e.host, e.edit_ref);
    expect(checked.edit).toEqual(e.edit);
    expect(checked.quantization.total_frames).toBe(24);
    expect(checked.quantization.total_samples).toBe(8000);
    expect(
      checked.quantization.boundaries.map((b) => [b.item_id, b.frame_in, b.frame_out])
    ).toEqual([
      ["clip_one", 0, 12],
      ["gap_one", 12, 18],
      ["clip_two", 18, 24],
      ["voice_one", 0, 24],
      ["caption_one", 0, 24],
    ]);
    expect(checked.dependency_refs).toContainEqual(e.font);
    expect(checked.dependency_refs).toContainEqual(e.caption);
    expect(checked.dependency_refs).toContainEqual(e.audio.source_ref);
    expect(checked.external_evidence_refs).toContainEqual(e.audio.source.decoded_audio_ref);
    expect(checked).toMatchObject({
      status: "structural_checked",
      production_admission: "blocked",
      effect_permission: "none",
    });
    expect(checked.unverified).toContain("native_interoperability");
    // 32 ticks at 16 fps means TWO seconds, never 32/24 seconds.
    expect(e.measured.decoded_duration).toEqual(time(2));
  });
  it("uses absolute ties-to-even frame boundaries, not rounded segment duration", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const first = e.edit.tracks[0];
    if (first === undefined) throw new Error("picture fixture missing");
    const clip = first.items.find((i) => i.kind === "clip");
    if (clip?.kind !== "clip") throw new Error("clip missing");
    const picture = {
      ...first,
      items: [
        {
          kind: "gap" as const,
          item_id: "initial_gap",
          timeline_start: time(0),
          timeline_end: time(1, 48),
        },
        {
          ...clip,
          source_in: time(0),
          source_out: time(1, 24),
          timeline_start: time(1, 48),
          timeline_end: time(1, 16),
          frame_in: 0,
          frame_out: 2,
        },
        {
          kind: "gap" as const,
          item_id: "end_gap",
          timeline_start: time(1, 16),
          timeline_end: time(1),
        },
      ],
    };
    const edit = {
      ...e.edit,
      tracks: [picture, ...e.edit.tracks.slice(1)],
      cut_boundaries: [time(1, 48), time(1, 16)],
    };
    const result = inspectEditDecision(e.host, persistEdit(f, edit));
    const boundary = result.quantization.boundaries.find((b) => b.item_id === clip.item_id);
    expect(boundary).toMatchObject({
      frame_in: 0,
      frame_out: 2,
      frame_residuals: [time(1, 48), time(-1, 48)],
    });
    expect(() =>
      inspectEditDecision(
        e.host,
        persistEdit(
          f,
          replaceItem(validateEditDecision(edit, FOUNDATION_LIMITS), clip.item_id, { frame_out: 1 })
        )
      )
    ).toThrow(/indices drift/);
  });
  it("uses absolute ties-to-even samples, permitting an audio placement shorter than a frame", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const voice = e.edit.tracks[1];
    if (voice === undefined) throw new Error("voice fixture missing");
    const clip = voice.items[0];
    if (clip?.kind !== "clip") throw new Error("voice clip missing");
    const changed = {
      ...voice,
      items: [
        {
          kind: "gap" as const,
          item_id: "voice_lead",
          timeline_start: time(0),
          timeline_end: time(1, 16000),
        },
        {
          ...clip,
          source_in: time(1, 16000),
          source_out: time(3, 16000),
          timeline_start: time(1, 16000),
          timeline_end: time(3, 16000),
          frame_in: 0,
          frame_out: 0,
          sample_in: 0,
          sample_out: 2,
        },
        {
          kind: "gap" as const,
          item_id: "voice_tail",
          timeline_start: time(3, 16000),
          timeline_end: time(1),
        },
      ],
    };
    const result = inspectEditDecision(
      e.host,
      persistEdit(f, { ...e.edit, tracks: [e.edit.tracks[0], changed, ...e.edit.tracks.slice(2)] })
    );
    expect(result.quantization.boundaries.find((b) => b.item_id === "voice_one")).toMatchObject({
      sample_in: 0,
      sample_out: 2,
      sample_residuals: [time(1, 16000), time(-1, 16000)],
    });
  });
  it("does not accumulate duration rounding over many ordered shots", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const picture = e.edit.tracks[0];
    if (picture === undefined) throw new Error("picture missing");
    const base = picture.items[0];
    if (base?.kind !== "clip") throw new Error("clip missing");
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      item_id: `placement_${i}`,
      source_in: time(0),
      source_out: time(1, 20),
      timeline_start: fraction(i, 20),
      timeline_end: fraction(i + 1, 20),
      frame_in: quantizeBoundary(fraction(i, 20), e.edit.canvas.fps, 10000).index,
      frame_out: quantizeBoundary(fraction(i + 1, 20), e.edit.canvas.fps, 10000).index,
    }));
    const result = inspectEditDecision(
      e.host,
      persistEdit(f, {
        ...e.edit,
        tracks: [{ ...picture, items }, ...e.edit.tracks.slice(1)],
        cut_boundaries: Array.from({ length: 19 }, (_, i) => fraction(i + 1, 20)),
      })
    );
    const boundaries = result.quantization.boundaries.filter((b) =>
      b.item_id.startsWith("placement_")
    );
    expect(boundaries.reduce((sum, b) => sum + b.frame_out - b.frame_in, 0)).toBe(24);
    expect(new Set(boundaries.map((b) => b.frame_out - b.frame_in))).toEqual(new Set([1, 2]));
    expect(boundaries.at(-1)?.frame_out).toBe(24);
  });
  it.each([
    ["duplicate cross-track ID", { item_id: "clip_one" }],
    ["unsupported effect", { effect_ids: ["crossfade"] }],
    [
      "unqualified speed",
      {
        speed_map: [
          { source_time: time(0), timeline_time: time(0) },
          { source_time: time(1), timeline_time: time(1) },
        ],
      },
    ],
    ["unknown authority", { playback_verified: true }],
    ["source duration mismatch", { source_out: time(2) }],
    ["sample index mismatch", { sample_out: 7999 }],
    ["missing paired sample", { sample_out: undefined }],
    ["gain outside placement", { gain_envelope: [{ sample_index: 8000, gain_db: -6 }] }],
    [
      "unqualified automation",
      {
        gain_envelope: [
          { sample_index: 0, gain_db: -6 },
          { sample_index: 100, gain_db: -3 },
        ],
      },
    ],
    ["fractional foundation dB", { gain_envelope: [{ sample_index: 0, gain_db: -6.5 }] }],
  ])("refuses %s without dropping it", (_label, patch) => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    expect(() =>
      inspectEditDecision(e.host, persistEdit(f, replaceItem(e.edit, "voice_one", patch)))
    ).toThrow();
  });
  it("rejects overlap/implicit gap, reordered tracks, cut omission and dangling/double bus routing", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    for (const value of [
      replaceItem(e.edit, "clip_two", { timeline_start: time(1, 2) }),
      { ...e.edit, tracks: [...e.edit.tracks].reverse() },
      { ...e.edit, cut_boundaries: [] },
      {
        ...e.edit,
        mix_buses: [
          {
            bus_id: "bad",
            source_track_ids: ["picture"],
            gain_envelope: [{ sample_index: 0, gain_db: 0 }],
            loudness_target_lufs: -16,
          },
        ],
      },
      { ...e.edit, mix_buses: [...e.edit.mix_buses, { ...e.edit.mix_buses[0], bus_id: "double" }] },
      { ...e.edit, audio_policy: "retain_as_sole_speech" },
      { ...e.edit, effect_registry_refs: [e.style] },
      {
        ...e.edit,
        tracks: e.edit.tracks.map((t) =>
          t.track_id !== "picture"
            ? t
            : {
                ...t,
                items: [
                  {
                    kind: "transition",
                    from_id: "clip_one",
                    to_id: "dangling",
                    span: { start: time(0), end: time(1) },
                    parameters_ref: e.style,
                  },
                ],
              }
        ),
      },
    ])
      expect(() => validateEditDecision(value, FOUNDATION_LIMITS)).toThrow();
  });
  it("refuses zero-length quantized video, unsafe integers, unreduced time and representation/work caps", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    for (const host of [
      { ...e.host, edit_policy: { ...e.host.edit_policy, max_frames: 23 } },
      { ...e.host, edit_policy: { ...e.host.edit_policy, max_samples: 7999 } },
      { ...e.host, edit_policy: { ...e.host.edit_policy, max_width: 639 } },
      { ...e.host, edit_policy: { ...e.host.edit_policy, max_duration: time(1, 2) } },
      { ...e.host, edit_policy: { ...e.host.edit_policy, max_frames: Infinity } },
      { ...e.host, limits: { ...FOUNDATION_LIMITS, max_json_bytes: 100 } },
      { ...e.host, limits: { ...FOUNDATION_LIMITS, max_collection_items: 2 } },
    ])
      expect(() => inspectEditDecision(host, e.edit_ref)).toThrow();
    expect(() =>
      validateEditDecision({ ...e.edit, end_time: time(2, 2) }, FOUNDATION_LIMITS)
    ).toThrow();
    expect(() =>
      validateEditDecision(
        { ...e.edit, canvas: { ...e.edit.canvas, width: Number.MAX_SAFE_INTEGER + 1 } },
        FOUNDATION_LIMITS
      )
    ).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateEditDecision(cyclic, FOUNDATION_LIMITS)).toThrow(/cyclic/);
  });
  it("refuses a zero-frame non-gap video and multiple active caption tracks", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const picture = e.edit.tracks[0];
    const caption = e.edit.tracks[2];
    if (picture === undefined || caption === undefined) throw new Error("fixture tracks missing");
    const clip = picture.items[0];
    if (clip?.kind !== "clip") throw new Error("fixture clip missing");
    const edit = {
      ...e.edit,
      tracks: [
        {
          ...picture,
          items: [
            {
              ...clip,
              source_in: time(0),
              source_out: time(1, 100),
              timeline_start: time(0),
              timeline_end: time(1, 100),
              frame_in: 0,
              frame_out: 0,
            },
            { kind: "gap", item_id: "tail", timeline_start: time(1, 100), timeline_end: time(1) },
          ],
        },
        ...e.edit.tracks.slice(1),
      ],
      cut_boundaries: [time(1, 100)],
    };
    expect(() => inspectEditDecision(e.host, persistEdit(f, edit))).toThrow(
      /zero-length quantized/
    );
    expect(() =>
      validateEditDecision(
        {
          ...e.edit,
          tracks: [
            ...e.edit.tracks,
            {
              ...caption,
              track_id: "other_caption",
              order: 3,
              items: caption.items.map((i) => ({ ...i, item_id: "other_caption_item" })),
            },
          ],
        },
        FOUNDATION_LIMITS
      )
    ).toThrow(/multiple active caption/);
  });
  it("refuses source PTS drift and trim outside measured source without reinterpreting source rate", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const wrongFacts = f.json(
      { ...e.measured, decoded_duration: time(4, 3) },
      e.measured.schema_id
    );
    expect(() =>
      inspectEditDecision({ ...e.host, measured_source_refs: [wrongFacts] }, e.edit_ref)
    ).toThrow(/PTS duration/);
    expect(() =>
      inspectEditDecision(
        e.host,
        persistEdit(
          f,
          replaceItem(e.edit, "clip_one", { source_in: time(7, 4), source_out: time(9, 4) })
        )
      )
    ).toThrow(/trim exceeds/);
    const quantized = inspectEditDecision(e.host, e.edit_ref);
    expect(quantized.quantization.total_frames).toBe(24);
    expect(() =>
      inspectEditDecision(
        { ...e.host, edit_policy: { ...e.host.edit_policy, sync_tolerance: time(0) } },
        persistEdit(f, {
          ...e.edit,
          canvas: { ...e.edit.canvas, fps: { numerator: 25, denominator: 1 } },
        })
      )
    ).toThrow(/sync tolerance/);
  });
  it("rejects noncanonical/duplicate-key semantic bytes and extra schema versions", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const text = canonicalJson(e.edit);
    for (const bytes of [
      " " + text,
      text.replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
      Buffer.from([255]),
    ]) {
      const ref = f.raw(bytes, "application/json", e.edit.schema_id);
      expect(() => inspectEditDecision(e.host, ref)).toThrow();
    }
    expect(() =>
      inspectEditDecision(e.host, {
        ...e.edit_ref,
        content_schema: { schema_id: e.edit.schema_id, schema_version: 2 },
      })
    ).toThrow();
  });
});
