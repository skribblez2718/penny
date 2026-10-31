import {
  hostReceiptedResult,
  verifyHostEffectBinding,
  verifyHostResultWrapper,
} from "./effect-protocol.js";
import { ArtifactStore, currentArtifactRef } from "../artifact-store.js";
import { HostOperationCapacityRuntimeBinding } from "./capacity-runtime.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type {
  ArtifactRef,
  Directive,
  HostOperationArtifactContractV1,
  InvokeHostOperationDirectiveV1,
} from "../contracts.js";
import type { OrchestrationEngine } from "../engine.js";
import { runtimeRegistrationSha256, type PlaybookRegistration } from "../playbooks/registry.js";
import type {
  Checkpointer,
  ConsumeHostOperationCallInput,
  ReserveHostOperationCallInput,
  ReserveHostOperationCallOutcome,
} from "../checkpointer.js";
import {
  hostOperationDeclarationSha256,
  hostOperationResultIsSelected,
  validateHostOperationCallRecord,
  validateHostOperationDeclaration,
  validateHostOperationProgress,
  validateHostOperationReceipt,
  validateHostOperationResult,
  type HostOperationAdapterTerminalV1,
  type HostOperationAdapterV1,
  type HostOperationArtifactPlanV1,
  type HostOperationArtifactWriteV1,
  type HostOperationCallRecordV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionReceiptV1,
  type HostOperationDispositionV1,
  type HostOperationExecutionContextV1,
  type HostOperationLifecycleV1,
  type HostOperationPersistedOutputV1,
  type HostOperationPersistenceInputV1,
  type HostOperationProgressSink,
  type HostOperationProgressV1,
  type HostOperationReceiptV1,
  type HostOperationRemoteCancellationResultV1,
  type HostOperationRequestBindingV1,
  type HostOperationResultV1,
  type HostOperationCachedResultV1,
  type HostOperationResultCacheV1,
  type HostOperationLeaseIdentityV1,
} from "./contracts.js";
import {
  HostOperationArtifactCustody,
  createPreparedHostOperationCallRecord,
  encodeHostOperationCallRecord,
} from "./storage.js";
import {
  HostOperationLeaseAuthority,
  type HostOperationLeaseRequestV1,
} from "./lease-authority.js";

const QUEUE_POLL_INTERVAL_MS = 20;
const REMOTE_CANCELLATION_OBSERVE_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function uniqueArtifactRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...new Map(refs.map((ref) => [ref.artifact_id, ref] as const)).values()];
}

function contentBuffer(content: Uint8Array | string): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function artifactMatchesContract(
  artifact: ArtifactRef,
  contract: HostOperationArtifactContractV1
): boolean {
  return (
    artifact.kind === contract.artifact_kind &&
    artifact.content_schema?.schema_id === contract.schema_id &&
    artifact.content_schema.schema_version === contract.schema_version_required
  );
}

function assertWriteMatchesContract(
  write: HostOperationArtifactWriteV1,
  expected?: HostOperationArtifactContractV1
): void {
  const contract = expected ?? write.contract;
  if (!sameCanonical(write.contract, contract)) {
    throw new Error("host-operation artifact write diverges from its registered contract");
  }
  if (write.media_type.length === 0 || Buffer.byteLength(write.media_type, "utf8") > 128) {
    throw new Error("host-operation artifact media type is invalid");
  }
}

function leaseRequest(
  record: HostOperationCallRecordV1,
  declaration: HostOperationDeclarationV1
): HostOperationLeaseRequestV1 {
  return {
    operation_record_id: record.operation_record_id,
    backend_key_sha256: record.policy_binding.backend_key_sha256,
    project_id: record.project_id,
    run_id: record.identity.run_id,
    state_id: record.state_id,
    attempt: record.attempt,
    operation_id: record.operation_id,
    registration_sha256: record.registration_sha256,
    request_sha256: record.request_sha256,
    duration_ms: declaration.lease_profile.duration_ms,
    queue_inactivity_expires_at_ms: record.queue_inactivity_expires_at_ms,
    ...(record.remote_correlation_sha256 === null
      ? {}
      : { remote_correlation_sha256: record.remote_correlation_sha256 }),
  };
}

function releasedDisposition(
  outcome: "failed" | "cancelled" | "timed_out",
  remoteDisposition: "none" | "proven_not_accepted" | "proven_terminal",
  reasonCode: string,
  retryable = false
): HostOperationDispositionV1 {
  if (outcome === "failed") {
    return {
      outcome,
      remote_disposition: remoteDisposition,
      lease_disposition: "released",
      retryable,
      reason_code: reasonCode,
    };
  }
  return {
    outcome,
    remote_disposition: remoteDisposition,
    lease_disposition: "released",
    retryable: false,
    reason_code: reasonCode,
  };
}

function quarantinedDisposition(
  outcome: "cancelled" | "timed_out" | "remote_unknown",
  remoteDisposition: "may_continue" | "unknown_acceptance",
  reasonCode: string
): HostOperationDispositionV1 {
  return {
    outcome,
    remote_disposition: remoteDisposition,
    lease_disposition: "quarantined",
    retryable: false,
    reason_code: reasonCode,
  };
}

class HostOperationBoundaryError extends Error {
  constructor(
    readonly boundary: "cancelled" | "timed_out" | "failed",
    message: string
  ) {
    super(message);
    this.name = "HostOperationBoundaryError";
  }
}

/**
 * Exact host-owned interruption points in the asynchronous operation lifecycle. They are the only
 * strings the optional `fault` seam emits; no caller, request, model, or directive can name one.
 */
export const HOST_OPERATION_FAULT_POINTS = Object.freeze([
  "capacity_queued",
  "after_capacity_park",
  "after_capacity_reacquire",
  "before_capacity_admit",
  "after_capacity_admit",
  "before_submit",
  "after_submit_before_remote_checkpoint",
  "after_remote_checkpoint",
  "after_fetch",
  "after_persist",
  "after_raw_plan",
  "after_raw_artifacts",
  "after_receipt",
  "after_wrapper_plan",
  "after_wrapper_persist",
  "after_wrapper",
  "after_consume",
  "before_consume",
] as const);

export type HostOperationFaultPointV1 = (typeof HOST_OPERATION_FAULT_POINTS)[number];

/**
 * Raised by a host-owned fault seam to simulate a process crash at a durable lifecycle boundary.
 * The runtime owner recognizes it and rethrows after leaving the journal at its last committed
 * milestone instead of terminalizing the operation, so a restart can prove exact recovery.
 */
export class HostOperationSimulatedCrashError extends Error {
  constructor(readonly point: HostOperationFaultPointV1) {
    super(`simulated host-operation crash at '${point}'`);
    this.name = "HostOperationSimulatedCrashError";
  }
}

/** Project-local artifact custody and journal transaction boundary. */
export class HostOperationStateOwner {
  private readonly custody: HostOperationArtifactCustody;

  constructor(
    private readonly checkpointer: Pick<
      Checkpointer,
      "reserveHostOperationCall" | "transitionHostOperationCall" | "consumeHostOperationCall"
    >,
    artifacts: ArtifactStore
  ) {
    this.custody = HostOperationArtifactCustody.fromArtifactStore(artifacts);
  }

  reserve(input: Omit<ReserveHostOperationCallInput, "custody">): ReserveHostOperationCallOutcome {
    const record = this.custody.verifyForProject(input.record.project_id, input.record);
    return this.checkpointer.reserveHostOperationCall({ ...input, custody: this.custody, record });
  }

  transition(
    current: HostOperationCallRecordV1,
    next: HostOperationCallRecordV1
  ): HostOperationCallRecordV1 {
    const record = this.custody.verifyForProject(next.project_id, next);
    return this.checkpointer.transitionHostOperationCall({
      operation_record_id: current.operation_record_id,
      from: current.lifecycle,
      expected_record_sha256: encodeHostOperationCallRecord(current).record_sha256,
      next: record,
      custody: this.custody,
    });
  }

  consume(
    current: HostOperationCallRecordV1,
    input: Omit<ConsumeHostOperationCallInput, "custody" | "expected_record_sha256">
  ): HostOperationCallRecordV1 {
    const next = this.custody.verifyForProject(input.next.project_id, input.next);
    return this.checkpointer.consumeHostOperationCall({
      ...input,
      expected_record_sha256: encodeHostOperationCallRecord(current).record_sha256,
      next,
      custody: this.custody,
    });
  }
}

export interface HostOperationUseValidatorV1 {
  /** Synchronous ref-only admission. No artifact discovery/read capability is supplied. */
  preflightRefs?(input: {
    readonly directive: InvokeHostOperationDirectiveV1;
    readonly declaration: HostOperationDeclarationV1;
  }): void;
  validateUse(input: {
    readonly directive: InvokeHostOperationDirectiveV1;
    readonly declaration: HostOperationDeclarationV1;
    readonly request_bytes: Uint8Array;
    /** Linked caller/runner cancellation plus owner-enforced validation inactivity expiry. */
    readonly signal: AbortSignal;
    /** Renews only the bounded pre-journal authority-validation window. */
    readonly reportWorkMilestone: () => void;
  }): void | Promise<void>;
}

export interface HostOperationRuntimeOwnerOptions {
  readonly projectId: string;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly leaseAuthority: HostOperationLeaseAuthority;
  readonly adapters: ReadonlyMap<string, HostOperationAdapterV1>;
  /** Explicit host-only opt-in; enforced on every operation, with no missing-mapping bypass. */
  readonly capacityRuntime?: HostOperationCapacityRuntimeBinding;
  /** Optional host-owned durable exact-result cache for adapters with no-repeat recovery. */
  readonly resultCache?: HostOperationResultCacheV1;
  /** Host-selected local-operation exemptions; absence preserves the all-operation cache policy. */
  readonly resultCacheBypassOperationKinds?: readonly string[];
  /**
   * Optional host-owned use-time validator. It runs before journal fast-path adoption, adapter
   * inspection, execution, cached-result recovery, settled consumption, or consumed replay.
   */
  readonly useValidator?: HostOperationUseValidatorV1;
  /** Host-owned clock for lease deadlines and persisted journal/progress/receipt timestamps.
   * Defaults to the current wall clock; a controlled host may supply deterministic time.
   */
  readonly now?: () => number;
  /**
   * Narrow host-only interruption seam for recovery qualification. It is a construction-time
   * capability: it is absent from every directive, registration, request, and model-visible
   * surface, so no caller or model can select an interruption point. A callback that throws
   * `HostOperationSimulatedCrashError` leaves the durable journal at its last committed milestone.
   */
  readonly fault?: (point: HostOperationFaultPointV1, operation_kind: string) => void;
}

