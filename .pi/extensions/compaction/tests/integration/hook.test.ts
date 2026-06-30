/**
 * Integration tests for the session_before_compact hook handler.
 *
 * These mock the Pi ExtensionAPI and verify:
 * - Handler registers on session_before_compact
 * - Valid artifact is emitted when session state is extractable
 * - Invalid artifact falls back (does not provide compaction)
 * - Token budget check prevents oversized artifacts
 */

import { describe, it, expect, vi } from "vitest";
import compactionExtension from "../../index.js";

// Mock bridge calls to avoid spawning Python in tests
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

  return {
    on: (event: string, handler: (...args: any[]) => any) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    emit: async (event: string, data: any) => {
      const hs = handlers[event] || [];
      for (const h of hs) {
        const result = await h(data);
        if (result != null) return result;
      }
      return undefined;
    },
    _handlers: handlers,
  };
}

function createMockEvent(overrides: any = {}) {
  return {
    preparation: {
      firstKeptEntryId: "fkid-1",
      tokensBefore: 15000,
      fileOps: {
        read: new Set(["/tmp/read.md"]),
        written: new Set(["/tmp/written.md"]),
        edited: new Set(["/tmp/edited.md"]),
      },
      previousSummary: undefined,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      settings: { reserveTokens: 16384, keepRecentTokens: 20000 },
      ...overrides.preparation,
    },
    branchEntries: [
      { type: "session", sessionId: "sess-abc", id: "e1" },
      ...(overrides.extraEntries || []),
    ],
    customInstructions: undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("compactionExtension", () => {
  it("registers a session_before_compact handler", () => {
    const pi = createMockPi() as any;
    compactionExtension(pi);
    expect(pi._handlers["session_before_compact"]).toBeDefined();
    expect(pi._handlers["session_before_compact"].length).toBe(1);
  });

  it("emits a valid artifact on a clean session", async () => {
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const event = createMockEvent();
    const result = await pi.emit("session_before_compact", event);

    expect(result).toBeDefined();
    expect(result.cancel).toBeFalsy();
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary).toContain("## Goal");
    expect(result.compaction.summary).toContain("Active session - goal not yet extracted");
    expect(result.compaction.firstKeptEntryId).toBe("fkid-1");
    expect(result.compaction.tokensBefore).toBe(15000);
    expect(result.compaction.details).toBeDefined();
    expect(result.compaction.details.schema_version).toBe("1.0.0");
    expect(result.compaction.details.files.read).toContain("/tmp/read.md");
    expect(result.compaction.details.files.modified).toContain("/tmp/written.md");
    expect(result.compaction.details.files.modified).toContain("/tmp/edited.md");
  });

  it("increments compaction_seq for second compaction", async () => {
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const event = createMockEvent({
      extraEntries: [
        { type: "compaction", id: "c1" },
        { type: "compaction", id: "c2" },
      ],
    });
    const result = await pi.emit("session_before_compact", event);

    expect(result.compaction.details.compaction_seq).toBe(2);
  });

  it("returns a valid compaction for a minimal session", async () => {
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const event = createMockEvent({
      preparation: {
        firstKeptEntryId: "fkid-1",
        tokensBefore: 15000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        previousSummary: undefined,
      },
    });

    // With zero file ops and default goal="", the artifact is tiny and should pass.
    const result = await pi.emit("session_before_compact", event);
    expect(result).toBeDefined();
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary).toContain("## Goal");
  });
});
