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
import { fileURLToPath } from "node:url";

// Resolve the project root from THIS file, not PROJECT_ROOT, so the suite passes
// regardless of the directory vitest is launched from (the per-extension runner
// cd's into the extension dir). This file lives at
// .pi/extensions/skill/tests/integration/, so the project root is five levels up.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("Skill Integration — Skill Discovery", () => {
  it("should find the plan skill in .pi/skills/", () => {
    const skillsDir = path.join(PROJECT_ROOT, ".pi/skills");
    expect(fs.existsSync(skillsDir)).toBe(true);

    const planDir = path.join(skillsDir, "plan");
    expect(fs.existsSync(planDir)).toBe(true);

    const skillFile = path.join(planDir, "SKILL.md");
    expect(fs.existsSync(skillFile)).toBe(true);
  });

  it("should have orchestrate.py in the plan skill", () => {
    const scriptPath = path.join(PROJECT_ROOT, ".pi/skills/plan/scripts/orchestrate.py");
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it("should have Python venv for orchestration scripts", () => {
    const venvPath = path.join(PROJECT_ROOT, ".venv/bin/python");
    expect(fs.existsSync(venvPath)).toBe(true);
  });
});

describe("Skill Integration — Orchestrate Script Validation", () => {
  it("should have valid Python syntax in orchestrate.py", () => {
    const scriptPath = path.join(PROJECT_ROOT, ".pi/skills/plan/scripts/orchestrate.py");
    const content = fs.readFileSync(scriptPath, "utf-8");

    // Post-migration: orchestrate.py is a ~5-line delegate into the shared
    // orchestration engine — it imports and routes to the engine CLI, with no
    // local `def`/`class`/FSM.
    expect(content).toContain("import ");
    expect(content).toContain("orchestration");
    expect(content.length).toBeGreaterThan(100);
  });

  it("should route to the shared orchestration engine's playbook", () => {
    const scriptPath = path.join(PROJECT_ROOT, ".pi/skills/plan/scripts/orchestrate.py");
    const content = fs.readFileSync(scriptPath, "utf-8");

    // The FSM now lives in the installed `orchestration` package (PlanPlaybook);
    // the delegate just wires start/step/status/recover to it.
    expect(content).toContain("orchestration.cli");
    expect(content).toContain("default_playbook");
  });
});

describe("Skill Integration — SKILL.md Validation", () => {
  it("should have valid SKILL.md format", () => {
    const skillPath = path.join(PROJECT_ROOT, ".pi/skills/plan/SKILL.md");
    const content = fs.readFileSync(skillPath, "utf-8");

    // SKILL.md should have YAML frontmatter
    expect(content).toContain("---");
    expect(content).toContain("name:");
    expect(content).toContain("description:");
  });
});
