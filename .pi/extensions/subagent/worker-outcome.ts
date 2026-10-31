import type { ObservedPiMessage, SingleResult } from "./agent-runner.js";

export type WorkerFailureReason =
  | "process_lifecycle"
  | "process_exit"
  | "missing_terminal"
  | "assistant_error"
  | "malformed_terminal";

export type WorkerCancellationReason = "caller_cancelled" | "assistant_cancelled";

export type WorkerTerminalEnvelope =
  | {
      readonly schema_version: 1;
      readonly status: "completed";
      readonly reason: "assistant_completed";
    }
  | {
      readonly schema_version: 1;
      readonly status: "cancelled";
      readonly reason: WorkerCancellationReason;
    }
  | {
      readonly schema_version: 1;
      readonly status: "failed";
      readonly reason: WorkerFailureReason;
    };

export type WorkerTerminalClassification =
  | { readonly status: "running"; readonly label: "running" }
  | WorkerTerminalEnvelope;

export type WorkerDeliveryClassification =
  | { readonly status: "not_attempted" }
  | { readonly status: "pending" }
  | { readonly status: "delivered" }
  | { readonly status: "failed"; readonly error: string };

export type WorkerStreamingDeliveryClassification =
  | { readonly status: "not_attempted" }
  | { readonly status: "delivered" }
  | { readonly status: "failed"; readonly error: string };

/**
 * Parent-level disposition. Execution, required artifact delivery, and optional
 * streaming delivery remain separate counts; `succeeded` is the end-to-end
 * count and therefore never includes a required artifact delivery failure.
 */
export interface WorkerOutcomeSummary {
  readonly status: "empty" | "running" | "succeeded" | "partial_failure" | "cancelled" | "failed";
  readonly total: number;
  readonly running: number;
  readonly completed: number;
  readonly succeeded: number;
  readonly cancelled: number;
  /** Execution failures only; artifact delivery failures are counted separately. */
  readonly failed: number;
  readonly deliveryNotAttempted: number;
  readonly deliveryPending: number;
  readonly delivered: number;
  readonly deliveryFailed: number;
  /** Optional streaming callback failures; these do not make the parent unsuccessful. */
  readonly streamingDeliveryFailed: number;
}

const SUCCESSFUL_ASSISTANT_STOP_REASONS = new Set(["stop", "toolUse"]);

