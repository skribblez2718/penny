/**
 * Skill Extension Integration — Progress Heartbeats
 *
 * Tests the withAgentTimeout staleness timer with mocked extension
 * dependencies, verifying progress events keep an agent alive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: async (_path: string, fn: () => Promise<void>) => fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  Message: {},
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

describe("withAgentTimeout + ProgressEmitter integration", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks progress across the full agent lifecycle with no false kills", async () => {
    // Import here so mocks are applied before module load
    const { withAgentTimeout: wt } = await import("../../index.js");

    const emitter = new ProgressEmitter();
    let agentResolve: ((v: string) => void) | undefined;
    const agentPromise = new Promise<string>((resolve) => {
      agentResolve = resolve;
    });

    // Start withAgentTimeout with a 10s window
    const timeoutPromise = wt(agentPromise, "echo", undefined, emitter, 10_000, undefined);

    // Simulate realistic progress cadence: tool result at 2s, message end at 5s
    vi.advanceTimersByTime(2000);
    emitter.markProgress({ type: "tool_result", timestamp: Date.now(), detail: "bash" });

    vi.advanceTimersByTime(3000);
    emitter.markProgress({ type: "message_end", timestamp: Date.now() });

    // Advance past the original 10s timeout window — agent should NOT be killed
    // because progress resets the staleness clock
    vi.advanceTimersByTime(8000);
    emitter.markProgress({ type: "tool_result", timestamp: Date.now(), detail: "read" });

    // Complete the agent (total elapsed ~13s), still within hard cap (30s)
    vi.advanceTimersByTime(1000);
    agentResolve!("all done");

    const result = await timeoutPromise;
    expect(result).toBe("all done");
  });

  it("emits and records progress for all event types", () => {
    const emitter = new ProgressEmitter();
    const events: Array<{ type: string; detail?: string }> = [];

    emitter.on("progress", (ev) => {
      events.push({ type: ev.type, detail: ev.detail });
    });

    emitter.markProgress({ type: "agent_start", timestamp: Date.now() });
    emitter.markProgress({ type: "tool_result", timestamp: Date.now(), detail: "bash" });
    emitter.markProgress({ type: "message_end", timestamp: Date.now() });

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("agent_start");
    expect(events[1].type).toBe("tool_result");
    expect(events[1].detail).toBe("bash");
    expect(events[2].type).toBe("message_end");
  });
});
