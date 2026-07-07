/**
 * YouTube Extension E2E Tests
 *
 * Tests extension discovery and directory structure without LLM API calls.
 * Full E2E with tool invocation is run separately via the integration tests.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Resolve to the extension root (3 parent dirs up from tests/e2e/)
const TEST_FILE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(TEST_FILE, "../..");

describe("YouTube E2E — Extension Discovery", () => {
  it("should have pi available on PATH", () => {
    const result = execSync("pi --version 2>&1", { encoding: "utf-8" }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should have the YouTube extension directory structure", () => {
    expect(fs.existsSync(path.join(EXT_DIR, "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(EXT_DIR, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(EXT_DIR, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(EXT_DIR, "client.ts"))).toBe(true);
    expect(fs.existsSync(path.join(EXT_DIR, "tests"))).toBe(true);
  });

  it("should have node_modules installed", () => {
    expect(fs.existsSync(path.join(EXT_DIR, "node_modules", "youtube-transcript"))).toBe(true);
  });
});

function fileURLToPath(url: string): string {
  return url.startsWith("file://") ? new URL(url).pathname : url;
}
