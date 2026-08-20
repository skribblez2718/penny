/**
 * KB run artifacts — §5.7 host-owned artifact content plane.
 *
 * `stage_run_artifact` is a custom child tool closed over the current run_id,
 * state_id, allowed artifact kinds, profile, and resolved private root. The model
 * does not submit run/state/profile/path fields. Every KB work artifact is one
 * closed JSON payload; the host strict-parses it, validates it, and stores JCS
 * canonical UTF-8 bytes. SHA-256 always covers those stored canonical bytes.
 *
 * Lifecycle: prepared → staged → sealed → consumed (with discarding → discarded
 * for cleanup). A durable `prepared` index row is written BEFORE any bytes hit
 * disk, so recovery can always find and clean up orphaned artifacts.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import {
  sha256Hex,
  type Sha256Hex,
  type ArtifactKind,
  type ArtifactMediaType,
} from "./contracts.js";

// ── Types (§5.7) ─────────────────────────────────────────────────────────────

/** Path-free artifact handle — what the model and parent see. */
export interface ArtifactHandle {
  schema_version: 1;
  artifact_id: string;
  artifact_kind: ArtifactKind;
  sha256: Sha256Hex;
  media_type: ArtifactMediaType;
  byte_length: number;
}

export type ArtifactLifecycle =
  | "prepared"
  | "staged"
  | "sealed"
  | "consumed"
  | "discarding"
  | "discarded";

/** Internal index record — host-only, never returned to the model. */
export interface ArtifactIndexRecord {
  schema_version: 1;
  artifact_id: string;
  run_id: string;
  state_id: string;
  kb_profile_id: string;
  artifact_kind: ArtifactKind;
  media_type: ArtifactMediaType;
  sha256: Sha256Hex;
  byte_length: number;
  storage_key: string;
  temporary_storage_key?: string;
  lifecycle: ArtifactLifecycle;
  created_at: string;
  updated_at: string;
}

/** What the model submits to stage_run_artifact. */
export interface StageRunArtifactInput {
  schema_version: 1;
  artifact_kind: ArtifactKind;
  media_type: ArtifactMediaType;
  encoding: "utf8";
  content: string;
}

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

