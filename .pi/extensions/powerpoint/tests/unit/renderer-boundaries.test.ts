import { describe, expect, it } from "vitest";
import {
  _resolve_design,
  adaptInternalMediaSpec,
  adaptInternalSlideDesignPatch,
  adaptPptxSlide,
  normalize_slide,
  parse_options,
  parseMarkdownTokenArray,
  pptxWriteOutputToBuffer,
} from "../../renderer.js";
import { requireDefined } from "../helpers/contracts.js";

describe("renderer boundary contracts", () => {
  it("characterizes valid, missing, wrong, and extra untrusted slide-spec fields", () => {
    const options = parse_options({
      output_path: "/tmp/boundary-characterization.pptx",
      project_root: "/tmp",
      future_top_level: { retained: true },
    });
    expect(options.theme_name).toBe("executive");
    expect(
      parse_options({ output_path: "/tmp/modern.pptx", project_root: "/tmp", theme: "modern" })
        .theme_name
    ).toBe("modern");
    expect(() =>
      parse_options({ output_path: "/tmp/wrong.pptx", project_root: "/tmp", theme: "future" })
    ).toThrow(/theme must be one of/i);

    const openLegacySlide = normalize_slide({
      title: "Default content",
      future_layout_token: { retained: true },
    });
    expect(openLegacySlide.layout).toBe("content");
    expect(openLegacySlide.bullets).toEqual([]);
    expect(openLegacySlide.future_layout_token).toEqual({ retained: true });
    expect(() => normalize_slide({ layout: "future" })).toThrow(/layout must be one of/i);
    expect(() => normalize_slide({ layout: "content", bullets: { text: "wrong" } })).toThrow(
      /slide\.bullets must be an array/i
    );
    expect(() => normalize_slide({ layout: "content", bullets: null })).toThrow(
      /slide\.bullets must be an array/i
    );
    expect(() =>
      normalize_slide({
        layout: "image_left",
        media: { path: "media.png", future_media_field: true },
      })
    ).toThrow(/slide\.media contains unknown keys/i);
    expect(() =>
      normalize_slide({
        layout: "image_left",
        media: { path: "media.png" },
        future_composed_field: true,
      })
    ).toThrow(/incompatible or unknown content fields/i);
  });

  it("keeps internal media/design contracts open to extras but rejects missing and wrong shapes", () => {
    const media = {
      path: "media.png",
      fit: "contain",
      focal_point: { x: 0.5, y: 0.5, future_focal_field: true },
      overlay: null,
      asset: null,
      future_media_field: { retained: true },
    };
    expect(adaptInternalMediaSpec(media)).toBe(media);
    expect(media.future_media_field).toEqual({ retained: true });
    expect(() => adaptInternalMediaSpec(undefined)).toThrow(/invalid internal media metadata/i);
    expect(() => adaptInternalMediaSpec(null)).toThrow(/invalid internal media metadata/i);
    expect(() => adaptInternalMediaSpec({ ...media, fit: "stretch" })).toThrow(
      /invalid internal media metadata/i
    );

    const patch = {
      palette: { accent: "38BDF8", future_palette_field: true },
      background_is_set: false,
      background: null,
      mark_is_set: false,
      mark: null,
      supplied: true,
      future_design_field: { retained: true },
    };
    expect(adaptInternalSlideDesignPatch(patch)).toBe(patch);
    expect(patch.future_design_field).toEqual({ retained: true });
    expect(() => adaptInternalSlideDesignPatch(undefined)).toThrow(
      /invalid internal design metadata/i
    );
    expect(() => adaptInternalSlideDesignPatch(null)).toThrow(/invalid internal design metadata/i);
    expect(() => adaptInternalSlideDesignPatch({ ...patch, supplied: "yes" })).toThrow(
      /invalid internal design metadata/i
    );

    const options = parse_options({
      output_path: "/tmp/design-boundary.pptx",
      project_root: "/tmp",
    });
    expect(_resolve_design(options, { layout: "content" }).active).toBe(false);
    expect(() => _resolve_design(options, { layout: "content", _design_patch: "wrong" })).toThrow(
      /invalid internal design metadata/i
    );
  });

  it("validates open markdown token objects without stripping plugin extras", () => {
    const token = {
      type: "text",
      tag: "",
      content: "hello",
      children: null,
      attrs: null,
      plugin_metadata: { retained: true },
    };
    const parsed = parseMarkdownTokenArray([token]);
    const parsedToken = requireDefined(parsed[0], "parsed markdown token was omitted");
    expect(parsedToken).toBe(token);
    expect(parsedToken.plugin_metadata).toEqual({ retained: true });
    expect(() => parseMarkdownTokenArray(undefined)).toThrow(/must be an array of tokens/i);
    expect(() => parseMarkdownTokenArray([{ type: "text", tag: "" }])).toThrow(
      /not a compatible markdown token/i
    );
    expect(() => parseMarkdownTokenArray(["wrong"])).toThrow(/not a compatible markdown token/i);
  });

  it("validates pptxgenjs slide and binary write results while accepting library extras", () => {
    const slide = {
      addImage() {
        return this;
      },
      addNotes() {
        return this;
      },
      addShape() {
        return this;
      },
      addTable() {
        return this;
      },
      addText() {
        return this;
      },
      library_extra: { retained: true },
    };
    expect(adaptPptxSlide(slide)).toBe(slide);
    expect(slide.library_extra).toEqual({ retained: true });
    expect(() => adaptPptxSlide(undefined)).toThrow(/incompatible slide/i);
    expect(() => adaptPptxSlide({ ...slide, addText: "wrong" })).toThrow(/incompatible slide/i);

    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
    expect(pptxWriteOutputToBuffer(Buffer.from(bytes))).toEqual(Buffer.from(bytes));
    expect(pptxWriteOutputToBuffer(bytes)).toEqual(Buffer.from(bytes));
    expect(pptxWriteOutputToBuffer(bytes.buffer)).toEqual(Buffer.from(bytes));
    expect(() => pptxWriteOutputToBuffer(undefined)).toThrow(/incompatible nodebuffer output/i);
    expect(() => pptxWriteOutputToBuffer("PK")).toThrow(/incompatible nodebuffer output/i);
  });
});
