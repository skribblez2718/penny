/**
 * Subagent Extension E2E Tests
 *
 * Tests extension discovery and structure without LLM API calls.
 * Full E2E with LLM is run separately.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths relative to THIS file, not process.cwd(), so the suite passes
// regardless of the directory vitest is launched from (the per-extension test
// runner cd's into the extension dir; a root run does not). This file lives at
// .pi/extensions/subagent/tests/e2e/, so the extension root is two levels up
// and the project root is five.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUBAGENT_DIR = path.resolve(HERE, "../..");
const PROJECT_ROOT = path.resolve(SUBAGENT_DIR, "../../..");

describe("Subagent E2E — Extension Discovery", () => {
  it("should have pi available on PATH", () => {
    const result = execSync("pi --version 2>&1", { encoding: "utf-8" }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should have the subagent extension directory structure", () => {
    expect(fs.existsSync(path.join(SUBAGENT_DIR, "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(SUBAGENT_DIR, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(SUBAGENT_DIR, "tsconfig.json"))).toBe(true);
  });

  it("should have agent definitions in .pi/agents/", () => {
    const agentsDir = path.join(PROJECT_ROOT, ".pi/agents");
    const agents = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.map((f) => path.basename(f, ".md"))).toContain("echo");
  });
});
