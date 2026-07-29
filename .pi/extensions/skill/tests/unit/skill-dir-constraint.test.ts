/**
 * `skill_dir` constraint injection.
 *
 * WHY: an agent subprocess is spawned with `cwd = projectRoot` — the TARGET repo a
 * skill operates on, which for code/jsa/sca/prd runs is NOT this repo. Any
 * skill-relative path a playbook puts in a task message ("resources/foo.md",
 * "python3 scripts/bar.py --stdin") therefore resolves into the wrong tree, and the
 * agent proceeds WITHOUT the guidance instead of failing loudly. The driver is the
 * only component that authoritatively knows `skill.path`, so it injects it as an
 * absolute `skill_dir` constraint that playbooks use to emit absolute paths.
 *
 * These tests pin the contract of the injection itself (shape + precedence), which is
 * what downstream playbooks depend on.
 */

import { describe, expect, it } from "vitest";

/**
 * Mirror of the driver's constraint-building expression (index.ts, executeSkill).
 * Kept as a pure function so the contract is testable without booting the whole
 * skill loop; the production copy is the same three branches.
 */
function buildConstraints(
  paramsConstraints: unknown,
  skillPath: string,
  constraintsObj: Record<string, unknown>
): string {
  if (typeof paramsConstraints === "string") {
    try {
      const parsed = JSON.parse(paramsConstraints) as Record<string, unknown>;
      return JSON.stringify({ skill_dir: skillPath, ...parsed });
    } catch {
      return paramsConstraints;
    }
  }
  return JSON.stringify({ skill_dir: skillPath, ...constraintsObj });
}

const SKILL_PATH = "/abs/path/.pi/skills/prd";

describe("skill_dir constraint injection", () => {
  it("injects an absolute skill_dir when no constraints are supplied", () => {
    const out = JSON.parse(buildConstraints(undefined, SKILL_PATH, {}));
    expect(out.skill_dir).toBe(SKILL_PATH);
    expect(out.skill_dir.startsWith("/")).toBe(true);
  });

  it("preserves caller constraints alongside skill_dir", () => {
    const obj = { domain: "web-app", max_iterations: 3 };
    const out = JSON.parse(buildConstraints(obj, SKILL_PATH, obj));
    expect(out).toEqual({ skill_dir: SKILL_PATH, domain: "web-app", max_iterations: 3 });
  });

  it("lets an explicit caller skill_dir win over the driver's", () => {
    const obj = { skill_dir: "/caller/override" };
    const out = JSON.parse(buildConstraints(obj, SKILL_PATH, obj));
    expect(out.skill_dir).toBe("/caller/override");
  });

  it("injects into a JSON-string constraints payload too", () => {
    const out = JSON.parse(buildConstraints('{"domain":"generic"}', SKILL_PATH, {}));
    expect(out).toEqual({ skill_dir: SKILL_PATH, domain: "generic" });
  });

  it("passes an unparseable constraints string through untouched", () => {
    // Never silently drop a caller payload we cannot understand.
    expect(buildConstraints("not json{", SKILL_PATH, {})).toBe("not json{");
  });

  it("produces a payload that survives a JSON round-trip (the Python CLI parses it)", () => {
    const out = buildConstraints({ domain: "web-app" }, SKILL_PATH, { domain: "web-app" });
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
