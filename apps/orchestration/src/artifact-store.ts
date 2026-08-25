import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256 } from "./checkpointer.js";
import {
  ArtifactRefSchema,
  OutputArtifactMetadataSchema,
  type ArtifactRef,
  type CurrentArtifactRef,
  type OutputArtifactMetadata,
  validateContract,
} from "./contracts.js";
import { PENNY_STATE_LAYOUT_VERSION, PROJECT_ID_PATTERN } from "./state/paths.js";

export interface PersistArtifactInput {
  readonly metadata: OutputArtifactMetadata;
  readonly content: string | Uint8Array;
}

export interface ArtifactRevisionLookup {
  lastVersion(
    runId: string,
    phase: string,
    branchId: string | null,
    kind: string,
    operationId: string
  ): number;
  refFor(
    runId: string,
    phase: string,
    branchId: string | null,
    kind: string,
    operationId: string,
    version: number
  ): ArtifactRef | null;
}

type CurrentOutputArtifactMetadata = Extract<OutputArtifactMetadata, { schema_version: 2 }>;

interface ArtifactRow {
  readonly artifact_id: string;
  readonly ref_json: string;
  readonly metadata_json: string;
}

interface ArtifactRefProjection {
  readonly artifact_id: string;
  readonly run_id: string;
  readonly phase: string;
  readonly branch_key: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly version: number;
  readonly producer: string;
  readonly content_digest: string;
  readonly byte_length: number;
  readonly store_ref: string;
  readonly ref_json: string;
}

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
}

const ARTIFACT_ID_PATTERN = /^art_[a-f0-9]{64}$/;
export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const;
const CURRENT_MANIFEST_NAME = "manifest.db";

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSqliteModule(value: object | undefined): value is SqliteModule {
  return value !== undefined && "DatabaseSync" in value && typeof value.DatabaseSync === "function";
}

function sqliteModule(): SqliteModule {
  const module = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) {
    throw new Error("Node.js runtime does not provide node:sqlite");
  }
  return module;
}

function sqliteRow(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new Error(`${label} is missing or is not a SQLite row`);
  return value;
}

function sqliteText(row: Record<string, unknown>, field: string, label: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new Error(`${label}.${field} is not text`);
  return value;
}

function sqliteInteger(row: Record<string, unknown>, field: string, label: string): number {
  const value = row[field];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`${label}.${field} is not an integer`);
  }
  const integer = Number(value);
  if (!Number.isSafeInteger(integer)) throw new Error(`${label}.${field} is not a safe integer`);
  return integer;
}

function artifactRefProjection(value: unknown, label: string): ArtifactRefProjection {
  const row = sqliteRow(value, label);
  return {
    artifact_id: sqliteText(row, "artifact_id", label),
    run_id: sqliteText(row, "run_id", label),
    phase: sqliteText(row, "phase", label),
    branch_key: sqliteText(row, "branch_key", label),
    kind: sqliteText(row, "kind", label),
    operation_id: sqliteText(row, "operation_id", label),
    version: sqliteInteger(row, "version", label),
    producer: sqliteText(row, "producer", label),
    content_digest: sqliteText(row, "content_digest", label),
    byte_length: sqliteInteger(row, "byte_length", label),
    store_ref: sqliteText(row, "store_ref", label),
    ref_json: sqliteText(row, "ref_json", label),
  };
}

function artifactRow(value: unknown, label: string): ArtifactRow | undefined {
  if (value === undefined) return undefined;
  const row = sqliteRow(value, label);
  return {
    artifact_id: sqliteText(row, "artifact_id", label),
    ref_json: sqliteText(row, "ref_json", label),
    metadata_json: sqliteText(row, "metadata_json", label),
  };
}

function optionalSqliteText(value: unknown, field: string, label: string): string | undefined {
  if (value === undefined) return undefined;
  return sqliteText(sqliteRow(value, label), field, label);
}

