import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension, {
  buildSpec,
  defaultOutputPath,
  resolveOutputPath,
  slugify,
  WORD_THEMES,
} from "../../index.js";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: { properties: Record<string, unknown> };
}

describe("word extension registration", () => {
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

  it("registers the word_generate tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "word_generate");
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
    for (const key of [
      "markdown",
      "markdown_path",
      "title",
      "theme",
      "output_path",
      "table_style",
    ]) {
      expect(props[key], `missing parameter: ${key}`).toBeDefined();
    }
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
  it("builds a default path under output/word with a timestamp and uniquifier", () => {
    const p = defaultOutputPath("/proj", "My Report", new Date(2026, 6, 5, 9, 30, 15, 42));
    expect(p).toMatch(/^\/proj\/output\/word\/my-report_20260705_093015_042[a-z0-9]*\.docx$/);
  });

  it("produces distinct default paths for same-second calls", () => {
    const now = new Date(2026, 6, 5, 9, 30, 15, 42);
    expect(defaultOutputPath("/proj", "t", now)).not.toBe(defaultOutputPath("/proj", "t", now));
  });

  it("resolves relative explicit paths against the project root", () => {
    expect(resolveOutputPath("out/report", "t", "/proj")).toBe(
      path.join("/proj", "out", "report.docx")
    );
  });

  it("keeps absolute explicit paths and existing extension", () => {
    expect(resolveOutputPath("/tmp/x.docx", "t", "/proj")).toBe("/tmp/x.docx");
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

  it("passes inline markdown through with a resolved output path", () => {
    const spec = buildSpec({ markdown: "# Hello", title: "Hello" }, "/proj");
    expect(spec.markdown).toBe("# Hello");
    expect(String(spec.output_path)).toMatch(
      /output\/word\/hello_\d{8}_\d{6}_\d{3}[a-z0-9]*\.docx$/
    );
    expect(spec.project_root).toBe("/proj");
  });

  it("resolves relative markdown_path against the project root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "word-ext-test-"));
    fs.writeFileSync(path.join(dir, "doc.md"), "# Doc");
    const spec = buildSpec({ markdown_path: "doc.md" }, dir);
    expect(spec.markdown_path).toBe(path.join(dir, "doc.md"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("themes", () => {
  it("exposes the five shared theme names", () => {
    expect([...WORD_THEMES]).toEqual(["executive", "modern", "minimal", "editorial", "tech"]);
  });
});
