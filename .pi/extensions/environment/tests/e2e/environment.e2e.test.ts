/**
 * Environment Extension E2E Tests
 *
 * Tests extension discovery and structure without LLM API calls.
 * Full E2E with LLM is run separately.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

describe("Environment E2E — Extension Discovery", () => {
  it("should have pi available on PATH", () => {
    // pi --version outputs to stderr, so we check the process succeeds
    const result = execSync("pi --version 2>&1", { encoding: "utf-8" }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should have the .pi directory with extension config", () => {
    const extDir = path.join(process.cwd(), ".pi/extensions/environment");
    expect(fs.existsSync(path.join(extDir, "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "tsconfig.json"))).toBe(true);
  });
});
