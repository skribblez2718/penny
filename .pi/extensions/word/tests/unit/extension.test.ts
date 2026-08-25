import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, {
  buildSpec,
  defaultOutputPath,
  getExtensionDir,
  getProjectRoot,
  reserveStagingPath,
  resolveOutputPath,
  slugify,
  WORD_THEMES,
} from "../../index.js";
import {
  THEMES,
  contrast_ratio,
  derive_palette,
  mixColors,
  parseMarkdownTokenStream,
  parse_options,
  type_scale,
  validateMarkdownTokenStream,
} from "../../renderer.js";
import {
  createTestExtensionApi,
  isRecord,
  requireArrayElement,
} from "../../../../lib/tests/test-narrowers.js";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: { properties: Record<string, unknown> };
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.label === "string" &&
    typeof value.description === "string" &&
    isRecord(value.parameters) &&
    isRecord(value.parameters.properties)
  );
}

describe("word extension registration", () => {
  let mockPi: ReturnType<typeof createTestExtensionApi>;
  let registeredTools: RegisteredTool[];

  beforeEach(() => {
    registeredTools = [];
    mockPi = createTestExtensionApi({
      onRegisterTool(tool) {
        if (!isRegisteredTool(tool)) throw new Error("word extension registered an invalid tool");
        registeredTools.push(tool);
      },
    });
  });

  it("registers the word_generate tool", () => {
    extension(mockPi);
    expect(registeredTools.find((tool) => tool.name === "word_generate")).toBeDefined();
  });

  it("registers exactly one tool", () => {
    extension(mockPi);
    expect(registeredTools).toHaveLength(1);
  });

  it("has a useful label, description, and prompt snippet", () => {
    extension(mockPi);
    const tool = requireArrayElement(registeredTools, 0, "word_generate tool was not registered");
    expect(tool.label).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(100);
    expect(tool.promptSnippet).toBeTruthy();
  });

  it("exposes the documented parameters", () => {
    extension(mockPi);
    const properties = requireArrayElement(
      registeredTools,
      0,
      "word_generate tool was not registered"
    ).parameters.properties;
    for (const key of [
      "markdown",
      "markdown_path",
      "title",
      "theme",
      "output_path",
      "table_style",
      "line_break_mode",
      "table_layout",
      "title_mode",
    ]) {
      expect(properties[key], `missing parameter: ${key}`).toBeDefined();
    }
  });
});

