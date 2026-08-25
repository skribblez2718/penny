/**
 * KB profile registry — §5.1 host-owned profile resolution.
 *
 * The registry maps opaque profile IDs to absolute KB roots. It is an ignored,
 * owner-only host file — never a model-visible argument. The model names a
 * `kb_profile_id`; the host resolves it here.
 *
 * This module reads and validates the registry file. It does not create, modify,
 * or expose roots to callers that lack host authority.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  KbProfileRegistrySchema,
  KbProfileSchema,
  OpaqueIdSchema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
  type KbProfile,
  type KbProfileRegistry,
  type Sha256Hex,
} from "./contracts.js";
import { KbSessionProfileGrantStore } from "./profile-grants.js";

export class ProfileRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileRegistryError";
  }
}

/** A profile that has been resolved and admission-checked. */
export interface ResolvedProfile {
  readonly profile: KbProfile;
  /** Realpath-normalized root, verified to exist and be a directory. */
  readonly resolvedRoot: string;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Load and validate the profile registry from an ignored host file.
 *
 * The file and its containing directory must be regular, non-symlink, and
 * owner-only (0600 / 0700) where the platform supports it.
 */
export function loadProfileRegistry(registryPath: string): KbProfileRegistry {
  if (!existsSync(registryPath)) {
    throw new ProfileRegistryError(`profile registry not found: ${registryPath}`);
  }
  const directory = path.dirname(registryPath);
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new ProfileRegistryError("profile registry directory must be a regular directory");
  }
  const stat = lstatSync(registryPath);
  if (stat.isSymbolicLink()) {
    throw new ProfileRegistryError("profile registry must not be a symlink");
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new ProfileRegistryError("profile registry must be a regular single-link file");
  }
  if ((directoryStat.mode & 0o077) !== 0 || (stat.mode & 0o077) !== 0) {
    throw new ProfileRegistryError("profile registry and directory must be owner-only");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && (directoryStat.uid !== uid || stat.uid !== uid)) {
    throw new ProfileRegistryError("profile registry and directory must be current-user-owned");
  }
  const raw = readFileSync(registryPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProfileRegistryError("profile registry is not valid JSON");
  }
  const parsedProfiles =
    isUnknownRecord(parsed) && Array.isArray(parsed["profiles"]) ? parsed["profiles"] : [];
  const parsedProfileIds = parsedProfiles.flatMap((profile) => {
    if (!isUnknownRecord(profile)) return [];
    const profileId = profile["kb_profile_id"];
    return typeof profileId === "string" ? [profileId] : [];
  });
  if (new Set(parsedProfileIds).size !== parsedProfileIds.length) {
    throw new ProfileRegistryError("profile registry contains a duplicate profile id");
  }
  const registry = validateKbContract(KbProfileRegistrySchema, parsed, "profile registry");
  const profileIds = registry.profiles.map((profile) => profile.kb_profile_id);
  if (new Set(profileIds).size !== profileIds.length) {
    throw new ProfileRegistryError("profile registry contains a duplicate profile id");
  }
  return registry;
}

/**
 * Resolve a profile by ID from a loaded registry.
 *
 * Returns `undefined` when the ID is not present — the caller decides whether
 * that is a refusal or a creation opportunity.
 */
export function findProfile(registry: KbProfileRegistry, profileId: string): KbProfile | undefined {
  return registry.profiles.find((p) => p.kb_profile_id === profileId);
}

/**
 * Validate that a profile ID is well-formed (not a path, not a root, not a
 * traversal attempt).
 */
