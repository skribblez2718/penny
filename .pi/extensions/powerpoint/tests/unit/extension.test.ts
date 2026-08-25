import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import extension, {
  adaptPowerpointResultEnvelope,
  buildSpec,
  DeckDesign,
  FocalPoint,
  defaultOutputPath,
  getProjectRoot,
  HexColor,
  MediaSpec,
  Overlay,
  PalettePatch,
  PlacedImage,
  POWERPOINT_THEMES,
  reserveStagingPath,
  resolveOutputPath,
  SLIDE_LAYOUTS,
  slugify,
  SlideDesign,
} from "../../index.js";
import { createPptxPresentation } from "../../renderer.js";
import {
  createExtensionApiHarness,
  requireDefined,
  requirePowerpointTool,
  requireRecord,
} from "../helpers/contracts.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const target of cleanup.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("powerpoint extension registration", () => {
  let mockPi: ExtensionAPI;
  let registeredTools: unknown[];

  beforeEach(() => {
    const harness = createExtensionApiHarness();
    mockPi = harness.api;
    registeredTools = harness.registeredTools;
  });

  it("registers the powerpoint_generate tool with the documented schema", () => {
    extension(mockPi);
    expect(registeredTools).toHaveLength(1);
    const tool = requirePowerpointTool(registeredTools[0]);
    expect(tool.name).toBe("powerpoint_generate");
    expect(tool.label).toBeTruthy();
    expect(tool.description).toContain("PowerPoint (.pptx)");
    expect(tool.promptSnippet).toContain("powerpoint_generate");
    expect(tool.parameters.properties.design).toBeDefined();
    expect(tool.parameters.properties.allowed_image_roots).toBeDefined();
  });

  it("keeps the registered line_break_mode schema on the legacy string-enum shape", () => {
    extension(mockPi);
    const tool = requirePowerpointTool(registeredTools[0]);
    const lineBreakMode = requireDefined(
      tool.parameters.properties.line_break_mode,
      "line_break_mode schema was not registered"
    );
    const serialized = requireDefined(
      JSON.stringify(lineBreakMode),
      "line_break_mode schema was not serializable"
    );
    const property: unknown = JSON.parse(serialized);
    expect(requireRecord(property, "line_break_mode schema was not an object")).toEqual({
      type: "string",
      enum: ["preserve", "commonmark"],
      default: "preserve",
      description:
        "Single-newline policy. 'preserve' (default) emits a PowerPoint line break; " +
        "'commonmark' folds a soft break to a space. Hard breaks and <br> are always preserved.",
    });
  });

  it("keeps the strict additive design schema closed to unknown nested fields", () => {
    expect(Object.keys(PalettePatch.properties)).toEqual([
      "canvas",
      "surface",
      "accent",
      "text",
      "muted_text",
    ]);
    expect(Object.keys(DeckDesign.properties)).toEqual(["palette", "background", "mark"]);
    expect(Object.keys(SlideDesign.properties)).toEqual(["palette", "background", "mark"]);
    expect(Value.Check(HexColor, "#0B1020")).toBe(true);
    expect(Value.Check(FocalPoint, { x: 0, y: 1 })).toBe(true);
    expect(Value.Check(Overlay, { opacity: 0.35 })).toBe(true);
    expect(
      Value.Check(MediaSpec, {
        path: "assets/background.jpg",
        fit: "crop",
        focal_point: { x: 0.7, y: 0.4 },
        overlay: { opacity: 0.35 },
      })
    ).toBe(true);
    expect(
      Value.Check(PlacedImage, {
        path: "assets/mark.png",
        x: 0.9,
        y: 0.05,
        width: 0.06,
        height: 0.06,
      })
    ).toBe(true);
    expect(Value.Check(SlideDesign, { background: null, mark: null })).toBe(true);
    expect(Value.Check(PalettePatch, { canvas: "000000", border: "FFFFFF" })).toBe(false);
    expect(Value.Check(DeckDesign, { background: null })).toBe(false);
  });

  it("preserves cancellation and public error envelopes", async () => {
    extension(mockPi);
    const tool = requirePowerpointTool(registeredTools[0]);

    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute("cancelled", {}, controller.signal)).resolves.toEqual({
      content: [{ type: "text", text: "Cancelled" }],
      details: { cancelled: true },
    });
    await expect(tool.execute("invalid", {})).rejects.toThrow(
      "powerpoint_generate failed: Provide exactly one of 'slides' or 'markdown'."
    );
  });

  it("fails fast when the exact partial ExtensionAPI seam is exceeded", () => {
    const harness = createExtensionApiHarness();
    expect(() => harness.api.getActiveTools()).toThrow(
      "PowerPoint ExtensionAPI test seam does not implement getActiveTools"
    );
  });

  it("fails fast when required captured values are missing", () => {
    expect(() => requireDefined(undefined, "missing fixture")).toThrow("missing fixture");
    expect(() => requirePowerpointTool(undefined)).toThrow(
      "powerpoint_generate was not registered"
    );
    expect(requireDefined(false, "boolean fixture")).toBe(false);
  });
});

