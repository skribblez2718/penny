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

describe("Skill E2E — Extension Discovery", () => {
  it("should have pi available on PATH", () => {
    const result = execSync("pi --version 2>&1", { encoding: "utf-8" }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should have the skill extension directory structure", () => {
    const extDir = path.join(process.cwd(), ".pi/extensions/skill");
    expect(fs.existsSync(path.join(extDir, "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "tsconfig.json"))).toBe(true);
  });

  it("should have the plan skill with orchestrate script", () => {
    const skillDir = path.join(process.cwd(), ".pi/skills/plan");
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, "scripts/orchestrate.py"))).toBe(true);
  });
});
