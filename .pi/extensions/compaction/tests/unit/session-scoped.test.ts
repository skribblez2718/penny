import { describe, it, expect } from "vitest";
import {
  detectDominantSkill,
  extractSessionState,
  evictArray,
  applyEviction,
} from "../../index.js";

// ============================================================
// detectDominantSkill — real function, real pairing rules
// ============================================================

function skillCall(goal: string, opts: { id?: string; skill?: string; constraints?: any } = {}) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: opts.id,
        name: "skill",
        arguments: {
          skill_name: opts.skill || "plan",
          goal,
          ...(opts.constraints ? { constraints: opts.constraints } : {}),
        },
      },
    ],
  };
}

function skillResult(sessionId: string, success = true, toolCallId?: string) {
  return {
    role: "toolResult",
    toolName: "skill",
    toolCallId,
    content: JSON.stringify({ success, session_id: sessionId }),
  };
}

describe("detectDominantSkill", () => {
  it("detects the skill call and takes session_id from its result", () => {
    const dominant = detectDominantSkill([
      skillCall("Design a scoring system", { id: "tc-1" }),
      skillResult("plan-1751700000000", true, "tc-1"),
    ]);
    expect(dominant).toMatchObject({
      skill_name: "plan",
      session_id: "plan-1751700000000",
      goal: "Design a scoring system",
      completed: true,
    });
  });

  it("NEVER fabricates a session_id when the result carries none", () => {
    // Regression: fabricated `${skill}-${Date.now()}` ids created false
    // addresses — empty string is the honest value.
    const dominant = detectDominantSkill([skillCall("Do the thing")]);
    expect(dominant).not.toBeNull();
    expect(dominant!.session_id).toBe("");
  });

  it("pairs a call with ITS result via toolCallId, not any skill result", () => {
    const dominant = detectDominantSkill([
      skillCall("Old goal", { id: "tc-old" }),
      skillResult("plan-old", true, "tc-old"),
      skillCall("New goal", { id: "tc-new" }),
      // A stale result from a DIFFERENT call sits after the new call
      skillResult("plan-stale", true, "tc-old"),
      skillResult("plan-new", true, "tc-new"),
    ]);
    expect(dominant!.goal).toBe("New goal");
    expect(dominant!.session_id).toBe("plan-new");
  });

  it("most recent invocation wins", () => {
    const dominant = detectDominantSkill([
      skillCall("Old plan", { id: "a" }),
      skillResult("plan-1", true, "a"),
      skillCall("New work", { id: "b" }),
      skillResult("plan-2", true, "b"),
    ]);
    expect(dominant!.goal).toBe("New work");
  });

  it("returns null when no skill tool call exists (no user-intent guessing)", () => {
    // Regression: the old fallback regex-guessed a skill from user text
    const dominant = detectDominantSkill([
      { role: "user", content: "Run the plan skill to design a system" },
      { role: "assistant", content: [{ type: "text", text: "Sure." }] },
    ]);
    expect(dominant).toBeNull();
  });

  it("captures the skill call's constraints object", () => {
    const dominant = detectDominantSkill([
      skillCall("Build it", { id: "c", constraints: { language: "python" } }),
      skillResult("code-9", true, "c"),
    ]);
    expect(dominant!.constraints).toEqual({ language: "python" });
  });
});

// ============================================================
// extractSessionState — explicit sources only
// ============================================================

