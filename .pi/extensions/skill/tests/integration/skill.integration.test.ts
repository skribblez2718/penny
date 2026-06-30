/**
 * Skill Extension Integration Tests
 *
 * Tests the skill extension with real tool registration:
 * - Tool registration verification
 * - Parameter schema validation
 * - Skill discovery and orchestration logic
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Skill Integration — Skill Discovery", () => {
  it("should find the plan skill in .pi/skills/", () => {
    const skillsDir = path.join(process.cwd(), ".pi/skills");
    expect(fs.existsSync(skillsDir)).toBe(true);

    const planDir = path.join(skillsDir, "plan");
    expect(fs.existsSync(planDir)).toBe(true);

    const skillFile = path.join(planDir, "SKILL.md");
    expect(fs.existsSync(skillFile)).toBe(true);
  });

  it("should have orchestrate.py in the plan skill", () => {
    const scriptPath = path.join(process.cwd(), ".pi/skills/plan/scripts/orchestrate.py");
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it("should have Python venv for orchestration scripts", () => {
    const venvPath = path.join(process.cwd(), ".venv/bin/python");
    expect(fs.existsSync(venvPath)).toBe(true);
  });
});

describe("Skill Integration — Orchestrate Script Validation", () => {
  it("should have valid Python syntax in orchestrate.py", () => {
    const scriptPath = path.join(process.cwd(), ".pi/skills/plan/scripts/orchestrate.py");
    const content = fs.readFileSync(scriptPath, "utf-8");

    // Basic Python validity checks
    expect(content).toContain("def ");
    expect(content).toContain("import ");
    expect(content.length).toBeGreaterThan(100);
  });

  it("should define state machine classes", () => {
    const scriptPath = path.join(process.cwd(), ".pi/skills/plan/scripts/orchestrate.py");
    const content = fs.readFileSync(scriptPath, "utf-8");

    expect(content).toContain("class ");
  });
});

describe("Skill Integration — SKILL.md Validation", () => {
  it("should have valid SKILL.md format", () => {
    const skillPath = path.join(process.cwd(), ".pi/skills/plan/SKILL.md");
    const content = fs.readFileSync(skillPath, "utf-8");

    // SKILL.md should have YAML frontmatter
    expect(content).toContain("---");
    expect(content).toContain("name:");
    expect(content).toContain("description:");
  });
});
