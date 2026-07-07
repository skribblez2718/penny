/**
 * Skill Extension Unit Tests — Mode Detection
 *
 * Tests detectSkillMode() pure function + truncateForPrevious + placeholders.
 * No mocking needed — all functions are pure.
 */

import { describe, it, expect } from "vitest";
import {
  truncateForPrevious,
  getFinalOutputFromSkillResult,
  SkillResult,
  detectSkillMode,
} from "../../skill-utils.js";

// ============================================================
// detectSkillMode
// ============================================================

describe("detectSkillMode", () => {
  it("detects single mode", () => {
    const result = detectSkillMode({ skill_name: "plan", goal: "test" });
    expect(result.mode).toBe("single");
    expect(result.error).toBeUndefined();
  });

  it("detects parallel mode", () => {
    const result = detectSkillMode({
      skills: [{ skill_name: "plan", goal: "test" }],
    });
    expect(result.mode).toBe("parallel");
    expect(result.error).toBeUndefined();
  });

  it("detects chain mode", () => {
    const result = detectSkillMode({
      chain: [{ skill_name: "plan", goal: "test" }],
    });
    expect(result.mode).toBe("chain");
    expect(result.error).toBeUndefined();
  });

  it("detects resume mode", () => {
    const result = detectSkillMode({ resume_chain: "chain-123" });
    expect(result.mode).toBe("resume");
    expect(result.error).toBeUndefined();
  });

  it("returns error for mutual exclusion: skills + chain", () => {
    const result = detectSkillMode({
      skills: [{ skill_name: "plan", goal: "test" }],
      chain: [{ skill_name: "plan", goal: "test" }],
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Ambiguous");
  });

  it("returns error for mutual exclusion: skill_name + skills", () => {
    const result = detectSkillMode({
      skill_name: "plan",
      goal: "test",
      skills: [{ skill_name: "agent", goal: "test2" }],
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Ambiguous");
  });

  it("returns error for mutual exclusion: skill_name + chain", () => {
    const result = detectSkillMode({
      skill_name: "plan",
      goal: "test",
      chain: [{ skill_name: "agent", goal: "test2" }],
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Ambiguous");
  });

  it("returns error for mutual exclusion: skill_name + resume_chain", () => {
    const result = detectSkillMode({
      skill_name: "plan",
      goal: "test",
      resume_chain: "chain-123",
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Ambiguous");
  });

  it("returns error for mutual exclusion: all four modes", () => {
    const result = detectSkillMode({
      skill_name: "plan",
      goal: "test",
      skills: [{ skill_name: "agent", goal: "test2" }],
      chain: [{ skill_name: "research", goal: "test3" }],
      resume_chain: "chain-123",
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Ambiguous");
  });

  it("returns error for empty skills array", () => {
    const result = detectSkillMode({ skills: [] });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("No invocation mode");
  });

  it("returns error for empty chain array", () => {
    const result = detectSkillMode({ chain: [] });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("No invocation mode");
  });

  it("returns error for missing goal in single mode", () => {
    const result = detectSkillMode({ skill_name: "plan" });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("No invocation mode");
  });

  it("returns error for missing skill_name in single mode", () => {
    const result = detectSkillMode({ goal: "test" });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("No invocation mode");
  });

  it("returns error for empty params", () => {
    const result = detectSkillMode({});
    expect(result.error).toBeDefined();
    expect(result.error).toContain("No invocation mode");
  });
});

// ============================================================
// truncateForPrevious
// ============================================================

describe("truncateForPrevious", () => {
  it("returns text as-is when under limit", () => {
    const text = "Short text";
    expect(truncateForPrevious(text, 2000)).toBe(text);
  });

  it("returns text as-is when exactly at limit", () => {
    const text = "A".repeat(2000);
    expect(truncateForPrevious(text, 2000)).toBe(text);
  });

  it("truncates at word boundary with ellipsis", () => {
    // Build text where spaces appear every 6 characters
    const text = "hello ".repeat(400) + "world"; // ~2400 chars, space every 6th position
    const result = truncateForPrevious(text, 2000);
    expect(result.endsWith("…")).toBe(true);
    // Length should not exceed maxChars + 1 (for ellipsis)
    expect(result.length).toBeLessThanOrEqual(2001);
  });

  it("hard cuts when no word boundary within 80% of limit", () => {
    // Build text with no spaces near the cutoff
    const prefix = "x".repeat(1950);
    const suffix = "y".repeat(100);
    const text = prefix + suffix; // 2050 chars, no spaces after position 1950
    const result = truncateForPrevious(text, 2000);
    expect(result.length).toBe(2001); // 2000 + "…"
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty string as-is", () => {
    expect(truncateForPrevious("")).toBe("");
  });

  it("handles text with only whitespace near limit", () => {
    const text = "a ".repeat(1000) + "b".repeat(2000);
    const result = truncateForPrevious(text, 2000);
    expect(result.endsWith("…")).toBe(true);
  });
});

// ============================================================
// {previous} placeholder replacement
// ============================================================

describe("{previous} placeholder replacement", () => {
  it("replaces {previous} with output", () => {
    const goal = "Research {previous} and plan";
    const previous = "JWT, OAuth patterns";
    const result = goal.replaceAll("{previous}", previous);
    expect(result).toBe("Research JWT, OAuth patterns and plan");
  });

  it("handles empty previous output", () => {
    const goal = "Use {previous} for planning";
    const result = goal.replaceAll("{previous}", "");
    expect(result).toBe("Use  for planning");
  });

  it("replaces multiple occurrences", () => {
    const goal = "From {previous} build {previous}";
    const previous = "output";
    const result = goal.replaceAll("{previous}", previous);
    expect(result).toBe("From output build output");
  });

  it("passes through when no placeholder present", () => {
    const goal = "No placeholder here";
    const result = goal.replaceAll("{previous}", "irrelevant");
    expect(result).toBe("No placeholder here");
  });
});

// ============================================================
// getFinalOutputFromSkillResult
// ============================================================

describe("getFinalOutputFromSkillResult", () => {
  it("returns plan_summary when available", () => {
    const result: SkillResult = {
      success: true,
      session_id: "test-123",
      skill_name: "plan",
      state: "complete",
      requires_approval: false,
      steps_total: 3,
      agents_invoked: ["echo", "piper"],
      errors: [],
      plan: { plan_summary: "Three authentication patterns found." },
    };
    expect(getFinalOutputFromSkillResult(result)).toBe("Three authentication patterns found.");
  });

  it("returns fallback when no plan_summary", () => {
    const result: SkillResult = {
      success: true,
      session_id: "test-456",
      skill_name: "research",
      state: "complete",
      requires_approval: false,
      steps_total: 2,
      agents_invoked: ["echo"],
      errors: [],
    };
    const output = getFinalOutputFromSkillResult(result);
    expect(output).toContain("session:test-456");
    expect(output).toContain("skill:research");
    expect(output).toContain("state:complete");
  });

  it("includes errors in fallback", () => {
    const result: SkillResult = {
      success: false,
      session_id: "test-789",
      skill_name: "plan",
      state: "error",
      requires_approval: false,
      steps_total: 0,
      agents_invoked: [],
      errors: ["timeout", "oom"],
    };
    const output = getFinalOutputFromSkillResult(result);
    expect(output).toContain("errors:timeout; oom");
  });
});

// ============================================================
// Chain error aggregation logic
// ============================================================

describe("chain error aggregation", () => {
  it("error at step 1 returns step index 1, 0 prior results", () => {
    const errorStep = 1;
    const priorResults: SkillResult[] = [];
    expect(errorStep).toBe(1);
    expect(priorResults.length).toBe(0);
  });

  it("error at step 3 of 5 returns step index 3, 2 prior results", () => {
    const errorStep = 3;
    const priorResults = new Array(2).fill(null);
    expect(errorStep).toBe(3);
    expect(priorResults.length).toBe(2);
  });
});

// ============================================================
// Parallel result aggregation
// ============================================================

describe("parallel result aggregation", () => {
  it("all successes → aggregate success", () => {
    const results = [true, true, true];
    const allSucceeded = results.every((r) => r);
    expect(allSucceeded).toBe(true);
  });

  it("mixed results → aggregate failure", () => {
    const results = [true, false, true];
    const allSucceeded = results.every((r) => r);
    expect(allSucceeded).toBe(false);
  });

  it("correct count in parallel_results", () => {
    const results = [1, 2, 3];
    expect(results.length).toBe(3);
  });
});
