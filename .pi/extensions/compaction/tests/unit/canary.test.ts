import { describe, it, expect } from "vitest";
import { parseGoalStreak, computeGoalStreak, goalStagnationCanary } from "../../index.js";

// ============================================================
// Goal-stagnation regression canary (P2, observational only).
// It NEVER alters goal selection — a long single-task session legitimately
// keeps the same goal. These tests pin the pure streak arithmetic + marker
// parsing that the handler uses to log (and only log) suspected stagnation.
// ============================================================

describe("parseGoalStreak", () => {
  it("returns 0 when no marker is present", () => {
    expect(parseGoalStreak("## Goal\nSomething\n")).toBe(0);
    expect(parseGoalStreak(undefined)).toBe(0);
  });

  it("reads the streak embedded by a prior compaction", () => {
    const summary = "## Goal\nX\n\n[/RESUME-REFS]\n<!-- penny-goal-streak:4 -->";
    expect(parseGoalStreak(summary)).toBe(4);
  });

  it("is tolerant of whitespace inside the marker", () => {
    expect(parseGoalStreak("<!--  penny-goal-streak:7  -->")).toBe(7);
  });
});

describe("computeGoalStreak", () => {
  it("resets to 1 when the goal changes", () => {
    expect(computeGoalStreak("new goal", "old goal", 5)).toBe(1);
  });

  it("resets to 1 when there is no previous goal", () => {
    expect(computeGoalStreak("goal", null, 0)).toBe(1);
  });

  it("increments the prior streak when the goal is byte-identical", () => {
    expect(computeGoalStreak("same", "same", 2)).toBe(3);
  });

  it("treats a missing prior streak as at least 1 before incrementing", () => {
    expect(computeGoalStreak("same", "same", 0)).toBe(2);
  });
});

describe("goalStagnationCanary", () => {
  it("does not fire below the default threshold of 3", () => {
    expect(goalStagnationCanary(1)).toBe(false);
    expect(goalStagnationCanary(2)).toBe(false);
  });

  it("fires at or above the threshold", () => {
    expect(goalStagnationCanary(3)).toBe(true);
    expect(goalStagnationCanary(9)).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(goalStagnationCanary(2, 2)).toBe(true);
    expect(goalStagnationCanary(1, 2)).toBe(false);
  });

  it("byte-identical-but-legitimate: the canary is a boolean signal, not a mutation", () => {
    // The canary only reports; it returns a boolean and touches no goal state.
    const streak = computeGoalStreak("Long single-task goal", "Long single-task goal", 4);
    expect(streak).toBe(5);
    expect(goalStagnationCanary(streak)).toBe(true); // logs, but never changes the goal
  });
});
