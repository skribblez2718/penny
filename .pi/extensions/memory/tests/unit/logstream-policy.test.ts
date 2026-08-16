import { describe, expect, it, vi } from "vitest";

import {
  MemoryError,
  createMemoryExtension,
  loadMemoryRuntimeConfig,
  primaryLogstreamToolNames,
} from "../../index.js";
import { extensionEnv } from "../fixtures.js";

function advisoryEnv(overrides: Record<string, string | undefined> = {}) {
  return extensionEnv({
    PENNY_MEMORY_LOGSTREAM_MODE: "primary-advisory",
    PENNY_MEMORY_LOGSTREAM_STREAM: "project/advisory",
    PENNY_MEMORY_LOGSTREAM_ROOMS: "status,questions",
    ...overrides,
  });
}

function recordTools(env: Record<string, string | undefined>) {
  const tools: any[] = [];
  const handlers: string[] = [];
  const fetchSpy = vi.fn();
  createMemoryExtension({ env, fetch: fetchSpy as typeof fetch })({
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand: vi.fn(),
    on(event: string) {
      handlers.push(event);
    },
  } as any);
  return { tools, handlers, fetchSpy };
}

describe("strict primary advisory logstream configuration", () => {
  it("defaults off without requiring stream or rooms", () => {
    const config = loadMemoryRuntimeConfig(extensionEnv());
    expect(config.logstream).toEqual({ mode: "disabled", stream: null, rooms: [] });
  });

  it("loads one safe stream and a frozen nonempty room allowlist", () => {
    const config = loadMemoryRuntimeConfig(advisoryEnv());
    expect(config.logstream).toEqual({
      mode: "primary-advisory",
      stream: "project/advisory",
      rooms: ["status", "questions"],
    });
    expect(Object.isFrozen(config.logstream.rooms)).toBe(true);
  });

  it.each(["on", "advisory", "primary", "read-only"])('rejects unknown mode "%s"', (mode) => {
    expect(() =>
      loadMemoryRuntimeConfig(advisoryEnv({ PENNY_MEMORY_LOGSTREAM_MODE: mode }))
    ).toThrow(/LOGSTREAM_MODE/);
  });

  it("requires hub mode, stream, and nonempty rooms when enabled", () => {
    expect(() => loadMemoryRuntimeConfig(advisoryEnv({ PENNY_MEMORY_MODE: "disabled" }))).toThrow(
      /requires PENNY_MEMORY_MODE=hub/
    );
    expect(() =>
      loadMemoryRuntimeConfig(advisoryEnv({ PENNY_MEMORY_LOGSTREAM_STREAM: undefined }))
    ).toThrow(/LOGSTREAM_STREAM/);
    expect(() =>
      loadMemoryRuntimeConfig(advisoryEnv({ PENNY_MEMORY_LOGSTREAM_ROOMS: undefined }))
    ).toThrow(/LOGSTREAM_ROOMS/);
    expect(() =>
      loadMemoryRuntimeConfig(advisoryEnv({ PENNY_MEMORY_LOGSTREAM_ROOMS: "" }))
    ).toThrow(/nonempty/);
    expect(() =>
      loadMemoryRuntimeConfig(
        advisoryEnv({ PENNY_MEMORY_PRINCIPAL_ID: `principal-${"x".repeat(256)}` })
      )
    ).toThrow(/PRINCIPAL_ID/);
  });

  it.each([
    "../advisory",
    "/absolute",
    "project/../advisory",
    "https://memory.invalid/stream",
    "Project/advisory",
    "project//advisory",
    `project/${"x".repeat(122)}`,
  ])('rejects unsafe stream "%s"', (stream) => {
    expect(() =>
      loadMemoryRuntimeConfig(advisoryEnv({ PENNY_MEMORY_LOGSTREAM_STREAM: stream }))
    ).toThrow(MemoryError);
  });

  it.each([
    "status,,questions",
    "status,status",
    "Status",
    "status/questions",
    `${"x".repeat(65)}`,
  ])('rejects malformed, duplicate, or overlong rooms "%s"', (rooms) => {
    expect(() =>
      loadMemoryRuntimeConfig(advisoryEnv({ PENNY_MEMORY_LOGSTREAM_ROOMS: rooms }))
    ).toThrow(MemoryError);
  });

  it("rejects more than sixteen rooms", () => {
    const rooms = Array.from({ length: 17 }, (_, index) => `room-${index}`).join(",");
    expect(() =>
      loadMemoryRuntimeConfig(advisoryEnv({ PENNY_MEMORY_LOGSTREAM_ROOMS: rooms }))
    ).toThrow(/1-16/);
  });
});

describe("default-off, primary-only advisory tool registration", () => {
  it("registers no logstream tools by default", () => {
    const { tools } = recordTools(extensionEnv());
    expect(
      tools.map((tool) => tool.name).filter((name) => name.startsWith("memory_logstream_"))
    ).toEqual([]);
  });

  it("adds exactly four primary advisory tools when both modes permit writes", () => {
    const { tools } = recordTools(advisoryEnv());
    const names = tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("memory_logstream_"));
    expect(names).toEqual(primaryLogstreamToolNames({ writeEnabled: true }));
    expect(names).toHaveLength(4);
  });

  it("registers only list/wait during ordinary memory read-only qualification", () => {
    const { tools } = recordTools(advisoryEnv({ PENNY_MEMORY_WRITE_MODE: "disabled" }));
    const names = tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("memory_logstream_"));
    expect(names).toEqual(primaryLogstreamToolNames());
    expect(names).toEqual(["memory_logstream_list", "memory_logstream_wait"]);
  });

  it.each(["", "worker", "skill-driver", "primary", "invented-grant"])(
    "registers no tools or hooks and performs no HTTP for deny marker %s",
    (role) => {
      const { tools, handlers, fetchSpy } = recordTools(advisoryEnv({ PENNY_RUNTIME_ROLE: role }));
      expect(tools).toEqual([]);
      expect(handlers).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it("exposes no principal, stream, metadata, or artifact override in any schema", () => {
    const { tools } = recordTools(advisoryEnv());
    const advisoryTools = tools.filter((tool) => tool.name.startsWith("memory_logstream_"));
    for (const tool of advisoryTools) {
      const properties = Object.keys(tool.parameters.properties);
      expect(properties).not.toEqual(
        expect.arrayContaining([
          "stream",
          "from_agent",
          "to_agent",
          "principal",
          "principal_id",
          "metadata",
          "artifact_ids",
        ])
      );
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  });

  it("fails closed with memory absent or malformed rather than registering advisory tools", () => {
    const absent = recordTools({
      PENNY_MEMORY_LOGSTREAM_MODE: "primary-advisory",
      PENNY_MEMORY_LOGSTREAM_STREAM: "project/advisory",
      PENNY_MEMORY_LOGSTREAM_ROOMS: "status",
    });
    expect(absent.tools).toEqual([]);
    expect(absent.handlers).toEqual([]);
    expect(absent.fetchSpy).not.toHaveBeenCalled();
  });
});
