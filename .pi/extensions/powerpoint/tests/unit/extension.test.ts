import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension, {
  buildSpec,
  defaultOutputPath,
  getGeneratorScript,
  getProjectRoot,
  getVenvPython,
  reserveStagingPath,
  resolveOutputPath,
  slugify,
  venvPythonCandidates,
  POWERPOINT_THEMES,
  SLIDE_LAYOUTS,
} from "../../index.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const target of cleanup.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

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
    for (const key of [
      "slides",
      "markdown",
      "title",
      "theme",
      "line_break_mode",
      "footer_text",
      "output_path",
    ]) {
      expect(props[key], `missing parameter: ${key}`).toBeDefined();
    }
  });
});

describe("runtime paths and staging", () => {
  it("resolves the generator relative to the extension rather than cwd", () => {
    expect(fs.existsSync(getGeneratorScript())).toBe(true);
    expect(getGeneratorScript()).toMatch(
      /[\\/]\.pi[\\/]extensions[\\/]powerpoint[\\/]generate_pptx\.py$/
    );
    expect(getProjectRoot({})).not.toBe(process.cwd() + path.sep + "unrelated");
  });

  it("orders Unix and Windows venv candidates by platform", () => {
    expect(venvPythonCandidates("/project", "linux")[0]).toBe(
      path.join("/project", ".venv", "bin", "python")
    );
    expect(venvPythonCandidates("C:\\project", "win32")[0]).toBe(
      path.join("C:\\project", ".venv", "Scripts", "python.exe")
    );
  });

  it("honors interpreter and project-root overrides", () => {
    expect(getProjectRoot({ PROJECT_ROOT: "relative-root" })).toBe(path.resolve("relative-root"));
    expect(getVenvPython("/project", { PI_VENV_PYTHON: "custom/python" })).toBe(
      path.resolve("custom/python")
    );
  });

  it("reserves unique same-directory staging paths", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penny-powerpoint-unit-"));
    cleanup.push(directory);
    const output = path.join(directory, "deck.pptx");
    const first = reserveStagingPath(output);
    const second = reserveStagingPath(output);
    expect(path.dirname(first)).toBe(directory);
    expect(first).not.toBe(second);
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);
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
  it("builds a default temp path with a full invocation UUID, never the project tree", () => {
    const invocationId = "123e4567-e89b-12d3-a456-426614174000";
    const p = defaultOutputPath("My Deck", new Date(2026, 6, 5, 9, 30, 15, 42), () => invocationId);
    expect(p).toMatch(
      /[\\/]penny[\\/]powerpoint[\\/]my-deck_20260705_093015_042-123e4567-e89b-12d3-a456-426614174000\.pptx$/
    );
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });

  it("uses the invocation identifier rather than a short probabilistic suffix", () => {
    const now = new Date(2026, 6, 5, 9, 30, 15, 42);
    const first = defaultOutputPath("t", now, () => "invocation-a");
    const second = defaultOutputPath("t", now, () => "invocation-b");
    expect(first).not.toBe(second);
    expect(first).toContain("invocation-a");
    expect(second).toContain("invocation-b");
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
      /[\\/]penny[\\/]powerpoint[\\/]deck_\d{8}_\d{6}_\d{3}-[0-9a-f-]{36}\.pptx$/
    );
    expect(spec.project_root).toBe("/proj");
  });

  it("accepts markdown-only input and forwards line-break policy", () => {
    const spec = buildSpec({ markdown: "# Deck", line_break_mode: "commonmark" }, "/proj");
    expect(spec.markdown).toBe("# Deck");
    expect(spec.line_break_mode).toBe("commonmark");
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
