import { describe, it, expect } from "vitest";
import { parseGoalFromSummary, extractSessionState } from "../../index.js";

// ============================================================
// Fix A: previousSummary Goal carry-forward (deterministic, no LLM call)
// ============================================================

describe("parseGoalFromSummary (Fix A)", () => {
  it("extracts the goal from this extension's own prose format", () => {
    const prev = [
      "## Goal",
      "Migrate research skill onto engine",
      "",
      "## Active Skill",
      "- **code** (incomplete)",
    ].join("\n");
    expect(parseGoalFromSummary(prev)).toBe("Migrate research skill onto engine");
  });

  it("tolerates a multi-line goal, joining until the next heading", () => {
    const prev = ["# Goal", "Line one of the goal", "continues here", "", "# Next"].join("\n");
    expect(parseGoalFromSummary(prev)).toBe("Line one of the goal continues here");
  });

  it("returns null when there is no parseable ## Goal section (Pi default / hand-edited)", () => {
    const piDefault = "Summary of the conversation so far:\n- did some things\n- then more things";
    expect(parseGoalFromSummary(piDefault)).toBeNull();
  });

  it("returns null for the placeholder goal text (never carries a non-goal forward)", () => {
    expect(parseGoalFromSummary("## Goal\n(not set)\n")).toBeNull();
    expect(parseGoalFromSummary("## Goal\nActive session - goal not yet extracted\n")).toBeNull();
  });

  it("returns null for undefined / empty input", () => {
    expect(parseGoalFromSummary(undefined)).toBeNull();
    expect(parseGoalFromSummary("")).toBeNull();
  });

  it("stops at a horizontal rule (does not swallow the RESUME-REFS appendix)", () => {
    const prev = ["## Goal", "Fix the goal-recency regression", "---", "[RESUME-REFS v2]"].join(
      "\n"
    );
    expect(parseGoalFromSummary(prev)).toBe("Fix the goal-recency regression");
  });
});

describe("carry-forward precedence in extractSessionState", () => {
  const priorGoal = "Migrate research skill onto engine";

  it("carries the prior goal forward when the window has no fresher signal", () => {
    const state = extractSessionState([], null, undefined, priorGoal);
    expect(state.goal).toBe(priorGoal);
  });

  it("never overrides a fresh user pivot with carry-forward", () => {
    const state = extractSessionState(
      [{ role: "user", content: "Switch entirely to the Current Work rendering task" }],
      null,
      undefined,
      priorGoal
    );
    expect(state.goal).toBe("Switch entirely to the Current Work rendering task");
  });

  it("never overrides an engine-run goal with carry-forward", () => {
    const state = extractSessionState([], null, "Active engine run goal", priorGoal);
    expect(state.goal).toBe("Active engine run goal");
  });

  it("never overrides an incomplete active skill with carry-forward", () => {
    const state = extractSessionState(
      [],
      { skill_name: "code", session_id: "code-1", goal: "Skill-driven goal", completed: false },
      undefined,
      priorGoal
    );
    expect(state.goal).toBe("Skill-driven goal");
  });
});
