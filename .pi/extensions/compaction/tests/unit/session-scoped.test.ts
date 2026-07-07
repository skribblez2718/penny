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
    // Regression: fabricated `${skill}-${Date.now()}` ids silently poisoned
    // room scoping — empty string is the honest value.
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

  it("falls back to the engine run goal before message text", () => {
    const state = extractSessionState(
      [{ role: "user", content: "some general chatter here" }],
      null,
      "Migrate research skill onto engine"
    );
    expect(state.goal).toBe("Migrate research skill onto engine");
  });

  it("skips reactionary user messages when falling back to message text", () => {
    const state = extractSessionState(
      [
        { role: "user", content: "fix this immediately" },
        { role: "user", content: "Implement the compaction redesign end to end" },
      ],
      null
    );
    expect(state.goal).toBe("Implement the compaction redesign end to end");
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
});

// ============================================================
// Eviction — real algorithm, real protection
// ============================================================

describe("eviction", () => {
  const room = (name: string, ageMs: number) => ({
    wing: "penny",
    room: name,
    drawer_ids: ["d1"],
    last_updated: new Date(Date.now() - ageMs).toISOString(),
  });

  it("never evicts rooms matching a protected (real) session id", () => {
    const rooms = [
      room("skills/code-1751700000000", 86_400_000 * 30), // old but protected
      room("skills/plan-aaa", 1000),
      room("skills/plan-bbb", 2000),
    ];
    const { kept } = evictArray("mempalace_rooms", rooms, 1, false, ["code-1751700000000"]);
    expect(kept).toHaveLength(1);
    expect(kept[0].room).toBe("skills/code-1751700000000");
  });

  it("keeps unresolved errors over resolved ones", () => {
    const errors = [
      { error_type: "E1", message: "m", turn_id: "t", mempalace_drawer_id: "d", resolved: true },
      { error_type: "E2", message: "m", turn_id: "t", mempalace_drawer_id: "d", resolved: false },
    ];
    const { kept } = evictArray("errors", errors, 1, true);
    expect(kept[0].error_type).toBe("E2");
  });

  it("keeps CERTAIN decisions over UNCERTAIN", () => {
    const decisions = [
      { decision_id: "d1", summary: "A", outcome_room: "r", confidence: "UNCERTAIN" },
      { decision_id: "d2", summary: "B", outcome_room: "r", confidence: "CERTAIN" },
      { decision_id: "d3", summary: "C", outcome_room: "r", confidence: "POSSIBLE" },
    ];
    const { kept } = evictArray("decisions", decisions, 2);
    expect(kept.map((d: any) => d.decision_id)).toEqual(["d2", "d3"]);
  });

  it("scale tightens caps but floors at 1 (degrade never empties a field)", () => {
    const artifact: any = {
      constraints: Array.from({ length: 20 }, (_, i) => `c${i}`),
      preferences: [],
      decisions: [],
      errors: [],
      engine_runs: [],
      mempalace_rooms: [],
      kg_entities: [],
      files: { read: Array.from({ length: 30 }, (_, i) => `/f${i}`), modified: [] },
      tool_calls: [],
      tool_error_recovery: [],
      metadata: { eviction_log: [] },
    };
    const result = applyEviction(artifact, [], 0.01);
    expect(result.constraints.length).toBe(1);
    expect(result.files.read.length).toBe(1);
  });
});