export function isValidProfileId(id: string): boolean {
  try {
    validateKbContract(OpaqueIdSchema, id, "profile id");
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a single profile entry in isolation.
 */
export function validateProfile(profile: unknown): KbProfile {
  return validateKbContract(KbProfileSchema, profile, "profile");
}

const LIVE_PATH_CLASSES = [
  "manifest.json",
  "index.md",
  ".kb/policy.json",
  ".kb/lock",
  ".kb/current.json",
  ".kb/generations/g/catalog.json",
  ".kb/generations/g/index.sqlite",
  `sources/objects/${"a".repeat(64)}`,
  "sources/records/source_demo.json",
  "pages/page_demo/revisions/rev_demo/page.md",
  "pages/page_demo/revisions/rev_demo/claims.json",
  "conflicts/conflict_demo.json",
  "work/run_demo/artifacts/state_demo/artifact_demo",
] as const;

function hasSymlinkComponent(target: string): boolean {
  let current = path.resolve(target);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function enclosingWorktree(target: string): string | undefined {
  let current = path.resolve(target);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function assertRootCustody(root: string, publicScaffold: boolean): void {
  const stat = statSync(root);
  if (!stat.isDirectory()) throw new ProfileRegistryError("profile root is not a directory");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) {
    throw new ProfileRegistryError("profile root is not current-user-owned");
  }
  if (publicScaffold ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o077) !== 0) {
    throw new ProfileRegistryError(
      publicScaffold
        ? "profile scaffold root must not be group/other writable"
        : "outside-worktree profile root must be owner-only"
    );
  }
}

function listScaffoldEntries(root: string): string[] {
  const entries: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const relative = path.relative(root, child).split(path.sep).join("/");
      if (entry.name === ".git") {
        throw new ProfileRegistryError("nested repository or worktree changes profile containment");
      }
      if (entry.isSymbolicLink()) {
        throw new ProfileRegistryError("profile root contains a symlink component");
      }
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new ProfileRegistryError("profile scaffold contains a special filesystem entry");
      }
      entries.push(relative);
      if (entry.isDirectory()) stack.push(child);
    }
  }
  return entries.sort();
}

function assertScaffoldGitBoundary(worktree: string, root: string): void {
  const relativeRoot = path.relative(worktree, root).split(path.sep).join("/");
  let tracked = "";
  try {
    tracked = execFileSync("git", ["-C", worktree, "ls-files", "--", relativeRoot], {
      encoding: "utf8",
    });
  } catch {
    throw new ProfileRegistryError("unable to establish profile Git boundary");
  }
  const allowed = new Set([
    `${relativeRoot}/.gitignore`,
    `${relativeRoot}/README.md`,
    `${relativeRoot}/manifest.example.json`,
    `${relativeRoot}/templates/page.md`,
    `${relativeRoot}/templates/source.json`,
  ]);
  for (const trackedPath of tracked.split("\n").filter(Boolean)) {
    if (!allowed.has(trackedPath)) {
      throw new ProfileRegistryError("profile scaffold contains tracked live content");
    }
  }
  const isIgnored = (candidate: string): boolean => {
    try {
      execFileSync("git", ["-C", worktree, "check-ignore", "-q", "--no-index", "--", candidate]);
      return true;
    } catch {
      return false;
    }
  };
  for (const livePath of LIVE_PATH_CLASSES) {
    if (!isIgnored(`${relativeRoot}/${livePath}`)) {
      throw new ProfileRegistryError("profile scaffold live paths are not ignored");
    }
  }

  const publicEntries = new Set([
    ".gitignore",
    "README.md",
    "manifest.example.json",
    "templates",
    "templates/page.md",
    "templates/source.json",
  ]);
  const trackedSet = new Set(tracked.split("\n").filter(Boolean));
  for (const relative of listScaffoldEntries(root)) {
    const worktreeRelative = `${relativeRoot}/${relative}`;
    if (publicEntries.has(relative)) continue;
    if (trackedSet.has(worktreeRelative)) {
      throw new ProfileRegistryError("profile scaffold contains tracked live content");
    }
    if (!isIgnored(worktreeRelative)) {
      throw new ProfileRegistryError("an existing profile live path is not ignored");
    }
  }
}

