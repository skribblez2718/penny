import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { migrationArtifactRef } from "./artifact-compat.js";
import {
  normalizeMigratedOrchestrationDatabase,
  verifyMigrationExecutionReceipt,
} from "./receipt-compat.js";
import { projectRootCommitment } from "./catalog.js";
import {
  assertOwnerFile,
  assertSafeAncestorChain,
  fsyncDirectory,
  pathExistsNoFollow,
} from "./custody.js";
import {
  PENNY_STATE_LAYOUT_VERSION,
  PROJECT_ID_PATTERN,
  resolvePennyStateRoot,
  type ResolvePennyStateRootOptions,
} from "./paths.js";
import {
  materializeReconciledSqlite,
  type ArtifactSelectionPolicy,
  type SqliteReconciliationEvidence,
  type SqliteReconciliationStrategy,
} from "./reconciliation.js";

export const STATE_MIGRATION_MANIFEST_VERSION = 1 as const;
export const STATE_MIGRATION_TOOL_VERSION = "1.2.0" as const;
const MIGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PATH_COMMITMENT_DOMAIN = "penny-migration-source-path-v1\0";

const STORE_KINDS = {
  "orchestration-db": "sqlite",
  "orchestration-receipt-key": "file",
  "orchestration-inputs": "tree",
  "artifact-manifest": "sqlite",
  "artifact-objects": "tree",
  "skill-chains": "tree",
  "subagent-sessions": "tree",
  "kb-profiles": "file",
  "kb-host-grants": "tree",
  "kb-capabilities": "tree",
  "kb-save-claims": "tree",
  "kb-operation-receipts": "tree",
  "kb-approval": "tree",
} as const;

export type MigrationStoreId = keyof typeof STORE_KINDS;
export type MigrationStoreKind = (typeof STORE_KINDS)[MigrationStoreId];

export interface SourceStoreCandidate {
  readonly sourceId: string;
  readonly path: string;
  readonly receiptKeyPath?: string;
}

export interface SourceStoreReconciliation {
  readonly strategy: SqliteReconciliationStrategy;
  readonly precedence: readonly string[];
  readonly selectionPolicy?: ArtifactSelectionPolicy;
}

export interface SourceStore {
  readonly id: MigrationStoreId;
  readonly kind: MigrationStoreKind;
  /** Primary path retained for the single-source copy path and explicit precedence winner. */
  readonly path: string;
  /** Explicit relative SQLite members for tree stores; WAL/SHM are never copied as files. */
  readonly sqliteFiles: readonly string[];
  readonly candidates: readonly SourceStoreCandidate[];
  readonly reconciliation?: SourceStoreReconciliation;
}

export interface SourceManifest {
  readonly schema_version: 1;
  readonly migration_id: string;
  readonly stores: readonly SourceStore[];
}

export interface FileSnapshot {
  readonly size: number;
  readonly sha256: string;
  readonly mode: string;
  readonly mtime_ms: number;
}

export type TreeEntrySnapshot =
  | (FileSnapshot & {
      readonly kind: "file";
      readonly relative_path_commitment: string;
      readonly target_size?: number;
      readonly target_sha256?: string;
    })
  | {
      readonly kind: "sqlite";
      readonly relative_path_commitment: string;
      readonly database: FileSnapshot;
      readonly wal: FileSnapshot | null;
      readonly sqlite: SqliteSnapshot;
    };

export interface SqliteSnapshot {
  readonly user_version: number;
  readonly quick_check: string;
  readonly foreign_key_violation_count: number;
  readonly tables: readonly { readonly name: string; readonly row_count: number }[];
}

export type MigrationSourceSnapshot =
  | { readonly kind: "file"; readonly file: FileSnapshot }
  | {
      readonly kind: "tree";
      readonly file_count: number;
      readonly total_bytes: number;
      readonly tree_sha256: string;
      readonly files: readonly TreeEntrySnapshot[];
    }
  | {
      readonly kind: "sqlite";
      readonly database: FileSnapshot;
      readonly wal: FileSnapshot | null;
      readonly sqlite: SqliteSnapshot;
    };

export interface MigrationPlanSourceCandidate {
  readonly source_id: string;
  readonly source_path_commitment: string;
  readonly source_snapshot: Extract<MigrationSourceSnapshot, { kind: "sqlite" }>;
  readonly receipt_key_sha256?: string;
}

export interface MigrationPlanStore {
  readonly id: MigrationStoreId;
  readonly kind: MigrationStoreKind;
  readonly source_path_commitment: string;
  readonly source_snapshot: MigrationSourceSnapshot;
  readonly source_candidates?: readonly MigrationPlanSourceCandidate[];
  readonly reconciliation?: SqliteReconciliationEvidence;
}

export interface StateMigrationPlan {
  readonly schema_version: 1;
  readonly migration_tool_version: typeof STATE_MIGRATION_TOOL_VERSION;
  readonly migration_id: string;
  readonly phase: "planned";
  readonly generated_at: string;
  readonly source_manifest_sha256: string;
  readonly project_root_commitment: string;
  readonly state_root_commitment: string;
  readonly target_layout_version: number;
  readonly target_project_id: string;
  readonly stores: readonly MigrationPlanStore[];
  readonly plan_sha256: string;
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

function sqliteModule(): SqliteModule {
  const module = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) throw new Error("Node.js runtime does not provide node:sqlite");
  return module;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isMigrationStoreId(value: unknown): value is MigrationStoreId {
  return typeof value === "string" && Object.hasOwn(STORE_KINDS, value);
}

function isArtifactSelectionPolicy(value: unknown): value is ArtifactSelectionPolicy {
  return value === "require-identical" || value === "prefer-precedence";
}

function closedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(`${label} has unknown fields: ${unknown.sort().join(", ")}`);
}

