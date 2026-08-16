import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSpec,
  getGeneratorScript,
  getProjectRoot,
  getVenvPython,
  runGenerator,
} from "../../index.js";

const cleanup: string[] = [];
const cleanupFiles: string[] = [];
const slowGenerator = path.resolve("tests/fixtures/slow_generator.py");
const publishedGenerator = path.resolve("tests/fixtures/published_generator.py");

afterEach(() => {
  for (const file of cleanupFiles.splice(0)) {
    fs.rmSync(file, { force: true });
  }
  for (const directory of cleanup.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penny-powerpoint-integration-"));
  cleanup.push(directory);
  return directory;
}

function createDesignAssets(directory: string): {
  background: string;
  media: string;
  mark: string;
} {
  const background = path.join(directory, "background.jpg");
  const media = path.join(directory, "media.png");
  const mark = path.join(directory, "mark.png");
  execFileSync(
    getVenvPython(),
    [
      "-c",
      "import json,sys; from PIL import Image; " +
        "items=json.loads(sys.argv[1]); " +
        "[(Image.new('RGB', tuple(size), tuple(color)).save(target, format=kind)) " +
        "for target,size,color,kind in items]",
      JSON.stringify([
        [background, [1600, 900], [18, 35, 60], "JPEG"],
        [media, [1200, 800], [45, 120, 180], "PNG"],
        [mark, [240, 240], [56, 189, 248], "PNG"],
      ]),
    ],
    { stdio: "pipe" }
  );
  return { background, media, mark };
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for fixture output: ${file}`);
}

describe("TypeScript to Python PowerPoint boundary", () => {
  it("creates a structurally validated PPTX", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "integration.pptx");
    const spec = buildSpec(
      {
        markdown: "## Integration\n\nAlpha\nBeta with **bold** and café 東京.",
        output_path: output,
      },
      getProjectRoot()
    );

    const outcome = await runGenerator(getGeneratorScript(), spec, undefined);

    expect(outcome.cancelled).toBe(false);
    expect(outcome.result?.path).toBe(path.resolve(output));
    expect(outcome.result?.validation).toMatchObject({
      package_valid: true,
      reopen_valid: true,
      slide_count: 1,
    });
    expect(outcome.result?.normalization).toMatchObject({ line_break_mode: "preserve" });
    expect(fs.readFileSync(output).subarray(0, 2).toString("ascii")).toBe("PK");
  });

  it("finds the generator when cwd is outside the repository", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "cwd-independent.pptx");
    const originalCwd = process.cwd();
    try {
      process.chdir(directory);
      const outcome = await runGenerator(
        getGeneratorScript(),
        buildSpec(
          {
            slides: [{ layout: "title", title: "CWD independent" }],
            output_path: output,
          },
          getProjectRoot()
        ),
        undefined
      );
      expect(outcome.result?.path).toBe(path.resolve(output));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("generates a dark background deck with all composed layouts from an unrelated cwd", async () => {
    const directory = temporaryDirectory();
    const unrelatedCwd = path.join(directory, "unrelated-cwd");
    fs.mkdirSync(unrelatedCwd);
    const output = path.join(directory, "custom-design.pptx");
    const assets = createDesignAssets(directory);
    const spec = buildSpec(
      {
        slides: [
          {
            layout: "image_left",
            kicker: "P1A",
            title: "Image left",
            body: "Editable body text.",
            bullets: ["Opaque text pane"],
            media: { path: assets.media, fit: "contain" },
          },
          {
            layout: "image_right",
            title: "Image right",
            body: "Inherited background removed.",
            media: { path: assets.media },
            design: { background: null },
          },
          {
            layout: "full_bleed",
            title: "Full bleed",
            body: "Inherited mark removed.",
            media: {
              path: assets.media,
              focal_point: { x: 0.65, y: 0.5 },
              overlay: { opacity: 0.3 },
            },
            design: { mark: null },
          },
        ],
        design: {
          palette: {
            canvas: "0B1020",
            surface: "151F32",
            accent: "38BDF8",
            text: "F8FAFC",
            muted_text: "A8B4C8",
          },
          background: {
            path: assets.background,
            fit: "crop",
            overlay: { color: "000000", opacity: 0.4 },
          },
          mark: {
            path: assets.mark,
            x: 0.9,
            y: 0.05,
            width: 0.06,
            height: 0.06,
          },
        },
        allowed_image_roots: [directory],
        output_path: output,
      },
      getProjectRoot()
    );

    const originalCwd = process.cwd();
    let outcome: Awaited<ReturnType<typeof runGenerator>>;
    try {
      process.chdir(unrelatedCwd);
      outcome = await runGenerator(getGeneratorScript(), spec, undefined);
    } finally {
      process.chdir(originalCwd);
    }

    expect(outcome.cancelled).toBe(false);
    expect(outcome.result?.validation).toMatchObject({
      package_valid: true,
      reopen_valid: true,
      slide_count: 3,
    });
    const resolvedDesign = outcome.result?.resolved_design as
      | { deck_default?: Record<string, unknown>; slides?: Array<Record<string, unknown>> }
      | undefined;
    expect(resolvedDesign?.deck_default).toBeDefined();
    expect(resolvedDesign?.slides).toHaveLength(3);
    const telemetry = JSON.stringify(resolvedDesign);
    expect(telemetry).toContain("0B1020");
    expect(telemetry).toContain("151F32");
    expect(telemetry).toContain("38BDF8");
    for (const assetPath of Object.values(assets)) {
      expect(telemetry).not.toContain(assetPath);
    }

    const pictureCounts = JSON.parse(
      execFileSync(
        getVenvPython(),
        [
          "-c",
          "import json,sys; from pptx import Presentation; " +
            "from pptx.enum.shapes import MSO_SHAPE_TYPE; p=Presentation(sys.argv[1]); " +
            "print(json.dumps([sum(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in slide.shapes) " +
            "for slide in p.slides]))",
          output,
        ],
        { encoding: "utf8" }
      )
    ) as number[];
    expect(pictureCounts).toEqual([3, 2, 1]);
  });

  it("propagates Python diagnostics without publishing", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "invalid.pptx");
    await expect(
      runGenerator(
        getGeneratorScript(),
        {
          slides: [{ layout: "title", title: "Invalid" }],
          theme: "not-a-theme",
          output_path: output,
          project_root: getProjectRoot(),
        },
        undefined
      )
    ).rejects.toThrow(/theme must be one of/);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("names an explicitly missing interpreter", () => {
    const missing = path.join(temporaryDirectory(), "missing-python");
    expect(() =>
      runGenerator(
        getGeneratorScript(),
        { slides: [{ layout: "title" }], output_path: path.join(temporaryDirectory(), "x.pptx") },
        undefined,
        { pythonPath: missing }
      )
    ).toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("reports every platform venv candidate when discovery fails", () => {
    const root = temporaryDirectory();
    const previousRoot = process.env.PROJECT_ROOT;
    const previousOverride = process.env.PI_VENV_PYTHON;
    process.env.PROJECT_ROOT = root;
    delete process.env.PI_VENV_PYTHON;
    try {
      expect(() =>
        runGenerator(
          getGeneratorScript(),
          { slides: [{ layout: "title" }], output_path: path.join(root, "x.pptx") },
          undefined
        )
      ).toThrow(
        new RegExp(
          `${path.join(root, ".venv", "bin", "python").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${path
            .join(root, ".venv", "Scripts", "python.exe")
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
        )
      );
    } finally {
      if (previousRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = previousRoot;
      if (previousOverride === undefined) delete process.env.PI_VENV_PYTHON;
      else process.env.PI_VENV_PYTHON = previousOverride;
    }
  });

  it("concurrent default-output calls publish distinct decks with their own sentinels", async () => {
    const specs = Array.from({ length: 12 }, (_, index) =>
      buildSpec({ slides: [{ layout: "title", title: `CONCURRENT-${index}` }] }, getProjectRoot())
    );
    const paths = specs.map((spec) => spec.output_path as string);
    cleanupFiles.push(...paths);
    expect(new Set(paths).size).toBe(paths.length);
    const outcomes = await Promise.all(
      specs.map((spec) => runGenerator(getGeneratorScript(), spec, undefined))
    );
    expect(outcomes.every((outcome) => outcome.result?.validation)).toBe(true);
    expect(
      paths.every((output) => fs.readFileSync(output).subarray(0, 2).toString("ascii") === "PK")
    ).toBe(true);

    const sentinels = paths.map((output, index) => [output, `CONCURRENT-${index}`]);
    execFileSync(
      getVenvPython(),
      [
        "-c",
        "import json,sys; from pptx import Presentation; " +
          "items=json.loads(sys.argv[1]); " +
          "assert all(s in '\\n'.join(sh.text for sl in Presentation(p).slides for sh in sl.shapes if getattr(sh, 'has_text_frame', False)) for p,s in items)",
        JSON.stringify(sentinels),
      ],
      { stdio: "pipe" }
    );
  });

  it("failed explicit overwrite preserves the previous valid target", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "existing.pptx");
    await runGenerator(
      getGeneratorScript(),
      buildSpec(
        { slides: [{ layout: "title", title: "Baseline" }], output_path: output },
        getProjectRoot()
      ),
      undefined
    );
    const baseline = fs.readFileSync(output);
    await expect(
      runGenerator(
        getGeneratorScript(),
        {
          slides: [{ layout: "title", title: "Invalid" }],
          accent_color: "not-a-color",
          output_path: output,
          project_root: getProjectRoot(),
        },
        undefined
      )
    ).rejects.toThrow(/accent_color/);
    expect(fs.readFileSync(output)).toEqual(baseline);
  });

  it("rejects Python-only design semantics and preserves an existing target", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "semantic-preservation.pptx");
    const assets = createDesignAssets(directory);
    await runGenerator(
      getGeneratorScript(),
      buildSpec(
        { slides: [{ layout: "title", title: "Baseline" }], output_path: output },
        getProjectRoot()
      ),
      undefined
    );
    const baseline = fs.readFileSync(output);
    const common = {
      output_path: output,
      project_root: getProjectRoot(),
      allowed_image_roots: [directory],
    };
    const invalidSpecs: Array<[Record<string, unknown>, RegExp]> = [
      [
        {
          ...common,
          accent_color: "FF0000",
          design: { palette: { accent: "00FF00" } },
          slides: [{ layout: "title", title: "Conflicting accents" }],
        },
        /accent_color.*design\.palette\.accent|design\.palette\.accent.*accent_color/i,
      ],
      [
        {
          ...common,
          design: {
            mark: {
              path: assets.mark,
              x: 0.95,
              y: 0.05,
              width: 0.1,
              height: 0.1,
            },
          },
          slides: [{ layout: "title", title: "Out-of-bounds mark" }],
        },
        /normalized slide bounds/i,
      ],
      [
        {
          ...common,
          slides: [{ layout: "image_left", title: "Missing media field" }],
        },
        /requires? media|media.*required/i,
      ],
      [
        {
          ...common,
          design: { background: { path: assets.background, fit: null } },
          slides: [{ layout: "title", title: "Explicit null fit" }],
        },
        /fit.*crop.*contain/i,
      ],
      [
        {
          ...common,
          design: { background: { path: assets.background, focal_point: null } },
          slides: [{ layout: "title", title: "Explicit null focal point" }],
        },
        /focal_point.*object/i,
      ],
      [
        {
          ...common,
          design: { background: { path: assets.background, overlay: null } },
          slides: [{ layout: "title", title: "Explicit null overlay" }],
        },
        /overlay.*object/i,
      ],
      [
        {
          output_path: output,
          project_root: getProjectRoot(),
          allowed_image_roots: [],
          slides: [{ layout: "title", title: "Empty root list" }],
        },
        /allowed_image_roots.*non-empty/i,
      ],
    ];

    for (const [invalidSpec, diagnostic] of invalidSpecs) {
      await expect(runGenerator(getGeneratorScript(), invalidSpec, undefined)).rejects.toThrow(
        diagnostic
      );
      expect(fs.readFileSync(output)).toEqual(baseline);
    }
  });

  it("fails closed for missing composed media and preserves an existing target", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "missing-media-preservation.pptx");
    await runGenerator(
      getGeneratorScript(),
      buildSpec(
        { slides: [{ layout: "title", title: "Baseline" }], output_path: output },
        getProjectRoot()
      ),
      undefined
    );
    const baseline = fs.readFileSync(output);

    await expect(
      runGenerator(
        getGeneratorScript(),
        {
          slides: [
            {
              layout: "full_bleed",
              title: "Critical media is absent",
              media: { path: path.join(directory, "missing.png") },
            },
          ],
          allowed_image_roots: [directory],
          output_path: output,
          project_root: getProjectRoot(),
        },
        undefined
      )
    ).rejects.toThrow(/media|asset|image|not found|does not exist/i);
    expect(fs.readFileSync(output)).toEqual(baseline);
  });

  it("aborts once and removes only its staging file", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "aborted.pptx");
    const unrelated = path.join(directory, ".unrelated.tmp.pptx");
    fs.writeFileSync(unrelated, "keep");
    const controller = new AbortController();
    const pending = runGenerator(
      slowGenerator,
      { slides: [{ layout: "title" }], output_path: output },
      controller.signal,
      { timeoutMs: 5000 }
    );
    setTimeout(() => controller.abort(), 50);

    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("keep");
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.pptx"))).toEqual([
      path.basename(unrelated),
    ]);
  });

  it("documents the post-publication cancellation race with a valid final", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "published-before-abort.pptx");
    const controller = new AbortController();
    const pending = runGenerator(
      publishedGenerator,
      {
        slides: [{ layout: "title", title: "Published" }],
        output_path: output,
        project_root: getProjectRoot(),
      },
      controller.signal,
      { timeoutMs: 10_000 }
    );
    await waitForFile(output);
    controller.abort();

    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(fs.readFileSync(output).subarray(0, 2).toString("ascii")).toBe("PK");
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.pptx"))).toEqual([]);
  });

  it("times out once without publishing a target", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "timed-out.pptx");
    await expect(
      runGenerator(
        slowGenerator,
        { slides: [{ layout: "title" }], output_path: output },
        undefined,
        { timeoutMs: 50 }
      )
    ).rejects.toThrow(/timed out after 50ms/);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.pptx"))).toEqual([]);
  });
});
