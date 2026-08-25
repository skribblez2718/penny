import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  parseFrontmatter: (content: string) => {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { frontmatter: {}, body: content };

    const frontmatter: Record<string, unknown> = {};
    for (const line of match[1].split("\n")) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      const rawValue = line.slice(separator + 1).trim();
      frontmatter[key] = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
    }
    return { frontmatter, body: content.replace(/^---\n[\s\S]*?\n---\n?/, "") };
  },
}));

import { discoverSkillsFromDirectory, modelInvocableSkills } from "../../skill-discovery.js";

const temporaryDirectories: string[] = [];

function makeSkillsDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penny-skill-discovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSkill(root: string, name: string, disabled: boolean): void {
  const skillDirectory = path.join(root, name);
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(skillDirectory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${name} description`,
      `disable-model-invocation: ${disabled}`,
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

describe("skill discovery model visibility", () => {
  it("soft-hides disabled skills without removing them from the execution registry", () => {
    const skillsDirectory = makeSkillsDirectory();
    writeSkill(skillsDirectory, "enabled-skill", false);
    writeSkill(skillsDirectory, "hidden-skill", true);

    const discovered = discoverSkillsFromDirectory(skillsDirectory);
    const hidden = discovered.find((skill) => skill.name === "hidden-skill");

    expect(hidden).toMatchObject({ disableModelInvocation: true });
    expect(modelInvocableSkills(discovered).map((skill) => skill.name)).toEqual(["enabled-skill"]);
  });
});
