import { validateSkillSchema } from "../skill-contracts/common.js";
import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { OwnerSqliteDatabase } from "../state/owner-sqlite.js";
import { CATALOG_DATABASE_NAME, PROJECT_ID_PATTERN, pennyStatePaths } from "../state/paths.js";
import { PROJECT_CATALOG_SCHEMA_VERSION } from "../state/catalog.js";
import {
  capacityCore,
  capacityParkingJournalBinding,
  HostCapacityParkingProofV1Schema,
  validateCapacityStoredRecord,
  type HostCapacityParkingProofV1,
  type HostCapacityRuntimeRecordV2,
} from "./capacity-runtime-contracts.js";
import {
  hostOperationRecordId,
  HostOperationLeaseIdentityV1Schema,
  validateHostOperationDispositionReceipt,
  validateHostOperationCallRecord,
  type HostOperationCallRecordV1,
  type HostOperationDispositionReceiptV1,
  type HostOperationDispositionV1,
  type HostOperationLeaseIdentityV1,
  type HostOperationQuarantineResetV1,
} from "./contracts.js";

export type HostBackendLeasePhaseV1 = "pre_submission" | "submission_guarded" | "remote_accepted";

export interface HostOperationLeaseRequestV1 {
  readonly operation_record_id: string;
  readonly backend_key_sha256: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly state_id: string;
  readonly attempt: number;
  readonly operation_id: string;
  readonly registration_sha256: string;
  readonly request_sha256: string;
  readonly duration_ms: number;
  readonly queue_inactivity_expires_at_ms: number;
  readonly remote_correlation_sha256?: string;
}

export interface HostOperationActiveLeaseV1 {
  readonly lease: HostOperationLeaseIdentityV1;
  readonly phase: HostBackendLeasePhaseV1;
  readonly expires_at_ms: number;
  readonly remote_correlation_sha256: string | null;
}

export type HostOperationLeaseAcquisitionV1 =
  | { readonly kind: "acquired" | "adopted"; readonly active: HostOperationActiveLeaseV1 }
  | { readonly kind: "waiting" }
  | { readonly kind: "quarantined"; readonly quarantine_id: string };

interface LeaseRow extends Record<string, SQLOutputValue> {
  backend_key_sha256: string;
  state: "free" | "active" | "quarantined";
  active_phase: HostBackendLeasePhaseV1 | null;
  lease_id: string | null;
  lease_epoch: number | null;
  fencing_token_sha256: string | null;
  operation_record_id: string | null;
  project_id: string | null;
  run_id: string | null;
  state_id: string | null;
  attempt: number | null;
  operation_id: string | null;
  registration_sha256: string | null;
  request_sha256: string | null;
  remote_correlation_sha256: string | null;
  expires_at_ms: number | null;
  quarantine_id: string | null;
  disposition_receipt_id: string | null;
  updated_at: string;
}

function text(row: Record<string, SQLOutputValue>, key: string, nullable = false): string | null {
  const value = row[key];
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error(`host lease row '${key}' is not text`);
  return value;
}

function integer(
  row: Record<string, SQLOutputValue>,
  key: string,
  nullable = false
): number | null {
  const value = row[key];
  if (nullable && value === null) return null;
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new Error(`host lease row '${key}' is not an integer`);
  }
  return number;
}

function isSqliteRow(value: unknown): value is Record<string, SQLOutputValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) =>
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "bigint" ||
      item instanceof Uint8Array
  );
}

function parseLeaseRow(value: unknown): LeaseRow {
  if (!isSqliteRow(value)) {
    throw new Error("host backend lease row is absent or malformed");
  }
  const row = value;
  const state = text(row, "state");
  const phase = text(row, "active_phase", true);
  if (state !== "free" && state !== "active" && state !== "quarantined") {
    throw new Error("host backend lease state is invalid");
  }
  if (
    phase !== null &&
    phase !== "pre_submission" &&
    phase !== "submission_guarded" &&
    phase !== "remote_accepted"
  ) {
    throw new Error("host backend lease phase is invalid");
  }
  return {
    backend_key_sha256: text(row, "backend_key_sha256") ?? "",
    state,
    active_phase: phase,
    lease_id: text(row, "lease_id", true),
    lease_epoch: integer(row, "lease_epoch", true),
    fencing_token_sha256: text(row, "fencing_token_sha256", true),
    operation_record_id: text(row, "operation_record_id", true),
    project_id: text(row, "project_id", true),
    run_id: text(row, "run_id", true),
    state_id: text(row, "state_id", true),
    attempt: integer(row, "attempt", true),
    operation_id: text(row, "operation_id", true),
    registration_sha256: text(row, "registration_sha256", true),
    request_sha256: text(row, "request_sha256", true),
    remote_correlation_sha256: text(row, "remote_correlation_sha256", true),
    expires_at_ms: integer(row, "expires_at_ms", true),
    quarantine_id: text(row, "quarantine_id", true),
    disposition_receipt_id: text(row, "disposition_receipt_id", true),
    updated_at: text(row, "updated_at") ?? "",
  };
}

function activeLease(row: LeaseRow): HostOperationActiveLeaseV1 {
  if (
    row.state !== "active" ||
    row.active_phase === null ||
    row.lease_id === null ||
    row.lease_epoch === null ||
    row.fencing_token_sha256 === null ||
    row.expires_at_ms === null
  ) {
    throw new Error("host backend lease active projection is incomplete");
  }
  return {
    lease: {
      schema_version: 1,
      backend_key_sha256: row.backend_key_sha256,
      lease_id: row.lease_id,
      lease_epoch: row.lease_epoch,
      fencing_token_sha256: row.fencing_token_sha256,
    },
    phase: row.active_phase,
    expires_at_ms: row.expires_at_ms,
    remote_correlation_sha256: row.remote_correlation_sha256,
  };
}

