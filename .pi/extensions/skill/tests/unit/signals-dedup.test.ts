/**
 * Signal Dedup Unit Tests
 *
 * Verifies that _signalsSurfacedThisSession prevents checkAndEmitSignals
 * from spawning the signal checker more than once per session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
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

vi.mock("@mariozechner/pi-tui", () => ({
  Container: class Container { addChild() {} },
  Spacer: class Spacer { constructor(public readonly size = 1) {} },
  Text: class Text { constructor() {} },
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: async (_path: string, fn: () => Promise<void>) => fn(),
}));

// Import AFTER mocks so the module loads with mocked dependencies
import { checkAndEmitSignals, _setSignalsSurfacedThisSession } from "../../index.js";

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

describe("checkAndEmitSignals dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setSignalsSurfacedThisSession(false);
  });

  afterEach(() => {
    _setSignalsSurfacedThisSession(false);
    vi.restoreAllMocks();
  });

  it("spawns signal checker when flag is false", async () => {
    const { spawn } = await import("child_process");
    const mockProc = makeMockProc();
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const emit = vi.fn();
    const pending = checkAndEmitSignals("sess-1", emit);

    setTimeout(() => {
      mockProc.emitData(Buffer.from('{"pending":{"critical_count":0,"info_count":0},"presentation":""}'));
      mockProc.emitClose();
    }, 10);

    await pending;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining("python"),
      expect.arrayContaining([expect.stringContaining("session_start_checker.py"), "sess-1"]),
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] })
    );
  });

  it("skips spawning when flag is already true (dedup)", async () => {
    const { spawn } = await import("child_process");
    _setSignalsSurfacedThisSession(true);

    await checkAndEmitSignals("sess-2", vi.fn());

    expect(spawn).not.toHaveBeenCalled();
  });

  it("surfaces signals when counts are non-zero", async () => {
    const { spawn } = await import("child_process");
    const mockProc = makeMockProc();
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const emit = vi.fn();
    const pending = checkAndEmitSignals("sess-3", emit);

    setTimeout(() => {
      mockProc.emitData(
        Buffer.from(
          '{"pending":{"critical_count":1,"info_count":2},"presentation":"⚠️ Critical signal"}'
        )
      );
      mockProc.emitClose();
    }, 10);

    await pending;

    expect(emit).toHaveBeenCalledWith("📡 Pending signals detected:");
    expect(emit).toHaveBeenCalledWith("⚠️ Critical signal");
  });
});
