import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { ARTIFACT_MANIFEST_SCHEMA_VERSION, ArtifactStore } from "../artifact-store.js";
import { migrationArtifactRef } from "./artifact-compat.js";
import { ORCHESTRATION_DATABASE_SCHEMA_VERSION, Checkpointer } from "../checkpointer.js";
import { ProjectCatalog, projectRootCommitment } from "./catalog.js";
import {
  assertOwnerDirectory,
  assertOwnerFile,
  ensureOwnerDirectory,
  fsyncDirectory,
  OWNER_FILE_MODE,
  pathExistsNoFollow,
} from "./custody.js";
import {
  assertMigrationStoresUnchanged,
  migrationCanonicalJson,
  inspectMigrationStores,
  pathCommitment,
  readMigrationSourceManifest,
  readStateMigrationPlan,
  snapshotFile,
  snapshotTree,
  transformSkillChainCheckpoint,
  type MigrationPlanStore,
  type MigrationStoreId,
  type SourceManifest,
  type StateMigrationPlan,
} from "./migration-plan.js";
import {
  normalizeMigratedOrchestrationDatabase,
  verifyMigrationExecutionReceipt,
} from "./receipt-compat.js";
import {
  PENNY_STATE_LAYOUT_VERSION,
  pennyStatePaths,
  projectStatePaths,
  projectStatePathsAtRoot,
  resolvePennyStateRoot,
  type PennyStatePaths,
  type ProjectStatePaths,
  type ResolvePennyStateRootOptions,
} from "./paths.js";
import {
  materializeReconciledSqlite,
  sqliteTargetEvidence,
  type SqliteReconciliationEvidence,
} from "./reconciliation.js";
import { ensureProjectStateDirectories, initializePennyStateInfrastructure } from "./setup.js";

export const STATE_MIGRATION_JOURNAL_VERSION = 1 as const;
export const STATE_MIGRATION_FINALIZED_MARKER = "migration-finalized.json" as const;

type MigrationPhase = "applying" | "applied" | "verified" | "finalized";

interface MigrationJournal {
  readonly schema_version: 1;
  readonly migration_id: string;
  readonly plan_sha256: string;
  readonly project_id: string;
  readonly phase: MigrationPhase;
  readonly completed_stores: readonly MigrationStoreId[];
  readonly created_at: string;
  readonly updated_at: string;
}

interface FinalizedMarker {
  readonly schema_version: 1;
  readonly migration_id: string;
  readonly plan_sha256: string;
  readonly project_id: string;
  readonly state_layout_version: number;
  readonly finalized_at: string;
}

interface MigrationWorkspace {
  readonly root: string;
  readonly journal: string;
  readonly staging: string;
  readonly stagedProject: string;
}

export interface MigrationPhaseResult {
  readonly migration_id: string;
  readonly project_id: string;
  readonly plan_sha256: string;
  readonly phase: MigrationPhase;
  readonly completed_stores: readonly MigrationStoreId[];
  readonly finalized: boolean;
}

export interface MigrationVerificationStore {
  readonly id: MigrationStoreId;
  readonly kind: "file" | "tree" | "sqlite";
  readonly verified: true;
  readonly target_user_version?: number;
  readonly target_table_count?: number;
  readonly reconciliation?: SqliteReconciliationEvidence;
}

export interface MigrationSemanticVerification {
  readonly historical_receipts_verified: number;
  readonly artifact_object_bindings_verified: number;
  readonly skill_chain_artifact_refs_verified: number;
  readonly kb_authorities: readonly {
    readonly store_id: MigrationStoreId;
    readonly files_verified: number;
    readonly sqlite_units_verified: number;
  }[];
}

export interface StateMigrationVerification extends MigrationPhaseResult {
  readonly phase: "verified" | "finalized";
  readonly stores: readonly MigrationVerificationStore[];
  readonly semantic_verification: MigrationSemanticVerification;
}

export type StateMigrationFaultPoint =
  | "apply-start"
  | "catalog-reservation.before"
  | "catalog-reservation.after"
  | "metadata-write.before"
  | "metadata-write.after"
  | "metadata-rename.after"
  | "file-copy.before"
  | "file-copy.after"
  | "tree-copy.before"
  | "tree-copy.after"
  | "sqlite-backup.before"
  | "sqlite-backup.after"
  | "sqlite-reconciliation.before"
  | "sqlite-reconciliation.after"
  | "file-fsync.before"
  | "file-fsync.after"
  | "directory-fsync.before"
  | "directory-fsync.after"
  | "store-verification.before"
  | "store-verification.after"
  | "finalized-marker.before"
  | "finalized-marker.after"
  | "project-rename.before"
  | "project-rename.after"
  | "catalog-activation.before"
  | "catalog-activation.after";

export interface StateMigrationFaultEvent {
  readonly point: StateMigrationFaultPoint;
  /** Closed implementation label such as journal:initial, store ID, or staged-project. */
  readonly operation: string;
  readonly store_id?: MigrationStoreId;
}

export type StateMigrationFaultInjector = (event: StateMigrationFaultEvent) => void;

function injectFault(
  injector: StateMigrationFaultInjector | undefined,
  point: StateMigrationFaultPoint,
  operation: string,
  storeId?: MigrationStoreId
): void {
  injector?.({ point, operation, ...(storeId === undefined ? {} : { store_id: storeId }) });
}

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  readonly backup: typeof import("node:sqlite").backup;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSqliteModule(value: object | undefined): value is SqliteModule {
  return (
    value !== undefined &&
    "DatabaseSync" in value &&
    typeof value.DatabaseSync === "function" &&
    "backup" in value &&
    typeof value.backup === "function"
  );
}

function sqliteModule(): SqliteModule {
  const module = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) throw new Error("Node.js runtime does not provide node:sqlite");
  return module;
}

function errorHasCode(error: unknown, code: string): boolean {
  return isUnknownRecord(error) && error.code === code;
}

function isPlannedStoreId(
  value: unknown,
  validIds: ReadonlySet<MigrationStoreId>
): value is MigrationStoreId {
  if (typeof value !== "string") return false;
  for (const id of validIds) {
    if (id === value) return true;
  }
  return false;
}

function workspace(state: PennyStatePaths, migrationId: string): MigrationWorkspace {
  const root = path.join(state.migrations, migrationId);
  return {
    root,
    journal: path.join(root, "journal.json"),
    staging: path.join(root, "staging"),
    stagedProject: path.join(root, "staging", "project"),
  };
}

function migrationLockPath(state: PennyStatePaths, migrationId: string): string {
  const suffix = createHash("sha256").update(migrationId).digest("hex").slice(0, 24);
  return path.join(state.locks, `migration-${suffix}.lock`);
}

