import { canonicalJson } from "../canonical-json.js";
import type { InvokeHostOperationDirectiveV1 } from "../contracts.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
  type HostCapacityMeasurementSourceV1,
  type HostCapacityProductiveSourceV1,
} from "./capacity-authority.js";
import {
  validateCapacityRequest,
  type HostCapacityRecordV1,
  type HostCapacityRequestV1,
} from "./capacity-contracts.js";
import type { HostCapacityParkingProofV1 } from "./capacity-runtime-contracts.js";
import type {
  HostOperationDeclarationV1,
  HostOperationCallRecordV1,
  HostOperationDispositionReceiptV1,
  HostOperationLeaseIdentityV1,
} from "./contracts.js";

/** Trusted host selection from immutable operands, not an adapter/request permission callback.
 * Must return the same exact demand on every use; missing mappings have no legacy fallback. */
export interface HostCapacityDemandSourceV1 {
  requestFor(input: {
    readonly project_id: string;
    readonly operation_record_id: string;
    readonly directive: InvokeHostOperationDirectiveV1;
    readonly request_bytes: Uint8Array;
  }): HostCapacityRequestV1;
}

/** Service composition is read-only. Policy must already have been explicitly installed. */
export interface HostOperationCapacityRuntimeOptions {
  readonly policy: unknown;
  readonly demands: HostCapacityDemandSourceV1;
  readonly measurements: HostCapacityMeasurementSourceV1;
  readonly productive?: HostCapacityProductiveSourceV1;
  readonly now?: () => number;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Host-only concrete binding. It cannot grant effects, install policy, or invent final readings.
 * Runtime V2 opts into proof-bound parking and durable host-selected productive evidence. */
export class HostOperationCapacityRuntimeBinding {
  constructor(
    private readonly authority: HostOperationCapacityAuthority,
    private readonly project: HostCapacityProjectAuthority,
    private readonly demands: HostCapacityDemandSourceV1
  ) {
    if (
      !(authority instanceof HostOperationCapacityAuthority) ||
      !(project instanceof HostCapacityProjectAuthority)
    )
      throw new Error("capacity runtime requires concrete owners");
    project.measurements.bind?.(authority);
  }

  private selection(journal: HostOperationCallRecordV1): HostCapacityRequestV1 {
    const exact = this.project.read(journal.operation_record_id);
    if (!same(exact, journal)) throw new Error("capacity runtime journal is not current");
    const request = validateCapacityRequest(
      this.demands.requestFor({
        project_id: exact.project_id,
        operation_record_id: exact.operation_record_id,
        directive: structuredClone(exact.directive),
        request_bytes: this.project.requestBytes(exact.operation_record_id),
      })
    );
    if (
      request.project_id !== exact.project_id ||
      request.operation_record_id !== exact.operation_record_id
    )
      throw new Error("capacity runtime selection identity conflict");
    return this.authority.validateSelection(request);
  }

  /** Selection is re-derived even on consumed/terminal/cache paths. Only an initial pre-submit
   * journal may lack a reservation. A refused admission is replayable only with exact proof. */
  check(journal: HostOperationCallRecordV1): HostCapacityRecordV1 | undefined {
    this.selection(journal);
    const record = this.authority.inspect(journal.operation_record_id);
    if (
      record === undefined &&
      journal.lifecycle !== "prepared" &&
      journal.lifecycle !== "lease_acquired" &&
      !this.unadmittedRefusal(journal)
    )
      throw new Error("capacity required reservation absent");
    return record;
  }

  private unadmittedRefusal(journal: HostOperationCallRecordV1): boolean {
    return (
      ["terminal", "settled", "consumed"].includes(journal.lifecycle) &&
      journal.remote_correlation_id === null &&
      journal.fetched === null &&
      journal.persistence_plan === null &&
      journal.disposition?.lease_disposition === "released" &&
      (journal.lease === null ||
        (journal.disposition.reason_code === "capacity_unavailable" &&
          journal.disposition.remote_disposition === "proven_not_accepted"))
    );
  }

