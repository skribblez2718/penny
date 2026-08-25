import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/** Shared profile-session and parent-delivery authority database. */
export const HOST_GRANT_DATABASE_NAME = "grants.sqlite";
const HOST_GRANT_AUTHORITY_FILES = new Set([
  HOST_GRANT_DATABASE_NAME,
  `${HOST_GRANT_DATABASE_NAME}-wal`,
  `${HOST_GRANT_DATABASE_NAME}-shm`,
]);

/** Refuse every non-SQLite fragment instead of scanning or adopting legacy authority. */
export function isUnsafeHostGrantFragment(name: string): boolean {
  return !HOST_GRANT_AUTHORITY_FILES.has(name);
}

function isSqliteModule(value: unknown): value is typeof import("node:sqlite") {
  return (
    value !== null &&
    typeof value === "object" &&
    "DatabaseSync" in value &&
    typeof value.DatabaseSync === "function"
  );
}

function sqliteModule(): typeof import("node:sqlite") {
  const module: unknown = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) throw new Error("Node.js runtime does not provide node:sqlite");
  return module;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function currentUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function pathExistsNoFollow(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function assertNoSymlinkAncestors(candidate: string, label: string): void {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!pathExistsNoFollow(cursor)) continue;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${label} has a symlink ancestor: ${cursor}`);
    }
  }
}

function assertOwnerDirectory(directory: string, label: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if ((stat.mode & 0o777) !== OWNER_DIRECTORY_MODE) {
    throw new Error(`${label} mode must be exactly 0700`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} has the wrong owner`);
}

function assertOwnerFile(file: string, label: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a regular non-symlink single-link file`);
  }
  if ((stat.mode & 0o777) !== OWNER_FILE_MODE) {
    throw new Error(`${label} mode must be exactly 0600`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} has the wrong owner`);
}

function createOwnerFile(file: string, directory: string, label: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      OWNER_FILE_MODE
    );
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      assertOwnerFile(file, label);
      return;
    }
    throw error;
  }
  try {
    fchmodSync(descriptor, OWNER_FILE_MODE);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directoryDescriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
  assertOwnerFile(file, label);
}

export interface OwnerSqliteDatabaseOptions {
  readonly directory: string;
  readonly databaseName: string;
  readonly label: string;
  /**
   * Legacy authority files are never scanned or adopted. Their mere presence
   * blocks the store, so a directory scan cannot mint authority in SQLite.
   */
  readonly isLegacyAuthorityFile?: (name: string) => boolean;
}

/**
 * Owner-only SQLite/WAL/FULL custody shared by the small host authority stores.
 * The wrapper pins directory/database identity and revalidates database, WAL,
 * SHM, and legacy-file absence before every operation.
 */
export class OwnerSqliteDatabase implements Disposable {
  readonly directory: string;
  readonly databasePath: string;
  readonly db: DatabaseSync;
  private readonly label: string;
  private readonly isLegacyAuthorityFile: ((name: string) => boolean) | undefined;
  private readonly directoryIdentity: { dev: bigint | number; ino: bigint | number };
  private readonly databaseIdentity: { dev: bigint | number; ino: bigint | number };
  private closed = false;

