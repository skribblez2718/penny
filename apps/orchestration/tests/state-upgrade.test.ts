import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer } from "../src/checkpointer.js";
import { initializePennyState, resolvePennyRuntimeState } from "../src/state/setup.js";
import { upgradePennyState } from "../src/state/upgrade.js";
import { parseJson, requireNumber, requireRecord, requireSqlite } from "./helpers/narrowing.js";

const roots: string[] = [];

function sandbox(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `penny-state-upgrade-${label}-`));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(label: string) {
  const root = sandbox(label);
  const projectRoot = path.join(root, "project");
  const stateRoot = path.join(root, "state");
  const backupParent = path.join(root, "backups");
  mkdirSync(projectRoot, { mode: 0o700 });
  mkdirSync(backupParent, { mode: 0o700 });
  const env = { PENNY_STATE_ROOT: stateRoot };
  const state = initializePennyState(projectRoot, { env });
  return { root, projectRoot, backupParent, env, state };
}

function database(file: string): import("node:sqlite").DatabaseSync {
  const sqlite = requireSqlite(
    process.getBuiltinModule("node:sqlite"),
    "state-upgrade test SQLite runtime"
  );
  return new sqlite.DatabaseSync(file);
}

function userVersion(file: string): number {
  using db = database(file);
  const row = requireRecord(db.prepare("PRAGMA user_version").get(), "user-version row");
  return requireNumber(row["user_version"], "user-version value");
}

function downgradeToV10(file: string): void {
  using db = database(file);
  db.exec(`
    PRAGMA wal_autocheckpoint=0;
    INSERT INTO runs(
      run_id, session_id, playbook, engine_owner, schema_version, status,
      state_id, context_json, created_at, updated_at
    ) VALUES(
      'retained-run', 'retained-session', 'research', 'typescript', 2, 'running',
      'observing', '{"goal":"retained"}', 't0', 't1'
    );
    DROP TABLE child_workflow_calls;
    PRAGMA user_version=10;
  `);
}

function retainedRunCount(file: string): number {
  using db = database(file);
  const row = requireRecord(
    db.prepare("SELECT COUNT(*) AS count FROM runs WHERE run_id='retained-run'").get(),
    "retained run count"
  );
  return requireNumber(row["count"], "retained run count");
}

function persistRetainedArtifact(
  artifactRoot: string,
  projectId: string
): { readonly artifactId: string; readonly bytes: Buffer } {
  const bytes = Buffer.from("retained artifact bytes\n雪", "utf8");
  using store = ArtifactStore.openExisting(artifactRoot, { projectId });
  const ref = store.persist({
    metadata: {
      schema_version: 2,
      run_id: "retained-run",
      phase: "observing",
      branch_id: null,
      kind: "agent-output",
      operation_id: "retained-output",
      version: 1,
      producer: "agent:echo",
      media_type: "text/plain; charset=utf-8",
      parent_ref: null,
      upstream_refs: [],
    },
    content: bytes,
  });
  return { artifactId: ref.artifact_id, bytes };
}

