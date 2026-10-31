import { lstatSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { assertOwnerFile } from "./custody.js";

/** A database-health failure, distinct from missing files or incompatible schemas. */
export class SqliteHealthError extends Error {
  constructor(
    readonly component: string,
    readonly diagnostics: readonly string[],
    options?: ErrorOptions
  ) {
    super(`${component} database integrity check failed: ${diagnostics.join("; ")}`, options);
    this.name = "SqliteHealthError";
  }
}

/** SQLite primary result codes, including extended variants, not message matching. */
export function isSqliteCorruption(error: unknown): boolean {
  if (error instanceof SqliteHealthError) return true;
  if (error === null || typeof error !== "object" || !("errcode" in error)) return false;
  return typeof error.errcode === "number" && [11, 26].includes(error.errcode & 0xff);
}

/** Full scans belong to startup/administration, never each exact artifact read. */
export function assertSqliteHealthy(database: DatabaseSync, component: string): void {
  const diagnostics = database
    .prepare("PRAGMA integrity_check")
    .all()
    .map((row) => {
      if (typeof row.integrity_check !== "string") {
        throw new Error(`${component} integrity_check returned an invalid diagnostic`);
      }
      return row.integrity_check;
    });
  if (diagnostics.length !== 1 || diagnostics[0] !== "ok") {
    throw new SqliteHealthError(component, diagnostics);
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) {
    throw new SqliteHealthError(
      component,
      foreignKeys.map(
        (row) =>
          `foreign-key violation: table=${String(row.table)}, rowid=${String(row.rowid)}, parent=${String(row.parent)}, key=${String(row.fkid)}`
      )
    );
  }
}

/**
 * SQLite-managed, create-never read transaction. Never raw-open/read/close an
 * active database: POSIX close() would drop this process's SQLite file locks.
 * SQLite may update access metadata and manage WAL/SHM files; application data
 * and schema remain read-only. The caller closes the connection/transaction.
 */
export function openReadOnlySqliteDatabase(
  databasePath: string,
  label: string,
  Database: typeof DatabaseSync
): DatabaseSync {
  assertOwnerFile(databasePath, label);
  const before = lstatSync(databasePath);
  const database = new Database(databasePath, { readOnly: true });
  try {
    const after = lstatSync(databasePath);
    assertOwnerFile(databasePath, label);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`${label} changed while opening`);
    }
    database.exec(
      "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN;"
    );
    // Establish the snapshot now, not on an arbitrary later validation query.
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
