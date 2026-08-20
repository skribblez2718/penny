import * as fs from "fs";
import * as path from "path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  "disable-model-invocation"?: unknown;
}

export interface SkillDiscovery {
  name: string;
  description: string;
  path: string;
  disableModelInvocation: boolean;
}

interface DiscoveryOptions {
  onMetadataError?: (directoryName: string) => void;
}

/**
 * Discover orchestration skills while preserving Pi's model-invocation flag.
 *
 * Disabled skills remain in the returned registry so explicit `/skill:name`
 * requests can still execute them. Call modelInvocableSkills() only when
 * constructing model-facing descriptions and listings.
 */
export function discoverSkillsFromDirectory(
  skillsDir: string,
  options: DiscoveryOptions = {}
): SkillDiscovery[] {
  const skills: SkillDiscovery[] = [];
  if (!fs.existsSync(skillsDir)) return skills;

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillPath = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(skillPath, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    let name = entry.name;
    let description = "";
    let disableModelInvocation = false;

    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
      if (typeof frontmatter.name === "string" && frontmatter.name.trim()) {
        name = frontmatter.name.trim();
      }
      if (typeof frontmatter.description === "string") {
        description = frontmatter.description.trim();
      }
      disableModelInvocation = frontmatter["disable-model-invocation"] === true;
    } catch {
      options.onMetadataError?.(entry.name);
      description = `Skill: ${entry.name}`;
    }

    skills.push({
      name,
      description,
      path: skillPath,
      disableModelInvocation,
    });
  }

  return skills;
}

/** Skills that may be advertised to and selected autonomously by the model. */
export function modelInvocableSkills(skills: SkillDiscovery[]): SkillDiscovery[] {
  return skills.filter((skill) => !skill.disableModelInvocation);
}
