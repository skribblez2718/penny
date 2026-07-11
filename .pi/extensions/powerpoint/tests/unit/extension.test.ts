import { describe, it, expect, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension, {
  buildSpec,
  defaultOutputPath,
  resolveOutputPath,
  slugify,
  POWERPOINT_THEMES,
  SLIDE_LAYOUTS,
} from "../../index.js";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: { properties: Record<string, unknown> };
}

describe("powerpoint extension registration", () => {
  let mockPi: ExtensionAPI;
  let registeredTools: RegisteredTool[];

  beforeEach(() => {
    registeredTools = [];
    mockPi = {
      registerTool: (tool: RegisteredTool) => {
        registeredTools.push(tool);
      },
      registerCommand: () => {},
      on: () => {},
    } as unknown as ExtensionAPI;
  });

  it("registers the powerpoint_generate tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "powerpoint_generate");
    expect(tool).toBeDefined();
  });

  it("registers exactly 1 tool", () => {
    extension(mockPi);
    expect(registeredTools).toHaveLength(1);
  });

  it("has label, description, and promptSnippet", () => {
    extension(mockPi);
    const tool = registeredTools[0];
    expect(tool.label).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(50);
    expect(tool.promptSnippet).toBeTruthy();
  });

  it("exposes the expected top-level parameters", () => {
    extension(mockPi);
    const props = registeredTools[0].parameters.properties;
    for (const key of ["slides", "markdown", "title", "theme", "footer_text", "output_path"]) {
      expect(props[key], `missing parameter: ${key}`).toBeDefined();
    }
  });
});

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Platform Review: H2!")).toBe("platform-review-h2");
  });

  it("falls back to 'presentation' by default", () => {
    expect(slugify("???")).toBe("presentation");
  });
});

describe("output paths", () => {
  it("builds a default temp path (…/penny/powerpoint/) with a timestamp and uniquifier, never the project tree", () => {
    const p = defaultOutputPath("My Deck", new Date(2026, 6, 5, 9, 30, 15, 42));
    expect(p).toMatch(/[\\/]penny[\\/]powerpoint[\\/]my-deck_20260705_093015_042[a-z0-9]*\.pptx$/);
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });

  it("produces distinct default paths for same-second calls", () => {
    const now = new Date(2026, 6, 5, 9, 30, 15, 42);
    expect(defaultOutputPath("t", now)).not.toBe(defaultOutputPath("t", now));
  });

  it("appends .pptx to explicit paths when missing", () => {
    expect(resolveOutputPath("decks/review", "t", "/proj")).toBe(
      path.join("/proj", "decks", "review.pptx")
    );
  });
});

describe("buildSpec", () => {
  it("rejects when neither slides nor markdown is given", () => {
    expect(() => buildSpec({}, "/proj")).toThrow(/exactly one/i);
  });

  it("rejects when both slides and markdown are given", () => {
    expect(() => buildSpec({ slides: [{ layout: "title" }], markdown: "# Hi" }, "/proj")).toThrow(
      /exactly one/i
    );
  });

  it("passes slides through with a resolved output path", () => {
    const spec = buildSpec(
      { slides: [{ layout: "title", title: "Deck" }], title: "Deck" },
      "/proj"
    );
    expect(Array.isArray(spec.slides)).toBe(true);
    expect(String(spec.output_path)).toMatch(
      /[\\/]penny[\\/]powerpoint[\\/]deck_\d{8}_\d{6}_\d{3}[a-z0-9]*\.pptx$/
    );
    expect(spec.project_root).toBe("/proj");
  });

  it("accepts markdown-only input", () => {
    const spec = buildSpec({ markdown: "# Deck" }, "/proj");
    expect(spec.markdown).toBe("# Deck");
  });
});

describe("constants", () => {
  it("exposes the five shared theme names", () => {
    expect([...POWERPOINT_THEMES]).toEqual(["executive", "modern", "minimal", "editorial", "tech"]);
  });

  it("exposes the eight slide layouts", () => {
    expect([...SLIDE_LAYOUTS]).toEqual([
      "title",
      "section",
      "content",
      "two_column",
      "table",
      "quote",
      "image",
      "closing",
    ]);
  });
});
