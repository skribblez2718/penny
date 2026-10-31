import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLAYBOOK_REGISTRY } from "@penny/orchestration";
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
const GENERIC_UNIVERSAL_SKILLS = [
  "assess",
  "decide",
  "diagnose",
  "plan",
  "produce",
  "sca",
] as const;

describe("unified production skill registration", () => {
  it("exposes exact registered V2 Define/Plan assurance at the generic ingress", () => {
    for (const name of ["define", "plan"] as const) {
      const resolved = resolveSkillIngress({
        projectRoot: PROJECT_ROOT,
        skillsDir: SKILLS_DIR,
        name,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.message);
      expect(resolved.registration.start_admission?.invocation_versions).toEqual([1, 2]);
      expect(resolved.registration.caller_documentation?.example.constraints).toMatchObject({
        schema_version: 2,
        specification_assurance: "reviewed_definition",
      });
      expect(resolved.registration.caller_documentation?.constraints_schema).toMatchObject({
        properties: {
          specification_assurance: {
            anyOf: [{ const: "reviewed_definition" }, { const: "semantic_only" }],
          },
        },
      });
    }
  });

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

  it("exposes the registered SCA package to model invocation", () => {
    const discovered = discoverSkillsFromDirectory(SKILLS_DIR);
    expect(discovered.find((skill) => skill.name === "sca")).toMatchObject({
      engine: "orchestration",
      disableModelInvocation: false,
      metadataValid: true,
    });
    expect(modelInvocableSkills(discovered).map((skill) => skill.name)).toContain("sca");
    expect(
      resolveSkillIngress({ projectRoot: PROJECT_ROOT, skillsDir: SKILLS_DIR, name: "sca" })
    ).toMatchObject({ ok: true, registration: { name: "sca" } });
  });
});
