/**
 * Unit test: compaction extension hook registration
 *
 * Verifies that the compaction extension registers a handler
 * on the session_before_compact event when loaded.
 */

import { describe, it, expect, vi } from "vitest";
import compactionExtension from "../../index.js";

vi.mock("../../bridge.js", () => ({
  queryMempalaceSkillRooms: vi.fn(async () => []),
  queryKGEntitiesForSession: vi.fn(async () => []),
  queryOutcomeLedgerDecisions: vi.fn(async () => []),
  queryDiaryEscalation: vi.fn(async () => []),
}));

vi.mock("../../pending.js", () => ({
  detectPendingState: vi.fn(async () => null),
}));

function createMockPi() {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const calls: Array<{ event: string; handler: Function }> = [];

  return {
    on: (event: string, handler: (...args: any[]) => any) => {
      calls.push({ event, handler });
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    _handlers: handlers,
    _calls: calls,
  };
}

describe("compactionExtension hook registration", () => {
  it("registers pi.on('session_before_compact', ...) when extension loads", () => {
    const pi = createMockPi() as any;
    compactionExtension(pi);

    expect(pi._calls.length).toBeGreaterThanOrEqual(1);
    const sessionBeforeCompactCalls = pi._calls.filter(
      (c: any) => c.event === "session_before_compact"
    );
    expect(sessionBeforeCompactCalls.length).toBe(1);
    expect(typeof sessionBeforeCompactCalls[0].handler).toBe("function");
  });

  it("registers exactly one session_before_compact handler", () => {
    const pi = createMockPi() as any;
    compactionExtension(pi);

    expect(pi._handlers["session_before_compact"]).toBeDefined();
    expect(pi._handlers["session_before_compact"].length).toBe(1);
  });
});