describe("extractSessionState", () => {
  it("prefers the dominant skill goal", () => {
    const state = extractSessionState(
      [{ role: "user", content: "please help with something else" }],
      { skill_name: "plan", session_id: "s", goal: "Design a scoring system", completed: false }
    );
    expect(state.goal).toBe("Design a scoring system");
  });

  it("a substantive user message beats the engine-run goal (recency, RC3 fix)", () => {
    const state = extractSessionState(
      [{ role: "user", content: "some general chatter here that is substantive" }],
      null,
      "Migrate research skill onto engine"
    );
    // The fresh user intent outranks an exact run's older goal.
    expect(state.goal).toBe("some general chatter here that is substantive");
  });

  it("uses the exact engine-run goal when no substantive user message exists", () => {
    const state = extractSessionState(
      [{ role: "user", content: "ok" }],
      null,
      "Migrate onto engine"
    );
    expect(state.goal).toBe("Migrate onto engine");
  });

  it("does NOT keyword-scrape constraints from user messages", () => {
    // Regression: "must"/"use "/"prefer" substring scraping produced junk
    const state = extractSessionState(
      [{ role: "user", content: "You must be careful. I prefer tabs. Use bun." }],
      null
    );
    expect(state.constraints).toEqual([]);
  });

  it("renders constraints from the skill call's constraints object", () => {
    const state = extractSessionState([], {
      skill_name: "code",
      session_id: "code-1",
      goal: "Build it",
      completed: false,
      constraints: { language: "python", user_response: "yes" },
    });
    expect(state.constraints).toEqual(["language: python"]); // resume-plumbing key skipped
  });

  // ----------------------------------------------------------
  // Newest-first fallback (no keyword denylist) — reworked from the old
  // "skips reactionary user messages" test. Goal must track the LATEST
  // substantive user intent, not the first-seen one.
  // ----------------------------------------------------------

  it("returns the chronologically LATEST substantive user message (newest-first, no denylist)", () => {
    const state = extractSessionState(
      [
        { role: "user", content: "Implement the compaction redesign end to end" },
        { role: "user", content: "actually, focus on fixing the goal-recency bug instead" },
      ],
      null
    );
    // Old denylist code first-seen-scanned and returned message 0. The
    // newest-first scan returns the real latest intent (message 1) — even
    // though it contains words the old denylist would have skipped.
    expect(state.goal).toBe("actually, focus on fixing the goal-recency bug instead");
    expect(state.superseded).toBe(false);
  });

  it("ignores trivial short messages and keeps the latest SUBSTANTIVE one", () => {
    const state = extractSessionState(
      [
        { role: "user", content: "Design a full observability pipeline for compaction" },
        { role: "user", content: "ok" },
        { role: "user", content: "go" },
      ],
      null
    );
    expect(state.goal).toBe("Design a full observability pipeline for compaction");
  });

  it("prefers an INCOMPLETE active skill over any user message (precedence #1)", () => {
    const state = extractSessionState(
      [{ role: "user", content: "some later ad-hoc chatter that is fairly substantive" }],
      { skill_name: "code", session_id: "code-1", goal: "Ship the feature", completed: false }
    );
    expect(state.goal).toBe("Ship the feature");
    expect(state.superseded).toBe(false);
  });

  // ----------------------------------------------------------
  // Completed-then-ad-hoc-follow-up (supersession)
  // ----------------------------------------------------------

  it("supersedes a COMPLETED skill goal with a later substantive user message", () => {
    const messages = [
      skillCall("Design a scoring system", { id: "tc-1" }),
      skillResult("plan-1", true, "tc-1"),
      { role: "user", content: "Now build the compaction goal-recency fix end to end" },
    ];
    const dominant = detectDominantSkill(messages);
    const state = extractSessionState(messages, dominant);
    expect(state.goal).toBe("Now build the compaction goal-recency fix end to end");
    expect(state.superseded).toBe(true);
  });

  it("does NOT supersede a completed skill when no later user pivot exists", () => {
    const messages = [
      { role: "user", content: "Please design a scoring system for the review queue" },
      skillCall("Design a scoring system", { id: "tc-1" }),
      skillResult("plan-1", true, "tc-1"),
    ];
    const dominant = detectDominantSkill(messages);
    const state = extractSessionState(messages, dominant);
    // The completed skill's goal is still the best summary of the session.
    expect(state.goal).toBe("Design a scoring system");
    expect(state.superseded).toBe(false);
  });

  it("carries forward previousSummary's goal only when nothing fresher exists", () => {
    const carried = extractSessionState([], null, undefined, "Migrate research skill onto engine");
    expect(carried.goal).toBe("Migrate research skill onto engine");

    // A fresh user pivot always beats carry-forward.
    const pivoted = extractSessionState(
      [{ role: "user", content: "Switch focus to the boundary_shift population work" }],
      null,
      undefined,
      "Migrate research skill onto engine"
    );
    expect(pivoted.goal).toBe("Switch focus to the boundary_shift population work");
  });
});

// ============================================================
// Eviction
// ============================================================

describe("eviction", () => {
  it("keeps unresolved errors over resolved ones", () => {
    const errors = [
      { error_type: "E1", message: "m", turn_id: "t", resolved: true },
      { error_type: "E2", message: "m", turn_id: "t", resolved: false },
    ];
    const { kept } = evictArray("errors", errors, 1, true);
    expect(kept[0].error_type).toBe("E2");
  });

  it("scale tightens caps but floors at 1", () => {
    const artifact: any = {
      constraints: Array.from({ length: 20 }, (_, i) => `c${i}`),
      preferences: [],
      errors: [],
      engine_runs: [],
      artifact_refs: [],
      resume_refs: { version: 2, refs: [] },
      files: { read: Array.from({ length: 30 }, (_, i) => `/f${i}`), modified: [] },
      tool_calls: [],
      tool_error_recovery: [],
      metadata: { eviction_log: [] },
    };
    const result = applyEviction(artifact, 0.01);
    expect(result.constraints.length).toBe(1);
    expect(result.files.read.length).toBe(1);
  });
});
