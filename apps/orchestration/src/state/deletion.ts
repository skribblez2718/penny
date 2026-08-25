import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  migrationCanonicalJson,
  pathCommitment,
  readMigrationSourceManifest,
  readStateMigrationPlan,
} from "./migration-plan.js";
import {
  STATE_MIGRATION_FINALIZED_MARKER,
  verifyStateMigrationSourcesUnchanged,
} from "./migration.js";
import { resolvePennyProjectState } from "./setup.js";
import {
  assertOwnerFile,
  assertSafeAncestorChain,
  fsyncDirectory,
  pathExistsNoFollow,
} from "./custody.js";
import {
  pennyStatePaths,
  resolvePennyStateRoot,
  type ResolvePennyStateRootOptions,
} from "./paths.js";

const DELETE_CONFIRMATION_SUFFIX = "DELETE-ALL-MANAGED-LEGACY";
const APPROVAL_VERSION = 1 as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface LegacyDeletionEntry {
  readonly id: string;
  readonly path: string;
  readonly kind: "file" | "sqlite" | "tree";
}

export interface LegacyDeletionManifest {
  readonly schema_version: 1;
  readonly migration_id: string;
  readonly entries: readonly LegacyDeletionEntry[];
}

interface DeletionApprovalEntry {
  readonly id: string;
  readonly path_commitment: string;
  readonly kind: LegacyDeletionEntry["kind"];
  readonly snapshot_sha256: string;
}

interface DeletionApproval {
  readonly schema_version: 1;
  readonly action: "delete-managed-legacy";
  readonly migration_id: string;
  readonly project_id: string;
  readonly plan_sha256: string;
  readonly source_manifest_sha256: string;
  readonly deletion_manifest_sha256: string;
  readonly approval_nonce: string;
  readonly approved_at: string;
  readonly status: "approved" | "deleting" | "completed";
  readonly entries: readonly DeletionApprovalEntry[];
  readonly completed_entry_ids: readonly string[];
  readonly completed_at?: string;
}

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isSqliteModule(value: object | undefined): value is SqliteModule {
  return value !== undefined && "DatabaseSync" in value && typeof value.DatabaseSync === "function";
}

function sqliteModule(): SqliteModule {
  const module = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) throw new Error("Node.js runtime does not provide node:sqlite");
  return module;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function parseDeletionManifest(file: string): {
  readonly manifest: LegacyDeletionManifest;
  readonly sha256: string;
} {
  assertOwnerFile(file, "legacy deletion manifest");
  const bytes = readFileSync(file);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const value = objectValue(parsed, "legacy deletion manifest");
  if (
    value.schema_version !== 1 ||
    !Array.isArray(value.entries) ||
    typeof value.migration_id !== "string" ||
    !ID_PATTERN.test(value.migration_id)
  ) {
    throw new Error("legacy deletion manifest is invalid");
  }
  const entries = value.entries.map((candidate, index): LegacyDeletionEntry => {
    if (!isUnknownRecord(candidate)) {
      throw new Error(`legacy deletion manifest entry ${index} is invalid`);
    }
    if (
      typeof candidate.id !== "string" ||
      !ID_PATTERN.test(candidate.id) ||
      typeof candidate.path !== "string" ||
      !path.isAbsolute(candidate.path) ||
      (candidate.kind !== "file" && candidate.kind !== "sqlite" && candidate.kind !== "tree")
    ) {
      throw new Error(`legacy deletion manifest entry ${index} is invalid`);
    }
    return {
      id: candidate.id,
      path: path.normalize(candidate.path),
      kind: candidate.kind,
    };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("legacy deletion manifest entry IDs must be unique");
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("legacy deletion manifest paths must be unique");
  }
  return {
    manifest: { schema_version: 1, migration_id: value.migration_id, entries },
    sha256: sha256(bytes),
  };
}

function assertDeletionPathAllowed(
  entry: LegacyDeletionEntry,
  projectRoot: string,
  stateRoot: string
): void {
  const candidate = path.resolve(entry.path);
  const canonicalProject = path.resolve(projectRoot);
  const agentDirectory = path.dirname(stateRoot);
  const protectedRoots = [
    stateRoot,
    path.join(agentDirectory, "sessions"),
    path.join(os.homedir(), ".local", "share", "penny", "mempalace"),
    path.join(os.homedir(), ".local", "share", "penny", "memory"),
    path.join(os.homedir(), ".local", "state", "penny", "memory"),
    path.join(os.homedir(), ".config", "penny", "memory"),
  ];
  if (candidate === canonicalProject || isWithin(candidate, canonicalProject)) {
    throw new Error(`deletion entry '${entry.id}' would remove the project root`);
  }
  if (
    protectedRoots.some(
      (protectedRoot) => isWithin(candidate, protectedRoot) || isWithin(protectedRoot, candidate)
    )
  ) {
    throw new Error(`deletion entry '${entry.id}' overlaps protected state`);
  }
  assertSafeAncestorChain(
    entry.kind === "tree" ? candidate : path.dirname(candidate),
    `legacy deletion entry '${entry.id}'`
  );
  if (!pathExistsNoFollow(candidate)) {
    throw new Error(`legacy deletion entry '${entry.id}' is missing before approval`);
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`deletion entry '${entry.id}' is a symlink`);
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new Error(`deletion entry '${entry.id}' has the wrong owner`);
  }
  if (entry.kind === "tree" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`deletion entry '${entry.id}' has the wrong type`);
  }
}