/** Registered, runner-only asynchronous host-operation execution owner. */
const canonicalExecutionContexts = new WeakSet<HostOperationExecutionContextV1>();
/** Opaque in-process custody accompanies the existing durable owner/fence. A structural
 * context, fake field or callback cannot acquire a registered host execution capability. */
export function isCanonicalHostOperationExecutionContextV1(
  context: HostOperationExecutionContextV1
): boolean {
  return canonicalExecutionContexts.has(context);
}
export class HostOperationRuntimeOwner {
  private readonly state: HostOperationStateOwner;
  private readonly active = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly options: HostOperationRuntimeOwnerOptions) {
    if (
      options.capacityRuntime !== undefined &&
      !(options.capacityRuntime instanceof HostOperationCapacityRuntimeBinding)
    )
      throw new Error("host capacity runtime binding must be concrete");
    this.state = new HostOperationStateOwner(options.checkpointer, options.artifacts);
    this.now = options.now ?? Date.now;
  }

  /** Journal, progress and receipt time share the host-owned operation clock. */
  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  cancelRun(runId: string): void {
    this.active.get(runId)?.abort(new Error("host operation was cancelled by its runner"));
  }

  async dispatch(
    engine: OrchestrationEngine,
    directive: InvokeHostOperationDirectiveV1,
    signal?: AbortSignal,
    progress?: HostOperationProgressSink
  ): Promise<Directive> {
    const prior = this.active.get(directive.identity.run_id);
    if (prior !== undefined) throw new Error("run already has an active host operation");
    const controller = new AbortController();
    const forward = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener("abort", forward, { once: true });
    this.active.set(directive.identity.run_id, controller);
    try {
      return await this.dispatchOwned(engine, directive, controller.signal, progress);
    } finally {
      if (this.active.get(directive.identity.run_id) === controller) {
        this.active.delete(directive.identity.run_id);
      }
      signal?.removeEventListener("abort", forward);
    }
  }

  private async dispatchOwned(
    engine: OrchestrationEngine,
    directive: InvokeHostOperationDirectiveV1,
    signal: AbortSignal,
    progress?: HostOperationProgressSink
  ): Promise<Directive> {
    const declaration = this.validateDirectiveBinding(engine.registration, directive);
    const existing = this.options.checkpointer.hostOperationCallForDirective(
      directive.identity.run_id,
      directive.state_id,
      directive.attempt,
      directive.operation_id
    );
    let exactInputs:
      | Awaited<ReturnType<HostOperationRuntimeOwner["verifyExactInputs"]>>
      | undefined;
    try {
      exactInputs = await this.verifyExactInputs(directive, declaration, signal);
    } catch (error) {
      if (
        !(error instanceof HostOperationSimulatedCrashError) &&
        existing !== undefined &&
        sameCanonical(existing.directive, directive)
      )
        this.compensateRejectedReacquisition(existing, declaration);
      // Input cancellation is a lifecycle boundary, not an adapter failure. Without a
      // use-time validator, exact journal custody can still establish a no-effect result.
      // A configured validator must finish before any reservation or replay; never turn
      // interrupted authority validation (or a ref/byte refusal) into an admitted call.
      if (
        !(error instanceof HostOperationBoundaryError) ||
        error.boundary !== "cancelled" ||
        this.options.useValidator !== undefined
      )
        throw error;
    }

    const nowMs = this.now();
    const operationInactivityExpiry =
      existing?.operation_inactivity_expires_at_ms ?? nowMs + declaration.operation_inactivity_ms;
    const queueInactivityExpiry =
      existing?.queue_inactivity_expires_at_ms ??
      Math.min(operationInactivityExpiry, nowMs + declaration.lease_profile.queue_inactivity_ms);
    const prepared = createPreparedHostOperationCallRecord({
      project_id: this.options.projectId,
      directive,
      queue_inactivity_expires_at_ms: queueInactivityExpiry,
      operation_inactivity_expires_at_ms: operationInactivityExpiry,
      timestamp: existing?.created_at ?? new Date(nowMs).toISOString(),
    });
    let record = this.state.reserve({ record: prepared }).record;
    record = this.reconcileCompensatedParking(record);
    try {
      this.options.capacityRuntime?.check(record);
    } catch (error) {
      // A refused current mapping cannot strand the exact pre-submission fence. Later
      // lifecycles preserve their evidence and hold; never reconstruct missing capacity.
      if (record.lifecycle === "lease_acquired") {
        record = this.compensateRejectedReacquisition(record, declaration);
        record = this.toTerminal(
          record,
          releasedDisposition("failed", "proven_not_accepted", "capacity_unavailable")
        );
        this.settleLease(record, declaration);
      }
      throw error;
    }
    if (record.lifecycle === "consumed") {
      this.synchronizeCapacity(record);
      if (
        declaration.receipt_citing_result !== undefined &&
        record.operation_result_ref !== null &&
        record.result_wrapper?.ref == null
      )
        throw new Error("host-operation requires its receipt-citing wrapper");
      verifyHostResultWrapper(this.options.artifacts, record);
      return engine.handle({ schema_version: 2, action: "status", identity: directive.identity });
    }
    if (record.lifecycle === "settled") return this.settleAndConsume(engine, record, declaration);
    if (record.lifecycle === "terminal") return this.settleAndConsume(engine, record, declaration);
    record = this.adoptPersistedBoundaries(record, declaration);
    if (record.lifecycle === "settled") return this.settleAndConsume(engine, record, declaration);
    if (record.lifecycle === "terminal") return this.settleAndConsume(engine, record, declaration);

    if (exactInputs === undefined || signal.aborted) {
      this.options.leaseAuthority.cancelQueue(record.operation_record_id);
      record = await this.failAdapterExecution(record, undefined, true, undefined);
      return this.settleAndConsume(engine, record, declaration);
    }
    const requestBytes = exactInputs.request_bytes;
    const adapter = this.options.adapters.get(declaration.adapter_id);
    if (adapter === undefined || adapter.adapter_id !== declaration.adapter_id) {
      record = this.toTerminal(
        record,
        record.lifecycle === "submitting"
          ? quarantinedDisposition(
              "remote_unknown",
              "unknown_acceptance",
              "adapter_unavailable_during_submission"
            )
          : record.lifecycle === "submitted"
            ? quarantinedDisposition(
                "remote_unknown",
                "may_continue",
                "adapter_unavailable_after_acceptance"
              )
            : releasedDisposition(
                "failed",
                record.lifecycle === "prepared"
                  ? "none"
                  : record.lifecycle === "lease_acquired"
                    ? "proven_not_accepted"
                    : "proven_terminal",
                "adapter_unavailable",
                false
              )
      );
      return this.settleAndConsume(engine, record, declaration);
    }
    let inspected: HostOperationRequestBindingV1;
    try {
      inspected = adapter.inspectRequest({
        directive,
        declaration,
        request_bytes: requestBytes,
        input_artifacts: directive.input_artifacts,
      });
    } catch {
      record = this.toTerminal(
        record,
        record.lifecycle === "submitted"
          ? quarantinedDisposition(
              "remote_unknown",
              "may_continue",
              "adapter_request_inspection_failed_after_acceptance"
            )
          : record.lifecycle === "submitting"
            ? quarantinedDisposition(
                "remote_unknown",
                "unknown_acceptance",
                "adapter_request_inspection_failed_during_submission"
              )
            : releasedDisposition(
                "failed",
                record.lifecycle === "prepared"
                  ? "none"
                  : record.lifecycle === "lease_acquired"
                    ? "proven_not_accepted"
                    : "proven_terminal",
                "adapter_request_inspection_failed",
                false
              )
      );
      return this.settleAndConsume(engine, record, declaration);
    }
    if (
      inspected.schema_version !== 1 ||
      inspected.operation_kind !== directive.operation_kind ||
      inspected.adapter_id !== declaration.adapter_id ||
      inspected.backend_binding_id !== declaration.backend_binding_id ||
      inspected.backend_key_sha256 !== directive.policy_binding.backend_key_sha256
    ) {
      record = this.toTerminal(
        record,
        record.lifecycle === "submitted"
          ? quarantinedDisposition(
              "remote_unknown",
              "may_continue",
              "adapter_request_binding_refused_after_acceptance"
            )
          : record.lifecycle === "submitting"
            ? quarantinedDisposition(
                "remote_unknown",
                "unknown_acceptance",
                "adapter_request_binding_refused_during_submission"
              )
            : releasedDisposition(
                "failed",
                record.lifecycle === "prepared"
                  ? "none"
                  : record.lifecycle === "lease_acquired"
                    ? "proven_not_accepted"
                    : "proven_terminal",
                "adapter_request_binding_refused",
                false
              )
      );
      return this.settleAndConsume(engine, record, declaration);
    }

    if (record.lifecycle === "submitting" && record.remote_correlation_id === null) {
      const disposition = quarantinedDisposition(
        "remote_unknown",
        "unknown_acceptance",
        "ambiguous_submission_restart"
      );
      record = this.toTerminal(record, disposition);
      return this.settleAndConsume(engine, record, declaration);
    }

    const capacity = this.options.capacityRuntime;
    if (capacity?.isParked(record)) {
      record = await this.waitForCapacity(record, declaration, signal);
      if (record.lifecycle === "terminal")
        return this.settleAndConsume(engine, record, declaration);
    } else if (record.lease === null || record.lifecycle === "prepared") {
      record = await this.acquireLease(record, declaration, signal, progress);
      if (record.lifecycle === "terminal") {
        return this.settleAndConsume(engine, record, declaration);
      }
    } else {
      record = this.adoptLease(record, declaration);
      if (record.lifecycle === "terminal") {
        return this.settleAndConsume(engine, record, declaration);
      }
    }

    if (capacity !== undefined) {
      let admitted;
      try {
        admitted = capacity.reserve(record);
      } catch (error) {
        if (error instanceof HostOperationSimulatedCrashError) throw error;
        // reserve is permitted only at lease_acquired; a later absent/corrupt record
        // must refuse rather than terminalize as an unadmitted replacement.
        if (record.lifecycle !== "lease_acquired")
          throw new Error("capacity recovery reservation refused");
        record = this.toTerminal(
          record,
          releasedDisposition("failed", "proven_not_accepted", "capacity_unavailable")
        );
        return this.settleAndConsume(engine, record, declaration);
      }
      if (admitted.state !== "held") {
        if (record.lifecycle !== "lease_acquired")
          throw new Error("capacity recovery hold refused");
        if (admitted.state === "queued" && capacity.supportsParking(record)) {
          this.options.fault?.("capacity_queued", record.operation_kind);
          capacity.park(record);
          this.options.fault?.("after_capacity_park", record.operation_kind);
          record = await this.waitForCapacity(record, declaration, signal);
          if (record.lifecycle === "terminal")
            return this.settleAndConsume(engine, record, declaration);
        } else {
          record = this.toTerminal(
            record,
            releasedDisposition("failed", "proven_not_accepted", "capacity_unavailable")
          );
          return this.settleAndConsume(engine, record, declaration);
        }
      }
    }

    const operationController = new AbortController();
    let accepting = true;
    let current = record;
    let remoteCancellation:
      | ((signal: AbortSignal) => Promise<HostOperationRemoteCancellationResultV1>)
      | undefined;
    let progressSequence = current.progress_event_count;
    let cachedResult: HostOperationCachedResultV1 | null = null;
    let renewalTimer: NodeJS.Timeout | undefined;
    let inactivityTimer: NodeJS.Timeout | undefined;
    let capacityTimer: NodeJS.Timeout | undefined;
    let cleanupGraceMs = REMOTE_CANCELLATION_OBSERVE_MS;
    const beginCleanup = (): void => {
      if (capacity !== undefined)
        cleanupGraceMs = Math.min(cleanupGraceMs, capacity.beginCleanup(current, this.now()));
    };
    const abortOperation = (reason: unknown): void => {
      if (operationController.signal.aborted) return;
      try {
        beginCleanup();
      } catch (error) {
        reason = error;
      }
      operationController.abort(reason);
    };
    const forwardAbort = (): void => abortOperation(signal.reason);
    const scheduleCapacityExpiry = (): void => {
      if (capacityTimer !== undefined) clearTimeout(capacityTimer);
      if (capacity === undefined || operationController.signal.aborted) return;
      try {
        const remaining = capacity.activeRemaining(current, this.now());
        if (remaining <= 0) {
          abortOperation(
            new HostOperationBoundaryError("timed_out", "host capacity active clock expired")
          );
          return;
        }
        capacityTimer = setTimeout(scheduleCapacityExpiry, Math.min(MAX_TIMER_DELAY_MS, remaining));
      } catch (error) {
        abortOperation(
          new HostOperationBoundaryError(
            "failed",
            error instanceof Error ? error.message : "capacity clock refused"
          )
        );
      }
    };

    const replace = (next: HostOperationCallRecordV1): void => {
      current = this.state.transition(current, next);
    };
    const touch = (
      lifecycle: HostOperationLifecycleV1,
      patch: Partial<HostOperationCallRecordV1>
    ): HostOperationCallRecordV1 =>
      validateHostOperationCallRecord({
        ...current,
        ...patch,
        lifecycle,
        updated_at: this.timestamp(),
      });
    const scheduleInactivityExpiry = (): void => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      const remaining = current.operation_inactivity_expires_at_ms - this.now();
      const expire = (): void =>
        abortOperation(
          new HostOperationBoundaryError("timed_out", "host operation inactivity lease expired")
        );
      if (remaining <= 0) {
        expire();
        return;
      }
      inactivityTimer = setTimeout(
        remaining > MAX_TIMER_DELAY_MS ? scheduleInactivityExpiry : expire,
        Math.min(MAX_TIMER_DELAY_MS, remaining)
      );
    };
    const assertAccepting = (): void => {
      if (
        !accepting ||
        operationController.signal.aborted ||
        this.now() >= current.operation_inactivity_expires_at_ms
      ) {
        throw new Error("host-operation adapter callback is outside its active fence");
      }
      if (capacity !== undefined && capacity.activeRemaining(current, this.now()) <= 0) {
        const error = new HostOperationBoundaryError(
          "timed_out",
          "host capacity active clock expired"
        );
        abortOperation(error);
        throw error;
      }
    };
    const renewActivity = (activityClass: string, observedUnits = 1): void => {
      assertAccepting();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(activityClass) ||
        !Number.isSafeInteger(observedUnits) ||
        observedUnits <= 0 ||
        observedUnits > 16_777_216
      ) {
        throw new Error("host-operation activity signal is invalid");
      }
      const expiresAt = this.now() + declaration.operation_inactivity_ms;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error("host-operation inactivity expiry exceeds the safe clock range");
      }
      replace(
        touch(current.lifecycle, {
          operation_inactivity_expires_at_ms: expiresAt,
        })
      );
      scheduleInactivityExpiry();
    };
    // Successful fenced lease acquisition/adoption starts a fresh inactivity interval. Queue wait
    // and process downtime are not active operation time.
    const initialActivityExpiry = this.now() + declaration.operation_inactivity_ms;
    if (!Number.isSafeInteger(initialActivityExpiry)) {
      throw new Error("host-operation inactivity expiry exceeds the safe clock range");
    }
    replace(
      touch(current.lifecycle, {
        operation_inactivity_expires_at_ms: initialActivityExpiry,
      })
    );
    const emitProgress = (
      value: Omit<HostOperationProgressV1, "schema_version" | "sequence" | "observed_at">
    ): void => {
      if (progressSequence >= declaration.max_progress_events) {
        throw new Error("host-operation progress event limit exceeded");
      }
      renewActivity(value.progress_class, Math.max(1, value.completed_units ?? 1));
      progressSequence += 1;
      const event = validateHostOperationProgress({
        schema_version: 1,
        sequence: progressSequence,
        observed_at: this.timestamp(),
        ...value,
      });
      replace(touch(current.lifecycle, { progress_event_count: progressSequence }));
      this.options.checkpointer.appendHostOperationEvent(
        current.identity.run_id,
        "host_operation_progress",
        {
          operation_record_id: current.operation_record_id,
          sequence: event.sequence,
          progress_class: event.progress_class,
          ...(event.completed_units === undefined
            ? {}
            : { completed_units: event.completed_units }),
          ...(event.total_units === undefined ? {} : { total_units: event.total_units }),
          ...(event.detail_code === undefined ? {} : { detail_code: event.detail_code }),
          ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
        },
        event.observed_at
      );
      try {
        progress?.(event);
      } catch {
        // Progress is observational and cannot alter durable execution truth.
      }
    };
    const scheduleRenewal = (): void => {
      if (!accepting || current.lease === null || current.lease_expires_at_ms === null) return;
      const renewAt =
        current.lease_expires_at_ms -
        declaration.lease_profile.duration_ms +
        declaration.lease_profile.renew_after_ms;
      const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, renewAt - this.now()));
      renewalTimer = setTimeout(() => {
        if (!accepting || current.lease === null) return;
        try {
          const renewed = this.options.leaseAuthority.renew(
            leaseRequest(current, declaration),
            current.lease,
            this.now()
          );
          replace(
            touch(current.lifecycle, {
              lease: renewed.lease,
              lease_expires_at_ms: renewed.expires_at_ms,
            })
          );
          scheduleRenewal();
        } catch (error) {
          abortOperation(
            new HostOperationBoundaryError(
              "failed",
              error instanceof Error ? error.message : "host-operation lease renewal failed"
            )
          );
        }
      }, delay);
    };

    const executionContext: HostOperationExecutionContextV1 = {
      directive,
      declaration,
      request_bytes: requestBytes,
      // Expose the current canonical snapshot after each journal CAS, never the stale
      // lease_acquired value captured when execution began. Adapters cannot mutate it.
      get journal() {
        return structuredClone(current);
      },
      signal: operationController.signal,
      reportActivity: renewActivity,
      ...(capacity?.productiveEnabled(current)
        ? {
            observeProductiveProgress: () => {
              assertAccepting();
              if (!capacity.observeProductive(current)) return;
              assertAccepting();
              // This ordinary owner activity follows accepted durable proof, not adapter counters.
              renewActivity("durable_productive_output");
              scheduleCapacityExpiry();
            },
          }
        : {}),
      readInput: (slot) => {
        assertAccepting();
        const input = exactInputs.inputs.get(slot);
        if (input === undefined)
          throw new Error(`host-operation input slot '${slot}' is not bound`);
        return { ref: input.ref, bytes: Buffer.from(input.bytes) };
      },
      emitProgress,
      beginSubmission: () => {
        assertAccepting();
        if (current.lifecycle !== "lease_acquired" || current.lease === null) {
          throw new Error("host operation cannot begin submission from its current lifecycle");
        }
        this.options.fault?.("before_submit", current.operation_kind);
        capacity?.requireHeld(current);
        capacity?.beginMeasurement(current, declaration);
        this.options.leaseAuthority.guardSubmission(
          leaseRequest(current, declaration),
          current.lease,
          this.now()
        );
        replace(touch("submitting", {}));
        capacity?.submissionGuarded(current);
        emitProgress({ progress_class: "submission_started" });
      },
      recordRemoteAccepted: (remoteCorrelationId) => {
        assertAccepting();
        if (
          current.lifecycle !== "submitting" ||
          current.lease === null ||
          remoteCorrelationId.length === 0 ||
          Buffer.byteLength(remoteCorrelationId, "utf8") > 8_192
        ) {
          throw new Error("host operation cannot record this remote acceptance");
        }
        const correlationSha256 = sha256(remoteCorrelationId);
        this.options.fault?.("after_submit_before_remote_checkpoint", current.operation_kind);
        replace(
          touch("submitted", {
            remote_correlation_id: remoteCorrelationId,
            remote_correlation_sha256: correlationSha256,
          })
        );
        const accepted = this.options.leaseAuthority.reconcileRemoteAccepted(
          leaseRequest(current, declaration),
          current.lease,
          correlationSha256,
          this.now()
        );
        replace(
          touch("submitted", {
            lease: accepted.lease,
            lease_expires_at_ms: accepted.expires_at_ms,
          })
        );
        capacity?.reconcile(current);
        emitProgress({ progress_class: "remote_accepted" });
        this.options.fault?.("after_remote_checkpoint", current.operation_kind);
      },
      cacheResult: async (bytesValue) => {
        assertAccepting();
        const cache =
          this.options.resultCacheBypassOperationKinds !== undefined &&
          this.options.resultCacheBypassOperationKinds.includes(current.operation_kind)
            ? undefined
            : this.options.resultCache;
        if (cache === undefined) {
          throw new Error("host-operation durable result cache is unavailable");
        }
        const bytes = Buffer.from(bytesValue);
        if (bytes.byteLength > declaration.max_output_bytes) {
          throw new Error("host-operation cached result exceeds registered output bytes");
        }
        const cached = await cache.write(current.request_sha256, bytes);
        assertAccepting();
        if (
          cached.request_sha256 !== current.request_sha256 ||
          cached.byte_length !== bytes.byteLength ||
          cached.content_sha256 !== sha256(bytes) ||
          !Buffer.from(cached.bytes).equals(bytes)
        ) {
          throw new Error("host-operation result cache returned divergent exact bytes");
        }
        capacity?.recordCachedResult(current, cached.byte_length, cached.content_sha256);
        cachedResult = cached;
        return cached;
      },
      readCachedResult: async () => {
        assertAccepting();
        const cache =
          this.options.resultCacheBypassOperationKinds !== undefined &&
          this.options.resultCacheBypassOperationKinds.includes(current.operation_kind)
            ? undefined
            : this.options.resultCache;
        if (cache === undefined) {
          throw new Error("host-operation durable result cache is unavailable");
        }
        const cached = await cache.read(current.request_sha256);
        assertAccepting();
        if (cached !== null && cached.byte_length > declaration.max_output_bytes) {
          throw new Error("host-operation cached result exceeds registered output bytes");
        }
        if (cached)
          capacity?.recordCachedResult(current, cached.byte_length, cached.content_sha256);
        cachedResult = cached;
        return cached;
      },
      recordFetched: (fetched) => {
        assertAccepting();
        if (current.lease === null) {
          throw new Error("host operation cannot record fetched output from its current lifecycle");
        }
        if (
          this.options.resultCache !== undefined &&
          (this.options.resultCacheBypassOperationKinds === undefined ||
            !this.options.resultCacheBypassOperationKinds.includes(current.operation_kind)) &&
          (cachedResult === null ||
            cachedResult.content_sha256 !== fetched.content_sha256 ||
            cachedResult.byte_length !== fetched.byte_length)
        ) {
          throw new Error("host operation must durably cache exact bytes before recordFetched");
        }
        if (current.lifecycle === "fetched" || current.lifecycle === "persisting") {
          // Recovery after a durable fetch milestone re-reads the exact output (the adapter must
          // re-fetch the bytes to persist them). The milestone is immutable: a restart may only
          // re-record the identical fetch, never a different one.
          if (!sameCanonical(current.fetched, fetched)) {
            throw new Error("host operation fetched milestone diverges on recovery");
          }
        } else if (current.lifecycle === "submitting" || current.lifecycle === "submitted") {
          replace(touch("fetched", { fetched }));
          capacity?.observeMilestone(current);
          scheduleCapacityExpiry();
          emitProgress({
            progress_class: "fetched",
            completed_units: fetched.byte_length,
            ...(fetched.byte_length === 0 ? {} : { total_units: fetched.byte_length }),
          });
        } else {
          throw new Error("host operation cannot record fetched output from its current lifecycle");
        }
        this.options.fault?.("after_fetch", current.operation_kind);
      },
      persist: (input) => {
        assertAccepting();
        if (current.lifecycle !== "fetched" && current.lifecycle !== "persisting") {
          throw new Error("host operation cannot persist before a durable fetch milestone");
        }
        const persisted = this.persistAdapterOutputs(current, declaration, input);
        current = persisted.record;
        emitProgress({
          progress_class: "persisted",
          completed_units:
            persisted.output.operation_result_ref.byte_length +
            persisted.output.output_artifacts.reduce(
              (sum, artifact) => sum + artifact.byte_length,
              0
            ),
        });
        this.options.fault?.("after_persist", current.operation_kind);
        return persisted.output;
      },
      registerRemoteCancellation: (callback) => {
        assertAccepting();
        if (remoteCancellation !== undefined) {
          throw new Error("host operation registered more than one remote cancellation callback");
        }
        remoteCancellation = callback;
      },
    };

    canonicalExecutionContexts.add(executionContext);
    let terminal: HostOperationAdapterTerminalV1 | undefined;
    let failure: unknown;
    try {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
      scheduleInactivityExpiry();
      scheduleCapacityExpiry();
      scheduleRenewal();
      terminal = await this.runAdapterWithBoundary(
        adapter,
        executionContext,
        operationController.signal,
        signal,
        async () => {
          if (capacity !== undefined) {
            await this.verifyExactInputs(directive, declaration, operationController.signal);
            assertAccepting();
            capacity.requireHeld(current);
            await capacity.prepareExternalSources(current);
            assertAccepting();
            await adapter.prepare?.(executionContext);
            assertAccepting();
            capacity.requireHeld(current);
            capacity.beginMeasurement(current, declaration);
          }
        }
      );
    } catch (error) {
      failure = error;
    } finally {
      accepting = false;
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      if (renewalTimer !== undefined) clearTimeout(renewalTimer);
      if (capacityTimer !== undefined) clearTimeout(capacityTimer);
      signal.removeEventListener("abort", forwardAbort);
    }

    if (failure instanceof HostOperationSimulatedCrashError) throw failure;
    if (terminal !== undefined) {
      current = this.acceptAdapterTerminal(current, declaration, terminal);
    } else {
      current = this.options.checkpointer.hostOperationCall(current.operation_record_id) ?? current;
      // A capacity refusal must not strand an exact pre-submission backend fence.
      // Preserve the refusal for synchronization; still obtain the safe lease disposition.
      try {
        beginCleanup();
      } catch {
        /* Exact selection/clock failure is checked again before consume. */
      }
      current = await this.failAdapterExecution(
        current,
        failure,
        signal.aborted,
        remoteCancellation,
        cleanupGraceMs
      );
    }
    return this.settleAndConsume(engine, current, declaration);
  }

  /** Re-run current host authority after queue waits, without holding a catalog transaction.
   * The queue deadline remains independent even if validation reports productive work. */
  private async validateUse(
    directive: InvokeHostOperationDirectiveV1,
    declaration: HostOperationDeclarationV1,
    requestBytes: Uint8Array,
    signal: AbortSignal,
    deadline = Infinity
  ): Promise<void> {
    const useValidator = this.options.useValidator;
    if (useValidator !== undefined) {
      const validationController = new AbortController();
      const forwardAbort = (): void => validationController.abort(signal.reason);
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
      let validating = true;
      let rejectOnAbort: (() => void) | undefined;
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
      const armInactivity = (): void => {
        if (!validating || validationController.signal.aborted) return;
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(
          () =>
            validationController.abort(
              new Error("host operation use authority inactivity expired")
            ),
          Math.min(declaration.operation_inactivity_ms, Math.max(0, deadline - this.now()))
        );
        inactivityTimer.unref?.();
      };
      try {
        armInactivity();
        const validation = Promise.resolve().then(() =>
          useValidator.validateUse({
            directive,
            declaration,
            request_bytes: requestBytes,
            signal: validationController.signal,
            reportWorkMilestone: armInactivity,
          })
        );
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectOnAbort = () => reject(validationController.signal.reason);
          if (validationController.signal.aborted) rejectOnAbort();
          else validationController.signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
        await Promise.race([validation, aborted]);
        validationController.signal.throwIfAborted();
      } finally {
        validating = false;
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        signal.removeEventListener("abort", forwardAbort);
        if (rejectOnAbort !== undefined)
          validationController.signal.removeEventListener("abort", rejectOnAbort);
      }
    }
  }

  private validateDirectiveBinding(
    registration: PlaybookRegistration,
    directive: InvokeHostOperationDirectiveV1
  ): HostOperationDeclarationV1 {
    const registrationSha256 = runtimeRegistrationSha256(registration);
    if (directive.registration_sha256 !== registrationSha256) {
      throw new Error("host-operation directive registration digest is stale");
    }
    if (directive.request_sha256 !== directive.request_ref.content_digest) {
      throw new Error("host-operation directive request digest diverges from its exact ref");
    }
    const declaration = registration.host_operations?.declarations.find(
      (candidate) => candidate.operation_kind === directive.operation_kind
    );
    if (declaration === undefined) {
      throw new Error(`host operation '${directive.operation_kind}' is not registered`);
    }
    const validated = validateHostOperationDeclaration(declaration);
    if (
      directive.policy_binding.declaration_sha256 !== hostOperationDeclarationSha256(validated) ||
      directive.policy_binding.adapter_id !== validated.adapter_id ||
      directive.policy_binding.backend_binding_id !== validated.backend_binding_id ||
      directive.policy_binding.lease_profile_id !== validated.lease_profile.profile_id ||
      directive.policy_binding.lease_profile_sha256 !== validated.lease_profile.profile_sha256 ||
      directive.policy_binding.operation_inactivity_ms !== validated.operation_inactivity_ms ||
      !sameCanonical(directive.expected_result, validated.result)
    ) {
      throw new Error("host-operation directive diverges from its registered declaration");
    }
    return validated;
  }

  private async verifyExactInputs(
    directive: InvokeHostOperationDirectiveV1,
    declaration: HostOperationDeclarationV1,
    signal: AbortSignal,
    deadline = Infinity
  ): Promise<{
    readonly request_bytes: Buffer;
    readonly inputs: ReadonlyMap<string, { readonly ref: ArtifactRef; readonly bytes: Buffer }>;
  }> {
    if (declaration.effect_protocol !== undefined && directive.effect_intent_ref === undefined)
      throw new Error("registered effect requires request-before-intent binding");
    verifyHostEffectBinding(this.options.artifacts, this.options.projectId, directive);
    const request = currentArtifactRef(directive.request_ref);
    const slots = new Set<string>();
    let declaredBytes = 0;
    for (const binding of directive.input_artifacts.artifacts) {
      const ref = currentArtifactRef(binding.ref);
      if (slots.has(binding.slot)) throw new Error("host-operation input slots are duplicated");
      slots.add(binding.slot);
      if (!Number.isSafeInteger(ref.byte_length))
        throw new Error("host-operation unsafe input size");
      declaredBytes += ref.byte_length;
      if (!Number.isSafeInteger(declaredBytes))
        throw new Error("host-operation unsafe input total");
    }
    if (
      declaration.max_input_artifacts !== undefined &&
      (slots.size > declaration.max_input_artifacts ||
        declaredBytes > (declaration.max_input_bytes ?? -1))
    )
      throw new Error("host-operation input artifacts exceed registration");
    this.options.useValidator?.preflightRefs?.({ directive, declaration });
    if (
      !artifactMatchesContract(request, declaration.request) ||
      request.byte_length > declaration.max_request_bytes
    ) {
      throw new Error("host-operation request artifact metadata violates registration");
    }
    // Ref-only admission must fail closed even on an already-aborted call. Once it
    // passes, stop buffering inputs on cancellation; settlement separately rechecks
    // exact artifact custody and cannot acquire submission authority.
    const assertInputWorkActive = (): void => {
      if (signal.aborted)
        throw new HostOperationBoundaryError(
          "cancelled",
          "host-operation input work was cancelled"
        );
    };
    assertInputWorkActive();
    const stored = this.options.artifacts.refById(request.artifact_id);
    if (stored === undefined || !sameCanonical(stored, request)) {
      throw new Error("host-operation request artifact ref differs from custody");
    }
    const bytes = this.options.artifacts.readById(request.artifact_id);
    if (
      bytes.byteLength !== request.byte_length ||
      sha256(bytes) !== directive.request_sha256 ||
      request.store_ref !== `artifact://sha256/${directive.request_sha256}`
    ) {
      throw new Error("host-operation request bytes differ from the bound ref");
    }
    const earlyValidation = this.options.useValidator?.preflightRefs !== undefined;
    if (earlyValidation) await this.validateUse(directive, declaration, bytes, signal, deadline);
    const inputs = new Map<string, { readonly ref: ArtifactRef; readonly bytes: Buffer }>();
    let inputBytes = 0;
    for (const binding of directive.input_artifacts.artifacts) {
      assertInputWorkActive();
      const storedInput = this.options.artifacts.refById(binding.ref.artifact_id);
      if (storedInput === undefined || !sameCanonical(storedInput, binding.ref)) {
        throw new Error(`host-operation input '${binding.slot}' differs from custody`);
      }
      const input = this.options.artifacts.readById(binding.ref.artifact_id);
      if (
        input.byteLength !== binding.ref.byte_length ||
        sha256(input) !== binding.ref.content_digest
      )
        throw new Error("host-operation input bytes differ from custody");
      inputBytes += input.byteLength;
      inputs.set(binding.slot, { ref: storedInput, bytes: input });
    }
    if (
      declaration.max_input_artifacts !== undefined &&
      (inputs.size > declaration.max_input_artifacts ||
        inputBytes > (declaration.max_input_bytes ?? -1))
    ) {
      throw new Error("host-operation input artifacts exceed registration");
    }
    assertInputWorkActive();
    if (!earlyValidation) await this.validateUse(directive, declaration, bytes, signal, deadline);
    return { request_bytes: bytes, inputs };
  }

  private async acquireLease(
    initial: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1,
    signal: AbortSignal,
    progress?: HostOperationProgressSink
  ): Promise<HostOperationCallRecordV1> {
    let record = initial;
    let progressSent = false;
    while (record.lifecycle === "prepared") {
      const nowMs = this.now();
      if (signal.aborted || nowMs >= record.queue_inactivity_expires_at_ms) {
        this.options.leaseAuthority.cancelQueue(record.operation_record_id);
        const outcome = signal.aborted ? "cancelled" : "timed_out";
        return this.toTerminal(
          record,
          releasedDisposition(
            outcome,
            "none",
            signal.aborted ? "cancelled_while_queued" : "queue_inactivity_expired"
          )
        );
      }
      const acquired = this.options.leaseAuthority.tryAcquire(
        leaseRequest(record, declaration),
        nowMs
      );
      if (acquired.kind === "acquired" || acquired.kind === "adopted") {
        record = this.state.transition(
          record,
          validateHostOperationCallRecord({
            ...record,
            lifecycle: "lease_acquired",
            lease: acquired.active.lease,
            lease_expires_at_ms: acquired.active.expires_at_ms,
            updated_at: this.timestamp(),
          })
        );
        return record;
      }
      if (acquired.kind === "quarantined") {
        this.options.leaseAuthority.cancelQueue(record.operation_record_id);
        return this.toTerminal(
          record,
          releasedDisposition("failed", "none", "backend_quarantined", false)
        );
      }
      if (!progressSent && record.progress_event_count < declaration.max_progress_events) {
        progressSent = true;
        const event = validateHostOperationProgress({
          schema_version: 1,
          sequence: record.progress_event_count + 1,
          observed_at: this.timestamp(),
          progress_class: "queued",
        });
        record = this.state.transition(
          record,
          validateHostOperationCallRecord({
            ...record,
            progress_event_count: event.sequence,
            updated_at: this.timestamp(),
          })
        );
        this.options.checkpointer.appendHostOperationEvent(
          record.identity.run_id,
          "host_operation_progress",
          {
            operation_record_id: record.operation_record_id,
            sequence: event.sequence,
            progress_class: event.progress_class,
          },
          event.observed_at
        );
        try {
          progress?.(event);
        } catch {
          // Observational only.
        }
      }
      await this.waitForQueue(signal, record.queue_inactivity_expires_at_ms);
    }
    return record;
  }

  /** Catalog compensation and the project CAS are intentionally separate commits. Only the
   * durable exact compensation event restores a fresh journal fence to the original proof. */
  private reconcileCompensatedParking(
    record: HostOperationCallRecordV1
  ): HostOperationCallRecordV1 {
    if (record.lifecycle !== "lease_acquired") return record;
    const proof = this.options.capacityRuntime?.compensatedParking(record);
    if (proof === undefined) return record;
    return this.state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lease: proof.lease,
        lease_expires_at_ms: proof.parked_at_ms,
        updated_at: this.timestamp(),
      })
    );
  }

  private compensateRejectedReacquisition(
    initial: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1,
    fresh?: HostOperationLeaseIdentityV1
  ): HostOperationCallRecordV1 {
    const capacity = this.options.capacityRuntime;
    if (capacity === undefined || initial.lifecycle !== "lease_acquired") return initial;
    let record = this.options.checkpointer.hostOperationCall(initial.operation_record_id);
    if (record === undefined) throw new Error("capacity compensation project journal absent");
    if (record.lifecycle !== "lease_acquired") return record;
    // Recover only an existing owned fence if acquisition threw after its catalog commit.
    // Otherwise use the captured result, so a subsequently stale token cannot be cleaned up.
    const owned = this.options.leaseAuthority.ownedActive(leaseRequest(record, declaration));
    if (owned !== undefined) capacity.compensateRejectedReacquisition(record, fresh ?? owned.lease);
    record = this.reconcileCompensatedParking(record);
    return record;
  }

  /** Parked work never holds a backend fence while waiting on resources. Each reacquisition
   * checks the exact proof and current demand before entering FIFO, then admits atomically. */
  private async waitForCapacity(
    initial: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1,
    signal: AbortSignal
  ): Promise<HostOperationCallRecordV1> {
    const capacity = this.options.capacityRuntime;
    if (capacity === undefined) throw new Error("capacity parking runtime absent");
    let record = initial;
    let fresh: HostOperationLeaseIdentityV1 | undefined;
    try {
      while (record.lifecycle === "lease_acquired") {
        const deadline = capacity.queueDeadline(record);
        if (signal.aborted || this.now() >= deadline) {
          // A crash may leave a fresh owned fence before project/capacity adoption. Resolve only
          // that existing fence; never acquire after cancellation or queue expiry.
          const owned = this.options.leaseAuthority.ownedActive(leaseRequest(record, declaration));
          if (owned !== undefined) {
            fresh = owned.lease;
            if (owned.phase !== "pre_submission")
              throw new Error("parked work acquired submission authority");
            record = this.state.transition(
              record,
              validateHostOperationCallRecord({
                ...record,
                lease: owned.lease,
                lease_expires_at_ms: owned.expires_at_ms,
                updated_at: this.timestamp(),
              })
            );
            capacity.reacquire(record, false);
          }
          this.options.leaseAuthority.cancelQueue(record.operation_record_id);
          return this.toTerminal(
            record,
            releasedDisposition(
              signal.aborted ? "cancelled" : "timed_out",
              "proven_not_accepted",
              signal.aborted ? "cancelled_while_capacity_parked" : "capacity_queue_expired"
            )
          );
        }
        if (
          !capacity.readyToReacquire(record) &&
          this.options.leaseAuthority.ownedActive(leaseRequest(record, declaration)) === undefined
        ) {
          this.options.leaseAuthority.cancelQueue(record.operation_record_id);
          await this.waitForQueue(signal, deadline);
          continue;
        }
        await this.verifyExactInputs(record.directive, declaration, signal, deadline);
        // Validation is asynchronous; demand, cancellation, queue time and readiness may change.
        // No later readiness hint may skip this validation, even if another process frees capacity.
        capacity.check(record);
        if (signal.aborted || this.now() >= deadline) continue;
        const recovered = this.options.leaseAuthority.ownedActive(
          leaseRequest(record, declaration)
        );
        if (recovered !== undefined) {
          if (recovered.phase !== "pre_submission")
            throw new Error("parked work acquired submission authority");
          const active = this.options.leaseAuthority.tryAcquire(
            leaseRequest(record, declaration),
            this.now()
          );
          if (active.kind !== "acquired" && active.kind !== "adopted")
            throw new Error("parked owned fence recovery refused");
          fresh = active.active.lease;
          record = this.state.transition(
            record,
            validateHostOperationCallRecord({
              ...record,
              lease: active.active.lease,
              lease_expires_at_ms: active.active.expires_at_ms,
              updated_at: this.timestamp(),
            })
          );
          const admitted = capacity.reacquire(record, !signal.aborted);
          if (admitted.state === "held") return record;
          if (admitted.state === "expired" || signal.aborted) {
            return this.toTerminal(
              record,
              releasedDisposition(
                signal.aborted ? "cancelled" : "timed_out",
                "proven_not_accepted",
                signal.aborted ? "cancelled_while_capacity_parked" : "capacity_queue_expired"
              )
            );
          }
          capacity.park(record);
          fresh = undefined;
          this.options.fault?.("after_capacity_park", record.operation_kind);
        }
        if (!capacity.readyToReacquire(record)) {
          // Readiness can change while backend FIFO is busy. Do not leave an unready head there.
          this.options.leaseAuthority.cancelQueue(record.operation_record_id);
          await this.waitForQueue(signal, deadline);
          continue;
        }
        const acquired = this.options.leaseAuthority.tryAcquire(
          leaseRequest(record, declaration),
          this.now()
        );
        if (acquired.kind === "quarantined") {
          this.options.leaseAuthority.cancelQueue(record.operation_record_id);
          return this.toTerminal(
            record,
            releasedDisposition("failed", "proven_not_accepted", "backend_quarantined")
          );
        }
        if (acquired.kind === "waiting") {
          await this.waitForQueue(signal, deadline);
          continue;
        }
        fresh = acquired.active.lease;
        this.options.fault?.("after_capacity_reacquire", record.operation_kind);
        record = this.state.transition(
          record,
          validateHostOperationCallRecord({
            ...record,
            lease: acquired.active.lease,
            lease_expires_at_ms: acquired.active.expires_at_ms,
            updated_at: this.timestamp(),
          })
        );
        this.options.fault?.("before_capacity_admit", record.operation_kind);
        const admitted = capacity.reacquire(record, !signal.aborted);
        this.options.fault?.("after_capacity_admit", record.operation_kind);
        if (admitted.state === "held") return record;
        if (admitted.state === "expired" || signal.aborted) {
          return this.toTerminal(
            record,
            releasedDisposition(
              signal.aborted ? "cancelled" : "timed_out",
              "proven_not_accepted",
              signal.aborted ? "cancelled_while_capacity_parked" : "capacity_queue_expired"
            )
          );
        }
        capacity.park(record);
        fresh = undefined;
        this.options.fault?.("after_capacity_park", record.operation_kind);
        await this.waitForQueue(signal, deadline);
      }
      throw new Error("capacity parked journal lifecycle changed");
    } catch (error) {
      if (!(error instanceof HostOperationSimulatedCrashError))
        this.compensateRejectedReacquisition(record, declaration, fresh);
      throw error;
    }
  }

  private adoptLease(
    record: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1
  ): HostOperationCallRecordV1 {
    if (record.lease === null) throw new Error("host-operation journal lost its lease identity");
    const acquired = this.options.leaseAuthority.tryAcquire(
      leaseRequest(record, declaration),
      this.now()
    );
    if (acquired.kind === "waiting") {
      const prior = this.options.leaseAuthority.dispositionForOperation(record.operation_record_id);
      if (prior === undefined) {
        throw new Error("host-operation journal lease lost its global owner without disposition");
      }
      return this.toTerminal(record, prior.disposition);
    }
    if (acquired.kind === "quarantined") {
      const prior = this.options.leaseAuthority.dispositionForOperation(record.operation_record_id);
      const disposition =
        prior?.disposition ??
        quarantinedDisposition(
          "remote_unknown",
          record.remote_correlation_id === null ? "unknown_acceptance" : "may_continue",
          "backend_quarantined"
        );
      return this.toTerminal(record, disposition);
    }
    const active = acquired.active;
    if (
      !sameCanonical(record.lease, active.lease) ||
      record.lease_expires_at_ms !== active.expires_at_ms
    ) {
      return this.state.transition(
        record,
        validateHostOperationCallRecord({
          ...record,
          lease: active.lease,
          lease_expires_at_ms: active.expires_at_ms,
          updated_at: this.timestamp(),
        })
      );
    }
    return record;
  }

  private adoptPersistedBoundaries(
    initial: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1
  ): HostOperationCallRecordV1 {
    let record = initial;
    if (record.lifecycle === "persisting") {
      const plan = record.persistence_plan;
      if (plan === null) throw new Error("persisting host operation lacks its deterministic plan");
      const result = this.refForPlan(record, plan.operation_result);
      const outputs = plan.outputs.map((item) => this.refForPlan(record, item));
      if (result !== undefined && outputs.every((item) => item !== undefined)) {
        const completeOutputs = outputs.flatMap((item) => (item === undefined ? [] : [item]));
        record = this.state.transition(
          record,
          validateHostOperationCallRecord({
            ...record,
            lifecycle: "persisted",
            operation_result_ref: result,
            output_artifacts: completeOutputs,
            updated_at: this.timestamp(),
          })
        );
      }
    }
    if (record.lifecycle === "persisted") {
      this.verifyPersistedOutputs(record, declaration);
      record = this.state.transition(
        record,
        validateHostOperationCallRecord({
          ...record,
          lifecycle: "verified",
          updated_at: this.timestamp(),
        })
      );
    }
    if (record.lifecycle === "verified") {
      const disposition = record.persistence_plan?.disposition;
      if (disposition === undefined) {
        throw new Error("verified host operation lacks its persisted disposition");
      }
      record = this.toTerminal(record, disposition);
    }
    return record;
  }

  private persistAdapterOutputs(
    initial: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1,
    input: HostOperationPersistenceInputV1
  ): {
    readonly record: HostOperationCallRecordV1;
    readonly output: HostOperationPersistedOutputV1;
  } {
    assertWriteMatchesContract(input.operation_result, declaration.result);
    const outputs = input.outputs ?? [];
    const registeredOutputs = declaration.output_contracts ?? [];
    for (const output of outputs) {
      const expected = registeredOutputs.find((contract) =>
        sameCanonical(contract, output.contract)
      );
      if (expected === undefined) {
        throw new Error("host-operation output artifact is not registered");
      }
      assertWriteMatchesContract(output, expected);
    }
    if (outputs.length + 1 > declaration.max_output_artifacts) {
      throw new Error("host-operation output artifact count exceeds registration");
    }
    const resultBytes = contentBuffer(input.operation_result.content);
    const outputBytes = outputs.map((output) => contentBuffer(output.content));
    const totalBytes =
      resultBytes.byteLength + outputBytes.reduce((sum, value) => sum + value.byteLength, 0);
    if (totalBytes > declaration.max_output_bytes) {
      throw new Error("host-operation output bytes exceed registration");
    }
    const planItem = (
      write: HostOperationArtifactWriteV1,
      bytes: Buffer,
      operationId: string
    ): HostOperationArtifactPlanV1 => ({
      schema_version: 1,
      operation_id: operationId,
      version: 1,
      artifact_kind: write.contract.artifact_kind,
      media_type: write.media_type,
      schema_id: write.contract.schema_id,
      schema_version_required: write.contract.schema_version_required,
      byte_length: bytes.byteLength,
      content_sha256: sha256(bytes),
    });
    const resultPlan = planItem(
      input.operation_result,
      resultBytes,
      `host-operation-specific-result:${initial.operation_record_id}`
    );
    const outputPlans = outputs.map((output, index) =>
      planItem(
        output,
        outputBytes[index] ?? Buffer.alloc(0),
        `host-operation-output:${initial.operation_record_id}:${index}`
      )
    );
    const persistencePlan = {
      schema_version: 1 as const,
      operation_result: resultPlan,
      outputs: outputPlans,
      disposition: input.disposition,
    };
    let record: HostOperationCallRecordV1;
    if (initial.lifecycle === "persisting") {
      if (!sameCanonical(initial.persistence_plan, persistencePlan)) {
        throw new Error("host-operation persistence retry diverges from its durable plan");
      }
      record = initial;
    } else {
      record = this.state.transition(
        initial,
        validateHostOperationCallRecord({
          ...initial,
          lifecycle: "persisting",
          persistence_plan: persistencePlan,
          updated_at: this.timestamp(),
        })
      );
    }
    this.options.fault?.("after_raw_plan", record.operation_kind);
    const resultRef = this.persistPlannedArtifact(
      record,
      resultPlan,
      resultBytes,
      hostOperationResultIsSelected(declaration)
    );
    const selectedOutputKinds = new Set<string>();
    const outputRefs = outputPlans.map((plan, index) => {
      const select = !selectedOutputKinds.has(plan.artifact_kind);
      selectedOutputKinds.add(plan.artifact_kind);
      return this.persistPlannedArtifact(
        record,
        plan,
        outputBytes[index] ?? Buffer.alloc(0),
        select
      );
    });
    this.options.fault?.("after_raw_artifacts", record.operation_kind);
    record = this.state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lifecycle: "persisted",
        operation_result_ref: resultRef,
        output_artifacts: outputRefs,
        updated_at: this.timestamp(),
      })
    );
    this.options.capacityRuntime?.observeMilestone(record);
    this.verifyPersistedOutputs(record, declaration);
    record = this.state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lifecycle: "verified",
        updated_at: this.timestamp(),
      })
    );
    this.options.capacityRuntime?.observeMilestone(record);
    return {
      record,
      output: { operation_result_ref: resultRef, output_artifacts: outputRefs },
    };
  }

  private persistPlannedArtifact(
    record: HostOperationCallRecordV1,
    plan: HostOperationArtifactPlanV1,
    bytes: Buffer,
    select: boolean
  ): ArtifactRef {
    const existing = this.refForPlan(record, plan);
    const ref =
      existing ??
      this.options.artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: record.identity.run_id,
          phase: record.state_id,
          branch_id: null,
          kind: plan.artifact_kind,
          operation_id: plan.operation_id,
          version: plan.version,
          producer: `host:${record.policy_binding.adapter_id}`,
          media_type: plan.media_type,
          content_schema: {
            schema_id: plan.schema_id,
            schema_version: plan.schema_version_required,
          },
          parent_ref: null,
          upstream_refs: uniqueArtifactRefs([
            record.request_ref,
            ...(record.directive.effect_intent_ref === undefined
              ? []
              : [record.directive.effect_intent_ref]),
            ...(record.result_wrapper?.plan.operation_id === plan.operation_id
              ? [
                  record.operation_result_ref,
                  record.host_receipt_ref,
                  ...record.output_artifacts,
                ].flatMap((ref) => (ref === null ? [] : [ref]))
              : []),
            ...record.input_artifacts.artifacts.map((binding) => binding.ref),
          ]),
        },
        content: bytes,
      });
    const readback = this.options.artifacts.readById(ref.artifact_id);
    if (
      ref.byte_length !== plan.byte_length ||
      ref.content_digest !== plan.content_sha256 ||
      readback.byteLength !== plan.byte_length ||
      sha256(readback) !== plan.content_sha256
    ) {
      throw new Error("host-operation artifact failed exact persisted readback");
    }
    if (select) this.options.artifacts.select(ref);
    return ref;
  }

  private refForPlan(
    record: HostOperationCallRecordV1,
    plan: HostOperationArtifactPlanV1
  ): ArtifactRef | undefined {
    const ref = this.options.artifacts.refFor(
      record.identity.run_id,
      record.state_id,
      null,
      plan.artifact_kind,
      plan.operation_id,
      plan.version
    );
    if (ref === undefined || ref === null) return undefined;
    const bytes = this.options.artifacts.readById(ref.artifact_id);
    if (
      ref.media_type !== plan.media_type ||
      ref.content_schema?.schema_id !== plan.schema_id ||
      ref.content_schema.schema_version !== plan.schema_version_required ||
      ref.byte_length !== plan.byte_length ||
      ref.content_digest !== plan.content_sha256 ||
      bytes.byteLength !== plan.byte_length ||
      sha256(bytes) !== plan.content_sha256
    ) {
      throw new Error("host-operation deterministic artifact coordinate conflicts");
    }
    return ref;
  }

  private verifyPersistedOutputs(
    record: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1
  ): void {
    if (
      record.operation_result_ref === null ||
      !artifactMatchesContract(record.operation_result_ref, declaration.result)
    ) {
      throw new Error("host-operation persisted result violates its registered contract");
    }
    const registeredOutputs = declaration.output_contracts ?? [];
    for (const output of record.output_artifacts) {
      if (!registeredOutputs.some((contract) => artifactMatchesContract(output, contract))) {
        throw new Error("host-operation persisted output violates its registered contract");
      }
    }
    const artifacts = [record.operation_result_ref, ...record.output_artifacts];
    if (artifacts.length > declaration.max_output_artifacts) {
      throw new Error("host-operation persisted output count exceeds registration");
    }
    const bytes = artifacts.reduce((sum, artifact) => {
      this.options.artifacts.readById(artifact.artifact_id);
      return sum + artifact.byte_length;
    }, 0);
    if (bytes > declaration.max_output_bytes) {
      throw new Error("host-operation persisted output bytes exceed registration");
    }
  }

  private acceptAdapterTerminal(
    record: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1,
    terminal: HostOperationAdapterTerminalV1
  ): HostOperationCallRecordV1 {
    if (record.lifecycle === "verified") {
      const planDisposition = record.persistence_plan?.disposition;
      if (
        planDisposition === undefined ||
        !sameCanonical(planDisposition, terminal.disposition) ||
        record.operation_result_ref === null ||
        !sameCanonical(record.operation_result_ref, terminal.operation_result_ref) ||
        !sameCanonical(record.output_artifacts, terminal.output_artifacts)
      ) {
        throw new Error("host-operation adapter terminal diverges from persisted outputs");
      }
      this.verifyPersistedOutputs(record, declaration);
      return this.toTerminal(record, terminal.disposition);
    }
    if (
      terminal.operation_result_ref !== null ||
      terminal.output_artifacts.length !== 0 ||
      terminal.disposition.outcome === "completed"
    ) {
      throw new Error("host-operation adapter returned unowned or incomplete output refs");
    }
    return this.toTerminal(record, terminal.disposition);
  }

  private async failAdapterExecution(
    record: HostOperationCallRecordV1,
    error: unknown,
    callerCancelled: boolean,
    remoteCancellation:
      | ((signal: AbortSignal) => Promise<HostOperationRemoteCancellationResultV1>)
      | undefined,
    cleanupGraceMs = REMOTE_CANCELLATION_OBSERVE_MS
  ): Promise<HostOperationCallRecordV1> {
    const timedOut =
      error instanceof HostOperationBoundaryError
        ? error.boundary === "timed_out"
        : !callerCancelled && this.now() >= record.operation_inactivity_expires_at_ms;
    const cancelled =
      callerCancelled ||
      (error instanceof HostOperationBoundaryError && error.boundary === "cancelled");
    const boundaryOutcome = timedOut ? "timed_out" : cancelled ? "cancelled" : undefined;
    if (record.lifecycle === "prepared") {
      return this.toTerminal(
        record,
        releasedDisposition(
          boundaryOutcome ?? "failed",
          "none",
          boundaryOutcome ?? "adapter_failed",
          boundaryOutcome === undefined
        )
      );
    }
    if (record.lifecycle === "lease_acquired") {
      return this.toTerminal(
        record,
        releasedDisposition(
          boundaryOutcome ?? "failed",
          "proven_not_accepted",
          boundaryOutcome ?? "adapter_failed_before_submission",
          boundaryOutcome === undefined
        )
      );
    }
    if (record.lifecycle === "submitting") {
      return this.toTerminal(
        record,
        quarantinedDisposition(
          "remote_unknown",
          "unknown_acceptance",
          boundaryOutcome === "cancelled"
            ? "cancelled_during_submission"
            : boundaryOutcome === "timed_out"
              ? "timed_out_during_submission"
              : "adapter_failed_during_submission"
        )
      );
    }
    if (record.lifecycle === "submitted") {
      if (boundaryOutcome !== undefined && remoteCancellation !== undefined) {
        const observed = await this.observeRemoteCancellation(remoteCancellation, cleanupGraceMs);
        if (observed?.remote_disposition === "proven_terminal") {
          return this.toTerminal(
            record,
            releasedDisposition(boundaryOutcome, "proven_terminal", observed.reason_code)
          );
        }
        return this.toTerminal(
          record,
          quarantinedDisposition(
            boundaryOutcome,
            "may_continue",
            observed?.reason_code ?? "remote_cancellation_unproven"
          )
        );
      }
      return this.toTerminal(
        record,
        quarantinedDisposition(
          boundaryOutcome ?? "remote_unknown",
          "may_continue",
          boundaryOutcome ?? "accepted_remote_outcome_unknown"
        )
      );
    }
    if (
      record.lifecycle === "fetched" ||
      record.lifecycle === "persisting" ||
      record.lifecycle === "persisted" ||
      record.lifecycle === "verified"
    ) {
      return this.toTerminal(
        record,
        releasedDisposition(
          boundaryOutcome ?? "failed",
          "proven_terminal",
          boundaryOutcome ?? "post_fetch_persistence_failed",
          false
        )
      );
    }
    if (
      record.lifecycle === "terminal" ||
      record.lifecycle === "settled" ||
      record.lifecycle === "consumed"
    ) {
      return record;
    }
    throw new Error(`unsupported host-operation failure lifecycle '${record.lifecycle}'`);
  }

  private async observeRemoteCancellation(
    callback: (signal: AbortSignal) => Promise<HostOperationRemoteCancellationResultV1>,
    graceMs: number
  ): Promise<HostOperationRemoteCancellationResultV1 | undefined> {
    if (graceMs <= 0) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("remote cancellation observation timed out")),
      graceMs
    );
    try {
      return await Promise.race([
        callback(controller.signal),
        new Promise<undefined>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private toTerminal(
    record: HostOperationCallRecordV1,
    disposition: HostOperationDispositionV1
  ): HostOperationCallRecordV1 {
    if (record.lifecycle === "terminal") {
      if (!sameCanonical(record.disposition, disposition)) {
        throw new Error("host-operation terminal disposition conflicts with durable journal");
      }
      return record;
    }
    return this.state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lifecycle: "terminal",
        disposition,
        updated_at: this.timestamp(),
      })
    );
  }

  private settleAndConsume(
    engine: OrchestrationEngine,
    initial: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1
  ): Directive {
    let record = initial;
    if (record.lifecycle !== "terminal" && record.lifecycle !== "settled") {
      throw new Error("host operation is not terminal or settled");
    }
    if (record.lifecycle === "terminal") {
      const disposition = record.disposition;
      if (disposition === null) throw new Error("terminal host operation lacks its disposition");
      try {
        const requiredCapacity = this.options.capacityRuntime?.check(record);
        if (requiredCapacity !== undefined) this.options.capacityRuntime?.reconcile(record);
        this.options.capacityRuntime?.endMeasurement(record);
      } catch (error) {
        // Preserve safe backend cleanup even when current capacity selection refuses.
        // No capacity refund, settled output or continuation is produced on this path.
        this.settleLease(record, declaration);
        throw error;
      }
      const leaseReceipt = this.settleLease(record, declaration);
      this.options.capacityRuntime?.synchronize(record, leaseReceipt);
      const platformResult = validateHostOperationResult({
        schema_version: 1,
        operation_record_id: record.operation_record_id,
        identity: record.identity,
        state_id: record.state_id,
        attempt: record.attempt,
        operation_id: record.operation_id,
        operation_kind: record.operation_kind,
        registration_sha256: record.registration_sha256,
        request_sha256: record.request_sha256,
        lease: record.lease,
        disposition,
        operation_result_ref: record.operation_result_ref,
        output_artifacts: record.output_artifacts,
      });
      const outputArtifacts = [
        ...(record.operation_result_ref === null ? [] : [record.operation_result_ref]),
        ...record.output_artifacts,
      ];
      const hostReceipt = validateHostOperationReceipt({
        schema_version: 1,
        receipt_id: `hop_receipt_${sha256(
          canonicalJson({
            operation_record_id: record.operation_record_id,
            disposition_receipt_id: leaseReceipt.receipt_id,
          })
        )}`,
        operation_record_id: record.operation_record_id,
        identity: record.identity,
        state_id: record.state_id,
        attempt: record.attempt,
        operation_id: record.operation_id,
        operation_kind: record.operation_kind,
        registration_sha256: record.registration_sha256,
        request_sha256: record.request_sha256,
        started_at: record.started_at,
        ended_at: record.updated_at,
        progress_event_count: record.progress_event_count,
        poll_count: record.fetched?.poll_count ?? 0,
        request_bytes: record.request_ref.byte_length,
        output_artifact_count: outputArtifacts.length,
        output_bytes: outputArtifacts.reduce((sum, artifact) => sum + artifact.byte_length, 0),
        result_sha256: record.operation_result_ref?.content_digest ?? null,
        remote_correlation_sha256: record.remote_correlation_sha256,
        lease_disposition_receipt_id: leaseReceipt.receipt_id,
        disposition,
      });
      const platformResultRef = this.persistOwnerJson(
        record,
        "host-operation-result",
        `host-operation-platform-result:${record.operation_record_id}`,
        "penny.host-operation-result.v1",
        platformResult,
        outputArtifacts,
        hostOperationResultIsSelected(declaration)
      );
      const receiptRef = this.persistOwnerJson(
        record,
        "host-operation-receipt",
        `host-operation-receipt:${record.operation_record_id}`,
        "penny.host-operation-receipt.v1",
        hostReceipt,
        [platformResultRef],
        hostOperationResultIsSelected(declaration)
      );
      record = this.state.transition(
        record,
        validateHostOperationCallRecord({
          ...record,
          lifecycle: "settled",
          lease_disposition_receipt_id: leaseReceipt.receipt_id,
          platform_result_ref: platformResultRef,
          host_receipt_ref: receiptRef,
          updated_at: this.timestamp(),
        })
      );
    }
    this.options.fault?.("after_receipt", record.operation_kind);
    record = this.persistResultWrapper(record, declaration);
    return this.consume(engine, record);
  }

  private persistResultWrapper(
    record: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1
  ): HostOperationCallRecordV1 {
    const contract = declaration.receipt_citing_result;
    if (contract === undefined || record.operation_result_ref === null) return record;
    const content = Buffer.from(canonicalJson(hostReceiptedResult(record)), "utf8");
    const plan: HostOperationArtifactPlanV1 = {
      schema_version: 1,
      operation_id: `host-operation-wrapper:${record.operation_record_id}`,
      version: 1,
      artifact_kind: contract.artifact_kind,
      media_type: "application/json",
      schema_id: contract.schema_id,
      schema_version_required: contract.schema_version_required,
      byte_length: content.length,
      content_sha256: sha256(content),
    };
    const rawArtifacts = [record.operation_result_ref, ...record.output_artifacts];
    if (
      rawArtifacts.length + 1 > declaration.max_output_artifacts ||
      content.length + rawArtifacts.reduce((sum, ref) => sum + (ref?.byte_length ?? 0), 0) >
        declaration.max_output_bytes
    )
      throw new Error("host result wrapper byte limit");
    if (record.result_wrapper === undefined)
      record = this.state.transition(
        record,
        validateHostOperationCallRecord({
          ...record,
          result_wrapper: { plan, ref: null },
          updated_at: this.timestamp(),
        })
      );
    if (!sameCanonical(record.result_wrapper?.plan, plan))
      throw new Error("host result wrapper plan conflict");
    this.options.fault?.("after_wrapper_plan", record.operation_kind);
    const ref = this.persistPlannedArtifact(
      record,
      plan,
      content,
      hostOperationResultIsSelected(declaration)
    );
    this.options.fault?.("after_wrapper_persist", record.operation_kind);
    if (record.result_wrapper?.ref === null)
      record = this.state.transition(
        record,
        validateHostOperationCallRecord({
          ...record,
          result_wrapper: { plan, ref },
          updated_at: this.timestamp(),
        })
      );
    verifyHostResultWrapper(this.options.artifacts, record);
    this.options.fault?.("after_wrapper", record.operation_kind);
    return record;
  }

  private settleLease(
    record: HostOperationCallRecordV1,
    declaration: HostOperationDeclarationV1
  ): HostOperationDispositionReceiptV1 {
    const disposition = record.disposition;
    if (disposition === null) throw new Error("terminal host operation lacks its disposition");
    const existingReceipt = this.options.leaseAuthority.dispositionForOperation(
      record.operation_record_id
    );
    let leaseReceipt: HostOperationDispositionReceiptV1;
    if (existingReceipt !== undefined) {
      if (!sameCanonical(existingReceipt.disposition, disposition)) {
        throw new Error("host-operation lease disposition conflicts with project journal");
      }
      leaseReceipt = existingReceipt;
    } else if (record.lease !== null && this.options.capacityRuntime?.isParked(record)) {
      leaseReceipt = this.options.leaseAuthority.settleParked(
        leaseRequest(record, declaration),
        record.lease,
        disposition,
        this.now()
      );
    } else if (record.lease === null) {
      leaseReceipt = this.options.leaseAuthority.settleWithoutLease(
        leaseRequest(record, declaration),
        disposition,
        this.now()
      );
    } else if (disposition.lease_disposition === "released") {
      leaseReceipt = this.options.leaseAuthority.release(
        leaseRequest(record, declaration),
        record.lease,
        disposition,
        record.remote_correlation_sha256,
        this.now()
      );
    } else {
      leaseReceipt = this.options.leaseAuthority.quarantine(
        leaseRequest(record, declaration),
        record.lease,
        disposition,
        record.remote_correlation_sha256,
        this.now()
      );
    }
    if (
      this.options.capacityRuntime !== undefined &&
      (!sameCanonical(leaseReceipt.lease, record.lease) ||
        leaseReceipt.backend_key_sha256 !== record.policy_binding.backend_key_sha256 ||
        leaseReceipt.remote_correlation_sha256 !== record.remote_correlation_sha256)
    )
      throw new Error("capacity exact lease disposition conflict");
    return leaseReceipt;
  }

  private synchronizeCapacity(record: HostOperationCallRecordV1): void {
    if (this.options.capacityRuntime === undefined) return;
    const receipt = this.options.leaseAuthority.dispositionForOperation(record.operation_record_id);
    if (receipt === undefined) throw new Error("capacity lease disposition proof absent");
    this.options.capacityRuntime.synchronize(record, receipt);
  }

  private persistOwnerJson(
    record: HostOperationCallRecordV1,
    kind: string,
    operationId: string,
    schemaId: string,
    value: HostOperationResultV1 | HostOperationReceiptV1,
    upstreamRefs: readonly ArtifactRef[],
    select: boolean
  ): ArtifactRef {
    const content = canonicalJson(value);
    const existing = this.options.artifacts.refFor(
      record.identity.run_id,
      record.state_id,
      null,
      kind,
      operationId,
      1
    );
    const ref =
      existing ??
      this.options.artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: record.identity.run_id,
          phase: record.state_id,
          branch_id: null,
          kind,
          operation_id: operationId,
          version: 1,
          producer: "host:host-operation-owner",
          media_type: "application/json",
          content_schema: { schema_id: schemaId, schema_version: 1 },
          parent_ref: null,
          upstream_refs: [record.request_ref, ...upstreamRefs],
        },
        content,
      });
    if (
      ref.content_digest !== sha256(content) ||
      this.options.artifacts.readById(ref.artifact_id).toString("utf8") !== content
    ) {
      throw new Error("host-operation owner artifact failed exact readback");
    }
    if (select) this.options.artifacts.select(ref);
    return ref;
  }

  private consume(engine: OrchestrationEngine, record: HostOperationCallRecordV1): Directive {
    if (
      record.lifecycle !== "settled" ||
      record.platform_result_ref === null ||
      record.host_receipt_ref === null ||
      record.disposition === null
    ) {
      throw new Error("host operation is not ready for parent consumption");
    }
    this.synchronizeCapacity(record);
    this.options.fault?.("before_consume", record.operation_kind);
    const prepared = engine.prepareHostOperationContinuation({ record });
    const consumed = validateHostOperationCallRecord({
      ...record,
      lifecycle: "consumed",
      updated_at: this.timestamp(),
    });
    this.state.consume(record, {
      operation_record_id: record.operation_record_id,
      next: consumed,
      parentContext: prepared.context,
      expected_parent_snapshot_sha256: prepared.source_snapshot_sha256,
      eventType: "host_operation_consumed",
      payload: {
        operation_record_id: record.operation_record_id,
        operation_id: record.operation_id,
        disposition_outcome: record.disposition.outcome,
        platform_result_artifact_id: record.platform_result_ref.artifact_id,
        host_receipt_artifact_id: record.host_receipt_ref.artifact_id,
      },
    });
    this.options.fault?.("after_consume", record.operation_kind);
    return prepared.next;
  }

  private async runAdapterWithBoundary(
    adapter: HostOperationAdapterV1,
    context: HostOperationExecutionContextV1,
    effectiveSignal: AbortSignal,
    callerSignal: AbortSignal,
    beforeEntry: () => void | Promise<void>
  ): Promise<HostOperationAdapterTerminalV1> {
    const execution = Promise.resolve().then(async () => {
      // Preserve the legacy path; opt-in capacity checks at the actual microtask entry.
      await beforeEntry();
      effectiveSignal.throwIfAborted();
      return adapter.run(context);
    });
    void execution.catch(() => undefined);
    if (effectiveSignal.aborted) {
      if (effectiveSignal.reason instanceof HostOperationBoundaryError) {
        throw effectiveSignal.reason;
      }
      throw new HostOperationBoundaryError(
        callerSignal.aborted ? "cancelled" : "timed_out",
        "host operation ended before adapter start"
      );
    }
    const boundary = new Promise<never>((_resolve, reject) => {
      effectiveSignal.addEventListener(
        "abort",
        () =>
          reject(
            effectiveSignal.reason instanceof HostOperationBoundaryError
              ? effectiveSignal.reason
              : new HostOperationBoundaryError(
                  callerSignal.aborted ? "cancelled" : "timed_out",
                  callerSignal.aborted
                    ? "host operation was cancelled"
                    : "host operation inactivity lease expired"
                )
          ),
        { once: true }
      );
    });
    return await Promise.race([execution, boundary]);
  }

  private async waitForQueue(signal: AbortSignal, inactivityExpiresAtMs: number): Promise<void> {
    const remaining = Math.max(0, inactivityExpiresAtMs - this.now());
    const delay = Math.min(QUEUE_POLL_INTERVAL_MS, remaining);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
  }
}