  constructor(options: OwnerSqliteDatabaseOptions) {
    this.directory = path.resolve(options.directory);
    this.databasePath = path.join(this.directory, options.databaseName);
    this.label = options.label;
    this.isLegacyAuthorityFile = options.isLegacyAuthorityFile;

    assertNoSymlinkAncestors(this.directory, this.label);
    if (!pathExistsNoFollow(this.directory)) {
      mkdirSync(this.directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
    }
    assertNoSymlinkAncestors(this.directory, this.label);
    assertOwnerDirectory(this.directory, this.label);
    this.assertNoLegacyAuthorityFiles();
    const directoryStat = lstatSync(this.directory);
    this.directoryIdentity = { dev: directoryStat.dev, ino: directoryStat.ino };

    const databaseExisted = pathExistsNoFollow(this.databasePath);
    if (databaseExisted) assertOwnerFile(this.databasePath, `${this.label} database`);
    else createOwnerFile(this.databasePath, this.directory, `${this.label} database`);

    const sidecarExisted = new Map(
      SQLITE_SIDECAR_SUFFIXES.map((suffix) => {
        const sidecar = `${this.databasePath}${suffix}`;
        const existed = pathExistsNoFollow(sidecar);
        if (existed) assertOwnerFile(sidecar, `${this.label} database${suffix}`);
        return [suffix, existed] as const;
      })
    );

    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(this.databasePath);
    this.db = db;
    try {
      const journal = db.prepare("PRAGMA journal_mode=WAL").get() as
        | Record<string, SQLOutputValue>
        | undefined;
      db.exec(
        `PRAGMA synchronous=FULL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};`
      );
      if (String(journal?.journal_mode ?? "").toLowerCase() !== "wal") {
        throw new Error(`${this.label} database refused WAL mode`);
      }
      const synchronous = db.prepare("PRAGMA synchronous").get() as
        | Record<string, SQLOutputValue>
        | undefined;
      if (Number(synchronous?.synchronous) !== 2) {
        throw new Error(`${this.label} database refused synchronous=FULL`);
      }
      const integrity = db.prepare("PRAGMA integrity_check(1)").get() as
        | Record<string, SQLOutputValue>
        | undefined;
      if (String(integrity?.integrity_check ?? "") !== "ok") {
        throw new Error(`${this.label} database failed integrity_check`);
      }

      for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
        const sidecar = `${this.databasePath}${suffix}`;
        if (!pathExistsNoFollow(sidecar)) continue;
        if (!sidecarExisted.get(suffix)) {
          const stat = lstatSync(sidecar);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
            throw new Error(`${this.label} database${suffix} is not a safe SQLite sidecar`);
          }
          const uid = currentUid();
          if (uid !== undefined && stat.uid !== uid) {
            throw new Error(`${this.label} database${suffix} has the wrong owner`);
          }
          const descriptor = openSync(sidecar, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            fchmodSync(descriptor, OWNER_FILE_MODE);
          } finally {
            closeSync(descriptor);
          }
        }
        assertOwnerFile(sidecar, `${this.label} database${suffix}`);
      }
      assertOwnerFile(this.databasePath, `${this.label} database`);
    } catch (error) {
      db.close();
      this.closed = true;
      throw error;
    }
    const databaseStat = lstatSync(this.databasePath);
    this.databaseIdentity = { dev: databaseStat.dev, ino: databaseStat.ino };
  }

  assertCustody(): void {
    if (this.closed) throw new Error(`${this.label} database is closed`);
    assertNoSymlinkAncestors(this.directory, this.label);
    assertOwnerDirectory(this.directory, this.label);
    const directoryStat = lstatSync(this.directory);
    if (
      directoryStat.dev !== this.directoryIdentity.dev ||
      directoryStat.ino !== this.directoryIdentity.ino
    ) {
      throw new Error(`${this.label} directory changed after open`);
    }
    this.assertNoLegacyAuthorityFiles();
    assertOwnerFile(this.databasePath, `${this.label} database`);
    const databaseStat = lstatSync(this.databasePath);
    if (
      databaseStat.dev !== this.databaseIdentity.dev ||
      databaseStat.ino !== this.databaseIdentity.ino
    ) {
      throw new Error(`${this.label} database path changed after open`);
    }
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const sidecar = `${this.databasePath}${suffix}`;
      if (pathExistsNoFollow(sidecar)) {
        assertOwnerFile(sidecar, `${this.label} database${suffix}`);
      }
    }
  }

  transaction<T>(operation: () => T): T {
    this.assertCustody();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure; SQLite may already have rolled back.
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private assertNoLegacyAuthorityFiles(): void {
    if (this.isLegacyAuthorityFile === undefined) return;
    const legacy = readdirSync(this.directory).find((name) => this.isLegacyAuthorityFile?.(name));
    if (legacy !== undefined) {
      throw new Error(
        `${this.label} contains legacy authority file '${legacy}'; automatic scan/adoption is forbidden`
      );
    }
  }
}
