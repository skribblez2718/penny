import { chmodSync, closeSync, openSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType, SQLOutputValue } from "node:sqlite";

import { assertOwnerDirectory, assertOwnerFile, fsyncDirectory } from "./custody.js";
import { createReadOnlySqliteSnapshot } from "./sqlite-snapshot.js";

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;
const REQUIRED_OBSERVABILITY_TABLES = ["compactions", "logs"] as const;
const REQUIRED_OBSERVABILITY_COLUMNS = {
  compactions: ["id", "timestamp_ms", "session_id", "summary", "details_json"],
  logs: [
    "id",
    "timestamp_ms",
    "level",
    "component",
    "event",
    "session_id",
    "client_id",
    "data_json",
  ],
} as const;
const REQUIRED_OBSERVABILITY_INDEXES = [
  "compactions_session_idx",
  "logs_component_idx",
  "logs_session_idx",
  "logs_time_idx",
] as const;

type SqliteRow = Record<string, SQLOutputValue>;

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSqliteModule(value: unknown): value is SqliteModule {
  return isUnknownRecord(value) && typeof value.DatabaseSync === "function";
}

function sqliteModule(): SqliteModule {
  const module: unknown = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) throw new Error("Node.js runtime does not provide node:sqlite");
  return module;
}

function sqliteText(row: SqliteRow, column: string, label: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`${label}.${column} is invalid`);
  return value;
}

function sqliteInteger(row: SqliteRow, column: string, label: string): number {
  const value = row[column];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new Error(`${label}.${column} is invalid`);
  }
  return number;
}

function requiredRow(value: SqliteRow | undefined, label: string): SqliteRow {
  if (value === undefined) throw new Error(`${label} is absent`);
  return value;
}

function errorHasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function createOwnerFile(file: string): void {
  let created = false;
  try {
    const descriptor = openSync(file, "wx", 0o600);
    closeSync(descriptor);
    fsyncDirectory(path.dirname(file));
    created = true;
  } catch (error) {
    if (!errorHasCode(error, "EEXIST")) throw error;
  }
  if (!created) {
    assertOwnerFile(file, "Penny observability database");
    return;
  }
  chmodSync(file, 0o600);
  assertOwnerFile(file, "Penny observability database");
}

function configureRuntimeConnection(database: DatabaseSyncType): void {
  database.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
}

function assertExistingSchema(database: DatabaseSyncType): void {
  const journal = requiredRow(
    database.prepare("PRAGMA journal_mode").get(),
    "observability journal mode"
  );
  if (sqliteText(journal, "journal_mode", "observability journal mode").toLowerCase() !== "wal") {
    throw new Error("observability database is not configured for WAL mode");
  }
  const version = sqliteInteger(
    requiredRow(database.prepare("PRAGMA user_version").get(), "observability user_version"),
    "user_version",
    "observability user_version"
  );
  if (version !== OBSERVABILITY_SCHEMA_VERSION) {
    throw new Error(
      `observability schema ${version} is not current; run explicit penny-state init or migration`
    );
  }
  const rows = database
    .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index')")
    .all();
  const tables = new Set(
    rows
      .filter((row) => sqliteText(row, "type", "observability schema") === "table")
      .map((row) => sqliteText(row, "name", "observability schema"))
  );
  const indexes = new Set(
    rows
      .filter((row) => sqliteText(row, "type", "observability schema") === "index")
      .map((row) => sqliteText(row, "name", "observability schema"))
  );
  for (const table of REQUIRED_OBSERVABILITY_TABLES) {
    if (!tables.has(table)) throw new Error(`observability database is missing table '${table}'`);
  }
  for (const index of REQUIRED_OBSERVABILITY_INDEXES) {
    if (!indexes.has(index)) throw new Error(`observability database is missing index '${index}'`);
  }
  for (const [table, requiredColumns] of Object.entries(REQUIRED_OBSERVABILITY_COLUMNS)) {
    const columns = new Set(
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => sqliteText(row, "name", `${table} table metadata`))
    );
    for (const column of requiredColumns) {
      if (!columns.has(column)) {
        throw new Error(`observability table '${table}' is missing required column '${column}'`);
      }
    }
  }
  const integrity = requiredRow(
    database.prepare("PRAGMA integrity_check").get(),
    "observability integrity"
  );
  if (sqliteText(integrity, "integrity_check", "observability integrity") !== "ok") {
    throw new Error("observability database integrity check failed");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("observability database foreign-key check failed");
  }
}

/** Explicit state setup path. It may create or upgrade only the canonical observability store. */
export function provisionObservabilityDatabase(databasePath: string): void {
  const resolved = path.resolve(databasePath);
  assertOwnerDirectory(path.dirname(resolved), "Penny observability directory");
  createOwnerFile(resolved);
  const { DatabaseSync } = sqliteModule();
  using database = new DatabaseSync(resolved);
  database.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000;"
  );
  const version = sqliteInteger(
    requiredRow(database.prepare("PRAGMA user_version").get(), "observability user_version"),
    "user_version",
    "observability user_version"
  );
  if (version > OBSERVABILITY_SCHEMA_VERSION) {
    throw new Error(`observability schema ${version} is newer than supported`);
  }
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_ms INTEGER NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('DEBUG','INFO','WARN','ERROR','CRITICAL')),
      component TEXT NOT NULL,
      event TEXT NOT NULL,
      session_id TEXT,
      client_id TEXT,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS logs_time_idx ON logs(timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS logs_component_idx ON logs(component, id DESC);
    CREATE INDEX IF NOT EXISTS logs_session_idx ON logs(session_id, id DESC);
    CREATE TABLE IF NOT EXISTS compactions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT
    );
    CREATE INDEX IF NOT EXISTS compactions_session_idx ON compactions(session_id, id DESC);
    PRAGMA user_version=${OBSERVABILITY_SCHEMA_VERSION};
    COMMIT;
  `);
  assertExistingSchema(database);
}

/** Ordinary runtime opening path. It never creates, repairs, or upgrades the store. */
export function openExistingObservabilityDatabase(databasePath: string): DatabaseSyncType {
  const resolved = path.resolve(databasePath);
  assertOwnerDirectory(path.dirname(resolved), "Penny observability directory");
  assertOwnerFile(resolved, "Penny observability database");
  const { DatabaseSync } = sqliteModule();
  const database = new DatabaseSync(resolved);
  try {
    configureRuntimeConnection(database);
    assertExistingSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Administrative readiness validation operates on a private no-atime copy.
 * node:sqlite creates WAL/SHM siblings even for a read-only connection, so
 * opening the canonical observability DB here would violate state custody.
 */
export function assertExistingObservabilityDatabase(databasePath: string): void {
  const resolved = path.resolve(databasePath);
  assertOwnerDirectory(path.dirname(resolved), "Penny observability directory");
  using snapshot = createReadOnlySqliteSnapshot(resolved, "Penny observability database");
  const { DatabaseSync } = sqliteModule();
  using database = new DatabaseSync(snapshot.databasePath, { readOnly: true });
  assertExistingSchema(database);
}
