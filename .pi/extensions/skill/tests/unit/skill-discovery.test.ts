import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";
import { resolvePlaybook, type PlaybookRegistration } from "@penny/orchestration";
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

function registrationFor(name: string): PlaybookRegistration {
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
    seal_policy: undefined,
  };
}

function writeSkill(root: string, name: string, disabled?: true): void {
  const skillDirectory = path.join(root, name);
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(skillDirectory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${name} skill. Use when testing discovery. Do not use for production work.`,
      ...(disabled === undefined ? [] : ["disable-model-invocation: true"]),
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
  it("loads both visibility classes natively but advertises only the omitted-flag class", () => {
    const project = makeProject();
    const skillsRoot = path.join(project, ".pi", "skills");
    writeSkill(skillsRoot, "visible-default");
    writeSkill(skillsRoot, "hidden-explicit", true);

    const loaded = loadSkills({
      cwd: project,
      agentDir: path.join(project, ".agent"),
      skillPaths: [],
      includeDefaults: true,
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills.map((skill) => skill.name).sort()).toEqual([
      "hidden-explicit",
      "visible-default",
    ]);
    expect(loaded.skills.find((skill) => skill.name === "hidden-explicit")).toMatchObject({
      disableModelInvocation: true,
    });
    expect(loaded.skills.find((skill) => skill.name === "visible-default")).toMatchObject({
      disableModelInvocation: false,
    });
    const prompt = formatSkillsForPrompt(loaded.skills);
    expect(prompt).toContain("<name>visible-default</name>");
    expect(prompt).not.toContain("<name>hidden-explicit</name>");

    const discovered = discoverSkillsFromDirectory(skillsRoot);
    expect(discovered.map((skill) => skill.name)).toEqual(["hidden-explicit", "visible-default"]);
    expect(modelInvocableSkills(discovered).map((skill) => skill.name)).toEqual([
      "visible-default",
    ]);
  });

  it("accepts one matching package without lifecycle metadata", () => {
    const skillsRoot = path.join(makeProject(), ".pi", "skills");
    writeSkill(skillsRoot, "visible-skill");
    expect(checkSkillPackage({ skillsDir: skillsRoot, name: "visible-skill" })).toMatchObject({
      ok: true,
    });
  });

  it("validates registered visible and hidden packages without extra discovery configuration", () => {
    const skillsDir = path.join(makeProject(), ".pi", "skills");
    writeSkill(skillsDir, "registered-visible");
    writeSkill(skillsDir, "registered-hidden", true);
    const registry = new Map(
      ["registered-visible", "registered-hidden"].map((name) => [name, registrationFor(name)])
    );
    expect(
      validateUnifiedSkillRegistryPackages({ skillsDir, registry }).map((skill) => skill.name)
    ).toEqual(["registered-hidden", "registered-visible"]);
    expect(() => validateUnifiedSkillRegistryPackages({ skillsDir, registry: new Map() })).toThrow(
      /model-invocable skill package/u
    );
  });

  it.each(["false", '"true"', '"false"', "null", "", "1", "[]", "{}"])(
    "rejects invalid visibility %j instead of advertising or admitting it",
    (flag) => {
      const skillsDir = path.join(makeProject(), ".pi", "skills");
      const name = "invalid-visibility";
      writeSkill(skillsDir, name, true);
      const manifest = path.join(skillsDir, name, "SKILL.md");
      fs.writeFileSync(
        manifest,
        fs
          .readFileSync(manifest, "utf8")
          .replace("disable-model-invocation: true", `disable-model-invocation: ${flag}`)
      );
      const errors: string[] = [];
      const discovered = discoverSkillsFromDirectory(skillsDir, {
        onMetadataError: (directoryName) => errors.push(directoryName),
      });
      expect(errors).toEqual([name]);
      expect(discovered).toMatchObject([{ metadataValid: false }]);
      expect(modelInvocableSkills(discovered)).toEqual([]);
      expect(checkSkillPackage({ skillsDir, name, discoveredSkills: discovered })).toMatchObject({
        ok: false,
      });
      expect(() =>
        validateUnifiedSkillRegistryPackages({ skillsDir, registry: new Map() })
      ).toThrow(/invalid metadata/u);
    }
  );

  it.each(["yaml", "identity", "engine", "symlink"] as const)(
    "refuses registered-package %s drift independently of visibility",
    (fault) => {
      const skillsDir = path.join(makeProject(), ".pi", "skills");
      const name = "hidden-registered";
      writeSkill(skillsDir, name, true);
      const manifest = path.join(skillsDir, name, "SKILL.md");
      const registry = new Map([[name, registrationFor(name)]]);
      if (fault === "yaml") fs.writeFileSync(manifest, "---\nname: [unterminated\n---\n");
      if (fault === "identity")
        fs.writeFileSync(
          manifest,
          fs.readFileSync(manifest, "utf8").replace(`name: ${name}`, "name: impostor")
        );
      if (fault === "engine")
        fs.writeFileSync(
          manifest,
          fs.readFileSync(manifest, "utf8").replace("engine: orchestration", "engine: other")
        );
      if (fault === "symlink") {
        fs.renameSync(manifest, `${manifest}.original`);
        fs.symlinkSync(`${manifest}.original`, manifest);
      }
      expect(() => validateUnifiedSkillRegistryPackages({ skillsDir, registry })).toThrow(
        /registry\/package mismatch/u
      );
    }
  );
});
