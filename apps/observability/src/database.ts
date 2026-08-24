import { closeSync, chmodSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType, SQLOutputValue } from "node:sqlite";

import { assertOwnerDirectory, assertOwnerFile, fsyncDirectory } from "@penny/orchestration";

const sqlite = process.getBuiltinModule("node:sqlite");

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;
const LOG_LEVELS = new Set(["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"]);

export interface LogWrite {
  readonly timestamp?: string | number;
  readonly level: string;
  readonly component: string;
  readonly event: string;
  readonly session_id?: string;
  readonly client_id?: string;
  readonly data?: unknown;
}

export interface CompactionWrite {
  readonly session_id: string;
  readonly timestamp?: string | number;
  readonly summary: string;
  readonly details?: unknown;
}

export interface LogQuery {
  readonly level?: string;
  readonly component?: string;
  readonly sessionId?: string;
  readonly fromTimestamp?: number;
  readonly toTimestamp?: number;
  readonly limit: number;
  readonly offset: number;
}

interface ParsedLogWrite {
  readonly timestamp: number;
  readonly level: string;
  readonly component: string;
  readonly event: string;
  readonly sessionId: string | null;
  readonly clientId: string | null;
  readonly dataJson: string | null;
}

interface ParsedCompactionWrite {
  readonly timestamp: number;
  readonly sessionId: string;
  readonly summary: string;
  readonly detailsJson: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectPayload(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function timestampMilliseconds(value: unknown): number {
  if (value === undefined) return Date.now();
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("timestamp is invalid");
  }
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("timestamp is invalid");
  return parsed;
}

function boundedJson(value: unknown, maximumBytes: number): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("structured data must be JSON-serializable");
  if (Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw new Error(`structured data exceeds ${maximumBytes} bytes`);
  }
  return json;
}

function optionalBoundedString(
  input: Record<string, unknown>,
  name: string,
  maximum: number
): string | null {
  const value = input[name];
  return value === undefined ? null : boundedString(value, name, maximum);
}

function parseLogWrite(value: unknown): ParsedLogWrite {
  const input = objectPayload(value, "log payload");
  const level = boundedString(input.level, "level", 16).toUpperCase();
  if (!LOG_LEVELS.has(level)) throw new Error("level is unsupported");
  return {
    timestamp: timestampMilliseconds(input.timestamp),
    level,
    component: boundedString(input.component, "component", 128),
    event: boundedString(input.event, "event", 4096),
    sessionId: optionalBoundedString(input, "session_id", 256),
    clientId: optionalBoundedString(input, "client_id", 128),
    dataJson: boundedJson(input.data, 256 * 1024),
  };
}

function parseCompactionWrite(value: unknown): ParsedCompactionWrite {
  const input = objectPayload(value, "compaction payload");
  return {
    timestamp: timestampMilliseconds(input.timestamp),
    sessionId: boundedString(input.session_id, "session_id", 256),
    summary: boundedString(input.summary, "summary", 256 * 1024),
    detailsJson: boundedJson(input.details, 512 * 1024),
  };
}

function integerColumn(row: unknown, name: string): number {
  if (!isRecord(row)) throw new Error(`database row for ${name} is missing`);
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`database column ${name} is invalid`);
  }
  return value;
}

function createOwnerFile(file: string): void {
  if (existsSync(file)) return;
  const descriptor = openSync(file, "wx", 0o600);
  closeSync(descriptor);
  fsyncDirectory(path.dirname(file));
}

export class ObservabilityDatabase implements Disposable {
  readonly databasePath: string;
  private readonly database: DatabaseSyncType;
  private readonly maxRows: number;
  private insertionsSincePrune = 0;

  constructor(options: {
    readonly databasePath: string;
    readonly maxRows?: number;
    readonly journalSizeLimitBytes?: number;
  }) {
    this.databasePath = options.databasePath;
    const directory = path.dirname(this.databasePath);
    assertOwnerDirectory(directory, "Penny observability directory");
    createOwnerFile(this.databasePath);
    chmodSync(this.databasePath, 0o600);
    assertOwnerFile(this.databasePath, "Penny observability database");
    this.database = new sqlite.DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec("PRAGMA synchronous=FULL");
    this.database.exec("PRAGMA foreign_keys=ON");
    this.database.exec("PRAGMA busy_timeout=5000");
    this.database.exec("PRAGMA wal_autocheckpoint=1000");
    this.database.exec(
      `PRAGMA journal_size_limit=${options.journalSizeLimitBytes ?? 64 * 1024 * 1024}`
    );
    this.maxRows = options.maxRows ?? 100_000;
    if (!Number.isSafeInteger(this.maxRows) || this.maxRows < 1) {
      throw new Error("observability maxRows must be a positive safe integer");
    }
    this.initialize();
  }

  insertLog(value: unknown): number {
    const input = parseLogWrite(value);
    const result = this.database
      .prepare(
        "INSERT INTO logs(timestamp_ms, level, component, event, session_id, client_id, data_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.timestamp,
        input.level,
        input.component,
        input.event,
        input.sessionId,
        input.clientId,
        input.dataJson
      );
    this.insertionsSincePrune += 1;
    if (this.insertionsSincePrune >= 100) {
      this.prune();
      this.insertionsSincePrune = 0;
    }
    return Number(result.lastInsertRowid);
  }

  insertCompaction(value: unknown): number {
    const input = parseCompactionWrite(value);
    const result = this.database
      .prepare(
        "INSERT INTO compactions(timestamp_ms, session_id, summary, details_json) VALUES (?, ?, ?, ?)"
      )
      .run(input.timestamp, input.sessionId, input.summary, input.detailsJson);
    return Number(result.lastInsertRowid);
  }

  queryLogs(query: LogQuery): readonly Record<string, SQLOutputValue>[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.level) {
      clauses.push("level = ?");
      values.push(query.level.toUpperCase());
    }
    if (query.component) {
      clauses.push("component = ?");
      values.push(query.component);
    }
    if (query.sessionId) {
      clauses.push("session_id = ?");
      values.push(query.sessionId);
    }
    if (query.fromTimestamp !== undefined) {
      clauses.push("timestamp_ms >= ?");
      values.push(query.fromTimestamp);
    }
    if (query.toTimestamp !== undefined) {
      clauses.push("timestamp_ms <= ?");
      values.push(query.toTimestamp);
    }
    values.push(query.limit, query.offset);
    return this.database
      .prepare(
        "SELECT id, timestamp_ms, level, component, event, session_id, client_id, data_json " +
          `FROM logs${clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""} ` +
          "ORDER BY id DESC LIMIT ? OFFSET ?"
      )
      .all(...values);
  }

  counts(): { readonly logs: number; readonly compactions: number } {
    const logs: unknown = this.database.prepare("SELECT COUNT(*) AS count FROM logs").get();
    const compactions: unknown = this.database
      .prepare("SELECT COUNT(*) AS count FROM compactions")
      .get();
    return { logs: integerColumn(logs, "count"), compactions: integerColumn(compactions, "count") };
  }

  checkpoint(): void {
    this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close(): void {
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private initialize(): void {
    const version = integerColumn(
      this.database.prepare("PRAGMA user_version").get(),
      "user_version"
    );
    if (version > OBSERVABILITY_SCHEMA_VERSION) {
      throw new Error(`observability schema ${version} is newer than supported`);
    }
    this.database.exec(`
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
  }

  private prune(): void {
    this.database
      .prepare(
        "DELETE FROM logs WHERE id IN (" +
          "SELECT id FROM logs ORDER BY id DESC LIMIT -1 OFFSET ?" +
          ")"
      )
      .run(this.maxRows);
  }
}
