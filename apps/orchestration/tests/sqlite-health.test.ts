function isSqliteModule(value: unknown): value is typeof import("node:sqlite") {
  return (
    value !== null &&
    typeof value === "object" &&
    "DatabaseSync" in value &&
    typeof value.DatabaseSync === "function"
  );
}
const sqlite: unknown = process.getBuiltinModule("node:" + "sqlite");
if (!isSqliteModule(sqlite)) throw new Error("node:sqlite is unavailable");
const { DatabaseSync } = sqlite;
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import {
  initializePennyState,
  resolvePennyProjectState,
  resolvePennyRuntimeState,
} from "../dist/state/setup.js";
import {
  assertSqliteHealthy,
  isSqliteCorruption,
  openReadOnlySqliteDatabase,
  SqliteHealthError,
} from "../dist/state/sqlite-health.js";
import { assertSupportedSqliteVersion } from "../dist/state/sqlite-runtime.js";

const roots: string[] = [];
function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sqlite-health-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs in a different process: a successful BEGIN EXCLUSIVE disproves a held read lock. */
function exclusiveWriterProbe(
  Database: typeof import("node:sqlite").DatabaseSync,
  assert: typeof import("node:assert/strict"),
  file: string,
  blocked: boolean
): void {
  const database = new Database(file);
  try {
    // In WAL mode, BEGIN EXCLUSIVE alone permits readers. Exclusive locking
    // mode also contends for the main database's POSIX shared byte range.
    database.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;");
    let failure: unknown;
    try {
      database.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    } catch (error) {
      failure = error;
    }
    if (blocked) {
      assert.ok(failure !== null && typeof failure === "object" && "errcode" in failure);
      assert.equal(failure.errcode, 5, "independent writer must receive SQLITE_BUSY");
    } else if (failure !== undefined) {
      throw failure;
    }
  } finally {
    database.close();
  }
}

function committedWalProbe(
  Database: typeof import("node:sqlite").DatabaseSync,
  assert: typeof import("node:assert/strict"),
  file: string
): void {
  const database = new Database(file, { readOnly: true });
  try {
    assert.deepEqual(
      database
        .prepare("SELECT value FROM data ORDER BY rowid")
        .all()
        .map((row) => row.value),
      ["committed", "later"]
    );
  } finally {
    database.close();
  }
}

