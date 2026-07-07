/**
 * Progress Heartbeat Tests
 *
 * Tests the ProgressEmitter class and the withAgentTimeout staleness-based
 * timer logic that prevents killing agents that are actively making progress.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: async (_path: string, fn: () => Promise<void>) => fn(),
}));

vi.mock("@mariozechner/pi-tui", () => ({
  Container: class Container {
    addChild() {}
  },
  Spacer: class Spacer {
    constructor(public readonly size = 1) {}
  },
  Text: class Text {
    constructor() {}
  },
}));

import { ProgressEmitter } from "../../../subagent/agent-runner.js";
import { withAgentTimeout, createTimeoutResult } from "../../index.js";

describe("ProgressEmitter", () => {
  it("emits tool_result event when markProgress is called", () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    emitter.on("progress", listener);
    emitter.markProgress({ type: "tool_result", timestamp: 1, detail: "bash" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: "tool_result", timestamp: 1, detail: "bash" });
  });

  it("emits message_end event when markProgress is called", () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    emitter.on("progress", listener);
    emitter.markProgress({ type: "message_end", timestamp: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: "message_end", timestamp: 2 });
  });

  it("emits agent_start event when markProgress is called", () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    emitter.on("progress", listener);
    emitter.markProgress({ type: "agent_start", timestamp: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: "agent_start", timestamp: 3 });
  });

  it("fires multiple rapid progress events correctly", () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    emitter.on("progress", listener);
    emitter.markProgress({ type: "tool_result", timestamp: 1 });
    emitter.markProgress({ type: "message_end", timestamp: 2 });
    emitter.markProgress({ type: "tool_result", timestamp: 3 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not crash when markProgress is called with unexpected shapes", () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    emitter.on("progress", listener);
    emitter.markProgress({ type: "tool_result", timestamp: Date.now() } as any);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("withAgentTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves with agent result when agent completes before any threshold", async () => {
    const agentPromise = Promise.resolve("success");
    const result = await withAgentTimeout(
      agentPromise,
      "test-agent",
      undefined,
      new ProgressEmitter(),
      60_000,
      undefined
    );
    expect(result).toBe("success");
  });

  it("progress events reset staleness timer so agent runs beyond original timeout", async () => {
    const emitter = new ProgressEmitter();
    const agentPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("late-success"), 70_000);
    });

    const timeoutPromise = withAgentTimeout(
      agentPromise,
      "test-agent",
      undefined,
      emitter,
      30_000,
      undefined
    );

    // Advance past the old single-timeout window (30s) but before staleness kill (60s)
    vi.advanceTimersByTime(35_000);
    emitter.markProgress({ type: "tool_result", timestamp: Date.now() });

    // Advance past what would be staleness with old behavior
    vi.advanceTimersByTime(35_000);
    emitter.markProgress({ type: "message_end", timestamp: Date.now() });

    // Advance to agent completion
    vi.advanceTimersByTime(10_000);

    const result = await timeoutPromise;
    expect(result).toBe("late-success");
  });

  it("resolves with staleness kill result when no progress for timeoutMs×2", async () => {
    const emitter = new ProgressEmitter();
    const agentPromise = new Promise<string>(() => {
      // never resolves
    });

    const timeoutPromise = withAgentTimeout(
      agentPromise,
      "test-agent",
      undefined,
      emitter,
      10_000,
      undefined
    );

    // Advance past staleness threshold (20s) + check interval buffer
    vi.advanceTimersByTime(25_000);

    const result = (await timeoutPromise) as any;
    expect(result.stopReason).toBe("timeout");
    expect(result.stderr).toContain("exceeded timeout");
  });

  it("resolves with hard cap kill result when total elapsed exceeds timeoutMs×3 regardless of progress", async () => {
    const emitter = new ProgressEmitter();
    const agentPromise = new Promise<string>(() => {
      // never resolves
    });

    const timeoutPromise = withAgentTimeout(
      agentPromise,
      "test-agent",
      undefined,
      emitter,
      10_000,
      undefined
    );

    // Emit progress every 10s to reset staleness, keep agent "alive"
    const progressInterval = setInterval(() => {
      emitter.markProgress({ type: "tool_result", timestamp: Date.now() });
    }, 10_000);

    // Hard cap is 30s. Check interval fires every 15s (at 15s, 30s, 45s...).
    // At 30s: elapsed=30s, NOT > 30s, so not killed yet.
    // At 45s: elapsed=45s > 30s → hard cap kill.
    vi.advanceTimersByTime(46_000);
    clearInterval(progressInterval);

    const result = (await timeoutPromise) as any;
    expect(result.stopReason).toBe("timeout");
    expect(result.stderr).toContain("exceeded timeout");
  });

  it("resolves with error result (not timeout) when agent promise rejects", async () => {
    const emitter = new ProgressEmitter();
    const agentPromise = Promise.reject(new Error("agent crashed"));

    const result = (await withAgentTimeout(
      agentPromise,
      "test-agent",
      undefined,
      emitter,
      60_000,
      undefined
    )) as any;

    expect(result.stopReason).toBe("error");
    expect(result.stderr).toContain("agent crashed");
  });

  it("falls back to old single-timer behavior when progressEmitter is undefined", async () => {
    const agentPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("should-timeout"), 200_000);
    });

    const timeoutPromise = withAgentTimeout(
      agentPromise,
      "test-agent",
      undefined,
      undefined, // no progressEmitter
      10_000,
      undefined
    );

    vi.advanceTimersByTime(15_000);

    const result = (await timeoutPromise) as any;
    expect(result.stopReason).toBe("timeout");
  });

  it("does not double-resolve when progress fires after agent already resolved", async () => {
    const emitter = new ProgressEmitter();
    const agentPromise = Promise.resolve("done");

    const result = await withAgentTimeout(
      agentPromise,
      "test-agent",
      undefined,
      emitter,
      60_000,
      undefined
    );

    // Simulate a late progress event (e.g., from buffered stdout)
    emitter.markProgress({ type: "tool_result", timestamp: Date.now() });

    expect(result).toBe("done");
    // If there were a double-resolve bug, the promise would have been resolved twice.
    // Since Promise.resolve only returns once, we verify no exception was thrown.
  });

  it("uses fallbackFactory on staleness kill when provided", async () => {
    const emitter = new ProgressEmitter();
    const agentPromise = new Promise<string>(() => {
      // never resolves
    });

    const timeoutPromise = withAgentTimeout(
      agentPromise,
      "test-agent",
      undefined,
      emitter,
      10_000,
      (name) => `fallback-${name}`
    );

    vi.advanceTimersByTime(25_000);

    const result = await timeoutPromise;
    expect(result).toBe("fallback-test-agent");
  });

  it("cleans up listeners and interval when signal is aborted", async () => {
    const emitter = new ProgressEmitter();
    const abortController = new AbortController();
    let resolveAgent: ((value: string) => void) | undefined;
    const agentPromise = new Promise<string>((resolve) => {
      resolveAgent = resolve;
    });

    const timeoutPromise = withAgentTimeout(
      agentPromise,
      "test-agent",
      abortController.signal,
      emitter,
      60_000,
      undefined
    );

    abortController.abort();

    // Simulate agent finishing after abort
    vi.advanceTimersByTime(100);
    resolveAgent!("done");

    const result = await timeoutPromise;
    expect(result).toBe("done");
    expect(emitter.listenerCount("progress")).toBe(0);
  });
});

describe("createTimeoutResult", () => {
  it("returns a SingleResult with timeout stopReason", () => {
    const result = createTimeoutResult("echo", 30_000);
    expect(result.agent).toBe("echo");
    expect(result.stopReason).toBe("timeout");
    expect(result.exitCode).toBe(1);
    expect(result.messages[0].content[0].text).toContain("30s");
  });
});