async function withMigrationLock<T>(
  state: PennyStatePaths,
  migrationId: string,
  injector: StateMigrationFaultInjector | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = migrationLockPath(state, migrationId);
  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      OWNER_FILE_MODE
    );
  } catch (error) {
    if (errorHasCode(error, "EEXIST")) {
      throw new Error("migration is locked by another operator process or requires lock recovery");
    }
    throw error;
  }
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ schema_version: 1, migration_id: migrationId })}\n`,
      "utf8"
    );
    injectFault(injector, "file-fsync.before", "migration-lock");
    fsyncSync(descriptor);
    injectFault(injector, "file-fsync.after", "migration-lock");
    return await operation();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
    fsyncMigrationDirectory(state.locks, injector, "migration-lock-cleanup");
  }
}

function fsyncOwnerFile(
  file: string,
  injector: StateMigrationFaultInjector | undefined,
  operation: string,
  storeId?: MigrationStoreId
): void {
  assertOwnerFile(file, `migration durable file ${operation}`);
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    injectFault(injector, "file-fsync.before", operation, storeId);
    fsyncSync(descriptor);
    injectFault(injector, "file-fsync.after", operation, storeId);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncMigrationDirectory(
  directory: string,
  injector: StateMigrationFaultInjector | undefined,
  operation: string,
  storeId?: MigrationStoreId
): void {
  injectFault(injector, "directory-fsync.before", operation, storeId);
  fsyncDirectory(directory);
  injectFault(injector, "directory-fsync.after", operation, storeId);
}

function atomicOwnerJson(
  file: string,
  value: unknown,
  injector: StateMigrationFaultInjector | undefined,
  operation: string
): void {
  const parent = path.dirname(file);
  ensureOwnerDirectory(parent, `migration metadata directory ${parent}`);
  const temporary = path.join(
    parent,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  injectFault(injector, "metadata-write.before", operation);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      OWNER_FILE_MODE
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    injectFault(injector, "file-fsync.before", operation);
    fsyncSync(descriptor);
    injectFault(injector, "file-fsync.after", operation);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    injectFault(injector, "metadata-rename.after", operation);
    fsyncMigrationDirectory(parent, injector, operation);
    assertOwnerFile(file, "migration metadata");
    injectFault(injector, "metadata-write.after", operation);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJournal(value: unknown, plan: StateMigrationPlan): MigrationJournal {
  if (!isUnknownRecord(value)) {
    throw new Error("migration journal is invalid");
  }
  const record = value;
  const allowed = new Set([
    "schema_version",
    "migration_id",
    "plan_sha256",
    "project_id",
    "phase",
    "completed_stores",
    "created_at",
    "updated_at",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("migration journal contains unknown fields");
  }
  if (
    record.schema_version !== STATE_MIGRATION_JOURNAL_VERSION ||
    record.migration_id !== plan.migration_id ||
    record.plan_sha256 !== plan.plan_sha256 ||
    record.project_id !== plan.target_project_id
  ) {
    throw new Error("migration journal does not match the plan");
  }
  if (
    record.phase !== "applying" &&
    record.phase !== "applied" &&
    record.phase !== "verified" &&
    record.phase !== "finalized"
  ) {
    throw new Error("migration journal phase is invalid");
  }
  if (!Array.isArray(record.completed_stores)) {
    throw new Error("migration journal completed store list is invalid");
  }
  const validIds = new Set(plan.stores.map((store) => store.id));
  const completedStores = record.completed_stores.map((value) => {
    if (!isPlannedStoreId(value, validIds)) {
      throw new Error("migration journal contains an unknown completed store");
    }
    return value;
  });
  if (new Set(completedStores).size !== completedStores.length) {
    throw new Error("migration journal contains duplicate completed stores");
  }
  if (typeof record.created_at !== "string" || typeof record.updated_at !== "string") {
    throw new Error("migration journal timestamps are invalid");
  }
  return {
    schema_version: STATE_MIGRATION_JOURNAL_VERSION,
    migration_id: plan.migration_id,
    plan_sha256: plan.plan_sha256,
    project_id: plan.target_project_id,
    phase: record.phase,
    completed_stores: completedStores,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function readJournal(file: string, plan: StateMigrationPlan): MigrationJournal {
  assertOwnerFile(file, "migration journal");
  return parseJournal(JSON.parse(readFileSync(file, "utf8")), plan);
}

function initialJournal(plan: StateMigrationPlan): MigrationJournal {
  const now = new Date().toISOString();
  return {
    schema_version: STATE_MIGRATION_JOURNAL_VERSION,
    migration_id: plan.migration_id,
    plan_sha256: plan.plan_sha256,
    project_id: plan.target_project_id,
    phase: "applying",
    completed_stores: [],
    created_at: now,
    updated_at: now,
  };
}

function updateJournal(
  file: string,
  journal: MigrationJournal,
  patch: Partial<Pick<MigrationJournal, "phase" | "completed_stores">>,
  injector: StateMigrationFaultInjector | undefined,
  transition: string
): MigrationJournal {
  const updated: MigrationJournal = {
    ...journal,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  atomicOwnerJson(file, updated, injector, `journal:${transition}`);
  return updated;
}

function validatePlanContext(
  projectRoot: string,
  plan: StateMigrationPlan,
  rootOptions: ResolvePennyStateRootOptions
): PennyStatePaths {
  if (projectRootCommitment(projectRoot) !== plan.project_root_commitment) {
    throw new Error("project root does not match the migration plan");
  }
  const stateRoot = resolvePennyStateRoot(rootOptions);
  if (pathCommitment(stateRoot) !== plan.state_root_commitment) {
    throw new Error("Penny state root does not match the migration plan");
  }
  return pennyStatePaths(stateRoot);
}

function validateSource(
  sourceManifestPath: string,
  source: { readonly manifest: SourceManifest; readonly sha256: string },
  plan: StateMigrationPlan
): void {
  if (source.sha256 !== plan.source_manifest_sha256) {
    throw new Error("migration source manifest changed after planning");
  }
  if (source.manifest.migration_id !== plan.migration_id) {
    throw new Error("migration source manifest ID does not match the plan");
  }
  if (!path.isAbsolute(sourceManifestPath)) {
    throw new Error("migration source manifest path must be absolute");
  }
  assertMigrationStoresUnchanged(
    plan.stores,
    inspectMigrationStores(source.manifest, {
      targetProjectId: plan.target_project_id,
      bindingCreatedAt: plan.generated_at,
    })
  );
}

function targetForStore(paths: ProjectStatePaths, id: MigrationStoreId): string {
  switch (id) {
    case "orchestration-db":
      return paths.orchestration.database;
    case "orchestration-receipt-key":
      return paths.orchestration.receiptKey;
    case "orchestration-inputs":
      return paths.orchestration.inputs;
    case "artifact-manifest":
      return paths.artifacts.manifestDatabase;
    case "artifact-objects":
      return paths.artifacts.objects;
    case "skill-chains":
      return paths.skillChains;
    case "subagent-sessions":
      return paths.subagentSessions;
    case "kb-profiles":
      return paths.knowledgeBase.profiles;
    case "kb-host-grants":
      return paths.knowledgeBase.hostGrants;
    case "kb-capabilities":
      return paths.knowledgeBase.capabilities;
    case "kb-save-claims":
      return paths.knowledgeBase.saveClaims;
    case "kb-operation-receipts":
      return paths.knowledgeBase.operationReceipts;
    case "kb-approval":
      return paths.knowledgeBase.approval;
  }
}

function sourceStore(
  source: SourceManifest,
  id: MigrationStoreId
): SourceManifest["stores"][number] {
  const store = source.stores.find((candidate) => candidate.id === id);
  if (store === undefined) throw new Error(`migration source store '${id}' is missing`);
  return store;
}

function fileContentSignature(snapshot: {
  readonly size: number;
  readonly sha256: string;
  readonly mode: string;
}): string {
  return `${snapshot.size}:${snapshot.sha256}:${snapshot.mode}`;
}

function treeSqliteCommitments(snapshot: ReturnType<typeof snapshotTree>): readonly string[] {
  return snapshot.files
    .filter((file) => file.kind === "sqlite")
    .map((file) => file.relative_path_commitment);
}

function treeContentSignature(
  snapshot: ReturnType<typeof snapshotTree>,
  useTransformationTargets = false
): string {
  return migrationCanonicalJson({
    file_count: snapshot.file_count,
    files: snapshot.files.map((file) =>
      file.kind === "file"
        ? {
            kind: "file",
            relative_path_commitment: file.relative_path_commitment,
            size: useTransformationTargets ? (file.target_size ?? file.size) : file.size,
            sha256: useTransformationTargets ? (file.target_sha256 ?? file.sha256) : file.sha256,
            mode: file.mode,
          }
        : {
            kind: "sqlite",
            relative_path_commitment: file.relative_path_commitment,
            user_version: file.sqlite.user_version,
            tables: file.sqlite.tables,
          }
    ),
  });
}

function writeOwnerBytes(
  target: string,
  bytes: Buffer,
  injector: StateMigrationFaultInjector | undefined,
  operation: string,
  storeId: MigrationStoreId
): void {
  if (pathExistsNoFollow(target)) {
    const snapshot = snapshotFile(target, "migration transformed file");
    if (
      snapshot.size === bytes.length &&
      snapshot.sha256 === createHash("sha256").update(bytes).digest("hex")
    ) {
      fsyncOwnerFile(target, injector, operation, storeId);
      fsyncMigrationDirectory(path.dirname(target), injector, operation, storeId);
      return;
    }
    unlinkSync(target);
    fsyncMigrationDirectory(path.dirname(target), injector, operation, storeId);
  }
  const parent = path.dirname(target);
  ensureOwnerDirectory(parent, `migration target directory ${parent}`);
  const descriptor = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    OWNER_FILE_MODE
  );
  try {
    fchmodSync(descriptor, OWNER_FILE_MODE);
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(descriptor, bytes, written, bytes.length - written);
    }
    injectFault(injector, "file-fsync.before", operation, storeId);
    fsyncSync(descriptor);
    injectFault(injector, "file-fsync.after", operation, storeId);
  } finally {
    closeSync(descriptor);
  }
  fsyncMigrationDirectory(parent, injector, operation, storeId);
  assertOwnerFile(target, "migration transformed file");
}

function copyOwnerFile(
  source: string,
  target: string,
  injector: StateMigrationFaultInjector | undefined,
  operation: string,
  storeId: MigrationStoreId
): void {
  injectFault(injector, "file-copy.before", operation, storeId);
  if (pathExistsNoFollow(target)) {
    const sourceSnapshot = snapshotFile(source, "migration source file");
    const targetSnapshot = snapshotFile(target, "migration staged file");
    if (fileContentSignature(sourceSnapshot) === fileContentSignature(targetSnapshot)) {
      fsyncOwnerFile(target, injector, operation, storeId);
      fsyncMigrationDirectory(path.dirname(target), injector, operation, storeId);
      injectFault(injector, "file-copy.after", operation, storeId);
      return;
    }
    unlinkSync(target);
    fsyncMigrationDirectory(path.dirname(target), injector, operation, storeId);
  }
  const parent = path.dirname(target);
  ensureOwnerDirectory(parent, `migration target directory ${parent}`);
  const sourceDescriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let targetDescriptor: number | undefined;
  try {
    const sourceStat = fstatSync(sourceDescriptor);
    if (!sourceStat.isFile() || sourceStat.nlink !== 1) {
      throw new Error("migration source changed to an unsafe file");
    }
    targetDescriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      OWNER_FILE_MODE
    );
    fchmodSync(targetDescriptor, OWNER_FILE_MODE);
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
    injectFault(injector, "file-fsync.before", operation, storeId);
    fsyncSync(targetDescriptor);
    injectFault(injector, "file-fsync.after", operation, storeId);
    utimesSync(target, sourceStat.atime, sourceStat.mtime);
  } finally {
    if (targetDescriptor !== undefined) closeSync(targetDescriptor);
    closeSync(sourceDescriptor);
  }
  fsyncMigrationDirectory(parent, injector, operation, storeId);
  assertOwnerFile(target, "migration staged file");
  injectFault(injector, "file-copy.after", operation, storeId);
}

function fsyncOwnerTree(
  root: string,
  injector: StateMigrationFaultInjector | undefined,
  operation: string,
  storeId: MigrationStoreId
): void {
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else fsyncOwnerFile(candidate, injector, operation, storeId);
    }
    fsyncMigrationDirectory(directory, injector, operation, storeId);
  };
  walk(root);
}

async function copyOwnerTree(
  source: string,
  target: string,
  sqliteFiles: readonly string[],
  expected: Extract<MigrationPlanStore["source_snapshot"], { kind: "tree" }>,
  injector: StateMigrationFaultInjector | undefined,
  storeId: MigrationStoreId,
  transformFile?: (relativePath: string, bytes: Buffer) => Buffer
): Promise<void> {
  injectFault(injector, "tree-copy.before", storeId, storeId);
  const snapshotOptions = { sqliteFiles } as const;
  const targetSnapshotOptions = {
    sqlitePathCommitments: treeSqliteCommitments(expected),
  } as const;
  if (pathExistsNoFollow(target)) {
    snapshotTree(source, "migration source tree", snapshotOptions);
    const targetSnapshot = snapshotTree(target, "migration staged tree", targetSnapshotOptions);
    if (treeContentSignature(expected, true) === treeContentSignature(targetSnapshot)) {
      fsyncOwnerTree(target, injector, storeId, storeId);
      injectFault(injector, "tree-copy.after", storeId, storeId);
      return;
    }
    rmSync(target, { recursive: true, force: false });
    fsyncMigrationDirectory(path.dirname(target), injector, storeId, storeId);
    ensureOwnerDirectory(target, `migration target tree ${target}`);
  } else {
    ensureOwnerDirectory(target, `migration target tree ${target}`);
  }
  const sqliteSet = new Set(sqliteFiles);
  const expectedSqlite = new Map(
    expected.files
      .filter((file) => file.kind === "sqlite")
      .map((file) => [file.relative_path_commitment, file] as const)
  );
  const expectedFiles = new Map(
    expected.files
      .filter((file) => file.kind === "file")
      .map((file) => [file.relative_path_commitment, file] as const)
  );
  const walk = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const sourceCandidate = path.join(sourceDirectory, entry.name);
      const targetCandidate = path.join(targetDirectory, entry.name);
      const stat = lstatSync(sourceCandidate);
      if (stat.isSymbolicLink()) throw new Error("migration source tree contains a symbolic link");
      if (entry.isDirectory()) {
        ensureOwnerDirectory(targetCandidate, `migration target tree ${targetCandidate}`);
        await walk(sourceCandidate, targetCandidate);
        continue;
      }
      const relativePath = path.relative(source, sourceCandidate);
      const sidecarSuffix = relativePath.endsWith("-wal")
        ? "-wal"
        : relativePath.endsWith("-shm")
          ? "-shm"
          : undefined;
      if (
        sidecarSuffix !== undefined &&
        sqliteSet.has(relativePath.slice(0, -sidecarSuffix.length))
      ) {
        continue;
      }
      if (sqliteSet.has(relativePath)) {
        const member = expectedSqlite.get(pathCommitment(relativePath));
        if (member === undefined) throw new Error("SQLite tree member is missing from the plan");
        await copyEmbeddedSqlite(
          sourceCandidate,
          targetCandidate,
          member.sqlite,
          injector,
          `${storeId}:embedded-sqlite`,
          storeId
        );
      } else {
        const expectedFile = expectedFiles.get(pathCommitment(relativePath));
        if (expectedFile === undefined) throw new Error("tree file is missing from the plan");
        if (expectedFile.target_sha256 !== undefined) {
          if (transformFile === undefined) {
            throw new Error("tree file requires an unavailable migration transformation");
          }
          const transformed = transformFile(relativePath, readFileSync(sourceCandidate));
          if (
            transformed.length !== expectedFile.target_size ||
            createHash("sha256").update(transformed).digest("hex") !== expectedFile.target_sha256
          ) {
            throw new Error("tree file transformation differs from the migration plan");
          }
          writeOwnerBytes(targetCandidate, transformed, injector, `${storeId}:tree-file`, storeId);
        } else {
          copyOwnerFile(
            sourceCandidate,
            targetCandidate,
            injector,
            `${storeId}:tree-file`,
            storeId
          );
        }
      }
    }
    fsyncMigrationDirectory(targetDirectory, injector, storeId, storeId);
  };
  await walk(source, target);
  snapshotTree(source, "migration source tree", snapshotOptions);
  const targetSnapshot = snapshotTree(target, "migration staged tree", targetSnapshotOptions);
  if (treeContentSignature(expected, true) !== treeContentSignature(targetSnapshot)) {
    throw new Error("migration staged tree failed digest verification");
  }
  injectFault(injector, "tree-copy.after", storeId, storeId);
}

function sqliteLogicalSnapshot(database: DatabaseSync): {
  readonly userVersion: number;
  readonly tables: ReadonlyMap<string, number>;
} {
  database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (String(integrity?.integrity_check ?? "") !== "ok") {
    throw new Error("migration target SQLite database failed integrity_check");
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) {
    throw new Error("migration target SQLite database failed foreign_key_check");
  }
  const version = database.prepare("PRAGMA user_version").get();
  const tableRows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  const tables = new Map<string, number>();
  for (const row of tableRows) {
    const name = String(row.name);
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const count = database.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get();
    if (count === undefined) throw new Error(`migration target table '${name}' has no count row`);
    tables.set(name, Number(count.count));
  }
  return { userVersion: Number(version?.user_version ?? 0), tables };
}

function assertSqliteLogicalParity(
  logical: ReturnType<typeof sqliteLogicalSnapshot>,
  expected: {
    readonly user_version: number;
    readonly tables: readonly { name: string; row_count: number }[];
  },
  label: string
): void {
  if (logical.userVersion !== expected.user_version) {
    throw new Error(`${label} has the wrong user_version`);
  }
  for (const table of expected.tables) {
    if (logical.tables.get(table.name) !== table.row_count) {
      throw new Error(`${label} row count differs for ${table.name}`);
    }
  }
}

function verifyEmbeddedSqlite(
  target: string,
  expected: {
    readonly user_version: number;
    readonly tables: readonly { name: string; row_count: number }[];
  }
): void {
  assertOwnerFile(target, "migration target embedded SQLite database");
  const { DatabaseSync } = sqliteModule();
  const database = new DatabaseSync(target, { readOnly: true });
  try {
    assertSqliteLogicalParity(
      sqliteLogicalSnapshot(database),
      expected,
      "migration target embedded SQLite database"
    );
  } finally {
    database.close();
  }
}

function expectedTargetUserVersion(store: MigrationPlanStore): number {
  if (store.source_snapshot.kind !== "sqlite") throw new Error("expected SQLite migration store");
  if (store.id === "orchestration-db") return ORCHESTRATION_DATABASE_SCHEMA_VERSION;
  if (store.id === "artifact-manifest") return ARTIFACT_MANIFEST_SCHEMA_VERSION;
  return store.source_snapshot.sqlite.user_version;
}

function verifySqliteStore(
  store: MigrationPlanStore,
  target: string,
  projectId: string
): MigrationVerificationStore {
  assertOwnerFile(target, `migration target ${store.id}`);
  const { DatabaseSync } = sqliteModule();
  const database = new DatabaseSync(target, { readOnly: true });
  try {
    const logical = sqliteLogicalSnapshot(database);
    if (store.source_snapshot.kind !== "sqlite") throw new Error("expected SQLite source snapshot");
    if (store.reconciliation === undefined) {
      assertSqliteLogicalParity(
        logical,
        {
          ...store.source_snapshot.sqlite,
          user_version: expectedTargetUserVersion(store),
          tables: store.source_snapshot.sqlite.tables.filter(
            (table) =>
              table.name !== "store_metadata" ||
              (store.id !== "orchestration-db" && store.id !== "artifact-manifest")
          ),
        },
        `migration target ${store.id}`
      );
    } else {
      if (logical.userVersion !== expectedTargetUserVersion(store)) {
        throw new Error(`migration target ${store.id} has the wrong user_version`);
      }
      const targetEvidence = sqliteTargetEvidence(target);
      if (
        migrationCanonicalJson(targetEvidence.tables) !==
          migrationCanonicalJson(store.reconciliation.target_tables) ||
        targetEvidence.logicalSha256 !== store.reconciliation.target_logical_sha256
      ) {
        throw new Error(`migration target ${store.id} reconciliation evidence differs`);
      }
    }
    if (store.id === "orchestration-db" || store.id === "artifact-manifest") {
      const binding = database.prepare("SELECT project_id FROM store_metadata").get();
      if (String(binding?.project_id ?? "") !== projectId) {
        throw new Error(`migration target ${store.id} has the wrong project binding`);
      }
      if (logical.tables.get("store_metadata") !== 1) {
        throw new Error(`migration target ${store.id} has invalid binding metadata`);
      }
    }
    return {
      id: store.id,
      kind: "sqlite",
      verified: true,
      target_user_version: logical.userVersion,
      target_table_count: logical.tables.size,
      ...(store.reconciliation === undefined ? {} : { reconciliation: store.reconciliation }),
    };
  } finally {
    database.close();
  }
}

function removeIncompleteStagedSqlite(
  target: string,
  injector?: StateMigrationFaultInjector,
  operation = "sqlite-cleanup",
  storeId?: MigrationStoreId
): void {
  const uid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  for (const candidate of [target, `${target}-wal`, `${target}-shm`]) {
    if (!pathExistsNoFollow(candidate)) continue;
    const stat = lstatSync(candidate);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (uid !== undefined && stat.uid !== uid)
    ) {
      throw new Error("incomplete staged SQLite target has unsafe custody");
    }
    unlinkSync(candidate);
  }
  fsyncMigrationDirectory(path.dirname(target), injector, operation, storeId);
}

function fsyncSqliteUnit(
  target: string,
  injector: StateMigrationFaultInjector | undefined,
  operation: string,
  storeId: MigrationStoreId
): void {
  fsyncOwnerFile(target, injector, operation, storeId);
  const wal = `${target}-wal`;
  if (pathExistsNoFollow(wal)) fsyncOwnerFile(wal, injector, `${operation}:wal`, storeId);
  fsyncMigrationDirectory(path.dirname(target), injector, operation, storeId);
}

async function backupSqliteToStaging(
  source: string,
  target: string,
  injector: StateMigrationFaultInjector | undefined,
  operation: string,
  storeId: MigrationStoreId
): Promise<void> {
  ensureOwnerDirectory(path.dirname(target), `migration target directory ${path.dirname(target)}`);
  const { DatabaseSync, backup } = sqliteModule();
  const sourceWal = `${source}-wal`;
  const sourceShm = `${source}-shm`;
  const sourceHadWal = pathExistsNoFollow(sourceWal);
  const sourceHadShm = pathExistsNoFollow(sourceShm);
  const sourceDatabase = new DatabaseSync(source, { readOnly: true });
  let backupError: unknown;
  try {
    sourceDatabase.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    injectFault(injector, "sqlite-backup.before", operation, storeId);
    await backup(sourceDatabase, target);
    injectFault(injector, "sqlite-backup.after", operation, storeId);
  } catch (error) {
    backupError = error;
  } finally {
    sourceDatabase.close();
  }
  if (!sourceHadWal && pathExistsNoFollow(sourceWal)) {
    assertOwnerFile(sourceWal, "transient source SQLite WAL");
    if (lstatSync(sourceWal).size !== 0) {
      throw new Error("SQLite backup changed source WAL state");
    }
    unlinkSync(sourceWal);
  }
  if (!sourceHadShm && pathExistsNoFollow(sourceShm)) {
    assertOwnerFile(sourceShm, "transient source SQLite SHM");
    unlinkSync(sourceShm);
  }
  if (
    (!sourceHadWal && !pathExistsNoFollow(sourceWal)) ||
    (!sourceHadShm && !pathExistsNoFollow(sourceShm))
  ) {
    fsyncMigrationDirectory(path.dirname(source), injector, `${operation}:source`, storeId);
  }
  if (backupError !== undefined) {
    removeIncompleteStagedSqlite(target, injector, operation, storeId);
    throw backupError;
  }
  chmodSync(target, OWNER_FILE_MODE);
  fsyncSqliteUnit(target, injector, operation, storeId);
}

async function copyEmbeddedSqlite(
  source: string,
  target: string,
  expected: {
    readonly user_version: number;
    readonly tables: readonly { name: string; row_count: number }[];
  },
  injector: StateMigrationFaultInjector | undefined,
  operation: string,
  storeId: MigrationStoreId
): Promise<void> {
  if (pathExistsNoFollow(target)) {
    try {
      verifyEmbeddedSqlite(target, expected);
      fsyncSqliteUnit(target, injector, operation, storeId);
      return;
    } catch {
      removeIncompleteStagedSqlite(target, injector, operation, storeId);
    }
  }
  await backupSqliteToStaging(source, target, injector, operation, storeId);
  try {
    verifyEmbeddedSqlite(target, expected);
  } catch (error) {
    removeIncompleteStagedSqlite(target, injector, operation, storeId);
    throw error;
  }
}

async function copySqliteStore(
  source: string,
  target: string,
  store: MigrationPlanStore,
  projectId: string,
  injector: StateMigrationFaultInjector | undefined
): Promise<void> {
  const operation = store.id;
  if (pathExistsNoFollow(target)) {
    try {
      verifySqliteStore(store, target, projectId);
      fsyncSqliteUnit(target, injector, operation, store.id);
      return;
    } catch {
      removeIncompleteStagedSqlite(target, injector, operation, store.id);
    }
  }
  await backupSqliteToStaging(source, target, injector, operation, store.id);
  try {
    chmodSync(target, OWNER_FILE_MODE);
    fsyncSqliteUnit(target, injector, operation, store.id);
    if (store.id === "orchestration-db") {
      using _checkpointer = new Checkpointer(target, undefined, { projectId });
    } else if (store.id === "artifact-manifest") {
      using _artifacts = new ArtifactStore(path.dirname(target), { projectId });
    }
    for (const suffix of ["-wal", "-shm"] as const) {
      const sidecar = `${target}${suffix}`;
      if (pathExistsNoFollow(sidecar)) chmodSync(sidecar, OWNER_FILE_MODE);
    }
    fsyncSqliteUnit(target, injector, operation, store.id);
    verifySqliteStore(store, target, projectId);
  } catch (error) {
    removeIncompleteStagedSqlite(target, injector, operation, store.id);
    throw error;
  }
}

function copyReconciledSqliteStore(
  source: SourceManifest["stores"][number],
  target: string,
  store: MigrationPlanStore,
  plan: StateMigrationPlan,
  injector: StateMigrationFaultInjector | undefined
): void {
  if (source.reconciliation === undefined || store.reconciliation === undefined) {
    throw new Error("reconciled SQLite store metadata is missing");
  }
  if (pathExistsNoFollow(target)) {
    try {
      verifySqliteStore(store, target, plan.target_project_id);
      fsyncSqliteUnit(target, injector, store.id, store.id);
      return;
    } catch {
      removeIncompleteStagedSqlite(target, injector, store.id, store.id);
    }
  }
  try {
    injectFault(injector, "sqlite-reconciliation.before", store.id, store.id);
    const evidence = materializeReconciledSqlite({
      target,
      strategy: source.reconciliation.strategy,
      ...(source.reconciliation.selectionPolicy === undefined
        ? {}
        : { selectionPolicy: source.reconciliation.selectionPolicy }),
      sources: source.candidates.map((candidate) => ({
        sourceId: candidate.sourceId,
        path: candidate.path,
      })),
      projectId: plan.target_project_id,
      bindingCreatedAt: plan.generated_at,
      ...(store.id === "orchestration-db"
        ? {
            postprocess: (databasePath: string) => {
              const keyPath = source.candidates.find(
                (candidate) => candidate.receiptKeyPath !== undefined
              )?.receiptKeyPath;
              if (keyPath !== undefined) {
                normalizeMigratedOrchestrationDatabase(databasePath, keyPath);
              }
            },
          }
        : {}),
    });
    if (migrationCanonicalJson(evidence) !== migrationCanonicalJson(store.reconciliation)) {
      throw new Error("reconciled SQLite result differs from the migration plan");
    }
    fsyncSqliteUnit(target, injector, store.id, store.id);
    verifySqliteStore(store, target, plan.target_project_id);
    injectFault(injector, "sqlite-reconciliation.after", store.id, store.id);
  } catch (error) {
    if (pathExistsNoFollow(target)) {
      removeIncompleteStagedSqlite(target, injector, store.id, store.id);
    }
    throw error;
  }
}

function verifyStore(
  store: MigrationPlanStore,
  paths: ProjectStatePaths,
  projectId: string
): MigrationVerificationStore {
  const target = targetForStore(paths, store.id);
  if (store.kind === "sqlite") return verifySqliteStore(store, target, projectId);
  if (store.source_snapshot.kind === "file") {
    const targetSnapshot = snapshotFile(target, `migration target ${store.id}`);
    if (fileContentSignature(targetSnapshot) !== fileContentSignature(store.source_snapshot.file)) {
      throw new Error(`migration target ${store.id} file differs from the plan`);
    }
    return { id: store.id, kind: "file", verified: true };
  }
  if (store.source_snapshot.kind !== "tree") throw new Error("migration store snapshot is invalid");
  const targetSnapshot = snapshotTree(target, `migration target ${store.id}`, {
    sqlitePathCommitments: treeSqliteCommitments(store.source_snapshot),
  });
  if (treeContentSignature(targetSnapshot) !== treeContentSignature(store.source_snapshot, true)) {
    throw new Error(`migration target ${store.id} tree differs from the plan`);
  }
  return { id: store.id, kind: "tree", verified: true };
}

function verifyStoreWithFault(
  store: MigrationPlanStore,
  paths: ProjectStatePaths,
  projectId: string,
  injector: StateMigrationFaultInjector | undefined
): MigrationVerificationStore {
  injectFault(injector, "store-verification.before", store.id, store.id);
  const result = verifyStore(store, paths, projectId);
  injectFault(injector, "store-verification.after", store.id, store.id);
  return result;
}

function verifyArtifactObjectBindings(paths: ProjectStatePaths): number {
  const { DatabaseSync } = sqliteModule();
  const database = new DatabaseSync(paths.artifacts.manifestDatabase, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const rows = database
      .prepare("SELECT artifact_id, content_digest, byte_length, store_ref FROM artifacts")
      .all();
    for (const row of rows) {
      const artifactId = String(row.artifact_id ?? "");
      const digest = String(row.content_digest ?? "");
      const byteLength = Number(row.byte_length);
      const storeRef = String(row.store_ref ?? "");
      if (!/^art_[a-f0-9]{64}$/u.test(artifactId) || !/^[a-f0-9]{64}$/u.test(digest)) {
        throw new Error("migration target artifact manifest contains an invalid identity");
      }
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new Error(`migration target artifact '${artifactId}' has an invalid byte length`);
      }
      if (storeRef !== `artifact://sha256/${digest}`) {
        throw new Error(`migration target artifact '${artifactId}' has an invalid store ref`);
      }
      const objectPath = path.join(
        paths.artifacts.objects,
        "sha256",
        digest.slice(0, 2),
        digest.slice(2)
      );
      if (!pathExistsNoFollow(objectPath)) {
        throw new Error(`migration target artifact '${artifactId}' object is missing`);
      }
      assertOwnerFile(objectPath, `migration target artifact '${artifactId}' object`);
      const bytes = readFileSync(objectPath);
      if (
        bytes.length !== byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== digest
      ) {
        throw new Error(
          `migration target artifact '${artifactId}' failed exact object verification`
        );
      }
    }
    return rows.length;
  } finally {
    database.close();
  }
}

