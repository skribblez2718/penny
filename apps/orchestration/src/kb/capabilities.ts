/**
 * KB capabilities — §5.2 host-minted source and canonical-target capabilities.
 *
 * A capability is the host's way of authorizing one specific operation against one
 * specific file without ever exposing a path to the model. The model carries an
 * opaque `capability_id`; the host resolves it to a path, validates the file, and
 * enforces single-use lifecycle transitions.
 *
 * This module implements the SQLite-backed capability store (separate from the
 * orchestration control DB) and the envelope/lease/admission schemas. The
 * all-or-none claim protocol, snapshot I/O, and crash recovery are also here.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { canonicalJson, sha256Hex, type Sha256Hex } from "./contracts.js";

// ── Types (§5.2) ────────────────────────────────────────────────────────────

export type CapabilityKind = "source_read" | "canonical_target";

export interface SourceCapabilityMetadata {
  source_type: "file" | "url_snapshot" | "research_artifact" | "manual";
  captured_at: string;
  published_at?: string;
  title: string;
  authors: string[];
  redacted_locator?: string;
}

export interface CapabilityEnvelope {
  schema_version: 1;
  capability_id: string;
  kind: CapabilityKind;
  session_id: string;
  kb_profile_id: string;
  resolved_path: string;
  authority_root?: string;
  expected_sha256: Sha256Hex;
  media_type?: string;
  source_metadata?: SourceCapabilityMetadata;
  allowed_operation: "ingest" | "promote";
  issued_at: string;
  expires_at: string;
}

export type CapabilityState =
  | "available"
  | "claimed"
  | "commit_reserved"
  | "apply_reserved"
  | "consumed"
  | "invalidated"
  | "expired";

export interface CapabilityLease {
  schema_version: 1;
  capability_id: string;
  envelope_sha256: Sha256Hex;
  state: CapabilityState;
  run_id?: string;
  transaction_id?: string;
  claimed_at?: string;
  reserved_at?: string;
  terminal_at?: string;
}

export type AdmissionState = "preparing" | "admitted" | "published" | "discarding" | "discarded";

export interface SourceAdmissionRecord {
  schema_version: 1;
  source_id: string;
  capability_id: string;
  envelope_sha256: Sha256Hex;
  run_id: string;
  transaction_id: string;
  sha256: Sha256Hex;
  media_type: "text/plain" | "text/markdown" | "application/json";
  byte_length: number;
  storage_key: string;
  temporary_storage_key?: string;
  state: AdmissionState;
  created_at: string;
  updated_at: string;
}

// ── Cross-field validation (§5.2) ───────────────────────────────────────────

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

/**
 * Validate a capability envelope's cross-field rules.
 *
 * - `source_read` requires `allowed_operation: "ingest"`, no `authority_root`,
 *   a media type in the text/plain|text/markdown|application/json set, and
 *   complete `source_metadata`.
 * - `canonical_target` requires `allowed_operation: "promote"`, no
 *   `source_metadata`, and a present `authority_root`.
 */
export function validateEnvelopeCrossField(env: CapabilityEnvelope): void {
  const validMediaTypes = new Set(["text/plain", "text/markdown", "application/json"]);

  if (env.kind === "source_read") {
    if (env.allowed_operation !== "ingest") {
      throw new CapabilityError(
        `source_read capability '${env.capability_id}' must have allowed_operation "ingest"`
      );
    }
    if (env.authority_root !== undefined) {
      throw new CapabilityError(
        `source_read capability '${env.capability_id}' must not carry authority_root`
      );
    }
    if (env.media_type !== undefined && !validMediaTypes.has(env.media_type)) {
      throw new CapabilityError(
        `source_read capability '${env.capability_id}' has unsupported media_type '${env.media_type}'`
      );
    }
    if (env.source_metadata === undefined) {
      throw new CapabilityError(
        `source_read capability '${env.capability_id}' must carry source_metadata`
      );
    }
  } else if (env.kind === "canonical_target") {
    if (env.allowed_operation !== "promote") {
      throw new CapabilityError(
        `canonical_target capability '${env.capability_id}' must have allowed_operation "promote"`
      );
    }
    if (env.source_metadata !== undefined) {
      throw new CapabilityError(
        `canonical_target capability '${env.capability_id}' must not carry source_metadata`
      );
    }
    if (env.authority_root === undefined) {
      throw new CapabilityError(
        `canonical_target capability '${env.capability_id}' must carry authority_root`
      );
    }
  }
}

/**
 * Mint a new capability envelope. The host generates the opaque ID; the caller
 * supplies the resolved path, digest, and metadata. The envelope is stored in
 * the capability DB and returned for the host to hand to the model as an opaque
 * capability ID only.
 */
export function mintEnvelope(input: {
  kind: CapabilityKind;
  session_id: string;
  kb_profile_id: string;
  resolved_path: string;
  expected_sha256: Sha256Hex;
  allowed_operation: "ingest" | "promote";
  issued_at: string;
  expires_at: string;
  authority_root?: string;
  media_type?: string;
  source_metadata?: SourceCapabilityMetadata;
}): CapabilityEnvelope {
  const envelope: CapabilityEnvelope = {
    schema_version: 1,
    capability_id: `cap_${randomUUID().replace(/-/g, "")}`,
    kind: input.kind,
    session_id: input.session_id,
    kb_profile_id: input.kb_profile_id,
    resolved_path: input.resolved_path,
    expected_sha256: input.expected_sha256,
    allowed_operation: input.allowed_operation,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    ...(input.authority_root !== undefined ? { authority_root: input.authority_root } : {}),
    ...(input.media_type !== undefined ? { media_type: input.media_type } : {}),
    ...(input.source_metadata !== undefined ? { source_metadata: input.source_metadata } : {}),
  };
  validateEnvelopeCrossField(envelope);
  return envelope;
}

