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

function registrationFor(
  name: string,
  releaseStatus: "production" | "candidate"
): PlaybookRegistrationV1 {
  const research = resolvePlaybook("research");
  if (research === undefined || research.worker.kind !== "catalog-agent") {
    throw new Error("research registration fixture is unavailable");
  }
  return {
    ...research,
    name,
    contract: { ...research.contract, name, release_status: releaseStatus },
    worker: { ...research.worker, workflow_name: name },
  };
}

function writeSkill(
  root: string,
  name: string,
  input: { readonly disabled?: boolean; readonly releaseStatus: "production" | "candidate" }
): void {
  const skillDirectory = path.join(root, name);
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(skillDirectory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${name} description`,
      ...(input.disabled === undefined ? [] : [`disable-model-invocation: ${input.disabled}`]),
      "metadata:",
      "  penny:",
      "    engine: orchestration",
      `    release_status: ${input.releaseStatus}`,
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
    writeSkill(skillsRoot, "production-visible", {
      disabled: false,
      releaseStatus: "production",
    });
    writeSkill(skillsRoot, "candidate-visible", {
      disabled: false,
      releaseStatus: "candidate",
    });
    writeSkill(skillsRoot, "candidate-implicit-visible", { releaseStatus: "candidate" });
    writeSkill(skillsRoot, "production-hidden", {
      disabled: true,
      releaseStatus: "production",
    });
    writeSkill(skillsRoot, "candidate-hidden", {
      disabled: true,
      releaseStatus: "candidate",
    });
    fs.writeFileSync(
      path.join(skillsRoot, ".ignore"),
      "# Explicitly model-disabled packages only.\ncandidate-hidden/\nproduction-hidden/\n"
    );

    const loaded = loadSkills({
      cwd: project,
      agentDir: path.join(project, ".agent"),
      skillPaths: [],
      includeDefaults: true,
    });
    expect(loaded.skills.map((skill) => skill.name).sort()).toEqual([
      "candidate-implicit-visible",
      "candidate-visible",
      "production-visible",
    ]);
    const prompt = formatSkillsForPrompt(loaded.skills);
    expect(prompt).toContain("candidate-implicit-visible");
    expect(prompt).toContain("candidate-visible");
    expect(prompt).toContain("production-visible");
    expect(prompt).not.toContain("candidate-hidden");
    expect(prompt).not.toContain("production-hidden");

    const discovered = discoverSkillsFromDirectory(skillsRoot);
    expect(modelInvocableSkills(discovered).map((skill) => skill.name)).toEqual([
      "candidate-implicit-visible",
      "candidate-visible",
      "production-visible",
    ]);
  });

  it("uses release status only for the registry namespace", () => {
    const project = makeProject();
    const skillsRoot = path.join(project, ".pi", "skills");
    writeSkill(skillsRoot, "candidate-visible", {
      disabled: false,
      releaseStatus: "candidate",
    });
    const discovered = discoverSkillsFromDirectory(skillsRoot);
    expect(
      checkSkillPackage({
        skillsDir: skillsRoot,
        name: "candidate-visible",
        expectedReleaseStatus: "candidate",
        discoveredSkills: discovered,
      })
    ).toMatchObject({ ok: true });
    expect(
      checkSkillPackage({
        skillsDir: skillsRoot,
        name: "candidate-visible",
        expectedReleaseStatus: "production",
        discoveredSkills: discovered,
      })
    ).toMatchObject({ ok: false });
    expect(modelInvocableSkills(discovered).map((skill) => skill.name)).toEqual([
      "candidate-visible",
    ]);
  });

  it("requires native ignore entries to mirror explicit disablement across release classes", () => {
    const project = makeProject();
    const skillsRoot = path.join(project, ".pi", "skills");
    writeSkill(skillsRoot, "production-hidden", {
      disabled: true,
      releaseStatus: "production",
    });
    writeSkill(skillsRoot, "candidate-visible", {
      disabled: false,
      releaseStatus: "candidate",
    });
    fs.writeFileSync(path.join(skillsRoot, ".ignore"), "production-hidden/\n");
    const production = registrationFor("production-hidden", "production");
    const candidate = registrationFor("candidate-visible", "candidate");
    const discovered = discoverSkillsFromDirectory(skillsRoot);

    expect(
      validateUnifiedSkillRegistryPackages({
        skillsDir: skillsRoot,
        productionRegistry: new Map([[production.name, production]]),
        candidateRegistry: new Map([[candidate.name, candidate]]),
        discoveredSkills: discovered,
      }).map((skill) => skill.name)
    ).toEqual(["candidate-visible", "production-hidden"]);

    fs.writeFileSync(path.join(skillsRoot, ".ignore"), "candidate-visible/\n");
    expect(() =>
      validateUnifiedSkillRegistryPackages({
        skillsDir: skillsRoot,
        productionRegistry: new Map([[production.name, production]]),
        candidateRegistry: new Map([[candidate.name, candidate]]),
        discoveredSkills: discovered,
      })
    ).toThrow(/explicitly model-disabled package names exactly/u);
  });
});