interface SkillChainReferenceStep {
  readonly inputArtifacts: readonly string[];
  readonly outputArtifactRef?: ReturnType<typeof migrationArtifactRef>;
  readonly handoffArtifactRef?: ReturnType<typeof migrationArtifactRef>;
}

interface SkillChainReferenceProjection {
  readonly steps: readonly SkillChainReferenceStep[];
  readonly pendingSteps: readonly { readonly inputArtifacts: readonly string[] }[];
}

function artifactIdList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (artifactId) => typeof artifactId !== "string" || !/^art_[a-f0-9]{64}$/u.test(artifactId)
    )
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value.filter((artifactId): artifactId is string => typeof artifactId === "string");
}

function skillChainReferenceProjection(value: unknown): SkillChainReferenceProjection {
  if (
    !isUnknownRecord(value) ||
    !Array.isArray(value.steps) ||
    !Array.isArray(value.pending_steps)
  ) {
    throw new Error("migration target skill-chain reference projection is invalid");
  }
  const steps = value.steps.map((candidate, index): SkillChainReferenceStep => {
    if (!isUnknownRecord(candidate)) {
      throw new Error(`migration target skill-chain step ${index} is invalid`);
    }
    const outputArtifactRef =
      candidate.output_artifact_ref === undefined
        ? undefined
        : migrationArtifactRef(
            candidate.output_artifact_ref,
            `migration target skill-chain step ${index} output ref`
          );
    const handoffArtifactRef =
      candidate.handoff_artifact_ref === undefined
        ? undefined
        : migrationArtifactRef(
            candidate.handoff_artifact_ref,
            `migration target skill-chain step ${index} handoff ref`
          );
    return {
      inputArtifacts: artifactIdList(
        candidate.input_artifacts,
        `migration target skill-chain step ${index} inputs`
      ),
      ...(outputArtifactRef === undefined ? {} : { outputArtifactRef }),
      ...(handoffArtifactRef === undefined ? {} : { handoffArtifactRef }),
    };
  });
  const pendingSteps = value.pending_steps.map((candidate, index) => {
    if (!isUnknownRecord(candidate)) {
      throw new Error(`migration target skill-chain pending step ${index} is invalid`);
    }
    return {
      inputArtifacts: artifactIdList(
        candidate.input_artifacts,
        `migration target skill-chain pending step ${index} inputs`
      ),
    };
  });
  return { steps, pendingSteps };
}

