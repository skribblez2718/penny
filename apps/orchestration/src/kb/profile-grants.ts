/**
 * Host-owned KB profile-session authority (§5.1).
 *
 * A profile ID has no authority by itself. One exact session/profile grant must
 * be available in the shared owner-only SQLite authority. Each model-visible
 * tool call then records one immutable, transactionally unique use bound to the
 * exact session, invocation, profile, action, request digest, and observed
 * policy digest (or exact policy absence for create-init). The session grant is
 * reusable until revoked/expired; its invocation uses are not authority files
 * and are never discovered by scanning a directory.
 */

import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";

import { Value } from "typebox/value";

import {
  KbSessionProfileGrantRecordSchema,
  KbSessionProfileGrantSchema,
  KbSessionProfileGrantUseSchema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
  type KbSessionProfileGrant,
  type KbSessionProfileGrantRecord,
  type KbSessionProfileGrantState,
  type KbSessionProfileGrantUse,
  type Rfc3339Utc,
  type Sha256Hex,
} from "./contracts.js";
import {
  HOST_GRANT_DATABASE_NAME,
  isUnsafeHostGrantFragment,
  OwnerSqliteDatabase,
} from "./owner-sqlite.js";

export interface KbSessionProfileGrantDocument {
  readonly schema_version: 1;
  readonly record: KbSessionProfileGrantRecord;
  readonly grant: KbSessionProfileGrant;
}

export interface StoredProfileGrantProjection {
  readonly grant_id: string;
  readonly state: KbSessionProfileGrantState;
  readonly session_id: string;
  readonly kb_profile_id: string;
  readonly issued_at: Rfc3339Utc;
  readonly expires_at: Rfc3339Utc;
}

function requiredText(row: Record<string, SQLOutputValue>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`profile-grant database field '${field}' is malformed`);
  }
  return value;
}