export function parseSourceManifest(value: unknown): SourceManifest {
  const record = asRecord(value, "migration source manifest");
  closedKeys(record, ["schema_version", "migration_id", "stores"], "migration source manifest");
  if (record.schema_version !== STATE_MIGRATION_MANIFEST_VERSION) {
    throw new Error("unsupported migration source manifest version");
  }
  if (typeof record.migration_id !== "string" || !MIGRATION_ID_PATTERN.test(record.migration_id)) {
    throw new Error("migration_id is not canonical");
  }
  if (!Array.isArray(record.stores) || record.stores.length === 0) {
    throw new Error("migration source manifest must contain at least one store");
  }
  const stores = record.stores.map((value, index): SourceStore => {
    const label = `migration source store ${index}`;
    const store = asRecord(value, label);
    closedKeys(store, ["id", "kind", "path", "sqlite_files", "sources", "reconciliation"], label);
    if (!isMigrationStoreId(store.id)) {
      throw new Error(`${label} has an unknown ID`);
    }
    const id = store.id;
    const expectedKind = STORE_KINDS[id];
    if (store.kind !== expectedKind) {
      throw new Error(`migration source store '${id}' must use kind '${expectedKind}'`);
    }

    if (store.sources !== undefined || store.reconciliation !== undefined) {
      if (store.path !== undefined || store.sqlite_files !== undefined) {
        throw new Error(`migration source store '${id}' mixes single and reconciled sources`);
      }
      if (expectedKind !== "sqlite" || (id !== "orchestration-db" && id !== "artifact-manifest")) {
        throw new Error(`migration source store '${id}' does not support reconciliation`);
      }
      if (!Array.isArray(store.sources) || store.sources.length < 2) {
        throw new Error(`migration source store '${id}' reconciliation requires two sources`);
      }
      const candidates = store.sources.map((value, sourceIndex): SourceStoreCandidate => {
        const sourceLabel = `migration source store '${id}' source ${sourceIndex}`;
        const source = asRecord(value, sourceLabel);
        closedKeys(source, ["source_id", "path", "receipt_key_path"], sourceLabel);
        if (typeof source.source_id !== "string" || !SOURCE_ID_PATTERN.test(source.source_id)) {
          throw new Error(`${sourceLabel} source_id is not canonical`);
        }
        if (typeof source.path !== "string" || !path.isAbsolute(source.path)) {
          throw new Error(`${sourceLabel} path must be absolute`);
        }
        if (
          source.receipt_key_path !== undefined &&
          (id !== "orchestration-db" ||
            typeof source.receipt_key_path !== "string" ||
            !path.isAbsolute(source.receipt_key_path))
        ) {
          throw new Error(`${sourceLabel} receipt_key_path is invalid`);
        }
        return {
          sourceId: source.source_id,
          path: path.normalize(source.path),
          ...(source.receipt_key_path === undefined
            ? {}
            : { receiptKeyPath: path.normalize(String(source.receipt_key_path)) }),
        };
      });
      if (new Set(candidates.map((candidate) => candidate.sourceId)).size !== candidates.length) {
        throw new Error(`migration source store '${id}' has duplicate source IDs`);
      }
      if (new Set(candidates.map((candidate) => candidate.path)).size !== candidates.length) {
        throw new Error(`migration source store '${id}' has duplicate source paths`);
      }
      const reconciliation = asRecord(
        store.reconciliation,
        `migration source store '${id}' reconciliation`
      );
      closedKeys(
        reconciliation,
        ["strategy", "precedence", "selection_policy"],
        `migration source store '${id}' reconciliation`
      );
      const expectedStrategy: SqliteReconciliationStrategy =
        id === "orchestration-db" ? "strict-union" : "artifact-union";
      if (reconciliation.strategy !== expectedStrategy) {
        throw new Error(
          `migration source store '${id}' must use reconciliation strategy '${expectedStrategy}'`
        );
      }
      if (
        !Array.isArray(reconciliation.precedence) ||
        reconciliation.precedence.length !== candidates.length ||
        reconciliation.precedence.some(
          (sourceId) => typeof sourceId !== "string" || !SOURCE_ID_PATTERN.test(sourceId)
        )
      ) {
        throw new Error(`migration source store '${id}' precedence is invalid`);
      }
      const precedence = reconciliation.precedence.filter(
        (sourceId): sourceId is string => typeof sourceId === "string"
      );
      if (
        new Set(precedence).size !== precedence.length ||
        precedence.some(
          (sourceId) => !candidates.some((candidate) => candidate.sourceId === sourceId)
        )
      ) {
        throw new Error(`migration source store '${id}' precedence must list every source once`);
      }
      const rawSelectionPolicy = reconciliation.selection_policy;
      const selectionPolicy =
        rawSelectionPolicy === undefined
          ? undefined
          : isArtifactSelectionPolicy(rawSelectionPolicy)
            ? rawSelectionPolicy
            : undefined;
      if (
        (id === "artifact-manifest" && selectionPolicy === undefined) ||
        (id === "orchestration-db" && rawSelectionPolicy !== undefined)
      ) {
        throw new Error(`migration source store '${id}' selection policy is invalid`);
      }
      const ordered = precedence.map((sourceId) => {
        const candidate = candidates.find((value) => value.sourceId === sourceId);
        if (candidate === undefined) throw new Error("reconciliation precedence is inconsistent");
        return candidate;
      });
      const primary = ordered[0];
      if (primary === undefined) throw new Error("reconciliation has no primary source");
      return {
        id,
        kind: expectedKind,
        path: primary.path,
        sqliteFiles: [],
        candidates: ordered,
        reconciliation: {
          strategy: expectedStrategy,
          precedence,
          ...(selectionPolicy === undefined ? {} : { selectionPolicy }),
        },
      };
    }

    if (typeof store.path !== "string" || !path.isAbsolute(store.path)) {
      throw new Error(`migration source store '${id}' path must be absolute`);
    }
    const sqliteFiles =
      store.sqlite_files === undefined
        ? []
        : Array.isArray(store.sqlite_files)
          ? store.sqlite_files.map((value, sqliteIndex) => {
              if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
                throw new Error(
                  `migration source store '${id}' sqlite_files[${sqliteIndex}] is invalid`
                );
              }
              const normalized = path.normalize(value);
              if (
                normalized === "." ||
                normalized === ".." ||
                normalized.startsWith(`..${path.sep}`)
              ) {
                throw new Error(`migration source store '${id}' sqlite_files escapes its tree`);
              }
              return normalized;
            })
          : (() => {
              throw new Error(`migration source store '${id}' sqlite_files must be an array`);
            })();
    if (expectedKind !== "tree" && sqliteFiles.length !== 0) {
      throw new Error(`migration source store '${id}' cannot declare sqlite_files`);
    }
    if (new Set(sqliteFiles).size !== sqliteFiles.length) {
      throw new Error(`migration source store '${id}' has duplicate sqlite_files`);
    }
    const normalizedPath = path.normalize(store.path);
    return {
      id,
      kind: expectedKind,
      path: normalizedPath,
      sqliteFiles,
      candidates: [{ sourceId: id, path: normalizedPath }],
    };
  });
  if (new Set(stores.map((store) => store.id)).size !== stores.length) {
    throw new Error("migration source manifest contains duplicate store IDs");
  }
  return {
    schema_version: STATE_MIGRATION_MANIFEST_VERSION,
    migration_id: record.migration_id,
    stores,
  };
}

export function migrationSha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function pathCommitment(candidate: string): string {
  return `path_${migrationSha256(`${PATH_COMMITMENT_DOMAIN}${path.normalize(candidate)}`)}`;
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

export function snapshotFile(candidate: string, label: string): FileSnapshot {
  assertSafeAncestorChain(path.dirname(candidate), label);
  assertOwnerFile(candidate, label);
  const stat = lstatSync(candidate);
  const bytes = readFileSync(candidate);
  return {
    size: bytes.length,
    sha256: migrationSha256(bytes),
    mode: modeString(stat.mode),
    mtime_ms: Math.trunc(stat.mtimeMs),
  };
}

function sqliteLikeTreeEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".db") ||
    lower.endsWith(".sqlite") ||
    lower.endsWith(".sqlite3") ||
    lower.endsWith("-wal") ||
    lower.endsWith("-shm")
  );
}