describe("active-project state upgrade", () => {
  it("backs up and upgrades populated v10 state while retaining artifacts and identities", async () => {
    const { projectRoot, backupParent, env, state } = fixture("success");
    const retained = persistRetainedArtifact(state.paths.artifacts.root, state.projectId);
    const receiptKeySha256 = createHash("sha256")
      .update(readFileSync(state.paths.orchestration.receiptKey))
      .digest("hex");
    downgradeToV10(state.paths.orchestration.database);

    expect(() => resolvePennyRuntimeState(projectRoot, { env })).toThrow(
      "schema 10 is not current"
    );
    const result = await upgradePennyState({
      projectRoot,
      backupDirectory: backupParent,
      rootOptions: { env },
    });

    expect(result).toMatchObject({
      projectId: state.projectId,
      sourceVersion: 10,
      targetVersion: 12,
      changed: true,
    });
    expect(result.backupRoot).not.toBeNull();
    expect(result.backupDatabase).not.toBeNull();
    if (result.backupRoot === null || result.backupDatabase === null) {
      throw new Error("upgrade omitted its verified backup");
    }
    expect(userVersion(result.backupDatabase)).toBe(10);
    expect(
      Checkpointer.inspectExistingSchema(result.backupDatabase, state.projectId)
    ).toMatchObject({
      actualVersion: 10,
      upgradeRequired: true,
      upgradeSupported: true,
    });
    const backupManifest = parseJson(
      readFileSync(path.join(result.backupRoot, "upgrade-backup.json"), "utf8")
    );
    expect(backupManifest).toMatchObject({
      schema_version: 1,
      phase: "upgraded",
      project_id: state.projectId,
      source_schema_version: 10,
      target_schema_version: 12,
      database_file: "orchestration-before-upgrade.db",
    });
    expect(requireRecord(backupManifest, "upgrade backup manifest")["database_sha256"]).toBe(
      createHash("sha256").update(readFileSync(result.backupDatabase)).digest("hex")
    );

    const recoveryCopy = path.join(result.backupRoot, "recovery-check.db");
    copyFileSync(result.backupDatabase, recoveryCopy);
    chmodSync(recoveryCopy, 0o600);
    expect(retainedRunCount(recoveryCopy)).toBe(1);
    await Checkpointer.upgradeExisting(recoveryCopy, state.projectId, async () => undefined);
    expect(userVersion(recoveryCopy)).toBe(12);
    expect(retainedRunCount(recoveryCopy)).toBe(1);
    using recoveredCheckpointer = new Checkpointer(recoveryCopy, undefined, {
      projectId: state.projectId,
    });
    expect(recoveredCheckpointer).toBeDefined();

    expect(resolvePennyRuntimeState(projectRoot, { env }).projectId).toBe(state.projectId);
    expect(retainedRunCount(state.paths.orchestration.database)).toBe(1);
    using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    expect(artifacts.readById(retained.artifactId)).toEqual(retained.bytes);
    expect(
      createHash("sha256").update(readFileSync(state.paths.orchestration.receiptKey)).digest("hex")
    ).toBe(receiptKeySha256);

    const backupCount = readdirSync(backupParent).length;
    const repeated = await upgradePennyState({
      projectRoot,
      backupDirectory: backupParent,
      rootOptions: { env },
    });
    expect(repeated).toMatchObject({ changed: false, sourceVersion: 12, targetVersion: 12 });
    expect(repeated.backupRoot).toBeNull();
    expect(readdirSync(backupParent)).toHaveLength(backupCount);
  });

  it("retains a verified backup and rolls back schema v10 after a mid-upgrade failure", async () => {
    const { projectRoot, backupParent, env, state } = fixture("failure");
    downgradeToV10(state.paths.orchestration.database);

    await expect(
      upgradePennyState({
        projectRoot,
        backupDirectory: backupParent,
        rootOptions: { env },
        faultInjector(point) {
          if (point === "after-v11-migration") throw new Error("synthetic mid-upgrade failure");
        },
      })
    ).rejects.toThrow("synthetic mid-upgrade failure");

    expect(userVersion(state.paths.orchestration.database)).toBe(10);
    expect(retainedRunCount(state.paths.orchestration.database)).toBe(1);
    const [backupName] = readdirSync(backupParent);
    expect(backupName).toBeDefined();
    if (backupName === undefined) throw new Error("failed upgrade omitted its backup");
    const backupRoot = path.join(backupParent, backupName);
    const backupDatabase = path.join(backupRoot, "orchestration-before-upgrade.db");
    expect(existsSync(backupDatabase)).toBe(true);
    expect(userVersion(backupDatabase)).toBe(10);
    expect(
      parseJson(readFileSync(path.join(backupRoot, "upgrade-backup.json"), "utf8"))
    ).toMatchObject({
      phase: "prepared",
      source_schema_version: 10,
      target_schema_version: 12,
    });
  });

  it("refuses a concurrent administrative upgrade lock without creating a backup", async () => {
    const { projectRoot, backupParent, env, state } = fixture("locked");
    downgradeToV10(state.paths.orchestration.database);
    const lockSuffix = createHash("sha256")
      .update(state.projectId, "utf8")
      .digest("hex")
      .slice(0, 24);
    const lock = path.join(state.state.locks, `upgrade-${lockSuffix}.lock`);
    writeFileSync(lock, "held\n", { mode: 0o600 });

    await expect(
      upgradePennyState({
        projectRoot,
        backupDirectory: backupParent,
        rootOptions: { env },
      })
    ).rejects.toThrow("state upgrade is locked by another operator process");
    expect(userVersion(state.paths.orchestration.database)).toBe(10);
    expect(readdirSync(backupParent)).toEqual([]);
  });

  it("rejects backup overlap before creating a destination", async () => {
    const { projectRoot, env, state } = fixture("overlap");
    downgradeToV10(state.paths.orchestration.database);
    await expect(
      upgradePennyState({
        projectRoot,
        backupDirectory: path.join(projectRoot, "backup"),
        rootOptions: { env },
      })
    ).rejects.toThrow("must not overlap");
    expect(existsSync(path.join(projectRoot, "backup"))).toBe(false);
    expect(userVersion(state.paths.orchestration.database)).toBe(10);
  });
});
