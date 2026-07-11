/**
 * Skill Extension E2E Tests
 *
 * Tests extension discovery and structure without LLM API calls.
 * Full E2E with LLM is run separately.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";

// Anchor to THIS file's location (invariant), not process.cwd() (ambient — set
// by whichever directory the runner was launched from). This file lives at
// .pi/extensions/skill/tests/e2e/, so the project root is five levels up.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

// `pi` is an external binary that may not be installed / on PATH (clean CI,
// minimal shells). Probe once and skip the PATH assertion gracefully rather than
// hard-failing on an environment precondition the suite does not own.
function piOnPath(): boolean {
  try {
    execSync("pi --version 2>&1", { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}
const PI_AVAILABLE = piOnPath();

describe("Skill E2E — Extension Discovery", () => {
  it.skipIf(!PI_AVAILABLE)("should have pi available on PATH", () => {
    const result = execSync("pi --version 2>&1", { encoding: "utf-8" }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should have the skill extension directory structure", () => {
    const extDir = path.join(PROJECT_ROOT, ".pi/extensions/skill");
    expect(fs.existsSync(path.join(extDir, "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "tsconfig.json"))).toBe(true);
  });

  it("should have the plan skill with orchestrate script", () => {
    const skillDir = path.join(PROJECT_ROOT, ".pi/skills/plan");
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, "scripts/orchestrate.py"))).toBe(true);
  });
});
