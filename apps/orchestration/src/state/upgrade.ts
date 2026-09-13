import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { ArtifactStore } from "../artifact-store.js";
import {
  Checkpointer,
  ORCHESTRATION_DATABASE_SCHEMA_VERSION,
  type OrchestrationSchemaUpgradeResult,
} from "../checkpointer.js";
import { ReceiptAuthority } from "../receipts.js";
import { canonicalJson } from "../canonical-json.js";
import {
  assertOwnerDirectory,
  assertOwnerFile,
  assertSafeAncestorChain,
  ensureOwnerDirectory,
  fsyncDirectory,
  OWNER_FILE_MODE,
  pathExistsNoFollow,
} from "./custody.js";
import { projectRootCommitment } from "./catalog.js";
import { resolvePennyProjectState } from "./setup.js";
import type { ResolvePennyStateRootOptions } from "./paths.js";

export const STATE_UPGRADE_BACKUP_SCHEMA_VERSION = 1 as const;
const BACKUP_DATABASE_NAME = "orchestration-before-upgrade.db";
const BACKUP_MANIFEST_NAME = "upgrade-backup.json";
const UPGRADE_LOCK_PREFIX = "upgrade-";

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  readonly backup: typeof import("node:sqlite").backup;
}

export type StateUpgradeFaultPoint =
  | "lock-acquired"
  | "backup-created"
  | "before-schema-mutation"
  | "after-v11-migration"
  | "after-v12-migration"
  | "schema-committed";

export interface UpgradePennyStateInput {
  readonly projectRoot: string;
  readonly backupDirectory: string;
  readonly rootOptions?: ResolvePennyStateRootOptions;
  readonly faultInjector?: (point: StateUpgradeFaultPoint) => void;
}

export interface UpgradePennyStateResult extends OrchestrationSchemaUpgradeResult {
  readonly projectId: string;
  readonly backupRoot: string | null;
  readonly backupDatabase: string | null;
}

interface UpgradeBackupManifest {
  readonly schema_version: 1;
  readonly phase: "prepared" | "upgraded";
  readonly project_id: string;
  readonly project_root_commitment: string;
  readonly source_schema_version: number;
  readonly target_schema_version: number;
  readonly database_file: typeof BACKUP_DATABASE_NAME;
  readonly database_sha256: string;
  readonly created_at: string;
  readonly upgraded_at?: string;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSqliteModule(value: unknown): value is SqliteModule {
  return (
    isUnknownRecord(value) &&
    typeof value["DatabaseSync"] === "function" &&
    typeof value["backup"] === "function"
  );
}

function sqliteModule(): SqliteModule {
  const value: unknown = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(value)) {
    throw new Error("Node.js runtime does not provide node:sqlite backup support");
  }
  return value;
}

function errorHasCode(error: unknown, code: string): boolean {
  return isUnknownRecord(error) && error["code"] === code;
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  const contained = (relative: string): boolean =>
    relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
  return contained(leftToRight) || contained(rightToLeft);
}

function createBackupRoot(parent: string, projectId: string): string {
  ensureOwnerDirectory(parent, "Penny state-upgrade backup parent");
  const canonicalParent = realpathSync.native(parent);
  assertOwnerDirectory(canonicalParent, "Penny state-upgrade backup parent");
  const backupRoot = path.join(canonicalParent, `penny-state-upgrade-${projectId}-${randomUUID()}`);
  mkdirSync(backupRoot, { mode: 0o700 });
  assertOwnerDirectory(backupRoot, "Penny state-upgrade backup root");
  fsyncDirectory(canonicalParent);
  return backupRoot;
}

