/**
 * KB profile registry tests (G7, §5.1).
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findProfile,
  isValidProfileId,
  loadProfileRegistry,
  normalizedProfileCommitment,
  resolveGrantedProfile,
  validateProfile,
  ProfileRegistryError,
} from "../src/kb/profile-registry.js";
import type { KbProfile, KbProfileRegistry } from "../src/kb/contracts.js";
import { KbSessionProfileGrantStore } from "../src/kb/profile-grants.js";

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
    writeFileSync(regPath, JSON.stringify(REGISTRY), { mode: 0o600 });
    chmodSync(regPath, 0o600);
    const loaded = loadProfileRegistry(regPath);
    expect(loaded.profiles.length).toBe(1);
    const profile = loaded.profiles[0];
    if (profile === undefined) throw new Error("validated registry has no profile");
    expect(profile.kb_profile_id).toBe("kbp_demo");
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

  it("rejects duplicate profile identities", () => {
    const dir = tmp();
    const regPath = path.join(dir, "kb-profiles.json");
    writeFileSync(regPath, JSON.stringify({ schema_version: 1, profiles: [PROFILE, PROFILE] }), {
      mode: 0o600,
    });
    expect(() => loadProfileRegistry(regPath)).toThrow(/duplicate profile id/);
  });

  it("commits the normalized registry profile/root and changes on remap", () => {
    const firstRoot = tmp();
    const secondRoot = tmp();
    const firstProfile: KbProfile = {
      ...PROFILE,
      kb_root: path.join(firstRoot, "..", path.basename(firstRoot)),
    };
    const normalized = normalizedProfileCommitment({
      profile: firstProfile,
      resolvedRoot: firstRoot,
    });
    expect(
      normalizedProfileCommitment({
        profile: { ...firstProfile, kb_root: firstRoot },
        resolvedRoot: firstRoot,
      })
    ).toBe(normalized);
    expect(
      normalizedProfileCommitment({
        profile: { ...firstProfile, kb_root: secondRoot },
        resolvedRoot: secondRoot,
      })
    ).not.toBe(normalized);
  });

  it("checks every existing scaffold entry, not only representative sample paths", () => {
    const repo = tmp();
    execFileSync("git", ["init", "-q", repo]);
    const scaffold = path.join(repo, "docs", "kb");
    mkdirSync(path.join(scaffold, "templates"), { recursive: true, mode: 0o755 });
    writeFileSync(
      path.join(scaffold, ".gitignore"),
      [
        "*",
        "!.gitignore",
        "!README.md",
        "!manifest.example.json",
        "!templates/",
        "!templates/**",
        "!misc/",
        "!misc/**",
        "",
      ].join("\n")
    );
    writeFileSync(path.join(scaffold, "README.md"), "scaffold\n");
    writeFileSync(path.join(scaffold, "manifest.example.json"), "{}\n");
    writeFileSync(path.join(scaffold, "templates", "page.md"), "page\n");
    writeFileSync(path.join(scaffold, "templates", "source.json"), "{}\n");
    execFileSync("git", [
      "-C",
      repo,
      "add",
      "docs/kb/.gitignore",
      "docs/kb/README.md",
      "docs/kb/manifest.example.json",
      "docs/kb/templates/page.md",
      "docs/kb/templates/source.json",
    ]);
    mkdirSync(path.join(scaffold, "misc"), { mode: 0o700 });
    writeFileSync(path.join(scaffold, "misc", "leak.txt"), "private", { mode: 0o600 });

    const penny = path.join(repo, ".penny");
    mkdirSync(penny, { mode: 0o700 });
    const registryPath = path.join(penny, "kb-profiles.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        schema_version: 1,
        profiles: [
          {
            schema_version: 1,
            kb_profile_id: "kbp_scaffold",
            kb_root: scaffold,
            allow_create: true,
            repository_admission: {
              mode: "inside_allowlisted_scaffold",
              worktree_root: repo,
              scaffold_root: scaffold,
            },
          },
        ],
      }),
      { mode: 0o600 }
    );
    const grantStoreDir = path.join(penny, "kb-host-grants");
    const grantStore = new KbSessionProfileGrantStore(grantStoreDir);
    grantStore.mint({
      session_id: "sess_scaffold",
      kb_profile_id: "kbp_scaffold",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    grantStore.close();
    expect(() =>
      resolveGrantedProfile({
        profileId: "kbp_scaffold",
        sessionId: "sess_scaffold",
        registryPath,
        grantStoreDir,
      })
    ).toThrow(/existing profile live path is not ignored/);
  });
});
