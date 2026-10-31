import { describe, expect, it } from "vitest";
import {
  inspectPortablePackage,
  portablePathFor,
  validatePortableManifest,
  validatePortablePath,
} from "../dist/videogen/portable-package.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./helpers/videogen-foundation-fixtures.js";
import { editFixture, packageFixture } from "./helpers/videogen-edit-fixtures.js";

describe("portable canonical manifest structural closure", () => {
  it("closes exact originals, speech, script, active captions/fonts, licenses and environment without self/review hashes", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    const checked = inspectPortablePackage(e.host, p.manifest);
    expect(checked.canonical_bytes.toString("utf8")).toBe(canonicalJson(p.manifest));
    expect(checked.manifest_sha256).toBe(sha256(checked.canonical_bytes));
    expect(checked.manifest.files.some((file) => file.relative_path === "manifest.json")).toBe(
      false
    );
    expect(
      checked.manifest.files.some((file) => file.producer_ref.artifact_id === e.font.artifact_id)
    ).toBe(true);
    expect(checked.manifest.clip_to_timeline.map((m) => m.clip_id)).toEqual([
      "clip_one",
      "clip_two",
      "voice_one",
    ]);
    expect(checked.manifest.files.filter((file) => file.role === "original_video")).toHaveLength(1);
    expect(checked).toMatchObject({
      production_admission: "blocked",
      effect_permission: "none",
      status: "structural_checked",
    });
    expect(checked.unverified).toContain("native_xml_resource_and_plugin_readback");
    expect(checked.unverified).toContain("external_manifest_bound_reviews");
  });
  it.each([
    "../escape",
    "/absolute",
    "a/../escape",
    "a//b",
    "a/./b",
    "a\\b",
    "a:%2fb",
    "a/%2e%2e/b",
    ".hidden",
    "a/..",
    "a/CON.txt",
    "a/nul",
    "a./b",
    "a/é",
    "a/\u0000b",
    "a/",
  ])("refuses unsafe internal path %s", (name) => {
    expect(() => validatePortablePath(name)).toThrow();
  });
  it("generates root-independent stable internal paths from exact artifact identity", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    expect(portablePathFor(e.video, "original_video")).toBe(
      `original_video/${e.video.artifact_id}.mp4`
    );
    expect(portablePathFor(e.font, "title_asset")).toBe(`title_asset/${e.font.artifact_id}.ttf`);
    expect(validatePortablePath("media/clip-one.mp4")).toBe("media/clip-one.mp4");
  });
  it("refuses missing originals/font/caption/script/native resources, proxy-only and native substitutions", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    for (const ref of [
      e.video,
      e.font,
      e.caption,
      e.script_ref,
      e.audio.source.media_ref,
      p.project,
    ])
      expect(() =>
        inspectPortablePackage(e.host, {
          ...p.manifest,
          files: p.manifest.files.filter(
            (file) => file.producer_ref.artifact_id !== ref.artifact_id
          ),
        })
      ).toThrow();
    for (const patch of [
      { role: "proxy" },
      { bytes: e.video.byte_length + 1 },
      { sha256: "f".repeat(64) },
      { media_type: "image/png" },
      { used_by: [] },
      { relative_path: "original_video/changed.mp4" },
      { license_ref: e.style },
    ])
      expect(() =>
        inspectPortablePackage(e.host, {
          ...p.manifest,
          files: p.manifest.files.map((file) =>
            file.producer_ref.artifact_id === e.video.artifact_id ? { ...file, ...patch } : file
          ),
        })
      ).toThrow();
    for (const patch of [
      { role: "documentation" },
      { media_type: "application/x-otio" },
      { relative_path: "project/fake.mlt" },
    ])
      expect(() =>
        inspectPortablePackage(e.host, {
          ...p.manifest,
          files: p.manifest.files.map((file) =>
            file.role === "project" ? { ...file, ...patch } : file
          ),
        })
      ).toThrow();
  });
  it("rejects duplicate/case-folded/prefix collisions, conflicting producer mappings and cycles", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    const a = p.manifest.files[0];
    const b = p.manifest.files[1];
    if (a === undefined || b === undefined) throw new Error("fixture payload missing");
    for (const file of [
      { ...b, relative_path: a.relative_path.toUpperCase() },
      { ...b, relative_path: `${a.relative_path}/child` },
      { ...b, producer_ref: a.producer_ref },
    ])
      expect(() =>
        validatePortableManifest({ ...p.manifest, files: [a, file] }, FOUNDATION_LIMITS)
      ).toThrow();
    expect(() =>
      validatePortableManifest(
        {
          ...p.manifest,
          reference_graph: [
            { from: a.relative_path, to: b.relative_path },
            { from: b.relative_path, to: a.relative_path },
          ],
        },
        FOUNDATION_LIMITS
      )
    ).toThrow(/cyclic/);
    expect(() =>
      validatePortableManifest(
        { ...p.manifest, reference_graph: [{ from: a.relative_path, to: "unlisted.bin" }] },
        FOUNDATION_LIMITS
      )
    ).toThrow(/unlisted/);
    expect(() => inspectPortablePackage(e.host, { ...p.manifest, reference_graph: [] })).toThrow(
      /dropped semantic/
    );
  });
  it("requires every Clip.item_id, including audio, once at exact track/span; Gap/Caption IDs are not Clip IDs", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    const mapping = p.manifest.clip_to_timeline[0];
    if (mapping === undefined) throw new Error("mapping missing");
    for (const patch of [
      { clip_id: "gap_one" },
      { clip_id: "caption_one" },
      { clip_id: e.video.artifact_id },
      { track_id: "speech" },
      { end: { numerator: 1, denominator: 1 } },
    ])
      expect(() =>
        inspectPortablePackage(e.host, {
          ...p.manifest,
          clip_to_timeline: [{ ...mapping, ...patch }, ...p.manifest.clip_to_timeline.slice(1)],
        })
      ).toThrow();
    expect(() =>
      inspectPortablePackage(e.host, {
        ...p.manifest,
        clip_to_timeline: p.manifest.clip_to_timeline.slice(0, 2),
      })
    ).toThrow(/mapping coverage/);
    expect(() =>
      inspectPortablePackage(e.host, {
        ...p.manifest,
        clip_to_timeline: [...p.manifest.clip_to_timeline, mapping],
      })
    ).toThrow(/unique/);
  });
  it("refuses receipt cycles, root digest, caller proof booleans and unqualified subset/effects", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    for (const patch of [
      { root_digest: "1".repeat(64) },
      { review_ref: e.audio.source.decoded_audio_ref },
      { native_verified: true },
      { g5_approved: true },
    ])
      expect(() =>
        validatePortableManifest({ ...p.manifest, ...patch }, FOUNDATION_LIMITS)
      ).toThrow();
    const file = {
      relative_path: portablePathFor(e.audio.source.decoded_audio_ref, "provenance"),
      role: "provenance",
      sha256: e.audio.source.decoded_audio_ref.content_digest,
      bytes: e.audio.source.decoded_audio_ref.byte_length,
      media_type: "application/json",
      producer_ref: e.audio.source.decoded_audio_ref,
      used_by: [],
    };
    expect(() =>
      inspectPortablePackage(e.host, { ...p.manifest, files: [...p.manifest.files, file] })
    ).toThrow(/review and delivery receipts/);
    const self = f.json(p.manifest, p.manifest.schema_id);
    expect(() =>
      validatePortableManifest(
        {
          ...p.manifest,
          files: [
            ...p.manifest.files,
            {
              ...file,
              relative_path: portablePathFor(self, "documentation"),
              producer_ref: self,
              sha256: self.content_digest,
              bytes: self.byte_length,
            },
          ],
        },
        FOUNDATION_LIMITS
      )
    ).toThrow(/excludes self/);
    const subset = f.json(
      {
        schema_id: "penny.videogen-edit-feature-subset.v1",
        schema_version: 1,
        features: ["hard_cuts", "ordered_clips", "trims"],
      },
      "penny.videogen-edit-feature-subset.v1"
    );
    const subsetFile = p.manifest.files.find(
      (item) => item.producer_ref.artifact_id === p.subset.artifact_id
    );
    if (subsetFile === undefined) throw new Error("subset payload missing");
    const subsetPath = portablePathFor(subset, subsetFile.role);
    expect(() =>
      inspectPortablePackage(e.host, {
        ...p.manifest,
        feature_subset_ref: subset,
        files: p.manifest.files.map((item) =>
          item === subsetFile
            ? {
                ...item,
                producer_ref: subset,
                relative_path: subsetPath,
                bytes: subset.byte_length,
                sha256: subset.content_digest,
              }
            : item
        ),
      })
    ).toThrow(/drop an edit feature/);
  });
  it("refuses unpackaged environment dependencies, stale master rights and changed master descriptors", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    for (const dependencies of [
      [{ id: "font_main", digest: e.font.content_digest, packaged: false }],
      [{ id: "font_main", digest: "f".repeat(64), packaged: true }],
    ])
      expect(() =>
        inspectPortablePackage(e.host, {
          ...p.manifest,
          environment: { ...p.manifest.environment, dependencies },
        })
      ).toThrow(/unpackaged/);
    const revoked = {
      ...e.host,
      current_rights: e.host.current_rights.map((r) =>
        r.subject_ref.artifact_id === p.master.artifact_id
          ? { ...r, status: "revoked" as const }
          : r
      ),
    };
    expect(() => inspectPortablePackage(revoked, p.manifest)).toThrow(/rights/);
    expect(() =>
      inspectPortablePackage(e.host, {
        ...p.manifest,
        accepted_master: { ...p.manifest.accepted_master, sha256: "f".repeat(64) },
      })
    ).toThrow(/descriptor drift/);
    expect(() =>
      inspectPortablePackage(e.host, {
        ...p.manifest,
        files: p.manifest.files.map((file) => ({ ...file, used_by: ["invented"] })),
      })
    ).toThrow();
  });
  it("enforces per-file/aggregate/count budgets and persisted residuals before any manifest freeze", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    for (const policy of [
      { ...e.host.package_policy, max_files: 1 },
      { ...e.host.package_policy, max_file_bytes: 1 },
      { ...e.host.package_policy, max_payload_bytes: 1 },
      { ...e.host.package_policy, max_payload_bytes: Infinity },
    ])
      expect(() =>
        inspectPortablePackage({ ...e.host, package_policy: policy }, p.manifest)
      ).toThrow(/package/);
    const quantized = p.manifest.files.find(
      (file) =>
        file.producer_ref.content_schema?.schema_id === "penny.videogen-edit-quantization.v1"
    );
    if (quantized === undefined) throw new Error("quantization fixture missing");
    expect(() =>
      inspectPortablePackage(e.host, {
        ...p.manifest,
        files: p.manifest.files.filter((file) => file !== quantized),
        reference_graph: p.manifest.reference_graph.filter(
          (edge) => edge.from !== quantized.relative_path && edge.to !== quantized.relative_path
        ),
      })
    ).toThrow(/persisted exact quantization/);
    const original: unknown = JSON.parse(f.store.read(quantized.producer_ref).toString("utf8"));
    if (original === null || typeof original !== "object")
      throw new Error("invalid quantization fixture");
    const changed = f.json(
      { ...original, total_frames: 23 },
      "penny.videogen-edit-quantization.v1"
    );
    const relative = portablePathFor(changed, quantized.role);
    expect(() =>
      inspectPortablePackage(e.host, {
        ...p.manifest,
        files: p.manifest.files.map((file) =>
          file === quantized
            ? {
                ...file,
                producer_ref: changed,
                relative_path: relative,
                bytes: changed.byte_length,
                sha256: changed.content_digest,
              }
            : file
        ),
        reference_graph: p.manifest.reference_graph.map((edge) => ({
          from: edge.from === quantized.relative_path ? relative : edge.from,
          to: edge.to === quantized.relative_path ? relative : edge.to,
        })),
      })
    ).toThrow(/persisted quantization drift/);
  });
  it("requires transformation originals rather than retaining only current processed video", () => {
    using f = new FoundationFixture();
    const e = editFixture(f, { transformed: true });
    const p = packageFixture(f, e);
    expect(
      inspectPortablePackage(e.host, p.manifest).manifest.files.filter(
        (file) => file.role === "original_video"
      )
    ).toHaveLength(2);
    expect(() =>
      inspectPortablePackage(e.host, {
        ...p.manifest,
        files: p.manifest.files.filter(
          (file) => file.producer_ref.artifact_id !== e.original.artifact_id
        ),
      })
    ).toThrow();
  });
});
