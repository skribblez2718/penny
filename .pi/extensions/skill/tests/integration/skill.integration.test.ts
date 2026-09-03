import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("TypeScript skill integration", () => {
  it("discovers the research manifest without an executable delegate", () => {
    const research = path.join(PROJECT_ROOT, ".pi", "skills", "research");
    expect(existsSync(path.join(research, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(research, "scripts", "orchestrate.py"))).toBe(false);
  });

  it("ships the research playbook and registry in the TypeScript package", () => {
    expect(
      existsSync(
        path.join(PROJECT_ROOT, "apps", "orchestration", "src", "playbooks", "research.ts")
      )
    ).toBe(true);
    const registry = readFileSync(
      path.join(PROJECT_ROOT, "apps", "orchestration", "src", "playbooks", "registry.ts"),
      "utf8"
    );
    expect(registry).toContain('DEFAULT_PLAYBOOK_NAME = "research"');
  });

  it("declares the shared TypeScript orchestration engine in SKILL.md", () => {
    const content = readFileSync(
      path.join(PROJECT_ROOT, ".pi", "skills", "research", "SKILL.md"),
      "utf8"
    );
    expect(content).toContain("engine: orchestration");
    expect(content).not.toContain("python");
  });
});
