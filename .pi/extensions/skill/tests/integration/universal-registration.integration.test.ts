import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLAYBOOK_REGISTRY } from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

import { resolveSkillIngress } from "../../skill-ingress.js";
import {
  checkSkillPackage,
  discoverSkillsFromDirectory,
  modelInvocableSkills,
  validateUnifiedSkillRegistryPackages,
} from "../../skill-discovery.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const SKILLS_DIR = path.join(PROJECT_ROOT, ".pi", "skills");
const GENERIC_UNIVERSAL_SKILLS = ["assess", "decide", "diagnose", "plan", "produce"] as const;

describe("unified production skill registration", () => {
  it("binds every model-invocable orchestration package to the sole executable registry", () => {
    const discovered = discoverSkillsFromDirectory(SKILLS_DIR);
    expect(
      validateUnifiedSkillRegistryPackages({
        skillsDir: SKILLS_DIR,
        registry: PLAYBOOK_REGISTRY,
        discoveredSkills: discovered,
      })
    ).toEqual(discovered);

    for (const name of GENERIC_UNIVERSAL_SKILLS) {
      expect(
        checkSkillPackage({ skillsDir: SKILLS_DIR, name, discoveredSkills: discovered })
      ).toMatchObject({
        ok: true,
      });
      expect(PLAYBOOK_REGISTRY.has(name)).toBe(true);
      expect(
        resolveSkillIngress({ projectRoot: PROJECT_ROOT, skillsDir: SKILLS_DIR, name })
      ).toMatchObject({
        ok: true,
      });
    }
  });

  it("keeps an unregistered model-disabled development package discoverable but non-executable", () => {
    const discovered = discoverSkillsFromDirectory(SKILLS_DIR);
    expect(discovered.find((skill) => skill.name === "sca")).toMatchObject({
      engine: "orchestration",
      disableModelInvocation: true,
      metadataValid: true,
    });
    expect(modelInvocableSkills(discovered).map((skill) => skill.name)).not.toContain("sca");
    expect(
      resolveSkillIngress({ projectRoot: PROJECT_ROOT, skillsDir: SKILLS_DIR, name: "sca" })
    ).toEqual({
      ok: false,
      code: "SKILL_NOT_REGISTERED",
      message: "skill 'sca' is not registered",
    });
  });
});
