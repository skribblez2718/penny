/**
 * KB profile registry tests (G7, §5.1).
 */

import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findProfile,
  isValidProfileId,
  loadProfileRegistry,
  validateProfile,
  ProfileRegistryError,
} from "../src/kb/profile-registry.js";
import type { KbProfile, KbProfileRegistry } from "../src/kb/contracts.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-profile-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PROFILE: KbProfile = {
  schema_version: 1,
  kb_profile_id: "kbp_demo",
  kb_root: "/tmp/kb",
  allow_create: true,
  repository_admission: { mode: "outside_worktree" },
};

const REGISTRY: KbProfileRegistry = {
  schema_version: 1,
  profiles: [PROFILE],
};

describe("KB §5.1 profile registry", () => {
  it("loads and validates a correct registry", () => {
    const dir = tmp();
    const regPath = path.join(dir, "kb-profiles.json");
    writeFileSync(regPath, JSON.stringify(REGISTRY));
    const loaded = loadProfileRegistry(regPath);
    expect(loaded.profiles.length).toBe(1);
    expect(loaded.profiles[0].kb_profile_id).toBe("kbp_demo");
  });

  it("rejects a symlinked registry", () => {
    const dir = tmp();
    const real = path.join(dir, "real.json");
    const link = path.join(dir, "link.json");
    writeFileSync(real, JSON.stringify(REGISTRY));
    symlinkSync(real, link);
    expect(() => loadProfileRegistry(link)).toThrow(ProfileRegistryError);
  });

  it("rejects invalid JSON", () => {
    const dir = tmp();
    const regPath = path.join(dir, "kb-profiles.json");
    writeFileSync(regPath, "{not json");
    expect(() => loadProfileRegistry(regPath)).toThrow(ProfileRegistryError);
  });

  it("rejects a registry with an unknown key", () => {
    const dir = tmp();
    const regPath = path.join(dir, "kb-profiles.json");
    writeFileSync(regPath, JSON.stringify({ ...REGISTRY, rogue: true }));
    expect(() => loadProfileRegistry(regPath)).toThrow();
  });

  it("finds a profile by ID", () => {
    expect(findProfile(REGISTRY, "kbp_demo")?.kb_profile_id).toBe("kbp_demo");
    expect(findProfile(REGISTRY, "kbp_missing")).toBeUndefined();
  });

  it("validates profile IDs and rejects path-like values", () => {
    expect(isValidProfileId("kbp_demo")).toBe(true);
    expect(isValidProfileId("../etc/passwd")).toBe(false);
    expect(isValidProfileId("")).toBe(false);
    expect(isValidProfileId("kbp/with/slash")).toBe(false);
  });

  it("validates a single profile", () => {
    expect(() => validateProfile(PROFILE)).not.toThrow();
    expect(() => validateProfile({ ...PROFILE, allow_create: "yes" })).toThrow();
  });
});