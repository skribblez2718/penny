import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";

import { assertSupportedSqliteVersion } from "../../orchestration/dist/state/sqlite-runtime.js";
import { canonicalJson } from "../../orchestration/dist/canonical-json.js";
import {
  SCA_BROKER_CONTRACT_LIMITS_V1,
  ScaBrokerContractError,
  classifyScaBrokerIdempotency,
  scaBrokerExecuteRequestSha256,
  validateScaBrokerExecuteAcceptedResultV2,
  validateScaBrokerExecuteRequestV1,
  validateScaBrokerJobProgressV1,
  validateScaBrokerReceiptV1,
  type ScaBrokerErrorCode,
  type ScaBrokerExecuteAcceptedResultV2,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerJobProgressV1,
  type ScaBrokerReceiptV1,
} from "./contracts.js";

// Use Node's builtin loader; older test resolvers do not recognize node:sqlite.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const DEFAULT_MAX_RETAINED_JOBS = 256;
const MAX_RETAINED_JOBS = 10_000;
const SIDECARS = ["-journal", "-wal", "-shm"];
const METADATA_SQL = `CREATE TABLE metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL,
  max_retained_jobs INTEGER NOT NULL CHECK (max_retained_jobs BETWEEN 1 AND 10000)
) STRICT`;
const JOBS_SQL = `CREATE TABLE jobs (
  request_sha256 TEXT PRIMARY KEY NOT NULL,
  idempotency_identity TEXT UNIQUE NOT NULL,
  job_identity TEXT UNIQUE NOT NULL,
  request_bytes BLOB NOT NULL,
  accepted_bytes BLOB NOT NULL,
  receipt_bytes BLOB,
  progress_bytes BLOB,
  CHECK ((receipt_bytes IS NULL) = (progress_bytes IS NULL))
) STRICT`;

export interface ScaJobStoreOptions {
  readonly projectId: string;
  /** A hard admission quota. No eviction: forgetting an identity would permit re-execution. */
  readonly maxRetainedJobs?: number;
}

export interface ScaStoredJob {
  readonly request: ScaBrokerExecuteRequestV1;
  readonly accepted: ScaBrokerExecuteAcceptedResultV2;
  readonly receipt: ScaBrokerReceiptV1 | null;
  readonly progress: ScaBrokerJobProgressV1;
}

export type ScaJobStoreAdmission =
  | { readonly disposition: "inserted"; readonly job: ScaStoredJob }
  | { readonly disposition: "duplicate"; readonly job: ScaStoredJob };

/** Bounded operational view of retained state. Contains no request or receipt bodies. */
export interface ScaJobStoreSummary {
  readonly projectId: string;
  readonly retainedJobs: number;
  readonly terminalJobs: number;
  readonly maxRetainedJobs: number;
}

export class ScaJobStoreError extends Error {
  constructor(
    readonly code: ScaBrokerErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaJobStoreError";
  }
}

function retainedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETAINED_JOBS) {
    throw new Error("SCA job store retained row limit must be between 1 and 10000");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("SCA job store contains an invalid row");
  }
  return value;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function canonicalValue(value: unknown): unknown {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength > SCA_BROKER_CONTRACT_LIMITS_V1.max_request_bytes
  ) {
    throw new Error("SCA job store contains invalid document bytes");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error("SCA job store document is not canonical");
  return parsed;
}

function identities(request: ScaBrokerExecuteRequestV1): { idempotency: string; job: string } {
  const scope = [request.tenant_id, request.project_id, request.run_id];
  return {
    idempotency: canonicalJson([...scope, request.idempotency_key]),
    job: canonicalJson([...scope, request.job_id, request.attempt]),
  };
}

function ownerStat(target: string, directory: boolean): BigIntStats {
  const stat = lstatSync(target, { bigint: true });
  const uid = process.geteuid?.();
  if (
    uid === undefined ||
    stat.uid !== BigInt(uid) ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
    (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
  ) {
    throw new Error(
      `SCA job store ${directory ? "parent must be owner-only 0700" : "file must be owner-only single-link 0600"}`
    );
  }
  return stat;
}

function exists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function validatePath(databasePath: string): void {
  if (
    !path.isAbsolute(databasePath) ||
    path.normalize(databasePath) !== databasePath ||
    databasePath.includes("\0") ||
    databasePath.length > 4096
  )
    throw new Error("SCA job store path must be a canonical absolute path");
  const parent = path.dirname(databasePath);
  ownerStat(parent, true);
  if (realpathSync(parent) !== parent)
    throw new Error("SCA job store path may not traverse symlinks");
}

function validateOptions(options: ScaJobStoreOptions): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.projectId)) {
    throw new Error("SCA job store project binding is invalid");
  }
  if (options.maxRetainedJobs !== undefined) retainedLimit(options.maxRetainedJobs);
}

