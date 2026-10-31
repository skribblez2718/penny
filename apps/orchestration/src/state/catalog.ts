import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { SQLOutputValue } from "node:sqlite";

import { OwnerSqliteDatabase } from "../state/owner-sqlite.js";
import {
  HOST_CAPACITY_CATALOG_COLUMNS,
  HOST_CAPACITY_CATALOG_SQL,
  HOST_LEASE_CATALOG_V3_SQL,
} from "../host-operations/capacity-catalog-schema.js";
import {
  assertOwnerDirectory,
  assertOwnerFile,
  assertSafeAncestorChain,
  ensureOwnerDirectory,
  pathExistsNoFollow,
} from "./custody.js";
import {
  CATALOG_DATABASE_NAME,
  PENNY_STATE_LAYOUT_VERSION,
  PROJECT_ID_PATTERN,
  pennyStatePaths,
  type PennyStatePaths,
} from "./paths.js";

export const PROJECT_CATALOG_SCHEMA_VERSION = 4 as const;
const PROJECT_ROOT_COMMITMENT_DOMAIN = "penny-project-root-v1\0";
const PROJECT_ROOT_COMMITMENT_PATTERN = /^root_[a-f0-9]{64}$/u;
const REQUIRED_CATALOG_COLUMNS = {
  ...HOST_CAPACITY_CATALOG_COLUMNS,
  host_backend_dispositions: [
    "receipt_id",
    "operation_record_id",
    "backend_key_sha256",
    "lease_id",
    "lease_epoch",
    "disposition_jcs",
    "receipt_jcs",
    "receipt_sha256",
    "created_at",
  ],
  host_backend_lease_events: [
    "event_id",
    "backend_key_sha256",
    "operation_record_id",
    "event_type",
    "event_jcs",
    "event_sha256",
    "created_at",
  ],
  host_backend_leases: [
    "backend_key_sha256",
    "state",
    "active_phase",
    "lease_id",
    "lease_epoch",
    "fencing_token_sha256",
    "operation_record_id",
    "project_id",
    "run_id",
    "state_id",
    "attempt",
    "operation_id",
    "registration_sha256",
    "request_sha256",
    "remote_correlation_sha256",
    "expires_at_ms",
    "quarantine_id",
    "disposition_receipt_id",
    "updated_at",
  ],
  host_backend_quarantine_resets: [
    "reset_receipt_id",
    "backend_key_sha256",
    "quarantine_id",
    "disposition",
    "evidence_sha256",
    "reset_jcs",
    "reset_sha256",
    "reset_at",
  ],
  host_operation_queue: [
    "operation_record_id",
    "backend_key_sha256",
    "project_id",
    "run_id",
    "state_id",
    "attempt",
    "operation_id",
    "registration_sha256",
    "request_sha256",
    "queued_at_ms",
    // Catalog v3 keeps its original storage name; the runtime projects this
    // value as queue_inactivity_expires_at_ms without rewriting retained state.
    "queue_deadline_at_ms",
  ],
  migration_reservations: ["project_id", "migration_id", "plan_sha256", "created_at"],
  project_relinks: [
    "relink_id",
    "project_id",
    "old_root_commitment",
    "new_root_commitment",
    "relinked_at",
  ],
  projects: [
    "project_id",
    "root_commitment",
    "lifecycle_state",
    "layout_version",
    "created_at",
    "updated_at",
  ],
} as const;

type ProjectLifecycleState = "active" | "relink_pending" | "retired";

interface CatalogProjectRow extends Record<string, SQLOutputValue> {
  project_id: string;
  root_commitment: string;
  lifecycle_state: ProjectLifecycleState;
  layout_version: number;
  created_at: string;
  updated_at: string;
}

export interface CatalogProject {
  readonly projectId: string;
  readonly rootCommitment: string;
  readonly lifecycleState: ProjectLifecycleState;
  readonly layoutVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MigrationProjectReservation {
  readonly projectId: string;
  readonly migrationId: string;
  readonly planSha256: string;
  readonly createdAt: string;
}

export interface ProjectBinding extends CatalogProject {
  readonly canonicalProjectRoot: string;
  readonly state: PennyStatePaths;
}

function canonicalProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const canonical = realpathSync.native(resolved);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("project root must resolve to a non-symlink directory");
  }
  return canonical;
}

export function projectRootCommitment(canonicalRoot: string): string {
  const digest = createHash("sha256")
    .update(PROJECT_ROOT_COMMITMENT_DOMAIN, "utf8")
    .update(canonicalRoot, "utf8")
    .digest("hex");
  return `root_${digest}`;
}