function hashFile(file: string): string {
  const digest = createHash("sha256");
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function snapshotEntry(entry: LegacyDeletionEntry): string {
  if (entry.kind !== "tree") {
    const stat = lstatSync(entry.path);
    return sha256(`${stat.size}:${stat.mode & 0o777}:${hashFile(entry.path)}`);
  }
  const digest = createHash("sha256");
  const visit = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(entry.path, absolute);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`deletion tree '${entry.id}' contains a symlink`);
      if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
        throw new Error(`deletion tree '${entry.id}' contains a foreign owner`);
      }
      if (child.isDirectory()) {
        digest.update(`d\0${relative}\0${stat.mode & 0o777}\0`);
        visit(absolute);
      } else if (child.isFile()) {
        digest.update(
          `f\0${relative}\0${stat.size}\0${stat.mode & 0o777}\0${hashFile(absolute)}\0`
        );
      } else {
        throw new Error(`deletion tree '${entry.id}' contains an unsupported entry`);
      }
    }
  };
  visit(entry.path);
  return digest.digest("hex");
}

function atomicApproval(file: string, approval: DeletionApproval): void {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  writeFileSync(temporary, `${migrationCanonicalJson(approval)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
}

function readApproval(file: string): DeletionApproval {
  assertOwnerFile(file, "legacy deletion approval");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const value = objectValue(parsed, "legacy deletion approval");
  if (
    value.schema_version !== APPROVAL_VERSION ||
    value.action !== "delete-managed-legacy" ||
    typeof value.migration_id !== "string" ||
    typeof value.project_id !== "string" ||
    typeof value.plan_sha256 !== "string" ||
    typeof value.source_manifest_sha256 !== "string" ||
    typeof value.deletion_manifest_sha256 !== "string" ||
    typeof value.approval_nonce !== "string" ||
    typeof value.approved_at !== "string" ||
    (value.status !== "approved" && value.status !== "deleting" && value.status !== "completed") ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.completed_entry_ids) ||
    value.completed_entry_ids.some((id) => typeof id !== "string") ||
    (value.completed_at !== undefined && typeof value.completed_at !== "string")
  ) {
    throw new Error("legacy deletion approval is invalid");
  }
  const entries = value.entries.map((candidate, index): DeletionApprovalEntry => {
    if (
      !isUnknownRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.path_commitment !== "string" ||
      (candidate.kind !== "file" && candidate.kind !== "sqlite" && candidate.kind !== "tree") ||
      typeof candidate.snapshot_sha256 !== "string"
    ) {
      throw new Error(`legacy deletion approval entry ${index} is invalid`);
    }
    return {
      id: candidate.id,
      path_commitment: candidate.path_commitment,
      kind: candidate.kind,
      snapshot_sha256: candidate.snapshot_sha256,
    };
  });
  const completedEntryIds = value.completed_entry_ids.filter(
    (id): id is string => typeof id === "string"
  );
  return {
    schema_version: APPROVAL_VERSION,
    action: "delete-managed-legacy",
    migration_id: value.migration_id,
    project_id: value.project_id,
    plan_sha256: value.plan_sha256,
    source_manifest_sha256: value.source_manifest_sha256,
    deletion_manifest_sha256: value.deletion_manifest_sha256,
    approval_nonce: value.approval_nonce,
    approved_at: value.approved_at,
    status: value.status,
    entries,
    completed_entry_ids: completedEntryIds,
    ...(value.completed_at === undefined ? {} : { completed_at: value.completed_at }),
  };
}

function verifyPostCutoverTarget(
  projectRoot: string,
  plan: ReturnType<typeof readStateMigrationPlan>,
  rootOptions: ResolvePennyStateRootOptions | undefined
): void {
  const resolved = resolvePennyProjectState(projectRoot, rootOptions ?? {});
  if (resolved.projectId !== plan.target_project_id) {
    throw new Error("post-cutover project binding differs from the migration plan");
  }
  const markerPath = path.join(resolved.paths.root, STATE_MIGRATION_FINALIZED_MARKER);
  assertOwnerFile(markerPath, "migration finalized marker");
  const markerValue: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
  const marker = objectValue(markerValue, "migration finalized marker");
  if (
    marker.migration_id !== plan.migration_id ||
    marker.project_id !== plan.target_project_id ||
    marker.plan_sha256 !== plan.plan_sha256
  ) {
    throw new Error("post-cutover finalized marker differs from the migration plan");
  }
  const sqlite = sqliteModule();
  const includedStores = new Set(plan.stores.map((store) => store.id));
  const databases = [
    ...(includedStores.has("orchestration-db") ? [resolved.paths.orchestration.database] : []),
    ...(includedStores.has("artifact-manifest") ? [resolved.paths.artifacts.manifestDatabase] : []),
  ];
  for (const databasePath of databases) {
    assertOwnerFile(databasePath, "post-cutover canonical database");
    const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const integrity = database.prepare("PRAGMA integrity_check").get();
      if (String(integrity?.integrity_check ?? "") !== "ok") {
        throw new Error("post-cutover canonical database failed integrity_check");
      }
      if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
        throw new Error("post-cutover canonical database failed foreign_key_check");
      }
      const binding = database.prepare("SELECT project_id FROM store_metadata").get();
      if (String(binding?.project_id ?? "") !== plan.target_project_id) {
        throw new Error("post-cutover canonical database has the wrong project binding");
      }
    } finally {
      database.close();
    }
  }
}

function requiredSourcePaths(sourceManifestPath: string): readonly string[] {
  const source = readMigrationSourceManifest(sourceManifestPath).manifest;
  return source.stores.flatMap((store) => [
    store.path,
    ...store.candidates.flatMap((candidate) => [
      candidate.path,
      ...(candidate.receiptKeyPath ? [candidate.receiptKeyPath] : []),
    ]),
  ]);
}

function assertSourceCoverage(
  deletionEntries: readonly LegacyDeletionEntry[],
  sourceManifestPath: string
): void {
  for (const sourcePath of new Set(requiredSourcePaths(sourceManifestPath))) {
    if (!deletionEntries.some((entry) => isWithin(entry.path, sourcePath))) {
      throw new Error(
        `legacy deletion manifest does not cover migrated source ${pathCommitment(sourcePath)}`
      );
    }
  }
}

function openHandles(entries: readonly LegacyDeletionEntry[]): readonly string[] {
  const commitments = new Set<string>();
  for (const processEntry of readdirSync("/proc", { withFileTypes: true })) {
    if (!processEntry.isDirectory() || !/^\d+$/u.test(processEntry.name)) continue;
    const pid = Number(processEntry.name);
    if (pid === process.pid) continue;
    const descriptors = `/proc/${pid}/fd`;
    let names: string[];
    try {
      names = readdirSync(descriptors);
    } catch {
      continue;
    }
    for (const name of names) {
      let target: string;
      try {
        target = readlinkSync(path.join(descriptors, name)).replace(/ \(deleted\)$/u, "");
      } catch {
        continue;
      }
      if (!path.isAbsolute(target)) continue;
      const matched = entries.find((entry) => isWithin(entry.path, target));
      if (matched) commitments.add(matched.id);
    }
  }
  return [...commitments].sort();
}

export async function prepareStateMigrationDeletion(input: {
  readonly projectRoot: string;
  readonly sourceManifestPath: string;
  readonly planPath: string;
  readonly deletionManifestPath: string;
  readonly approvalPath: string;
  readonly confirmation: string;
  readonly rootOptions?: ResolvePennyStateRootOptions;
}): Promise<DeletionApproval> {
  const plan = verifyStateMigrationSourcesUnchanged(input);
  if (input.confirmation !== `${plan.migration_id}:${DELETE_CONFIRMATION_SUFFIX}`) {
    throw new Error("legacy deletion confirmation phrase does not match the migration");
  }
  verifyPostCutoverTarget(input.projectRoot, plan, input.rootOptions);
  const deletion = parseDeletionManifest(input.deletionManifestPath);
  if (deletion.manifest.migration_id !== plan.migration_id) {
    throw new Error("legacy deletion manifest ID does not match the migration");
  }
  assertSourceCoverage(deletion.manifest.entries, input.sourceManifestPath);
  const stateRoot = resolvePennyStateRoot(input.rootOptions ?? {});
  for (const entry of deletion.manifest.entries) {
    assertDeletionPathAllowed(entry, input.projectRoot, stateRoot);
  }
  const handles = openHandles(deletion.manifest.entries);
  if (handles.length > 0) {
    throw new Error(`legacy deletion sources still have open handles: ${handles.join(", ")}`);
  }
  if (pathExistsNoFollow(input.approvalPath)) {
    throw new Error("legacy deletion approval path already exists");
  }
  assertSafeAncestorChain(input.approvalPath, "legacy deletion approval");
  const approval: DeletionApproval = {
    schema_version: APPROVAL_VERSION,
    action: "delete-managed-legacy",
    migration_id: plan.migration_id,
    project_id: plan.target_project_id,
    plan_sha256: plan.plan_sha256,
    source_manifest_sha256: plan.source_manifest_sha256,
    deletion_manifest_sha256: deletion.sha256,
    approval_nonce: randomBytes(32).toString("hex"),
    approved_at: new Date().toISOString(),
    status: "approved",
    entries: deletion.manifest.entries.map((entry) => ({
      id: entry.id,
      path_commitment: pathCommitment(entry.path),
      kind: entry.kind,
      snapshot_sha256: snapshotEntry(entry),
    })),
    completed_entry_ids: [],
  };
  atomicApproval(input.approvalPath, approval);
  return approval;
}

export async function deleteStateMigrationLegacy(input: {
  readonly projectRoot: string;
  readonly sourceManifestPath: string;
  readonly planPath: string;
  readonly deletionManifestPath: string;
  readonly approvalPath: string;
  readonly rootOptions?: ResolvePennyStateRootOptions;
}): Promise<DeletionApproval> {
  const plan = readStateMigrationPlan(input.planPath);
  const source = readMigrationSourceManifest(input.sourceManifestPath);
  const deletion = parseDeletionManifest(input.deletionManifestPath);
  let approval = readApproval(input.approvalPath);
  if (
    approval.migration_id !== plan.migration_id ||
    approval.project_id !== plan.target_project_id ||
    approval.plan_sha256 !== plan.plan_sha256 ||
    approval.source_manifest_sha256 !== source.sha256 ||
    approval.deletion_manifest_sha256 !== deletion.sha256
  ) {
    throw new Error("legacy deletion approval binding does not match current inputs");
  }
  const byId = new Map(deletion.manifest.entries.map((entry) => [entry.id, entry]));
  for (const approved of approval.entries) {
    const entry = byId.get(approved.id);
    if (
      !entry ||
      approved.path_commitment !== pathCommitment(entry.path) ||
      approved.kind !== entry.kind
    ) {
      throw new Error("legacy deletion approval entry binding is invalid");
    }
  }
  if (approval.status === "completed") return approval;
  const completed = new Set(approval.completed_entry_ids);
  if (approval.status === "approved") {
    verifyStateMigrationSourcesUnchanged(input);
    const handles = openHandles(deletion.manifest.entries);
    if (handles.length > 0) {
      throw new Error(`legacy deletion sources still have open handles: ${handles.join(", ")}`);
    }
    for (const approved of approval.entries) {
      const entry = byId.get(approved.id);
      if (entry === undefined) throw new Error("legacy deletion approval entry is missing");
      if (snapshotEntry(entry) !== approved.snapshot_sha256) {
        throw new Error(`legacy deletion entry '${entry.id}' changed after approval`);
      }
    }
    approval = { ...approval, status: "deleting" };
    atomicApproval(input.approvalPath, approval);
  }
  for (const approved of approval.entries) {
    if (completed.has(approved.id)) continue;
    const entry = byId.get(approved.id);
    if (entry === undefined) throw new Error("legacy deletion approval entry is missing");
    if (pathExistsNoFollow(entry.path)) {
      rmSync(entry.path, { recursive: entry.kind === "tree", force: false });
      fsyncDirectory(path.dirname(entry.path));
    }
    completed.add(entry.id);
    approval = { ...approval, completed_entry_ids: [...completed] };
    atomicApproval(input.approvalPath, approval);
  }
  approval = {
    ...approval,
    status: "completed",
    completed_entry_ids: approval.entries.map((entry) => entry.id),
    completed_at: new Date().toISOString(),
  };
  atomicApproval(input.approvalPath, approval);

  const state = pennyStatePaths(resolvePennyStateRoot(input.rootOptions ?? {}));
  const receipt = path.join(state.migrations, plan.migration_id, "deletion-receipt.json");
  atomicApproval(receipt, approval);
  return approval;
}