function syncPath(target: string, directory: boolean): void {
  const fd = openSync(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function disableTrustedSchema(db: SqliteDatabase): void {
  db.exec("PRAGMA trusted_schema=OFF");
  if (db.prepare("PRAGMA trusted_schema").get()?.trusted_schema !== 0) {
    throw new Error("SCA job store could not disable trusted SQLite schema execution");
  }
}

function inspectExisting(databasePath: string, options: ScaJobStoreOptions): ScaJobStoreSummary {
  validatePath(databasePath);
  const before = ownerStat(databasePath, false);
  for (const suffix of SIDECARS) {
    if (exists(`${databasePath}${suffix}`)) ownerStat(`${databasePath}${suffix}`, false);
  }
  const preflight = new DatabaseSync(databasePath, { readOnly: true });
  let summary: ScaJobStoreSummary | undefined;
  try {
    disableTrustedSchema(preflight);
    const schema = preflight
      .prepare("SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name")
      .all();
    if (
      canonicalJson(schema) !==
      canonicalJson([
        { name: "jobs", sql: JOBS_SQL },
        { name: "metadata", sql: METADATA_SQL },
      ])
    ) {
      throw new Error("SCA job store schema is incompatible");
    }
    const metadata = preflight.prepare("SELECT * FROM metadata").all();
    const binding = record(metadata[0]);
    if (
      metadata.length !== 1 ||
      binding.schema_version !== 1 ||
      binding.project_id !== options.projectId ||
      typeof binding.max_retained_jobs !== "number"
    ) {
      throw new Error("SCA job store project binding does not match");
    }
    const limit = retainedLimit(binding.max_retained_jobs);
    if (options.maxRetainedJobs !== undefined && limit !== options.maxRetainedJobs) {
      throw new Error("SCA job store retained row limit does not match");
    }
    const health = preflight.prepare("PRAGMA quick_check").all();
    if (health.length !== 1 || record(health[0]).quick_check !== "ok") {
      throw new Error("SCA job store integrity check failed");
    }
    if (preflight.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") {
      throw new Error("SCA job store journal mode is incompatible");
    }
    const counts = record(
      preflight
        .prepare("SELECT count(*) AS retained, count(receipt_bytes) AS terminal FROM jobs")
        .get()
    );
    const retained = counts.retained;
    const terminal = counts.terminal;
    if (
      typeof retained !== "number" ||
      typeof terminal !== "number" ||
      retained > limit ||
      terminal < 0 ||
      terminal > retained
    ) {
      throw new Error("SCA job store retained row summary is inconsistent");
    }
    summary = {
      projectId: options.projectId,
      retainedJobs: retained,
      terminalJobs: terminal,
      maxRetainedJobs: limit,
    };
  } finally {
    preflight.close();
  }
  const after = ownerStat(databasePath, false);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("SCA job store changed while opening");
  }
  if (summary === undefined) throw new Error("SCA job store inspection did not complete");
  return summary;
}

/** Project-bound SQLite custody. Runtime opening never provisions or repairs retained state. */
export class ScaJobStore {
  private closed = false;
  private readonly parentIdentity: BigIntStats;
  private readonly fileIdentity: BigIntStats;

  private constructor(
    readonly databasePath: string,
    readonly projectId: string,
    readonly maxRetainedJobs: number,
    private readonly db: SqliteDatabase
  ) {
    this.parentIdentity = ownerStat(path.dirname(databasePath), true);
    this.fileIdentity = ownerStat(databasePath, false);
  }

  static provision(databasePath: string, options: ScaJobStoreOptions): ScaJobStore {
    assertSupportedSqliteVersion(process.versions.sqlite);
    validateOptions(options);
    validatePath(databasePath);
    if (exists(databasePath) || SIDECARS.some((suffix) => exists(`${databasePath}${suffix}`))) {
      throw new Error("SCA job store already exists; provisioning refuses retained state");
    }
    const temporary = path.join(
      path.dirname(databasePath),
      `.sca-jobs-${randomBytes(16).toString("hex")}.db`
    );
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    try {
      const db = new DatabaseSync(temporary);
      try {
        disableTrustedSchema(db);
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
        db.exec(`${METADATA_SQL}; ${JOBS_SQL};`);
        db.prepare("INSERT INTO metadata VALUES (1, 1, ?, ?)").run(
          options.projectId,
          retainedLimit(options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS)
        );
        db.exec("COMMIT");
      } finally {
        db.close();
      }
      syncPath(temporary, false);
      validatePath(databasePath);
      // Publish a complete database with no-clobber semantics, never an empty runtime store.
      linkSync(temporary, databasePath);
    } finally {
      unlinkSync(temporary);
    }
    syncPath(path.dirname(databasePath), true);
    return ScaJobStore.openExisting(databasePath, options);
  }

  /** Read-only inspection. It never opens a writable connection, provisions, repairs, or evicts. */
  static inspectExisting(databasePath: string, options: ScaJobStoreOptions): ScaJobStoreSummary {
    assertSupportedSqliteVersion(process.versions.sqlite);
    validateOptions(options);
    return inspectExisting(databasePath, options);
  }

  static openExisting(databasePath: string, options: ScaJobStoreOptions): ScaJobStore {
    assertSupportedSqliteVersion(process.versions.sqlite);
    validateOptions(options);
    const inspected = inspectExisting(databasePath, options);
    const db = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      disableTrustedSchema(db);
      db.exec("PRAGMA synchronous=FULL");
      const store = new ScaJobStore(databasePath, options.projectId, inspected.maxRetainedJobs, db);
      store.assertCustody();
      store.retained();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Reserve before dispatch. Transactions serialize duplicate/conflict/quota decisions. */
  admit(
    requestValue: ScaBrokerExecuteRequestV1,
    acceptedValue: ScaBrokerExecuteAcceptedResultV2
  ): ScaJobStoreAdmission {
    return this.operation(() =>
      this.transaction(() => {
        const request = validateScaBrokerExecuteRequestV1(requestValue);
        this.assertProject(request);
        const accepted = validateScaBrokerExecuteAcceptedResultV2(acceptedValue, request);
        if (accepted.progress.sequence !== 0)
          throw new Error("SCA job store admission requires baseline progress");
        const jobs = this.retained();
        for (const existing of jobs) {
          if (classifyScaBrokerIdempotency(existing.request, request) === "duplicate") {
            return { disposition: "duplicate", job: existing };
          }
        }
        if (jobs.length >= this.maxRetainedJobs)
          throw new ScaJobStoreError("quota_exceeded", "SCA retained job limit was reached");
        const identity = identities(request);
        this.db
          .prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, NULL, NULL)")
          .run(
            accepted.request_sha256,
            identity.idempotency,
            identity.job,
            canonicalBytes(request),
            canonicalBytes(accepted)
          );
        return {
          disposition: "inserted",
          job: { request, accepted, receipt: null, progress: accepted.progress },
        };
      })
    );
  }

  findDuplicate(requestValue: ScaBrokerExecuteRequestV1): ScaStoredJob | null {
    return this.operation(() => {
      const request = validateScaBrokerExecuteRequestV1(requestValue);
      this.assertProject(request);
      for (const existing of this.retained()) {
        if (classifyScaBrokerIdempotency(existing.request, request) === "duplicate")
          return existing;
      }
      return null;
    });
  }

  get(requestSha256: string): ScaStoredJob | null {
    return this.operation(() => {
      const row: unknown = this.db
        .prepare("SELECT * FROM jobs WHERE request_sha256 = ?")
        .get(requestSha256);
      return row === undefined ? null : this.parseJob(row);
    });
  }

  persistTerminal(
    requestSha256: string,
    receiptValue: ScaBrokerReceiptV1,
    progressValue: ScaBrokerJobProgressV1
  ): void {
    this.operation(() =>
      this.transaction(() => {
        const row: unknown = this.db
          .prepare("SELECT * FROM jobs WHERE request_sha256 = ?")
          .get(requestSha256);
        if (row === undefined) throw new Error("SCA job store reservation is absent");
        const job = this.parseJob(row);
        const receipt = validateScaBrokerReceiptV1(receiptValue, job.request);
        const progress = validateScaBrokerJobProgressV1(progressValue, job.accepted);
        this.assertTerminalBinding(job, receipt, progress);
        if (job.receipt !== null) {
          if (
            canonicalJson(job.receipt) !== canonicalJson(receipt) ||
            canonicalJson(job.progress) !== canonicalJson(progress)
          ) {
            throw new ScaJobStoreError(
              "conflict",
              "SCA terminal receipt conflicts with retained work"
            );
          }
          return;
        }
        this.db
          .prepare("UPDATE jobs SET receipt_bytes = ?, progress_bytes = ? WHERE request_sha256 = ?")
          .run(canonicalBytes(receipt), canonicalBytes(progress), requestSha256);
      })
    );
  }

  /** Read-only, body-free retained-row counts for operator inspection. Never repairs or evicts. */
  summary(): ScaJobStoreSummary {
    return this.operation(() => {
      const counts = record(
        this.db
          .prepare("SELECT count(*) AS retained, count(receipt_bytes) AS terminal FROM jobs")
          .get()
      );
      const retained = counts.retained;
      const terminal = counts.terminal;
      if (
        typeof retained !== "number" ||
        typeof terminal !== "number" ||
        retained > this.maxRetainedJobs ||
        terminal < 0 ||
        terminal > retained
      ) {
        throw new Error("SCA job store retained row summary is inconsistent");
      }
      return {
        projectId: this.projectId,
        retainedJobs: retained,
        terminalJobs: terminal,
        maxRetainedJobs: this.maxRetainedJobs,
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private assertCustody(): void {
    if (this.closed) throw new Error("SCA job store is closed");
    validatePath(this.databasePath);
    const parent = ownerStat(path.dirname(this.databasePath), true);
    const file = ownerStat(this.databasePath, false);
    if (
      parent.dev !== this.parentIdentity.dev ||
      parent.ino !== this.parentIdentity.ino ||
      file.dev !== this.fileIdentity.dev ||
      file.ino !== this.fileIdentity.ino
    ) {
      throw new Error("SCA job store custody changed");
    }
    for (const suffix of SIDECARS)
      if (exists(`${this.databasePath}${suffix}`))
        ownerStat(`${this.databasePath}${suffix}`, false);
  }

  private operation<T>(operation: () => T): T {
    try {
      this.assertCustody();
      return operation();
    } catch (error) {
      if (error instanceof ScaJobStoreError) throw error;
      if (error instanceof ScaBrokerContractError && error.code === "conflict")
        throw new ScaJobStoreError("conflict", "SCA job identity conflicts with retained work");
      throw new ScaJobStoreError("service_unavailable", "SCA durable job state is unavailable", {
        cause: error,
      });
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* Preserve the original storage failure. */
      }
      throw error;
    }
  }

  private retained(): ScaStoredJob[] {
    const count = this.db.prepare("SELECT count(*) AS count FROM jobs").get()?.count;
    if (typeof count !== "number" || count > this.maxRetainedJobs)
      throw new Error("SCA job store exceeds its retained row bound");
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY request_sha256")
      .all()
      .map((row) => this.parseJob(row));
  }

  private assertProject(request: ScaBrokerExecuteRequestV1): void {
    if (request.project_id !== this.projectId)
      throw new ScaJobStoreError("invalid_request", "SCA job project binding does not match");
  }

  private parseJob(value: unknown): ScaStoredJob {
    const row = record(value);
    const request = validateScaBrokerExecuteRequestV1(canonicalValue(row.request_bytes));
    this.assertProject(request);
    const accepted = validateScaBrokerExecuteAcceptedResultV2(
      canonicalValue(row.accepted_bytes),
      request
    );
    const identity = identities(request);
    if (
      row.request_sha256 !== scaBrokerExecuteRequestSha256(request) ||
      row.idempotency_identity !== identity.idempotency ||
      row.job_identity !== identity.job ||
      accepted.progress.sequence !== 0
    ) {
      throw new Error("SCA job store retained identity is inconsistent");
    }
    if (row.receipt_bytes === null && row.progress_bytes === null)
      return { request, accepted, receipt: null, progress: accepted.progress };
    const receipt = validateScaBrokerReceiptV1(canonicalValue(row.receipt_bytes), request);
    const progress = validateScaBrokerJobProgressV1(canonicalValue(row.progress_bytes), accepted);
    const job = { request, accepted, receipt, progress };
    this.assertTerminalBinding(job, receipt, progress);
    return job;
  }

  private assertTerminalBinding(
    job: ScaStoredJob,
    receipt: ScaBrokerReceiptV1,
    progress: ScaBrokerJobProgressV1
  ): void {
    if (
      receipt.accepted_at !== job.accepted.accepted_at ||
      progress.output_bytes > job.request.limits.max_output_bytes ||
      progress.result_items > job.request.limits.max_result_items
    ) {
      throw new Error("SCA job store terminal binding is inconsistent");
    }
  }
}