function finalAssistantMessage(
  result: SingleResult
): Extract<ObservedPiMessage, { role: "assistant" }> | undefined {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function isCancellationReason(reason: string | undefined): boolean {
  return reason === "aborted" || reason === "cancelled" || reason === "canceled";
}

/**
 * Derive terminal process/model truth only. Artifact and streaming delivery are
 * deliberately outside this envelope: a delivery failure cannot rewrite a
 * successfully computed terminal outcome.
 */
export function deriveWorkerTerminalOutcome(result: SingleResult): WorkerTerminalClassification {
  if (
    result.processState === "pending" ||
    result.processState === "running" ||
    (result.processState === undefined && result.exitCode === -1)
  ) {
    return { status: "running", label: "running" };
  }

  if (
    result.processState === "spawn_error" ||
    result.processState === "setup_failed" ||
    result.processState === "admission_rejected" ||
    result.processState === "drain_timeout" ||
    result.processState === "termination_failed" ||
    result.processState === "close_without_exit"
  ) {
    return { schema_version: 1, status: "failed", reason: "process_lifecycle" };
  }

  if (
    result.processState !== "closed" ||
    result.processExitObserved !== true ||
    result.processCloseObserved !== true ||
    result.exitCode === -1
  ) {
    return { schema_version: 1, status: "failed", reason: "process_lifecycle" };
  }

  // The runner uses the same bounded termination lifecycle for owner lease expiry and
  // caller abort. An actual inactivity termination is a lifecycle failure, not cancellation.
  if (result.inactivityExpired === true) {
    return { schema_version: 1, status: "failed", reason: "process_lifecycle" };
  }

  if (result.wasAborted === true) {
    return { schema_version: 1, status: "cancelled", reason: "caller_cancelled" };
  }

  const finalAssistant = finalAssistantMessage(result);
  const stopReason = finalAssistant?.stopReason ?? result.stopReason;
  if (isCancellationReason(stopReason) || isCancellationReason(result.stopReason)) {
    return { schema_version: 1, status: "cancelled", reason: "assistant_cancelled" };
  }

  if (result.exitCode !== 0) {
    return { schema_version: 1, status: "failed", reason: "process_exit" };
  }

  if (finalAssistant === undefined) {
    return { schema_version: 1, status: "failed", reason: "missing_terminal" };
  }

  if (
    stopReason === "error" ||
    result.stopReason === "error" ||
    finalAssistant.errorMessage !== undefined ||
    result.errorMessage !== undefined
  ) {
    return { schema_version: 1, status: "failed", reason: "assistant_error" };
  }

  if (
    stopReason === undefined ||
    !SUCCESSFUL_ASSISTANT_STOP_REASONS.has(stopReason) ||
    (result.stopReason !== undefined && !SUCCESSFUL_ASSISTANT_STOP_REASONS.has(result.stopReason))
  ) {
    return { schema_version: 1, status: "failed", reason: "malformed_terminal" };
  }

  return { schema_version: 1, status: "completed", reason: "assistant_completed" };
}

/** Seal terminal truth once so late events or best-effort delivery cannot replace it. */
export function sealWorkerTerminalOutcome(result: SingleResult): WorkerTerminalClassification {
  if (result.terminalOutcome !== undefined) return result.terminalOutcome;
  const outcome = deriveWorkerTerminalOutcome(result);
  if (outcome.status !== "running") result.terminalOutcome = outcome;
  return outcome;
}

/** Return the sealed terminal envelope when present; otherwise derive current progress. */
export function classifyWorkerResult(result: SingleResult): WorkerTerminalClassification {
  return result.terminalOutcome ?? deriveWorkerTerminalOutcome(result);
}

export function classifyWorkerDelivery(result: SingleResult): WorkerDeliveryClassification {
  if (result.outputArtifactState === "pending") return { status: "pending" };
  if (
    result.outputArtifactState === "failed" ||
    result.outputArtifactError !== undefined ||
    (result.outputArtifactState === "persisted" && result.outputArtifactRef === undefined) ||
    (result.outputArtifactRequired === true && result.outputArtifactState === undefined)
  ) {
    return {
      status: "failed",
      error:
        result.outputArtifactError ??
        (result.outputArtifactState === "persisted"
          ? "persisted output omitted its exact artifact reference"
          : "required output artifact delivery was not attempted"),
    };
  }
  if (result.outputArtifactState === "persisted" && result.outputArtifactRef !== undefined) {
    return { status: "delivered" };
  }
  return { status: "not_attempted" };
}

export function workerDiagnosticLines(result: SingleResult): readonly string[] {
  const lines: string[] = [];
  const execution = result.errorMessage || result.stderr || undefined;
  if (execution) lines.push(`Execution: ${execution}`);
  if (result.outputArtifactError && result.outputArtifactError !== execution) {
    lines.push(`Artifact delivery: ${result.outputArtifactError}`);
  }
  if (result.updateDeliveryError) {
    lines.push(`Optional streaming update: ${result.updateDeliveryError}`);
  }
  return lines;
}

export function formatWorkerDiagnostics(result: SingleResult): string | undefined {
  const lines = workerDiagnosticLines(result);
  return lines.length === 0 ? undefined : lines.join("\n");
}

export function classifyWorkerStreamingDelivery(
  result: SingleResult
): WorkerStreamingDeliveryClassification {
  if (result.updateDeliveryState === "failed" || result.updateDeliveryError !== undefined) {
    return {
      status: "failed",
      error: result.updateDeliveryError ?? "streaming update callback failed",
    };
  }
  if (result.updateDeliveryState === "delivered") return { status: "delivered" };
  return { status: "not_attempted" };
}

/** Required parent-success blockers. Optional streaming delivery is excluded. */
export function workerResultHasError(result: SingleResult): boolean {
  const terminal = classifyWorkerResult(result);
  return (
    terminal.status === "failed" ||
    terminal.status === "cancelled" ||
    classifyWorkerDelivery(result).status === "failed"
  );
}

/** Stable worker-dimensional text carried in tool content at the model-visible boundary. */
export function formatWorkerOutcomeBoundary(result: SingleResult): string {
  const terminal = classifyWorkerResult(result);
  const delivery = classifyWorkerDelivery(result);
  const streaming = classifyWorkerStreamingDelivery(result);
  const terminalText =
    terminal.status === "running"
      ? "terminal=running"
      : `terminal=${terminal.status} (${terminal.reason})`;
  const deliveryText =
    delivery.status === "failed"
      ? `output_delivery=failed (${delivery.error})`
      : `output_delivery=${delivery.status}`;
  const streamingText =
    streaming.status === "failed"
      ? `streaming_update=failed (${streaming.error})`
      : `streaming_update=${streaming.status}`;
  return `${terminalText}; ${deliveryText}; ${streamingText}`;
}

export function summarizeWorkerResults(results: readonly SingleResult[]): WorkerOutcomeSummary {
  let running = 0;
  let completed = 0;
  let succeeded = 0;
  let cancelled = 0;
  let failed = 0;
  let deliveryNotAttempted = 0;
  let deliveryPending = 0;
  let delivered = 0;
  let deliveryFailed = 0;
  let streamingDeliveryFailed = 0;

  for (const result of results) {
    const outcome = classifyWorkerResult(result);
    const delivery = classifyWorkerDelivery(result);
    if (outcome.status === "running") running += 1;
    else if (outcome.status === "completed") completed += 1;
    else if (outcome.status === "cancelled") cancelled += 1;
    else failed += 1;

    if (delivery.status === "not_attempted") deliveryNotAttempted += 1;
    else if (delivery.status === "pending") deliveryPending += 1;
    else if (delivery.status === "delivered") delivered += 1;
    else deliveryFailed += 1;

    if (
      outcome.status === "completed" &&
      delivery.status !== "pending" &&
      delivery.status !== "failed"
    ) {
      succeeded += 1;
    }
    if (classifyWorkerStreamingDelivery(result).status === "failed") {
      streamingDeliveryFailed += 1;
    }
  }

  let status: WorkerOutcomeSummary["status"];
  if (results.length === 0) status = "empty";
  else if (running > 0 || deliveryPending > 0) status = "running";
  else if (failed === 0 && cancelled === 0 && deliveryFailed === 0) status = "succeeded";
  else if (succeeded > 0) status = "partial_failure";
  else if (failed === 0 && deliveryFailed === 0) status = "cancelled";
  else status = "failed";

  return {
    status,
    total: results.length,
    running,
    completed,
    succeeded,
    cancelled,
    failed,
    deliveryNotAttempted,
    deliveryPending,
    delivered,
    deliveryFailed,
    streamingDeliveryFailed,
  };
}

/** Whether a terminal parent summary must be returned to Pi as an error. */
export function workerOutcomeSummaryHasError(summary: WorkerOutcomeSummary): boolean {
  return (
    summary.status === "partial_failure" ||
    summary.status === "cancelled" ||
    summary.status === "failed"
  );
}

/** Stable parent-level text that cannot claim success beside a required delivery error. */
export function formatWorkerOutcomeSummaryBoundary(summary: WorkerOutcomeSummary): string {
  return (
    `aggregate=${summary.status}; end_to_end_succeeded=${summary.succeeded}/${summary.total}; ` +
    `execution={running:${summary.running},completed:${summary.completed},cancelled:${summary.cancelled},failed:${summary.failed}}; ` +
    `artifact_delivery={not_attempted:${summary.deliveryNotAttempted},pending:${summary.deliveryPending},delivered:${summary.delivered},failed:${summary.deliveryFailed}}; ` +
    `streaming_update={failed:${summary.streamingDeliveryFailed}}`
  );
}