describe("paths and spec building", () => {
  it("discovers the project root from PROJECT_ROOT when supplied", () => {
    expect(getProjectRoot({ PROJECT_ROOT: "relative-root" })).toBe(path.resolve("relative-root"));
  });

  it("creates default output paths in the OS temp tree with full invocation ids", () => {
    const now = new Date(2026, 6, 5, 9, 30, 15, 42);
    const one = defaultOutputPath("My Deck", now, () => "invocation-a");
    const two = defaultOutputPath("My Deck", now, () => "invocation-b");
    expect(one).toContain("invocation-a");
    expect(two).toContain("invocation-b");
    expect(one.startsWith(os.tmpdir())).toBe(true);
    expect(one).not.toBe(two);
  });

  it("reserves unique sibling staging files", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penny-powerpoint-unit-"));
    cleanup.push(directory);
    const output = path.join(directory, "deck.pptx");
    const first = reserveStagingPath(output);
    const second = reserveStagingPath(output);
    expect(path.dirname(first)).toBe(directory);
    expect(first).not.toBe(second);
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);
  });

  it("slugifies filenames and resolves output paths", () => {
    expect(slugify("Platform Review: H2!")).toBe("platform-review-h2");
    expect(slugify("???")).toBe("presentation");
    expect(resolveOutputPath("decks/review", "x", "/proj")).toBe(
      path.join("/proj", "decks", "review.pptx")
    );
  });

  it("builds specs with exactly one slide source", () => {
    expect(() => buildSpec({}, "/proj")).toThrow(/exactly one/i);
    expect(() => buildSpec({ slides: [{ layout: "title" }], markdown: "# Hi" }, "/proj")).toThrow(
      /exactly one/i
    );
    const slidesSpec = buildSpec({ slides: [{ layout: "title", title: "Deck" }] }, "/proj");
    expect(Array.isArray(slidesSpec.slides)).toBe(true);
    expect(String(slidesSpec.output_path)).toMatch(/\.pptx$/);
    const markdownSpec = buildSpec({ markdown: "# Deck", line_break_mode: "commonmark" }, "/proj");
    expect(markdownSpec.markdown).toBe("# Deck");
    expect(markdownSpec.line_break_mode).toBe("commonmark");
  });
});

describe("constants", () => {
  it("exposes the shared theme names and all eleven slide layouts", () => {
    expect([...POWERPOINT_THEMES]).toEqual(["executive", "modern", "minimal", "editorial", "tech"]);
    expect([...SLIDE_LAYOUTS]).toEqual([
      "title",
      "section",
      "content",
      "two_column",
      "table",
      "quote",
      "image",
      "closing",
      "image_left",
      "image_right",
      "full_bleed",
    ]);
  });
});

describe("PowerPoint result boundary", () => {
  it("preserves the open renderer envelope and its object identity", () => {
    const envelope = {
      path: "/tmp/deck.pptx",
      slide_count: 2,
      theme: "executive",
      warnings: ["font substituted"],
      future_renderer_field: { enabled: true },
    };

    const adapted = adaptPowerpointResultEnvelope(envelope);
    expect(adapted).toBe(envelope);
    expect(adapted.warnings).toEqual(["font substituted"]);
    expect(adapted.future_renderer_field).toEqual({ enabled: true });
  });

  it("preserves the missing-result error and rejects malformed required fields", () => {
    expect(() => adaptPowerpointResultEnvelope(undefined)).toThrow(
      "PowerPoint generator completed without a result"
    );
    for (const value of [
      {},
      { path: "", slide_count: 1, theme: "executive" },
      { path: "/tmp/deck.pptx", slide_count: "1", theme: "executive" },
      { path: "/tmp/deck.pptx", slide_count: 1, theme: "unknown" },
    ]) {
      expect(() => adaptPowerpointResultEnvelope(value)).toThrow(
        "PowerPoint generator returned an invalid result envelope"
      );
    }
  });
});

describe("pptxgenjs constructor boundary", () => {
  it("constructs once, validates the required methods, and accepts library extras", () => {
    let constructorCalls = 0;
    const layouts: unknown[] = [];
    class CompatiblePresentation {
      layout = "";
      theme = {};
      title = "Constructed title";
      author = "Penny";
      subject = "Presentation";
      libraryExtra = true;

      constructor() {
        constructorCalls += 1;
      }

      addSlide() {
        return {};
      }

      defineLayout(layout: unknown) {
        layouts.push(layout);
      }

      async write() {
        return new Uint8Array();
      }
    }

    const presentation = createPptxPresentation(CompatiblePresentation);
    presentation.defineLayout({ name: "TEST", width: 13.333, height: 7.5 });

    expect(constructorCalls).toBe(1);
    expect(presentation.title).toBe("Constructed title");
    expect(layouts).toEqual([{ name: "TEST", width: 13.333, height: 7.5 }]);
  });

  it("rejects non-constructors and incomplete presentation surfaces", () => {
    expect(() => createPptxPresentation({})).toThrow(
      "pptxgenjs default export is not constructable"
    );
    expect(() => createPptxPresentation(class IncompletePresentation {})).toThrow(
      "pptxgenjs constructor returned an incompatible presentation"
    );
  });

  it("propagates constructor failures unchanged", () => {
    const failure = new Error("constructor failed");
    class ThrowingPresentation {
      constructor() {
        throw failure;
      }
    }

    let caught: unknown;
    try {
      createPptxPresentation(ThrowingPresentation);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});
