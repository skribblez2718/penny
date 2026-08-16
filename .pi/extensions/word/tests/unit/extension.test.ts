import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension, {
  buildSpec,
  defaultOutputPath,
  getExtensionDir,
  getGeneratorScript,
  getProjectRoot,
  getVenvPython,
  reserveStagingPath,
  resolveOutputPath,
  slugify,
  venvPythonCandidates,
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
    expect(registeredTools.find((tool) => tool.name === "word_generate")).toBeDefined();
  });

  it("registers exactly one tool", () => {
    extension(mockPi);
    expect(registeredTools).toHaveLength(1);
  });

  it("has a useful label, description, and prompt snippet", () => {
    extension(mockPi);
    const tool = registeredTools[0];
    expect(tool.label).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(100);
    expect(tool.promptSnippet).toBeTruthy();
  });

  it("exposes existing and corrected layout parameters", () => {
    extension(mockPi);
    const properties = registeredTools[0].parameters.properties;
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
  it("resolves the generator relative to the extension, not cwd", () => {
    expect(getGeneratorScript()).toBe(path.join(getExtensionDir(), "generate_docx.py"));
    expect(fs.existsSync(getGeneratorScript())).toBe(true);
  });

  it("discovers the project root from the extension by default", () => {
    expect(getProjectRoot({})).toBe(path.resolve(getExtensionDir(), "../../.."));
  });

  it("honors a PROJECT_ROOT override", () => {
    expect(getProjectRoot({ PROJECT_ROOT: "./configured-root" })).toBe(
      path.resolve("./configured-root")
    );
  });

  it("prefers the POSIX venv layout outside Windows", () => {
    expect(venvPythonCandidates("/project", "linux")).toEqual([
      path.join("/project", ".venv", "bin", "python"),
      path.join("/project", ".venv", "Scripts", "python.exe"),
    ]);
  });

  it("prefers Scripts/python.exe on Windows", () => {
    expect(venvPythonCandidates("C:\\project", "win32")).toEqual([
      path.join("C:\\project", ".venv", "Scripts", "python.exe"),
      path.join("C:\\project", ".venv", "bin", "python"),
    ]);
  });

  it("honors a PI_VENV_PYTHON override", () => {
    expect(getVenvPython("/project", { PI_VENV_PYTHON: "./custom-python" }, "linux")).toBe(
      path.resolve("./custom-python")
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

  it("reserves a unique same-directory staging file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "word-staging-test-"));
    try {
      const output = path.join(directory, "report.docx");
      const first = reserveStagingPath(output);
      const second = reserveStagingPath(output);
      expect(path.dirname(first)).toBe(directory);
      expect(first).not.toBe(second);
      expect(fs.existsSync(first)).toBe(true);
      expect(fs.existsSync(second)).toBe(true);
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

describe("themes", () => {
  it("exposes the five shared theme names", () => {
    expect([...WORD_THEMES]).toEqual(["executive", "modern", "minimal", "editorial", "tech"]);
  });
});
