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
import { crashAuthorityTransaction, runAuthorityRace } from "./fixtures/authority-race-harness.js";

const PROFILE = "kbp_demo";
const SESSION = "sess_allowed";
const REQUEST_SHA = "a".repeat(64);
const POLICY_SHA = "b".repeat(64);
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
    grantStoreDir: path.join(projectRoot, ".penny", "kb-host-grants"),
  };
}

function database(pathname: string): import("node:sqlite").DatabaseSync {
  const module = process.getBuiltinModule("node:" + "sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (module === undefined) throw new Error("node:sqlite is unavailable");
  return new module.DatabaseSync(pathname);
}

function consumeInput(overrides: Record<string, unknown> = {}) {
  return {
    session_id: SESSION,
    invocation_id: "call-profile-exact",
    kb_profile_id: PROFILE,
    action: "query" as const,
    request_sha256: REQUEST_SHA,
    policy_sha256: POLICY_SHA,
    ...overrides,
  };
}

function mintActive(store: KbSessionProfileGrantStore, grantId = "kpg-active") {
  return store.mint({
    session_id: SESSION,
    kb_profile_id: PROFILE,
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    grant_id: grantId,
  });
}

describe("KB session/profile SQLite authority", () => {
  it("requires exact registry membership and an unexpired grant for the active session", () => {
    const projectRoot = temp();
    const kbRoot = path.join(projectRoot, "private-kb");
    installGrantedProfile({
      projectRoot,
      kbRoot,
      profileId: PROFILE,
      sessionId: SESSION,
    });
    expect(
      resolveGrantedProfile({ profileId: PROFILE, sessionId: SESSION, ...paths(projectRoot) })
        .resolvedRoot
    ).toBe(kbRoot);
    expect(() =>
      resolveGrantedProfile({
        profileId: PROFILE,
        sessionId: "sess_other",
        ...paths(projectRoot),
      })
    ).toThrow(/not granted/);
  });

  it("issues one exact active session/profile grant and makes only byte-identical retry idempotent", async () => {
    const root = path.join(temp(), ".penny", "kb-host-grants");
    const issuedAt = new Date(Date.now() - 1_000).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const exact = {
      session_id: SESSION,
      kb_profile_id: PROFILE,
      issued_at: issuedAt,
      expires_at: expiresAt,
      grant_id: "kpg-exact-retry",
    };
    const store = new KbSessionProfileGrantStore(root);
    store.mint(exact);
    store.close();

    const exactRetries = await runAuthorityRace([
      { operation: "profile-mint", storeDir: root, input: exact },
      { operation: "profile-mint", storeDir: root, input: exact },
    ]);
    expect(exactRetries.every((result) => result.ok === true)).toBe(true);

    const competitors = await runAuthorityRace([
      {
        operation: "profile-mint",
        storeDir: root,
        input: { ...exact, grant_id: "kpg-competing-a" },
      },
      {
        operation: "profile-mint",
        storeDir: root,
        input: { ...exact, grant_id: "kpg-competing-b" },
      },
    ]);
    expect(competitors.every((result) => result.ok === false)).toBe(true);
  });

  it("synchronizes exact reads/consumes and rejects a competing invocation binding", async () => {
    const root = path.join(temp(), ".penny", "kb-host-grants");
    const store = new KbSessionProfileGrantStore(root);
    mintActive(store);
    store.close();

    const reads = await runAuthorityRace([
      {
        operation: "profile-read",
        storeDir: root,
        input: { sessionId: SESSION, profileId: PROFILE },
      },
      {
        operation: "profile-read",
        storeDir: root,
        input: { sessionId: SESSION, profileId: PROFILE },
      },
    ]);
    expect(reads.every((result) => result.ok === true)).toBe(true);

    const exact = await runAuthorityRace([
      { operation: "profile-consume", storeDir: root, input: consumeInput() },
      { operation: "profile-consume", storeDir: root, input: consumeInput() },
    ]);
    expect(exact.every((result) => result.ok === true)).toBe(true);

    const competingRoot = path.join(temp(), ".penny", "kb-host-grants");
    const competingStore = new KbSessionProfileGrantStore(competingRoot);
    mintActive(competingStore, "kpg-competing-use");
    competingStore.close();
    const competing = await runAuthorityRace([
      { operation: "profile-consume", storeDir: competingRoot, input: consumeInput() },
      {
        operation: "profile-consume",
        storeDir: competingRoot,
        input: consumeInput({ policy_sha256: "c".repeat(64) }),
      },
    ]);
    expect(competing.filter((result) => result.ok === true)).toHaveLength(1);
    expect(competing.filter((result) => result.ok === false)).toHaveLength(1);
  });

  it("revokes and expires by exact transactional CAS without re-authorizing", async () => {
    const revokeRoot = path.join(temp(), ".penny", "kb-host-grants");
    const revokeStore = new KbSessionProfileGrantStore(revokeRoot);
    mintActive(revokeStore, "kpg-revoke");
    expect(revokeStore.revoke("kpg-revoke").record.state).toBe("revoked");
    expect(revokeStore.revoke("kpg-revoke").record.state).toBe("revoked");
    expect(revokeStore.allowedProfiles(SESSION)).not.toContain(PROFILE);
    revokeStore.close();

    const expiryRoot = path.join(temp(), ".penny", "kb-host-grants");
    const expiryStore = new KbSessionProfileGrantStore(expiryRoot);
    expiryStore.mint({
      session_id: SESSION,
      kb_profile_id: PROFILE,
      issued_at: new Date(Date.now() - 120_000).toISOString(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      grant_id: "kpg-expire",
    });
    expiryStore.close();
    const now = new Date().toISOString();
    const results = await runAuthorityRace([
      {
        operation: "profile-expire",
        storeDir: expiryRoot,
        input: { grantId: "kpg-expire", now },
      },
      {
        operation: "profile-expire",
        storeDir: expiryRoot,
        input: { grantId: "kpg-expire", now },
      },
    ]);
    expect(results.every((result) => result.ok === true)).toBe(true);
    const reopened = new KbSessionProfileGrantStore(expiryRoot);
    expect(reopened.load("kpg-expire").record.state).toBe("expired");
    expect(reopened.allowedProfiles(SESSION)).not.toContain(PROFILE);
    reopened.close();
  });

  it("rolls back an uncommitted use and preserves committed bindings across restart", async () => {
    const root = path.join(temp(), ".penny", "kb-host-grants");
    const store = new KbSessionProfileGrantStore(root);
    mintActive(store, "kpg-restart");
    store.close();

    await crashAuthorityTransaction({
      operation: "profile-crash-uncommitted",
      storeDir: root,
      input: consumeInput({ grantId: "kpg-restart" }),
    });
    const reopened = new KbSessionProfileGrantStore(root);
    expect(reopened.useForInvocation(SESSION, "call-profile-exact")).toBeUndefined();
    const consumed = reopened.consume(consumeInput());
    reopened.close();

    const restarted = new KbSessionProfileGrantStore(root);
    expect(restarted.useForInvocation(SESSION, "call-profile-exact")).toEqual(consumed);
    expect(restarted.consume(consumeInput())).toEqual(consumed);
    restarted.close();
  });

  it("detects logical tamper and refuses unsafe legacy fragments instead of scanning them", () => {
    const root = path.join(temp(), ".penny", "kb-host-grants");
    const store = new KbSessionProfileGrantStore(root);
    mintActive(store, "kpg-tamper");
    const db = database(path.join(root, "grants.sqlite"));
    db.prepare("UPDATE profile_session_grants SET kb_profile_id = ? WHERE grant_id = ?").run(
      "kbp_tampered",
      "kpg-tamper"
    );
    db.close();
    expect(() => store.load("kpg-tamper")).toThrow(/disagree|digest mismatch/);
    store.close();

    const legacyRoot = path.join(temp(), ".penny", "kb-host-grants");
    const legacyStore = new KbSessionProfileGrantStore(legacyRoot);
    mkdirSync(path.join(legacyRoot, "profile-grants"), { mode: 0o700 });
    expect(() => legacyStore.allowedProfiles(SESSION)).toThrow(/scan\/adoption is forbidden/);
    legacyStore.close();
  });

  it("keeps the shared WAL authority owner-only and rejects symlinks/broadened custody", () => {
    const root = path.join(temp(), ".penny", "kb-host-grants");
    const store = new KbSessionProfileGrantStore(root);
    mintActive(store, "kpg-modes");
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = path.join(root, `grants.sqlite${suffix}`);
      try {
        expect(lstatSync(file).mode & 0o777).toBe(0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    store.close();

    const symlinkRoot = path.join(temp(), "hostile");
    mkdirSync(symlinkRoot, { mode: 0o700 });
    const target = path.join(temp(), "target.sqlite");
    writeFileSync(target, "not sqlite", { mode: 0o600 });
    symlinkSync(target, path.join(symlinkRoot, "grants.sqlite"));
    expect(() => new KbSessionProfileGrantStore(symlinkRoot)).toThrow(/non-symlink|regular/);

    const broad = path.join(temp(), "broad");
    mkdirSync(broad, { mode: 0o700 });
    chmodSync(broad, 0o775);
    expect(() => new KbSessionProfileGrantStore(broad)).toThrow(/exactly 0700/);
  });

  it("rejects impossible timestamps and path-shaped identities before registry resolution", () => {
    const projectRoot = temp();
    const store = new KbSessionProfileGrantStore(paths(projectRoot).grantStoreDir);
    expect(() =>
      store.mint({
        session_id: "sess_bad_time",
        kb_profile_id: PROFILE,
        issued_at: "2026-99-99T00:00:00Z",
        expires_at: "2027-99-99T00:00:00Z",
      })
    ).toThrow(/real UTC instant/);
    store.close();

    expect(() =>
      resolveGrantedProfile({
        profileId: "../private",
        sessionId: "sess_ok",
        ...paths(projectRoot),
      })
    ).toThrow(/profile id is invalid/);
    expect(() =>
      resolveGrantedProfile({
        profileId: PROFILE,
        sessionId: "../session",
        ...paths(projectRoot),
      })
    ).toThrow(/session identity/);
  });

  it("still rejects broadened profile-registry custody", () => {
    const projectRoot = temp();
    const kbRoot = path.join(projectRoot, "private-kb");
    installGrantedProfile({ projectRoot, kbRoot, profileId: PROFILE, sessionId: SESSION });
    chmodSync(paths(projectRoot).registryPath, 0o644);
    expect(() =>
      resolveGrantedProfile({ profileId: PROFILE, sessionId: SESSION, ...paths(projectRoot) })
    ).toThrow(/owner-only/);
  });
});