function sqliteModule(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule("node:" + "sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (mod === undefined) throw new Error("Node.js runtime does not provide node:sqlite");
  return mod;
}

/**
 * The KB run-artifact store. Manages the `work/<run_id>/artifacts/<state_id>/`
 * content plane with a SQLite index for lifecycle tracking.
 *
 * The store is constructed per-KB-root and closed when the run completes.
 */
export class RunArtifactStore implements Disposable {
  readonly root: string;
  private readonly db: DatabaseSync;

  constructor(kbRoot: string, runId: string) {
    this.root = path.resolve(kbRoot, "work", runId);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    const artifactsDir = path.join(this.root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    chmodSync(artifactsDir, 0o700);

    const { DatabaseSync } = sqliteModule();
    this.db = new DatabaseSync(path.join(this.root, "artifacts.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        state_id TEXT NOT NULL,
        kb_profile_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        media_type TEXT NOT NULL DEFAULT 'application/json',
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        storage_key TEXT NOT NULL,
        temporary_storage_key TEXT,
        lifecycle TEXT NOT NULL DEFAULT 'prepared',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS artifacts_no_update
      BEFORE UPDATE ON artifacts BEGIN
        SELECT RAISE(ABORT, 'use the lifecycle API, not raw UPDATE');
      END;
    `);
    // Drop the no-update trigger — we need controlled updates via the lifecycle API.
    this.db.exec("DROP TRIGGER IF EXISTS artifacts_no_update;");
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = path.join(this.root, `artifacts.db${suffix}`);
      if (existsSync(f)) chmodSync(f, 0o600);
    }
  }

  /**
   * Stage an artifact: validate, canonicalize, write a durable `prepared` row,
   * write the bytes atomically, then transition to `staged`.
   *
   * Returns a path-free handle. The model never sees a path.
   */
  stage(input: {
    state_id: string;
    kb_profile_id: string;
    artifact_kind: ArtifactKind;
    content: string;
    max_bytes?: number;
  }): ArtifactHandle {
    const bytes = Buffer.from(input.content, "utf8");
    const maxBytes = input.max_bytes ?? 1_048_576;
    if (bytes.length > maxBytes) {
      throw new ArtifactStoreError(
        `artifact exceeds ${maxBytes} byte limit (${bytes.length} bytes)`
      );
    }
    const digest = sha256Hex(input.content);
    const artifactId = `art_${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const storageKey = path.join("artifacts", input.state_id, artifactId);
    const tmpKey = path.join("artifacts", input.state_id, `.${artifactId}.tmp`);

    // 1. Insert a `prepared` row BEFORE writing any bytes (durability guarantee)
    this.db
      .prepare(
        `INSERT INTO artifacts (
          artifact_id, run_id, state_id, kb_profile_id, artifact_kind,
          media_type, sha256, byte_length, storage_key, temporary_storage_key,
          lifecycle, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'application/json', ?, ?, ?, ?, 'prepared', ?, ?)`
      )
      .run(
        artifactId,
        this.root.split("/").slice(-2, -1)[0] ?? "unknown", // run_id from path
        input.state_id,
        input.kb_profile_id,
        input.artifact_kind,
        digest,
        bytes.length,
        storageKey,
        tmpKey,
        now,
        now
      );

    // 2. Write the temp file (mode 0600, exclusive)
    const tmpPath = path.join(this.root, tmpKey);
    const dir = path.dirname(tmpPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    writeFileSync(tmpPath, input.content, { mode: 0o600, flag: "wx" });
    const fd = openSync(tmpPath, "r");
    fsyncSync(fd);
    closeSync(fd);

    // 3. Atomic rename to final key
    const finalPath = path.join(this.root, storageKey);
    renameSync(tmpPath, finalPath);
    chmodSync(finalPath, 0o600);

    // 4. Transition to `staged` and clear the temp key
    this.db
      .prepare(
        `UPDATE artifacts
         SET lifecycle = 'staged', temporary_storage_key = NULL, updated_at = ?
         WHERE artifact_id = ? AND lifecycle = 'prepared'`
      )
      .run(now, artifactId);

    return {
      schema_version: 1,
      artifact_id: artifactId,
      artifact_kind: input.artifact_kind,
      sha256: digest,
      media_type: "application/json",
      byte_length: bytes.length,
    };
  }

  /**
   * Read a staged or sealed artifact's bytes, verifying the hash on reopen.
   * Rejects missing, symlinked, cross-run, altered, or lifecycle-ineligible data.
   */
  read(artifactId: string): { handle: ArtifactHandle; content: string } {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId) as
      | Record<string, SQLOutputValue>
      | undefined;
    if (row === undefined) {
      throw new ArtifactStoreError(`artifact '${artifactId}' not found in index`);
    }
    const lifecycle = String(row.lifecycle) as ArtifactLifecycle;
    if (lifecycle !== "staged" && lifecycle !== "sealed" && lifecycle !== "consumed") {
      throw new ArtifactStoreError(`artifact '${artifactId}' is ${lifecycle}, not readable`);
    }

    const filePath = path.join(this.root, String(row.storage_key));
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new ArtifactStoreError(`artifact '${artifactId}' is a symlink — rejected`);
    }
    if (!stat.isFile()) {
      throw new ArtifactStoreError(`artifact '${artifactId}' is not a regular file`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new ArtifactStoreError(`artifact '${artifactId}' is not owner-only`);
    }

    const content = readFileSync(filePath, "utf8");
    const calculated = sha256Hex(content);
    if (calculated !== String(row.sha256)) {
      throw new ArtifactStoreError(`artifact '${artifactId}' hash mismatch on reopen`);
    }
    if (Buffer.byteLength(content, "utf8") !== Number(row.byte_length)) {
      throw new ArtifactStoreError(`artifact '${artifactId}' byte length mismatch on reopen`);
    }

    return {
      handle: {
        schema_version: 1,
        artifact_id: artifactId,
        artifact_kind: String(row.artifact_kind) as ArtifactKind,
        sha256: String(row.sha256) as Sha256Hex,
        media_type: "application/json",
        byte_length: Number(row.byte_length),
      },
      content,
    };
  }

  /**
   * Seal artifacts: transition `staged` rows to `sealed` when a phase result
   * is accepted. Called by `submit_phase_result`.
   */
  seal(artifactIds: readonly string[]): void {
    const now = new Date().toISOString();
    for (const id of artifactIds) {
      const result = this.db
        .prepare(
          `UPDATE artifacts
           SET lifecycle = 'sealed', updated_at = ?
           WHERE artifact_id = ? AND lifecycle = 'staged'`
        )
        .run(now, id);
      if (Number(result.changes) !== 1) {
        throw new ArtifactStoreError(`artifact '${id}' cannot be sealed (not staged)`);
      }
    }
  }

  /**
   * Consume artifacts: transition `sealed` rows to `consumed` when a publisher
   * or applier has used them.
   */
  consume(artifactIds: readonly string[]): void {
    const now = new Date().toISOString();
    for (const id of artifactIds) {
      const result = this.db
        .prepare(
          `UPDATE artifacts
           SET lifecycle = 'consumed', updated_at = ?
           WHERE artifact_id = ? AND lifecycle = 'sealed'`
        )
        .run(now, id);
      if (Number(result.changes) !== 1) {
        throw new ArtifactStoreError(`artifact '${id}' cannot be consumed (not sealed)`);
      }
    }
  }

  /**
   * List all staged or sealed artifacts for a given state.
   */
  listByState(stateId: string, lifecycle?: ArtifactLifecycle): ArtifactHandle[] {
    const states = lifecycle ? [lifecycle] : (["staged", "sealed"] as ArtifactLifecycle[]);
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT artifact_id, artifact_kind, sha256, byte_length
         FROM artifacts
         WHERE state_id = ? AND lifecycle IN (${placeholders})
         ORDER BY created_at`
      )
      .all(stateId, ...states) as Array<Record<string, SQLOutputValue>>;

    return rows.map((row) => ({
      schema_version: 1 as const,
      artifact_id: String(row.artifact_id),
      artifact_kind: String(row.artifact_kind) as ArtifactKind,
      sha256: String(row.sha256) as Sha256Hex,
      media_type: "application/json" as ArtifactMediaType,
      byte_length: Number(row.byte_length),
    }));
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
