import { createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { canonicalJson } from "../checkpointer.js";
import { ExecutionReceiptSchema, validateContract, type ExecutionReceipt } from "../contracts.js";
import { ReceiptAuthority } from "../receipts.js";
import { migrationArtifactRef, migrationOutputArtifactMetadata } from "./artifact-compat.js";

function ownerKey(keyPath: string): Buffer {
  const stat = lstatSync(keyPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (typeof process.geteuid === "function" && stat.uid !== process.geteuid())
  ) {
    throw new Error("migration receipt key custody is invalid");
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error("migration receipt key must contain exactly 32 bytes");
  return key;
}

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSqliteModule(value: object | undefined): value is SqliteModule {
  return value !== undefined && "DatabaseSync" in value && typeof value.DatabaseSync === "function";
}

/** Verify one retained receipt before normalizing any schema-v1 artifact ref it signs. */
function sqliteModule(): SqliteModule {
  const module = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) throw new Error("Node.js runtime does not provide node:sqlite");
  return module;
}

function migrationRowId(value: SQLOutputValue | undefined): number | bigint {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("migration JSON projection has an invalid rowid");
  }
  return value;
}

function normalizeArtifactValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeArtifactValues);
  if (!isUnknownRecord(value)) return value;
  const record = value;
  if (
    record.schema_version === 1 &&
    typeof record.run_id === "string" &&
    typeof record.consumer === "string" &&
    Array.isArray(record.artifacts)
  ) {
    return {
      schema_version: 2,
      artifacts: record.artifacts.map(normalizeArtifactValues),
    };
  }
  if (record.schema_version === 1 && "consumer_scope" in record) {
    if (typeof record.artifact_id === "string") {
      return migrationArtifactRef(record, "migration orchestration artifact ref");
    }
    if (
      typeof record.run_id === "string" &&
      typeof record.operation_id === "string" &&
      Array.isArray(record.upstream_refs)
    ) {
      return migrationOutputArtifactMetadata(record);
    }
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, normalizeArtifactValues(child)])
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Normalize retained orchestration JSON projections to artifact schema v2 and
 * re-sign historical worker receipts with the exact migrated authority.
 */
export function normalizeMigratedOrchestrationDatabase(
  databasePath: string,
  receiptKeyPath: string
): void {
  const { DatabaseSync } = sqliteModule();
  const database: DatabaseSync = new DatabaseSync(databasePath);
  const authority = ReceiptAuthority.loadExisting(receiptKeyPath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    for (const tableRow of tables) {
      const table = String(tableRow.name);
      const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
      for (const columnRow of columns) {
        const column = String(columnRow.name);
        if (!column.endsWith("_json")) continue;
        let rows: Array<Record<string, SQLOutputValue>>;
        try {
          rows = database
            .prepare(
              `SELECT rowid AS migration_rowid, ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`
            )
            .all();
        } catch {
          continue;
        }
        const update = database.prepare(
          `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)}=? WHERE rowid=?`
        );
        for (const row of rows) {
          const raw = String(row.value);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          let normalized = normalizeArtifactValues(parsed);
          if (
            table === "receipts" &&
            column === "result_json" &&
            isUnknownRecord(normalized) &&
            "worker_receipt" in normalized
          ) {
            const worker = validateContract(
              ExecutionReceiptSchema,
              normalized.worker_receipt,
              "migration normalized execution receipt"
            );
            const { signature: _signature, ...unsigned } = worker;
            normalized = { ...normalized, worker_receipt: authority.sign(unsigned) };
          }
          const canonical = canonicalJson(normalized);
          if (canonical !== raw) {
            update.run(canonical, migrationRowId(row.migration_rowid));
          }
        }
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Transaction may not have started.
    }
    throw error;
  } finally {
    database.close();
  }
}

function normalizedReceiptArtifactRef(value: unknown): unknown {
  if (!isUnknownRecord(value)) return value;
  const record = value;
  if (record.schema_version !== 1) return record;
  return {
    schema_version: 2,
    artifact_id: record.artifact_id,
    run_id: record.run_id,
    phase: record.phase,
    branch_id: record.branch_id,
    kind: record.kind,
    operation_id: record.operation_id,
    version: record.version,
    producer: record.producer,
    media_type: record.media_type,
    byte_length: record.byte_length,
    content_digest: record.content_digest,
    store_ref: record.store_ref,
  };
}

export function verifyMigrationExecutionReceipt(value: unknown, keyPath: string): ExecutionReceipt {
  if (!isUnknownRecord(value)) {
    throw new Error("migration execution receipt must be an object");
  }
  const raw = value;
  if (typeof raw.signature !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/u.test(raw.signature)) {
    throw new Error("migration execution receipt signature is invalid");
  }
  const { signature, ...unsigned } = raw;
  const expected = `hmac-sha256:${createHmac("sha256", ownerKey(keyPath))
    .update(canonicalJson(unsigned), "utf8")
    .digest("hex")}`;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(signature, "utf8");
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    throw new Error("migration execution receipt has an invalid signature");
  }
  return validateContract(
    ExecutionReceiptSchema,
    {
      ...raw,
      output_artifact_ref: normalizedReceiptArtifactRef(raw.output_artifact_ref),
    },
    "migration execution receipt"
  );
}