  reserve(journal: HostOperationCallRecordV1): HostCapacityRecordV1 {
    const request = this.selection(journal);
    const existing = this.authority.inspect(journal.operation_record_id);
    return existing === undefined
      ? this.authority.reserveRuntime(request)
      : this.reconcile(journal);
  }

  reconcile(journal: HostOperationCallRecordV1): HostCapacityRecordV1 {
    const record = this.required(journal);
    if (this.isParked(journal)) return record;
    if (same(record.lease, journal.lease)) return record;
    return this.authority.adoptFence(journal.operation_record_id, record.revision);
  }

  isParked(journal: HostOperationCallRecordV1): boolean {
    return this.authority.runtimeRecord(journal.operation_record_id)?.parked === true;
  }
  queueDeadline(journal: HostOperationCallRecordV1): number {
    const record = this.required(journal);
    return Math.min(record.queue_expires_ms, journal.queue_inactivity_expires_at_ms);
  }
  park(journal: HostOperationCallRecordV1): void {
    const record = this.required(journal);
    this.authority.park(journal.operation_record_id, record.revision);
  }
  readyToReacquire(journal: HostOperationCallRecordV1): boolean {
    this.required(journal);
    return this.authority.readyToReacquire(journal.operation_record_id);
  }
  reacquire(journal: HostOperationCallRecordV1, admit = true): HostCapacityRecordV1 {
    const record = this.required(journal);
    return this.authority.reacquire(journal.operation_record_id, record.revision, admit);
  }
  /** This error-only compensation deliberately does not select current demand. Admission
   * remains selection-bound; cleanup rechecks original request, custody, proof and live fence. */
  compensateRejectedReacquisition(
    journal: HostOperationCallRecordV1,
    fresh: HostOperationLeaseIdentityV1
  ): void {
    const exact = this.project.read(journal.operation_record_id);
    if (!same(exact, journal)) throw new Error("capacity compensation journal is not current");
    const stored = this.authority.runtimeRecord(journal.operation_record_id);
    // An admitted hold is never compensation-eligible, even if submission has not begun.
    if (
      stored?.parking === null ||
      stored === undefined ||
      stored.core.state !== "queued" ||
      stored.core.active_started_ms !== null
    )
      return;
    this.authority.compensateReacquisition(journal, stored.core.revision, fresh);
  }
  compensatedParking(journal: HostOperationCallRecordV1): HostCapacityParkingProofV1 | undefined {
    return this.authority.compensatedParking(journal);
  }
  supportsParking(journal: HostOperationCallRecordV1): boolean {
    return this.authority.runtimeRecord(journal.operation_record_id) !== undefined;
  }
  productiveEnabled(journal: HostOperationCallRecordV1): boolean {
    return this.project.productive !== undefined && this.supportsParking(journal);
  }
  observeProductive(journal: HostOperationCallRecordV1): boolean {
    const record = this.required(journal);
    const next = this.authority.observeProductive(journal.operation_record_id, record.revision);
    return next.last_milestone_ms !== record.last_milestone_ms;
  }

  private required(journal: HostOperationCallRecordV1): HostCapacityRecordV1 {
    const record = this.check(journal);
    if (record === undefined) throw new Error("capacity required reservation absent");
    return record;
  }

  requireHeld(journal: HostOperationCallRecordV1): void {
    const record = this.required(journal);
    this.authority.requireHeld(journal.operation_record_id, record.revision);
  }

  async prepareExternalSources(journal: HostOperationCallRecordV1): Promise<void> {
    const capacity = this.required(journal);
    if (capacity.state !== "held") throw new Error("managed preparation requires actual hold");
    await this.project.measurements.prepareExternalSources?.({
      journal: structuredClone(journal),
      capacity: structuredClone(capacity),
    });
  }