function verifySkillChainReferences(
  paths: ProjectStatePaths,
  artifactManifestIncluded: boolean
): number {
  const artifactIds = new Set<string>();
  const exactRefs = new Map<string, unknown>();
  for (const entry of readdirSync(paths.skillChains, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".json") {
      throw new Error("migration target skill-chain directory contains an unexpected entry");
    }
    const checkpointPath = path.join(paths.skillChains, entry.name);
    assertOwnerFile(checkpointPath, "migration target skill-chain checkpoint");
    const bytes = readFileSync(checkpointPath);
    const normalized = transformSkillChainCheckpoint(entry.name, bytes, paths.projectId);
    if (!bytes.equals(normalized)) {
      throw new Error("migration target skill-chain checkpoint is not canonically project-bound");
    }
    const checkpointValue: unknown = JSON.parse(bytes.toString("utf8"));
    const checkpoint = skillChainReferenceProjection(checkpointValue);
    for (const step of checkpoint.steps) {
      for (const artifactId of step.inputArtifacts) artifactIds.add(artifactId);
      if (step.outputArtifactRef !== undefined) {
        artifactIds.add(step.outputArtifactRef.artifact_id);
        exactRefs.set(step.outputArtifactRef.artifact_id, step.outputArtifactRef);
      }
      if (step.handoffArtifactRef !== undefined) {
        artifactIds.add(step.handoffArtifactRef.artifact_id);
        exactRefs.set(step.handoffArtifactRef.artifact_id, step.handoffArtifactRef);
      }
    }
    for (const step of checkpoint.pendingSteps) {
      for (const artifactId of step.inputArtifacts) artifactIds.add(artifactId);
    }
  }
  if (artifactIds.size === 0) return 0;
  if (!artifactManifestIncluded) {
    throw new Error("retained skill-chain artifacts require the artifact manifest migration unit");
  }
  const { DatabaseSync } = sqliteModule();
  const database = new DatabaseSync(paths.artifacts.manifestDatabase, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const statement = database.prepare("SELECT ref_json FROM artifacts WHERE artifact_id = ?");
    for (const artifactId of artifactIds) {
      const row = statement.get(artifactId);
      if (row === undefined) {
        throw new Error(`retained skill-chain artifact '${artifactId}' is missing`);
      }
      const suppliedRef = exactRefs.get(artifactId);
      if (
        suppliedRef !== undefined &&
        migrationCanonicalJson(suppliedRef) !==
          migrationCanonicalJson(JSON.parse(String(row.ref_json)))
      ) {
        throw new Error(`retained skill-chain artifact '${artifactId}' ref differs from manifest`);
      }
    }
    return artifactIds.size;
  } finally {
    database.close();
  }
}

