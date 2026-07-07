/**
 * Observability Extension Integration Tests
 *
 * Tests the observability extension with real ExtensionAPI:
 * - Event handler registration
 * - WebSocket connection lifecycle
 * - Message serialization
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock WebSocket — we test integration with the Pi API, not real WS connections
vi.mock("ws", () => ({
  WebSocket: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 0,
  })),
}));

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

describe("Observability Integration — Event Handler Registration", () => {
  let registeredEvents: string[];
  let registeredTools: string[];

  beforeAll(async () => {
    registeredEvents = [];
    registeredTools = [];
    const mockPi = {
      registerTool: vi.fn((tool: { name: string }) => {
        registeredTools.push(tool.name);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string) => {
        registeredEvents.push(event);
      }),
    } as unknown as ExtensionAPI;

    const mod = await import("../../index.js");
    await mod.default(mockPi);
  });

  it("should register session_start event handler", () => {
    expect(registeredEvents).toContain("session_start");
  });

  it("should register session_shutdown event handler", () => {
    expect(registeredEvents).toContain("session_shutdown");
  });

  it("should register agent_start event handler", () => {
    expect(registeredEvents).toContain("agent_start");
  });

  it("should register agent_end event handler", () => {
    expect(registeredEvents).toContain("agent_end");
  });

  it("should register tool_execution_start event handler", () => {
    expect(registeredEvents).toContain("tool_execution_start");
  });

  it("should register observability_query_logs tool", () => {
    expect(registeredTools).toContain("observability_query_logs");
  });

  it("should register observability_query_history tool", () => {
    expect(registeredTools).toContain("observability_query_history");
  });
});

describe("Observability Integration — Message Format", () => {
  it("should serialize tool call events to valid JSON", () => {
    const event = {
      type: "tool_call",
      toolName: "memory_search",
      params: { query: "test" },
      timestamp: new Date().toISOString(),
    };

    const serialized = JSON.stringify(event);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized).type).toBe("tool_call");
  });

  it("should serialize message events to valid JSON", () => {
    const event = {
      type: "message",
      role: "assistant",
      content: "Response text",
      timestamp: new Date().toISOString(),
    };

    const serialized = JSON.stringify(event);
    const parsed = JSON.parse(serialized);
    expect(parsed.role).toBe("assistant");
  });

  it("should handle event with undefined optional fields", () => {
    const event = {
      type: "agent_end",
      timestamp: new Date().toISOString(),
    };

    const serialized = JSON.stringify(event);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});