/** No Vitest/native module contexts share this process's SQLite connections. */
function sqliteLockProbe(
  Database: typeof import("node:sqlite").DatabaseSync,
  fs: typeof import("node:fs"),
  assert: typeof import("node:assert/strict"),
  spawn: typeof import("node:child_process").spawnSync,
  health: typeof import("../dist/state/sqlite-health.js"),
  root: string,
  exclusiveSource: string,
  walSource: string,
  rawClose: boolean,
  omitGlobalLocks: boolean
): void {
  if (omitGlobalLocks) {
    // A global enumeration can miss our lock while it remains held. Inject at
    // the fs boundary so reverting to /proc/locks also fails this regression.
    const readFile = fs.readFileSync;
    fs = new Proxy(fs, {
      get(target, property, receiver): unknown {
        if (property === "readFileSync") {
          return (...args: Parameters<typeof readFile>): ReturnType<typeof readFile> =>
            args[0] === "/proc/locks" ? "" : readFile(...args);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    assert.equal(fs.readFileSync("/proc/locks", "utf8"), "");
  }
  const file = `${root}/locks.db`;
  const owner = new Database(file);
  const independent = (candidate: string, blocked: boolean): void => {
    const result = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { DatabaseSync } from 'node:sqlite'; import assert from 'node:assert/strict'; (${exclusiveSource})(DatabaseSync, assert, process.argv[1], process.argv[2] === 'blocked');`,
        candidate,
        blocked ? "blocked" : "available",
      ],
      { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
  };
  const hasSharedLock = (candidate: string): boolean => {
    const stat = fs.lstatSync(candidate, { bigint: true });
    // SQLite's 510-byte shared range starts two bytes after PENDING_BYTE.
    const sharedFirstByte = 1073741826n;
    const sharedLastByte = 1073742335n;
    // Linux dev_t encodes both device numbers; inode alone is not file identity.
    const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & 0xfffff000n);
    const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & 0xffffff00n);
    // /proc/locks walks a changing system-wide list across reads. Unrelated
    // lock churn can omit even our continuously held lock. fdinfo reports the
    // inode's locks instead; only proc descriptors are opened/closed here.
    return fs.readdirSync("/proc/self/fdinfo").some((descriptor) => {
      let info: string;
      try {
        info = fs.readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8");
      } catch (error) {
        // readdir's own descriptor (or another transient descriptor) may be gone.
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return false;
        throw error;
      }
      return info.split("\n").some((line) => {
        const fields = line.trim().split(/\s+/u);
        if (fields[0] !== "lock:") return false;
        fields.shift();
        if (fields[1] !== "POSIX" || fields[3] !== "READ" || fields[4] !== String(process.pid))
          return false;
        const identity = fields[5]?.split(":");
        if (!identity || identity.length !== 3) return false;
        const [deviceMajor, deviceMinor, inode] = identity;
        const start = fields[6];
        const end = fields[7];
        if (!deviceMajor || !deviceMinor || !inode || !start || !end) return false;
        return (
          BigInt(`0x${deviceMajor}`) === major &&
          BigInt(`0x${deviceMinor}`) === minor &&
          BigInt(inode) === stat.ino &&
          BigInt(start) <= sharedFirstByte &&
          (end === "EOF" || BigInt(end) >= sharedLastByte)
        );
      });
    });
  };
  try {
    owner.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE data(value TEXT); INSERT INTO data VALUES ('committed'); BEGIN;"
    );
    assert.equal(owner.prepare("SELECT value FROM data").get()?.value, "committed");
    fs.chmodSync(file, 0o600);
    assert.ok(hasSharedLock(file), "live owner must hold SQLite's shared byte range");
    independent(file, true);
    if (rawClose) {
      // Negative control: even a read-only raw open/read/close drops POSIX locks.
      fs.readFileSync(file);
      assert.equal(hasSharedLock(file), false);
      independent(file, false);
      assert.throws(() => independent(file, true), "the contention oracle must reject lost locks");
    } else {
      const reader = health.openReadOnlySqliteDatabase(file, "locks", Database);
      try {
        assert.equal(reader.prepare("SELECT value FROM data").get()?.value, "committed");
        assert.throws(
          () => reader.exec("INSERT INTO data VALUES ('forbidden')"),
          (error: unknown) =>
            error !== null &&
            typeof error === "object" &&
            "errcode" in error &&
            typeof error.errcode === "number" &&
            (error.errcode & 0xff) === 8
        );
        independent(file, true);
        assert.ok(hasSharedLock(file), "opening the canonical reader must preserve locks");
      } finally {
        reader.close();
      }
      // The owner still has a real read transaction, not an idle/closed connection.
      independent(file, true);
      assert.ok(
        hasSharedLock(file),
        "closing the canonical reader must preserve the owner's locks"
      );
      assert.equal(owner.prepare("SELECT count(*) AS n FROM data").get()?.n, 1);
      owner.exec("COMMIT;");
      independent(file, false); // Positive control: the same writer can acquire after release.
      health.assertSqliteHealthy(owner, "locks");
    }
  } finally {
    owner.close();
  }

  const walFile = `${root}/wal.db`;
  const writer = new Database(walFile);
  try {
    writer.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE data(value TEXT); INSERT INTO data VALUES ('committed');"
    );
    fs.chmodSync(walFile, 0o600);
    independent(walFile, true);
    assert.ok(hasSharedLock(walFile), "the live WAL writer must hold the main-file shared lock");
    if (rawClose) {
      fs.readFileSync(walFile);
      assert.equal(hasSharedLock(walFile), false, "raw close must drop the WAL main-file lock");
      independent(walFile, false);
      return;
    }
    const reader = health.openReadOnlySqliteDatabase(walFile, "WAL", Database);
    try {
      // Commit before the caller's first data read: BEGIN alone is not a snapshot.
      writer.exec("INSERT INTO data VALUES ('later');");
      assert.equal(reader.prepare("SELECT value FROM data").get()?.value, "committed");
      assert.equal(reader.prepare("SELECT count(*) AS n FROM data").get()?.n, 1);
      independent(walFile, true);
      assert.ok(hasSharedLock(walFile), "the canonical WAL snapshot must preserve locks");
      assert.throws(
        () => reader.exec("INSERT INTO data VALUES ('forbidden')"),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "errcode" in error &&
          typeof error.errcode === "number" &&
          (error.errcode & 0xff) === 8
      );
    } finally {
      reader.close();
    }
    independent(walFile, true);
    assert.ok(hasSharedLock(walFile), "closing the WAL reader must preserve the writer's locks");
    assert.equal(writer.prepare("SELECT count(*) AS n FROM data").get()?.n, 2);
    assert.ok(fs.lstatSync(`${walFile}-wal`).size > 0, "commits must still reside in a live WAL");
    const result = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { DatabaseSync } from 'node:sqlite'; import assert from 'node:assert/strict'; (${walSource})(DatabaseSync, assert, process.argv[1]);`,
        walFile,
      ],
      { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    health.assertSqliteHealthy(writer, "WAL");
  } finally {
    writer.close();
  }
}

function runIsolatedLockProbe(root: string, rawClose: boolean, omitGlobalLocks = false): void {
  // Transpile the actual source, not stale dist or a reimplemented read-only helper.
  for (const name of ["sqlite-health", "custody"]) {
    const source = readFileSync(new URL(`../src/state/${name}.ts`, import.meta.url), "utf8");
    const result = ts.transpileModule(source, {
      fileName: `${name}.ts`,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    expect(result.diagnostics ?? []).toEqual([]);
    writeFileSync(path.join(root, `${name}.js`), result.outputText);
  }
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  const script = [
    "import { DatabaseSync } from 'node:sqlite';",
    "import * as fs from 'node:fs';",
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    `import * as health from ${JSON.stringify(pathToFileURL(path.join(root, "sqlite-health.js")).href)};`,
    `(${sqliteLockProbe.toString()})(DatabaseSync, fs, assert, spawnSync, health, process.argv[1], ${JSON.stringify(exclusiveWriterProbe.toString())}, ${JSON.stringify(committedWalProbe.toString())}, ${String(rawClose)}, ${String(omitGlobalLocks)});`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script, root], {
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 128 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
}

describe("SQLite-managed validation", () => {
  it.skipIf(process.platform !== "linux")(
    "preserves an existing connection's POSIX locks and committed WAL data",
    () => runIsolatedLockProbe(sandbox(), false)
  );

  it.skipIf(process.platform !== "linux")(
    "detects POSIX lock loss caused by a raw database open/read/close",
    () => runIsolatedLockProbe(sandbox(), true)
  );

  it.skipIf(process.platform !== "linux")(
    "observes real main-file locks when the global enumeration omits them",
    () => runIsolatedLockProbe(sandbox(), false, true)
  );

  it("never creates a missing database and refuses a symlink", () => {
    const root = sandbox();
    const missing = path.join(root, "missing.db");
    expect(() => openReadOnlySqliteDatabase(missing, "missing", DatabaseSync)).toThrow();
    expect(existsSync(missing)).toBe(false);
    const target = path.join(root, "target.db");
    {
      using db = new DatabaseSync(target);
      db.exec("CREATE TABLE test(x)");
    }
    chmodSync(target, 0o600);
    const link = path.join(root, "link.db");
    symlinkSync(target, link);
    expect(() => openReadOnlySqliteDatabase(link, "link", DatabaseSync)).toThrow();
  });

  it("refuses hard-linked and non-owner-only files without repairing their custody", () => {
    const root = sandbox();
    const file = path.join(root, "custody.db");
    {
      using database = new DatabaseSync(file);
      database.exec("CREATE TABLE data(value)");
    }
    chmodSync(file, 0o644);
    expect(() => openReadOnlySqliteDatabase(file, "mode", DatabaseSync)).toThrow(
      "mode must be exactly 0600"
    );
    expect(lstatSync(file).mode & 0o777).toBe(0o644);
    chmodSync(file, 0o600);
    const link = path.join(root, "hardlink.db");
    linkSync(file, link);
    expect(() => openReadOnlySqliteDatabase(file, "links", DatabaseSync)).toThrow(
      "single-link file"
    );
    expect(() => openReadOnlySqliteDatabase(link, "links", DatabaseSync)).toThrow(
      "single-link file"
    );
    expect(lstatSync(file).nlink).toBe(2);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it("preserves SQLite's diagnostic and distinguishes health from configuration errors", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE data(x INTEGER CHECK(x>0)); PRAGMA ignore_check_constraints=ON; INSERT INTO data VALUES (-1); PRAGMA ignore_check_constraints=OFF;"
    );
    expect(() => assertSqliteHealthy(db, "test")).toThrow(SqliteHealthError);
    expect(() => assertSqliteHealthy(db, "test")).toThrow("CHECK constraint failed in data");
    expect(isSqliteCorruption({ errcode: 11 })).toBe(true);
    expect(isSqliteCorruption({ errcode: 26 })).toBe(true);
    expect(isSqliteCorruption({ errcode: 5 })).toBe(false);
    expect(isSqliteCorruption(new Error("missing file"))).toBe(false);
  });

  it("keeps whole-store scans out of exact artifact access but detects damage at startup", () => {
    const root = sandbox();
    const project = path.join(root, "project");
    mkdirSync(project);
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } };
    const state = initializePennyState(project, options);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const resolved = resolvePennyProjectState(project, options);
    {
      using store = ArtifactStore.openExisting(resolved.paths.artifacts.root, {
        projectId: resolved.projectId,
      });
      expect(store.refById(`art_${"1".repeat(64)}`)).toBeUndefined();
    }
    expect(
      prepare.mock.calls.some(([sql]) => /PRAGMA (?:integrity_check|foreign_key_check)/iu.test(sql))
    ).toBe(false);
    prepare.mockRestore();
    {
      using db = new DatabaseSync(state.paths.artifacts.manifestDatabase);
      db.exec(
        "PRAGMA foreign_keys=OFF; INSERT INTO artifact_selections VALUES ('run','phase','','kind','missing',1,'now');"
      );
    }
    expect(() => resolvePennyRuntimeState(project, options)).toThrow("STATE_DATABASE_CORRUPT");
    expect(() => resolvePennyRuntimeState(project, options)).toThrow(
      "foreign-key violation: table=artifact_selections"
    );
  });

  it("requires a patched SQLite library rather than trusting a Node major version", () => {
    for (const version of [undefined, "garbage", "3.50.4", "3.51.2"]) {
      expect(() => assertSupportedSqliteVersion(version)).toThrow("SQLite >=3.51.3");
    }
    for (const version of ["3.51.3", "3.53.4", "4.0.0"]) {
      expect(() => assertSupportedSqliteVersion(version)).not.toThrow();
    }
  });
});