function parseProjectRow(row: unknown): CatalogProject {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("project catalog row is missing");
  }
  const value = row as Partial<CatalogProjectRow>;
  const projectId = String(value.project_id ?? "");
  const rootCommitment = String(value.root_commitment ?? "");
  const lifecycleState = String(value.lifecycle_state ?? "");
  const layoutVersion = Number(value.layout_version);
  const createdAt = String(value.created_at ?? "");
  const updatedAt = String(value.updated_at ?? "");
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("project catalog ID is invalid");
  if (!PROJECT_ROOT_COMMITMENT_PATTERN.test(rootCommitment)) {
    throw new Error("project root commitment is invalid");
  }
  if (
    lifecycleState !== "active" &&
    lifecycleState !== "relink_pending" &&
    lifecycleState !== "retired"
  ) {
    throw new Error("project lifecycle state is invalid");
  }
  if (layoutVersion !== PENNY_STATE_LAYOUT_VERSION) {
    throw new Error("project layout version is unsupported");
  }
  if (!createdAt || !updatedAt) throw new Error("project catalog timestamps are invalid");
  return {
    projectId,
    rootCommitment,
    lifecycleState,
    layoutVersion,
    createdAt,
    updatedAt,
  };
}

/** Owner-only project identity catalog. Raw project paths are never persisted. */
export class ProjectCatalog implements Disposable {
  readonly state: PennyStatePaths;
  private readonly store: OwnerSqliteDatabase;

