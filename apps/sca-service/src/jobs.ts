import type {
  ScaAdapterRegistry,
  ScaAdapterTerminalResult,
  ScaJobExecutionContext,
  ScaOperationAdapter,
} from "./adapters.js";
import {
  SCA_BROKER_PROGRESS_LIMITS_V1,
  ScaBrokerContractError,
  classifyScaBrokerIdempotency,
  scaBrokerExecuteRequestSha256,
  validateScaBrokerCancelRequestV1,
  validateScaBrokerCancelResultV1,
  validateScaBrokerExecuteAcceptedResultV2,
  validateScaBrokerExecuteRequestV1,
  validateScaBrokerJobProgressV1,
  validateScaBrokerPollRequestV1,
  validateScaBrokerPollResultV2,
  validateScaBrokerReceiptV1,
  type ScaBrokerCancelRequestV1,
  type ScaBrokerCancelResultV1,
  type ScaBrokerErrorCode,
  type ScaBrokerExecuteAcceptedResultV2,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerJobProgressV1,
  type ScaBrokerPollRequestV1,
  type ScaBrokerPollResultV2,
  type ScaBrokerReceiptV1,
  type ScaBrokerTypedErrorV1,
} from "./contracts.js";

import { canonicalJson } from "../../orchestration/dist/canonical-json.js";
import type { ScaJobStore, ScaStoredJob } from "./job-store.js";

const DEFAULT_MAX_RETAINED_JOBS = 256;

export class ScaJobOwnerError extends Error {
  constructor(
    readonly code: ScaBrokerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ScaJobOwnerError";
  }
}

export class ScaJobProgressProducer {
  private progress: ScaBrokerJobProgressV1;
  private readonly maxOutputBytes: number;
  private readonly maxResultItems: number;

  constructor(requestValue: ScaBrokerExecuteRequestV1, retainedProgress?: ScaBrokerJobProgressV1) {
    const request = validateScaBrokerExecuteRequestV1(requestValue);
    this.maxOutputBytes = request.limits.max_output_bytes;
    this.maxResultItems = request.limits.max_result_items;
    this.progress = validateScaBrokerJobProgressV1({
      schema_id: "penny.sca-broker-job-progress.v1",
      schema_version: 1,
      tenant_id: request.tenant_id,
      project_id: request.project_id,
      run_id: request.run_id,
      job_id: request.job_id,
      attempt: request.attempt,
      idempotency_key: request.idempotency_key,
      tool_name: request.tool_name,
      operation: request.operation,
      request_sha256: scaBrokerExecuteRequestSha256(request),
      sequence: 0,
      phase: "accepted",
      work_units: 0,
      output_bytes: 0,
      result_items: 0,
    });
    if (retainedProgress !== undefined) {
      this.progress = validateScaBrokerJobProgressV1(retainedProgress, this.progress);
    }
  }

  snapshot(): ScaBrokerJobProgressV1 {
    return validateScaBrokerJobProgressV1({ ...this.progress });
  }

  executionStarted(): void {
    if (this.progress.phase !== "accepted") {
      throw new ScaJobOwnerError("failed", "job execution start was reported more than once");
    }
    this.progress = validateScaBrokerJobProgressV1({
      ...this.progress,
      sequence: 1,
      phase: "executing",
    });
  }

  reportWorkMilestone(): void {
    if (this.progress.phase === "accepted") {
      throw new ScaJobOwnerError("failed", "job work was reported before execution started");
    }
    this.progress = validateScaBrokerJobProgressV1({
      ...this.progress,
      sequence: this.nextSequence(),
      work_units: this.progress.work_units + 1,
    });
  }

  reportPersistedOutput(cumulativeBytes: number, cumulativeResultItems: number): void {
    if (this.progress.phase === "accepted") {
      throw new ScaJobOwnerError("failed", "job output was reported before execution started");
    }
    if (
      !Number.isSafeInteger(cumulativeBytes) ||
      !Number.isSafeInteger(cumulativeResultItems) ||
      cumulativeBytes > this.maxOutputBytes ||
      cumulativeResultItems > this.maxResultItems
    ) {
      throw new ScaJobOwnerError(
        "quota_exceeded",
        "persisted output counters exceed accepted request limits"
      );
    }
    if (
      cumulativeBytes < this.progress.output_bytes ||
      cumulativeResultItems < this.progress.result_items ||
      (cumulativeBytes === this.progress.output_bytes &&
        cumulativeResultItems === this.progress.result_items)
    ) {
      throw new ScaJobOwnerError("failed", "persisted output counters must advance monotonically");
    }
    this.progress = validateScaBrokerJobProgressV1({
      ...this.progress,
      sequence: this.nextSequence(),
      phase: "materializing_output",
      output_bytes: cumulativeBytes,
      result_items: cumulativeResultItems,
    });
  }