function artifactIdFor(metadata: {
  run_id: string;
  phase: string;
  branch_id: string | null;
  kind: string;
  operation_id: string;
  version: number;
}): string {
  const identity = {
    branch_id: metadata.branch_id,
    kind: metadata.kind,
    operation_id: metadata.operation_id,
    phase: metadata.phase,
    run_id: metadata.run_id,
    version: metadata.version,
  };
  return `art_${sha256(canonicalJson(identity))}`;
}

function branchKey(branchId: string | null): string {
  return branchId ?? "";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function assertOwnerOnly(candidate: string, type: "file" | "directory"): void {
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink()) {
    throw new Error(`artifact ${type} must not be a symbolic link`);
  }
  if ((type === "file" && !stats.isFile()) || (type === "directory" && !stats.isDirectory())) {
    throw new Error(`artifact path '${candidate}' has the wrong type`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`artifact path '${candidate}' must be owner-only`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`artifact path '${candidate}' has the wrong owner`);
  }
}

/** Validate one canonical schema-v2 artifact communication address. */
export function currentArtifactRef(value: unknown, label = "artifact ref"): CurrentArtifactRef {
  const ref = validateContract(ArtifactRefSchema, value, label);
  const normalized: CurrentArtifactRef = {
    schema_version: 2,
    artifact_id: ref.artifact_id,
    run_id: ref.run_id,
    phase: ref.phase,
    branch_id: ref.branch_id,
    kind: ref.kind,
    operation_id: ref.operation_id,
    version: ref.version,
    producer: ref.producer,
    media_type: ref.media_type,
    byte_length: ref.byte_length,
    content_digest: ref.content_digest,
    store_ref: ref.store_ref,
  };
  if (normalized.artifact_id !== artifactIdFor(normalized)) {
    throw new Error(`${label}.artifact_id does not match its canonical identity`);
  }
  if (normalized.store_ref !== `artifact://sha256/${normalized.content_digest}`) {
    throw new Error(`${label}.store_ref does not match content_digest`);
  }
  return normalized;
}

/** Validate canonical schema-v2 output metadata. */
export function currentOutputArtifactMetadata(value: unknown): CurrentOutputArtifactMetadata {
  const metadata = validateContract(
    OutputArtifactMetadataSchema,
    value,
    "output artifact metadata"
  );
  const parentRef = metadata.parent_ref === null ? null : currentArtifactRef(metadata.parent_ref);
  const upstreamRefs = metadata.upstream_refs.map((ref) => currentArtifactRef(ref));
  const normalized: CurrentOutputArtifactMetadata = {
    schema_version: 2,
    run_id: metadata.run_id,
    phase: metadata.phase,
    branch_id: metadata.branch_id,
    kind: metadata.kind,
    operation_id: metadata.operation_id,
    version: metadata.version,
    producer: metadata.producer,
    media_type: metadata.media_type,
    parent_ref: parentRef,
    upstream_refs: upstreamRefs,
  };
  if ((normalized.version === 1) !== (normalized.parent_ref === null)) {
    throw new Error("output artifact parent_ref does not match its version");
  }
  if (normalized.parent_ref !== null) {
    const parent = normalized.parent_ref;
    if (
      parent.run_id !== normalized.run_id ||
      parent.phase !== normalized.phase ||
      parent.branch_id !== normalized.branch_id ||
      parent.kind !== normalized.kind ||
      parent.operation_id !== normalized.operation_id ||
      parent.version !== normalized.version - 1
    ) {
      throw new Error("output artifact parent_ref is not the preceding revision");
    }
  }
  const ids = upstreamRefs.map((ref) => ref.artifact_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("output artifact upstream_refs contains duplicates");
  }
  return normalized;
}

export class ArtifactStore implements Disposable {
  readonly root: string;
  private readonly db: DatabaseSync;