function verifyHistoricalReceipts(paths: ProjectStatePaths): number {
  const { DatabaseSync } = sqliteModule();
  const database = new DatabaseSync(paths.orchestration.database, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const rows = database.prepare("SELECT result_json FROM receipts ORDER BY receipt_id").all();
    for (const row of rows) {
      const result: unknown = JSON.parse(String(row.result_json));
      const receipt =
        result !== null && typeof result === "object" && "worker_receipt" in result
          ? result.worker_receipt
          : result;
      verifyMigrationExecutionReceipt(receipt, paths.orchestration.receiptKey);
    }
    return rows.length;
  } finally {
    database.close();
  }
}

const KB_AUTHORITY_STORE_IDS = new Set<MigrationStoreId>([
  "kb-profiles",
  "kb-host-grants",
  "kb-capabilities",
  "kb-save-claims",
  "kb-operation-receipts",
  "kb-approval",
]);

function verifyCrossStoreInvariants(
  plan: StateMigrationPlan,
  paths: ProjectStatePaths
): MigrationSemanticVerification {
  const ids = new Set(plan.stores.map((store) => store.id));
  const artifactObjectBindings =
    ids.has("artifact-manifest") && ids.has("artifact-objects")
      ? verifyArtifactObjectBindings(paths)
      : 0;
  const historicalReceipts =
    ids.has("orchestration-db") && ids.has("orchestration-receipt-key")
      ? verifyHistoricalReceipts(paths)
      : 0;
  const skillChainArtifactRefs = ids.has("skill-chains")
    ? verifySkillChainReferences(paths, ids.has("artifact-manifest"))
    : 0;
  return {
    historical_receipts_verified: historicalReceipts,
    artifact_object_bindings_verified: artifactObjectBindings,
    skill_chain_artifact_refs_verified: skillChainArtifactRefs,
    kb_authorities: plan.stores
      .filter((store) => KB_AUTHORITY_STORE_IDS.has(store.id))
      .map((store) => ({
        store_id: store.id,
        files_verified:
          store.source_snapshot.kind === "tree" ? store.source_snapshot.file_count : 1,
        sqlite_units_verified:
          store.source_snapshot.kind === "tree"
            ? store.source_snapshot.files.filter((file) => file.kind === "sqlite").length
            : store.source_snapshot.kind === "sqlite"
              ? 1
              : 0,
      })),
  };
}

