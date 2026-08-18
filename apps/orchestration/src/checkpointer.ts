import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { RunContext, type RunContextSnapshot } from "./context.js";
import type { ExecutionReceipt, JsonValue, PhaseResult, RunIdentity } from "./contracts.js";

interface RunRow extends Record<string, SQLOutputValue> {
  run_id: string;
  session_id: string;
  playbook: string;
  engine_owner: string;
  schema_version: number;
  context_json: string;
}

interface ReceiptRow extends Record<string, SQLOutputValue> {
  receipt_id: string;
  result_json: string;
}

interface GateRow extends Record<string, SQLOutputValue> {
  gate_id: string;
  challenge: string;
  status: string;
  response_json: string | null;
}

export interface CheckpointObservation {
  readonly identity: RunIdentity;
  readonly status: string;
  readonly stateId: string;
  readonly eventType: string;
  readonly payload: Record<string, JsonValue>;
  readonly sequence: number;
  readonly timestamp: string;
}

export type CheckpointObserver = (observation: CheckpointObservation) => void;

export interface CheckpointEvent {
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: Record<string, JsonValue>;
  readonly createdAt: string;
}

export class CheckpointIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointIdentityError";
  }
}

export class ReceiptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptConflictError";
  }
}

export class GateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateConflictError";
  }
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

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeJson(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

function numberValue(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

export class Checkpointer implements Disposable {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly observer?: CheckpointObserver
  ) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      const parent = path.dirname(dbPath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      chmodSync(parent, 0o700);
    }
    const { DatabaseSync } = sqliteModule();
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    if (dbPath !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        const databaseFile = `${dbPath}${suffix}`;
        if (existsSync(databaseFile)) {
          chmodSync(databaseFile, 0o600);
        }
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        playbook TEXT NOT NULL,
        engine_owner TEXT NOT NULL CHECK(engine_owner = 'typescript'),
        schema_version INTEGER NOT NULL CHECK(schema_version = 2),
        status TEXT NOT NULL,
        state_id TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        state_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        output_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, state_id, branch_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS gates (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        gate_id TEXT NOT NULL,
        state_id TEXT NOT NULL,
        challenge TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'answered')),
        response_digest TEXT,
        response_json TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        PRIMARY KEY(run_id, gate_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session_playbook
        ON runs(session_id, playbook, status);
      CREATE INDEX IF NOT EXISTS idx_receipts_run_state
        ON receipts(run_id, state_id, branch_id);
      PRAGMA user_version=2;
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createRun(context: RunContext, eventType: string, payload: Record<string, JsonValue>): void {
    const snapshot = context.snapshot();
    const identity = snapshot.identity;
    this.transaction(() => {
      const existing = this.selectRun(identity.run_id);
      if (existing !== undefined) {
        this.assertIdentityRow(identity, existing);
        throw new CheckpointIdentityError(`run_id '${identity.run_id}' already exists`);
      }
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO runs(
            run_id, session_id, playbook, engine_owner, schema_version,
            status, state_id, context_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          identity.run_id,
          identity.session_id,
          identity.playbook,
          identity.engine_owner,
          identity.schema_version,
          context.status,
          context.stateId,
          canonicalJson(snapshot),
          timestamp,
          timestamp
        );
      this.persistPendingGate(context);
      this.insertEvent(identity.run_id, eventType, payload, timestamp);
    });
    this.observe(context, eventType, payload);
  }

  saveRun(context: RunContext, eventType: string, payload: Record<string, JsonValue>): void {
    this.transaction(() => {
      this.updateRun(context);
      this.persistPendingGate(context);
      this.insertEvent(context.identity.run_id, eventType, payload, now());
    });
    this.observe(context, eventType, payload);
  }

  saveWithReceipt(
    context: RunContext,
    result: PhaseResult,
    branchId: string,
    eventType: string,
    payload: Record<string, JsonValue>
  ): void {
    this.transaction(() => {
      this.insertReceipt(result.worker_receipt, result, branchId);
      this.updateRun(context);
      this.persistPendingGate(context);
      this.insertEvent(context.identity.run_id, eventType, payload, now());
    });
    this.observe(context, eventType, payload);
  }

  saveGateResponse(
    context: RunContext,
    gateId: string,
    challenge: string,
    response: JsonValue,
    eventType: string,
    payload: Record<string, JsonValue>
  ): void {
    this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT gate_id, challenge, status, response_json FROM gates WHERE run_id = ? AND gate_id = ?"
        )
        .get(context.identity.run_id, gateId) as GateRow | undefined;
      if (row === undefined) {
        throw new GateConflictError(`unknown gate '${gateId}'`);
      }
      const responseJson = canonicalJson(response);
      if (row.challenge !== challenge) {
        throw new GateConflictError(`challenge mismatch for gate '${gateId}'`);
      }
      if (row.status === "answered") {
        if (row.response_json === responseJson) {
          return;
        }
        throw new GateConflictError(`gate '${gateId}' was already answered`);
      }
      this.db
        .prepare(
          `UPDATE gates
           SET status='answered', response_digest=?, response_json=?, answered_at=?
           WHERE run_id=? AND gate_id=? AND status='pending'`
        )
        .run(sha256(responseJson), responseJson, now(), context.identity.run_id, gateId);
      this.updateRun(context);
      this.persistPendingGate(context);
      this.insertEvent(context.identity.run_id, eventType, payload, now());
    });
    this.observe(context, eventType, payload);
  }

  loadRun(identity: RunIdentity): RunContext {
    const row = this.selectRun(identity.run_id);
    if (row === undefined) {
      throw new CheckpointIdentityError(`unknown run_id '${identity.run_id}'`);
    }
    this.assertIdentityRow(identity, row);
    const snapshot = JSON.parse(row.context_json) as RunContextSnapshot;
    const context = RunContext.fromSnapshot(snapshot);
    this.assertIdentity(identity, context.identity);
    return context;
  }

  loadRunById(runId: string): RunContext | undefined {
    const row = this.selectRun(runId);
    if (row === undefined) {
      return undefined;
    }
    const snapshot = JSON.parse(row.context_json) as RunContextSnapshot;
    return RunContext.fromSnapshot(snapshot);
  }

  receiptResult(receipt: ExecutionReceipt): PhaseResult | undefined {
    const row = this.db
      .prepare("SELECT receipt_id, result_json FROM receipts WHERE receipt_id = ?")
      .get(receipt.receipt_id) as ReceiptRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return JSON.parse(row.result_json) as PhaseResult;
  }

  events(runId: string): CheckpointEvent[] {
    const rows = this.db
      .prepare(
        "SELECT sequence, event_type, payload_json, created_at FROM events WHERE run_id = ? ORDER BY sequence"
      )
      .all(runId) as Array<Record<string, SQLOutputValue>>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      eventType: String(row.event_type),
      payload: JSON.parse(String(row.payload_json)) as Record<string, JsonValue>,
      createdAt: String(row.created_at),
    }));
  }

  tableNames(): string[] {
    return (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<Record<string, SQLOutputValue>>
    ).map((row) => String(row.name));
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private selectRun(runId: string): RunRow | undefined {
    return this.db
      .prepare(
        `SELECT run_id, session_id, playbook, engine_owner, schema_version, context_json
         FROM runs WHERE run_id = ?`
      )
      .get(runId) as RunRow | undefined;
  }

  private assertIdentityRow(identity: RunIdentity, row: RunRow): void {
    this.assertIdentity(identity, {
      schema_version: Number(row.schema_version) as 2,
      run_id: row.run_id,
      session_id: row.session_id,
      playbook: row.playbook,
      engine_owner: row.engine_owner as "typescript" | "python",
    });
  }

  private assertIdentity(expected: RunIdentity, actual: RunIdentity): void {
    for (const key of [
      "schema_version",
      "run_id",
      "session_id",
      "playbook",
      "engine_owner",
    ] as const) {
      if (expected[key] !== actual[key]) {
        throw new CheckpointIdentityError(
          `checkpoint identity mismatch for ${key}: expected '${expected[key]}', found '${actual[key]}'`
        );
      }
    }
  }

  private updateRun(context: RunContext): void {
    const identity = context.identity;
    const result = this.db
      .prepare(
        `UPDATE runs
         SET status=?, state_id=?, context_json=?, updated_at=?
         WHERE run_id=? AND session_id=? AND playbook=?
           AND engine_owner=? AND schema_version=?`
      )
      .run(
        context.status,
        context.stateId,
        canonicalJson(context.snapshot()),
        now(),
        identity.run_id,
        identity.session_id,
        identity.playbook,
        identity.engine_owner,
        identity.schema_version
      );
    if (numberValue(result.changes) !== 1) {
      const row = this.selectRun(identity.run_id);
      if (row === undefined) {
        throw new CheckpointIdentityError(`unknown run_id '${identity.run_id}'`);
      }
      this.assertIdentityRow(identity, row);
      throw new CheckpointIdentityError(`failed to update checkpoint '${identity.run_id}'`);
    }
  }

  private insertEvent(
    runId: string,
    eventType: string,
    payload: Record<string, JsonValue>,
    timestamp: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO events(run_id, sequence, event_type, payload_json, created_at)
         SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?
         FROM events WHERE run_id = ?`
      )
      .run(runId, eventType, canonicalJson(payload), timestamp, runId);
  }

  private insertReceipt(receipt: ExecutionReceipt, result: PhaseResult, branchId: string): void {
    const resultJson = canonicalJson(result);
    const existingById = this.db
      .prepare("SELECT receipt_id, result_json FROM receipts WHERE receipt_id = ?")
      .get(receipt.receipt_id) as ReceiptRow | undefined;
    if (existingById !== undefined) {
      if (existingById.result_json === resultJson) {
        return;
      }
      throw new ReceiptConflictError(`receipt_id '${receipt.receipt_id}' has conflicting content`);
    }
    try {
      this.db
        .prepare(
          `INSERT INTO receipts(
            receipt_id, run_id, state_id, branch_id, agent, attempt,
            worker_id, output_digest, result_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          receipt.receipt_id,
          receipt.run_id,
          receipt.state_id,
          branchId,
          receipt.agent,
          receipt.attempt,
          receipt.worker_id,
          receipt.output_digest,
          resultJson,
          now()
        );
    } catch (error) {
      throw new ReceiptConflictError(
        `assignment ${receipt.run_id}/${receipt.state_id}/${branchId}/${receipt.attempt} already has a receipt: ${String(error)}`
      );
    }
  }

  private observe(
    context: RunContext,
    eventType: string,
    payload: Record<string, JsonValue>
  ): void {
    if (this.observer === undefined) {
      return;
    }
    try {
      const event = this.events(context.identity.run_id).at(-1);
      if (event === undefined) {
        return;
      }
      this.observer({
        identity: context.identity,
        status: context.status,
        stateId: context.stateId,
        eventType,
        payload: structuredClone(payload),
        sequence: event.sequence,
        timestamp: event.createdAt,
      });
    } catch {
      // The observability mirror never blocks durable checkpoint truth.
    }
  }

  private persistPendingGate(context: RunContext): void {
    const directive = context.pendingDirective;
    if (directive?.action !== "await_user") {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO gates(
          run_id, gate_id, state_id, challenge, payload_digest, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(run_id, gate_id) DO NOTHING`
      )
      .run(
        context.identity.run_id,
        directive.gate_id,
        directive.state_id,
        directive.challenge,
        directive.payload_digest,
        now()
      );
  }
}
