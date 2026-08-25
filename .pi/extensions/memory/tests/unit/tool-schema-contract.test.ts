import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturePath = join(
  extensionRoot,
  "tests",
  "type-contract-fixtures",
  "tool-schema-correlation.negative"
);

function moduleSpecifier(path: string): string {
  return path.replaceAll("\\", "/");
}

describe("schema-correlated memory tool contracts", () => {
  it("rejects exact operation/schema and callback/parameter mismatches", () => {
    const directory = mkdtempSync(join(tmpdir(), "penny-memory-tool-contract-"));
    const sourcePath = join(directory, "tool-schema-correlation.negative.ts");
    const source = readFileSync(fixturePath, "utf8")
      .replace("__LOGSTREAM_TOOLS__", moduleSpecifier(join(extensionRoot, "logstream-tools.js")))
      .replace("__MEMORY_TOOLS__", moduleSpecifier(join(extensionRoot, "tools.js")));
    writeFileSync(sourcePath, source, "utf8");

    try {
      const compiler = join(extensionRoot, "node_modules", ".bin", "tsc");
      const result = spawnSync(
        compiler,
        [
          "--ignoreConfig",
          "--pretty",
          "false",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--types",
          "node",
          "--isolatedModules",
          sourcePath,
        ],
        { cwd: extensionRoot, encoding: "utf8" }
      );
      const output = `${result.stdout}${result.stderr}`;
      const diagnostics = [...output.matchAll(/negative\.ts\((\d+),(\d+)\): error (TS\d+):/g)].map(
        ([, line, column, code]) => ({ line: Number(line), column: Number(column), code })
      );

      expect(result.status).toBe(2);
      expect(diagnostics).toEqual([
        { line: 12, column: 7, code: "TS2322" },
        { line: 22, column: 7, code: "TS2322" },
        { line: 30, column: 12, code: "TS2769" },
        { line: 35, column: 38, code: "TS2769" },
      ]);
      expect(output).toContain('operation: "search"');
      expect(output).toContain('operation: "logstream_append"');
      expect(output).toContain("'drawer_id' does not exist");
      expect(output).toContain("missing the following properties");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
