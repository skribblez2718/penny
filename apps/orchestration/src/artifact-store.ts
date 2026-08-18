import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { canonicalJson, sha256 } from "./checkpointer.js";
import {
  ArtifactRefSchema,
  OutputArtifactMetadataSchema,
  type ArtifactRef,
  type OutputArtifactMetadata,
  validateContract,
} from "./contracts.js";

export interface PersistArtifactInput {
  readonly metadata: OutputArtifactMetadata;
  readonly content: string | Uint8Array;
}

/**
 * Ledger view over the immutable artifact manifest. The manifest records every
 * persisted output for an operation, including attempts whose worker was
 * interrupted before the engine accepted the result. Revision chains must be
 * resolved against this ledger (not only accepted selections) so an orphaned
 * output can never collide with, or be overwritten by, a later attempt on the
 * same logical output slot.
 */
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

interface ArtifactRow extends Record<string, SQLOutputValue> {
  artifact_id: string;
  ref_json: string;
  metadata_json: string;
}

function sqliteModule(): typeof import("node:sqlite") {
  const module = process.getBuiltinModule("node:" + "sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (module === undefined) {
    throw new Error("Node.js runtime does not provide node:sqlite");
  }
  return module;
}

function artifactIdFor(metadata: OutputArtifactMetadata): string {
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

function validateMetadata(value: OutputArtifactMetadata): OutputArtifactMetadata {
  const metadata = validateContract(
    OutputArtifactMetadataSchema,
    value,
    "output artifact metadata"
  );
  if ((metadata.version === 1) !== (metadata.parent_ref === null)) {
    throw new Error("output artifact parent_ref does not match its version");
  }
  if (metadata.parent_ref !== null) {
    const parent = metadata.parent_ref;
    if (
      parent.run_id !== metadata.run_id ||
      parent.phase !== metadata.phase ||
      parent.branch_id !== metadata.branch_id ||
      parent.kind !== metadata.kind ||
      parent.operation_id !== metadata.operation_id ||
      parent.version !== metadata.version - 1
    ) {
      throw new Error("output artifact parent_ref is not the preceding revision");
    }
  }
  const consumer = `state:${metadata.phase}`;
  for (const upstream of metadata.upstream_refs) {
    if (upstream.run_id !== metadata.run_id) {
      throw new Error("output artifact upstream belongs to a different run");
    }
    if (!upstream.consumer_scope.includes(consumer)) {
      throw new Error(`upstream artifact '${upstream.artifact_id}' does not grant '${consumer}'`);
    }
  }
  return metadata;
}

export class ArtifactStore implements Disposable {
  readonly root: string;
  private readonly db: DatabaseSync;

  constructor(root: string) {
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
    this.db = new DatabaseSync(path.join(this.root, "manifest-v2.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
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
    `);
    for (const suffix of ["", "-wal", "-shm"]) {
      const databaseFile = path.join(this.root, `manifest-v2.db${suffix}`);
      if (existsSync(databaseFile)) {
        chmodSync(databaseFile, 0o600);
      }
    }
  }

  persist(input: PersistArtifactInput): ArtifactRef {
    const metadata = validateMetadata(input.metadata);
    const bytes =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : Buffer.from(input.content);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const ref = validateContract(
      ArtifactRefSchema,
      {
        schema_version: 1,
        artifact_id: artifactIdFor(metadata),
        run_id: metadata.run_id,
        phase: metadata.phase,
        branch_id: metadata.branch_id,
        kind: metadata.kind,
        operation_id: metadata.operation_id,
        version: metadata.version,
        producer: metadata.producer,
        consumer_scope: metadata.consumer_scope,
        media_type: metadata.media_type,
        byte_length: bytes.length,
        content_digest: digest,
        store_ref: `artifact://sha256/${digest}`,
      },
      "persisted artifact ref"
    );
    this.writeObject(digest, bytes);
    const refJson = canonicalJson(ref);
    const metadataJson = canonicalJson(metadata);
    const existing = this.db
      .prepare("SELECT artifact_id, ref_json, metadata_json FROM artifacts WHERE artifact_id = ?")
      .get(ref.artifact_id) as ArtifactRow | undefined;
    if (existing !== undefined) {
      if (existing.ref_json !== refJson || existing.metadata_json !== metadataJson) {
        throw new Error(
          `artifact operation '${metadata.operation_id}' version ${metadata.version} diverged`
        );
      }
      return ref;
    }
    try {
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
          new Date().toISOString()
        );
    } catch (error) {
      throw new Error(`artifact manifest insert failed: ${String(error)}`);
    }
    return ref;
  }

  /** Highest persisted version for the logical output slot (0 if none). */
  lastVersion(
    runId: string,
    phase: string,
    branchId: string | null,
    kind: string,
    operationId: string
  ): number {
    const row = this.db
      .prepare(
        `SELECT MAX(version) AS v FROM artifacts
         WHERE run_id = ? AND phase = ? AND branch_key = ? AND kind = ? AND operation_id = ?`
      )
      .get(runId, phase, branchKey(branchId), kind, operationId) as { v: number | null };
    return Number(row.v ?? 0);
  }

  /** Exact manifest ref for one persisted revision (null if absent). */
  refFor(
    runId: string,
    phase: string,
    branchId: string | null,
    kind: string,
    operationId: string,
    version: number
  ): ArtifactRef | null {
    const row = this.db
      .prepare(
        `SELECT ref_json FROM artifacts
         WHERE run_id = ? AND phase = ? AND branch_key = ? AND kind = ? AND operation_id = ? AND version = ?`
      )
      .get(runId, phase, branchKey(branchId), kind, operationId, version) as
      | {
          ref_json: string;
        }
      | undefined;
    if (row === undefined) {
      return null;
    }
    const ref = validateContract(
      ArtifactRefSchema,
      JSON.parse(row.ref_json),
      `stored ref ${runId}/${phase}/${branchId ?? ""}/v${version}`
    );
    return ref;
  }

  select(refValue: ArtifactRef): void {
    const ref = validateContract(ArtifactRefSchema, refValue, "selected artifact ref");
    const row = this.db
      .prepare("SELECT ref_json FROM artifacts WHERE artifact_id = ?")
      .get(ref.artifact_id) as Record<string, SQLOutputValue> | undefined;
    if (row === undefined || String(row.ref_json) !== canonicalJson(ref)) {
      throw new Error(`artifact '${ref.artifact_id}' is absent from the manifest`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const selected = this.db
        .prepare(
          `SELECT artifact_id, version FROM artifact_selections
           WHERE run_id=? AND phase=? AND branch_key=? AND kind=?`
        )
        .get(ref.run_id, ref.phase, branchKey(ref.branch_id), ref.kind) as
        | Record<string, SQLOutputValue>
        | undefined;
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
          // Recovery for a slot interrupted before its first accept: the
          // immutable ledger may already hold an orphaned revision for this
          // operation. Seed the selection from this revision only when it is
          // the ledger's exact top revision with a contiguous parent; anything
          // else is a stale attempt and fails closed.
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
  ): ArtifactRef | undefined {
    const row = this.db
      .prepare(
        `SELECT a.ref_json FROM artifact_selections s
         JOIN artifacts a ON a.artifact_id=s.artifact_id
         WHERE s.run_id=? AND s.phase=? AND s.branch_key=? AND s.kind=?`
      )
      .get(runId, phase, branchKey(branchId), kind) as Record<string, SQLOutputValue> | undefined;
    return row === undefined ? undefined : (JSON.parse(String(row.ref_json)) as ArtifactRef);
  }

  read(refValue: ArtifactRef, consumer: string): Buffer {
    const ref = validateContract(ArtifactRefSchema, refValue, "artifact ref");
    if (!ref.consumer_scope.includes(consumer)) {
      throw new Error(`artifact '${ref.artifact_id}' does not grant consumer '${consumer}'`);
    }
    const row = this.db
      .prepare("SELECT ref_json FROM artifacts WHERE artifact_id = ?")
      .get(ref.artifact_id) as Record<string, SQLOutputValue> | undefined;
    if (row === undefined || String(row.ref_json) !== canonicalJson(ref)) {
      throw new Error(`artifact '${ref.artifact_id}' is absent from the manifest`);
    }
    if (ref.store_ref !== `artifact://sha256/${ref.content_digest}`) {
      throw new Error("artifact store_ref does not match its digest");
    }
    const objectPath = path.join(
      this.root,
      "objects",
      "sha256",
      ref.content_digest.slice(0, 2),
      ref.content_digest.slice(2)
    );
    assertOwnerOnly(this.root, "directory");
    assertOwnerOnly(objectPath, "file");
    const bytes = readFileSync(objectPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== ref.content_digest || bytes.length !== ref.byte_length) {
      throw new Error(`artifact '${ref.artifact_id}' failed exact-byte verification`);
    }
    return bytes;
  }

  metadata(ref: ArtifactRef): OutputArtifactMetadata {
    const row = this.db
      .prepare("SELECT metadata_json FROM artifacts WHERE artifact_id = ?")
      .get(ref.artifact_id) as Record<string, SQLOutputValue> | undefined;
    if (row === undefined) {
      throw new Error(`artifact '${ref.artifact_id}' is absent from the manifest`);
    }
    return validateMetadata(JSON.parse(String(row.metadata_json)) as OutputArtifactMetadata);
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private writeObject(digest: string, bytes: Buffer): void {
    const shard = path.join(this.root, "objects", "sha256", digest.slice(0, 2));
    mkdirSync(shard, { recursive: true, mode: 0o700 });
    chmodSync(shard, 0o700);
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
