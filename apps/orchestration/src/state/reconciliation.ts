import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

import { ArtifactStore } from "../artifact-store.js";
import { canonicalJson, Checkpointer } from "../checkpointer.js";
import { migrationArtifactRef, migrationOutputArtifactMetadata } from "./artifact-compat.js";
import {
  assertOwnerFile,
  ensureOwnerDirectory,
  fsyncDirectory,
  pathExistsNoFollow,
} from "./custody.js";
import { PENNY_STATE_LAYOUT_VERSION, PROJECT_ID_PATTERN } from "./paths.js";

export type SqliteReconciliationStrategy = "strict-union" | "artifact-union";
export type ArtifactSelectionPolicy = "require-identical" | "prefer-precedence";

export interface SqliteReconciliationSource {
  readonly sourceId: string;
  readonly path: string;
}

export interface ReconciledTableEvidence {
  readonly name: string;
  readonly row_count: number;
  readonly rows_sha256: string;
}

export interface SqliteReconciliationEvidence {
  readonly strategy: SqliteReconciliationStrategy;
  readonly selection_policy?: ArtifactSelectionPolicy;
  readonly precedence: readonly string[];
  readonly source_count: number;
  readonly duplicate_row_count: number;
  readonly precedence_resolution_count: number;
  readonly precedence_resolution_sha256: string;
  readonly target_tables: readonly ReconciledTableEvidence[];
  readonly target_logical_sha256: string;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSqliteModule(value: object | undefined): value is SqliteModule {
  return value !== undefined && "DatabaseSync" in value && typeof value.DatabaseSync === "function";
}

function sqliteModule(): SqliteModule {
  const module = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) throw new Error("Node.js runtime does not provide node:sqlite");
  return module;
}

function sqlInput(
  row: Record<string, SQLOutputValue>,
  column: string,
  label: string
): SQLInputValue {
  const value = row[column];
  if (value === undefined) throw new Error(`${label} is missing column '${column}'`);
  return value;
}

function stableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (isUnknownRecord(input) && !Buffer.isBuffer(input)) {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)])
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

function sqliteValue(value: SQLOutputValue): unknown {
  if (value === null) return { type: "null" };
  if (Buffer.isBuffer(value)) return { type: "blob", value: value.toString("hex") };
  if (typeof value === "bigint") return { type: "integer", value: value.toString(10) };
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("SQLite reconciliation encountered non-finite data");
    return { type: "number", value: Object.is(value, -0) ? "-0" : String(value) };
  }
  return { type: "text", value };
}

function encodedRow(columns: readonly string[], row: Record<string, SQLOutputValue>): string {
  return stableJson(columns.map((column) => [column, sqliteValue(row[column] ?? null)]));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function userTables(database: DatabaseSync): readonly string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master " +
        "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => String(row.name));
}

function tableColumns(database: DatabaseSync, table: string): readonly string[] {
  return database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => String(row.name));
}

export function sqliteTargetEvidence(databasePath: string): {
  readonly tables: readonly ReconciledTableEvidence[];
  readonly logicalSha256: string;
} {
  const { DatabaseSync } = sqliteModule();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    const integrity = database.prepare("PRAGMA integrity_check").get() as
      | Record<string, SQLOutputValue>
      | undefined;
    if (String(integrity?.integrity_check ?? "") !== "ok") {
      throw new Error("reconciled SQLite target failed integrity_check");
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("reconciled SQLite target failed foreign_key_check");
    }
    const tables = userTables(database).map((name): ReconciledTableEvidence => {
      const columns = tableColumns(database, name);
      const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).all();
      const encoded = rows.map((row) => encodedRow(columns, row)).sort();
      return {
        name,
        row_count: rows.length,
        rows_sha256: createHash("sha256").update(encoded.join("\n")).digest("hex"),
      };
    });
    return {
      tables,
      logicalSha256: createHash("sha256").update(stableJson(tables)).digest("hex"),
    };
  } finally {
    database.close();
  }
}

