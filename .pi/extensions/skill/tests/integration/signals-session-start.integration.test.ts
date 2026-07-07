/**
 * Skill Extension Integration — Signal Session Start
 *
 * Verifies that the session_start event handler calls checkAndEmitSignals
 * and that the dedup flag prevents double invocation.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
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

vi.mock("../../lib/logger/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  setSessionId: vi.fn(),
}));

vi.mock("../../../subagent/agent-runner.js", () => ({
  discoverAgents: vi.fn(() => []),
  getFinalOutput: vi.fn(),
  resolveSkillContext: vi.fn(),
  runSingleAgent: vi.fn(),
  ProgressEmitter: class ProgressEmitter {
    on() {}
    emit() {}
    markProgress() {}
  },
  mapWithConcurrencyLimit: vi.fn((items: any[], fn: any) => Promise.all(items.map(fn))),
}));

function makeMockProc() {
  let dataCb: ((data: Buffer) => void) | null = null;
  let closeCb: (() => void) | null = null;

  return {
    stdout: {
      on: vi.fn((event: string, cb: any) => {
        if (event === "data") dataCb = cb;
      }),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn((event: string, cb: any) => {
      if (event === "close") closeCb = cb;
      if (event === "error") closeCb = cb;
    }),
    emitData: (buf: Buffer) => dataCb?.(buf),
    emitClose: () => closeCb?.(),
  };
}

describe("session_start signal surfacing", () => {
  let mockPi: any;
  let sessionStartHandler: any;

  // Dynamically import index.js after mocks are established (matches heartbeat.test.ts pattern)
  beforeAll(async () => {
    const index = await import("../../index.js");
    index._setSignalsSurfacedThisSession(false);

    mockPi = {
      on: vi.fn((event: string, handler: any) => {
        if (event === "session_start") {
          sessionStartHandler = handler;
        }
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    };

    index.default(mockPi);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    const index = await import("../../index.js");
    index._setSignalsSurfacedThisSession(false);
    vi.restoreAllMocks();
  });

  it("registers a session_start handler", () => {
    expect(sessionStartHandler).toBeDefined();
    expect(typeof sessionStartHandler).toBe("function");
  });

  it("calls checkAndEmitSignals on session_start and notifies UI", async () => {
    const { spawn } = await import("child_process");
    const mockProc = makeMockProc();
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const notify = vi.fn();
    const ctx = {
      sessionManager: { getSessionId: () => "integration-sess-1" },
      ui: { notify },
    };

    const promise = sessionStartHandler(null, ctx);

    setTimeout(() => {
      mockProc.emitData(
        Buffer.from(
          '{"pending":{"critical_count":1,"info_count":0},"presentation":"⚠️ Test signal"}'
        )
      );
      mockProc.emitClose();
    }, 10);

    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("📡 Pending signals detected:", "info");
  });

  it("resets dedup flag and allows another check on subsequent session_start", async () => {
    const index = await import("../../index.js");
    // The flag should be true from the previous test because checkAndEmitSignals sets it
    expect(index._getSignalsSurfacedThisSession()).toBe(true);

    const { spawn } = await import("child_process");
    const mockProc = makeMockProc();
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const notify = vi.fn();
    const ctx = {
      sessionManager: { getSessionId: () => "integration-sess-2" },
      ui: { notify },
    };

    const promise = sessionStartHandler(null, ctx);

    setTimeout(() => {
      mockProc.emitData(
        Buffer.from('{"pending":{"critical_count":0,"info_count":0},"presentation":""}')
      );
      mockProc.emitClose();
    }, 10);

    await promise;

    // After a fresh session_start, the handler resets the flag to false
    // then calls checkAndEmitSignals which sets it back to true.
    expect(index._getSignalsSurfacedThisSession()).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
