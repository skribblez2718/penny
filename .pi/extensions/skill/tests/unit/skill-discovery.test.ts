import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";
import { resolvePlaybook, type PlaybookRegistrationV1 } from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  checkSkillPackage,
  discoverSkillsFromDirectory,
  modelInvocableSkills,
  validateUnifiedSkillRegistryPackages,
} from "../../skill-discovery.js";

const temporaryDirectories: string[] = [];

function makeProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penny-skill-discovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

function registrationFor(name: string): PlaybookRegistrationV1 {
  const research = resolvePlaybook("research");
  if (research === undefined || research.worker.kind !== "catalog-agent") {
    throw new Error("research registration fixture is unavailable");
  }
  return {
    ...research,
    name,
    contract: { ...research.contract, name },
    worker: { ...research.worker, workflow_name: name },
    generic_child: undefined,
  };
}

function writeSkill(root: string, name: string, disabled?: boolean): void {
  const skillDirectory = path.join(root, name);
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(skillDirectory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${name} skill. Use when testing discovery. Do not use for production work.`,
      ...(disabled === undefined ? [] : [`disable-model-invocation: ${disabled}`]),
      "metadata:",
      "  penny:",
      "    engine: orchestration",
      "---",
      "",
      `# ${name}`,
    ].join("\n")
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("unified skill discovery and model visibility", () => {
  it("uses only the disable flag for native and Penny model visibility", () => {
    const project = makeProject();
    const skillsRoot = path.join(project, ".pi", "skills");
    writeSkill(skillsRoot, "visible-explicit", false);
    writeSkill(skillsRoot, "visible-default");
    writeSkill(skillsRoot, "hidden-explicit", true);
    fs.writeFileSync(
      path.join(skillsRoot, ".ignore"),
      "# Explicitly model-disabled packages only.\nhidden-explicit/\n"
    );

    const loaded = loadSkills({
      cwd: project,
      agentDir: path.join(project, ".agent"),
      skillPaths: [],
      includeDefaults: true,
    });
    expect(loaded.skills.map((skill) => skill.name).sort()).toEqual([
      "visible-default",
      "visible-explicit",
    ]);
    const prompt = formatSkillsForPrompt(loaded.skills);
    expect(prompt).toContain("visible-default");
    expect(prompt).toContain("visible-explicit");
    expect(prompt).not.toContain("hidden-explicit");

    const discovered = discoverSkillsFromDirectory(skillsRoot);
    expect(modelInvocableSkills(discovered).map((skill) => skill.name)).toEqual([
      "visible-default",
      "visible-explicit",
    ]);
  });

  it("accepts one matching package without lifecycle metadata", () => {
    const project = makeProject();
    const skillsRoot = path.join(project, ".pi", "skills");
    writeSkill(skillsRoot, "visible-skill", false);
    const discovered = discoverSkillsFromDirectory(skillsRoot);
    expect(
      checkSkillPackage({
        skillsDir: skillsRoot,
        name: "visible-skill",
        discoveredSkills: discovered,
      })
    ).toMatchObject({ ok: true });
  });

  it("requires model-invocable packages to be registered but permits disabled scaffolds", () => {
    const project = makeProject();
    const skillsRoot = path.join(project, ".pi", "skills");
    writeSkill(skillsRoot, "registered-visible", false);
    writeSkill(skillsRoot, "disabled-scaffold", true);
    fs.writeFileSync(path.join(skillsRoot, ".ignore"), "disabled-scaffold/\n");
    const visible = registrationFor("registered-visible");
    const discovered = discoverSkillsFromDirectory(skillsRoot);

    expect(
      validateUnifiedSkillRegistryPackages({
        skillsDir: skillsRoot,
        registry: new Map([[visible.name, visible]]),
        discoveredSkills: discovered,
      }).map((skill) => skill.name)
    ).toEqual(["disabled-scaffold", "registered-visible"]);

    expect(() =>
      validateUnifiedSkillRegistryPackages({
        skillsDir: skillsRoot,
        registry: new Map(),
        discoveredSkills: discovered,
      })
    ).toThrow(/model-invocable skill package/u);

    fs.writeFileSync(path.join(skillsRoot, ".ignore"), "registered-visible/\n");
    expect(() =>
      validateUnifiedSkillRegistryPackages({
        skillsDir: skillsRoot,
        registry: new Map([[visible.name, visible]]),
        discoveredSkills: discovered,
      })
    ).toThrow(/explicitly model-disabled package names exactly/u);
  });
});
