import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../dist/canonical-json.js";
import { HostOperationCapacityAuthority } from "../dist/host-operations/capacity-authority.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import { OwnerSqliteDatabase } from "../dist/state/owner-sqlite.js";
import { CATALOG_DATABASE_NAME, pennyStatePaths } from "../dist/state/paths.js";
import { upgradePennyCatalog } from "../dist/state/upgrade.js";
import { CapacityFixture } from "./helpers/capacity-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

function open(root: string): OwnerSqliteDatabase {
  return new OwnerSqliteDatabase({
    directory: root,
    databaseName: CATALOG_DATABASE_NAME,
    label: "capacity migration fixture",
    mode: "existing",
  });
}
function downgrade(f: CapacityFixture, version: 2 | 3): void {
  using db = open(f.stateRoot);
  db.db.exec(
    "DROP TABLE host_capacity_snapshots; DROP TABLE host_capacity_records; DROP TABLE host_capacity_policy;"
  );
  if (version === 2)
    db.db.exec(
      "DROP TABLE host_backend_quarantine_resets; DROP TABLE host_backend_dispositions; DROP TABLE host_backend_lease_events; DROP TABLE host_backend_leases; DROP TABLE host_operation_queue;"
    );
  db.db.exec(`PRAGMA user_version=${version}`);
}
function version(root: string): number | bigint | string | Uint8Array | null | undefined {
  using db = open(root);
  return db.db.prepare("PRAGMA user_version").get()?.user_version;
}
function rows(root: string): unknown {
  using db = open(root);
  return {
    projects: db.db.prepare("SELECT * FROM projects ORDER BY project_id").all(),
    leases: db.db.prepare("SELECT * FROM host_backend_leases ORDER BY backend_key_sha256").all(),
    queue: db.db.prepare("SELECT * FROM host_operation_queue ORDER BY operation_record_id").all(),
  };
}