  beginMeasurement(
    journal: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1
  ): void {
    const capacity = this.required(journal);
    if (capacity.state !== "held") throw new Error("native measurement requires actual hold");
    this.project.measurements.begin?.({
      journal: structuredClone(journal),
      capacity: structuredClone(capacity),
      declaration: structuredClone(declaration),
    });
  }
  recordCachedResult(
    journal: HostOperationCallRecordV1,
    byte_length: number,
    content_sha256: string
  ): void {
    this.project.measurements.cached?.({
      journal: structuredClone(journal),
      byte_length,
      content_sha256,
    });
  }
  submissionGuarded(journal: HostOperationCallRecordV1): void {
    const capacity = this.required(journal);
    this.project.measurements.guarded?.({
      journal: structuredClone(journal),
      capacity: structuredClone(capacity),
    });
  }
  endMeasurement(journal: HostOperationCallRecordV1): void {
    const capacity = this.check(journal);
    if (capacity?.state === "held" && journal.disposition?.lease_disposition === "released")
      this.project.measurements.end?.({
        journal: structuredClone(journal),
        capacity: structuredClone(capacity),
      });
  }

  observeMilestone(journal: HostOperationCallRecordV1): void {
    const record = this.required(journal);
    this.authority.observeMilestone(journal.operation_record_id, record.revision);
  }

  /** Deadlines never renew on polls, adapter activity, heartbeat or restart. */
  activeRemaining(journal: HostOperationCallRecordV1, now: number): number {
    const record = this.required(journal);
    if (
      record.state !== "held" ||
      record.cleanup_started_ms !== null ||
      !same(record.lease, journal.lease)
    )
      throw new Error("capacity runtime hold/fence inactive");
    const deadlines = this.authority.deadlines(journal.operation_record_id);
    if (deadlines.active_inactivity_at_ms === null) throw new Error("capacity active clock absent");
    return Math.min(deadlines.active_inactivity_at_ms, deadlines.elapsed_at_ms ?? Infinity) - now;
  }

  beginCleanup(journal: HostOperationCallRecordV1, now: number): number {
    const record = this.required(journal);
    this.authority.beginCleanup(journal.operation_record_id, record.revision);
    const deadlines = this.authority.deadlines(journal.operation_record_id);
    if (deadlines.cleanup_at_ms === null) throw new Error("capacity cleanup clock absent");
    return Math.max(0, Math.min(deadlines.cleanup_grace_ms, deadlines.cleanup_at_ms - now));
  }

  /** Runs after global lease disposition, before settlement/consume/replay. Final proof is
   * taken only from the trusted meter; quarantine never fabricates a final-zero snapshot. */
  synchronize(
    journal: HostOperationCallRecordV1,
    receipt: HostOperationDispositionReceiptV1
  ): void {
    const record = this.check(journal);
    if (
      receipt.operation_record_id !== journal.operation_record_id ||
      receipt.backend_key_sha256 !== journal.policy_binding.backend_key_sha256 ||
      !same(receipt.lease, journal.lease) ||
      !same(receipt.disposition, journal.disposition) ||
      receipt.remote_correlation_sha256 !== journal.remote_correlation_sha256 ||
      (journal.lease_disposition_receipt_id !== null &&
        journal.lease_disposition_receipt_id !== receipt.receipt_id)
    )
      throw new Error("capacity runtime exact lease disposition conflict");
    if (record === undefined) {
      if (!this.unadmittedRefusal(journal)) throw new Error("capacity required reservation absent");
      return;
    }
    if (!same(record.lease, journal.lease))
      throw new Error("capacity runtime settlement fence conflict");
    if (record.state === "queued" || record.state === "expired") {
      this.authority.retireQueued(journal.operation_record_id, record.revision);
      return;
    }
    const measured =
      receipt.disposition.lease_disposition === "released"
        ? this.authority.account(journal.operation_record_id, record.revision)
        : record;
    this.authority.settle(journal.operation_record_id, measured.revision);
  }
}