describe("path discovery", () => {
  it("discovers the extension directory independently of cwd", () => {
    expect(path.basename(getExtensionDir())).toBe("word");
    expect(fs.existsSync(getExtensionDir())).toBe(true);
  });

  it("discovers the project root from the extension by default", () => {
    expect(getProjectRoot({})).toBe(path.resolve(getExtensionDir(), "../../.."));
  });

  it("honors a PROJECT_ROOT override", () => {
    expect(getProjectRoot({ PROJECT_ROOT: "./configured-root" })).toBe(
      path.resolve("./configured-root")
    );
  });
});

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Quarterly Security Review: Q2!")).toBe("quarterly-security-review-q2");
  });

  it("falls back when the input has no usable characters", () => {
    expect(slugify("!!!")).toBe("document");
    expect(slugify("", "presentation")).toBe("presentation");
  });

  it("caps length at 60 characters", () => {
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("output paths", () => {
  it("builds a unique default temp path, never a project-tree path", () => {
    const output = defaultOutputPath("My Report", new Date(2026, 6, 5, 9, 30, 15, 42));
    expect(output).toMatch(/[\\/]penny[\\/]word[\\/]my-report_20260705_093015_042[a-z0-9]*\.docx$/);
    expect(output.startsWith(os.tmpdir())).toBe(true);
  });

  it("produces distinct default paths for same-millisecond calls", () => {
    const now = new Date(2026, 6, 5, 9, 30, 15, 42);
    expect(defaultOutputPath("t", now)).not.toBe(defaultOutputPath("t", now));
  });

  it("resolves relative explicit paths against the project root", () => {
    expect(resolveOutputPath("out/report", "t", "/proj")).toBe(
      path.join("/proj", "out", "report.docx")
    );
  });

  it("keeps absolute explicit paths and an existing extension", () => {
    expect(resolveOutputPath("/tmp/x.docx", "t", "/proj")).toBe("/tmp/x.docx");
  });

  it("reserves a unique same-directory staging file with 0600 permissions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "word-staging-test-"));
    try {
      const output = path.join(directory, "report.docx");
      const first = reserveStagingPath(output);
      const second = reserveStagingPath(output);
      expect(path.dirname(first)).toBe(directory);
      expect(first).not.toBe(second);
      expect(fs.existsSync(first)).toBe(true);
      expect(fs.existsSync(second)).toBe(true);
      expect(fs.statSync(first).mode & 0o777).toBe(0o600);
      expect(fs.statSync(second).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("buildSpec", () => {
  it("rejects when neither markdown nor markdown_path is given", () => {
    expect(() => buildSpec({}, "/proj")).toThrow(/exactly one/i);
  });

  it("rejects when both markdown and markdown_path are given", () => {
    expect(() => buildSpec({ markdown: "# Hi", markdown_path: "a.md" }, "/proj")).toThrow(
      /exactly one/i
    );
  });

  it("rejects a missing markdown file", () => {
    expect(() => buildSpec({ markdown_path: "/nope/missing.md" }, "/proj")).toThrow(/not found/i);
  });

  it("passes additive formatting options through", () => {
    const spec = buildSpec(
      {
        markdown: "# Hello",
        title: "Hello",
        line_break_mode: "commonmark",
        table_layout: "equal",
        title_mode: "none",
      },
      "/proj"
    );
    expect(spec.markdown).toBe("# Hello");
    expect(spec.line_break_mode).toBe("commonmark");
    expect(spec.table_layout).toBe("equal");
    expect(spec.title_mode).toBe("none");
    expect(String(spec.output_path)).toMatch(
      /[\\/]penny[\\/]word[\\/]hello_\d{8}_\d{6}_\d{3}[a-z0-9]*\.docx$/
    );
    expect(spec.project_root).toBe("/proj");
  });

  it("resolves relative markdown_path against the project root", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "word-ext-test-"));
    try {
      fs.writeFileSync(path.join(directory, "doc.md"), "# Doc");
      const spec = buildSpec({ markdown_path: "doc.md" }, directory);
      expect(spec.markdown_path).toBe(path.join(directory, "doc.md"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("themes and palette", () => {
  it("exposes the five shared theme names", () => {
    expect([...WORD_THEMES]).toEqual(["executive", "modern", "minimal", "editorial", "tech"]);
    expect(Object.keys(THEMES)).toEqual([...WORD_THEMES]);
  });

  it("builds a monotonic body-relative type scale", () => {
    for (const theme of Object.keys(THEMES)) {
      expect(theme).toBeTruthy();
      for (const bodySize of [8, 11, 14]) {
        const scale = type_scale(bodySize);
        expect(scale.title).toBeGreaterThan(scale.h1);
        expect(scale.h1).toBeGreaterThan(scale.h2);
        expect(scale.h2).toBeGreaterThan(scale.h3);
        expect(scale.h3).toBeGreaterThanOrEqual(scale.body);
        expect(scale.h4).toBeGreaterThanOrEqual(scale.h5);
        expect(scale.h5).toBeGreaterThanOrEqual(scale.h6);
      }
    }
  });

  it("regenerates the soft palette from a custom accent", () => {
    const defaultPalette = derive_palette(THEMES.executive);
    const customPalette = derive_palette(THEMES.executive, "FDE047");
    expect(customPalette.accent).toBe("FDE047");
    expect(customPalette.accent_soft).not.toBe(defaultPalette.accent_soft);
    expect(customPalette.accent_soft).toBe(mixColors("FDE047", "FFFFFF", 0.86));
  });

  it("keeps text-role pairs at or above the contrast threshold", () => {
    for (const accent of ["FDE047", "111827", "777777", "FF00FF", "00FFFF"]) {
      const colors = derive_palette(THEMES.executive, accent);
      expect(contrast_ratio(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast_ratio(colors.text_muted, colors.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast_ratio(colors.heading, colors.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast_ratio(colors.link, colors.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast_ratio(colors.on_accent, colors.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast_ratio(colors.link_on_accent, colors.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("option parsing", () => {
  it("normalizes legacy cover_page to title_mode cover", () => {
    const options = parse_options({ output_path: "/tmp/out.docx", cover_page: true });
    expect(options.title_mode).toBe("cover");
  });

  it("defaults the date when author or cover is present", () => {
    const options = parse_options(
      { output_path: "/tmp/out.docx", author: "Platform Team" },
      new Date("2026-08-23T12:34:56Z")
    );
    expect(options.date).toBe("2026-08-23");
  });

  it("rejects invalid accent colors", () => {
    expect(() => parse_options({ output_path: "/tmp/out.docx", accent_color: "XYZ" })).toThrow(
      /6-digit hex/
    );
  });
});

describe("markdown-it token boundary", () => {
  it("retains markdown-it token instances and inline rendering tokens", () => {
    const tokens = parseMarkdownTokenStream("# Report\n\nAlpha ~~old~~ new.");
    const inlineTypes = tokens
      .filter((token) => token.type === "inline")
      .flatMap((token) => token.children ?? [])
      .map((token) => token.type);

    expect(tokens.map((token) => token.type)).toEqual([
      "heading_open",
      "inline",
      "heading_close",
      "paragraph_open",
      "inline",
      "paragraph_close",
    ]);
    expect(inlineTypes).toEqual(expect.arrayContaining(["text", "s_open", "s_close"]));
  });

  it("accepts token and attrs extras without copying the stream", () => {
    const stream = [
      {
        type: "text",
        tag: "",
        content: "Alpha",
        children: null,
        attrs: { plugin_attribute: "kept" },
        plugin_metadata: { retained: true },
      },
    ];

    const validated = validateMarkdownTokenStream(stream);
    expect(validated).toBe(stream);
    expect(validated[0]?.attrs).toEqual({ plugin_attribute: "kept" });
  });

  it("rejects malformed top-level and nested token shapes", () => {
    for (const value of [
      null,
      {},
      [{ type: "text", tag: "" }],
      [{ type: "inline", tag: "", content: "", children: [{}] }],
      [{ type: "text", tag: "", content: "Alpha", attrGet: "not-a-function" }],
      [{ type: "text", tag: "", content: "Alpha", info: 42 }],
    ]) {
      expect(() => validateMarkdownTokenStream(value)).toThrow(
        "markdown-it returned an invalid token stream"
      );
    }
  });
});