function validateRequest(input: HostOperationLeaseRequestV1): void {
  if (!/^hop_[a-f0-9]{64}$/u.test(input.operation_record_id)) {
    throw new Error("host operation record ID is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.backend_key_sha256)) {
    throw new Error("host backend key digest is invalid");
  }
  if (!PROJECT_ID_PATTERN.test(input.project_id))
    throw new Error("host lease project ID is invalid");
  for (const value of [input.registration_sha256, input.request_sha256]) {
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("host lease digest is invalid");
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("host lease attempt is invalid");
  }
  if (!Number.isSafeInteger(input.duration_ms) || input.duration_ms < 2) {
    throw new Error("host lease duration is invalid");
  }
  if (
    !Number.isSafeInteger(input.queue_inactivity_expires_at_ms) ||
    input.queue_inactivity_expires_at_ms < 0
  ) {
    throw new Error("host lease queue deadline is invalid");
  }
}

function sameOwner(row: LeaseRow, input: HostOperationLeaseRequestV1): boolean {
  return (
    row.operation_record_id === input.operation_record_id &&
    row.project_id === input.project_id &&
    row.run_id === input.run_id &&
    row.state_id === input.state_id &&
    row.attempt === input.attempt &&
    row.operation_id === input.operation_id &&
    row.registration_sha256 === input.registration_sha256 &&
    row.request_sha256 === input.request_sha256
  );
}

function dispositionReceiptId(input: {
  readonly operation_record_id: string;
  readonly lease: HostOperationLeaseIdentityV1 | null;
  readonly disposition: HostOperationDispositionV1;
}): string {
  return `hop_disp_${sha256(canonicalJson(input))}`;
}

/** State-root-global FIFO queue, fenced lease, and quarantine authority. */
export class HostOperationLeaseAuthority implements Disposable {
  private readonly store: OwnerSqliteDatabase;

  constructor(stateRoot: string) {
    const state = pennyStatePaths(stateRoot);
    this.store = new OwnerSqliteDatabase({
      directory: state.root,
      databaseName: CATALOG_DATABASE_NAME,
      label: "Penny host-operation lease authority",
      mode: "existing",
      verifyIntegrity: false,
    });
    const version = this.store.db.prepare("PRAGMA user_version").get() as
      | Record<string, SQLOutputValue>
      | undefined;
    if (Number(version?.["user_version"] ?? 0) !== PROJECT_CATALOG_SCHEMA_VERSION) {
      this.store.close();
      throw new Error(
        `host-operation lease authority requires catalog schema ${PROJECT_CATALOG_SCHEMA_VERSION}`
      );
    }
  }

  /** Composite capacity parking uses the same canonical catalog write transaction. This is
   * not release: no terminal disposition is written, and no backend FIFO row is retained. */
  static parkPreSubmissionInTransaction(
    store: OwnerSqliteDatabase,
    value: HostOperationCallRecordV1,
    proof: HostCapacityParkingProofV1
  ): void {
    const journal = validateHostOperationCallRecord(value);
    validateSkillSchema(HostCapacityParkingProofV1Schema, proof, "HostCapacityParkingProofV1");
    const lease = journal.lease;
    if (
      !(store instanceof OwnerSqliteDatabase) ||
      !store.db.isTransaction ||
      lease === null ||
      proof.journal_binding_sha256 !== capacityParkingJournalBinding(journal) ||
      proof.project_id !== journal.project_id ||
      proof.directive_sha256 !== journal.directive_sha256 ||
      proof.operation_request_sha256 !== journal.request_sha256 ||
      proof.backend_queue_expires_ms !== journal.queue_inactivity_expires_at_ms ||
      journal.lifecycle !== "lease_acquired" ||
      journal.remote_correlation_id !== null ||
      journal.fetched !== null ||
      journal.persistence_plan !== null ||
      journal.disposition !== null ||
      canonicalJson(proof.lease) !== canonicalJson(lease) ||
      proof.operation_record_id !== journal.operation_record_id ||
      store.db
        .prepare("SELECT 1 FROM host_backend_dispositions WHERE operation_record_id = ? LIMIT 1")
        .get(journal.operation_record_id) !== undefined
    )
      throw new Error("host capacity parking non-submission proof refused");
    HostOperationLeaseAuthority.freePreSubmissionInTransaction(
      store,
      journal,
      lease,
      proof.parked_at_ms
    );
    const text = canonicalJson(proof);
    store.db
      .prepare(
        `INSERT INTO host_backend_lease_events
      (backend_key_sha256, operation_record_id, event_type, event_jcs, event_sha256, created_at)
      VALUES (?, ?, 'capacity_parked_v1', ?, ?, ?)`
      )
      .run(
        lease.backend_key_sha256,
        journal.operation_record_id,
        text,
        sha256(text),
        new Date(proof.parked_at_ms).toISOString()
      );
  }

  private static freePreSubmissionInTransaction(
    store: OwnerSqliteDatabase,
    journal: HostOperationCallRecordV1,
    lease: HostOperationLeaseIdentityV1,
    nowMs: number
  ): void {
    const changed = store.db
      .prepare(
        `UPDATE host_backend_leases SET
      state = 'free', active_phase = NULL, lease_id = NULL, lease_epoch = NULL,
      fencing_token_sha256 = NULL, operation_record_id = NULL, project_id = NULL,
      run_id = NULL, state_id = NULL, attempt = NULL, operation_id = NULL,
      registration_sha256 = NULL, request_sha256 = NULL, remote_correlation_sha256 = NULL,
      expires_at_ms = NULL, quarantine_id = NULL, disposition_receipt_id = NULL, updated_at = ?
      WHERE backend_key_sha256 = ? AND state = 'active' AND active_phase = 'pre_submission'
        AND lease_id = ? AND lease_epoch = ? AND fencing_token_sha256 = ?
        AND operation_record_id = ? AND project_id = ? AND run_id = ? AND state_id = ?
        AND attempt = ? AND operation_id = ? AND registration_sha256 = ? AND request_sha256 = ?
        AND remote_correlation_sha256 IS NULL AND expires_at_ms > ?`
      )
      .run(
        new Date(nowMs).toISOString(),
        lease.backend_key_sha256,
        lease.lease_id,
        lease.lease_epoch,
        lease.fencing_token_sha256,
        journal.operation_record_id,
        journal.project_id,
        journal.identity.run_id,
        journal.state_id,
        journal.attempt,
        journal.operation_id,
        journal.registration_sha256,
        journal.request_sha256,
        nowMs
      );
    if (Number(changed.changes) !== 1) throw new Error("host capacity parking fence stale");
    store.db
      .prepare("DELETE FROM host_operation_queue WHERE operation_record_id = ?")
      .run(journal.operation_record_id);
  }

  /** Compensation is not a terminal release. The original durable queue/proof remains the
   * authority, and only its exact same-operation, still-live fresh pre-submission fence is freed. */
  static compensateCapacityReacquisitionInTransaction(
    store: OwnerSqliteDatabase,
    journal: HostOperationCallRecordV1,
    fresh: HostOperationLeaseIdentityV1,
    nowMs: number
  ): void {
    if (!(store instanceof OwnerSqliteDatabase) || !store.db.isTransaction)
      throw new Error("host capacity compensation requires owning catalog transaction");
    validateSkillSchema(HostOperationLeaseIdentityV1Schema, fresh, "HostOperationLeaseIdentityV1");
    const stored = HostOperationLeaseAuthority.unadmittedParkingInTransaction(store, journal);
    const proof = stored.parking;
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < stored.core.last_checked_ms ||
      proof === null ||
      fresh.backend_key_sha256 !== stored.core.backend_key_sha256 ||
      canonicalJson(fresh) === canonicalJson(proof.lease) ||
      (canonicalJson(journal.lease) !== canonicalJson(proof.lease) &&
        canonicalJson(journal.lease) !== canonicalJson(fresh)) ||
      (!stored.parked && canonicalJson(stored.core.lease) !== canonicalJson(fresh))
    )
      throw new Error("host capacity compensation exact fresh fence conflict");
    // Reuse the exact owner/fence CAS; do not relax expiry, phase or remote proof checks.
    HostOperationLeaseAuthority.freePreSubmissionInTransaction(store, journal, fresh, nowMs);
    // This event authorizes only journal repair; it never replaces the selected parking proof.
    const text = canonicalJson({ schema_version: 1, parking: proof, lease: fresh });
    store.db
      .prepare(
        `INSERT INTO host_backend_lease_events
      (backend_key_sha256, operation_record_id, event_type, event_jcs, event_sha256, created_at)
      VALUES (?, ?, 'capacity_reacquisition_compensated_v1', ?, ?, ?)`
      )
      .run(
        proof.lease.backend_key_sha256,
        journal.operation_record_id,
        text,
        sha256(text),
        new Date(nowMs).toISOString()
      );
  }

  /** Resolve only the cross-store window after catalog compensation but before journal CAS.
   * No backend mutation is authorized by this event, including if another owner acquired it. */
  static compensatedParkingInTransaction(
    store: OwnerSqliteDatabase,
    journal: HostOperationCallRecordV1
  ): HostCapacityParkingProofV1 | undefined {
    if (!(store instanceof OwnerSqliteDatabase) || !store.db.isTransaction)
      throw new Error("host capacity reconciliation requires owning catalog transaction");
    const stored = HostOperationLeaseAuthority.unadmittedParkingInTransaction(store, journal);
    const proof = stored.parking;
    if (!stored.parked || proof === null)
      throw new Error("host capacity compensated parking proof absent");
    const text = canonicalJson({ schema_version: 1, parking: proof, lease: journal.lease });
    if (
      store.db
        .prepare(
          `SELECT 1 FROM host_backend_lease_events WHERE operation_record_id = ?
      AND backend_key_sha256 = ? AND event_type = 'capacity_reacquisition_compensated_v1'
      AND event_jcs = ? AND event_sha256 = ?`
        )
        .get(journal.operation_record_id, proof.lease.backend_key_sha256, text, sha256(text)) ===
      undefined
    )
      return undefined;
    return proof;
  }

  private static unadmittedParkingInTransaction(
    store: OwnerSqliteDatabase,
    value: HostOperationCallRecordV1
  ): HostCapacityRuntimeRecordV2 {
    const journal = validateHostOperationCallRecord(value);
    const row = store.db
      .prepare(
        `SELECT record_jcs, record_sha256 FROM host_capacity_records
      WHERE operation_record_id = ?`
      )
      .get(journal.operation_record_id);
    if (
      row === undefined ||
      typeof row.record_jcs !== "string" ||
      sha256(row.record_jcs) !== row.record_sha256
    )
      throw new Error("host capacity compensation canonical record absent");
    const raw: unknown = JSON.parse(row.record_jcs);
    const stored = validateCapacityStoredRecord(raw);
    if (
      canonicalJson(stored) !== row.record_jcs ||
      stored.schema_version !== 2 ||
      stored.parking === null ||
      stored.core.state !== "queued" ||
      stored.core.active_started_ms !== null ||
      stored.core.last_milestone_ms !== null ||
      stored.core.milestone !== "none" ||
      stored.core.snapshot !== null ||
      stored.core.cleanup_started_ms !== null ||
      stored.core.disposition_receipt_id !== null ||
      stored.productive_count !== 0 ||
      stored.productive !== null ||
      stored.parking.journal_binding_sha256 !== capacityParkingJournalBinding(journal) ||
      stored.parking.backend_queue_expires_ms !== journal.queue_inactivity_expires_at_ms ||
      stored.parking.project_id !== journal.project_id ||
      stored.parking.directive_sha256 !== journal.directive_sha256 ||
      stored.parking.operation_request_sha256 !== journal.request_sha256 ||
      store.db
        .prepare("SELECT 1 FROM host_backend_dispositions WHERE operation_record_id = ? LIMIT 1")
        .get(journal.operation_record_id) !== undefined
    )
      throw new Error("host capacity compensation requires exact never-admitted parking proof");
    const proofText = canonicalJson(stored.parking);
    if (
      store.db
        .prepare(
          `SELECT 1 FROM host_backend_lease_events WHERE operation_record_id = ?
      AND backend_key_sha256 = ? AND event_type = 'capacity_parked_v1'
      AND event_jcs = ? AND event_sha256 = ?`
        )
        .get(
          journal.operation_record_id,
          stored.core.backend_key_sha256,
          proofText,
          sha256(proofText)
        ) === undefined
    )
      throw new Error("host capacity compensation durable parking proof absent");
    return stored;
  }

  /** Read-only recovery of an already owned fence. Never acquires after cancellation. */
  ownedActive(request: HostOperationLeaseRequestV1): HostOperationActiveLeaseV1 | undefined {
    validateRequest(request);
    const row = this.leaseRow(request.backend_key_sha256);
    return row?.state === "active" && sameOwner(row, request) ? activeLease(row) : undefined;
  }

  /** A parked cancellation disposes only the proven never-submitted old fence; it cannot
   * free another operation's current backend lease or convert a terminal release to parking. */
  settleParked(
    request: HostOperationLeaseRequestV1,
    lease: HostOperationLeaseIdentityV1,
    disposition: HostOperationDispositionV1,
    nowMs = Date.now()
  ): HostOperationDispositionReceiptV1 {
    validateRequest(request);
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare(
          "SELECT record_jcs, record_sha256 FROM host_capacity_records WHERE operation_record_id = ?"
        )
        .get(request.operation_record_id);
      if (row === undefined) throw new Error("host parked capacity proof absent");
      const text = String(row.record_jcs);
      if (sha256(text) !== row.record_sha256)
        throw new Error("host parked capacity proof digest conflict");
      const raw: unknown = JSON.parse(text);
      const record = validateCapacityStoredRecord(raw);
      const core = capacityCore(record);
      if (
        hostOperationRecordId({
          project_id: request.project_id,
          run_id: request.run_id,
          state_id: request.state_id,
          attempt: request.attempt,
          operation_id: request.operation_id,
          registration_sha256: request.registration_sha256,
          request_sha256: request.request_sha256,
        }) !== request.operation_record_id ||
        request.backend_key_sha256 !== core.backend_key_sha256 ||
        canonicalJson(record) !== text ||
        record.schema_version !== 2 ||
        !record.parked ||
        record.parking === null ||
        !["queued", "expired"].includes(core.state) ||
        core.request.project_id !== request.project_id ||
        record.parking.backend_queue_expires_ms !== request.queue_inactivity_expires_at_ms ||
        core.operation_request_sha256 !== request.request_sha256 ||
        canonicalJson(core.lease) !== canonicalJson(lease) ||
        disposition.lease_disposition !== "released" ||
        disposition.remote_disposition !== "proven_not_accepted" ||
        this.ownedActive(request) !== undefined
      )
        throw new Error("host parked settlement exact proof conflict");
      const proofText = canonicalJson(record.parking);
      if (
        this.store.db
          .prepare(
            `SELECT 1 FROM host_backend_lease_events WHERE operation_record_id = ?
          AND backend_key_sha256 = ? AND event_type = 'capacity_parked_v1' AND event_jcs = ? AND event_sha256 = ?`
          )
          .get(
            request.operation_record_id,
            request.backend_key_sha256,
            proofText,
            sha256(proofText)
          ) === undefined
      )
        throw new Error("host parked settlement durable proof absent");
      this.deleteQueue(request.operation_record_id);
      return this.insertDisposition(
        request.operation_record_id,
        request.backend_key_sha256,
        lease,
        disposition,
        null,
        nowMs
      );
    });
  }

  tryAcquire(
    input: HostOperationLeaseRequestV1,
    nowMs = Date.now()
  ): HostOperationLeaseAcquisitionV1 {
    validateRequest(input);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("host lease clock is invalid");
    return this.store.transaction(() => {
      let row = this.leaseRow(input.backend_key_sha256);
      if (row?.state === "active" && sameOwner(row, input)) {
        const expiresAt = row.expires_at_ms;
        if (expiresAt === null) throw new Error("active host lease lacks expiry");
        if (expiresAt > nowMs) {
          this.deleteQueue(input.operation_record_id);
          return { kind: "adopted", active: activeLease(row) };
        }
        if (row.active_phase === "pre_submission") {
          return {
            kind: "adopted",
            active: this.activate(input, row.lease_epoch ?? 0, nowMs),
          };
        }
        if (
          input.remote_correlation_sha256 !== undefined &&
          (row.active_phase === "submission_guarded" || row.active_phase === "remote_accepted") &&
          (row.remote_correlation_sha256 === null ||
            row.remote_correlation_sha256 === input.remote_correlation_sha256)
        ) {
          return {
            kind: "adopted",
            active: this.activate(
              input,
              row.lease_epoch ?? 0,
              nowMs,
              "remote_accepted",
              input.remote_correlation_sha256
            ),
          };
        }
        const quarantineId = this.quarantineExpired(row, nowMs);
        return { kind: "quarantined", quarantine_id: quarantineId };
      }
      if (row?.state === "quarantined" && sameOwner(row, input)) {
        if (row.quarantine_id === null) throw new Error("quarantined host lease lacks its ID");
        return { kind: "quarantined", quarantine_id: row.quarantine_id };
      }
      this.enqueueExact(input, nowMs);
      if (row === undefined) {
        this.insertFreeLease(input.backend_key_sha256, nowMs);
        row = this.requiredLeaseRow(input.backend_key_sha256);
      }
      if (row.state === "quarantined") {
        if (row.quarantine_id === null) throw new Error("quarantined host lease lacks its ID");
        return { kind: "quarantined", quarantine_id: row.quarantine_id };
      }
      if (row.state === "active") {
        const expiresAt = row.expires_at_ms;
        if (expiresAt === null) throw new Error("active host lease lacks expiry");
        if (sameOwner(row, input) && expiresAt > nowMs) {
          this.deleteQueue(input.operation_record_id);
          return { kind: "adopted", active: activeLease(row) };
        }
        if (expiresAt > nowMs) return { kind: "waiting" };
        if (row.active_phase === "pre_submission") {
          if (!sameOwner(row, input)) this.recordStalePreSubmissionRelease(row, nowMs);
          const adopted = this.activate(input, row.lease_epoch ?? 0, nowMs);
          return {
            kind: sameOwner(row, input) ? "adopted" : "acquired",
            active: adopted,
          };
        }
        if (
          sameOwner(row, input) &&
          input.remote_correlation_sha256 !== undefined &&
          (row.active_phase === "submission_guarded" || row.active_phase === "remote_accepted") &&
          (row.remote_correlation_sha256 === null ||
            row.remote_correlation_sha256 === input.remote_correlation_sha256)
        ) {
          const adopted = this.activate(
            input,
            row.lease_epoch ?? 0,
            nowMs,
            "remote_accepted",
            input.remote_correlation_sha256
          );
          return { kind: "adopted", active: adopted };
        }
        const quarantineId = this.quarantineExpired(row, nowMs);
        return { kind: "quarantined", quarantine_id: quarantineId };
      }
      const first = this.store.db
        .prepare(
          `SELECT operation_record_id FROM host_operation_queue
           WHERE backend_key_sha256 = ? ORDER BY queued_at_ms, operation_record_id LIMIT 1`
        )
        .get(input.backend_key_sha256) as Record<string, SQLOutputValue> | undefined;
      if (String(first?.["operation_record_id"] ?? "") !== input.operation_record_id) {
        return { kind: "waiting" };
      }
      return { kind: "acquired", active: this.activate(input, 0, nowMs) };
    });
  }

  renew(
    request: HostOperationLeaseRequestV1,
    lease: HostOperationLeaseIdentityV1,
    nowMs = Date.now()
  ): HostOperationActiveLeaseV1 {
    validateRequest(request);
    return this.store.transaction(() => {
      const row = this.assertExactActive(request, lease);
      if ((row.expires_at_ms ?? -1) <= nowMs) {
        throw new Error("host backend lease expired before renewal");
      }
      const expiresAt = nowMs + request.duration_ms;
      const updated = this.store.db
        .prepare(
          `UPDATE host_backend_leases SET expires_at_ms = ?, updated_at = ?
           WHERE backend_key_sha256 = ? AND state = 'active' AND lease_id = ?
             AND lease_epoch = ? AND fencing_token_sha256 = ?`
        )
        .run(
          expiresAt,
          new Date(nowMs).toISOString(),
          lease.backend_key_sha256,
          lease.lease_id,
          lease.lease_epoch,
          lease.fencing_token_sha256
        );
      if (Number(updated.changes) !== 1)
        throw new Error("host backend lease renewal lost its fence");
      return activeLease(this.requiredLeaseRow(request.backend_key_sha256));
    });
  }

  guardSubmission(
    request: HostOperationLeaseRequestV1,
    lease: HostOperationLeaseIdentityV1,
    nowMs = Date.now()
  ): HostOperationActiveLeaseV1 {
    return this.changePhase(request, lease, "pre_submission", "submission_guarded", null, nowMs);
  }

  markRemoteAccepted(
    request: HostOperationLeaseRequestV1,
    lease: HostOperationLeaseIdentityV1,
    remoteCorrelationSha256: string,
    nowMs = Date.now()
  ): HostOperationActiveLeaseV1 {
    if (!/^[a-f0-9]{64}$/u.test(remoteCorrelationSha256)) {
      throw new Error("remote correlation digest is invalid");
    }
    return this.changePhase(
      request,
      lease,
      "submission_guarded",
      "remote_accepted",
      remoteCorrelationSha256,
      nowMs
    );
  }

  reconcileRemoteAccepted(
    request: HostOperationLeaseRequestV1,
    lease: HostOperationLeaseIdentityV1,
    remoteCorrelationSha256: string,
    nowMs = Date.now()
  ): HostOperationActiveLeaseV1 {
    if (!/^[a-f0-9]{64}$/u.test(remoteCorrelationSha256)) {
      throw new Error("remote correlation digest is invalid");
    }
    return this.store.transaction(() => {
      const row = this.assertExactActive(request, lease);
      if (row.active_phase !== "submission_guarded" && row.active_phase !== "remote_accepted") {
        throw new Error("host backend lease cannot reconcile acceptance from its current phase");
      }
      if (
        row.remote_correlation_sha256 !== null &&
        row.remote_correlation_sha256 !== remoteCorrelationSha256
      ) {
        throw new Error("host backend lease correlation proof conflicts");
      }
      return this.activate(
        { ...request, remote_correlation_sha256: remoteCorrelationSha256 },
        row.lease_epoch ?? 0,
        nowMs,
        "remote_accepted",
        remoteCorrelationSha256
      );
    });
  }

  release(
    request: HostOperationLeaseRequestV1,
    lease: HostOperationLeaseIdentityV1,
    disposition: HostOperationDispositionV1,
    remoteCorrelationSha256: string | null,
    nowMs = Date.now()
  ): HostOperationDispositionReceiptV1 {
    if (disposition.lease_disposition !== "released") {
      throw new Error("released host lease requires a released disposition");
    }
    return this.store.transaction(() => {
      const row = this.assertExactActive(request, lease);
      if (
        (row.active_phase === "remote_accepted" &&
          disposition.remote_disposition !== "proven_terminal") ||
        (row.active_phase === "submission_guarded" &&
          disposition.remote_disposition !== "proven_not_accepted" &&
          disposition.remote_disposition !== "proven_terminal") ||
        (row.active_phase === "pre_submission" &&
          disposition.remote_disposition !== "none" &&
          disposition.remote_disposition !== "proven_not_accepted") ||
        row.remote_correlation_sha256 !== remoteCorrelationSha256
      ) {
        throw new Error(
          "host backend lease cannot be released without exact remote disposition proof"
        );
      }
      const receipt = this.insertDisposition(
        request.operation_record_id,
        request.backend_key_sha256,
        lease,
        disposition,
        remoteCorrelationSha256,
        nowMs
      );
      const changed = this.store.db
        .prepare(
          `UPDATE host_backend_leases SET
             state = 'free', active_phase = NULL, lease_id = NULL, lease_epoch = NULL,
             fencing_token_sha256 = NULL, operation_record_id = NULL, project_id = NULL,
             run_id = NULL, state_id = NULL, attempt = NULL, operation_id = NULL,
             registration_sha256 = NULL, request_sha256 = NULL,
             remote_correlation_sha256 = NULL, expires_at_ms = NULL,
             quarantine_id = NULL, disposition_receipt_id = ?, updated_at = ?
           WHERE backend_key_sha256 = ? AND state = 'active' AND lease_id = ?
             AND lease_epoch = ? AND fencing_token_sha256 = ?`
        )
        .run(
          receipt.receipt_id,
          new Date(nowMs).toISOString(),
          lease.backend_key_sha256,
          lease.lease_id,
          lease.lease_epoch,
          lease.fencing_token_sha256
        );
      if (Number(changed.changes) !== 1)
        throw new Error("host backend lease release lost its fence");
      return receipt;
    });
  }

  quarantine(
    request: HostOperationLeaseRequestV1,
    lease: HostOperationLeaseIdentityV1,
    disposition: HostOperationDispositionV1,
    remoteCorrelationSha256: string | null,
    nowMs = Date.now()
  ): HostOperationDispositionReceiptV1 {
    if (disposition.lease_disposition !== "quarantined") {
      throw new Error("quarantined host lease requires a quarantined disposition");
    }
    return this.store.transaction(() => {
      const row = this.assertExactActive(request, lease);
      if (
        row.active_phase === "pre_submission" ||
        (row.active_phase === "remote_accepted" &&
          disposition.remote_disposition !== "may_continue") ||
        (row.active_phase === "submission_guarded" &&
          disposition.remote_disposition !== "unknown_acceptance" &&
          disposition.remote_disposition !== "may_continue") ||
        row.remote_correlation_sha256 !== remoteCorrelationSha256
      ) {
        throw new Error("host backend lease quarantine disposition does not match remote phase");
      }
      const receipt = this.insertDisposition(
        request.operation_record_id,
        request.backend_key_sha256,
        lease,
        disposition,
        remoteCorrelationSha256,
        nowMs
      );
      const quarantineId = `hop_quarantine_${sha256(
        canonicalJson({ receipt_id: receipt.receipt_id, lease })
      )}`;
      const changed = this.store.db
        .prepare(
          `UPDATE host_backend_leases SET state = 'quarantined', quarantine_id = ?,
             disposition_receipt_id = ?, expires_at_ms = NULL, updated_at = ?
           WHERE backend_key_sha256 = ? AND state = 'active' AND lease_id = ?
             AND lease_epoch = ? AND fencing_token_sha256 = ?`
        )
        .run(
          quarantineId,
          receipt.receipt_id,
          new Date(nowMs).toISOString(),
          lease.backend_key_sha256,
          lease.lease_id,
          lease.lease_epoch,
          lease.fencing_token_sha256
        );
      if (Number(changed.changes) !== 1) {
        throw new Error("host backend lease quarantine lost its fence");
      }
      return receipt;
    });
  }

  settleWithoutLease(
    request: HostOperationLeaseRequestV1,
    disposition: HostOperationDispositionV1,
    nowMs = Date.now()
  ): HostOperationDispositionReceiptV1 {
    if (disposition.lease_disposition !== "released" || disposition.remote_disposition !== "none") {
      throw new Error("no-lease settlement must prove that no remote effect occurred");
    }
    return this.store.transaction(() =>
      this.insertDisposition(
        request.operation_record_id,
        request.backend_key_sha256,
        null,
        disposition,
        null,
        nowMs
      )
    );
  }

  cancelQueue(operationRecordId: string): void {
    this.store.transaction(() => this.deleteQueue(operationRecordId));
  }

  resetQuarantine(input: {
    readonly backend_key_sha256: string;
    readonly quarantine_id: string;
    readonly disposition: "queue_inspected_empty" | "queue_drained" | "specific_remote_terminal";
    readonly evidence_sha256: string;
    /** Required exact FIFO snapshot when disposition is queue_drained. */
    readonly queue_operation_record_ids?: readonly string[];
    readonly now_ms?: number;
  }): HostOperationQuarantineResetV1 {
    if (!/^[a-f0-9]{64}$/u.test(input.backend_key_sha256)) {
      throw new Error("host quarantine backend key digest is invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.evidence_sha256)) {
      throw new Error("host quarantine reset evidence digest is invalid");
    }
    const nowMs = input.now_ms ?? Date.now();
    return this.store.transaction(() => {
      const row = this.requiredLeaseRow(input.backend_key_sha256);
      if (row.state !== "quarantined" || row.quarantine_id !== input.quarantine_id) {
        throw new Error("host quarantine reset does not match the exact poisoned lease");
      }
      const queueRows = this.store.db
        .prepare(
          `SELECT operation_record_id FROM host_operation_queue
           WHERE backend_key_sha256 = ? ORDER BY queued_at_ms, operation_record_id`
        )
        .all(input.backend_key_sha256);
      const queueOperationRecordIds = queueRows.map((queueRow) => {
        if (!isSqliteRow(queueRow)) throw new Error("host quarantine queue row is malformed");
        return text(queueRow, "operation_record_id") ?? "";
      });
      if (input.disposition === "queue_inspected_empty" && queueOperationRecordIds.length !== 0) {
        throw new Error("host quarantine reset found queued operations");
      }
      if (
        input.disposition === "queue_drained" &&
        canonicalJson(input.queue_operation_record_ids ?? []) !==
          canonicalJson(queueOperationRecordIds)
      ) {
        throw new Error("host quarantine reset queue snapshot diverges");
      }
      if (input.disposition === "queue_drained") {
        this.store.db
          .prepare("DELETE FROM host_operation_queue WHERE backend_key_sha256 = ?")
          .run(input.backend_key_sha256);
      }
      const queueSnapshotSha256 = sha256(canonicalJson(queueOperationRecordIds));
      const reset: HostOperationQuarantineResetV1 = {
        schema_version: 1,
        reset_receipt_id: `hop_reset_${sha256(
          canonicalJson({
            backend_key_sha256: input.backend_key_sha256,
            quarantine_id: input.quarantine_id,
            disposition: input.disposition,
            evidence_sha256: input.evidence_sha256,
            queue_snapshot_sha256: queueSnapshotSha256,
          })
        )}`,
        backend_key_sha256: input.backend_key_sha256,
        quarantine_id: input.quarantine_id,
        disposition: input.disposition,
        evidence_sha256: input.evidence_sha256,
        queue_snapshot_sha256: queueSnapshotSha256,
        reset_at: new Date(nowMs).toISOString(),
      };
      this.store.db
        .prepare(
          `INSERT INTO host_backend_quarantine_resets(
             reset_receipt_id, backend_key_sha256, quarantine_id, disposition,
             evidence_sha256, reset_jcs, reset_sha256, reset_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          reset.reset_receipt_id,
          reset.backend_key_sha256,
          reset.quarantine_id,
          reset.disposition,
          reset.evidence_sha256,
          canonicalJson(reset),
          sha256(canonicalJson(reset)),
          reset.reset_at
        );
      const changed = this.store.db
        .prepare(
          `UPDATE host_backend_leases SET
             state = 'free', active_phase = NULL, lease_id = NULL, lease_epoch = NULL,
             fencing_token_sha256 = NULL, operation_record_id = NULL, project_id = NULL,
             run_id = NULL, state_id = NULL, attempt = NULL, operation_id = NULL,
             registration_sha256 = NULL, request_sha256 = NULL,
             remote_correlation_sha256 = NULL, expires_at_ms = NULL,
             quarantine_id = NULL, updated_at = ?
           WHERE backend_key_sha256 = ? AND state = 'quarantined' AND quarantine_id = ?`
        )
        .run(reset.reset_at, input.backend_key_sha256, input.quarantine_id);
      if (Number(changed.changes) !== 1) throw new Error("host quarantine reset lost its CAS");
      return reset;
    });
  }

  dispositionForOperation(
    operationRecordId: string
  ): HostOperationDispositionReceiptV1 | undefined {
    this.store.assertCustody();
    const row = this.store.db
      .prepare(
        `SELECT receipt_jcs, receipt_sha256 FROM host_backend_dispositions
         WHERE operation_record_id = ? ORDER BY created_at DESC, receipt_id DESC LIMIT 1`
      )
      .get(operationRecordId) as Record<string, SQLOutputValue> | undefined;
    if (row === undefined) return undefined;
    const receiptJcs = String(row["receipt_jcs"] ?? "");
    if (sha256(receiptJcs) !== String(row["receipt_sha256"] ?? "")) {
      throw new Error("host lease disposition receipt digest diverges");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(receiptJcs);
    } catch {
      throw new Error("host lease disposition receipt is not JSON");
    }
    const receipt = validateHostOperationDispositionReceipt(parsed);
    if (receipt.operation_record_id !== operationRecordId) {
      throw new Error("host lease disposition receipt operation identity diverges");
    }
    return receipt;
  }

  inspect(
    backendKeySha256: string
  ):
    | { readonly state: "absent" | "free" }
    | { readonly state: "active"; readonly active: HostOperationActiveLeaseV1 }
    | { readonly state: "quarantined"; readonly quarantine_id: string } {
    const row = this.leaseRow(backendKeySha256);
    if (row === undefined) return { state: "absent" };
    if (row.state === "free") return { state: "free" };
    if (row.state === "active") return { state: "active", active: activeLease(row) };
    if (row.quarantine_id === null) throw new Error("quarantined host lease lacks its ID");
    return { state: "quarantined", quarantine_id: row.quarantine_id };
  }

  close(): void {
    this.store.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private enqueueExact(input: HostOperationLeaseRequestV1, nowMs: number): void {
    const existing = this.store.db
      .prepare("SELECT * FROM host_operation_queue WHERE operation_record_id = ?")
      .get(input.operation_record_id) as Record<string, SQLOutputValue> | undefined;
    if (existing !== undefined) {
      const expected = canonicalJson({
        operation_record_id: input.operation_record_id,
        backend_key_sha256: input.backend_key_sha256,
        project_id: input.project_id,
        run_id: input.run_id,
        state_id: input.state_id,
        attempt: input.attempt,
        operation_id: input.operation_id,
        registration_sha256: input.registration_sha256,
        request_sha256: input.request_sha256,
        queue_inactivity_expires_at_ms: input.queue_inactivity_expires_at_ms,
      });
      const actual = canonicalJson({
        operation_record_id: text(existing, "operation_record_id"),
        backend_key_sha256: text(existing, "backend_key_sha256"),
        project_id: text(existing, "project_id"),
        run_id: text(existing, "run_id"),
        state_id: text(existing, "state_id"),
        attempt: integer(existing, "attempt"),
        operation_id: text(existing, "operation_id"),
        registration_sha256: text(existing, "registration_sha256"),
        request_sha256: text(existing, "request_sha256"),
        // Preserve the catalog-v3 storage contract. A runtime field rename
        // must not require an unversioned rewrite of the global catalog.
        queue_inactivity_expires_at_ms: integer(existing, "queue_deadline_at_ms"),
      });
      if (actual !== expected) throw new Error("host operation queue identity conflicts");
      return;
    }
    this.store.db
      .prepare(
        `INSERT INTO host_operation_queue(
           operation_record_id, backend_key_sha256, project_id, run_id, state_id,
           attempt, operation_id, registration_sha256, request_sha256,
           queued_at_ms, queue_deadline_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.operation_record_id,
        input.backend_key_sha256,
        input.project_id,
        input.run_id,
        input.state_id,
        input.attempt,
        input.operation_id,
        input.registration_sha256,
        input.request_sha256,
        nowMs,
        input.queue_inactivity_expires_at_ms
      );
  }

  private insertFreeLease(backendKeySha256: string, nowMs: number): void {
    this.store.db
      .prepare(
        `INSERT INTO host_backend_leases(
           backend_key_sha256, state, updated_at
         ) VALUES (?, 'free', ?)`
      )
      .run(backendKeySha256, new Date(nowMs).toISOString());
  }

  private activate(
    input: HostOperationLeaseRequestV1,
    previousEpoch: number,
    nowMs: number,
    phase: HostBackendLeasePhaseV1 = "pre_submission",
    remoteCorrelationSha256: string | null = null
  ): HostOperationActiveLeaseV1 {
    const epoch = previousEpoch + 1;
    const leaseId = `hop_lease_${randomUUID()}`;
    const token = sha256(randomUUID());
    const expiresAt = nowMs + input.duration_ms;
    this.store.db
      .prepare(
        `UPDATE host_backend_leases SET
           state = 'active', active_phase = ?, lease_id = ?, lease_epoch = ?,
           fencing_token_sha256 = ?, operation_record_id = ?, project_id = ?, run_id = ?,
           state_id = ?, attempt = ?, operation_id = ?, registration_sha256 = ?,
           request_sha256 = ?, remote_correlation_sha256 = ?, expires_at_ms = ?,
           quarantine_id = NULL, disposition_receipt_id = NULL, updated_at = ?
         WHERE backend_key_sha256 = ?`
      )
      .run(
        phase,
        leaseId,
        epoch,
        token,
        input.operation_record_id,
        input.project_id,
        input.run_id,
        input.state_id,
        input.attempt,
        input.operation_id,
        input.registration_sha256,
        input.request_sha256,
        remoteCorrelationSha256,
        expiresAt,
        new Date(nowMs).toISOString(),
        input.backend_key_sha256
      );
    this.deleteQueue(input.operation_record_id);
    return activeLease(this.requiredLeaseRow(input.backend_key_sha256));
  }

  private changePhase(
    request: HostOperationLeaseRequestV1,
    lease: HostOperationLeaseIdentityV1,
    from: HostBackendLeasePhaseV1,
    to: HostBackendLeasePhaseV1,
    correlationSha256: string | null,
    nowMs: number
  ): HostOperationActiveLeaseV1 {
    validateRequest(request);
    return this.store.transaction(() => {
      const row = this.assertExactActive(request, lease);
      if (row.active_phase !== from) {
        throw new Error(`host backend lease expected phase '${from}', found '${row.active_phase}'`);
      }
      if ((row.expires_at_ms ?? -1) <= nowMs) {
        throw new Error("host backend lease expired before its fenced transition");
      }
      const changed = this.store.db
        .prepare(
          `UPDATE host_backend_leases SET active_phase = ?, remote_correlation_sha256 = ?, updated_at = ?
           WHERE backend_key_sha256 = ? AND state = 'active' AND active_phase = ?
             AND lease_id = ? AND lease_epoch = ? AND fencing_token_sha256 = ?
             AND operation_record_id = ? AND project_id = ? AND run_id = ? AND state_id = ?
             AND attempt = ? AND operation_id = ? AND registration_sha256 = ? AND request_sha256 = ?`
        )
        .run(
          to,
          correlationSha256,
          new Date(nowMs).toISOString(),
          lease.backend_key_sha256,
          from,
          lease.lease_id,
          lease.lease_epoch,
          lease.fencing_token_sha256,
          request.operation_record_id,
          request.project_id,
          request.run_id,
          request.state_id,
          request.attempt,
          request.operation_id,
          request.registration_sha256,
          request.request_sha256
        );
      if (Number(changed.changes) !== 1) throw new Error("host backend phase CAS lost its fence");
      return activeLease(this.requiredLeaseRow(request.backend_key_sha256));
    });
  }

  private assertExactActive(
    request: HostOperationLeaseRequestV1,
    lease: HostOperationLeaseIdentityV1
  ): LeaseRow {
    const row = this.requiredLeaseRow(request.backend_key_sha256);
    if (
      row.state !== "active" ||
      !sameOwner(row, request) ||
      row.lease_id !== lease.lease_id ||
      row.lease_epoch !== lease.lease_epoch ||
      row.fencing_token_sha256 !== lease.fencing_token_sha256 ||
      row.backend_key_sha256 !== lease.backend_key_sha256
    ) {
      throw new Error("host backend lease fence or owner identity is stale");
    }
    return row;
  }

  private recordStalePreSubmissionRelease(row: LeaseRow, nowMs: number): void {
    if (
      row.operation_record_id === null ||
      row.lease_id === null ||
      row.lease_epoch === null ||
      row.fencing_token_sha256 === null
    ) {
      throw new Error("stale pre-submission lease is incomplete");
    }
    const lease: HostOperationLeaseIdentityV1 = {
      schema_version: 1,
      backend_key_sha256: row.backend_key_sha256,
      lease_id: row.lease_id,
      lease_epoch: row.lease_epoch,
      fencing_token_sha256: row.fencing_token_sha256,
    };
    this.insertDisposition(
      row.operation_record_id,
      row.backend_key_sha256,
      lease,
      {
        outcome: "failed",
        remote_disposition: "proven_not_accepted",
        lease_disposition: "released",
        retryable: true,
        reason_code: "stale_pre_submission_lease",
      },
      null,
      nowMs
    );
  }

  private quarantineExpired(row: LeaseRow, nowMs: number): string {
    if (
      row.operation_record_id === null ||
      row.lease_id === null ||
      row.lease_epoch === null ||
      row.fencing_token_sha256 === null
    ) {
      throw new Error("ambiguous stale host lease is incomplete");
    }
    const lease: HostOperationLeaseIdentityV1 = {
      schema_version: 1,
      backend_key_sha256: row.backend_key_sha256,
      lease_id: row.lease_id,
      lease_epoch: row.lease_epoch,
      fencing_token_sha256: row.fencing_token_sha256,
    };
    const receipt = this.insertDisposition(
      row.operation_record_id,
      row.backend_key_sha256,
      lease,
      {
        outcome: "remote_unknown",
        remote_disposition:
          row.active_phase === "remote_accepted" ? "may_continue" : "unknown_acceptance",
        lease_disposition: "quarantined",
        retryable: false,
        reason_code: "stale_ambiguous_acceptance",
      },
      row.remote_correlation_sha256,
      nowMs
    );
    const quarantineId = `hop_quarantine_${sha256(canonicalJson({ receipt, lease }))}`;
    this.store.db
      .prepare(
        `UPDATE host_backend_leases SET state = 'quarantined', expires_at_ms = NULL,
           quarantine_id = ?, disposition_receipt_id = ?, updated_at = ?
         WHERE backend_key_sha256 = ?`
      )
      .run(quarantineId, receipt.receipt_id, new Date(nowMs).toISOString(), row.backend_key_sha256);
    return quarantineId;
  }

  private insertDisposition(
    operationRecordId: string,
    backendKeySha256: string,
    lease: HostOperationLeaseIdentityV1 | null,
    disposition: HostOperationDispositionV1,
    remoteCorrelationSha256: string | null,
    nowMs: number
  ): HostOperationDispositionReceiptV1 {
    const receipt: HostOperationDispositionReceiptV1 = {
      schema_version: 1,
      receipt_id: dispositionReceiptId({
        operation_record_id: operationRecordId,
        lease,
        disposition,
      }),
      operation_record_id: operationRecordId,
      backend_key_sha256: backendKeySha256,
      lease,
      disposition,
      remote_correlation_sha256: remoteCorrelationSha256,
      created_at: new Date(nowMs).toISOString(),
    };
    const existing = this.store.db
      .prepare("SELECT receipt_jcs FROM host_backend_dispositions WHERE receipt_id = ?")
      .get(receipt.receipt_id) as Record<string, SQLOutputValue> | undefined;
    if (existing !== undefined) {
      if (String(existing["receipt_jcs"]) !== canonicalJson(receipt)) {
        throw new Error("host lease disposition receipt identity conflicts");
      }
      return receipt;
    }
    this.store.db
      .prepare(
        `INSERT INTO host_backend_dispositions(
           receipt_id, operation_record_id, backend_key_sha256, lease_id, lease_epoch,
           disposition_jcs, receipt_jcs, receipt_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        receipt.receipt_id,
        operationRecordId,
        backendKeySha256,
        lease?.lease_id ?? null,
        lease?.lease_epoch ?? null,
        canonicalJson(disposition),
        canonicalJson(receipt),
        sha256(canonicalJson(receipt)),
        receipt.created_at
      );
    return receipt;
  }

  private leaseRow(backendKeySha256: string): LeaseRow | undefined {
    this.store.assertCustody();
    const row = this.store.db
      .prepare("SELECT * FROM host_backend_leases WHERE backend_key_sha256 = ?")
      .get(backendKeySha256);
    return row === undefined ? undefined : parseLeaseRow(row);
  }

  private requiredLeaseRow(backendKeySha256: string): LeaseRow {
    const row = this.leaseRow(backendKeySha256);
    if (row === undefined) throw new Error("host backend lease row is absent");
    return row;
  }

  private deleteQueue(operationRecordId: string): void {
    this.store.db
      .prepare("DELETE FROM host_operation_queue WHERE operation_record_id = ?")
      .run(operationRecordId);
  }
}