async function sha256File(file: string): Promise<string> {
  assertOwnerFile(file, "Penny state-upgrade backup database");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stream = createReadStream(file, { fd: descriptor, autoClose: true });
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function writeOwnerJson(file: string, value: unknown): void {
  const parent = path.dirname(file);
  const temporary = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    OWNER_FILE_MODE
  );
  try {
    writeFileSync(descriptor, `${canonicalJson(value)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  assertOwnerFile(file, "Penny state-upgrade backup manifest");
  fsyncDirectory(parent);
}

async function createVerifiedBackup(input: {
  readonly databasePath: string;
  readonly backupRoot: string;
  readonly projectId: string;
  readonly projectRootCommitment: string;
  readonly sourceVersion: number;
}): Promise<{ database: string; manifest: UpgradeBackupManifest }> {
  const database = path.join(input.backupRoot, BACKUP_DATABASE_NAME);
  const { DatabaseSync, backup } = sqliteModule();
  using source = new DatabaseSync(input.databasePath, { readOnly: true });
  source.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
  await backup(source, database);
  chmodSync(database, OWNER_FILE_MODE);
  {
    using backupDatabase = new DatabaseSync(database);
    backupDatabase.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;"
    );
  }
  assertOwnerFile(database, "Penny state-upgrade backup database");
  const databaseSha256 = await sha256File(database);
  const inspection = Checkpointer.inspectExistingSchema(database, input.projectId);
  if (inspection.actualVersion !== input.sourceVersion || !inspection.upgradeSupported) {
    throw new Error("state-upgrade backup does not match the admitted source schema");
  }
  const manifest: UpgradeBackupManifest = {
    schema_version: STATE_UPGRADE_BACKUP_SCHEMA_VERSION,
    phase: "prepared",
    project_id: input.projectId,
    project_root_commitment: input.projectRootCommitment,
    source_schema_version: input.sourceVersion,
    target_schema_version: ORCHESTRATION_DATABASE_SCHEMA_VERSION,
    database_file: BACKUP_DATABASE_NAME,
    database_sha256: databaseSha256,
    created_at: new Date().toISOString(),
  };
  writeOwnerJson(path.join(input.backupRoot, BACKUP_MANIFEST_NAME), manifest);
  fsyncDirectory(input.backupRoot);
  return { database, manifest };
}

function lockPath(stateLocks: string, projectId: string): string {
  const suffix = createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 24);
  return path.join(stateLocks, `${UPGRADE_LOCK_PREFIX}${suffix}.lock`);
}

async function withUpgradeLock<T>(
  stateLocks: string,
  projectId: string,
  operation: () => Promise<T>
): Promise<T> {
  assertOwnerDirectory(stateLocks, "Penny state lock directory");
  const file = lockPath(stateLocks, projectId);
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      OWNER_FILE_MODE
    );
  } catch (error) {
    if (errorHasCode(error, "EEXIST")) {
      throw new Error(
        "state upgrade is locked by another operator process or requires explicit lock recovery"
      );
    }
    throw error;
  }
  try {
    writeFileSync(
      descriptor,
      `${canonicalJson({ schema_version: 1, operation: "state-upgrade", project_id: projectId })}\n`,
      "utf8"
    );
    fsyncSync(descriptor);
    fsyncDirectory(stateLocks);
    return await operation();
  } finally {
    closeSync(descriptor);
    if (pathExistsNoFollow(file)) unlinkSync(file);
    fsyncDirectory(stateLocks);
  }
}

/** Explicit, backup-first upgrade of one already-active project partition. */
export async function upgradePennyState(
  input: UpgradePennyStateInput
): Promise<UpgradePennyStateResult> {
  if (!path.isAbsolute(input.projectRoot)) throw new Error("project root must be absolute");
  if (!path.isAbsolute(input.backupDirectory)) throw new Error("backup directory must be absolute");
  const resolved = resolvePennyProjectState(input.projectRoot, input.rootOptions ?? {});
  ArtifactStore.verifyExisting(resolved.paths.artifacts.root, { projectId: resolved.projectId });
  ReceiptAuthority.loadExisting(resolved.paths.orchestration.receiptKey);
  const inspection = Checkpointer.inspectExistingSchema(
    resolved.paths.orchestration.database,
    resolved.projectId
  );
  if (!inspection.upgradeRequired) {
    return {
      projectId: resolved.projectId,
      sourceVersion: inspection.actualVersion,
      targetVersion: inspection.requiredVersion,
      changed: false,
      backupRoot: null,
      backupDatabase: null,
    };
  }
  if (!inspection.upgradeSupported) {
    throw new Error(
      `orchestration schema ${inspection.actualVersion} has no supported active-project upgrade`
    );
  }

  assertSafeAncestorChain(input.backupDirectory, "Penny state-upgrade backup parent");
  const prospectiveBackup = path.resolve(input.backupDirectory);
  if (
    pathsOverlap(prospectiveBackup, resolved.state.root) ||
    pathsOverlap(prospectiveBackup, resolved.canonicalProjectRoot)
  ) {
    throw new Error("backup directory must not overlap the Penny state root or project root");
  }

  return withUpgradeLock(resolved.state.locks, resolved.projectId, async () => {
    input.faultInjector?.("lock-acquired");
    const backupRoot = createBackupRoot(prospectiveBackup, resolved.projectId);
    const backupState: {
      database?: string;
      manifest?: UpgradeBackupManifest;
    } = {};
    const result = await Checkpointer.upgradeExisting(
      resolved.paths.orchestration.database,
      resolved.projectId,
      async (sourceVersion) => {
        const backup = await createVerifiedBackup({
          databasePath: resolved.paths.orchestration.database,
          backupRoot,
          projectId: resolved.projectId,
          projectRootCommitment: projectRootCommitment(resolved.canonicalProjectRoot),
          sourceVersion,
        });
        backupState.database = backup.database;
        backupState.manifest = backup.manifest;
        input.faultInjector?.("backup-created");
        input.faultInjector?.("before-schema-mutation");
      },
      async (targetVersion) => {
        input.faultInjector?.(targetVersion === 11 ? "after-v11-migration" : "after-v12-migration");
      }
    );
    input.faultInjector?.("schema-committed");
    Checkpointer.verifyExisting(resolved.paths.orchestration.database, {
      projectId: resolved.projectId,
    });
    ArtifactStore.verifyExisting(resolved.paths.artifacts.root, { projectId: resolved.projectId });
    ReceiptAuthority.loadExisting(resolved.paths.orchestration.receiptKey);
    const backupDatabase = backupState.database;
    const preparedManifest = backupState.manifest;
    if (backupDatabase === undefined || preparedManifest === undefined) {
      throw new Error("state upgrade changed schema without producing its required backup");
    }
    const manifestPath = path.join(backupRoot, BACKUP_MANIFEST_NAME);
    writeOwnerJson(manifestPath, {
      ...preparedManifest,
      phase: "upgraded",
      upgraded_at: new Date().toISOString(),
    } satisfies UpgradeBackupManifest);
    return {
      projectId: resolved.projectId,
      ...result,
      backupRoot,
      backupDatabase,
    };
  });
}
