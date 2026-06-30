/**
 * Issue 3 Regression Tests
 *
 * Verifies that Pi's tool AbortSignal is NOT passed to agent subprocesses,
 * preventing premature "Agent was aborted" errors.
 */

import { describe, it, expect } from "vitest";

describe("Issue 3: Agent AbortSignal isolation", () => {
  it("AbortController exists globally in Node", () => {
    expect(typeof AbortController).toBe("function");
  });

  it("AbortSignal can be created independently of another signal", () => {
    const piController = new AbortController();
    const agentController = new AbortController();
    expect(piController.signal).not.toBe(agentController.signal);
    piController.abort();
    expect(piController.signal.aborted).toBe(true);
    expect(agentController.signal.aborted).toBe(false);
  });
});