  private nextSequence(): number {
    if (this.progress.sequence >= SCA_BROKER_PROGRESS_LIMITS_V1.max_sequence) {
      throw new ScaJobOwnerError("quota_exceeded", "job progress sequence limit was reached");
    }
    return this.progress.sequence + 1;
  }
}

interface ScaJobRecord {
  readonly request: ScaBrokerExecuteRequestV1;
  readonly requestSha256: string;
  readonly acceptedAt: string;
  readonly adapter: ScaOperationAdapter | null;
  readonly progress: ScaJobProgressProducer;
  readonly controller: AbortController;
  receipt: ScaBrokerReceiptV1 | null;
  cancellationRequested: boolean;
  unavailable: boolean;
  inactivityTimer: NodeJS.Timeout | undefined;
  cancellationTimer: NodeJS.Timeout | undefined;
  execution: Promise<void> | undefined;
}

export interface ScaJobOwnerOptions {
  readonly adapters: ScaAdapterRegistry;
  readonly now?: () => Date;
  readonly maxRetainedJobs?: number;
  readonly jobStore?: ScaJobStore;
}

function typedFailure(code: ScaBrokerTypedErrorV1["code"], message: string): ScaBrokerTypedErrorV1 {
  return { code, message };
}

function finitePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export class ScaJobOwner {
  private readonly jobs = new Map<string, ScaJobRecord>();
  private readonly now: () => Date;
  private readonly maxRetainedJobs: number;

  constructor(private readonly options: ScaJobOwnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxRetainedJobs = finitePositiveInteger(
      options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS,
      "maxRetainedJobs"
    );
  }

  execute(requestValue: ScaBrokerExecuteRequestV1): ScaBrokerExecuteAcceptedResultV2 {
    const validated = validateScaBrokerExecuteRequestV1(requestValue);
    const snapshot: unknown =
      this.options.jobStore === undefined ? validated : JSON.parse(canonicalJson(validated));
    const request = validateScaBrokerExecuteRequestV1(snapshot);
    const retained = this.options.jobStore?.findDuplicate(request);
    if (retained !== undefined && retained !== null) {
      return this.acceptedResult(this.adopt(retained));
    }
    const adapter = this.options.adapters[request.operation];
    if (adapter === null) {
      throw new ScaJobOwnerError("service_unavailable", "SCA adapter is unavailable");
    }
    for (const existing of this.jobs.values()) {
      try {
        if (classifyScaBrokerIdempotency(existing.request, request) === "duplicate") {
          return this.acceptedResult(existing);
        }
      } catch (error) {
        if (error instanceof ScaBrokerContractError) {
          throw new ScaJobOwnerError(error.code, "SCA job identity conflicts with retained work");
        }
        throw error;
      }
    }
    if (this.jobs.size >= this.maxRetainedJobs) {
      throw new ScaJobOwnerError("quota_exceeded", "SCA retained job limit was reached");
    }

    const requestSha256 = scaBrokerExecuteRequestSha256(request);
    const record: ScaJobRecord = {
      request,
      requestSha256,
      acceptedAt: this.currentDate().toISOString(),
      adapter,
      progress: new ScaJobProgressProducer(request),
      controller: new AbortController(),
      receipt: null,
      cancellationRequested: false,
      unavailable: false,
      inactivityTimer: undefined,
      cancellationTimer: undefined,
      execution: undefined,
    };
    const accepted = this.acceptedResult(record);
    const admission = this.options.jobStore?.admit(request, accepted);
    if (admission?.disposition === "duplicate")
      return this.acceptedResult(this.adopt(admission.job));
    this.jobs.set(requestSha256, record);
    this.renewInactivity(record);
    record.execution = Promise.resolve().then(async () => await this.run(record));
    return accepted;
  }

  poll(requestValue: ScaBrokerPollRequestV1): ScaBrokerPollResultV2 {
    const request = validateScaBrokerPollRequestV1(requestValue);
    const record = this.jobFor(request.request_sha256);
    this.assertJobBinding(record, request);
    this.assertAvailable(record);
    const receipt = record.receipt;
    const progress = record.progress.snapshot();
    const result = {
      schema_id: "penny.sca-broker-poll-result.v2",
      schema_version: 2,
      tenant_id: record.request.tenant_id,
      project_id: record.request.project_id,
      run_id: record.request.run_id,
      job_id: record.request.job_id,
      attempt: record.request.attempt,
      idempotency_key: record.request.idempotency_key,
      tool_name: record.request.tool_name,
      operation: record.request.operation,
      request_sha256: record.requestSha256,
      status: receipt?.terminal_status ?? (progress.phase === "accepted" ? "accepted" : "running"),
      progress,
      partial: receipt?.partial ?? false,
      truncated: receipt?.truncated ?? false,
      output_refs: receipt?.output_refs ?? [],
      result_item_count: receipt?.result_item_count ?? 0,
      failure: receipt?.failure ?? null,
      receipt,
      observed_at: this.currentDate().toISOString(),
    } as const;
    return validateScaBrokerPollResultV2(result, request, record.request);
  }

  cancel(requestValue: ScaBrokerCancelRequestV1): ScaBrokerCancelResultV1 {
    const request = validateScaBrokerCancelRequestV1(requestValue);
    const record = this.jobFor(request.request_sha256);
    this.assertJobBinding(record, request);
    this.assertAvailable(record);
    if (record.receipt !== null) return this.terminalCancelResult(request, record.receipt);

    record.cancellationRequested = true;
    record.controller.abort();
    if (record.inactivityTimer !== undefined) clearTimeout(record.inactivityTimer);
    if (record.cancellationTimer === undefined) {
      record.cancellationTimer = setTimeout(() => {
        if (this.options.jobStore !== undefined) {
          this.markUnavailable(record);
          return;
        }
        this.settleFailure(
          record,
          "failed",
          typedFailure("failed", "SCA job cancellation containment is unverified")
        );
      }, request.timeout_ms);
      record.cancellationTimer.unref();
    }
    return validateScaBrokerCancelResultV1(
      {
        schema_id: "penny.sca-broker-cancel-result.v1",
        schema_version: 1,
        tenant_id: record.request.tenant_id,
        project_id: record.request.project_id,
        run_id: record.request.run_id,
        job_id: record.request.job_id,
        attempt: record.request.attempt,
        idempotency_key: record.request.idempotency_key,
        tool_name: record.request.tool_name,
        operation: record.request.operation,
        request_sha256: record.requestSha256,
        outcome: "cancel_requested",
        terminal_status: null,
        receipt: null,
        error: null,
        observed_at: this.currentDate().toISOString(),
      },
      request,
      record.request
    );
  }

  async shutdown(cleanupTimeoutMs: number): Promise<void> {
    const timeoutMs = finitePositiveInteger(cleanupTimeoutMs, "cleanupTimeoutMs");
    const active = [...this.jobs.values()].filter((record) => record.receipt === null);
    for (const record of active) {
      record.cancellationRequested = true;
      record.controller.abort();
      if (record.inactivityTimer !== undefined) clearTimeout(record.inactivityTimer);
    }
    const executions = active.flatMap((record) =>
      record.execution === undefined ? [] : [record.execution]
    );
    if (executions.length > 0) {
      let cleanupTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled(executions).then(() => undefined),
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      }
    }
    for (const record of active) {
      if (record.receipt === null) {
        if (this.options.jobStore !== undefined) {
          this.markUnavailable(record);
          continue;
        }
        this.settleFailure(
          record,
          "failed",
          typedFailure("failed", "SCA service shutdown left containment unverified")
        );
      }
    }
  }

  private acceptedResult(record: ScaJobRecord): ScaBrokerExecuteAcceptedResultV2 {
    return validateScaBrokerExecuteAcceptedResultV2(
      {
        schema_id: "penny.sca-broker-execute-accepted-result.v2",
        schema_version: 2,
        tenant_id: record.request.tenant_id,
        project_id: record.request.project_id,
        run_id: record.request.run_id,
        job_id: record.request.job_id,
        attempt: record.request.attempt,
        idempotency_key: record.request.idempotency_key,
        tool_name: record.request.tool_name,
        operation: record.request.operation,
        status: "accepted",
        request_sha256: record.requestSha256,
        accepted_at: record.acceptedAt,
        progress:
          this.options.jobStore === undefined
            ? record.progress.snapshot()
            : new ScaJobProgressProducer(record.request).snapshot(),
      },
      record.request
    );
  }

  private async run(record: ScaJobRecord): Promise<void> {
    if (record.receipt !== null || record.unavailable || record.adapter === null) return;
    try {
      record.progress.executionStarted();
      this.renewInactivity(record);
      const context: ScaJobExecutionContext = {
        signal: record.controller.signal,
        reportContainmentUnverified: () => {
          if (this.options.jobStore !== undefined) this.markUnavailable(record);
        },
        reportWorkMilestone: () => {
          if (record.receipt !== null || record.cancellationRequested || record.unavailable) return;
          record.progress.reportWorkMilestone();
          this.renewInactivity(record);
        },
        reportPersistedOutput: (cumulativeBytes, cumulativeResultItems) => {
          if (record.receipt !== null || record.cancellationRequested || record.unavailable) return;
          if (
            cumulativeBytes > record.request.limits.max_output_bytes ||
            cumulativeResultItems > record.request.limits.max_result_items
          ) {
            throw new ScaJobOwnerError(
              "quota_exceeded",
              "job output progress exceeds accepted request limits"
            );
          }
          record.progress.reportPersistedOutput(cumulativeBytes, cumulativeResultItems);
          this.renewInactivity(record);
        },
      };
      const terminal = await record.adapter.run(record.request, context);
      if (record.receipt !== null) return;
      if (record.cancellationRequested) {
        // Only an adapter's verified terminal verdict can settle durable cancellation.
        this.settleTerminal(record, terminal);
        return;
      }
      this.settleTerminal(record, terminal);
    } catch (error) {
      if (record.receipt !== null) return;
      if (this.options.jobStore !== undefined) {
        this.markUnavailable(record);
        return;
      }
      if (record.cancellationRequested || record.controller.signal.aborted) {
        this.settleFailure(
          record,
          "failed",
          typedFailure("failed", "SCA job cancellation containment is unverified")
        );
        return;
      }
      const code = error instanceof ScaJobOwnerError ? error.code : "failed";
      this.settleFailure(
        record,
        "failed",
        typedFailure(code === "quota_exceeded" ? "quota_exceeded" : "failed", "SCA job failed")
      );
    }
  }

  private renewInactivity(record: ScaJobRecord): void {
    if (record.receipt !== null || record.cancellationRequested || record.unavailable) return;
    if (record.inactivityTimer !== undefined) clearTimeout(record.inactivityTimer);
    record.inactivityTimer = setTimeout(() => {
      record.controller.abort();
      if (this.options.jobStore !== undefined) {
        this.markUnavailable(record);
        return;
      }
      this.settleFailure(record, "timed_out", typedFailure("timeout", "SCA job became inactive"));
    }, record.request.limits.timeout_ms);
    record.inactivityTimer.unref();
  }

  private settleTerminal(record: ScaJobRecord, terminal: ScaAdapterTerminalResult): void {
    if (record.receipt !== null) return;
    if (record.unavailable) return;
    const value = this.receiptFor(record, terminal);
    const snapshot: unknown =
      this.options.jobStore === undefined ? value : JSON.parse(canonicalJson(value));
    const receipt = validateScaBrokerReceiptV1(snapshot, record.request);
    try {
      this.options.jobStore?.persistTerminal(
        record.requestSha256,
        receipt,
        record.progress.snapshot()
      );
    } catch {
      // A failed/ambiguous commit cannot be exposed as terminal, even if the adapter finished.
      this.markUnavailable(record);
      return;
    }
    record.receipt = receipt;
    this.clearTimers(record);
  }

  private settleFailure(
    record: ScaJobRecord,
    status: "failed" | "timed_out" | "cancelled",
    failure: ScaBrokerTypedErrorV1
  ): void {
    if (record.receipt !== null) return;
    this.settleTerminal(record, {
      terminal_status: status,
      partial: false,
      truncated: false,
      output_refs: [],
      result_item_count: 0,
      failure,
    });
  }

  private receiptFor(record: ScaJobRecord, terminal: ScaAdapterTerminalResult): ScaBrokerReceiptV1 {
    const terminalDate = this.currentDate();
    const acceptedMs = Date.parse(record.acceptedAt);
    const terminalAt = new Date(Math.max(acceptedMs, terminalDate.getTime())).toISOString();
    return {
      schema_id: "penny.sca-broker-receipt.v1",
      schema_version: 1,
      tenant_id: record.request.tenant_id,
      project_id: record.request.project_id,
      run_id: record.request.run_id,
      job_id: record.request.job_id,
      attempt: record.request.attempt,
      idempotency_key: record.request.idempotency_key,
      receipt_id: `receipt-${record.requestSha256.slice(0, 32)}`,
      tool_name: record.request.tool_name,
      operation: record.request.operation,
      request_sha256: record.requestSha256,
      limits: record.request.limits,
      terminal_status: terminal.terminal_status,
      partial: terminal.partial,
      truncated: terminal.truncated,
      source_snapshot_ref: record.request.source_snapshot_ref,
      config_ref: record.request.config_ref,
      input_refs: record.request.input_refs,
      output_refs: terminal.output_refs,
      result_item_count: terminal.result_item_count,
      failure: terminal.failure,
      accepted_at: record.acceptedAt,
      terminal_at: terminalAt,
    };
  }

  private terminalCancelResult(
    request: ScaBrokerCancelRequestV1,
    receipt: ScaBrokerReceiptV1
  ): ScaBrokerCancelResultV1 {
    return validateScaBrokerCancelResultV1(
      {
        schema_id: "penny.sca-broker-cancel-result.v1",
        schema_version: 1,
        tenant_id: receipt.tenant_id,
        project_id: receipt.project_id,
        run_id: receipt.run_id,
        job_id: receipt.job_id,
        attempt: receipt.attempt,
        idempotency_key: receipt.idempotency_key,
        tool_name: receipt.tool_name,
        operation: receipt.operation,
        request_sha256: receipt.request_sha256,
        outcome: "terminal",
        terminal_status: receipt.terminal_status,
        receipt,
        error: null,
        observed_at: this.currentDate().toISOString(),
      },
      request,
      this.jobFor(receipt.request_sha256).request
    );
  }

  private assertJobBinding(
    record: ScaJobRecord,
    request: ScaBrokerPollRequestV1 | ScaBrokerCancelRequestV1
  ): void {
    if (
      request.tenant_id !== record.request.tenant_id ||
      request.project_id !== record.request.project_id ||
      request.run_id !== record.request.run_id ||
      request.job_id !== record.request.job_id ||
      request.attempt !== record.request.attempt ||
      request.idempotency_key !== record.request.idempotency_key ||
      request.tool_name !== record.request.tool_name ||
      request.operation !== record.request.operation ||
      request.request_sha256 !== record.requestSha256
    ) {
      throw new ScaJobOwnerError("invalid_request", "SCA job request binding does not match");
    }
  }

  private jobFor(requestSha256: string): ScaJobRecord {
    const record = this.jobs.get(requestSha256);
    if (record === undefined) {
      const retained = this.options.jobStore?.get(requestSha256);
      if (retained !== undefined && retained !== null) return this.adopt(retained);
      throw new ScaJobOwnerError("service_unavailable", "SCA job is unavailable");
    }
    return record;
  }

  private adopt(retained: ScaStoredJob): ScaJobRecord {
    const existing = this.jobs.get(retained.accepted.request_sha256);
    if (existing !== undefined) return existing;
    // A reservation is not execution or containment evidence. Never create a runner or timer.
    const recovered: ScaJobRecord = {
      request: retained.request,
      requestSha256: retained.accepted.request_sha256,
      acceptedAt: retained.accepted.accepted_at,
      adapter: null,
      progress: new ScaJobProgressProducer(retained.request, retained.progress),
      controller: new AbortController(),
      receipt: retained.receipt,
      cancellationRequested: false,
      unavailable: retained.receipt === null,
      inactivityTimer: undefined,
      cancellationTimer: undefined,
      execution: undefined,
    };
    this.jobs.set(recovered.requestSha256, recovered);
    return recovered;
  }

  private assertAvailable(record: ScaJobRecord): void {
    if (record.unavailable) {
      throw new ScaJobOwnerError(
        "service_unavailable",
        "SCA job execution or containment is unverified"
      );
    }
  }

  private markUnavailable(record: ScaJobRecord): void {
    record.unavailable = true;
    record.controller.abort();
    this.clearTimers(record);
  }

  private clearTimers(record: ScaJobRecord): void {
    if (record.inactivityTimer !== undefined) clearTimeout(record.inactivityTimer);
    if (record.cancellationTimer !== undefined) clearTimeout(record.cancellationTimer);
    record.inactivityTimer = undefined;
    record.cancellationTimer = undefined;
  }

  private currentDate(): Date {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw new Error("SCA job owner clock is invalid");
    return value;
  }
}
