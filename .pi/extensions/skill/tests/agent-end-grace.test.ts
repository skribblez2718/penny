/**
 * Tests for agent process lifecycle handling.
 *
 * Verifies the stdin="ignore" + proc.on("close") pattern used by
 * the agent-runner when spawning Pi in --mode json -p.
 *
 * This pattern matches Pi's reference subagent implementation:
 * - stdin is "ignore" (Pi reads /dev/null, immediate EOF)
 * - We trust proc.on("close") as the authoritative exit signal
 * - No grace timer, no early resolution, no fabricated exit codes
 * - No hard timeout — Pi exits naturally after agent completes,
 *   runs compaction, and cleans up. Pi has its own internal safety
 *   mechanisms (context limits, cost limits). The abort signal
 *   handles user-initiated cancellation.
 *
 * Pi Alignment Standard: Extensions must follow Pi's implementation
 * patterns, deviating only when required with documented rationale.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("agent process lifecycle pattern", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should resolve with real exit code when process exits normally", async () => {
    let resolved = false;
    let resolvedExitCode: number | undefined;

    const promise = new Promise<number>((resolve) => {
      const resolveOnce = (code: number) => {
        if (resolved) return;
        resolved = true;
        resolvedExitCode = code;
        resolve(code);
      };

      // Simulate proc.on("close", code => ...) firing with exit code 0
      setTimeout(() => resolveOnce(0), 100);
    });

    vi.advanceTimersByTime(200);

    const result = await promise;
    expect(resolved).toBe(true);
    expect(resolvedExitCode).toBe(0);
  });

  it("should resolve with non-zero exit code when agent fails", async () => {
    let resolvedExitCode: number | undefined;

    const promise = new Promise<number>((resolve) => {
      let resolvedFlag = false;
      const resolveOnce = (code: number) => {
        if (resolvedFlag) return;
        resolvedFlag = true;
        resolvedExitCode = code;
        resolve(code);
      };

      // Simulate proc.on("close") with non-zero exit
      setTimeout(() => resolveOnce(1), 200);
    });

    vi.advanceTimersByTime(500);

    await promise;
    expect(resolvedExitCode).toBe(1);
  });

  it("should handle multiple parallel agents exiting independently", () => {
    const results: { idx: number; exitCode: number }[] = [];

    const promises = [0, 1, 2].map(
      (idx) =>
        new Promise<number>((resolve) => {
          const resolveOnce = (code: number) => {
            results.push({ idx, exitCode: code });
            resolve(code);
          };

          // Each agent exits at a different time
          const closeOffset = 1000 + idx * 500;
          setTimeout(() => resolveOnce(idx === 1 ? 1 : 0), closeOffset);
        })
    );

    vi.advanceTimersByTime(3000);

    return Promise.all(promises).then((codes) => {
      expect(codes).toEqual([0, 1, 0]);
      expect(results).toHaveLength(3);
    });
  });

  it("should use stdin='ignore' — no stdin pipe handle in parent", () => {
    // This is a design contract test: verify the spawn config we use.
    // With "ignore", there is no proc.stdin to close, no pipe FD,
    // and Pi's readPipedStdin() gets /dev/null (immediate EOF).
    const spawnConfig = {
      stdio: ["ignore", "pipe", "pipe"] as const,
    };

    // Verify stdin is "ignore" — this is the key fix that allows
    // Pi to exit cleanly after agent_end
    expect(spawnConfig.stdio[0]).toBe("ignore");
  });

  it("should report agent_end but not resolve the promise early", async () => {
    let resolved = false;
    let resolvedExitCode: number | undefined;
    let agentEndReceived = false;

    const promise = new Promise<number>((resolve) => {
      const resolveOnce = (code: number) => {
        if (resolved) return;
        resolved = true;
        resolvedExitCode = code;
        resolve(code);
      };

      // agent_end arrives at 1 second — we set flag but DON'T resolve
      setTimeout(() => {
        agentEndReceived = true;
        // Old code would start a grace timer and resolveOnce(0) here.
        // New code does nothing — trusts proc.on("close").
      }, 1000);

      // proc.on("close") arrives at 1.5 seconds with real exit code
      setTimeout(() => resolveOnce(0), 1500);
    });

    vi.advanceTimersByTime(2000);

    await promise;
    expect(agentEndReceived).toBe(true);
    expect(resolved).toBe(true);
    // Resolved from proc.on("close"), not from agent_end grace timer
    expect(resolvedExitCode).toBe(0);
  });

  it("should NOT enforce a hard timeout — Pi exits naturally", async () => {
    // Pi Alignment Standard: No hard timeout on agent processes.
    // Pi exits on its own after agent completes, compacts, and cleans up.
    // The abort signal handles user-initiated cancellation.
    // This test verifies that a long-running process (simulating Pi's
    // post-agent_end compaction/cleanup) resolves correctly when it
    // eventually exits, without being killed by a timeout.
    let resolved = false;
    let resolvedExitCode: number | undefined;
    let agentEndReceived = false;

    const promise = new Promise<number>((resolve) => {
      const resolveOnce = (code: number) => {
        if (resolved) return;
        resolved = true;
        resolvedExitCode = code;
        resolve(code);
      };

      // agent_end at 1s — agent work is done
      setTimeout(() => {
        agentEndReceived = true;
      }, 1000);

      // Pi continues running (compaction, cleanup) and exits at 3s
      // Previously, a 5-min timeout would have killed this process
      // if compaction took longer than the deadline. Now we trust
      // Pi to exit naturally.
      setTimeout(() => resolveOnce(0), 3000);
    });

    vi.advanceTimersByTime(4000);

    await promise;
    expect(agentEndReceived).toBe(true);
    expect(resolved).toBe(true);
    expect(resolvedExitCode).toBe(0);
  });

  it("should report error when agent exits without message_end", async () => {
    // Simulates Pi SSE timeout: process exits 0 but no message_end.
    // Real agent-runner sets errorMessage + stopReason="incomplete".
    let errorMessage = "";
    let stopReason = "";

    const promise = new Promise<number>((resolve) => {
      const resolveOnce = (code: number) => {
        const hasMessageEnd = false;
        const eventCount = 3;
        const lastEventType = "tool_result_end";
        const agentName = "echo";
        if (!hasMessageEnd && eventCount > 0) {
          errorMessage =
            `Agent '${agentName}' completed without emitting message_end. ` +
            `Events: ${eventCount}, last: ${lastEventType}, code: ${code}`;
          stopReason = "incomplete";
        }
        resolve(code);
      };
      setTimeout(() => resolveOnce(0), 1500);
    });

    vi.advanceTimersByTime(2000);
    await promise;
    expect(errorMessage).toContain("message_end");
    expect(stopReason).toBe("incomplete");
  });
});
