/**
 * Integration tests for the session_before_compact hook handler.
 *
 * These mock the Pi ExtensionAPI and the bridge layer, and verify:
 * - Handler registers on session_before_compact
 * - A prose summary with [RESUME-REFS] is emitted
 * - Engine checkpointer runs land in the summary and refs
 * - Budget overflow degrades (tightens caps) instead of abandoning
 */

import { describe, it, expect, vi } from "vitest";
import compactionExtension from "../../index.js";

// Mock bridge calls to avoid spawning Python in tests
const engineRunsMock = vi.fn(async () => [] as any[]);
vi.mock("../../bridge.js", () => ({
  queryEngineRuns: (...args: any[]) => engineRunsMock(...args),
  queryMempalaceSkillRooms: vi.fn(async () => []),
  queryMempalaceSkillRoomsForSession: vi.fn(async () => []),
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

  it("emits a valid v2 artifact on a clean session", async () => {
    engineRunsMock.mockResolvedValueOnce([]);
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const event = createMockEvent();
    const result = await pi.emit("session_before_compact", event);

    expect(result).toBeDefined();
    expect(result.cancel).toBeFalsy();
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary).toContain("## Goal");
    expect(result.compaction.firstKeptEntryId).toBe("fkid-1");
    expect(result.compaction.tokensBefore).toBe(15000);
    expect(result.compaction.details).toBeDefined();
    expect(result.compaction.details.schema_version).toBe("2.0.0");
    expect(result.compaction.details.files.read).toContain("/tmp/read.md");
    expect(result.compaction.details.files.modified).toContain("/tmp/written.md");
    expect(result.compaction.details.files.modified).toContain("/tmp/edited.md");
    // No filler constraints
    expect(result.compaction.details.constraints).toEqual([]);
  });

  it("surfaces engine checkpointer runs in prose and RESUME-REFS", async () => {
    engineRunsMock.mockResolvedValueOnce([
      {
        run_id: "code-a1b2c3",
        session_id: "code-1751700000000",
        playbook: "code",
        current_state_id: "VERIFY",
        status: "awaiting_user",
        goal: "Migrate research skill onto engine",
        clarification_text: "Keep the fixture?",
        updated_at: "2026-07-05T12:00:00.000Z",
      },
    ]);
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const result = await pi.emit("session_before_compact", createMockEvent());

    expect(result.compaction.summary).toContain("## In-Flight Orchestration Runs");
    expect(result.compaction.summary).toContain("[RESUME-REFS v2]");
    expect(result.compaction.summary).toContain(
      'resume=skill(skill_name="code", resumeFrom="code-1751700000000")'
    );
    // Engine run goal becomes the session goal when no skill call exists
    expect(result.compaction.details.goal).toBe("Migrate research skill onto engine");
  });

  it("increments compaction_seq for second compaction", async () => {
    engineRunsMock.mockResolvedValueOnce([]);
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

  it("degrades instead of abandoning when the summary overflows the budget", async () => {
    engineRunsMock.mockResolvedValueOnce([]);
    const pi = createMockPi() as any;
    compactionExtension(pi);

    // Enormous file lists → guaranteed overflow of the 6k budget before eviction
    const bigFiles = Array.from({ length: 3000 }, (_, i) => `/very/long/path/segment/file-${i}.md`);
    const event = createMockEvent({
      preparation: {
        firstKeptEntryId: "fkid-1",
        tokensBefore: 15000,
        fileOps: {
          read: new Set(bigFiles),
          written: new Set(),
          edited: new Set(),
        },
      },
    });

    const result = await pi.emit("session_before_compact", event);

    // The old behavior returned undefined (falling back to Pi's default
    // prose) — the worst outcome. The new behavior always emits.
    expect(result).toBeDefined();
    expect(result.compaction.summary).toContain("## Goal");
  });
});