function copyOwnerSource(source: string, target: string, label: string): void {
  assertOwnerFile(source, label);
  const sourceDescriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let targetDescriptor: number | undefined;
  try {
    const stat = fstatSync(sourceDescriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${label} has unsafe custody`);
    targetDescriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const read = readSync(sourceDescriptor, buffer, 0, buffer.length, position);
      if (read === 0) break;
      let written = 0;
      while (written < read) {
        written += writeSync(targetDescriptor, buffer, written, read - written);
      }
      position += read;
    }
  } finally {
    if (targetDescriptor !== undefined) closeSync(targetDescriptor);
    closeSync(sourceDescriptor);
  }
  chmodSync(target, 0o600);
}

function canonicalSourceCopy(
  source: string,
  strategy: SqliteReconciliationStrategy
): { readonly root: string; readonly database: string } {
  const root = mkdtempSync(path.join(tmpdir(), "penny-reconcile-source-"));
  chmodSync(root, 0o700);
  const database = path.join(root, strategy === "artifact-union" ? "manifest.db" : "source.db");
  copyOwnerSource(source, database, "reconciliation SQLite source");
  const wal = `${source}-wal`;
  if (pathExistsNoFollow(wal)) {
    copyOwnerSource(wal, `${database}-wal`, "reconciliation SQLite source WAL");
  }
  try {
    if (strategy === "artifact-union") {
      using _artifacts = new ArtifactStore(root);
    } else {
      using _checkpointer = new Checkpointer(database);
    }
    return { root, database };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function initializeTarget(
  target: string,
  strategy: SqliteReconciliationStrategy,
  projectId: string,
  bindingCreatedAt: string
): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("reconciliation project ID is invalid");
  ensureOwnerDirectory(path.dirname(target), "reconciliation target directory");
  if (strategy === "artifact-union") {
    if (path.basename(target) !== "manifest.db") {
      throw new Error("artifact reconciliation target must use manifest.db");
    }
    using _artifacts = new ArtifactStore(path.dirname(target), { projectId });
  } else {
    using _checkpointer = new Checkpointer(target, undefined, { projectId });
  }
  const { DatabaseSync } = sqliteModule();
  const database = new DatabaseSync(target);
  try {
    database
      .prepare("UPDATE store_metadata SET created_at=? WHERE singleton=1")
      .run(bindingCreatedAt);
  } finally {
    database.close();
  }
}

function normalizedArtifactRow(
  table: string,
  row: Record<string, SQLOutputValue>
): Record<string, SQLOutputValue> {
  if (table !== "artifacts") return row;
  const envelope: unknown =
    row.envelope_json === undefined ? undefined : JSON.parse(String(row.envelope_json));
  const envelopeRecord =
    envelope === undefined ? undefined : isUnknownRecord(envelope) ? envelope : undefined;
  if (envelope !== undefined && envelopeRecord === undefined) {
    throw new Error("reconciled artifact envelope must be an object");
  }
  const ref = migrationArtifactRef(
    envelopeRecord === undefined
      ? JSON.parse(String(row.ref_json))
      : {
          schema_version: envelopeRecord.schema_version,
          artifact_id: envelopeRecord.artifact_id,
          run_id: envelopeRecord.run_id,
          phase: envelopeRecord.phase,
          branch_id: envelopeRecord.branch_id,
          kind: envelopeRecord.kind,
          operation_id: envelopeRecord.operation_id,
          version: envelopeRecord.version,
          producer: envelopeRecord.producer,
          consumer_scope: envelopeRecord.consumer_scope,
          media_type: envelopeRecord.media_type,
          byte_length: envelopeRecord.byte_length,
          content_digest: envelopeRecord.content_digest,
          store_ref: envelopeRecord.store_ref,
        },
    "reconciled artifact ref"
  );
  const metadata = migrationOutputArtifactMetadata(
    envelopeRecord === undefined
      ? JSON.parse(String(row.metadata_json))
      : {
          schema_version: envelopeRecord.schema_version,
          run_id: envelopeRecord.run_id,
          phase: envelopeRecord.phase,
          branch_id: envelopeRecord.branch_id,
          kind: envelopeRecord.kind,
          operation_id: envelopeRecord.operation_id,
          version: envelopeRecord.version,
          producer: envelopeRecord.producer,
          consumer_scope: envelopeRecord.consumer_scope,
          media_type: envelopeRecord.media_type,
          parent_ref: envelopeRecord.parent_ref,
          upstream_refs: envelopeRecord.upstream_refs,
        }
  );
  const comparisons: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["artifact_id", String(row.artifact_id), ref.artifact_id],
    ["run_id", String(row.run_id), ref.run_id],
    ["phase", String(row.phase), ref.phase],
    ["branch_key", String(row.branch_key), ref.branch_id ?? ""],
    ["kind", String(row.kind), ref.kind],
    ["operation_id", String(row.operation_id), ref.operation_id],
    ["version", Number(row.version), ref.version],
    ["producer", String(row.producer), ref.producer],
    ["content_digest", String(row.content_digest), ref.content_digest],
    ["byte_length", Number(row.byte_length), ref.byte_length],
    ["store_ref", String(row.store_ref), ref.store_ref],
    ["metadata.run_id", metadata.run_id, ref.run_id],
    ["metadata.phase", metadata.phase, ref.phase],
    ["metadata.branch_id", metadata.branch_id, ref.branch_id],
    ["metadata.kind", metadata.kind, ref.kind],
    ["metadata.operation_id", metadata.operation_id, ref.operation_id],
    ["metadata.version", metadata.version, ref.version],
    ["metadata.producer", metadata.producer, ref.producer],
    ["metadata.media_type", metadata.media_type, ref.media_type],
  ];
  for (const [field, expected, actual] of comparisons) {
    if (expected !== actual) {
      throw new Error(`reconciled artifact row ${field} differs from its canonical ref`);
    }
  }
  return {
    artifact_id: ref.artifact_id,
    run_id: ref.run_id,
    phase: ref.phase,
    branch_key: ref.branch_id ?? "",
    kind: ref.kind,
    operation_id: ref.operation_id,
    version: ref.version,
    producer: ref.producer,
    content_digest: ref.content_digest,
    byte_length: ref.byte_length,
    store_ref: ref.store_ref,
    metadata_json: canonicalJson(metadata),
    ref_json: canonicalJson(ref),
    created_at: String(row.created_at),
  };
}

function assertArtifactSelectionRow(
  database: DatabaseSync,
  row: Record<string, SQLOutputValue>
): void {
  const artifact = database
    .prepare("SELECT run_id,phase,branch_key,kind,version FROM artifacts WHERE artifact_id=?")
    .get(sqlInput(row, "artifact_id", "artifact selection row"));
  if (artifact === undefined) {
    throw new Error("reconciled artifact selection references a missing artifact");
  }
  for (const field of ["run_id", "phase", "branch_key", "kind", "version"] as const) {
    if (artifact[field] !== row[field]) {
      throw new Error(`reconciled artifact selection ${field} differs from its artifact`);
    }
  }
}

function exactRowExists(
  database: DatabaseSync,
  table: string,
  columns: readonly string[],
  row: Record<string, SQLOutputValue>
): boolean {
  const where = columns.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ");
  const values = columns.map((column) => sqlInput(row, column, `${table} reconciliation row`));
  return (
    database
      .prepare(`SELECT 1 AS found FROM ${quoteIdentifier(table)} WHERE ${where}`)
      .get(...values) !== undefined
  );
}

function existingArtifactById(
  database: DatabaseSync,
  row: Record<string, SQLOutputValue>
): Record<string, SQLOutputValue> | undefined {
  return database
    .prepare("SELECT * FROM artifacts WHERE artifact_id=?")
    .get(sqlInput(row, "artifact_id", "artifact reconciliation row"));
}

function artifactRowsEquivalent(
  columns: readonly string[],
  left: Record<string, SQLOutputValue>,
  right: Record<string, SQLOutputValue>
): boolean {
  const semanticColumns = columns.filter((column) => column !== "created_at");
  return encodedRow(semanticColumns, left) === encodedRow(semanticColumns, right);
}

function existingSelection(
  database: DatabaseSync,
  row: Record<string, SQLOutputValue>
): Record<string, SQLOutputValue> | undefined {
  return database
    .prepare(
      "SELECT * FROM artifact_selections " +
        "WHERE run_id=? AND phase=? AND branch_key=? AND kind=?"
    )
    .get(
      sqlInput(row, "run_id", "artifact selection row"),
      sqlInput(row, "phase", "artifact selection row"),
      sqlInput(row, "branch_key", "artifact selection row"),
      sqlInput(row, "kind", "artifact selection row")
    );
}

function assertSourceProjectBinding(database: DatabaseSync, projectId: string): void {
  if (!userTables(database).includes("store_metadata")) return;
  const row = database
    .prepare("SELECT project_id,state_layout_version FROM store_metadata WHERE singleton=1")
    .get();
  if (row === undefined) return;
  if (String(row.project_id ?? "") !== projectId) {
    throw new Error("reconciliation source belongs to another Penny project");
  }
  if (Number(row.state_layout_version) !== PENNY_STATE_LAYOUT_VERSION) {
    throw new Error("reconciliation source has an unsupported state layout version");
  }
}

function insertRows(
  target: DatabaseSync,
  source: DatabaseSync,
  sourceId: string,
  strategy: SqliteReconciliationStrategy,
  selectionPolicy: ArtifactSelectionPolicy | undefined,
  resolutions: string[]
): number {
  const targetTables = new Set(userTables(target));
  let duplicates = 0;
  const tables = userTables(source).filter((table) => table !== "store_metadata");
  const ignoredArtifactTables = new Set(["artifact_materializations", "artifact_migrations"]);
  const orderedTables =
    strategy === "artifact-union"
      ? ["artifacts", "artifact_selections"].filter((table) => tables.includes(table))
      : tables;
  if (
    orderedTables.length + tables.filter((table) => ignoredArtifactTables.has(table)).length !==
    tables.length
  ) {
    throw new Error("artifact source manifest contains an unsupported table");
  }
  for (const table of orderedTables) {
    if (!targetTables.has(table)) {
      throw new Error(`reconciliation source contains unsupported table '${table}'`);
    }
    const rawSourceColumns = tableColumns(source, table);
    const targetColumnList = tableColumns(target, table);
    const targetColumns = new Set(targetColumnList);
    const legacyArtifactEnvelope =
      strategy === "artifact-union" &&
      table === "artifacts" &&
      rawSourceColumns.includes("envelope_json");
    const sourceColumns = legacyArtifactEnvelope ? targetColumnList : rawSourceColumns;
    if (sourceColumns.some((column) => !targetColumns.has(column))) {
      throw new Error(`reconciliation source table '${table}' has unsupported columns`);
    }
    const columnSql = sourceColumns.map(quoteIdentifier).join(", ");
    const placeholders = sourceColumns.map(() => "?").join(", ");
    const insert = target.prepare(
      `INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES (${placeholders})`
    );
    const rows = source.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
    for (const rawRow of rows) {
      const row = strategy === "artifact-union" ? normalizedArtifactRow(table, rawRow) : rawRow;
      if (strategy === "artifact-union" && table === "artifact_selections") {
        assertArtifactSelectionRow(target, row);
      }
      const values = sourceColumns.map((column) =>
        sqlInput(row, column, `${table} reconciliation source row`)
      );
      try {
        insert.run(...values);
      } catch (error) {
        if (exactRowExists(target, table, sourceColumns, row)) {
          duplicates += 1;
          continue;
        }
        if (strategy === "artifact-union" && table === "artifacts") {
          const existing = existingArtifactById(target, row);
          if (existing !== undefined && artifactRowsEquivalent(sourceColumns, existing, row)) {
            duplicates += 1;
            continue;
          }
        }
        if (strategy === "artifact-union" && table === "artifact_selections") {
          const existing = existingSelection(target, row);
          if (existing !== undefined && selectionPolicy === "prefer-precedence") {
            resolutions.push(
              stableJson({
                source_id: sourceId,
                table,
                rejected_row_sha256: createHash("sha256")
                  .update(encodedRow(sourceColumns, row))
                  .digest("hex"),
                retained_row_sha256: createHash("sha256")
                  .update(encodedRow(sourceColumns, existing))
                  .digest("hex"),
              })
            );
            continue;
          }
        }
        const rowCommitment = createHash("sha256")
          .update(encodedRow(sourceColumns, row))
          .digest("hex");
        throw new Error(
          `reconciliation collision in '${table}' from source '${sourceId}' (row ${rowCommitment})`,
          { cause: error }
        );
      }
    }
  }
  return duplicates;
}

/**
 * Build one canonical SQLite target from explicitly ordered sources. Sources are
 * copied into private temporary databases before schema upgrades, so source
 * bytes are never mutated by reconciliation.
 */
export function materializeReconciledSqlite(input: {
  readonly target: string;
  readonly strategy: SqliteReconciliationStrategy;
  readonly selectionPolicy?: ArtifactSelectionPolicy;
  readonly sources: readonly SqliteReconciliationSource[];
  readonly projectId: string;
  readonly bindingCreatedAt: string;
  readonly postprocess?: (target: string) => void;
}): SqliteReconciliationEvidence {
  if (input.sources.length < 2) throw new Error("reconciliation requires at least two sources");
  if (pathExistsNoFollow(input.target)) {
    throw new Error("reconciliation target already exists");
  }
  if (
    input.strategy === "artifact-union" &&
    input.selectionPolicy !== "require-identical" &&
    input.selectionPolicy !== "prefer-precedence"
  ) {
    throw new Error("artifact reconciliation requires an explicit selection policy");
  }
  if (input.strategy === "strict-union" && input.selectionPolicy !== undefined) {
    throw new Error("strict reconciliation cannot define an artifact selection policy");
  }

  const canonicalSources: Array<{ root: string; database: string; sourceId: string }> = [];
  const resolutions: string[] = [];
  let duplicateRows = 0;
  try {
    for (const source of input.sources) {
      const canonical = canonicalSourceCopy(source.path, input.strategy);
      canonicalSources.push({ ...canonical, sourceId: source.sourceId });
    }
    initializeTarget(input.target, input.strategy, input.projectId, input.bindingCreatedAt);
    const { DatabaseSync } = sqliteModule();
    const target = new DatabaseSync(input.target);
    try {
      target.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
      for (const source of canonicalSources) {
        const database = new DatabaseSync(source.database, { readOnly: true });
        try {
          database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
          assertSourceProjectBinding(database, input.projectId);
          duplicateRows += insertRows(
            target,
            database,
            source.sourceId,
            input.strategy,
            input.selectionPolicy,
            resolutions
          );
        } finally {
          database.close();
        }
      }
      target.exec("COMMIT; PRAGMA foreign_keys=ON;");
      if (target.prepare("PRAGMA foreign_key_check").all().length !== 0) {
        throw new Error("reconciled SQLite target failed foreign_key_check");
      }
      const integrity = target.prepare("PRAGMA integrity_check").get() as
        | Record<string, SQLOutputValue>
        | undefined;
      if (String(integrity?.integrity_check ?? "") !== "ok") {
        throw new Error("reconciled SQLite target failed integrity_check");
      }
    } catch (error) {
      try {
        target.exec("ROLLBACK");
      } catch {
        // The transaction may already have committed; the target is removed below.
      }
      throw error;
    } finally {
      target.close();
    }
    input.postprocess?.(input.target);
    chmodSync(input.target, 0o600);
    for (const suffix of ["-wal", "-shm"] as const) {
      if (existsSync(`${input.target}${suffix}`)) chmodSync(`${input.target}${suffix}`, 0o600);
    }
    fsyncDirectory(path.dirname(input.target));
    const targetEvidence = sqliteTargetEvidence(input.target);
    const sortedResolutions = resolutions.sort();
    return {
      strategy: input.strategy,
      ...(input.selectionPolicy === undefined ? {} : { selection_policy: input.selectionPolicy }),
      precedence: input.sources.map((source) => source.sourceId),
      source_count: input.sources.length,
      duplicate_row_count: duplicateRows,
      precedence_resolution_count: sortedResolutions.length,
      precedence_resolution_sha256:
        sortedResolutions.length === 0
          ? EMPTY_SHA256
          : createHash("sha256").update(sortedResolutions.join("\n")).digest("hex"),
      target_tables: targetEvidence.tables,
      target_logical_sha256: targetEvidence.logicalSha256,
    };
  } catch (error) {
    rmSync(input.target, { force: true });
    rmSync(`${input.target}-wal`, { force: true });
    rmSync(`${input.target}-shm`, { force: true });
    throw error;
  } finally {
    for (const source of canonicalSources) {
      rmSync(source.root, { recursive: true, force: true });
    }
  }
}