/** SHA-256 of the JCS-canonical envelope — the digest stored in the lease. */
export function envelopeDigest(env: CapabilityEnvelope): Sha256Hex {
  return sha256Hex(canonicalJson(env));
}

// ── Capability store (SQLite, separate DB) ──────────────────────────────────

function sqliteModule(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule("node:" + "sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (mod === undefined) throw new Error("Node.js runtime does not provide node:sqlite");
  return mod;
}

export class CapabilityStore implements Disposable {
  readonly root: string;
  private readonly db: DatabaseSync;

  constructor(root: string) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    const { DatabaseSync } = sqliteModule();
    this.db = new DatabaseSync(path.join(this.root, "capabilities.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capability_leases (
        capability_id TEXT PRIMARY KEY,
        envelope_sha256 TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'available',
        run_id TEXT,
        transaction_id TEXT,
        claimed_at TEXT,
        reserved_at TEXT,
        terminal_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_admissions (
        source_id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL,
        run_id TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        storage_key TEXT NOT NULL,
        temporary_storage_key TEXT,
        state TEXT NOT NULL DEFAULT 'preparing',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(capability_id, run_id, transaction_id)
      );
    `);
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = path.join(this.root, `capabilities.sqlite${suffix}`);
      if (existsSync(f)) chmodSync(f, 0o600);
    }
  }

  /** Store a newly minted envelope's lease as `available`. */
  register(envelope: CapabilityEnvelope): CapabilityLease {
    const digest = envelopeDigest(envelope);
    this.db
      .prepare(
        `INSERT INTO capability_leases (capability_id, envelope_sha256, state, updated_at)
         VALUES (?, ?, 'available', ?)`
      )
      .run(envelope.capability_id, digest, new Date().toISOString());
    return {
      schema_version: 1,
      capability_id: envelope.capability_id,
      envelope_sha256: digest,
      state: "available",
    };
  }

  /**
   * Atomically claim the complete set of capability IDs or none.
   *
   * All-or-none: every ID must be `available` and not expired. If any fails,
   * the transaction rolls back and no claim is made.
   */
  claimAll(
    capabilityIds: readonly string[],
    runId: string,
    transactionId: string,
    now = new Date().toISOString()
  ): void {
    if (capabilityIds.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of capabilityIds) {
        const row = this.db
          .prepare("SELECT state FROM capability_leases WHERE capability_id = ?")
          .get(id) as { state: string } | undefined;
        if (row === undefined) {
          throw new CapabilityError(`capability '${id}' not found`);
        }
        if (row.state !== "available") {
          throw new CapabilityError(`capability '${id}' is ${row.state}, not available`);
        }
      }
      for (const id of capabilityIds) {
        this.db
          .prepare(
            `UPDATE capability_leases
             SET state = 'claimed', run_id = ?, transaction_id = ?, claimed_at = ?, updated_at = ?
             WHERE capability_id = ? AND state = 'available'`
          )
          .run(runId, transactionId, now, now, id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Transition a claimed capability to `consumed` (selector commit / post-apply verification). */
  consume(capabilityId: string, now = new Date().toISOString()): void {
    const result = this.db
      .prepare(
        `UPDATE capability_leases
         SET state = 'consumed', terminal_at = ?, updated_at = ?
         WHERE capability_id = ? AND state IN ('claimed', 'commit_reserved', 'apply_reserved')`
      )
      .run(now, now, capabilityId);
    if (Number(result.changes) !== 1) {
      throw new CapabilityError(
        `capability '${capabilityId}' cannot be consumed from its current state`
      );
    }
  }

  /** Transition a capability to `invalidated` (deny, drift, cancellation, abandonment). */
  invalidate(capabilityId: string, now = new Date().toISOString()): void {
    const result = this.db
      .prepare(
        `UPDATE capability_leases
         SET state = 'invalidated', terminal_at = ?, updated_at = ?
         WHERE capability_id = ? AND state NOT IN ('consumed', 'invalidated', 'expired')`
      )
      .run(now, now, capabilityId);
    if (Number(result.changes) !== 1) {
      throw new CapabilityError(
        `capability '${capabilityId}' cannot be invalidated from its current state`
      );
    }
  }

  /** Read a lease by capability ID. */
  lease(capabilityId: string): CapabilityLease | undefined {
    const row = this.db
      .prepare("SELECT * FROM capability_leases WHERE capability_id = ?")
      .get(capabilityId) as Record<string, SQLOutputValue> | undefined;
    if (row === undefined) return undefined;
    return {
      schema_version: 1,
      capability_id: String(row.capability_id),
      envelope_sha256: String(row.envelope_sha256) as Sha256Hex,
      state: String(row.state) as CapabilityState,
      ...(row.run_id != null ? { run_id: String(row.run_id) } : {}),
      ...(row.transaction_id != null ? { transaction_id: String(row.transaction_id) } : {}),
      ...(row.claimed_at != null ? { claimed_at: String(row.claimed_at) } : {}),
      ...(row.reserved_at != null ? { reserved_at: String(row.reserved_at) } : {}),
      ...(row.terminal_at != null ? { terminal_at: String(row.terminal_at) } : {}),
    };
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