  constructor(
    stateRoot: string,
    options: { create: boolean; readOnly?: boolean; verifyIntegrity?: boolean }
  ) {
    this.state = pennyStatePaths(stateRoot);
    if (options.create) {
      ensureOwnerDirectory(this.state.root, "Penny state root");
    } else {
      assertSafeAncestorChain(this.state.root, "Penny state root");
      if (!pathExistsNoFollow(this.state.root)) {
        throw new Error("Penny state catalog is not initialized; run explicit state setup");
      }
      assertOwnerDirectory(this.state.root, "Penny state root");
      if (!pathExistsNoFollow(this.state.catalogDatabase)) {
        throw new Error("Penny state catalog is not initialized; run explicit state setup");
      }
      assertOwnerFile(this.state.catalogDatabase, "Penny state catalog");
    }
    this.store = new OwnerSqliteDatabase({
      directory: this.state.root,
      databaseName: CATALOG_DATABASE_NAME,
      label: "Penny state catalog",
      mode: options.create ? "provision" : "existing",
      ...(options.readOnly === true ? { readOnly: true } : {}),
      ...(options.verifyIntegrity === undefined
        ? {}
        : { verifyIntegrity: options.verifyIntegrity }),
    });
    try {
      this.initializeOrValidateSchema(options.create);
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  /** Verify one caller-specified upgrade backup; no scanning/adoption or schema mutation. */
  static verifyCapacityUpgradeBackup(directory: string, databaseName: string): void {
    using store = new OwnerSqliteDatabase({
      directory,
      databaseName,
      label: "global catalog upgrade backup",
      mode: "existing",
      readOnly: true,
    });
    const version = store.db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 2 && version !== 3) throw new Error("catalog backup source version diverges");
    validateCatalogTables(store, version);
    if (
      store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'host_capacity_%'").get() !==
      undefined
    )
      throw new Error("legacy catalog backup contains capacity state");
  }

  /** Administrative v2/v3→v4 only. Backup callback runs under the global write lock before DDL. */
  static async upgradeCapacitySchema(
    stateRoot: string,
    backupBeforeMutation: (version: 2 | 3) => Promise<void>,
    fault?: (point: "before-capacity-ddl" | "after-capacity-ddl") => void
  ): Promise<{ sourceVersion: number; targetVersion: number; changed: boolean }> {
    const state = pennyStatePaths(stateRoot);
    using store = new OwnerSqliteDatabase({
      directory: state.root,
      databaseName: CATALOG_DATABASE_NAME,
      label: "global catalog upgrade",
      mode: "existing",
    });
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const row = store.db.prepare("PRAGMA user_version").get();
      const version = row?.user_version;
      if (version === PROJECT_CATALOG_SCHEMA_VERSION) {
        validateCatalogTables(store, 4);
        store.db.exec("COMMIT");
        return { sourceVersion: version, targetVersion: version, changed: false };
      }
      if (version !== 2 && version !== 3)
        throw new Error("global capacity upgrade requires exact catalog schema 2 or 3");
      validateCatalogTables(store, version);
      await backupBeforeMutation(version);
      store.assertCustody();
      fault?.("before-capacity-ddl");
      if (version === 2) store.db.exec(HOST_LEASE_CATALOG_V3_SQL);
      store.db.exec(HOST_CAPACITY_CATALOG_SQL);
      store.db.exec(`PRAGMA user_version = ${PROJECT_CATALOG_SCHEMA_VERSION};`);
      validateCatalogTables(store, 4);
      fault?.("after-capacity-ddl");
      store.db.exec("COMMIT");
      return {
        sourceVersion: version,
        targetVersion: PROJECT_CATALOG_SCHEMA_VERSION,
        changed: true,
      };
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  }

  lookupProject(projectRoot: string): ProjectBinding | undefined {
    this.store.assertCustody();
    const canonicalRoot = canonicalProjectRoot(projectRoot);
    const commitment = projectRootCommitment(canonicalRoot);
    const row = this.store.db
      .prepare(
        "SELECT project_id, root_commitment, lifecycle_state, layout_version, created_at, updated_at " +
          "FROM projects WHERE root_commitment = ?"
      )
      .get(commitment);
    if (row === undefined) return undefined;
    const parsed = parseProjectRow(row);
    if (parsed.lifecycleState !== "active") {
      throw new Error(`project catalog entry is ${parsed.lifecycleState}`);
    }
    return { ...parsed, canonicalProjectRoot: canonicalRoot, state: this.state };
  }

  registerProject(projectRoot: string): ProjectBinding {
    const canonicalRoot = canonicalProjectRoot(projectRoot);
    const commitment = projectRootCommitment(canonicalRoot);
    const existing = this.lookupProject(canonicalRoot);
    if (existing !== undefined) return existing;

    const now = new Date().toISOString();
    const projectId = `prj_${randomBytes(16).toString("hex")}`;
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO projects(" +
            "project_id, root_commitment, lifecycle_state, layout_version, created_at, updated_at" +
            ") VALUES (?, ?, 'active', ?, ?, ?)"
        )
        .run(projectId, commitment, PENNY_STATE_LAYOUT_VERSION, now, now);
    });
    return {
      projectId,
      rootCommitment: commitment,
      lifecycleState: "active",
      layoutVersion: PENNY_STATE_LAYOUT_VERSION,
      createdAt: now,
      updatedAt: now,
      canonicalProjectRoot: canonicalRoot,
      state: this.state,
    };
  }

  projectById(projectId: string): CatalogProject | undefined {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("project ID is not canonical");
    this.store.assertCustody();
    const row = this.store.db
      .prepare(
        "SELECT project_id, root_commitment, lifecycle_state, layout_version, created_at, updated_at " +
          "FROM projects WHERE project_id = ?"
      )
      .get(projectId);
    return row === undefined ? undefined : parseProjectRow(row);
  }

  relinkProject(projectId: string, currentRoot: string, replacementRoot: string): CatalogProject {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("project ID is not canonical");
    const oldCommitment = projectRootCommitment(canonicalProjectRoot(currentRoot));
    const newCommitment = projectRootCommitment(canonicalProjectRoot(replacementRoot));
    if (oldCommitment === newCommitment) throw new Error("replacement project root is unchanged");
    const now = new Date().toISOString();

    this.store.transaction(() => {
      const existing = this.projectById(projectId);
      if (existing === undefined) throw new Error("project catalog entry does not exist");
      if (existing.lifecycleState !== "active") {
        throw new Error(`project catalog entry is ${existing.lifecycleState}`);
      }
      if (existing.rootCommitment !== oldCommitment) {
        throw new Error("current project root does not match the catalog entry");
      }
      const collision = this.store.db
        .prepare("SELECT project_id FROM projects WHERE root_commitment = ?")
        .get(newCommitment) as Record<string, SQLOutputValue> | undefined;
      if (collision !== undefined)
        throw new Error("replacement project root is already registered");

      this.store.db
        .prepare(
          "UPDATE projects SET lifecycle_state = 'relink_pending', updated_at = ? WHERE project_id = ?"
        )
        .run(now, projectId);
      this.store.db
        .prepare(
          "INSERT INTO project_relinks(project_id, old_root_commitment, new_root_commitment, relinked_at) " +
            "VALUES (?, ?, ?, ?)"
        )
        .run(projectId, oldCommitment, newCommitment, now);
      this.store.db
        .prepare(
          "UPDATE projects SET root_commitment = ?, lifecycle_state = 'active', updated_at = ? " +
            "WHERE project_id = ?"
        )
        .run(newCommitment, now, projectId);
    });

    const updated = this.projectById(projectId);
    if (updated === undefined) throw new Error("project relink did not persist");
    return updated;
  }

  reserveMigrationProject(input: {
    readonly projectRoot: string;
    readonly projectId: string;
    readonly migrationId: string;
    readonly planSha256: string;
  }): MigrationProjectReservation {
    if (!PROJECT_ID_PATTERN.test(input.projectId)) throw new Error("project ID is not canonical");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.migrationId)) {
      throw new Error("migration ID is not canonical");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.planSha256)) {
      throw new Error("migration plan checksum is invalid");
    }
    const commitment = projectRootCommitment(canonicalProjectRoot(input.projectRoot));
    const now = new Date().toISOString();
    this.store.transaction(() => {
      const byCommitment = this.store.db
        .prepare("SELECT project_id, lifecycle_state FROM projects WHERE root_commitment = ?")
        .get(commitment) as Record<string, SQLOutputValue> | undefined;
      const byId = this.store.db
        .prepare("SELECT root_commitment, lifecycle_state FROM projects WHERE project_id = ?")
        .get(input.projectId) as Record<string, SQLOutputValue> | undefined;
      if (byCommitment !== undefined || byId !== undefined) {
        if (
          String(byCommitment?.project_id ?? "") !== input.projectId ||
          String(byId?.root_commitment ?? "") !== commitment ||
          String(byCommitment?.lifecycle_state ?? "") !== "relink_pending" ||
          String(byId?.lifecycle_state ?? "") !== "relink_pending"
        ) {
          throw new Error("migration target project conflicts with an existing catalog entry");
        }
        const reservation = this.store.db
          .prepare(
            "SELECT migration_id, plan_sha256 FROM migration_reservations WHERE project_id = ?"
          )
          .get(input.projectId) as Record<string, SQLOutputValue> | undefined;
        if (
          String(reservation?.migration_id ?? "") !== input.migrationId ||
          String(reservation?.plan_sha256 ?? "") !== input.planSha256
        ) {
          throw new Error("migration target project has a different pending reservation");
        }
        return;
      }

      this.store.db
        .prepare(
          "INSERT INTO projects(" +
            "project_id, root_commitment, lifecycle_state, layout_version, created_at, updated_at" +
            ") VALUES (?, ?, 'relink_pending', ?, ?, ?)"
        )
        .run(input.projectId, commitment, PENNY_STATE_LAYOUT_VERSION, now, now);
      this.store.db
        .prepare(
          "INSERT INTO migration_reservations(" +
            "project_id, migration_id, plan_sha256, created_at" +
            ") VALUES (?, ?, ?, ?)"
        )
        .run(input.projectId, input.migrationId, input.planSha256, now);
    });
    return this.migrationReservation(input.projectId, input.migrationId, input.planSha256);
  }

  activateMigrationProject(input: {
    readonly projectId: string;
    readonly migrationId: string;
    readonly planSha256: string;
  }): CatalogProject {
    const reservation = this.migrationReservation(
      input.projectId,
      input.migrationId,
      input.planSha256
    );
    const now = new Date().toISOString();
    this.store.transaction(() => {
      const project = this.projectById(input.projectId);
      if (project === undefined || project.lifecycleState !== "relink_pending") {
        throw new Error("migration project is not pending activation");
      }
      this.store.db
        .prepare(
          "UPDATE projects SET lifecycle_state = 'active', updated_at = ? WHERE project_id = ?"
        )
        .run(now, reservation.projectId);
      this.store.db
        .prepare("DELETE FROM migration_reservations WHERE project_id = ?")
        .run(reservation.projectId);
    });
    const project = this.projectById(input.projectId);
    if (project === undefined || project.lifecycleState !== "active") {
      throw new Error("migration project activation did not persist");
    }
    return project;
  }

  migrationReservation(
    projectId: string,
    migrationId: string,
    planSha256: string
  ): MigrationProjectReservation {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("project ID is not canonical");
    this.store.assertCustody();
    const row = this.store.db
      .prepare(
        "SELECT project_id, migration_id, plan_sha256, created_at " +
          "FROM migration_reservations WHERE project_id = ?"
      )
      .get(projectId) as Record<string, SQLOutputValue> | undefined;
    if (
      row === undefined ||
      String(row.migration_id) !== migrationId ||
      String(row.plan_sha256) !== planSha256
    ) {
      throw new Error("migration reservation is missing or does not match the plan");
    }
    return {
      projectId: String(row.project_id),
      migrationId: String(row.migration_id),
      planSha256: String(row.plan_sha256),
      createdAt: String(row.created_at),
    };
  }

  close(): void {
    this.store.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private initializeOrValidateSchema(allowInitialization: boolean): void {
    const versionRow = this.store.db.prepare("PRAGMA user_version").get() as
      | Record<string, SQLOutputValue>
      | undefined;
    let version = Number(versionRow?.user_version ?? 0);
    const fresh = version === 0;
    if (!fresh && version !== PROJECT_CATALOG_SCHEMA_VERSION)
      throw new Error(
        `catalog schema ${version} requires explicit backup-first global catalog upgrade`
      );
    if (version > PROJECT_CATALOG_SCHEMA_VERSION) {
      throw new Error(`project catalog schema ${version} is newer than supported`);
    }
    if (version === 0) {
      if (!allowInitialization) {
        throw new Error("Penny state catalog schema is not initialized; run explicit state setup");
      }
      this.store.transaction(() => {
        this.store.db.exec(`
          CREATE TABLE projects (
            project_id TEXT PRIMARY KEY,
            root_commitment TEXT NOT NULL UNIQUE,
            lifecycle_state TEXT NOT NULL CHECK (
              lifecycle_state IN ('active', 'relink_pending', 'retired')
            ),
            layout_version INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE project_relinks (
            relink_id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL REFERENCES projects(project_id),
            old_root_commitment TEXT NOT NULL,
            new_root_commitment TEXT NOT NULL,
            relinked_at TEXT NOT NULL
          ) STRICT;
          PRAGMA user_version = 1;
        `);
      });
      version = 1;
    }
    if (version === 1) {
      if (!allowInitialization) {
        throw new Error("Penny state catalog schema requires explicit state setup");
      }
      this.store.transaction(() => {
        this.store.db.exec(`
          CREATE TABLE migration_reservations (
            project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
            migration_id TEXT NOT NULL UNIQUE,
            plan_sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          PRAGMA user_version = 2;
        `);
      });
      version = 2;
    }
    if (version === 2) {
      if (!allowInitialization) {
        throw new Error("Penny state catalog schema requires explicit state setup or upgrade");
      }
      this.store.transaction(() => {
        this.store.db.exec(`
          ${HOST_LEASE_CATALOG_V3_SQL}
        `);
      });
      version = 3;
    }
    if (version === 3) {
      if (!fresh)
        throw new Error("catalog schema 3 requires explicit backup-first global catalog upgrade");
      this.store.transaction(() => {
        this.store.db.exec(HOST_CAPACITY_CATALOG_SQL);
        this.store.db.exec(`PRAGMA user_version = ${PROJECT_CATALOG_SCHEMA_VERSION};`);
      });
      version = PROJECT_CATALOG_SCHEMA_VERSION;
    }
    if (version !== PROJECT_CATALOG_SCHEMA_VERSION) {
      throw new Error(`project catalog schema ${version} is unsupported`);
    }

    validateCatalogTables(this.store, 4);
  }
}

