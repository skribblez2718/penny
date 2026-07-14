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
  queryKGEntitiesForScope: vi.fn(async () => []),
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
    reason: overrides.reason ?? "threshold",
    customInstructions: overrides.customInstructions,
    willRetry: overrides.willRetry ?? false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function skillCall(goal: string, id: string, skill = "plan") {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "skill", arguments: { skill_name: skill, goal } }],
  };
}

function skillResult(sessionId: string, toolCallId: string, success = true) {
  return {
    role: "toolResult",
    toolName: "skill",
    toolCallId,
    content: JSON.stringify({ success, session_id: sessionId }),
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
    expect(result.compaction.details.schema_version).toBe("2.3.0");
    expect(result.compaction.details.files.read).toContain("/tmp/read.md");
    expect(result.compaction.details.files.modified).toContain("/tmp/written.md");
    expect(result.compaction.details.files.modified).toContain("/tmp/edited.md");
    // No filler constraints
    expect(result.compaction.details.constraints).toEqual([]);
  });

  it("surfaces a SCOPED engine run in prose and RESUME-REFS", async () => {
    // The run's session is bound to THIS conversation by a skill call/result in
    // the window, so it is scoped (not a stale cross-session run).
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

    const event = createMockEvent({
      preparation: {
        firstKeptEntryId: "fkid-1",
        tokensBefore: 15000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        messagesToSummarize: [
          skillCall("Migrate research skill onto engine", "tc-1", "code"),
          skillResult("code-1751700000000", "tc-1"),
        ],
      },
    });
    const result = await pi.emit("session_before_compact", event);

    expect(result.compaction.summary).toContain("## In-Flight Orchestration Runs");
    expect(result.compaction.summary).toContain("[RESUME-REFS v2]");
    expect(result.compaction.summary).toContain(
      'resume=skill(skill_name="code", resumeFrom="code-1751700000000")'
    );
    expect(result.compaction.details.engine_runs).toHaveLength(1);
    expect(result.compaction.details.goal).toBe("Migrate research skill onto engine");
  });

  it("excludes a STALE cross-session run from prose, surfacing it only in refs", async () => {
    // A pending run whose session is NOT referenced by this conversation (no
    // skill call/result, no prior refs) is the reported staleness symptom.
    engineRunsMock.mockResolvedValueOnce([
      {
        run_id: "old-x",
        session_id: "plan-9999999999999",
        playbook: "plan",
        current_state_id: "critiquing",
        status: "awaiting_user",
        goal: "An OLD goal from a previous session",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const event = createMockEvent({
      preparation: {
        firstKeptEntryId: "fkid-1",
        tokensBefore: 15000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        messagesToSummarize: [
          { role: "user", content: "Please help me refactor the token estimator module" },
        ],
      },
    });
    const result = await pi.emit("session_before_compact", event);

    // Goal tracks the fresh user intent, NOT the stale run.
    expect(result.compaction.details.goal).toBe(
      "Please help me refactor the token estimator module"
    );
    expect(result.compaction.details.engine_runs).toHaveLength(0);
    expect(result.compaction.details.other_session_runs).toHaveLength(1);
    // Prose never mentions the stale goal.
    expect(result.compaction.summary).not.toContain("An OLD goal from a previous session");
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

  it("captures event.reason and customInstructions into the named metadata sink", async () => {
    engineRunsMock.mockResolvedValueOnce([]);
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const event = createMockEvent({
      reason: "manual",
      customInstructions: "Focus on the goal-recency fix",
    });
    const result = await pi.emit("session_before_compact", event);

    expect(result.compaction.details.metadata.compaction_reason).toBe("manual");
    expect(result.compaction.details.metadata.custom_instructions).toBe(
      "Focus on the goal-recency fix"
    );
    // customInstructions surfaces as a focus hint under Next Steps.
    expect(result.compaction.summary).toContain("## Next Steps");
    expect(result.compaction.summary).toContain(
      "Focus (from /compact): Focus on the goal-recency fix"
    );
  });

  it("populates metadata.pi_boundary.boundary_shift on compactions after the first", async () => {
    engineRunsMock.mockResolvedValueOnce([]);
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const event = createMockEvent({
      extraEntries: [{ type: "compaction", id: "c1", firstKeptEntryId: "prev-fk" }],
    });
    const result = await pi.emit("session_before_compact", event);

    const shift = result.compaction.details.metadata.pi_boundary.boundary_shift;
    expect(shift).toBeDefined();
    expect(shift.previous).toBe("prev-fk");
    expect(shift.current).toBe("fkid-1");
    expect(shift.compaction_seq).toBe(1);
  });

  it("omits boundary_shift on a session's first compaction", async () => {
    engineRunsMock.mockResolvedValueOnce([]);
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const result = await pi.emit("session_before_compact", createMockEvent());
    expect(result.compaction.details.metadata.pi_boundary.boundary_shift).toBeUndefined();
  });

  it("supersedes a completed skill goal with a later ad-hoc user message", async () => {
    engineRunsMock.mockResolvedValueOnce([]);
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const event = createMockEvent({
      preparation: {
        firstKeptEntryId: "fkid-1",
        tokensBefore: 15000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        messagesToSummarize: [
          skillCall("Design a scoring system", "tc-1"),
          skillResult("plan-1", "tc-1", true),
          { role: "user", content: "Now build the goal-recency compaction fix end to end" },
        ],
      },
    });
    const result = await pi.emit("session_before_compact", event);

    expect(result.compaction.details.goal).toBe(
      "Now build the goal-recency compaction fix end to end"
    );
    expect(result.compaction.details.dominant_skill.superseded).toBe(true);
    // The skill stays listed under Active Skill even though it no longer sets Goal.
    expect(result.compaction.summary).toContain("## Active Skill");
    expect(result.compaction.summary).toContain("superseded by a newer request");
  });

  it("derives a non-default goal from a split-turn window (turnPrefixMessages only)", async () => {
    engineRunsMock.mockResolvedValueOnce([]);
    const pi = createMockPi() as any;
    compactionExtension(pi);

    const event = createMockEvent({
      preparation: {
        firstKeptEntryId: "fkid-1",
        tokensBefore: 15000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        messagesToSummarize: [],
        turnPrefixMessages: [
          { role: "user", content: "Refactor the eviction algorithm for recency weighting" },
        ],
        isSplitTurn: true,
      },
    });
    const result = await pi.emit("session_before_compact", event);

    expect(result.compaction.details.goal).toBe(
      "Refactor the eviction algorithm for recency weighting"
    );
    expect(result.compaction.details.goal).not.toContain("goal not yet extracted");
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