function verifyCrossStoreInvariantsWithFault(
  plan: StateMigrationPlan,
  paths: ProjectStatePaths,
  injector: StateMigrationFaultInjector | undefined
): MigrationSemanticVerification {
  injectFault(injector, "store-verification.before", "cross-store");
  const result = verifyCrossStoreInvariants(plan, paths);
  injectFault(injector, "store-verification.after", "cross-store");
  return result;
}

function readMarker(file: string, plan: StateMigrationPlan): FinalizedMarker {
  assertOwnerFile(file, "migration finalized marker");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isUnknownRecord(parsed)) {
    throw new Error("migration finalized marker does not match the plan");
  }
  if (
    parsed.schema_version !== 1 ||
    parsed.migration_id !== plan.migration_id ||
    parsed.plan_sha256 !== plan.plan_sha256 ||
    parsed.project_id !== plan.target_project_id ||
    parsed.state_layout_version !== PENNY_STATE_LAYOUT_VERSION ||
    typeof parsed.finalized_at !== "string"
  ) {
    throw new Error("migration finalized marker does not match the plan");
  }
  return {
    schema_version: 1,
    migration_id: plan.migration_id,
    plan_sha256: plan.plan_sha256,
    project_id: plan.target_project_id,
    state_layout_version: PENNY_STATE_LAYOUT_VERSION,
    finalized_at: parsed.finalized_at,
  };
}

