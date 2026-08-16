import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSpec, getGeneratorScript, getProjectRoot, runGenerator } from "../../index.js";

const cleanup: string[] = [];
const slowGenerator = path.resolve("tests/fixtures/slow_generator.py");

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penny-word-integration-"));
  cleanup.push(directory);
  return directory;
}

describe("TypeScript to Python Word boundary", () => {
  it("creates a structurally validated DOCX", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "integration.docx");
    const spec = buildSpec(
      {
        markdown: "# Integration\n\nAlpha\nBeta with **bold** and café 東京.",
        title_mode: "none",
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
    });
    expect(fs.readFileSync(output).subarray(0, 2).toString("ascii")).toBe("PK");
  });

  it("finds the generator when cwd is outside the repository", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "cwd-independent.docx");
    const originalCwd = process.cwd();
    try {
      process.chdir(directory);
      const outcome = await runGenerator(
        getGeneratorScript(),
        buildSpec(
          { markdown: "# CWD\n\nIndependent.", title_mode: "none", output_path: output },
          getProjectRoot()
        ),
        undefined
      );
      expect(outcome.result?.path).toBe(path.resolve(output));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("reports stage-aware Python diagnostics", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "invalid.docx");
    await expect(
      runGenerator(
        getGeneratorScript(),
        {
          markdown: "# Invalid",
          theme: "not-a-theme",
          output_path: output,
          project_root: getProjectRoot(),
        },
        undefined
      )
    ).rejects.toThrow(/options:.*theme must be one of/s);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("names an explicitly missing interpreter", () => {
    const missing = path.join(temporaryDirectory(), "missing-python");
    expect(() =>
      runGenerator(
        getGeneratorScript(),
        { markdown: "# Missing", output_path: path.join(temporaryDirectory(), "missing.docx") },
        undefined,
        { pythonPath: missing }
      )
    ).toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("aborts once without publishing a target", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "aborted.docx");
    const controller = new AbortController();
    const pending = runGenerator(
      slowGenerator,
      { markdown: "# Slow", output_path: output },
      controller.signal,
      { timeoutMs: 5000 }
    );
    setTimeout(() => controller.abort(), 50);

    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.docx"))).toEqual([]);
  });

  it("times out once without publishing a target", async () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "timed-out.docx");
    await expect(
      runGenerator(slowGenerator, { markdown: "# Slow", output_path: output }, undefined, {
        timeoutMs: 50,
      })
    ).rejects.toThrow(/timed out after 50ms/);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.docx"))).toEqual([]);
  });
});
