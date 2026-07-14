import { describe, it, expect, vi, afterEach } from "vitest";
import {
  renderGroundedDigest,
  buildSummarizerMessages,
  stripResumeRefs,
  generateModelSummary,
  _summaryInternals,
  type SummarizerCtx,
} from "../../summarizer.js";
import type { EngineRunRef } from "../../schema.js";

const run = (sid: string, goal: string): EngineRunRef => ({
  run_id: `run-${sid}`,
  session_id: sid,
  playbook: "code",
  current_state_id: "VERIFY",
  status: "awaiting_user",
  goal,
  updated_at: "2026-07-05T00:00:00.000Z",
});

// ============================================================
// renderGroundedDigest (pure)
// ============================================================

describe("renderGroundedDigest", () => {
  it("labels other-session runs distinctly so they are never treated as current", () => {
    const digest = renderGroundedDigest({
      scopedRuns: [run("plan-1", "Current work")],
      otherSessionRuns: [run("stale-9", "Old work")],
      rooms: [],
      decisions: [],
      kgEntities: [],
      pending: null,
      readFiles: [],
      modifiedFiles: [],
    });
    expect(digest).toContain("in-flight runs (this session):");
    expect(digest).toContain("run-plan-1");
    expect(digest).toContain("other pending runs (OTHER sessions");
    expect(digest).toContain("run-stale-9");
  });

  it("is empty when there is nothing grounded", () => {
    expect(
      renderGroundedDigest({
        scopedRuns: [],
        otherSessionRuns: [],
        rooms: [],
        decisions: [],
        kgEntities: [],
        pending: null,
        readFiles: [],
        modifiedFiles: [],
      })
    ).toBe("");
  });
});

// ============================================================
// buildSummarizerMessages (pure)
// ============================================================

describe("buildSummarizerMessages", () => {
  it("states the output contract, the recency constraint, and forbids refs", () => {
    const [msg] = buildSummarizerMessages({
      conversationText: "[User]: do X",
      previousSummary: "## Goal\nold goal",
      digest: "in-flight runs (this session):\n  - code run-1",
      customInstructions: "focus here",
      proseTokenTarget: 4000,
    });
    const text = msg.content[0].text;
    expect(text).toContain("## Goal");
    expect(text).toContain("LATEST substantive intent");
    expect(text).toContain("do not emit a [RESUME-REFS] block");
    expect(text).toContain("PREVIOUS BRIEF");
    expect(text).toContain("GROUNDED STATE");
    expect(text).toContain("FOCUS (from /compact");
    expect(text).toContain("[User]: do X");
  });
});

// ============================================================
// stripResumeRefs (pure)
// ============================================================

describe("stripResumeRefs", () => {
  it("removes a complete refs block a model may have emitted", () => {
    const out = stripResumeRefs("## Goal\nX\n\n[RESUME-REFS v2]\nrun: ...\n[/RESUME-REFS]");
    expect(out).toBe("## Goal\nX");
  });
  it("removes a dangling refs opener too", () => {
    expect(stripResumeRefs("brief\n[RESUME-REFS v2]\nrun: x")).toBe("brief");
  });
});

// ============================================================
// generateModelSummary (mocked seam + stub ctx)
// ============================================================

const savedSerialize = _summaryInternals.serialize;
const savedComplete = _summaryInternals.complete;
afterEach(() => {
  _summaryInternals.serialize = savedSerialize;
  _summaryInternals.complete = savedComplete;
  delete process.env.PI_COMPACTION_SUMMARY_MODEL;
});

function ctxWithModel(): SummarizerCtx {
  return {
    model: { provider: "anthropic", id: "claude-x" },
    modelRegistry: {
      find: () => ({ provider: "anthropic", id: "claude-x" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }),
    },
  };
}

const baseInput = {
  messages: [{ role: "user", content: "do X" }],
  digest: "in-flight runs (this session):\n  - code run-1",
  proseTokenTarget: 4000,
};

describe("generateModelSummary", () => {
  it("returns the model prose (refs stripped) + provider/model id", async () => {
    _summaryInternals.serialize = async () => "[User]: do X";
    _summaryInternals.complete = async () => ({
      content: [{ type: "text", text: "## Goal\nDo X\n[RESUME-REFS v2]\nx\n[/RESUME-REFS]" }],
    });
    const res = await generateModelSummary(baseInput, ctxWithModel());
    expect(res).not.toBeNull();
    expect(res!.prose).toBe("## Goal\nDo X");
    expect(res!.model).toBe("anthropic/claude-x");
  });

  it("passes the serialized conversation + digest into the model call", async () => {
    _summaryInternals.serialize = async () => "[User]: do X";
    const seen: any = {};
    _summaryInternals.complete = async (_m, context) => {
      seen.text = context.messages[0].content[0].text;
      return { content: [{ type: "text", text: "## Goal\nok" }] };
    };
    await generateModelSummary(baseInput, ctxWithModel());
    expect(seen.text).toContain("[User]: do X");
    expect(seen.text).toContain("in-flight runs (this session)");
  });

  it("returns null when no model is resolvable (→ caller falls back)", async () => {
    _summaryInternals.complete = async () => ({ content: [{ type: "text", text: "x" }] });
    const noModel: SummarizerCtx = {
      model: undefined,
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false }) },
    };
    expect(await generateModelSummary(baseInput, noModel)).toBeNull();
  });

  it("returns null on missing auth", async () => {
    _summaryInternals.serialize = async () => "x";
    const ctx: SummarizerCtx = {
      model: { provider: "p", id: "m" },
      modelRegistry: {
        find: () => ({ provider: "p", id: "m" }),
        getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
      },
    };
    expect(await generateModelSummary(baseInput, ctx)).toBeNull();
  });

  it("returns null on empty model output", async () => {
    _summaryInternals.serialize = async () => "x";
    _summaryInternals.complete = async () => ({ content: [{ type: "text", text: "   " }] });
    expect(await generateModelSummary(baseInput, ctxWithModel())).toBeNull();
  });

  it("returns null when the model call throws (timeout/abort/error)", async () => {
    _summaryInternals.serialize = async () => "x";
    _summaryInternals.complete = async () => {
      throw new Error("aborted");
    };
    expect(await generateModelSummary(baseInput, ctxWithModel())).toBeNull();
  });
});
