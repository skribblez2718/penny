import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KbSessionProfileGrantStore } from "../src/kb/profile-grants.js";
import { resolveGrantedProfile } from "../src/kb/profile-registry.js";
import { installGrantedProfile } from "./fixtures/kb-profile-fixture.js";

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-kb-profile-grant-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function paths(projectRoot: string) {
  return {
    registryPath: path.join(projectRoot, ".penny", "kb-profiles.json"),
    grantStoreDir: path.join(projectRoot, ".penny", "kb-host-grants", "profile-grants"),
  };
}

describe("KB session profile authority", () => {
  it("requires registry membership and an unexpired grant for the exact active session", () => {
    const projectRoot = temp();
    const kbRoot = path.join(projectRoot, "private-kb");
    installGrantedProfile({
      projectRoot,
      kbRoot,
      profileId: "kbp_demo",
      sessionId: "sess_allowed",
    });
    expect(
      resolveGrantedProfile({
        profileId: "kbp_demo",
        sessionId: "sess_allowed",
        ...paths(projectRoot),
      }).resolvedRoot
    ).toBe(kbRoot);
    expect(() =>
      resolveGrantedProfile({
        profileId: "kbp_demo",
        sessionId: "sess_other",
        ...paths(projectRoot),
      })
    ).toThrow(/not granted/);
  });

  it("treats an expired grant as no authority", () => {
    const projectRoot = temp();
    const penny = path.join(projectRoot, ".penny");
    const kbRoot = path.join(projectRoot, "private-kb");
    mkdirSync(penny, { recursive: true, mode: 0o700 });
    mkdirSync(kbRoot, { mode: 0o700 });
    const registryPath = path.join(penny, "kb-profiles.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        schema_version: 1,
        profiles: [
          {
            schema_version: 1,
            kb_profile_id: "kbp_demo",
            kb_root: kbRoot,
            allow_create: true,
            repository_admission: { mode: "outside_worktree" },
          },
        ],
      }),
      { mode: 0o600 }
    );
    const grantStoreDir = paths(projectRoot).grantStoreDir;
    new KbSessionProfileGrantStore(grantStoreDir).mint({
      session_id: "sess_expired",
      allowed_kb_profile_ids: ["kbp_demo"],
      issued_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-01T01:00:00Z",
    });
    expect(() =>
      resolveGrantedProfile({
        profileId: "kbp_demo",
        sessionId: "sess_expired",
        registryPath,
        grantStoreDir,
      })
    ).toThrow(/not granted/);
  });

  it("rejects path-shaped profile and session identifiers before root resolution", () => {
    const projectRoot = temp();
    expect(() =>
      resolveGrantedProfile({
        profileId: "../private",
        sessionId: "sess_ok",
        ...paths(projectRoot),
      })
    ).toThrow(/profile id is invalid/);
    expect(() =>
      resolveGrantedProfile({
        profileId: "kbp_demo",
        sessionId: "../session",
        ...paths(projectRoot),
      })
    ).toThrow(/session identity/);
  });

  it("creates owner-only grant files and rejects a symlinked grant", () => {
    const projectRoot = temp();
    const store = new KbSessionProfileGrantStore(paths(projectRoot).grantStoreDir);
    const grant = store.mint({
      session_id: "sess_ok",
      allowed_kb_profile_ids: ["kbp_demo"],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      grant_id: "grant_ok",
    });
    const file = path.join(paths(projectRoot).grantStoreDir, `${grant.grant_id}.json`);
    expect(lstatSync(paths(projectRoot).grantStoreDir).mode & 0o077).toBe(0);
    expect(lstatSync(file).mode & 0o077).toBe(0);
    const link = path.join(paths(projectRoot).grantStoreDir, "grant_link.json");
    symlinkSync(file, link);
    expect(() => store.list()).toThrow(/regular, single-link/);
  });

  it("rejects broadened registry custody", () => {
    const projectRoot = temp();
    const kbRoot = path.join(projectRoot, "private-kb");
    installGrantedProfile({
      projectRoot,
      kbRoot,
      profileId: "kbp_demo",
      sessionId: "sess_allowed",
    });
    chmodSync(paths(projectRoot).registryPath, 0o644);
    expect(() =>
      resolveGrantedProfile({
        profileId: "kbp_demo",
        sessionId: "sess_allowed",
        ...paths(projectRoot),
      })
    ).toThrow(/owner-only/);
  });
});