export interface SnapshotTreeOptions {
  readonly sqliteFiles?: readonly string[];
  readonly sqlitePathCommitments?: readonly string[];
  readonly transformFile?: (relativePath: string, bytes: Buffer) => Buffer | undefined;
}

export function snapshotTree(
  root: string,
  label: string,
  options: SnapshotTreeOptions = {}
): Extract<MigrationPlanStore["source_snapshot"], { kind: "tree" }> {
  assertSafeAncestorChain(root, label);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if ((rootStat.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`);
  const uid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (uid !== undefined && rootStat.uid !== uid) throw new Error(`${label} has the wrong owner`);

  const sqliteFiles = new Set(options.sqliteFiles ?? []);
  const sqliteCommitments = new Set(options.sqlitePathCommitments ?? []);
  const observedSqliteFiles = new Set<string>();
  const files: Array<{ snapshot: TreeEntrySnapshot; relativePath: string }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const candidate = path.join(directory, entry.name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
      if (entry.isDirectory()) {
        if ((stat.mode & 0o077) !== 0) throw new Error(`${label} contains a broad-mode directory`);
        if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} has the wrong owner`);
        walk(candidate);
        continue;
      }
      if (!entry.isFile() || stat.nlink !== 1) {
        throw new Error(`${label} contains an unsafe non-regular file`);
      }
      const relativePath = path.relative(root, candidate);
      const relativeCommitment = pathCommitment(relativePath);
      const sidecarSuffix = relativePath.endsWith("-wal")
        ? "-wal"
        : relativePath.endsWith("-shm")
          ? "-shm"
          : undefined;
      if (sidecarSuffix !== undefined) {
        const databaseRelativePath = relativePath.slice(0, -sidecarSuffix.length);
        if (
          sqliteFiles.has(databaseRelativePath) ||
          sqliteCommitments.has(pathCommitment(databaseRelativePath))
        ) {
          snapshotFile(candidate, `${label} SQLite sidecar`);
          continue;
        }
      }
      const isSqlite = sqliteFiles.has(relativePath) || sqliteCommitments.has(relativeCommitment);
      if (isSqlite) {
        const sqlite = snapshotSqlite(candidate, `${label} SQLite file`);
        observedSqliteFiles.add(relativePath);
        files.push({
          relativePath,
          snapshot: {
            kind: "sqlite",
            relative_path_commitment: relativeCommitment,
            database: sqlite.database,
            wal: sqlite.wal,
            sqlite: sqlite.sqlite,
          },
        });
        continue;
      }
      if (sqliteLikeTreeEntry(entry.name)) {
        throw new Error(
          `${label} contains SQLite state not listed in the source manifest: ${relativePath}`
        );
      }
      const fileSnapshot = snapshotFile(candidate, `${label} file`);
      const transformed = options.transformFile?.(relativePath, readFileSync(candidate));
      files.push({
        relativePath,
        snapshot: {
          kind: "file",
          ...fileSnapshot,
          relative_path_commitment: relativeCommitment,
          ...(transformed === undefined
            ? {}
            : {
                target_size: transformed.length,
                target_sha256: migrationSha256(transformed),
              }),
        },
      });
    }
  };
  walk(root);
  for (const sqliteFile of sqliteFiles) {
    if (!observedSqliteFiles.has(sqliteFile)) {
      throw new Error(`${label} declared missing SQLite file: ${sqliteFile}`);
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const digestInput = files
    .map((file) => `${file.relativePath}\0${migrationCanonicalJson(file.snapshot)}\n`)
    .join("");
  const totalBytes = files.reduce((total, file) => {
    if (file.snapshot.kind === "file") return total + file.snapshot.size;
    return total + file.snapshot.database.size + (file.snapshot.wal?.size ?? 0);
  }, 0);
  return {
    kind: "tree",
    file_count: files.length,
    total_bytes: totalBytes,
    tree_sha256: migrationSha256(digestInput),
    files: files.map((file) => file.snapshot),
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function inspectSqlite(databasePath: string): SqliteSnapshot {
  const scratch = mkdtempSync(path.join(tmpdir(), "penny-migration-sqlite-plan-"));
  const scratchDatabase = path.join(scratch, "source.db");
  copyFileSync(databasePath, scratchDatabase, constants.COPYFILE_EXCL);
  const sourceWal = `${databasePath}-wal`;
  if (pathExistsNoFollow(sourceWal)) {
    copyFileSync(sourceWal, `${scratchDatabase}-wal`, constants.COPYFILE_EXCL);
  }

  const { DatabaseSync } = sqliteModule();
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(scratchDatabase, { readOnly: true });
    database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    const quick = database.prepare("PRAGMA quick_check").get();
    const quickCheck = String(quick?.quick_check ?? "");
    if (quickCheck !== "ok") throw new Error("SQLite source failed quick_check");
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    const version = database.prepare("PRAGMA user_version").get();
    const tableRows = database
      .prepare(
        "SELECT name FROM sqlite_master " +
          "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all();
    const openedDatabase = database;
    const tables = tableRows.map((row) => {
      const name = String(row.name);
      const count = openedDatabase
        .prepare(`SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(name)}`)
        .get();
      if (count === undefined) throw new Error(`SQLite source table '${name}' has no count row`);
      return { name, row_count: Number(count.row_count) };
    });
    return {
      user_version: Number(version?.user_version ?? 0),
      quick_check: quickCheck,
      foreign_key_violation_count: foreignKeyViolations.length,
      tables,
    };
  } finally {
    database?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function snapshotSqlite(
  candidate: string,
  label: string
): Extract<MigrationPlanStore["source_snapshot"], { kind: "sqlite" }> {
  const beforeDatabase = snapshotFile(candidate, label);
  const walPath = `${candidate}-wal`;
  const beforeWal = pathExistsNoFollow(walPath) ? snapshotFile(walPath, `${label} WAL`) : null;
  const sqlite = inspectSqlite(candidate);
  const afterDatabase = snapshotFile(candidate, label);
  const afterWal = pathExistsNoFollow(walPath) ? snapshotFile(walPath, `${label} WAL`) : null;
  if (
    beforeDatabase.sha256 !== afterDatabase.sha256 ||
    beforeDatabase.size !== afterDatabase.size ||
    beforeWal?.sha256 !== afterWal?.sha256 ||
    beforeWal?.size !== afterWal?.size
  ) {
    throw new Error(`${label} changed during planning; quiesce writers and retry`);
  }
  return { kind: "sqlite", database: afterDatabase, wal: afterWal, sqlite };
}

export function migrationCanonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (isUnknownRecord(input)) {
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

function writeOwnerPlan(outputPath: string, plan: StateMigrationPlan): void {
  if (!path.isAbsolute(outputPath)) throw new Error("migration plan output path must be absolute");
  const parent = path.dirname(outputPath);
  assertSafeAncestorChain(parent, "migration plan output");
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("migration plan output parent must be a non-symlink directory");
  }
  const descriptor = openSync(
    outputPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(parent);
  assertOwnerFile(outputPath, "migration plan");
}

function sourceManifestBytes(sourceManifestPath: string): Buffer {
  if (!path.isAbsolute(sourceManifestPath)) {
    throw new Error("migration source manifest path must be absolute");
  }
  assertOwnerFile(sourceManifestPath, "migration source manifest");
  return readFileSync(sourceManifestPath);
}

export function readMigrationSourceManifest(sourceManifestPath: string): {
  readonly manifest: SourceManifest;
  readonly sha256: string;
} {
  const bytes = sourceManifestBytes(sourceManifestPath);
  return {
    manifest: parseSourceManifest(JSON.parse(bytes.toString("utf8"))),
    sha256: migrationSha256(bytes),
  };
}

const CHAIN_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ARTIFACT_ID_PATTERN = /^art_[a-f0-9]{64}$/u;

function normalizeChainArtifactRef(
  value: unknown,
  label: string
): ReturnType<typeof migrationArtifactRef> {
  const ref = asRecord(value, label);
  if (typeof ref.artifact_id !== "string" || !ARTIFACT_ID_PATTERN.test(ref.artifact_id)) {
    throw new Error(`${label}.artifact_id is invalid`);
  }
  return migrationArtifactRef(value, label);
}

/** Migration-only normalization from the XDG chain schema to project-bound schema v1. */
export function transformSkillChainCheckpoint(
  relativePath: string,
  bytes: Buffer,
  projectId: string
): Buffer {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("chain target project ID is invalid");
  if (path.dirname(relativePath) !== "." || path.extname(relativePath) !== ".json") {
    throw new Error("skill-chain source contains an unexpected non-root JSON file");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("skill-chain checkpoint is not valid JSON");
  }
  const record = asRecord(value, "skill-chain checkpoint");
  if (record.schema_version !== 1) throw new Error("unsupported skill-chain checkpoint schema");
  if (
    typeof record.chain_session_id !== "string" ||
    !CHAIN_SESSION_ID_PATTERN.test(record.chain_session_id) ||
    record.chain_run_id !== record.chain_session_id
  ) {
    throw new Error("skill-chain checkpoint identity is invalid");
  }
  if (relativePath !== `${record.chain_session_id}.json`) {
    throw new Error("skill-chain checkpoint filename does not match its identity");
  }
  if (
    record.state_layout_version !== undefined &&
    record.state_layout_version !== PENNY_STATE_LAYOUT_VERSION
  ) {
    throw new Error("skill-chain checkpoint layout version is unsupported");
  }
  if (record.project_id !== undefined && record.project_id !== projectId) {
    throw new Error("skill-chain checkpoint belongs to another Penny project");
  }
  if (!Array.isArray(record.steps) || !Array.isArray(record.pending_steps)) {
    throw new Error("skill-chain checkpoint steps are invalid");
  }
  const seen = new Set<number>();
  const normalizedSteps = record.steps.map((value, index) => {
    const step = asRecord(value, `skill-chain checkpoint step ${index}`);
    if (
      !Number.isSafeInteger(step.index) ||
      Number(step.index) < 0 ||
      seen.has(Number(step.index))
    ) {
      throw new Error("skill-chain checkpoint step index is invalid");
    }
    seen.add(Number(step.index));
    if (
      step.status !== "pending" &&
      step.status !== "running" &&
      step.status !== "complete" &&
      step.status !== "failed"
    ) {
      throw new Error("skill-chain checkpoint step status is invalid");
    }
    const outputRef =
      step.output_artifact_ref === undefined
        ? undefined
        : normalizeChainArtifactRef(step.output_artifact_ref, "skill-chain output_artifact_ref");
    const handoffRef =
      step.handoff_artifact_ref === undefined
        ? undefined
        : normalizeChainArtifactRef(step.handoff_artifact_ref, "skill-chain handoff_artifact_ref");
    if (
      step.input_artifacts !== undefined &&
      (!Array.isArray(step.input_artifacts) ||
        new Set(step.input_artifacts).size !== step.input_artifacts.length ||
        step.input_artifacts.some(
          (artifactId) => typeof artifactId !== "string" || !ARTIFACT_ID_PATTERN.test(artifactId)
        ))
    ) {
      throw new Error("skill-chain checkpoint input artifacts are invalid");
    }
    return {
      ...step,
      ...(outputRef === undefined ? {} : { output_artifact_ref: outputRef }),
      ...(handoffRef === undefined ? {} : { handoff_artifact_ref: handoffRef }),
    };
  });
  for (const [index, value] of record.pending_steps.entries()) {
    const step = asRecord(value, `skill-chain pending step ${index}`);
    if (!Number.isSafeInteger(step.index) || Number(step.index) < 0) {
      throw new Error("skill-chain pending step index is invalid");
    }
    if (
      step.input_artifacts !== undefined &&
      (!Array.isArray(step.input_artifacts) ||
        new Set(step.input_artifacts).size !== step.input_artifacts.length ||
        step.input_artifacts.some(
          (artifactId) => typeof artifactId !== "string" || !ARTIFACT_ID_PATTERN.test(artifactId)
        ))
    ) {
      throw new Error("skill-chain pending input artifacts are invalid");
    }
  }
  if (
    !Number.isSafeInteger(record.total_steps) ||
    Number(record.total_steps) !== record.steps.length ||
    !Number.isSafeInteger(record.current_step) ||
    Number(record.current_step) < 0 ||
    Number(record.current_step) > Number(record.total_steps)
  ) {
    throw new Error("skill-chain checkpoint progress is invalid");
  }
  if (
    record.chain_status !== "running" &&
    record.chain_status !== "failed" &&
    record.chain_status !== "complete"
  ) {
    throw new Error("skill-chain checkpoint status is invalid");
  }
  const transformed = {
    ...record,
    state_layout_version: PENNY_STATE_LAYOUT_VERSION,
    project_id: projectId,
    steps: normalizedSteps,
  };
  return Buffer.from(`${JSON.stringify(transformed, null, 2)}\n`, "utf8");
}

function inspectReceiptAuthority(
  candidate: SourceStoreCandidate,
  snapshot: Extract<MigrationSourceSnapshot, { kind: "sqlite" }>
): string | undefined {
  const receiptCount =
    snapshot.sqlite.tables.find((table) => table.name === "receipts")?.row_count ?? 0;
  if (candidate.receiptKeyPath === undefined) {
    if (receiptCount !== 0) {
      throw new Error(
        `orchestration source '${candidate.sourceId}' has receipts but no receipt_key_path`
      );
    }
    return undefined;
  }
  const keySnapshot = snapshotFile(candidate.receiptKeyPath, "orchestration source receipt key");
  if (receiptCount === 0) return keySnapshot.sha256;

  const scratch = mkdtempSync(path.join(tmpdir(), "penny-migration-receipts-plan-"));
  const databasePath = path.join(scratch, "source.db");
  try {
    copyFileSync(candidate.path, databasePath, constants.COPYFILE_EXCL);
    const wal = `${candidate.path}-wal`;
    if (pathExistsNoFollow(wal)) {
      copyFileSync(wal, `${databasePath}-wal`, constants.COPYFILE_EXCL);
    }
    const { DatabaseSync } = sqliteModule();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const rows = database.prepare("SELECT result_json FROM receipts ORDER BY receipt_id").all();
      for (const row of rows) {
        const result: unknown = JSON.parse(String(row.result_json));
        const receipt =
          result !== null && typeof result === "object" && "worker_receipt" in result
            ? result.worker_receipt
            : result;
        verifyMigrationExecutionReceipt(receipt, candidate.receiptKeyPath);
      }
    } finally {
      database.close();
    }
    return keySnapshot.sha256;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function inspectMigrationStores(
  source: SourceManifest,
  options: { readonly targetProjectId?: string; readonly bindingCreatedAt?: string } = {}
): readonly MigrationPlanStore[] {
  const stores = source.stores.map((store): MigrationPlanStore => {
    const sourcePathCommitment = pathCommitment(store.path);
    if (store.kind === "file") {
      return {
        id: store.id,
        kind: store.kind,
        source_path_commitment: sourcePathCommitment,
        source_snapshot: { kind: "file", file: snapshotFile(store.path, store.id) },
      };
    }
    if (store.kind === "tree") {
      return {
        id: store.id,
        kind: store.kind,
        source_path_commitment: sourcePathCommitment,
        source_snapshot: snapshotTree(store.path, store.id, {
          sqliteFiles: store.sqliteFiles,
          ...(store.id === "skill-chains"
            ? {
                transformFile: (relativePath, bytes) => {
                  if (options.targetProjectId === undefined) {
                    throw new Error("skill-chain planning requires a target project ID");
                  }
                  return transformSkillChainCheckpoint(
                    relativePath,
                    bytes,
                    options.targetProjectId
                  );
                },
              }
            : {}),
        }),
      };
    }
    if (store.reconciliation !== undefined) {
      if (options.targetProjectId === undefined || options.bindingCreatedAt === undefined) {
        throw new Error("reconciliation planning requires target binding metadata");
      }
      const sourceCandidates = store.candidates.map((candidate): MigrationPlanSourceCandidate => {
        const candidateSnapshot = snapshotSqlite(
          candidate.path,
          `${store.id} source '${candidate.sourceId}'`
        );
        const receiptKeySha256 =
          store.id === "orchestration-db"
            ? inspectReceiptAuthority(candidate, candidateSnapshot)
            : undefined;
        return {
          source_id: candidate.sourceId,
          source_path_commitment: pathCommitment(candidate.path),
          source_snapshot: candidateSnapshot,
          ...(receiptKeySha256 === undefined ? {} : { receipt_key_sha256: receiptKeySha256 }),
        };
      });
      const scratch = mkdtempSync(path.join(tmpdir(), "penny-migration-reconcile-plan-"));
      try {
        const target =
          store.id === "artifact-manifest"
            ? path.join(scratch, "artifacts", "manifest.db")
            : path.join(scratch, "orchestration.db");
        const reconciliation = materializeReconciledSqlite({
          target,
          strategy: store.reconciliation.strategy,
          ...(store.reconciliation.selectionPolicy === undefined
            ? {}
            : { selectionPolicy: store.reconciliation.selectionPolicy }),
          sources: store.candidates.map((candidate) => ({
            sourceId: candidate.sourceId,
            path: candidate.path,
          })),
          projectId: options.targetProjectId,
          bindingCreatedAt: options.bindingCreatedAt,
          ...(store.id === "orchestration-db"
            ? {
                postprocess: (databasePath: string) => {
                  const keyPath = store.candidates.find(
                    (candidate) => candidate.receiptKeyPath !== undefined
                  )?.receiptKeyPath;
                  if (keyPath !== undefined) {
                    normalizeMigratedOrchestrationDatabase(databasePath, keyPath);
                  }
                },
              }
            : {}),
        });
        const afterCandidates = store.candidates.map((candidate): MigrationPlanSourceCandidate => {
          const candidateSnapshot = snapshotSqlite(
            candidate.path,
            `${store.id} source '${candidate.sourceId}'`
          );
          const receiptKeySha256 =
            store.id === "orchestration-db"
              ? inspectReceiptAuthority(candidate, candidateSnapshot)
              : undefined;
          return {
            source_id: candidate.sourceId,
            source_path_commitment: pathCommitment(candidate.path),
            source_snapshot: candidateSnapshot,
            ...(receiptKeySha256 === undefined ? {} : { receipt_key_sha256: receiptKeySha256 }),
          };
        });
        if (migrationCanonicalJson(afterCandidates) !== migrationCanonicalJson(sourceCandidates)) {
          throw new Error(`${store.id} source changed during reconciliation planning`);
        }
        const primary = sourceCandidates[0];
        if (primary === undefined) throw new Error("reconciliation has no primary source");
        return {
          id: store.id,
          kind: store.kind,
          source_path_commitment: primary.source_path_commitment,
          source_snapshot: primary.source_snapshot,
          source_candidates: sourceCandidates,
          reconciliation,
        };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    return {
      id: store.id,
      kind: store.kind,
      source_path_commitment: sourcePathCommitment,
      source_snapshot: snapshotSqlite(store.path, store.id),
    };
  });

  const receiptKeyStore = stores.find((store) => store.id === "orchestration-receipt-key");
  const receiptKeySha256 =
    receiptKeyStore?.source_snapshot.kind === "file"
      ? receiptKeyStore.source_snapshot.file.sha256
      : undefined;
  const orchestration = stores.find((store) => store.id === "orchestration-db");
  for (const candidate of orchestration?.source_candidates ?? []) {
    const receiptCount =
      candidate.source_snapshot.sqlite.tables.find((table) => table.name === "receipts")
        ?.row_count ?? 0;
    if (receiptCount !== 0 && candidate.receipt_key_sha256 !== receiptKeySha256) {
      throw new Error(
        `orchestration source '${candidate.source_id}' receipt authority cannot be represented by the target key`
      );
    }
  }
  return stores;
}

function parseFileSnapshot(value: unknown, label: string): FileSnapshot {
  const record = asRecord(value, label);
  closedKeys(record, ["size", "sha256", "mode", "mtime_ms"], label);
  if (!Number.isSafeInteger(record.size) || Number(record.size) < 0) {
    throw new Error(`${label}.size is invalid`);
  }
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
    throw new Error(`${label}.sha256 is invalid`);
  }
  if (typeof record.mode !== "string" || !/^0[0-7]{3}$/u.test(record.mode)) {
    throw new Error(`${label}.mode is invalid`);
  }
  if (!Number.isSafeInteger(record.mtime_ms) || Number(record.mtime_ms) < 0) {
    throw new Error(`${label}.mtime_ms is invalid`);
  }
  return {
    size: Number(record.size),
    sha256: record.sha256,
    mode: record.mode,
    mtime_ms: Number(record.mtime_ms),
  };
}

function parseSqliteSnapshot(value: unknown, label: string): SqliteSnapshot {
  const record = asRecord(value, label);
  closedKeys(
    record,
    ["user_version", "quick_check", "foreign_key_violation_count", "tables"],
    label
  );
  if (!Number.isSafeInteger(record.user_version) || Number(record.user_version) < 0) {
    throw new Error(`${label}.user_version is invalid`);
  }
  if (record.quick_check !== "ok") throw new Error(`${label}.quick_check is invalid`);
  if (
    !Number.isSafeInteger(record.foreign_key_violation_count) ||
    Number(record.foreign_key_violation_count) !== 0
  ) {
    throw new Error(`${label}.foreign_key_violation_count is invalid`);
  }
  if (!Array.isArray(record.tables)) throw new Error(`${label}.tables is invalid`);
  const tables = record.tables.map((value, index) => {
    const table = asRecord(value, `${label}.tables[${index}]`);
    closedKeys(table, ["name", "row_count"], `${label}.tables[${index}]`);
    if (typeof table.name !== "string" || table.name.length === 0) {
      throw new Error(`${label}.tables[${index}].name is invalid`);
    }
    if (!Number.isSafeInteger(table.row_count) || Number(table.row_count) < 0) {
      throw new Error(`${label}.tables[${index}].row_count is invalid`);
    }
    return { name: table.name, row_count: Number(table.row_count) };
  });
  if (new Set(tables.map((table) => table.name)).size !== tables.length) {
    throw new Error(`${label}.tables contains duplicate names`);
  }
  return {
    user_version: Number(record.user_version),
    quick_check: "ok",
    foreign_key_violation_count: 0,
    tables,
  };
}

function parseReconciliationEvidence(value: unknown, label: string): SqliteReconciliationEvidence {
  const record = asRecord(value, label);
  closedKeys(
    record,
    [
      "strategy",
      "selection_policy",
      "precedence",
      "source_count",
      "duplicate_row_count",
      "precedence_resolution_count",
      "precedence_resolution_sha256",
      "target_tables",
      "target_logical_sha256",
    ],
    label
  );
  if (record.strategy !== "strict-union" && record.strategy !== "artifact-union") {
    throw new Error(`${label}.strategy is invalid`);
  }
  if (
    record.selection_policy !== undefined &&
    record.selection_policy !== "require-identical" &&
    record.selection_policy !== "prefer-precedence"
  ) {
    throw new Error(`${label}.selection_policy is invalid`);
  }
  if (
    (record.strategy === "artifact-union" && record.selection_policy === undefined) ||
    (record.strategy === "strict-union" && record.selection_policy !== undefined)
  ) {
    throw new Error(`${label}.selection_policy does not match its strategy`);
  }
  if (
    !Array.isArray(record.precedence) ||
    record.precedence.length < 2 ||
    record.precedence.some(
      (sourceId) => typeof sourceId !== "string" || !SOURCE_ID_PATTERN.test(sourceId)
    ) ||
    new Set(record.precedence).size !== record.precedence.length
  ) {
    throw new Error(`${label}.precedence is invalid`);
  }
  for (const field of [
    "source_count",
    "duplicate_row_count",
    "precedence_resolution_count",
  ] as const) {
    if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0) {
      throw new Error(`${label}.${field} is invalid`);
    }
  }
  if (Number(record.source_count) !== record.precedence.length) {
    throw new Error(`${label}.source_count is inconsistent`);
  }
  for (const field of ["precedence_resolution_sha256", "target_logical_sha256"] as const) {
    if (typeof record[field] !== "string" || !/^[a-f0-9]{64}$/u.test(record[field])) {
      throw new Error(`${label}.${field} is invalid`);
    }
  }
  if (!Array.isArray(record.target_tables)) throw new Error(`${label}.target_tables is invalid`);
  const targetTables = record.target_tables.map((value, index) => {
    const tableLabel = `${label}.target_tables[${index}]`;
    const table = asRecord(value, tableLabel);
    closedKeys(table, ["name", "row_count", "rows_sha256"], tableLabel);
    if (typeof table.name !== "string" || table.name.length === 0) {
      throw new Error(`${tableLabel}.name is invalid`);
    }
    if (!Number.isSafeInteger(table.row_count) || Number(table.row_count) < 0) {
      throw new Error(`${tableLabel}.row_count is invalid`);
    }
    if (typeof table.rows_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(table.rows_sha256)) {
      throw new Error(`${tableLabel}.rows_sha256 is invalid`);
    }
    return {
      name: table.name,
      row_count: Number(table.row_count),
      rows_sha256: table.rows_sha256,
    };
  });
  if (new Set(targetTables.map((table) => table.name)).size !== targetTables.length) {
    throw new Error(`${label}.target_tables contains duplicate names`);
  }
  if (migrationSha256(migrationCanonicalJson(targetTables)) !== record.target_logical_sha256) {
    throw new Error(`${label}.target_logical_sha256 is inconsistent`);
  }
  return {
    strategy: record.strategy,
    ...(record.selection_policy === undefined ? {} : { selection_policy: record.selection_policy }),
    precedence: record.precedence.filter(
      (sourceId): sourceId is string => typeof sourceId === "string"
    ),
    source_count: Number(record.source_count),
    duplicate_row_count: Number(record.duplicate_row_count),
    precedence_resolution_count: Number(record.precedence_resolution_count),
    precedence_resolution_sha256: String(record.precedence_resolution_sha256),
    target_tables: targetTables,
    target_logical_sha256: String(record.target_logical_sha256),
  };
}

function parsePlanSourceCandidate(value: unknown, label: string): MigrationPlanSourceCandidate {
  const record = asRecord(value, label);
  closedKeys(
    record,
    ["source_id", "source_path_commitment", "source_snapshot", "receipt_key_sha256"],
    label
  );
  if (typeof record.source_id !== "string" || !SOURCE_ID_PATTERN.test(record.source_id)) {
    throw new Error(`${label}.source_id is invalid`);
  }
  if (
    typeof record.source_path_commitment !== "string" ||
    !/^path_[a-f0-9]{64}$/u.test(record.source_path_commitment)
  ) {
    throw new Error(`${label}.source_path_commitment is invalid`);
  }
  if (
    record.receipt_key_sha256 !== undefined &&
    (typeof record.receipt_key_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.receipt_key_sha256))
  ) {
    throw new Error(`${label}.receipt_key_sha256 is invalid`);
  }
  const snapshot = asRecord(record.source_snapshot, `${label}.source_snapshot`);
  closedKeys(snapshot, ["kind", "database", "wal", "sqlite"], `${label}.source_snapshot`);
  if (snapshot.kind !== "sqlite") throw new Error(`${label}.source_snapshot.kind is invalid`);
  return {
    source_id: record.source_id,
    source_path_commitment: record.source_path_commitment,
    source_snapshot: {
      kind: "sqlite",
      database: parseFileSnapshot(snapshot.database, `${label}.source_snapshot.database`),
      wal:
        snapshot.wal === null
          ? null
          : parseFileSnapshot(snapshot.wal, `${label}.source_snapshot.wal`),
      sqlite: parseSqliteSnapshot(snapshot.sqlite, `${label}.source_snapshot.sqlite`),
    },
    ...(record.receipt_key_sha256 === undefined
      ? {}
      : { receipt_key_sha256: record.receipt_key_sha256 }),
  };
}

function parsePlanStore(value: unknown, index: number): MigrationPlanStore {
  const label = `migration plan store ${index}`;
  const record = asRecord(value, label);
  closedKeys(
    record,
    [
      "id",
      "kind",
      "source_path_commitment",
      "source_snapshot",
      "source_candidates",
      "reconciliation",
    ],
    label
  );
  if (!isMigrationStoreId(record.id)) {
    throw new Error(`${label} has an unknown ID`);
  }
  const id = record.id;
  const kind = STORE_KINDS[id];
  if (record.kind !== kind) throw new Error(`${label} has the wrong kind`);
  if (
    typeof record.source_path_commitment !== "string" ||
    !/^path_[a-f0-9]{64}$/u.test(record.source_path_commitment)
  ) {
    throw new Error(`${label} has an invalid path commitment`);
  }
  const snapshot = asRecord(record.source_snapshot, `${label}.source_snapshot`);
  if (
    kind !== "sqlite" &&
    (record.source_candidates !== undefined || record.reconciliation !== undefined)
  ) {
    throw new Error(`${label} reconciliation is valid only for SQLite stores`);
  }
  if (kind === "file") {
    closedKeys(snapshot, ["kind", "file"], `${label}.source_snapshot`);
    if (snapshot.kind !== "file") throw new Error(`${label} has the wrong snapshot kind`);
    return {
      id,
      kind,
      source_path_commitment: record.source_path_commitment,
      source_snapshot: {
        kind: "file",
        file: parseFileSnapshot(snapshot.file, `${label}.source_snapshot.file`),
      },
    };
  }
  if (kind === "tree") {
    closedKeys(
      snapshot,
      ["kind", "file_count", "total_bytes", "tree_sha256", "files"],
      `${label}.source_snapshot`
    );
    if (snapshot.kind !== "tree") throw new Error(`${label} has the wrong snapshot kind`);
    if (!Number.isSafeInteger(snapshot.file_count) || Number(snapshot.file_count) < 0) {
      throw new Error(`${label}.source_snapshot.file_count is invalid`);
    }
    if (!Number.isSafeInteger(snapshot.total_bytes) || Number(snapshot.total_bytes) < 0) {
      throw new Error(`${label}.source_snapshot.total_bytes is invalid`);
    }
    if (typeof snapshot.tree_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.tree_sha256)) {
      throw new Error(`${label}.source_snapshot.tree_sha256 is invalid`);
    }
    if (!Array.isArray(snapshot.files))
      throw new Error(`${label}.source_snapshot.files is invalid`);
    const files = snapshot.files.map((value, fileIndex): TreeEntrySnapshot => {
      const fileLabel = `${label}.source_snapshot.files[${fileIndex}]`;
      const file = asRecord(value, fileLabel);
      if (
        typeof file.relative_path_commitment !== "string" ||
        !/^path_[a-f0-9]{64}$/u.test(file.relative_path_commitment)
      ) {
        throw new Error(`${label} has an invalid relative path commitment`);
      }
      if (file.kind === "file") {
        closedKeys(
          file,
          [
            "kind",
            "size",
            "sha256",
            "mode",
            "mtime_ms",
            "relative_path_commitment",
            "target_size",
            "target_sha256",
          ],
          fileLabel
        );
        const hasTargetSize = file.target_size !== undefined;
        const hasTargetSha = file.target_sha256 !== undefined;
        if (hasTargetSize !== hasTargetSha) {
          throw new Error(`${fileLabel} target transformation metadata is incomplete`);
        }
        if (
          hasTargetSize &&
          (!Number.isSafeInteger(file.target_size) || Number(file.target_size) < 0)
        ) {
          throw new Error(`${fileLabel}.target_size is invalid`);
        }
        if (
          hasTargetSha &&
          (typeof file.target_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.target_sha256))
        ) {
          throw new Error(`${fileLabel}.target_sha256 is invalid`);
        }
        return {
          kind: "file",
          ...parseFileSnapshot(
            {
              size: file.size,
              sha256: file.sha256,
              mode: file.mode,
              mtime_ms: file.mtime_ms,
            },
            fileLabel
          ),
          relative_path_commitment: file.relative_path_commitment,
          ...(hasTargetSize
            ? {
                target_size: Number(file.target_size),
                target_sha256: String(file.target_sha256),
              }
            : {}),
        };
      }
      if (file.kind !== "sqlite") throw new Error(`${fileLabel}.kind is invalid`);
      closedKeys(
        file,
        ["kind", "relative_path_commitment", "database", "wal", "sqlite"],
        fileLabel
      );
      return {
        kind: "sqlite",
        relative_path_commitment: file.relative_path_commitment,
        database: parseFileSnapshot(file.database, `${fileLabel}.database`),
        wal: file.wal === null ? null : parseFileSnapshot(file.wal, `${fileLabel}.wal`),
        sqlite: parseSqliteSnapshot(file.sqlite, `${fileLabel}.sqlite`),
      };
    });
    if (files.length !== Number(snapshot.file_count)) {
      throw new Error(`${label}.source_snapshot file count is inconsistent`);
    }
    return {
      id,
      kind,
      source_path_commitment: record.source_path_commitment,
      source_snapshot: {
        kind: "tree",
        file_count: Number(snapshot.file_count),
        total_bytes: Number(snapshot.total_bytes),
        tree_sha256: snapshot.tree_sha256,
        files,
      },
    };
  }
  closedKeys(snapshot, ["kind", "database", "wal", "sqlite"], `${label}.source_snapshot`);
  if (snapshot.kind !== "sqlite") throw new Error(`${label} has the wrong snapshot kind`);
  const base: MigrationPlanStore = {
    id,
    kind,
    source_path_commitment: record.source_path_commitment,
    source_snapshot: {
      kind: "sqlite",
      database: parseFileSnapshot(snapshot.database, `${label}.source_snapshot.database`),
      wal:
        snapshot.wal === null
          ? null
          : parseFileSnapshot(snapshot.wal, `${label}.source_snapshot.wal`),
      sqlite: parseSqliteSnapshot(snapshot.sqlite, `${label}.source_snapshot.sqlite`),
    },
  };
  if (record.source_candidates === undefined && record.reconciliation === undefined) return base;
  if (!Array.isArray(record.source_candidates) || record.source_candidates.length < 2) {
    throw new Error(`${label}.source_candidates is invalid`);
  }
  if (id !== "orchestration-db" && id !== "artifact-manifest") {
    throw new Error(`${label} does not support reconciliation`);
  }
  const candidates = record.source_candidates.map((value, candidateIndex) =>
    parsePlanSourceCandidate(value, `${label}.source_candidates[${candidateIndex}]`)
  );
  if (new Set(candidates.map((candidate) => candidate.source_id)).size !== candidates.length) {
    throw new Error(`${label}.source_candidates contains duplicate IDs`);
  }
  if (
    new Set(candidates.map((candidate) => candidate.source_path_commitment)).size !==
    candidates.length
  ) {
    throw new Error(`${label}.source_candidates contains duplicate paths`);
  }
  const reconciliation = parseReconciliationEvidence(
    record.reconciliation,
    `${label}.reconciliation`
  );
  const expectedStrategy = id === "orchestration-db" ? "strict-union" : "artifact-union";
  if (reconciliation.strategy !== expectedStrategy) {
    throw new Error(`${label}.reconciliation strategy does not match its store`);
  }
  if (
    migrationCanonicalJson(reconciliation.precedence) !==
      migrationCanonicalJson(candidates.map((candidate) => candidate.source_id)) ||
    reconciliation.source_count !== candidates.length
  ) {
    throw new Error(`${label}.reconciliation precedence does not match its candidates`);
  }
  const primary = candidates[0];
  if (primary === undefined) throw new Error(`${label} has no primary source candidate`);
  if (
    base.source_path_commitment !== primary.source_path_commitment ||
    migrationCanonicalJson(base.source_snapshot) !== migrationCanonicalJson(primary.source_snapshot)
  ) {
    throw new Error(`${label} primary source does not match reconciliation precedence`);
  }
  return {
    ...base,
    source_candidates: candidates,
    reconciliation,
  };
}

export function parseStateMigrationPlan(value: unknown): StateMigrationPlan {
  const record = asRecord(value, "migration plan");
  closedKeys(
    record,
    [
      "schema_version",
      "migration_tool_version",
      "migration_id",
      "phase",
      "generated_at",
      "source_manifest_sha256",
      "project_root_commitment",
      "state_root_commitment",
      "target_layout_version",
      "target_project_id",
      "stores",
      "plan_sha256",
    ],
    "migration plan"
  );
  if (record.schema_version !== STATE_MIGRATION_MANIFEST_VERSION) {
    throw new Error("unsupported migration plan version");
  }
  if (record.migration_tool_version !== STATE_MIGRATION_TOOL_VERSION) {
    throw new Error("unsupported migration tool version");
  }
  if (typeof record.migration_id !== "string" || !MIGRATION_ID_PATTERN.test(record.migration_id)) {
    throw new Error("migration plan ID is invalid");
  }
  if (record.phase !== "planned") throw new Error("migration plan phase is invalid");
  if (typeof record.generated_at !== "string" || !record.generated_at) {
    throw new Error("migration plan timestamp is invalid");
  }
  for (const [key, pattern] of [
    ["source_manifest_sha256", /^[a-f0-9]{64}$/u],
    ["project_root_commitment", /^root_[a-f0-9]{64}$/u],
    ["state_root_commitment", /^path_[a-f0-9]{64}$/u],
    ["plan_sha256", /^[a-f0-9]{64}$/u],
  ] as const) {
    if (typeof record[key] !== "string" || !pattern.test(record[key])) {
      throw new Error(`migration plan ${key} is invalid`);
    }
  }
  if (record.target_layout_version !== PENNY_STATE_LAYOUT_VERSION) {
    throw new Error("migration plan target layout version is unsupported");
  }
  if (
    typeof record.target_project_id !== "string" ||
    !PROJECT_ID_PATTERN.test(record.target_project_id)
  ) {
    throw new Error("migration plan target project ID is invalid");
  }
  if (!Array.isArray(record.stores) || record.stores.length === 0) {
    throw new Error("migration plan must contain at least one store");
  }
  const stores = record.stores.map(parsePlanStore);
  if (new Set(stores.map((store) => store.id)).size !== stores.length) {
    throw new Error("migration plan contains duplicate store IDs");
  }
  const body = {
    schema_version: STATE_MIGRATION_MANIFEST_VERSION,
    migration_tool_version: STATE_MIGRATION_TOOL_VERSION,
    migration_id: record.migration_id,
    phase: "planned" as const,
    generated_at: record.generated_at,
    source_manifest_sha256: String(record.source_manifest_sha256),
    project_root_commitment: String(record.project_root_commitment),
    state_root_commitment: String(record.state_root_commitment),
    target_layout_version: PENNY_STATE_LAYOUT_VERSION,
    target_project_id: record.target_project_id,
    stores,
  };
  const expectedDigest = migrationSha256(migrationCanonicalJson(body));
  if (record.plan_sha256 !== expectedDigest) throw new Error("migration plan checksum is invalid");
  return { ...body, plan_sha256: String(record.plan_sha256) };
}

export function readStateMigrationPlan(planPath: string): StateMigrationPlan {
  if (!path.isAbsolute(planPath)) throw new Error("migration plan path must be absolute");
  assertOwnerFile(planPath, "migration plan");
  return parseStateMigrationPlan(JSON.parse(readFileSync(planPath, "utf8")));
}

export function assertMigrationStoresUnchanged(
  expected: readonly MigrationPlanStore[],
  actual: readonly MigrationPlanStore[]
): void {
  const changed = expected.find((store, index) => {
    const current = actual[index];
    return (
      current === undefined || migrationCanonicalJson(store) !== migrationCanonicalJson(current)
    );
  });
  if (changed !== undefined || expected.length !== actual.length) {
    throw new Error(
      `migration source changed after planning${changed ? ` (${changed.id})` : ""}; generate a new plan`
    );
  }
}

export function createStateMigrationPlan(input: {
  readonly projectRoot: string;
  readonly sourceManifestPath: string;
  readonly outputPath: string;
  readonly rootOptions?: ResolvePennyStateRootOptions;
}): StateMigrationPlan {
  if (!path.isAbsolute(input.projectRoot)) throw new Error("project root must be absolute");
  const source = readMigrationSourceManifest(input.sourceManifestPath);
  const targetProjectId = `prj_${randomBytes(16).toString("hex")}`;
  const generatedAt = new Date().toISOString();
  const stores = inspectMigrationStores(source.manifest, {
    targetProjectId,
    bindingCreatedAt: generatedAt,
  });

  const canonicalProjectRoot = realpathSync.native(path.resolve(input.projectRoot));
  const stateRoot = resolvePennyStateRoot(input.rootOptions);
  const body = {
    schema_version: STATE_MIGRATION_MANIFEST_VERSION,
    migration_tool_version: STATE_MIGRATION_TOOL_VERSION,
    migration_id: source.manifest.migration_id,
    phase: "planned" as const,
    generated_at: generatedAt,
    source_manifest_sha256: source.sha256,
    project_root_commitment: projectRootCommitment(canonicalProjectRoot),
    state_root_commitment: pathCommitment(stateRoot),
    target_layout_version: PENNY_STATE_LAYOUT_VERSION,
    target_project_id: targetProjectId,
    stores,
  } as const;
  const plan: StateMigrationPlan = {
    ...body,
    plan_sha256: migrationSha256(migrationCanonicalJson(body)),
  };
  writeOwnerPlan(input.outputPath, plan);
  return plan;
}
