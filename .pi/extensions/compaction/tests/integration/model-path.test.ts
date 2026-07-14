/**
 * Integration: the model-owned prose path and the LOAN fallback/ablation
 * branch of the session_before_compact handler.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import compactionExtension from "../../index.js";

const generateModelSummaryMock = vi.fn();

vi.mock("../../bridge.js", () => ({
  queryEngineRuns: vi.fn(async () => []),
  queryMempalaceSkillRooms: vi.fn(async () => []),
  queryMempalaceSkillRoomsForSession: vi.fn(async () => []),
  queryKGEntitiesForScope: vi.fn(async () => []),
  queryOutcomeLedgerDecisions: vi.fn(async () => []),
  queryDiaryEscalation: vi.fn(async () => []),
}));
vi.mock("../../pending.js", () => ({ detectPendingState: vi.fn(async () => null) }));
vi.mock("../../summarizer.js", () => ({
  // renderGroundedDigest is called by index during buildArtifact.
  renderGroundedDigest: vi.fn(() => "grounded digest"),
  generateModelSummary: (...args: any[]) => generateModelSummaryMock(...args),
}));

function createMockPi() {
  const handlers: Record<string, Array<(...a: any[]) => any>> = {};
  return {
    on: (event: string, handler: (...a: any[]) => any) => {
      (handlers[event] ||= []).push(handler);
    },
    emit: async (event: string, ev: any, ctx: any) => {
      for (const h of handlers[event] || []) {
        const r = await h(ev, ctx);
        if (r != null) return r;
      }
      return undefined;
    },
  };
}

function mockEvent() {
  return {
    preparation: {
      firstKeptEntryId: "fk-1",
      tokensBefore: 15000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      previousSummary: undefined,
      messagesToSummarize: [
        { role: "user", content: "Refactor the token estimator module please" },
      ],
      turnPrefixMessages: [],
    },
    branchEntries: [{ type: "session", sessionId: "sess-1", id: "e1" }],
    reason: "threshold",
    signal: new AbortController().signal,
  };
}

const ctx = { model: { provider: "anthropic", id: "claude-x" }, modelRegistry: {} };

afterEach(() => {
  generateModelSummaryMock.mockReset();
  delete process.env.PENNY_ABLATE_COMPACTION_DETERMINISTIC_SUMMARY;
});

describe("model-owned prose path", () => {
  it("uses the model prose and appends code-owned RESUME-REFS", async () => {
    generateModelSummaryMock.mockResolvedValueOnce({
      prose: "## Goal\nRefactor the token estimator\n## Critical Context\n- uses tiktoken",
      model: "anthropic/claude-x",
    });
    const pi = createMockPi() as any;
    compactionExtension(pi);
    const result = await pi.emit("session_before_compact", mockEvent(), ctx);

    expect(result.compaction.summary).toContain("Refactor the token estimator");
    expect(result.compaction.details.summary_source).toBe("model");
    expect(result.compaction.details.summary_model).toBe("anthropic/claude-x");
    expect(result.compaction.details.prose_summary).toContain("## Goal");
    // artifact.goal is kept consistent with the model's brief.
    expect(result.compaction.details.goal).toBe("Refactor the token estimator");
  });

  it("falls back to the deterministic prose when the model path fails", async () => {
    generateModelSummaryMock.mockResolvedValueOnce(null);
    const pi = createMockPi() as any;
    compactionExtension(pi);
    const result = await pi.emit("session_before_compact", mockEvent(), ctx);

    expect(result).toBeDefined();
    expect(result.compaction.details.summary_source).toBe("deterministic_fallback");
    expect(result.compaction.summary).toContain("## Goal");
    // Deterministic goal comes from the newest substantive user message.
    expect(result.compaction.details.goal).toBe("Refactor the token estimator module please");
  });

  it("yields to Pi's default (returns undefined) when model fails AND the loan is ablated", async () => {
    process.env.PENNY_ABLATE_COMPACTION_DETERMINISTIC_SUMMARY = "1";
    generateModelSummaryMock.mockResolvedValueOnce(null);
    const pi = createMockPi() as any;
    compactionExtension(pi);
    const result = await pi.emit("session_before_compact", mockEvent(), ctx);

    expect(result).toBeUndefined();
  });
});