/** Resolve one registered profile for an authenticated host administration command. */
export function resolveRegisteredProfile(input: {
  profileId: string;
  registryPath: string;
}): ResolvedProfile {
  if (!isValidProfileId(input.profileId)) {
    throw new ProfileRegistryError("profile id is invalid");
  }
  const profile = findProfile(loadProfileRegistry(input.registryPath), input.profileId);
  if (profile === undefined) throw new ProfileRegistryError("profile is not registered");
  if (!path.isAbsolute(profile.kb_root) || hasSymlinkComponent(profile.kb_root)) {
    throw new ProfileRegistryError("profile root must be an absolute non-symlink path");
  }
  if (!existsSync(profile.kb_root)) throw new ProfileRegistryError("profile root does not exist");
  const resolvedRoot = realpathSync(profile.kb_root);
  const worktree = enclosingWorktree(resolvedRoot);

  if (profile.repository_admission.mode === "outside_worktree") {
    if (worktree !== undefined) {
      throw new ProfileRegistryError("outside-worktree profile resolves inside a Git worktree");
    }
    assertRootCustody(resolvedRoot, false);
  } else {
    const expectedWorktree = realpathSync(profile.repository_admission.worktree_root);
    const expectedScaffold = realpathSync(profile.repository_admission.scaffold_root);
    if (worktree !== expectedWorktree || resolvedRoot !== expectedScaffold) {
      throw new ProfileRegistryError("profile does not resolve to the exact allowlisted scaffold");
    }
    assertRootCustody(resolvedRoot, true);
    assertScaffoldGitBoundary(expectedWorktree, resolvedRoot);
    for (const liveDirectory of [".kb", "sources", "pages", "conflicts", "work"]) {
      const candidate = path.join(resolvedRoot, liveDirectory);
      if (existsSync(candidate) && (statSync(candidate).mode & 0o077) !== 0) {
        throw new ProfileRegistryError("profile live directories must be owner-only");
      }
    }
  }

  return { profile, resolvedRoot };
}

/**
 * Commit the complete normalized host registry entry without persisting its
 * absolute paths in orchestration state. Re-resolution of another root or
 * repository-admission mapping necessarily produces another digest.
 */
export function normalizedProfileCommitment(input: ResolvedProfile): Sha256Hex {
  const repositoryAdmission =
    input.profile.repository_admission.mode === "outside_worktree"
      ? { mode: "outside_worktree" as const }
      : {
          mode: "inside_allowlisted_scaffold" as const,
          worktree_root: realpathSync(input.profile.repository_admission.worktree_root),
          scaffold_root: realpathSync(input.profile.repository_admission.scaffold_root),
        };
  return sha256Hex(
    canonicalJson({
      schema_version: 1,
      kb_profile_id: input.profile.kb_profile_id,
      kb_root: input.resolvedRoot,
      ...(input.profile.expected_kb_id === undefined
        ? {}
        : { expected_kb_id: input.profile.expected_kb_id }),
      allow_create: input.profile.allow_create,
      repository_admission: repositoryAdmission,
    })
  );
}

/** Resolve one currently session-granted profile without accepting a model-selected path. */
export function resolveGrantedProfile(input: {
  profileId: string;
  sessionId: string;
  registryPath: string;
  grantStoreDir: string;
}): ResolvedProfile {
  if (!isValidProfileId(input.profileId)) {
    throw new ProfileRegistryError("profile id is invalid");
  }
  if (!isValidProfileId(input.sessionId)) {
    throw new ProfileRegistryError("host session identity is unavailable");
  }
  const grantStore = new KbSessionProfileGrantStore(input.grantStoreDir);
  let allowed: ReadonlySet<string>;
  try {
    allowed = grantStore.allowedProfiles(input.sessionId);
  } finally {
    grantStore.close();
  }
  if (!allowed.has(input.profileId)) {
    throw new ProfileRegistryError("profile is not granted to the active host session");
  }
  return resolveRegisteredProfile({
    profileId: input.profileId,
    registryPath: input.registryPath,
  });
}
