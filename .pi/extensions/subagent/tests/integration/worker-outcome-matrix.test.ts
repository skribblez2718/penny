import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializePennyState } from "@penny/orchestration/source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestExtensionApi,
  createTestToolInfos,
  isRecord,
  isUnknownFunction,
} from "../../../../lib/tests/test-narrowers.js";
import { readArtifactById } from "../../../artifacts/owner-client.js";
import { discoverAgents } from "../../agents.js";
import type { SubagentDetails } from "../../agent-runner.js";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));

vi.mock("../../chain-artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../chain-artifacts.js")>();
  return {
    ...actual,
    async persistDirectChainOutput(request: Parameters<typeof actual.persistDirectChainOutput>[0]) {
      if (request.output.includes("PERSISTENCE_FAIL")) {
        throw new Error("synthetic persistence failure");
      }
      return actual.persistDirectChainOutput(request);
    },
  };
});

type UpdateCallback = (partial: {
  readonly content: Array<{ type: string; text: string }>;
  readonly details: SubagentDetails;
}) => void;

interface RegisteredSubagentTool {
  readonly name: "subagent";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: UpdateCallback | undefined,
    context: {
      readonly cwd: string;
      readonly hasUI: false;
      readonly sessionManager: { getSessionId(): string };
    }
  ): Promise<{
    readonly isError?: boolean;
    readonly content: Array<{ type: string; text: string }>;
    readonly details: SubagentDetails;
  }>;
}

function isSubagentTool(value: unknown): value is RegisteredSubagentTool {
  return isRecord(value) && value.name === "subagent" && typeof value.execute === "function";
}

function assistantEvent(task: string): Record<string, unknown> {
  const stopReason = task.includes("ABORT")
    ? "aborted"
    : task.includes("ERROR") && !task.includes("PROCESS_ERROR")
      ? "error"
      : "stop";
  const text = task.includes("FALSE_POSITIVE")
    ? "COMPLETED successfully; terminal=completed"
    : `output:${task}`;
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      ...(stopReason === "error" ? { errorMessage: "synthetic provider failure" } : {}),
    },
  };
}

