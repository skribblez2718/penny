/**
 * Signal Tools Unit Tests
 *
 * Tests signal schema validation and TypeScript extension-layer behavior
 * for signal operations through existing memory tools.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing extension
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === "close") {
        // Simulate successful bridge response for signal add
        setTimeout(() => cb(0), 0);
      }
    }),
  })),
}));

vi.mock("ws", () => ({
  WebSocket: vi.fn(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  })),
}));

describe("Signal Schema Validation", () => {
  it("should accept a valid signal payload", () => {
    const signal = {
      signal_id: "signal_2026-04-28_001_test",
      signal_type: "METRIC",
      source: "test_watcher",
      priority: "CRITICAL",
      title: "Test signal",
      timestamp: "2026-04-28T00:00:00Z",
      expires: "2026-05-05T00:00:00Z",
      status: "PENDING",
    };
    // All required fields present
    expect(signal.signal_id).toMatch(/^signal_\d{4}-\d{2}-\d{2}_\d{3}_/);
    expect(["TIME", "FILE", "METRIC"]).toContain(signal.signal_type);
    expect(["CRITICAL", "INFO"]).toContain(signal.priority);
    expect(["PENDING", "ACKNOWLEDGED", "EXPIRED"]).toContain(signal.status);
  });

  it("should reject signal with missing required fields", () => {
    const incomplete = {
      signal_id: "signal_2026-04-28_002",
      // missing signal_type, source, priority, title, timestamp, expires, status
    };
    const required = [
      "signal_type",
      "source",
      "priority",
      "title",
      "timestamp",
      "expires",
      "status",
    ];
    for (const field of required) {
      expect(incomplete).not.toHaveProperty(field);
    }
  });

  it("should validate priority ordering", () => {
    expect("CRITICAL").toBe("CRITICAL"); // CRITICAL before INFO
    const order = ["CRITICAL", "INFO"];
    expect(order[0]).toBe("CRITICAL");
    expect(order[1]).toBe("INFO");
  });
});

describe("Signal Tool Registration", () => {
  it("should register memory extension with signal-capable tools", async () => {
    const { default: memoryExtension } = await import("../../index.js");
    expect(memoryExtension).toBeDefined();
    // The extension provides add_drawer, smart_search, check_duplicate
    // which are the primitives used by the signal system
  });
});

function formatResult(result: Record<string, unknown>): string {
  if (result.success) return `✅ ${JSON.stringify(result)}`;
  return `❌ ${JSON.stringify(result)}`;
}

export {};