  constructor(root: string, options: { projectId?: string } = {}) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    const objects = path.join(this.root, "objects");
    const shaRoot = path.join(objects, "sha256");
    for (const directory of [objects, shaRoot]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    const { DatabaseSync } = sqliteModule();
    this.db = new DatabaseSync(path.join(this.root, CURRENT_MANIFEST_NAME));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const versionRow = sqliteRow(
      this.db.prepare("PRAGMA user_version").get(),
      "artifact manifest user_version"
    );
    const version = sqliteInteger(versionRow, "user_version", "artifact manifest user_version");
    if (version > ARTIFACT_MANIFEST_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`artifact manifest schema ${version} is newer than supported`);
    }
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        branch_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        producer TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        store_ref TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        ref_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, phase, branch_key, kind, operation_id, version)
      );
      CREATE TABLE IF NOT EXISTS store_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        project_id TEXT NOT NULL,
        state_layout_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS artifact_selections (
        run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        branch_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
        version INTEGER NOT NULL,
        selected_at TEXT NOT NULL,
        PRIMARY KEY(run_id, phase, branch_key, kind)
      );
      CREATE TRIGGER IF NOT EXISTS artifacts_no_update
      BEFORE UPDATE ON artifacts BEGIN
        SELECT RAISE(ABORT, 'artifact rows are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS artifacts_no_delete
      BEFORE DELETE ON artifacts BEGIN
        SELECT RAISE(ABORT, 'artifact rows are immutable');
      END;
      PRAGMA user_version=${ARTIFACT_MANIFEST_SCHEMA_VERSION};
      `);
      if (options.projectId !== undefined) this.bindProject(options.projectId);
      this.chmodManifestFiles();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  persist(input: PersistArtifactInput): CurrentArtifactRef {
    const metadata = currentOutputArtifactMetadata(input.metadata);
    const bytes =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : Buffer.from(input.content);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const ref = currentArtifactRef(
      {
        schema_version: 2,
        artifact_id: artifactIdFor(metadata),
        run_id: metadata.run_id,
        phase: metadata.phase,
        branch_id: metadata.branch_id,
        kind: metadata.kind,
        operation_id: metadata.operation_id,
        version: metadata.version,
        producer: metadata.producer,
        media_type: metadata.media_type,
        byte_length: bytes.length,
        content_digest: digest,
        store_ref: `artifact://sha256/${digest}`,
      },
      "persisted artifact ref"
    );
    this.writeObject(digest, bytes);
    this.insertVerified(ref, metadata, new Date().toISOString());
    return ref;
  }

  /** Indexed direct lookup. No caller, run, consumer, grant, or expiry state participates. */
  refById(artifactId: string): CurrentArtifactRef | undefined {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      throw new Error("artifact id is invalid");
    }
    const stored = this.db
      .prepare(
        `SELECT artifact_id,run_id,phase,branch_key,kind,operation_id,version,
                producer,content_digest,byte_length,store_ref,ref_json
         FROM artifacts WHERE artifact_id = ?`
      )
      .get(artifactId);
    if (stored === undefined) return undefined;
    const row = artifactRefProjection(stored, `artifact '${artifactId}' manifest row`);
    let value: unknown;
    try {
      value = JSON.parse(row.ref_json);
    } catch {
      throw new Error(`artifact '${artifactId}' has invalid manifest metadata`);
    }
    const ref = currentArtifactRef(value, `stored ref ${artifactId}`);
    const comparisons: Array<[string, unknown, unknown]> = [
      ["artifact_id", artifactId, ref.artifact_id],
      ["run_id", row.run_id, ref.run_id],
      ["phase", row.phase, ref.phase],
      ["branch_key", row.branch_key, branchKey(ref.branch_id)],
      ["kind", row.kind, ref.kind],
      ["operation_id", row.operation_id, ref.operation_id],
      ["version", row.version, ref.version],
      ["producer", row.producer, ref.producer],
      ["content_digest", row.content_digest, ref.content_digest],
      ["byte_length", row.byte_length, ref.byte_length],
      ["store_ref", row.store_ref, ref.store_ref],
    ];
    for (const [field, expected, actual] of comparisons) {
      if (expected !== actual) {
        throw new Error(`artifact '${artifactId}' manifest ${field} mismatch`);
      }
    }
    return ref;
  }

  /** Direct exact-byte read with digest and byte-length verification. */
  readById(artifactId: string): Buffer {
    const ref = this.refById(artifactId);
    if (ref === undefined) {
      throw new Error(`artifact '${artifactId}' is absent from the manifest`);
    }
    return this.readObject(ref);
  }

  /** Highest persisted version for the logical output slot (0 if none). */
  lastVersion(
    runId: string,
    phase: string,
    branchId: string | null,
    kind: string,
    operationId: string
  ): number {
    const row = sqliteRow(
      this.db
        .prepare(
          `SELECT MAX(version) AS v FROM artifacts
           WHERE run_id = ? AND phase = ? AND branch_key = ? AND kind = ? AND operation_id = ?`
        )
        .get(runId, phase, branchKey(branchId), kind, operationId),
      "artifact last-version projection"
    );
    return row.v === null ? 0 : sqliteInteger(row, "v", "artifact last-version projection");
  }

  /** Exact manifest ref for one persisted revision (null if absent). */
  refFor(
    runId: string,
    phase: string,
    branchId: string | null,
    kind: string,
    operationId: string,
    version: number
  ): CurrentArtifactRef | null {
    const artifactId = optionalSqliteText(
      this.db
        .prepare(
          `SELECT artifact_id FROM artifacts
           WHERE run_id = ? AND phase = ? AND branch_key = ? AND kind = ? AND operation_id = ? AND version = ?`
        )
        .get(runId, phase, branchKey(branchId), kind, operationId, version),
      "artifact_id",
      "artifact revision projection"
    );
    return artifactId === undefined ? null : (this.refById(artifactId) ?? null);
  }

  select(refValue: ArtifactRef): void {
    const ref = currentArtifactRef(refValue, "selected artifact ref");
    const stored = this.refById(ref.artifact_id);
    if (stored === undefined || canonicalJson(stored) !== canonicalJson(ref)) {
      throw new Error(`artifact '${ref.artifact_id}' is absent from the manifest`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const selected = this.db
        .prepare(
          `SELECT artifact_id, version FROM artifact_selections
           WHERE run_id=? AND phase=? AND branch_key=? AND kind=?`
        )
        .get(ref.run_id, ref.phase, branchKey(ref.branch_id), ref.kind);
      if (selected !== undefined && String(selected.artifact_id) === ref.artifact_id) {
        this.db.exec("COMMIT");
        return;
      }
      if (ref.version === 1) {
        if (selected !== undefined) {
          throw new Error("artifact selection already has a first revision");
        }
        this.db
          .prepare(
            `INSERT INTO artifact_selections(
              run_id, phase, branch_key, kind, artifact_id, version, selected_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            ref.run_id,
            ref.phase,
            branchKey(ref.branch_id),
            ref.kind,
            ref.artifact_id,
            ref.version,
            new Date().toISOString()
          );
      } else {
        const parent = this.metadata(ref).parent_ref;
        if (parent === null) {
          throw new Error("stale artifact compare-and-swap selection");
        }
        if (selected === undefined) {
          const ledgerTop = this.lastVersion(
            ref.run_id,
            ref.phase,
            ref.branch_id,
            ref.kind,
            parent.operation_id
          );
          const ledgerRef = this.refFor(
            ref.run_id,
            ref.phase,
            ref.branch_id,
            ref.kind,
            parent.operation_id,
            parent.version
          );
          if (
            ledgerTop !== ref.version ||
            ledgerRef === null ||
            ledgerRef.artifact_id !== parent.artifact_id ||
            parent.version !== ref.version - 1
          ) {
            throw new Error("stale artifact compare-and-swap selection");
          }
          this.db
            .prepare(
              `INSERT INTO artifact_selections(
                run_id, phase, branch_key, kind, artifact_id, version, selected_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              ref.run_id,
              ref.phase,
              branchKey(ref.branch_id),
              ref.kind,
              ref.artifact_id,
              ref.version,
              new Date().toISOString()
            );
        } else {
          if (String(selected.artifact_id) !== parent.artifact_id) {
            throw new Error("stale artifact compare-and-swap selection");
          }
          const updated = this.db
            .prepare(
              `UPDATE artifact_selections
               SET artifact_id=?, version=?, selected_at=?
               WHERE run_id=? AND phase=? AND branch_key=? AND kind=? AND artifact_id=?`
            )
            .run(
              ref.artifact_id,
              ref.version,
              new Date().toISOString(),
              ref.run_id,
              ref.phase,
              branchKey(ref.branch_id),
              ref.kind,
              parent.artifact_id
            );
          if (Number(updated.changes) !== 1) {
            throw new Error("stale artifact compare-and-swap selection");
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  selected(
    runId: string,
    phase: string,
    branchId: string | null,
    kind = "agent-output"
  ): CurrentArtifactRef | undefined {
    const artifactId = optionalSqliteText(
      this.db
        .prepare(
          `SELECT a.artifact_id FROM artifact_selections s
           JOIN artifacts a ON a.artifact_id=s.artifact_id
           WHERE s.run_id=? AND s.phase=? AND s.branch_key=? AND s.kind=?`
        )
        .get(runId, phase, branchKey(branchId), kind),
      "artifact_id",
      "artifact selection projection"
    );
    return artifactId === undefined ? undefined : this.refById(artifactId);
  }

  /** Compatibility wrapper. The former consumer argument is intentionally ignored. */
  read(refValue: ArtifactRef, _consumer?: string): Buffer {
    const supplied = currentArtifactRef(refValue);
    const stored = this.refById(supplied.artifact_id);
    if (stored === undefined || canonicalJson(stored) !== canonicalJson(supplied)) {
      throw new Error(`artifact '${supplied.artifact_id}' is absent from the manifest`);
    }
    return this.readObject(stored);
  }

  metadata(ref: ArtifactRef): CurrentOutputArtifactMetadata {
    const normalized = currentArtifactRef(ref);
    const metadataJson = optionalSqliteText(
      this.db
        .prepare("SELECT metadata_json FROM artifacts WHERE artifact_id = ?")
        .get(normalized.artifact_id),
      "metadata_json",
      "artifact metadata projection"
    );
    if (metadataJson === undefined) {
      throw new Error(`artifact '${normalized.artifact_id}' is absent from the manifest`);
    }
    const value: unknown = JSON.parse(metadataJson);
    return currentOutputArtifactMetadata(value);
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private bindProject(projectId: string): void {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("project ID is not canonical");
    const stored = this.db
      .prepare("SELECT project_id, state_layout_version FROM store_metadata WHERE singleton = 1")
      .get();
    if (stored === undefined) {
      this.db
        .prepare(
          "INSERT INTO store_metadata(singleton, project_id, state_layout_version, created_at) " +
            "VALUES(1, ?, ?, ?)"
        )
        .run(projectId, PENNY_STATE_LAYOUT_VERSION, new Date().toISOString());
      return;
    }
    const row = sqliteRow(stored, "artifact project binding");
    if (sqliteText(row, "project_id", "artifact project binding") !== projectId) {
      throw new Error("artifact manifest belongs to another Penny project");
    }
    if (
      sqliteInteger(row, "state_layout_version", "artifact project binding") !==
      PENNY_STATE_LAYOUT_VERSION
    ) {
      throw new Error("artifact manifest has an unsupported state layout version");
    }
  }

  private chmodManifestFiles(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      const databaseFile = path.join(this.root, `${CURRENT_MANIFEST_NAME}${suffix}`);
      if (existsSync(databaseFile)) chmodSync(databaseFile, 0o600);
    }
  }

  private insertVerified(
    ref: CurrentArtifactRef,
    metadata: CurrentOutputArtifactMetadata,
    createdAt: string
  ): void {
    const refJson = canonicalJson(ref);
    const metadataJson = canonicalJson(metadata);
    const existing = artifactRow(
      this.db
        .prepare("SELECT artifact_id, ref_json, metadata_json FROM artifacts WHERE artifact_id = ?")
        .get(ref.artifact_id),
      "existing artifact projection"
    );
    if (existing !== undefined) {
      const existingRefValue: unknown = JSON.parse(existing.ref_json);
      const existingMetadataValue: unknown = JSON.parse(existing.metadata_json);
      const existingRef = currentArtifactRef(existingRefValue);
      const existingMetadata = currentOutputArtifactMetadata(existingMetadataValue);
      if (
        canonicalJson(existingRef) !== refJson ||
        canonicalJson(existingMetadata) !== metadataJson
      ) {
        throw new Error(
          `artifact operation '${metadata.operation_id}' version ${metadata.version} diverged`
        );
      }
      this.readObject(existingRef);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO artifacts(
          artifact_id, run_id, phase, branch_key, kind, operation_id, version,
          producer, content_digest, byte_length, store_ref, metadata_json,
          ref_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ref.artifact_id,
        ref.run_id,
        ref.phase,
        branchKey(ref.branch_id),
        ref.kind,
        ref.operation_id,
        ref.version,
        ref.producer,
        ref.content_digest,
        ref.byte_length,
        ref.store_ref,
        metadataJson,
        refJson,
        createdAt
      );
  }

  private readObject(ref: CurrentArtifactRef): Buffer {
    if (ref.store_ref !== `artifact://sha256/${ref.content_digest}`) {
      throw new Error("artifact store_ref does not match its digest");
    }
    const objectsRoot = path.join(this.root, "objects");
    const shaRoot = path.join(objectsRoot, "sha256");
    const shardRoot = path.join(shaRoot, ref.content_digest.slice(0, 2));
    const objectPath = path.join(shardRoot, ref.content_digest.slice(2));
    for (const directory of [this.root, objectsRoot, shaRoot, shardRoot]) {
      assertOwnerOnly(directory, "directory");
    }
    assertOwnerOnly(objectPath, "file");
    const rootReal = realpathSync(this.root);
    const objectReal = realpathSync(objectPath);
    if (!isWithinRoot(rootReal, objectReal)) {
      throw new Error(`artifact '${ref.artifact_id}' object escapes its root`);
    }
    const bytes = readFileSync(objectReal);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== ref.content_digest || bytes.length !== ref.byte_length) {
      throw new Error(`artifact '${ref.artifact_id}' failed exact-byte verification`);
    }
    return bytes;
  }

  private writeObject(digest: string, bytes: Buffer): void {
    const objectsRoot = path.join(this.root, "objects");
    const shaRoot = path.join(objectsRoot, "sha256");
    const shard = path.join(shaRoot, digest.slice(0, 2));
    mkdirSync(shard, { recursive: true, mode: 0o700 });
    chmodSync(shard, 0o700);
    for (const directory of [this.root, objectsRoot, shaRoot, shard]) {
      assertOwnerOnly(directory, "directory");
    }
    const destination = path.join(shard, digest.slice(2));
    if (existsSync(destination)) {
      assertOwnerOnly(destination, "file");
      const existing = readFileSync(destination);
      if (!existing.equals(bytes)) {
        throw new Error(`artifact digest collision for '${digest}'`);
      }
      return;
    }
    const temporary = path.join(shard, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      renameSync(temporary, destination);
      chmodSync(destination, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