function validateCatalogTables(store: OwnerSqliteDatabase, version: 2 | 3 | 4): void {
  const schemaObjects = store.db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE type = 'table'")
    .all();
  const tables = new Map(schemaObjects.map((row) => [String(row.name), String(row.sql ?? "")]));
  for (const [table, requiredColumns] of Object.entries(REQUIRED_CATALOG_COLUMNS).filter(
    ([table]) =>
      version === 4 ||
      (version === 3 ? !table.startsWith("host_capacity_") : !table.startsWith("host_"))
  )) {
    const definition = tables.get(table);
    if (definition === undefined) throw new Error(`project catalog is missing table '${table}'`);
    if (!/\bSTRICT\b/u.test(definition)) {
      throw new Error(`project catalog table '${table}' is not STRICT`);
    }
    const columns = new Set(
      store.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String(row.name))
    );
    for (const column of requiredColumns) {
      if (!columns.has(column)) {
        throw new Error(`project catalog table '${table}' is missing column '${column}'`);
      }
    }
    if (table.startsWith("host_capacity_")) {
      const expected = HOST_CAPACITY_CATALOG_SQL.split(";").find((statement) =>
        statement.trim().startsWith(`CREATE TABLE ${table} (`)
      );
      if (
        expected === undefined ||
        definition.trim().replace(/\s+/gu, " ") !== expected.trim().replace(/\s+/gu, " ")
      )
        throw new Error(`capacity catalog table '${table}' schema diverges`);
    }
  }
  if (version === 4) {
    const index = store.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_host_capacity_project'"
      )
      .get();
    if (
      index?.sql !==
      "CREATE INDEX idx_host_capacity_project ON host_capacity_records(project_id, state)"
    )
      throw new Error("capacity catalog index schema diverges");
  }
}