function resultFromJournal(journal: MigrationJournal): MigrationPhaseResult {
  return {
    migration_id: journal.migration_id,
    project_id: journal.project_id,
    plan_sha256: journal.plan_sha256,
    phase: journal.phase,
    completed_stores: journal.completed_stores,
    finalized: journal.phase === "finalized",
  };
}

export async function applyStateMigration(input: {
  readonly projectRoot: string;
  readonly sourceManifestPath: string;
  readonly planPath: string;
  readonly rootOptions?: ResolvePennyStateRootOptions;
  readonly faultInjector?: StateMigrationFaultInjector;
}): Promise<MigrationPhaseResult> {
  const plan = readStateMigrationPlan(input.planPath);
  const state = validatePlanContext(input.projectRoot, plan, input.rootOptions ?? {});
  const finalPaths = projectStatePaths(state, plan.target_project_id);
  const finalMarker = path.join(finalPaths.root, STATE_MIGRATION_FINALIZED_MARKER);
  if (pathExistsNoFollow(finalMarker)) {
    readMarker(finalMarker, plan);
    for (const store of plan.stores) {
      verifyStoreWithFault(store, finalPaths, plan.target_project_id, input.faultInjector);
    }
    verifyCrossStoreInvariantsWithFault(plan, finalPaths, input.faultInjector);
    using catalog = new ProjectCatalog(state.root, { create: false });
    const project = catalog.projectById(plan.target_project_id);
    if (project?.lifecycleState !== "active") {
      throw new Error("finalized migration project is not active in the catalog");
    }
    return {
      migration_id: plan.migration_id,
      project_id: plan.target_project_id,
      plan_sha256: plan.plan_sha256,
      phase: "finalized",
      completed_stores: plan.stores.map((store) => store.id),
      finalized: true,
    };
  }
  if (pathExistsNoFollow(finalPaths.root)) {
    throw new Error("migration target project partition is preexisting or divergent");
  }

  const source = readMigrationSourceManifest(input.sourceManifestPath);
  validateSource(input.sourceManifestPath, source, plan);
  injectFault(input.faultInjector, "apply-start", "apply");
  initializePennyStateInfrastructure(input.rootOptions ?? {});

  return withMigrationLock(state, plan.migration_id, input.faultInjector, async () => {
    using catalog = new ProjectCatalog(state.root, { create: true });
    injectFault(input.faultInjector, "catalog-reservation.before", "catalog-reservation");
    catalog.reserveMigrationProject({
      projectRoot: input.projectRoot,
      projectId: plan.target_project_id,
      migrationId: plan.migration_id,
      planSha256: plan.plan_sha256,
    });
    injectFault(input.faultInjector, "catalog-reservation.after", "catalog-reservation");

    const work = workspace(state, plan.migration_id);
    if (!pathExistsNoFollow(work.root)) {
      ensureOwnerDirectory(work.root, "migration workspace");
    } else {
      assertOwnerDirectory(work.root, "migration workspace");
    }
    let journal: MigrationJournal;
    if (pathExistsNoFollow(work.journal)) {
      journal = readJournal(work.journal, plan);
      if (journal.phase === "finalized") return resultFromJournal(journal);
      if (journal.phase === "verified") return resultFromJournal(journal);
    } else {
      if (readdirSync(work.root).length !== 0) {
        throw new Error("migration workspace exists without a manifest-bound journal");
      }
      journal = initialJournal(plan);
      atomicOwnerJson(work.journal, journal, input.faultInjector, "journal:initial");
    }

    ensureOwnerDirectory(work.staging, "migration staging root");
    ensureOwnerDirectory(work.stagedProject, "migration staged project");
    const stagedPaths = projectStatePathsAtRoot(work.stagedProject, plan.target_project_id);
    ensureProjectStateDirectories(stagedPaths);

    for (const store of plan.stores) {
      if (journal.completed_stores.includes(store.id)) {
        verifyStoreWithFault(store, stagedPaths, plan.target_project_id, input.faultInjector);
        continue;
      }
      assertMigrationStoresUnchanged(
        plan.stores,
        inspectMigrationStores(source.manifest, {
          targetProjectId: plan.target_project_id,
          bindingCreatedAt: plan.generated_at,
        })
      );
      const declaredSource = sourceStore(source.manifest, store.id);
      const sourcePath = declaredSource.path;
      const targetPath = targetForStore(stagedPaths, store.id);
      if (store.kind === "sqlite") {
        if (store.reconciliation === undefined) {
          await copySqliteStore(
            sourcePath,
            targetPath,
            store,
            plan.target_project_id,
            input.faultInjector
          );
        } else {
          copyReconciledSqliteStore(declaredSource, targetPath, store, plan, input.faultInjector);
        }
      } else if (store.kind === "file") {
        copyOwnerFile(sourcePath, targetPath, input.faultInjector, store.id, store.id);
      } else {
        if (store.source_snapshot.kind !== "tree") {
          throw new Error("migration tree store snapshot is invalid");
        }
        await copyOwnerTree(
          sourcePath,
          targetPath,
          declaredSource.sqliteFiles,
          store.source_snapshot,
          input.faultInjector,
          store.id,
          store.id === "skill-chains"
            ? (relativePath, bytes) =>
                transformSkillChainCheckpoint(relativePath, bytes, plan.target_project_id)
            : undefined
        );
      }
      assertMigrationStoresUnchanged(
        plan.stores,
        inspectMigrationStores(source.manifest, {
          targetProjectId: plan.target_project_id,
          bindingCreatedAt: plan.generated_at,
        })
      );
      verifyStoreWithFault(store, stagedPaths, plan.target_project_id, input.faultInjector);
      journal = updateJournal(
        work.journal,
        journal,
        { completed_stores: [...journal.completed_stores, store.id] },
        input.faultInjector,
        `store:${store.id}`
      );
    }
    fsyncMigrationDirectory(work.stagedProject, input.faultInjector, "staged-project");
    journal = updateJournal(
      work.journal,
      journal,
      { phase: "applied" },
      input.faultInjector,
      "applied"
    );
    return resultFromJournal(journal);
  });
}

