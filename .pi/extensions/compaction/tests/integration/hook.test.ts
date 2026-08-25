/**
 * Integration tests for the session_before_compact hook handler.
 *
 * These mock the Pi ExtensionAPI and exact checkpointer reader, and verify:
 * - Handler registers on session_before_compact
 * - A prose summary with [RESUME-REFS] is emitted
 * - Engine checkpointer runs land in the summary and refs
 * - Budget overflow degrades (tightens caps) instead of abandoning
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializePennyState } from "@penny/orchestration/source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../index.js";
import type { CheckpointReadResult } from "../../checkpointer.js";
import { createMockCompactionPi, type CompactionEvent } from "../fixtures/compaction-pi.js";

const engineRunsMock = vi.fn<
  (runIds: readonly string[], projectRoot: string) => CheckpointReadResult
>(() => ({ runs: [], artifactRefs: [], issues: [] }));
let sandbox: string;
let projectRoot: string;
const previousStateRoot = process.env.PENNY_STATE_ROOT;
const previousArtifactRoot = process.env.PENNY_ARTIFACT_ROOT;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "penny-compaction-hook-test-"));
  projectRoot = path.join(sandbox, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  process.env.PENNY_STATE_ROOT = path.join(sandbox, "state");
  delete process.env.PENNY_ARTIFACT_ROOT;
  initializePennyState(projectRoot, { env: process.env });
});

afterEach(() => {
  if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = previousStateRoot;
  if (previousArtifactRoot === undefined) delete process.env.PENNY_ARTIFACT_ROOT;
  else process.env.PENNY_ARTIFACT_ROOT = previousArtifactRoot;
  rmSync(sandbox, { recursive: true, force: true });
});
vi.mock("../../checkpointer.js", () => ({
  readExactCheckpoints: (runIds: readonly string[], root: string) => engineRunsMock(runIds, root),
}));

vi.mock("../../pending.js", () => ({
  detectPendingState: vi.fn(async () => null),
}));

type MockEventOverrides = Omit<Partial<CompactionEvent>, "preparation"> & {
  preparation?: CompactionEvent["preparation"];
  extraEntries?: CompactionEvent["branchEntries"];
};

function createMockEvent(overrides: MockEventOverrides = {}): CompactionEvent {
  const preparation = {
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
  };
  const branchEntries = [
    { type: "session", sessionId: "sess-abc" },
    ...(overrides.extraEntries || []),
  ];
  return {
    preparation,
    branchEntries,
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

function skillResult(sessionId: string, toolCallId: string, success = true, runId?: string) {
  const details = { success, session_id: sessionId, ...(runId ? { run_id: runId } : {}) };
  return {
    role: "toolResult",
    toolName: "skill",
    toolCallId,
    content: JSON.stringify(details),
    details,
  };
}

describe("compactionExtension", () => {
  it("registers a session_before_compact handler", () => {
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);
    expect(pi.handlers).toHaveLength(1);
  });

  it("emits a valid v2 artifact on a clean session", async () => {
    engineRunsMock.mockReturnValueOnce({ runs: [], artifactRefs: [], issues: [] });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

    const event = createMockEvent();
    const result = await pi.emitRequired(event);

    expect(result).toBeDefined();
    expect(result.cancel).toBeFalsy();
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary).toContain("## Goal");
    expect(result.compaction.firstKeptEntryId).toBe("fkid-1");
    expect(result.compaction.tokensBefore).toBe(15000);
    expect(result.compaction.details).toBeDefined();
    expect(result.compaction.details.schema_version).toBe("3.0.0");
    expect(result.compaction.details.files.read).toContain("/tmp/read.md");
    expect(result.compaction.details.files.modified).toContain("/tmp/written.md");
    expect(result.compaction.details.files.modified).toContain("/tmp/edited.md");
    // No filler constraints
    expect(result.compaction.details.constraints).toEqual([]);
  });

  it("surfaces an explicitly named run in prose and RESUME-REFS", async () => {
    // The trusted skill result supplies the exact checkpointer key.
    engineRunsMock.mockReturnValueOnce({
      runs: [
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
      ],
      artifactRefs: [],
      issues: [],
    });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

    const event = createMockEvent({
      preparation: {
        firstKeptEntryId: "fkid-1",
        tokensBefore: 15000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        messagesToSummarize: [
          skillCall("Migrate research skill onto engine", "tc-1", "code"),
          skillResult("code-1751700000000", "tc-1", true, "code-a1b2c3"),
        ],
      },
    });
    const result = await pi.emitRequired(event);

    expect(result.compaction.summary).toContain("## In-Flight Orchestration Runs");
    expect(result.compaction.summary).toContain("[RESUME-REFS v2]");
    expect(result.compaction.summary).toContain("run:code-a1b2c3");
    expect(result.compaction.details.engine_runs).toHaveLength(1);
    expect(result.compaction.details.goal).toBe("Migrate research skill onto engine");
  });

  it("does not request or surface an unreferenced pending run", async () => {
    // With no explicit run ID there is no checkpointer lookup or stale-run scan.
    engineRunsMock.mockReturnValueOnce({ runs: [], artifactRefs: [], issues: [] });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

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
    const result = await pi.emitRequired(event);

    // Goal tracks the fresh user intent, NOT the stale run.
    expect(result.compaction.details.goal).toBe(
      "Please help me refactor the token estimator module"
    );
    expect(result.compaction.details.engine_runs).toHaveLength(0);
    expect(engineRunsMock).toHaveBeenCalledWith([], projectRoot);
    // Prose never mentions the stale goal.
    expect(result.compaction.summary).not.toContain("An OLD goal from a previous session");
  });

  it("recovers exact refs when durable memory is unavailable", async () => {
    const previousMemoryBridge = process.env.PI_MEMORY_BRIDGE;
    process.env.PI_MEMORY_BRIDGE = "/definitely/unavailable";
    engineRunsMock.mockReturnValueOnce({
      runs: [
        {
          run_id: "run-fresh-process",
          session_id: "session-fresh",
          playbook: "research",
          current_state_id: "framing",
          status: "running",
          updated_at: "2026-08-15T12:00:00.000Z",
        },
      ],
      artifactRefs: [],
      issues: [],
    });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);
    const event = createMockEvent({
      preparation: {
        firstKeptEntryId: "fkid-1",
        tokensBefore: 15000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        previousSummary: [
          "## Goal",
          "Continue exact run",
          "[RESUME-REFS v2]",
          "run:run-fresh-process",
          "[/RESUME-REFS]",
        ].join("\n"),
      },
    });
    const result = await pi.emitRequired(event);
    expect(engineRunsMock).toHaveBeenCalledWith(["run-fresh-process"], projectRoot);
    expect(result.compaction.summary).toContain("run:run-fresh-process");
    if (previousMemoryBridge === undefined) delete process.env.PI_MEMORY_BRIDGE;
    else process.env.PI_MEMORY_BRIDGE = previousMemoryBridge;
  });

  it("increments compaction_seq for second compaction", async () => {
    engineRunsMock.mockReturnValueOnce({ runs: [], artifactRefs: [], issues: [] });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

    const event = createMockEvent({
      extraEntries: [{ type: "compaction" }, { type: "compaction" }],
    });
    const result = await pi.emitRequired(event);

    expect(result.compaction.details.compaction_seq).toBe(2);
  });

  it("captures event.reason and customInstructions into the named metadata sink", async () => {
    engineRunsMock.mockReturnValueOnce({ runs: [], artifactRefs: [], issues: [] });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

    const event = createMockEvent({
      reason: "manual",
      customInstructions: "Focus on the goal-recency fix",
    });
    const result = await pi.emitRequired(event);

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
    engineRunsMock.mockReturnValueOnce({ runs: [], artifactRefs: [], issues: [] });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

    const event = createMockEvent({
      extraEntries: [{ type: "compaction", firstKeptEntryId: "prev-fk" }],
    });
    const result = await pi.emitRequired(event);

    const piBoundary = result.compaction.details.metadata.pi_boundary;
    expect(piBoundary).toBeDefined();
    if (!piBoundary) throw new Error("pi boundary metadata was not emitted");
    const shift = piBoundary.boundary_shift;
    expect(shift).toBeDefined();
    if (!shift) throw new Error("boundary shift metadata was not emitted");
    expect(shift.previous).toBe("prev-fk");
    expect(shift.current).toBe("fkid-1");
    expect(shift.compaction_seq).toBe(1);
  });

  it("omits boundary_shift on a session's first compaction", async () => {
    engineRunsMock.mockReturnValueOnce({ runs: [], artifactRefs: [], issues: [] });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

    const result = await pi.emitRequired(createMockEvent());
    expect(result.compaction.details.metadata.pi_boundary?.boundary_shift).toBeUndefined();
  });

  it("supersedes a completed skill goal with a later ad-hoc user message", async () => {
    engineRunsMock.mockReturnValueOnce({ runs: [], artifactRefs: [], issues: [] });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

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
    const result = await pi.emitRequired(event);

    expect(result.compaction.details.goal).toBe(
      "Now build the goal-recency compaction fix end to end"
    );
    const dominantSkill = result.compaction.details.dominant_skill;
    expect(dominantSkill).toBeDefined();
    if (!dominantSkill) throw new Error("dominant skill metadata was not emitted");
    expect(dominantSkill.superseded).toBe(true);
    // The skill stays listed under Active Skill even though it no longer sets Goal.
    expect(result.compaction.summary).toContain("## Active Skill");
    expect(result.compaction.summary).toContain("superseded by a newer request");
  });

  it("derives a non-default goal from a split-turn window (turnPrefixMessages only)", async () => {
    engineRunsMock.mockReturnValueOnce({ runs: [], artifactRefs: [], issues: [] });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

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
    const result = await pi.emitRequired(event);

    expect(result.compaction.details.goal).toBe(
      "Refactor the eviction algorithm for recency weighting"
    );
    expect(result.compaction.details.goal).not.toContain("goal not yet extracted");
  });

  it("degrades instead of abandoning when the summary overflows the budget", async () => {
    engineRunsMock.mockReturnValueOnce({ runs: [], artifactRefs: [], issues: [] });
    const pi = createMockCompactionPi({ cwd: projectRoot });
    compactionExtension(pi.api);

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

    const result = await pi.emitRequired(event);

    // The old behavior returned undefined (falling back to Pi's default
    // prose) — the worst outcome. The new behavior always emits.
    expect(result).toBeDefined();
    expect(result.compaction.summary).toContain("## Goal");
  });
});