describe("backup-first global catalog capacity migration", () => {
  it("refuses a concurrent administrative catalog lock without producing a backup", async () => {
    using f = new CapacityFixture();
    downgrade(f, 3);
    const locks = pennyStatePaths(f.stateRoot).locks;
    mkdirSync(locks, { mode: 0o700 });
    const suffix = sha256("global-catalog").slice(0, 24);
    writeFileSync(path.join(locks, `upgrade-${suffix}.lock`), "held\n", { mode: 0o600 });
    const backups = path.join(f.root, "blocked-backups");
    await expect(
      upgradePennyCatalog({ stateRoot: f.stateRoot, backupDirectory: backups })
    ).rejects.toThrow("locked by another operator");
    expect(version(f.stateRoot)).toBe(3);
  });
  it("fails startup when capacity table constraints or the required index drift", () => {
    using f = new CapacityFixture();
    using db = open(f.stateRoot);
    db.db.exec("DROP INDEX idx_host_capacity_project");
    expect(() => new ProjectCatalog(f.stateRoot, { create: false })).toThrow(
      "index schema diverges"
    );
    db.db.exec(
      "CREATE INDEX idx_host_capacity_project ON host_capacity_records(project_id, state); DROP TABLE host_capacity_snapshots; CREATE TABLE host_capacity_snapshots (operation_record_id TEXT NOT NULL, source_revision INTEGER NOT NULL, snapshot_jcs TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL, PRIMARY KEY(operation_record_id, source_revision)) STRICT;"
    );
    expect(() => new ProjectCatalog(f.stateRoot, { create: false })).toThrow("schema diverges");
  });
  it("preserves the verified backup after a post-commit fault and makes a repeated upgrade a no-op", async () => {
    using f = new CapacityFixture();
    downgrade(f, 3);
    const backupDirectory = path.join(f.root, "committed-backups");
    await expect(
      upgradePennyCatalog({
        stateRoot: f.stateRoot,
        backupDirectory,
        faultInjector(point) {
          if (point === "catalog-schema-committed") throw new Error("post-commit fixture fault");
        },
      })
    ).rejects.toThrow("post-commit");
    expect(version(f.stateRoot)).toBe(4);
    const root = path.join(
      backupDirectory,
      requireValue(readdirSync(backupDirectory)[0], "committed backup root")
    );
    ProjectCatalog.verifyCapacityUpgradeBackup(root, "catalog-before-capacity-upgrade.db");
    expect((await upgradePennyCatalog({ stateRoot: f.stateRoot, backupDirectory })).changed).toBe(
      false
    );
    expect(readdirSync(backupDirectory)).toHaveLength(1);
  });
  it("refuses old runtime/setup without mutation and preserves exact legacy lease/queue bytes during explicit v3 upgrade", async () => {
    using f = new CapacityFixture();
    f.operation("retained-operation");
    f.operation("retained-image-waiter", "image-a", 1);
    downgrade(f, 3);
    const before = rows(f.stateRoot);
    expect(() => new ProjectCatalog(f.stateRoot, { create: false })).toThrow("backup-first");
    expect(() => new ProjectCatalog(f.stateRoot, { create: true })).toThrow("backup-first");
    expect(() => new HostOperationLeaseAuthority(f.stateRoot)).toThrow("schema 4");
    expect(version(f.stateRoot)).toBe(3);
    const backupDirectory = path.join(f.root, "catalog-backups");
    const upgraded = await upgradePennyCatalog({
      stateRoot: f.stateRoot,
      backupDirectory,
      faultInjector(point) {
        if (point === "before-capacity-ddl") expect(version(f.stateRoot)).toBe(3);
      },
    });
    expect(upgraded).toMatchObject({ sourceVersion: 3, targetVersion: 4, changed: true });
    const backup = requireValue(upgraded.backupDatabase, "backup database");
    expect(sha256(readFileSync(backup))).toBe(upgraded.backupSha256);
    ProjectCatalog.verifyCapacityUpgradeBackup(path.dirname(backup), path.basename(backup));
    expect(rows(f.stateRoot)).toEqual(before);
    using db = open(f.stateRoot);
    expect(db.db.prepare("SELECT count(*) AS n FROM host_capacity_policy").get()?.n).toBe(0);
    expect(() => f.core()).toThrow("durable policy absent");
    using catalog = new ProjectCatalog(f.stateRoot, { create: false });
    expect(catalog.projectById(requireValue(f.projects[0], "project").projectId)).toBeDefined();
    const repeat = await upgradePennyCatalog({ stateRoot: f.stateRoot, backupDirectory });
    expect(repeat).toMatchObject({ changed: false, backupDatabase: null });
    expect(readdirSync(backupDirectory)).toHaveLength(1);
  });
  it("backs up catalog v2 before adding lease and capacity tables in one transaction", async () => {
    using f = new CapacityFixture();
    downgrade(f, 2);
    const upgraded = await upgradePennyCatalog({
      stateRoot: f.stateRoot,
      backupDirectory: path.join(f.root, "v2-backups"),
    });
    expect(upgraded).toMatchObject({ sourceVersion: 2, targetVersion: 4, changed: true });
    const backup = requireValue(upgraded.backupDatabase, "v2 backup");
    ProjectCatalog.verifyCapacityUpgradeBackup(path.dirname(backup), path.basename(backup));
    expect(version(f.stateRoot)).toBe(4);
  });
  it.each(["catalog-backup-created", "before-capacity-ddl", "after-capacity-ddl"] as const)(
    "keeps a verified backup and rolls back on %s",
    async (point) => {
      using f = new CapacityFixture();
      f.operation(`rollback-${point}`);
      downgrade(f, 3);
      const before = rows(f.stateRoot);
      const backupDirectory = path.join(f.root, "fault-backups");
      await expect(
        upgradePennyCatalog({
          stateRoot: f.stateRoot,
          backupDirectory,
          faultInjector(actual) {
            if (actual === point) throw new Error(`injected ${point}`);
          },
        })
      ).rejects.toThrow("injected");
      expect(version(f.stateRoot)).toBe(3);
      expect(rows(f.stateRoot)).toEqual(before);
      const root = path.join(
        backupDirectory,
        requireValue(readdirSync(backupDirectory)[0], "backup root")
      );
      ProjectCatalog.verifyCapacityUpgradeBackup(root, "catalog-before-capacity-upgrade.db");
      using db = open(f.stateRoot);
      expect(
        db.db.prepare("SELECT name FROM sqlite_master WHERE name='host_capacity_records'").get()
      ).toBeUndefined();
    }
  );
  it("restores the caller-specified verified backup to a separate temporary store and upgrades it without guessing records", async () => {
    using f = new CapacityFixture();
    f.operation("recovery-operation");
    downgrade(f, 3);
    const before = rows(f.stateRoot);
    const result = await upgradePennyCatalog({
      stateRoot: f.stateRoot,
      backupDirectory: path.join(f.root, "backups"),
    });
    const backup = requireValue(result.backupDatabase, "recovery backup");
    const recoveryRoot = path.join(f.root, "recovery-state");
    mkdirSync(recoveryRoot, { mode: 0o700 });
    copyFileSync(backup, pennyStatePaths(recoveryRoot).catalogDatabase);
    chmodSync(pennyStatePaths(recoveryRoot).catalogDatabase, 0o600);
    expect(sha256(readFileSync(pennyStatePaths(recoveryRoot).catalogDatabase))).toBe(
      result.backupSha256
    );
    expect(rows(recoveryRoot)).toEqual(before);
    await upgradePennyCatalog({
      stateRoot: recoveryRoot,
      backupDirectory: path.join(f.root, "recovery-backups"),
    });
    expect(rows(recoveryRoot)).toEqual(before);
    using db = open(recoveryRoot);
    expect(db.db.prepare("SELECT count(*) AS n FROM host_capacity_records").get()?.n).toBe(0);
  });
  it("refuses unsupported versions, malformed catalogs and backup overlap before DDL", async () => {
    using f = new CapacityFixture();
    downgrade(f, 3);
    await expect(
      upgradePennyCatalog({ stateRoot: f.stateRoot, backupDirectory: f.stateRoot })
    ).rejects.toThrow("outside state root");
    {
      using db = open(f.stateRoot);
      db.db.exec("PRAGMA user_version=99");
    }
    await expect(
      upgradePennyCatalog({
        stateRoot: f.stateRoot,
        backupDirectory: path.join(f.root, "bad-backups"),
      })
    ).rejects.toThrow("exact catalog schema");
    {
      using db = open(f.stateRoot);
      db.db.exec(
        "PRAGMA user_version=3; ALTER TABLE host_operation_queue RENAME COLUMN operation_id TO broken;"
      );
    }
    await expect(
      upgradePennyCatalog({
        stateRoot: f.stateRoot,
        backupDirectory: path.join(f.root, "bad-backups"),
      })
    ).rejects.toThrow("missing column");
    expect(version(f.stateRoot)).toBe(3);
  });
  it("never provisions absent capacity tables or policy from the ordinary core", () => {
    using f = new CapacityFixture();
    downgrade(f, 3);
    expect(
      () =>
        new HostOperationCapacityAuthority({
          stateRoot: f.stateRoot,
          policy: f.policy,
          projects: f.projects.map((x) => x.authority),
        })
    ).toThrow("backup-first");
    expect(version(f.stateRoot)).toBe(3);
  });
});