function fakeJsonProcess(task: string) {
  const processDouble = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    processDouble.emit("exit", code, signal);
    processDouble.emit("close", code, signal);
  };
  const kill = vi.fn((signal: NodeJS.Signals) => {
    queueMicrotask(() => finish(null, signal));
    return true;
  });
  const child = Object.assign(processDouble, { stdout, stderr, kill });

  const complete = (): void => {
    const events: Record<string, unknown>[] = [];
    if (!task.includes("NO_MESSAGE")) events.push(assistantEvent(task));
    if (!task.includes("NO_AGENT_END")) events.push({ type: "agent_end" });
    if (events.length > 0) {
      stdout.emit(
        "data",
        Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)
      );
    }
    if (task.includes("WAIT_CANCEL")) return;
    const exitCode = task.includes("PROCESS_ERROR") || task.includes("FALSE_POSITIVE") ? 7 : 0;
    finish(exitCode, null);
    if (task.includes("QUEUE_RACE")) {
      stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "late output after close" }],
              stopReason: "error",
              errorMessage: "late synthetic event",
            },
          })}\n`
        )
      );
    }
  };
  if (task.includes("DELAYED")) setTimeout(complete, 10);
  else queueMicrotask(complete);
  return child;
}

function taskFromArgs(args: readonly string[]): string {
  const task = args.at(-1);
  if (task === undefined || !task.startsWith("Task: ")) {
    throw new Error("spawn fixture did not receive a task argument");
  }
  return task.slice("Task: ".length);
}

describe("subagent JSON-mode worker outcome matrix", () => {
  let sandbox: string;
  let tool: RegisteredSubagentTool;
  let shutdownHandler: (() => Promise<void>) | undefined;
  let spawnedProcess: ReturnType<typeof fakeJsonProcess> | undefined;
  const previousStateRoot = process.env.PENNY_STATE_ROOT;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), "penny-worker-outcome-matrix-"));
    process.env.PENNY_STATE_ROOT = path.join(sandbox, "state");
    initializePennyState(process.cwd(), { env: process.env });
    mockSpawn.mockReset();
    shutdownHandler = undefined;
    spawnedProcess = undefined;
    mockSpawn.mockImplementation((_command: string, args: string[]) => {
      spawnedProcess = fakeJsonProcess(taskFromArgs(args));
      return spawnedProcess;
    });

    let registered: RegisteredSubagentTool | undefined;
    const names = [
      ...new Set(discoverAgents(process.cwd(), "project").agents.flatMap((agent) => agent.tools)),
    ];
    const host = createTestExtensionApi({
      getAllTools: () => createTestToolInfos(names),
      onEvent(event, handler) {
        if (event !== "session_shutdown" || !isUnknownFunction(handler)) return;
        shutdownHandler = async () => {
          await handler({ reason: "test" }, context());
        };
      },
      onRegisterTool(candidate) {
        if (isSubagentTool(candidate)) registered = candidate;
      },
    });
    const extension = await import("../../index.js");
    extension.default(host);
    if (registered === undefined) throw new Error("subagent tool was not registered");
    tool = registered;
  });

  afterEach(() => {
    mockSpawn.mockReset();
    if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
    else process.env.PENNY_STATE_ROOT = previousStateRoot;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function context() {
    return {
      cwd: process.cwd(),
      hasUI: false as const,
      sessionManager: { getSessionId: () => "worker-outcome-parent" },
    };
  }

  async function exactOutputs(details: SubagentDetails): Promise<string[]> {
    if (details.outputArtifactRefs === undefined) {
      throw new Error("worker matrix result omitted artifact references");
    }
    return Promise.all(
      details.outputArtifactRefs.map(async (ref) => {
        const artifact = await readArtifactById({
          artifactId: ref.artifact_id,
          projectRoot: process.cwd(),
          env: process.env,
        });
        return artifact.content.toString("utf8");
      })
    );
  }

  it("exposes completed, cancelled, and failed terminal envelopes in input order", async () => {
    const result = await tool.execute(
      "mixed-json",
      {
        tasks: [
          { agent: "echo", task: "SUCCESS" },
          { agent: "echo", task: "ERROR" },
          { agent: "echo", task: "ABORT" },
        ],
      },
      undefined,
      undefined,
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.details.outcome).toEqual({
      status: "partial_failure",
      total: 3,
      running: 0,
      completed: 1,
      succeeded: 1,
      cancelled: 1,
      failed: 1,
      deliveryNotAttempted: 0,
      deliveryPending: 0,
      delivered: 3,
      deliveryFailed: 0,
      streamingDeliveryFailed: 0,
    });
    expect(result.details.results.map((branch) => branch.terminalOutcome?.status)).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(result.details.outputArtifactRefs).toHaveLength(3);
    await expect(exactOutputs(result.details)).resolves.toEqual([
      "output:SUCCESS",
      "output:ERROR",
      "output:ABORT",
    ]);
    expect(result.content[0]?.text).toContain("1 completed, 1 cancelled, 1 failed");
    expect(result.content[0]?.text).toContain("terminal=completed (assistant_completed)");
    expect(result.content[0]?.text).toContain("terminal=failed (assistant_error)");
    expect(result.content[0]?.text).toContain("terminal=cancelled (assistant_cancelled)");
  });

  it("accepts structured success without agent_end and rejects false-positive text/process exits", async () => {
    const result = await tool.execute(
      "structured-matrix",
      {
        tasks: [
          { agent: "echo", task: "NO_AGENT_END" },
          { agent: "echo", task: "QUEUE_RACE" },
          { agent: "echo", task: "FALSE_POSITIVE" },
          { agent: "echo", task: "NO_MESSAGE" },
        ],
      },
      undefined,
      undefined,
      context()
    );

    expect(result.details.results.map((branch) => branch.terminalOutcome?.status)).toEqual([
      "completed",
      "completed",
      "failed",
      "failed",
    ]);
    expect(result.details.results[0]?.agentEndObserved).toBe(false);
    expect(result.details.results[1]?.errorMessage).toBeUndefined();
    expect(result.details.results[2]?.terminalOutcome).toMatchObject({
      status: "failed",
      reason: "process_exit",
    });
    expect(result.details.results[3]?.terminalOutcome).toMatchObject({
      status: "failed",
      reason: "missing_terminal",
    });
    await expect(exactOutputs(result.details)).resolves.toEqual([
      "output:NO_AGENT_END",
      "output:QUEUE_RACE",
      "COMPLETED successfully; terminal=completed",
      "",
    ]);
    expect(result.content[0]?.text).not.toContain("late output after close");
  });

  it("returns failed single aggregate for completed execution with required persistence failure", async () => {
    const result = await tool.execute(
      "single-persistence",
      { agent: "echo", task: "PERSISTENCE_FAIL" },
      undefined,
      undefined,
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.details.outcome).toMatchObject({
      status: "failed",
      total: 1,
      completed: 1,
      succeeded: 0,
      failed: 0,
      delivered: 0,
      deliveryFailed: 1,
      streamingDeliveryFailed: 0,
    });
    expect(result.details.results[0]?.terminalOutcome).toMatchObject({ status: "completed" });
    expect(result.content[0]?.text).toContain("Parent outcome: aggregate=failed");
    expect(result.content[0]?.text).toContain("terminal=completed (assistant_completed)");
    expect(result.content[0]?.text).toContain("output_delivery=failed");
  });

  it("fails the parent but preserves completed workers and stable sibling order when persistence fails", async () => {
    const result = await tool.execute(
      "persistence",
      {
        tasks: [
          { agent: "echo", task: "DELAYED-SUCCESS-SIBLING" },
          { agent: "echo", task: "PERSISTENCE_FAIL" },
        ],
      },
      undefined,
      undefined,
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.details.outcome).toEqual({
      status: "partial_failure",
      total: 2,
      running: 0,
      completed: 2,
      succeeded: 1,
      cancelled: 0,
      failed: 0,
      deliveryNotAttempted: 0,
      deliveryPending: 0,
      delivered: 1,
      deliveryFailed: 1,
      streamingDeliveryFailed: 0,
    });
    expect(result.details.results.map((branch) => branch.task)).toEqual([
      "DELAYED-SUCCESS-SIBLING",
      "PERSISTENCE_FAIL",
    ]);
    expect(result.details.results.map((branch) => branch.outputArtifactState)).toEqual([
      "persisted",
      "failed",
    ]);
    expect(result.details.results[1]?.terminalOutcome).toMatchObject({ status: "completed" });
    expect(result.details.results[1]?.outputArtifactError).toContain("ARTIFACT_PERSIST_FAILED");
    expect(result.details.outputArtifactRefs).toHaveLength(1);
    await expect(exactOutputs(result.details)).resolves.toEqual(["output:DELAYED-SUCCESS-SIBLING"]);
    expect(result.content[0]?.text).toContain("Parent outcome: aggregate=partial_failure");
    expect(result.content[0]?.text).toContain(
      "terminal=completed (assistant_completed); output_delivery=failed"
    );
  });

  it("returns the terminal model boundary when streaming updates throw or close", async () => {
    const onUpdate = vi.fn(() => {
      throw new Error("update queue closed");
    });
    const result = await tool.execute(
      "callback-failure",
      { agent: "echo", task: "NO_AGENT_END" },
      undefined,
      onUpdate,
      context()
    );

    expect(onUpdate).toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(result.details.results[0]?.terminalOutcome).toMatchObject({ status: "completed" });
    expect(result.details.results[0]?.updateDeliveryState).toBe("failed");
    expect(result.details.results[0]?.updateDeliveryError).toBe("update queue closed");
    expect(result.details.outcome).toMatchObject({
      status: "succeeded",
      completed: 1,
      succeeded: 1,
      deliveryFailed: 0,
      streamingDeliveryFailed: 1,
    });
    expect(result.content[0]?.text).toContain("Parent outcome: aggregate=succeeded");
    expect(result.content[0]?.text).toContain("terminal=completed (assistant_completed)");
    expect(result.content[0]?.text).toContain("streaming_update=failed (update queue closed)");
    expect(result.content[0]?.text).toContain("output:NO_AGENT_END");
  });

  it("classifies cancellation and error process exits without losing partial evidence", async () => {
    const controller = new AbortController();
    const cancelledPromise = tool.execute(
      "cancel-process",
      { agent: "echo", task: "WAIT_CANCEL ABORT" },
      controller.signal,
      undefined,
      context()
    );
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    controller.abort();
    const cancelled = await cancelledPromise;
    expect(cancelled.isError).toBe(true);
    expect(cancelled.details.results[0]?.terminalOutcome).toEqual({
      schema_version: 1,
      status: "cancelled",
      reason: "caller_cancelled",
    });
    expect(cancelled.content[0]?.text).toContain("output:WAIT_CANCEL ABORT");

    const failed = await tool.execute(
      "error-process",
      { agent: "echo", task: "PROCESS_ERROR" },
      undefined,
      undefined,
      context()
    );
    expect(failed.isError).toBe(true);
    expect(failed.details.results[0]?.terminalOutcome).toEqual({
      schema_version: 1,
      status: "failed",
      reason: "process_exit",
    });
    expect(failed.content[0]?.text).toContain("output:PROCESS_ERROR");
  });

  it("finalizes an active extension child once across repeated session shutdown", async () => {
    const execution = tool.execute(
      "session-shutdown",
      { agent: "echo", task: "WAIT_CANCEL" },
      undefined,
      undefined,
      context()
    );
    await vi.waitFor(() => expect(spawnedProcess).toBeDefined());
    if (shutdownHandler === undefined || spawnedProcess === undefined) {
      throw new Error("session shutdown lifecycle fixture was not registered");
    }

    await Promise.all([shutdownHandler(), shutdownHandler()]);
    const result = await execution;
    expect(spawnedProcess.kill).toHaveBeenCalledTimes(1);
    expect(result.details.results[0]?.terminalOutcome).toEqual({
      schema_version: 1,
      status: "cancelled",
      reason: "caller_cancelled",
    });
  });

  it("turns synchronous child-start failure into one failed terminal result", async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("synthetic beginChild failure");
    });

    const result = await tool.execute(
      "spawn-failure",
      { agent: "echo", task: "SPAWN_FAIL" },
      undefined,
      undefined,
      context()
    );
    expect(result.isError).toBe(true);
    expect(result.details.results).toHaveLength(1);
    expect(result.details.results[0]?.terminalOutcome).toEqual({
      schema_version: 1,
      status: "failed",
      reason: "process_lifecycle",
    });
    expect(result.content[0]?.text).toContain("terminal=failed (process_lifecycle)");
    expect(result.content[0]?.text).toContain("synthetic beginChild failure");
  });

  it("stops a chain on required artifact failure without rewriting completed execution", async () => {
    const chain = await tool.execute(
      "chain-persistence",
      {
        chain: [
          { agent: "echo", task: "PERSISTENCE_FAIL" },
          { agent: "echo", task: "SHOULD-NOT-RUN" },
        ],
      },
      undefined,
      undefined,
      context()
    );

    expect(chain.isError).toBe(true);
    expect(chain.details.results).toHaveLength(1);
    expect(chain.details.results[0]?.terminalOutcome).toMatchObject({ status: "completed" });
    expect(chain.details.outcome).toMatchObject({
      status: "failed",
      completed: 1,
      succeeded: 0,
      failed: 0,
      deliveryFailed: 1,
    });
    expect(chain.content[0]?.text).toContain("Parent outcome: aggregate=failed");
    expect(chain.content[0]?.text).toContain("terminal=completed (assistant_completed)");
    expect(chain.content[0]?.text).toContain("output_delivery=failed");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("uses the same terminal contract for chain stop decisions", async () => {
    const chain = await tool.execute(
      "chain-abort",
      {
        chain: [
          { agent: "echo", task: "SUCCESS" },
          { agent: "echo", task: "ABORT" },
          { agent: "echo", task: "SHOULD-NOT-RUN" },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(chain.isError).toBe(true);
    expect(chain.details.outcome).toEqual({
      status: "partial_failure",
      total: 2,
      running: 0,
      completed: 1,
      succeeded: 1,
      cancelled: 1,
      failed: 0,
      deliveryNotAttempted: 0,
      deliveryPending: 0,
      delivered: 2,
      deliveryFailed: 0,
      streamingDeliveryFailed: 0,
    });
    expect(chain.details.results).toHaveLength(2);
    expect(chain.content[0]?.text).toContain("terminal=cancelled (assistant_cancelled)");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});
