import * as fs from "fs";
import * as path from "path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { validateRegistrationContract, type PlaybookRegistry } from "@penny/orchestration";

interface SkillFrontmatter extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
  "disable-model-invocation"?: unknown;
  metadata?: unknown;
}

export interface SkillDiscovery {
  name: string;
  directoryName: string;
  description: string;
  path: string;
  disableModelInvocation: boolean;
  engine?: string;
  metadataValid: boolean;
}

export type SkillPackageCheck =
  | { readonly ok: true; readonly skill: SkillDiscovery }
  | { readonly ok: false; readonly reason: string };

interface DiscoveryOptions {
  onMetadataError?: (directoryName: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function pennyMetadata(frontmatter: SkillFrontmatter): Record<string, unknown> | undefined {
  return record(record(frontmatter.metadata)?.["penny"]);
}

function parseSkillPackage(skillPath: string, directoryName: string): SkillDiscovery {
  const skillMdPath = path.join(skillPath, "SKILL.md");
  const content = fs.readFileSync(skillMdPath, "utf8");
  const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
  if (
    Object.hasOwn(frontmatter, "disable-model-invocation") &&
    frontmatter["disable-model-invocation"] !== true
  ) {
    throw new Error("disable-model-invocation must be omitted or true");
  }
  const penny = pennyMetadata(frontmatter);
  const engine = typeof penny?.engine === "string" ? penny.engine : undefined;
  return {
    name:
      typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
        ? frontmatter.name.trim()
        : directoryName,
    directoryName,
    description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
    path: skillPath,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    ...(engine === undefined ? {} : { engine }),
    metadataValid: true,
  };
}

/** Discover every package exactly once from the one canonical skill source root. */
export function discoverSkillsFromDirectory(
  skillsDir: string,
  options: DiscoveryOptions = {}
): SkillDiscovery[] {
  const skills: SkillDiscovery[] = [];
  if (!fs.existsSync(skillsDir)) return skills;

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const skillPath = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(skillPath, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;
    try {
      skills.push(parseSkillPackage(skillPath, entry.name));
    } catch {
      options.onMetadataError?.(entry.name);
      skills.push({
        name: entry.name,
        directoryName: entry.name,
        description: `Skill: ${entry.name}`,
        path: skillPath,
        disableModelInvocation: true,
        metadataValid: false,
      });
    }
  }

  return skills.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

/** Model visibility is controlled only by the parsed disable flag. */
export function modelInvocableSkills(skills: readonly SkillDiscovery[]): SkillDiscovery[] {
  return skills.filter((skill) => skill.metadataValid && !skill.disableModelInvocation);
}

/** Validate one registered package from the unified root. */
export function checkSkillPackage(input: {
  readonly skillsDir: string;
  readonly name: string;
  readonly discoveredSkills?: readonly SkillDiscovery[];
}): SkillPackageCheck {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(input.name)) {
    return { ok: false, reason: "skill package name is not canonical" };
  }
  const skillPath = path.join(input.skillsDir, input.name);
  const skillMdPath = path.join(skillPath, "SKILL.md");
  try {
    const directory = fs.lstatSync(skillPath);
    const manifest = fs.lstatSync(skillMdPath);
    if (
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      manifest.isSymbolicLink() ||
      !manifest.isFile()
    ) {
      return { ok: false, reason: "skill package path has unsafe type" };
    }
  } catch {
    return { ok: false, reason: "skill package or SKILL.md is unavailable" };
  }

  const discovered = input.discoveredSkills ?? discoverSkillsFromDirectory(input.skillsDir);
  const matches = discovered.filter(
    (skill) => skill.directoryName === input.name || skill.name === input.name
  );
  if (matches.length !== 1) {
    return { ok: false, reason: "skill package identity is missing or ambiguous" };
  }
  const skill = matches[0];
  if (
    skill === undefined ||
    !skill.metadataValid ||
    skill.directoryName !== input.name ||
    skill.name !== input.name ||
    skill.engine !== "orchestration"
  ) {
    return {
      ok: false,
      reason: "skill manifest must match its directory and declare the orchestration engine",
    };
  }
  return { ok: true, skill };
}

/**
 * Validate the complete package↔registry relationship after one discovery pass.
 *
 * A model-invocable orchestration package must have one executable registration.
 * Visibility never grants execution authority; generic ingress independently refuses
 * unregistered names regardless of their parsed disable flag.
 */
export function validateUnifiedSkillRegistryPackages(input: {
  readonly skillsDir: string;
  readonly registry: PlaybookRegistry;
  readonly discoveredSkills?: readonly SkillDiscovery[];
}): readonly SkillDiscovery[] {
  const discovered = input.discoveredSkills ?? discoverSkillsFromDirectory(input.skillsDir);
  const names = discovered.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error("unified skill package names are duplicated or ambiguous");
  }

  for (const [name, registration] of input.registry) {
    validateRegistrationContract(registration);
    const packageCheck = checkSkillPackage({
      skillsDir: input.skillsDir,
      name,
      discoveredSkills: discovered,
    });
    if (!packageCheck.ok) {
      throw new Error(`registry/package mismatch for '${name}': ${packageCheck.reason}`);
    }
  }

  for (const skill of discovered) {
    if (!skill.metadataValid) {
      throw new Error(`skill package '${skill.directoryName}' has invalid metadata`);
    }
    if (
      skill.engine === "orchestration" &&
      !skill.disableModelInvocation &&
      !input.registry.has(skill.name)
    ) {
      throw new Error(
        `model-invocable skill package '${skill.directoryName}' has no executable registry binding`
      );
    }
  }

  return discovered;
}