function nullablePolicy(row: Record<string, SQLOutputValue>): Sha256Hex | null {
  const value = row["policy_sha256"];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("profile-grant database field 'policy_sha256' is malformed");
  }
  return value as Sha256Hex;
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a real UTC instant`);
  return parsed;
}

function recordDigest(record: KbSessionProfileGrantRecord): Sha256Hex {
  return sha256Hex(canonicalJson(record));
}

function useDigest(use: KbSessionProfileGrantUse): Sha256Hex {
  return sha256Hex(canonicalJson(use));
}

export class KbSessionProfileGrantStore implements Disposable {
  private readonly storage: OwnerSqliteDatabase;

  constructor(root: string) {
    this.storage = new OwnerSqliteDatabase({
      directory: root,
      databaseName: HOST_GRANT_DATABASE_NAME,
      label: "KB host-grant authority",
      isLegacyAuthorityFile: isUnsafeHostGrantFragment,
    });
    try {
      this.storage.db.exec(`
        CREATE TABLE IF NOT EXISTS profile_session_grants (
          grant_id TEXT PRIMARY KEY,
          grant_sha256 TEXT NOT NULL,
          grant_jcs TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kb_profile_id TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('available','revoked','expired')),
          updated_at TEXT NOT NULL,
          record_sha256 TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_available_profile_session_grant
          ON profile_session_grants(session_id, kb_profile_id)
          WHERE state = 'available';
        CREATE INDEX IF NOT EXISTS profile_session_grant_lookup
          ON profile_session_grants(session_id, kb_profile_id, state);

        CREATE TABLE IF NOT EXISTS profile_session_grant_uses (
          session_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL,
          grant_id TEXT NOT NULL,
          grant_sha256 TEXT NOT NULL,
          kb_profile_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN (
            'init','ingest','query','save','lint','promote','status','resume'
          )),
          request_sha256 TEXT NOT NULL,
          policy_sha256 TEXT,
          consumed_at TEXT NOT NULL,
          use_sha256 TEXT NOT NULL,
          PRIMARY KEY(session_id, invocation_id),
          FOREIGN KEY(grant_id) REFERENCES profile_session_grants(grant_id)
        );
      `);
    } catch (error) {
      this.storage.close();
      throw error;
    }
  }

  get dir(): string {
    return this.storage.directory;
  }

  /**
   * Transactionally issue one exact session/profile grant. A byte-identical
   * retry of the same grant ID observes the existing row. Any competing active
   * grant for that session/profile loses; expired rows are terminalized first.
   */
  mint(input: {
    session_id: string;
    kb_profile_id: string;
    issued_at?: string;
    expires_at: string;
    grant_id?: string;
  }): KbSessionProfileGrant {
    // Preserve the store's domain-specific chronology diagnostics while the
    // shared contract independently enforces exact RFC3339-Z syntax/calendar.
    const issuedAtValue = input.issued_at ?? new Date().toISOString();
    parseTimestamp(issuedAtValue, "KB profile grant issuance");
    parseTimestamp(input.expires_at, "KB profile grant expiry");
    const grant = validateKbContract(
      KbSessionProfileGrantSchema,
      {
        schema_version: 1,
        grant_id: input.grant_id ?? `kpg-${randomUUID()}`,
        session_id: input.session_id,
        kb_profile_id: input.kb_profile_id,
        issued_at: issuedAtValue,
        expires_at: input.expires_at,
      },
      "KB session profile grant"
    );
    const issuedAt = parseTimestamp(grant.issued_at, "KB profile grant issuance");
    const expiresAt = parseTimestamp(grant.expires_at, "KB profile grant expiry");
    if (expiresAt <= issuedAt) {
      throw new Error("KB profile grant expiry must be after issuance");
    }
    const grantJcs = canonicalJson(grant);
    const grantSha256 = sha256Hex(grantJcs);
    const now = new Date();

    return this.storage.transaction(() => {
      const existing = this.row(grant.grant_id);
      if (existing !== undefined) {
        const document = this.documentFromRow(existing);
        if (
          document.record.grant_sha256 === grantSha256 &&
          canonicalJson(document.grant) === grantJcs
        ) {
          return document.grant;
        }
        throw new Error(`profile grant id already exists with different bytes: ${grant.grant_id}`);
      }

      this.expireDueScope(grant.session_id, grant.kb_profile_id, now);
      const active = this.scopeRows(grant.session_id, grant.kb_profile_id, "available");
      if (active.length > 0) {
        for (const row of active) this.documentFromRow(row);
        throw new Error("competing profile grant issuance lost to an available grant");
      }

      const record: KbSessionProfileGrantRecord = {
        schema_version: 1,
        grant_id: grant.grant_id,
        grant_sha256: grantSha256,
        state: "available",
        updated_at: now.toISOString(),
      };
      try {
        this.storage.db
          .prepare(
            `INSERT INTO profile_session_grants (
               grant_id, grant_sha256, grant_jcs, session_id, kb_profile_id,
               issued_at, expires_at, state, updated_at, record_sha256
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`
          )
          .run(
            grant.grant_id,
            grantSha256,
            grantJcs,
            grant.session_id,
            grant.kb_profile_id,
            grant.issued_at,
            grant.expires_at,
            record.updated_at,
            recordDigest(record)
          );
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_SQLITE_ERROR") {
          throw new Error("competing profile grant issuance lost");
        }
        throw error;
      }
      return grant;
    });
  }

  /** Load and validate one exact indexed grant row. */
  load(grantId: string): KbSessionProfileGrantDocument {
    this.storage.assertCustody();
    const row = this.row(grantId);
    if (row === undefined) throw new Error(`profile grant is absent: ${grantId}`);
    return this.documentFromRow(row);
  }

  /** Return an already-consumed exact invocation binding, if one exists. */
  useForInvocation(sessionId: string, invocationId: string): KbSessionProfileGrantUse | undefined {
    this.storage.assertCustody();
    const row = this.storage.db
      .prepare(
        `SELECT * FROM profile_session_grant_uses
         WHERE session_id = ? AND invocation_id = ?`
      )
      .get(sessionId, invocationId) as Record<string, SQLOutputValue> | undefined;
    return row === undefined ? undefined : this.useFromRow(row);
  }

  /**
   * Record one immutable exact invocation use. The session grant remains active
   * for other invocations; the `(session_id, invocation_id)` use is single and
   * exact. A byte-identical retry returns the existing use, while a competing
   * profile/action/request/policy binding loses.
   */
  consume(input: {
    session_id: string;
    invocation_id: string;
    kb_profile_id: string;
    action: KbSessionProfileGrantUse["action"];
    request_sha256: Sha256Hex;
    policy_sha256: Sha256Hex | null;
    now?: Date;
  }): KbSessionProfileGrantUse {
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("profile grant use time is invalid");

    return this.storage.transaction(() => {
      const existing = this.useRow(input.session_id, input.invocation_id);
      if (existing !== undefined) {
        const use = this.useFromRow(existing);
        const expected = {
          session_id: input.session_id,
          invocation_id: input.invocation_id,
          kb_profile_id: input.kb_profile_id,
          action: input.action,
          request_sha256: input.request_sha256,
          policy_sha256: input.policy_sha256,
        };
        for (const [field, value] of Object.entries(expected)) {
          if (use[field as keyof typeof use] !== value) {
            throw new Error(`profile grant invocation already consumed with another ${field}`);
          }
        }
        return use;
      }

      this.expireDueScope(input.session_id, input.kb_profile_id, now);
      const rows = this.scopeRows(input.session_id, input.kb_profile_id, "available");
      if (rows.length !== 1) {
        if (rows.length > 1) throw new Error("profile grant authority is ambiguous");
        throw new Error("profile is not granted to the active host session");
      }
      const row = rows[0];
      if (row === undefined) throw new Error("profile grant disappeared during consumption");
      const document = this.documentFromRow(row);
      const at = now.getTime();
      if (
        parseTimestamp(document.grant.issued_at, "KB profile grant issuance") > at ||
        parseTimestamp(document.grant.expires_at, "KB profile grant expiry") <= at
      ) {
        throw new Error("profile grant is not active at the invocation time");
      }

      const use = validateKbContract(
        KbSessionProfileGrantUseSchema,
        {
          schema_version: 1,
          grant_id: document.grant.grant_id,
          grant_sha256: document.record.grant_sha256,
          session_id: input.session_id,
          invocation_id: input.invocation_id,
          kb_profile_id: input.kb_profile_id,
          action: input.action,
          request_sha256: input.request_sha256,
          policy_sha256: input.policy_sha256,
          consumed_at: now.toISOString(),
        },
        "KB session profile grant use"
      );
      try {
        this.storage.db
          .prepare(
            `INSERT INTO profile_session_grant_uses (
               session_id, invocation_id, grant_id, grant_sha256, kb_profile_id,
               action, request_sha256, policy_sha256, consumed_at, use_sha256
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            use.session_id,
            use.invocation_id,
            use.grant_id,
            use.grant_sha256,
            use.kb_profile_id,
            use.action,
            use.request_sha256,
            use.policy_sha256,
            use.consumed_at,
            useDigest(use)
          );
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_SQLITE_ERROR") {
          throw new Error("competing profile grant consumption lost");
        }
        throw error;
      }
      return use;
    });
  }

  /** Revoke one still-available grant. Exact retries are idempotent. */
  revoke(grantId: string): KbSessionProfileGrantDocument {
    return this.storage.transaction(() => {
      const current = this.requireDocument(grantId);
      if (current.record.state === "revoked") return current;
      if (current.record.state !== "available") {
        throw new Error(`profile grant is not available (state: ${current.record.state})`);
      }
      return this.transition(current, "revoked");
    });
  }

  /** Expire one exact available grant once its immutable window closes. */
  expire(grantId: string, now = new Date()): KbSessionProfileGrantDocument {
    if (!Number.isFinite(now.getTime())) throw new Error("profile grant expiry time is invalid");
    return this.storage.transaction(() => {
      const current = this.requireDocument(grantId);
      if (current.record.state === "expired") return current;
      if (current.record.state !== "available") {
        throw new Error(`profile grant is not available (state: ${current.record.state})`);
      }
      if (parseTimestamp(current.grant.expires_at, "KB profile grant expiry") > now.getTime()) {
        throw new Error(`profile grant has not expired: ${grantId}`);
      }
      return this.transition(current, "expired");
    });
  }

  /** Exact SQL lookup; no directory or pathname authority scan. */
  allowedProfiles(sessionId: string, now = new Date()): ReadonlySet<string> {
    if (!Number.isFinite(now.getTime())) throw new Error("profile grant read time is invalid");
    return this.storage.transaction(() => {
      const rows = this.storage.db
        .prepare(
          `SELECT * FROM profile_session_grants
           WHERE session_id = ? AND state = 'available'
           ORDER BY kb_profile_id, grant_id`
        )
        .all(sessionId) as Record<string, SQLOutputValue>[];
      const allowed = new Set<string>();
      for (const row of rows) {
        const document = this.documentFromRow(row);
        const issuedAt = parseTimestamp(document.grant.issued_at, "KB profile grant issuance");
        const expiresAt = parseTimestamp(document.grant.expires_at, "KB profile grant expiry");
        if (expiresAt <= now.getTime()) {
          this.transition(document, "expired", now);
          continue;
        }
        if (issuedAt <= now.getTime()) allowed.add(document.grant.kb_profile_id);
      }
      return allowed;
    });
  }

  list(): { grants: StoredProfileGrantProjection[]; skipped_malformed: number } {
    this.storage.assertCustody();
    const rows = this.storage.db
      .prepare("SELECT * FROM profile_session_grants ORDER BY grant_id")
      .all() as Record<string, SQLOutputValue>[];
    const grants: StoredProfileGrantProjection[] = [];
    let skippedMalformed = 0;
    for (const row of rows) {
      try {
        const document = this.documentFromRow(row);
        grants.push({
          grant_id: document.grant.grant_id,
          state: document.record.state,
          session_id: document.grant.session_id,
          kb_profile_id: document.grant.kb_profile_id,
          issued_at: document.grant.issued_at,
          expires_at: document.grant.expires_at,
        });
      } catch {
        skippedMalformed += 1;
      }
    }
    return { grants, skipped_malformed: skippedMalformed };
  }

  close(): void {
    this.storage.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private row(grantId: string): Record<string, SQLOutputValue> | undefined {
    return this.storage.db
      .prepare("SELECT * FROM profile_session_grants WHERE grant_id = ?")
      .get(grantId) as Record<string, SQLOutputValue> | undefined;
  }

  private scopeRows(
    sessionId: string,
    profileId: string,
    state: KbSessionProfileGrantState
  ): Record<string, SQLOutputValue>[] {
    return this.storage.db
      .prepare(
        `SELECT * FROM profile_session_grants
         WHERE session_id = ? AND kb_profile_id = ? AND state = ?
         ORDER BY grant_id`
      )
      .all(sessionId, profileId, state) as Record<string, SQLOutputValue>[];
  }

  private useRow(
    sessionId: string,
    invocationId: string
  ): Record<string, SQLOutputValue> | undefined {
    return this.storage.db
      .prepare(
        `SELECT * FROM profile_session_grant_uses
         WHERE session_id = ? AND invocation_id = ?`
      )
      .get(sessionId, invocationId) as Record<string, SQLOutputValue> | undefined;
  }

  private requireDocument(grantId: string): KbSessionProfileGrantDocument {
    const row = this.row(grantId);
    if (row === undefined) throw new Error(`profile grant is absent: ${grantId}`);
    return this.documentFromRow(row);
  }

  private documentFromRow(row: Record<string, SQLOutputValue>): KbSessionProfileGrantDocument {
    const grantId = requiredText(row, "grant_id");
    const grantSha256 = requiredText(row, "grant_sha256") as Sha256Hex;
    const grantJcs = requiredText(row, "grant_jcs");
    const state = requiredText(row, "state") as KbSessionProfileGrantState;
    const updatedAt = requiredText(row, "updated_at") as Rfc3339Utc;
    const storedRecordDigest = requiredText(row, "record_sha256");

    let rawGrant: unknown;
    try {
      rawGrant = JSON.parse(grantJcs) as unknown;
    } catch {
      throw new Error(`profile grant row is unparseable: ${grantId}`);
    }
    if (!Value.Check(KbSessionProfileGrantSchema, rawGrant)) {
      throw new Error(`profile grant row failed closed validation: ${grantId}`);
    }
    const grant = rawGrant as KbSessionProfileGrant;
    if (canonicalJson(grant) !== grantJcs) {
      throw new Error(`profile grant row is not exact JCS: ${grantId}`);
    }
    if (grant.grant_id !== grantId || sha256Hex(grantJcs) !== grantSha256) {
      throw new Error(`profile grant identity or digest mismatch: ${grantId}`);
    }
    if (
      requiredText(row, "session_id") !== grant.session_id ||
      requiredText(row, "kb_profile_id") !== grant.kb_profile_id ||
      requiredText(row, "issued_at") !== grant.issued_at ||
      requiredText(row, "expires_at") !== grant.expires_at
    ) {
      throw new Error(`profile grant lookup columns disagree with immutable body: ${grantId}`);
    }
    const issuedAt = parseTimestamp(grant.issued_at, "KB profile grant issuance");
    const expiresAt = parseTimestamp(grant.expires_at, "KB profile grant expiry");
    if (expiresAt <= issuedAt)
      throw new Error(`profile grant has invalid timestamp semantics: ${grantId}`);

    const record: KbSessionProfileGrantRecord = {
      schema_version: 1,
      grant_id: grantId,
      grant_sha256: grantSha256,
      state,
      updated_at: updatedAt,
    };
    if (!Value.Check(KbSessionProfileGrantRecordSchema, record)) {
      throw new Error(`profile grant record failed closed validation: ${grantId}`);
    }
    if (recordDigest(record) !== storedRecordDigest) {
      throw new Error(`profile grant state digest mismatch: ${grantId}`);
    }
    return { schema_version: 1, record, grant };
  }

  private useFromRow(row: Record<string, SQLOutputValue>): KbSessionProfileGrantUse {
    const use = {
      schema_version: 1 as const,
      grant_id: requiredText(row, "grant_id"),
      grant_sha256: requiredText(row, "grant_sha256") as Sha256Hex,
      session_id: requiredText(row, "session_id"),
      invocation_id: requiredText(row, "invocation_id"),
      kb_profile_id: requiredText(row, "kb_profile_id"),
      action: requiredText(row, "action") as KbSessionProfileGrantUse["action"],
      request_sha256: requiredText(row, "request_sha256") as Sha256Hex,
      policy_sha256: nullablePolicy(row),
      consumed_at: requiredText(row, "consumed_at") as Rfc3339Utc,
    };
    if (!Value.Check(KbSessionProfileGrantUseSchema, use)) {
      throw new Error("profile grant use failed closed validation");
    }
    if (useDigest(use) !== requiredText(row, "use_sha256")) {
      throw new Error("profile grant use digest mismatch");
    }
    const document = this.requireDocument(use.grant_id);
    if (
      document.record.grant_sha256 !== use.grant_sha256 ||
      document.grant.session_id !== use.session_id ||
      document.grant.kb_profile_id !== use.kb_profile_id
    ) {
      throw new Error("profile grant use disagrees with its immutable grant");
    }
    return use;
  }

  private transition(
    current: KbSessionProfileGrantDocument,
    state: KbSessionProfileGrantState,
    now = new Date()
  ): KbSessionProfileGrantDocument {
    const record: KbSessionProfileGrantRecord = {
      ...current.record,
      state,
      updated_at: now.toISOString(),
    };
    const result = this.storage.db
      .prepare(
        `UPDATE profile_session_grants
         SET state = ?, updated_at = ?, record_sha256 = ?
         WHERE grant_id = ? AND grant_sha256 = ? AND state = ?
           AND updated_at = ? AND record_sha256 = ?`
      )
      .run(
        record.state,
        record.updated_at,
        recordDigest(record),
        current.grant.grant_id,
        current.record.grant_sha256,
        current.record.state,
        current.record.updated_at,
        recordDigest(current.record)
      );
    if (Number(result.changes) !== 1) {
      throw new Error(
        `profile grant lost its exact state transition race: ${current.grant.grant_id}`
      );
    }
    return { schema_version: 1, record, grant: current.grant };
  }

  private expireDueScope(sessionId: string, profileId: string, now: Date): void {
    for (const row of this.scopeRows(sessionId, profileId, "available")) {
      const document = this.documentFromRow(row);
      if (parseTimestamp(document.grant.expires_at, "KB profile grant expiry") <= now.getTime()) {
        this.transition(document, "expired", now);
      }
    }
  }
}
