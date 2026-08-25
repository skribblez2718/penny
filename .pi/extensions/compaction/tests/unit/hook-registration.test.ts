/**
 * Unit test: compaction extension hook registration
 *
 * Verifies that the compaction extension registers a handler
 * on the session_before_compact event when loaded.
 */

import { describe, it, expect, vi } from "vitest";
import compactionExtension from "../../index.js";
import { createMockCompactionPi } from "../fixtures/compaction-pi.js";

vi.mock("../../checkpointer.js", () => ({
  readExactCheckpoints: vi.fn(() => ({ runs: [], artifactRefs: [], issues: [] })),
}));

vi.mock("../../pending.js", () => ({
  detectPendingState: vi.fn(async () => null),
}));

describe("compactionExtension hook registration", () => {
  it("registers pi.on('session_before_compact', ...) when extension loads", () => {
    const pi = createMockCompactionPi();
    compactionExtension(pi.api);

    expect(pi.calls.length).toBeGreaterThanOrEqual(1);
    const sessionBeforeCompactCalls = pi.calls.filter(
      (call) => call.event === "session_before_compact"
    );
    expect(sessionBeforeCompactCalls.length).toBe(1);
    expect(typeof sessionBeforeCompactCalls[0].handler).toBe("function");
  });

  it("registers exactly one session_before_compact handler", () => {
    const pi = createMockCompactionPi();
    compactionExtension(pi.api);

    expect(pi.handlers).toHaveLength(1);
  });
});
