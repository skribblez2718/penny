import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeStateCommand } from "../src/state/index.js";
import {
  initializePennyState,
  resolvePennyRuntimeState,
  resolvePennyStateStatus,
} from "../src/state/setup.js";

const roots: string[] = [];

interface DatabaseSyncBoundary extends Disposable {
  exec(sql: string): void;
}

interface SqliteRuntimeBoundary {
  readonly DatabaseSync: new (path: string) => DatabaseSyncBoundary;
}

function isSqliteRuntimeBoundary(value: unknown): value is SqliteRuntimeBoundary {
  return (
    value !== null &&
    typeof value === "object" &&
    "DatabaseSync" in value &&
    typeof value.DatabaseSync === "function"
  );
}

function openDatabase(path: string): DatabaseSyncBoundary {
  const runtime: unknown = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteRuntimeBoundary(runtime)) throw new Error("node:sqlite is unavailable");
  return new runtime.DatabaseSync(path);
}

function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-state-command-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface StateTreeEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "other";
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly nlink: number;
  readonly size: number;
  readonly atimeMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly sha256: string | undefined;
}

/** Capture contents and filesystem metadata after each entry's own read. */
function stateTreeSnapshot(root: string): StateTreeEntry[] {
  const entries: StateTreeEntry[] = [];
  const visit = (candidate: string): void => {
    for (const name of readdirSync(candidate).sort((left, right) => left.localeCompare(right))) {
      const child = path.join(candidate, name);
      const initial = lstatSync(child);
      if (initial.isDirectory() && !initial.isSymbolicLink()) visit(child);
      const bytes = initial.isFile() && !initial.isSymbolicLink() ? readFileSync(child) : undefined;
      const stat = lstatSync(child);
      entries.push({
        path: path.relative(root, child),
        kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
        nlink: stat.nlink,
        size: stat.size,
        atimeMs: stat.atimeMs,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        birthtimeMs: stat.birthtimeMs,
        sha256: bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  visit(root);
  const rootStat = lstatSync(root);
  entries.push({
    path: ".",
    kind: "directory",
    dev: rootStat.dev,
    ino: rootStat.ino,
    mode: rootStat.mode,
    uid: rootStat.uid,
    gid: rootStat.gid,
    nlink: rootStat.nlink,
    size: rootStat.size,
    atimeMs: rootStat.atimeMs,
    mtimeMs: rootStat.mtimeMs,
    ctimeMs: rootStat.ctimeMs,
    birthtimeMs: rootStat.birthtimeMs,
    sha256: undefined,
  });
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

describe("penny-state command", () => {
  it("requires an explicit absolute project root", async () => {
    await expect(executeStateCommand(["init"], {})).rejects.toThrow(
      "--project-root=PATH is required"
    );
    await expect(executeStateCommand(["init", "--project-root=relative"], {})).rejects.toThrow(
      "must be an absolute path"
    );
  });

  it("initializes and reports canonical stable paths", async () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };

    const initialized = await executeStateCommand(["init", `--project-root=${projectRoot}`], env);
    const status = await executeStateCommand(["status", `--project-root=${projectRoot}`], env);

    if (initialized.action !== "init") throw new Error("state init returned an unexpected result");
    if (status.action !== "status") throw new Error("state status returned an unexpected result");
    expect(status.project_id).toBe(initialized.project_id);
    expect(path.basename(status.orchestration_database)).toBe("orchestration.db");
    expect(path.basename(status.artifact_manifest_database)).toBe("manifest.db");
    const requiredFiles = [
      status.orchestration_database,
      status.orchestration_receipt_key,
      status.artifact_manifest_database,
      path.join(status.state_root, "observability", "observability.db"),
    ];
    for (const file of requiredFiles) {
      expect(existsSync(file)).toBe(true);
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses incomplete runtime state without recreating a missing store", async () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };
    const initialized = await executeStateCommand(["init", `--project-root=${projectRoot}`], env);
    if (initialized.action !== "init") throw new Error("state init returned an unexpected result");

    rmSync(initialized.orchestration_database, { force: true });
    rmSync(`${initialized.orchestration_database}-wal`, { force: true });
    rmSync(`${initialized.orchestration_database}-shm`, { force: true });

    await expect(
      executeStateCommand(["status", `--project-root=${projectRoot}`], env)
    ).rejects.toThrow("STATE_COMPONENT_UNINITIALIZED");
    expect(existsSync(initialized.orchestration_database)).toBe(false);
  });

  it("does not repair an incomplete active partition during repeated init", async () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };
    const initialized = await executeStateCommand(["init", `--project-root=${projectRoot}`], env);
    if (initialized.action !== "init") throw new Error("state init returned an unexpected result");

    rmSync(initialized.orchestration_database, { force: true });
    await expect(
      executeStateCommand(["init", `--project-root=${projectRoot}`], env)
    ).rejects.toThrow("STATE_COMPONENT_UNINITIALIZED");
    expect(existsSync(initialized.orchestration_database)).toBe(false);
  });

  it("refuses a symlinked retained store without mutating its target", async () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };
    const initialized = await executeStateCommand(["init", `--project-root=${projectRoot}`], env);
    if (initialized.action !== "init") throw new Error("state init returned an unexpected result");

    const observabilityDatabase = path.join(
      initialized.state_root,
      "observability",
      "observability.db"
    );
    const victim = path.join(root, "victim.db");
    writeFileSync(victim, "do-not-touch", { mode: 0o644 });
    chmodSync(victim, 0o644);
    rmSync(observabilityDatabase, { force: true });
    symlinkSync(victim, observabilityDatabase);

    await expect(
      executeStateCommand(["init", `--project-root=${projectRoot}`], env)
    ).rejects.toThrow("STATE_COMPONENT_UNINITIALIZED");
    expect(lstatSync(victim).mode & 0o777).toBe(0o644);
  });

  it("rejects a current-version control database with an incompatible required table", async () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };
    const initialized = await executeStateCommand(["init", `--project-root=${projectRoot}`], env);
    if (initialized.action !== "init") throw new Error("state init returned an unexpected result");

    {
      using database = openDatabase(initialized.orchestration_database);
      database.exec(`
        PRAGMA foreign_keys=OFF;
        DROP TABLE runs;
        CREATE TABLE runs(run_key TEXT PRIMARY KEY);
        PRAGMA user_version=10;
      `);
    }

    await expect(
      executeStateCommand(["status", `--project-root=${projectRoot}`], env)
    ).rejects.toThrow("missing required column 'run_id'");
  });

  it("performs readiness and status validation without mutating canonical state", () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } };
    const initialized = initializePennyState(projectRoot, options);

    const beforeRuntime = stateTreeSnapshot(initialized.state.root);
    expect(resolvePennyRuntimeState(projectRoot, options).projectId).toBe(initialized.projectId);
    expect(stateTreeSnapshot(initialized.state.root)).toEqual(beforeRuntime);

    const beforeStatus = stateTreeSnapshot(initialized.state.root);
    expect(resolvePennyStateStatus(projectRoot, options).projectId).toBe(initialized.projectId);
    expect(stateTreeSnapshot(initialized.state.root)).toEqual(beforeStatus);
  });

  it("rejects a repeated init on incomplete retained state without mutating it", () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } };
    const initialized = initializePennyState(projectRoot, options);
    rmSync(initialized.paths.orchestration.database, { force: true });
    rmSync(`${initialized.paths.orchestration.database}-wal`, { force: true });
    rmSync(`${initialized.paths.orchestration.database}-shm`, { force: true });

    const before = stateTreeSnapshot(initialized.state.root);
    expect(() => initializePennyState(projectRoot, options)).toThrow(
      "STATE_COMPONENT_UNINITIALIZED"
    );
    expect(stateTreeSnapshot(initialized.state.root)).toEqual(before);
  });

  it("rejects a missing global catalog without replacing retained state", () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } };
    const initialized = initializePennyState(projectRoot, options);
    const catalog = path.join(initialized.state.root, "catalog.db");
    rmSync(catalog, { force: true });
    rmSync(`${catalog}-wal`, { force: true });
    rmSync(`${catalog}-shm`, { force: true });

    const before = stateTreeSnapshot(initialized.state.root);
    expect(() => initializePennyState(projectRoot, options)).toThrow(
      "STATE_COMPONENT_UNINITIALIZED"
    );
    expect(stateTreeSnapshot(initialized.state.root)).toEqual(before);
  });

  it("refuses a retained catalog sidecar without replacing it", () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } };
    const initialized = initializePennyState(projectRoot, options);
    const catalog = path.join(initialized.state.root, "catalog.db");
    const retainedWal = `${catalog}-wal`;
    rmSync(catalog, { force: true });
    rmSync(retainedWal, { force: true });
    rmSync(`${catalog}-shm`, { force: true });
    writeFileSync(retainedWal, "retained catalog WAL", { mode: 0o600, flag: "wx" });

    const before = stateTreeSnapshot(initialized.state.root);
    expect(() => initializePennyState(projectRoot, options)).toThrow(
      "STATE_COMPONENT_UNINITIALIZED"
    );
    expect(stateTreeSnapshot(initialized.state.root)).toEqual(before);
  });

  it("refuses a retained catalog SHM sidecar without replacing it", () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } };
    const initialized = initializePennyState(projectRoot, options);
    const catalog = path.join(initialized.state.root, "catalog.db");
    const retainedShm = `${catalog}-shm`;
    rmSync(catalog, { force: true });
    rmSync(`${catalog}-wal`, { force: true });
    rmSync(retainedShm, { force: true });
    writeFileSync(retainedShm, "retained catalog SHM", { mode: 0o600, flag: "wx" });

    const before = stateTreeSnapshot(initialized.state.root);
    expect(() => initializePennyState(projectRoot, options)).toThrow(
      "STATE_COMPONENT_UNINITIALIZED"
    );
    expect(stateTreeSnapshot(initialized.state.root)).toEqual(before);
  });

  it("does not expose a legacy import or migration through setup", async () => {
    const help = await executeStateCommand(["help"], {});
    expect(help.action).toBe("help");
    if (help.action !== "help") throw new Error("expected help result");
    expect(help.text).toContain("never inspect or import legacy roots");
    expect(help.text).not.toContain("orchestration-v2.db");
  });
});