export function verifyStateMigrationSourcesUnchanged(input: {
  readonly projectRoot: string;
  readonly sourceManifestPath: string;
  readonly planPath: string;
  readonly rootOptions?: ResolvePennyStateRootOptions;
}): StateMigrationPlan {
  const plan = readStateMigrationPlan(input.planPath);
  validatePlanContext(input.projectRoot, plan, input.rootOptions ?? {});
  const source = readMigrationSourceManifest(input.sourceManifestPath);
  validateSource(input.sourceManifestPath, source, plan);
  return plan;
}

export async function verifyStateMigration(input: {
  readonly projectRoot: string;
  readonly planPath: string;
  readonly rootOptions?: ResolvePennyStateRootOptions;
  readonly faultInjector?: StateMigrationFaultInjector;
}): Promise<StateMigrationVerification> {
  const plan = readStateMigrationPlan(input.planPath);
  const state = validatePlanContext(input.projectRoot, plan, input.rootOptions ?? {});
  return withMigrationLock(state, plan.migration_id, input.faultInjector, async () => {
    const work = workspace(state, plan.migration_id);
    const journal = readJournal(work.journal, plan);
    if (
      journal.phase !== "applied" &&
      journal.phase !== "verified" &&
      journal.phase !== "finalized"
    ) {
      throw new Error("migration must finish apply before verification");
    }
    const finalPaths = projectStatePaths(state, plan.target_project_id);
    const finalMarker = path.join(finalPaths.root, STATE_MIGRATION_FINALIZED_MARKER);
    const targetPaths = pathExistsNoFollow(finalMarker)
      ? (readMarker(finalMarker, plan), finalPaths)
      : projectStatePathsAtRoot(work.stagedProject, plan.target_project_id);
    const stores = plan.stores.map((store) =>
      verifyStoreWithFault(store, targetPaths, plan.target_project_id, input.faultInjector)
    );
    const semanticVerification = verifyCrossStoreInvariantsWithFault(
      plan,
      targetPaths,
      input.faultInjector
    );
    const updated =
      journal.phase === "applied"
        ? updateJournal(
            work.journal,
            journal,
            { phase: "verified" },
            input.faultInjector,
            "verified"
          )
        : journal;
    return {
      ...resultFromJournal(updated),
      phase: updated.phase === "finalized" ? "finalized" : "verified",
      stores,
      semantic_verification: semanticVerification,
    };
  });
}

export async function finalizeStateMigration(input: {
  readonly projectRoot: string;
  readonly planPath: string;
  readonly rootOptions?: ResolvePennyStateRootOptions;
  readonly faultInjector?: StateMigrationFaultInjector;
}): Promise<MigrationPhaseResult> {
  const plan = readStateMigrationPlan(input.planPath);
  const state = validatePlanContext(input.projectRoot, plan, input.rootOptions ?? {});
  return withMigrationLock(state, plan.migration_id, input.faultInjector, async () => {
    const work = workspace(state, plan.migration_id);
    let journal = readJournal(work.journal, plan);
    const finalPaths = projectStatePaths(state, plan.target_project_id);
    const finalMarker = path.join(finalPaths.root, STATE_MIGRATION_FINALIZED_MARKER);

    using catalog = new ProjectCatalog(state.root, { create: false });
    if (pathExistsNoFollow(finalPaths.root)) {
      readMarker(finalMarker, plan);
      for (const store of plan.stores) {
        verifyStoreWithFault(store, finalPaths, plan.target_project_id, input.faultInjector);
      }
      verifyCrossStoreInvariantsWithFault(plan, finalPaths, input.faultInjector);
      const project = catalog.projectById(plan.target_project_id);
      if (project?.lifecycleState === "relink_pending") {
        injectFault(input.faultInjector, "catalog-activation.before", "catalog-activation");
        catalog.activateMigrationProject({
          projectId: plan.target_project_id,
          migrationId: plan.migration_id,
          planSha256: plan.plan_sha256,
        });
        injectFault(input.faultInjector, "catalog-activation.after", "catalog-activation");
      } else if (project?.lifecycleState !== "active") {
        throw new Error("finalized migration project is not active in the catalog");
      }
      if (journal.phase !== "finalized") {
        journal = updateJournal(
          work.journal,
          journal,
          { phase: "finalized" },
          input.faultInjector,
          "finalized"
        );
      }
      return resultFromJournal(journal);
    }

    if (journal.phase !== "verified") {
      throw new Error("migration must pass verify before finalize");
    }
    const stagedPaths = projectStatePathsAtRoot(work.stagedProject, plan.target_project_id);
    for (const store of plan.stores) {
      verifyStoreWithFault(store, stagedPaths, plan.target_project_id, input.faultInjector);
    }
    verifyCrossStoreInvariantsWithFault(plan, stagedPaths, input.faultInjector);
    const marker: FinalizedMarker = {
      schema_version: 1,
      migration_id: plan.migration_id,
      plan_sha256: plan.plan_sha256,
      project_id: plan.target_project_id,
      state_layout_version: PENNY_STATE_LAYOUT_VERSION,
      finalized_at: new Date().toISOString(),
    };
    injectFault(input.faultInjector, "finalized-marker.before", "finalized-marker");
    atomicOwnerJson(
      path.join(work.stagedProject, STATE_MIGRATION_FINALIZED_MARKER),
      marker,
      input.faultInjector,
      "finalized-marker"
    );
    injectFault(input.faultInjector, "finalized-marker.after", "finalized-marker");
    if (pathExistsNoFollow(finalPaths.root)) {
      throw new Error("migration target project partition already exists");
    }
    injectFault(input.faultInjector, "project-rename.before", "project-publication");
    renameSync(work.stagedProject, finalPaths.root);
    injectFault(input.faultInjector, "project-rename.after", "project-publication");
    fsyncMigrationDirectory(state.projects, input.faultInjector, "project-publication");
    readMarker(finalMarker, plan);
    injectFault(input.faultInjector, "catalog-activation.before", "catalog-activation");
    catalog.activateMigrationProject({
      projectId: plan.target_project_id,
      migrationId: plan.migration_id,
      planSha256: plan.plan_sha256,
    });
    injectFault(input.faultInjector, "catalog-activation.after", "catalog-activation");
    journal = updateJournal(
      work.journal,
      journal,
      { phase: "finalized" },
      input.faultInjector,
      "finalized"
    );
    return resultFromJournal(journal);
  });
}
