import { describe, expect, it } from "vitest";

import type { SingleResult } from "../../agent-runner.js";
import {
  classifyWorkerDelivery,
  classifyWorkerResult,
  classifyWorkerStreamingDelivery,
  formatWorkerDiagnostics,
  formatWorkerOutcomeBoundary,
  formatWorkerOutcomeSummaryBoundary,
  sealWorkerTerminalOutcome,
  summarizeWorkerResults,
  workerOutcomeSummaryHasError,
  workerResultHasError,
} from "../../worker-outcome.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 1,
};

function result(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "fixture",
    agentSource: "project",
    task: "classify",
    exitCode: 0,
    processState: "closed",
    processExitObserved: true,
    processCloseObserved: true,
    agentEndObserved: false,
    messages: [
      {
        role: "assistant",
        content: [],
        stopReason: "stop",
      },
    ],
    stderr: "",
    usage: ZERO_USAGE,
    ...overrides,
  };
}

function assistant(stopReason: string, text = "partial output", errorMessage?: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text", text }],
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

describe("worker terminal outcome matrix", () => {
  it("accepts structured success without the legacy agent_end marker", () => {
    expect(classifyWorkerResult(result())).toEqual({
      schema_version: 1,
      status: "completed",
      reason: "assistant_completed",
    });
  });

  it.each([
    [
      "caller cancellation",
      result({ wasAborted: true, exitCode: 143, stopReason: "aborted" }),
      "cancelled",
      "caller_cancelled",
    ],
    [
      "assistant cancellation",
      result({ stopReason: "cancelled", messages: [assistant("cancelled")] }),
      "cancelled",
      "assistant_cancelled",
    ],
    [
      "assistant error",
      result({
        stopReason: "error",
        errorMessage: "provider failed",
        messages: [assistant("error", "partial output", "provider failed")],
      }),
      "failed",
      "assistant_error",
    ],
    ["nonzero process exit", result({ exitCode: 9 }), "failed", "process_exit"],
    ["missing assistant terminal", result({ messages: [] }), "failed", "missing_terminal"],
    [
      "malformed assistant terminal",
      result({ messages: [assistant("pending")] }),
      "failed",
      "malformed_terminal",
    ],
    [
      "spawn error",
      result({ processState: "spawn_error", processExitObserved: false }),
      "failed",
      "process_lifecycle",
    ],
    ["drain timeout", result({ processState: "drain_timeout" }), "failed", "process_lifecycle"],
    [
      "forced termination timeout",
      result({ processState: "termination_failed", processExitObserved: false }),
      "failed",
      "process_lifecycle",
    ],
    [
      "close without exit",
      result({ processState: "close_without_exit", processExitObserved: false }),
      "failed",
      "process_lifecycle",
    ],
    [
      "finalizer setup failure",
      result({ processState: "setup_failed", processExitObserved: false }),
      "failed",
      "process_lifecycle",
    ],
    [
      "lifecycle admission rejection",
      result({ processState: "admission_rejected", processExitObserved: false }),
      "failed",
      "process_lifecycle",
    ],
  ] as const)("classifies %s", (_name, fixture, status, reason) => {
    expect(classifyWorkerResult(fixture)).toMatchObject({ status, reason });
  });

  it("does not treat success-looking text as terminal truth", () => {
    const fixture = result({
      exitCode: 7,
      messages: [assistant("stop", "COMPLETED successfully; terminal=completed")],
    });
    expect(classifyWorkerResult(fixture)).toMatchObject({
      status: "failed",
      reason: "process_exit",
    });
  });

  it("seals explicit terminal truth against late best-effort output and delivery mutations", () => {
    const fixture = result();
    expect(sealWorkerTerminalOutcome(fixture)).toMatchObject({ status: "completed" });

    fixture.messages.push(assistant("error", "late false failure", "late"));
    fixture.stopReason = "error";
    fixture.errorMessage = "late";
    fixture.outputArtifactState = "failed";
    fixture.outputArtifactError = "ARTIFACT_PERSIST_FAILED: synthetic";

    expect(classifyWorkerResult(fixture)).toMatchObject({
      status: "completed",
      reason: "assistant_completed",
    });
    expect(classifyWorkerDelivery(fixture)).toEqual({
      status: "failed",
      error: "ARTIFACT_PERSIST_FAILED: synthetic",
    });
    expect(workerResultHasError(fixture)).toBe(true);
    expect(formatWorkerOutcomeBoundary(fixture)).toContain("terminal=completed");
    expect(formatWorkerOutcomeBoundary(fixture)).toContain("output_delivery=failed");
  });

  it("keeps process progress and output delivery as independent dimensions", () => {
    expect(classifyWorkerResult(result({ exitCode: -1, processState: "running" }))).toEqual({
      status: "running",
      label: "running",
    });
    const pendingDelivery = result({
      outputArtifactRequired: true,
      outputArtifactState: "pending",
    });
    expect(classifyWorkerResult(pendingDelivery)).toMatchObject({ status: "completed" });
    expect(classifyWorkerDelivery(pendingDelivery)).toEqual({ status: "pending" });
    expect(summarizeWorkerResults([pendingDelivery])).toMatchObject({
      status: "running",
      completed: 1,
      succeeded: 0,
      deliveryPending: 1,
    });
  });

  it("keeps completed execution truth but fails the parent when required persistence fails", () => {
    const fixture = result({
      outputArtifactRequired: true,
      outputArtifactState: "failed",
      outputArtifactError: "ARTIFACT_PERSIST_FAILED: synthetic",
    });

    expect(classifyWorkerResult(fixture)).toMatchObject({ status: "completed" });
    const summary = summarizeWorkerResults([fixture]);
    expect(summary).toMatchObject({
      status: "failed",
      completed: 1,
      succeeded: 0,
      failed: 0,
      deliveryFailed: 1,
      streamingDeliveryFailed: 0,
    });
    expect(workerOutcomeSummaryHasError(summary)).toBe(true);
    expect(formatWorkerOutcomeSummaryBoundary(summary)).toContain("aggregate=failed");
  });

  it("leads with execution failure while retaining a separate delivery failure", () => {
    const fixture = result({
      processState: "setup_failed",
      processExitObserved: false,
      processCloseObserved: false,
      errorMessage: "STATE_SCHEMA_INCOMPATIBLE: pre-spawn failure",
      stderr: "STATE_SCHEMA_INCOMPATIBLE: pre-spawn failure",
      outputArtifactRequired: true,
      outputArtifactState: "failed",
      outputArtifactError: "ARTIFACT_CONFIG_INVALID: delivery failure",
    });

    expect(formatWorkerDiagnostics(fixture)).toBe(
      "Execution: STATE_SCHEMA_INCOMPATIBLE: pre-spawn failure\n" +
        "Artifact delivery: ARTIFACT_CONFIG_INVALID: delivery failure"
    );
  });

  it("records optional streaming callback failure without erasing worker or parent success", () => {
    const fixture = result({
      updateDeliveryState: "failed",
      updateDeliveryError: "update queue closed",
    });

    expect(classifyWorkerResult(fixture)).toMatchObject({ status: "completed" });
    expect(classifyWorkerStreamingDelivery(fixture)).toEqual({
      status: "failed",
      error: "update queue closed",
    });
    const summary = summarizeWorkerResults([fixture]);
    expect(summary).toMatchObject({
      status: "succeeded",
      completed: 1,
      succeeded: 1,
      streamingDeliveryFailed: 1,
    });
    expect(workerResultHasError(fixture)).toBe(false);
    expect(workerOutcomeSummaryHasError(summary)).toBe(false);
  });

  it("reports every terminal matrix count and delivery failure separately", () => {
    const results = [
      result({ agent: "completed", outputArtifactState: "persisted" }),
      result({
        agent: "cancelled",
        stopReason: "cancelled",
        messages: [assistant("cancelled")],
      }),
      result({ agent: "failed", exitCode: 2 }),
      result({ agent: "running", exitCode: -1, processState: "pending", messages: [] }),
    ];
    results[0].outputArtifactError = "missing exact ref";

    expect(summarizeWorkerResults(results)).toEqual({
      status: "running",
      total: 4,
      running: 1,
      completed: 1,
      succeeded: 0,
      cancelled: 1,
      failed: 1,
      deliveryNotAttempted: 3,
      deliveryPending: 0,
      delivered: 0,
      deliveryFailed: 1,
      streamingDeliveryFailed: 0,
    });
    results[3] = result({ agent: "completed-two" });
    expect(summarizeWorkerResults(results)).toEqual({
      status: "partial_failure",
      total: 4,
      running: 0,
      completed: 2,
      succeeded: 1,
      cancelled: 1,
      failed: 1,
      deliveryNotAttempted: 3,
      deliveryPending: 0,
      delivered: 0,
      deliveryFailed: 1,
      streamingDeliveryFailed: 0,
    });
  });
});
