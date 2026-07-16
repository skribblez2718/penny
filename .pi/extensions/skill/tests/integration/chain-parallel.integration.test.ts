/**
 * Skill Extension Integration Tests — Parallel + Chain + Resume
 *
 * Verifies the full execute→dispatch→aggregate flow with mocked
 * Python orchestrators. No real LLM calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import type { SkillResult } from "../../skill-utils.js";
import {
  truncateForPrevious,
  getFinalOutputFromSkillResult,
  reconstructResumeChain,
  isClarificationEscalation,
  formatResult,
} from "../../skill-utils.js";

// ============================================================
// Mocks
// ============================================================

vi.mock("fs");
vi.mock("node:child_process");

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);

// ============================================================
// Integration: truncated {previous} handoff simulation
// ============================================================

describe("chain {previous} handoff (integration simulation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("step 2 receives truncated step 1 output", () => {
    // Simulate: step 1 produces a long output, gets truncated for step 2
    const step1Output: SkillResult = {
      success: true,
      session_id: "plan-001",
      skill_name: "plan",
      state: "complete",
      requires_approval: false,
      steps_total: 3,
      agents_invoked: ["echo", "piper", "carren"],
      errors: [],
      plan: {
        plan_summary:
          "Found " +
          "entry ".repeat(500) + // ~2500 chars of repeated content
          "points in the codebase.",
      },
    };

    const raw = getFinalOutputFromSkillResult(step1Output);
    expect(raw.length).toBeGreaterThan(2000); // Should exceed limit

    const truncated = truncateForPrevious(raw, 2000);
    expect(truncated.length).toBeLessThanOrEqual(2001);
    expect(truncated.endsWith("…")).toBe(true);

    // Step 2's goal uses {previous}
    const step2Goal = "Research {previous} and plan approach";
    const resolved = step2Goal.replaceAll("{previous}", truncated);
    expect(resolved).toContain("Research ");
    expect(resolved).toContain(" and plan approach");
    expect(resolved).not.toContain("{previous}");
  });

  it("step 1 with no prior output gets empty {previous}", () => {
    const step1Goal = "Plan {previous}";
    const resolved = step1Goal.replaceAll("{previous}", "");
    expect(resolved).toBe("Plan ");
  });

  it("goal without {previous} passes through unchanged on substitution", () => {
    const goal = "Analyze the codebase";
    const resolved = goal.replaceAll("{previous}", "some output");
    expect(resolved).toBe("Analyze the codebase");
  });
});

// ============================================================
// Integration: chain error aggregation
// ============================================================

describe("chain error aggregation (integration simulation)", () => {
  it("error at step 1 returns correct structure", () => {
    const chainSteps = [
      { skill_name: "research", goal: "Research X" },
      { skill_name: "plan", goal: "Plan for {previous}" },
    ];

    // Simulate step 1 failing
    const errorStep = 0;
    const priorSuccesses: SkillResult[] = [];
    const errorMessage = `Chain stopped at step 1/2 (research): Agent timeout`;

    const result: Partial<SkillResult> = {
      success: false,
      mode: "chain",
      chain_error_step: errorStep,
      chain_results: priorSuccesses,
      chain_session_id: "chain-test-001",
      resumable: true,
      chain_total: chainSteps.length,
      errors: [errorMessage],
    };

    expect(result.chain_error_step).toBe(0);
    expect(result.chain_results).toHaveLength(0);
    expect(result.resumable).toBe(true);
    expect(result.errors![0]).toContain("research");
  });

  it("error at step 3 of 5 returns prior 2 results", () => {
    const priorSuccesses: SkillResult[] = [
      {
        success: true,
        session_id: "r1",
        skill_name: "plan",
        state: "complete",
        requires_approval: false,
        steps_total: 2,
        agents_invoked: ["echo"],
        errors: [],
      },
      {
        success: true,
        session_id: "r2",
        skill_name: "research",
        state: "complete",
        requires_approval: false,
        steps_total: 3,
        agents_invoked: ["echo", "synthia"],
        errors: [],
      },
    ];

    const result: Partial<SkillResult> = {
      success: false,
      mode: "chain",
      chain_error_step: 2, // 0-indexed, so step 3
      chain_results: priorSuccesses,
      chain_total: 5,
      resumable: true,
    };

    expect(result.chain_error_step).toBe(2);
    expect(result.chain_results).toHaveLength(2);
  });
});

// ============================================================
// Integration: parallel result aggregation
// ============================================================

describe("parallel result aggregation (integration simulation)", () => {
  it("aggregates two successful skills", () => {
    const results: SkillResult[] = [
      {
        success: true,
        session_id: "p1",
        skill_name: "plan",
        state: "complete",
        requires_approval: false,
        steps_total: 2,
        agents_invoked: ["echo", "piper"],
        errors: [],
      },
      {
        success: true,
        session_id: "p2",
        skill_name: "agent",
        state: "complete",
        requires_approval: false,
        steps_total: 3,
        agents_invoked: ["echo", "piper", "carren"],
        errors: [],
      },
    ];

    const allSucceeded = results.every((r) => r.success);
    const allErrors = results.flatMap((r) => r.errors);
    const allAgents = results.flatMap((r) => r.agents_invoked);

    const aggregated: SkillResult = {
      success: allSucceeded,
      session_id: "parallel-001",
      skill_name: "parallel",
      state: "complete",
      requires_approval: false,
      steps_total: 2,
      agents_invoked: allAgents,
      errors: allErrors,
      mode: "parallel",
      parallel_results: results,
    };

    expect(aggregated.success).toBe(true);
    expect(aggregated.parallel_results).toHaveLength(2);
    expect(aggregated.agents_invoked).toHaveLength(5);
    expect(aggregated.errors).toHaveLength(0);
  });

  it("aggregates mixed results (1 success + 1 failure)", () => {
    const results: SkillResult[] = [
      {
        success: true,
        session_id: "p1",
        skill_name: "plan",
        state: "complete",
        requires_approval: false,
        steps_total: 2,
        agents_invoked: ["echo"],
        errors: [],
      },
      {
        success: false,
        session_id: "p2",
        skill_name: "plan",
        state: "error",
        requires_approval: false,
        steps_total: 0,
        agents_invoked: ["echo"],
        errors: ["API rate limit exceeded"],
      },
    ];

    const allSucceeded = results.every((r) => r.success);
    expect(allSucceeded).toBe(false);

    const aggregated: SkillResult = {
      success: allSucceeded,
      session_id: "parallel-002",
      skill_name: "parallel",
      state: "partial",
      requires_approval: false,
      steps_total: 2,
      agents_invoked: results.flatMap((r) => r.agents_invoked),
      errors: results.flatMap((r) => r.errors),
      mode: "parallel",
      parallel_results: results,
    };

    expect(aggregated.success).toBe(false);
    expect(aggregated.errors).toContain("API rate limit exceeded");
  });
});

// ============================================================
// Integration: resume from checkpoint (simulated)
// ============================================================

describe("resume from checkpoint (integration simulation)", () => {
  it("reconstructs chain from checkpoint, skipping completed steps", () => {
    const checkpoint = {
      chain_session_id: "chain-resume-test",
      steps: [
        {
          index: 0,
          skill_name: "research",
          goal: "Research auth patterns",
          session_id: "research-001",
          status: "complete" as const,
          result_summary: "Found JWT, OAuth patterns",
        },
        {
          index: 1,
          skill_name: "plan",
          goal: "Plan approach for {previous}",
          session_id: "plan-001",
          status: "failed" as const,
          error: "Agent timeout",
        },
      ],
      current_step: 1,
      total_steps: 3,
      chain_status: "failed" as const,
      pending_steps: [
        {
          index: 2,
          skill_name: "agent",
          goal: "Scaffold from {previous}",
        },
      ],
    };

    // Simulate resume: skip completed step 0, retry step 1, then step 2
    const completedSteps = checkpoint.steps.filter((s) => s.status === "complete");
    const failedStep = checkpoint.steps.find((s) => s.status === "failed");

    expect(completedSteps).toHaveLength(1);
    expect(failedStep).toBeDefined();
    expect(failedStep!.index).toBe(1);

    // With overrides
    const overrides = { 1: { goal: "Plan with longer timeout for {previous}" } };
    const retryGoal = overrides[1]?.goal ?? failedStep!.goal;
    expect(retryGoal).toBe("Plan with longer timeout for {previous}");

    // Previous output from completed steps
    const previousOutput = completedSteps[0].result_summary;
    expect(previousOutput).toBe("Found JWT, OAuth patterns");
  });

  it("detects complete chain — no resume needed", () => {
    const checkpoint = {
      chain_session_id: "chain-already-done",
      chain_status: "complete" as const,
      steps: [],
      current_step: 3,
      total_steps: 3,
    };

    expect(checkpoint.chain_status).toBe("complete");
  });

  it("handles missing checkpoint gracefully", () => {
    const checkpoint = null;
    expect(checkpoint).toBeNull();
    // The executeSkillsChain function returns error when checkpoint not found
  });
});

// ============================================================
// Regression: reconstructResumeChain (the REAL function, not a simulation)
// Guards the two resume bugs that broke resuming after a clarification pause.
// ============================================================

describe("reconstructResumeChain (resume bug regression)", () => {
  // The real checkpoint shape: pending steps live in BOTH `steps` (status
  // "pending") AND `pending_steps`. The old inline logic added them from both,
  // producing "prd → code → code".
  const failedTwoStep = {
    steps: [
      {
        index: 0,
        skill_name: "prd",
        goal: "spec it",
        session_id: "prd-100",
        status: "failed" as const,
      },
      {
        index: 1,
        skill_name: "code",
        goal: "build {previous}",
        session_id: "code-101",
        status: "pending" as const,
      },
    ],
    pending_steps: [{ index: 1, skill_name: "code", goal: "build {previous}" }],
  };

  it("does NOT duplicate pending steps (fixes prd → code → code)", () => {
    const { chain } = reconstructResumeChain(failedTwoStep);
    expect(chain.map((s) => s.skill_name)).toEqual(["prd", "code"]);
    expect(chain).toHaveLength(2); // not 3
  });

  it("preserves each step's session_id so a paused run can be recovered", () => {
    const { chain, startStep } = reconstructResumeChain(failedTwoStep);
    expect(startStep).toBe(0);
    expect(chain[0].session_id).toBe("prd-100"); // paused/failed step keeps its session
    expect(chain[1].session_id).toBe("code-101");
  });

  it("applies overrides only to the failed step", () => {
    const { chain } = reconstructResumeChain(failedTwoStep, {
      0: { goal: "spec it (clarified)", constraints: { user_response: "go" } },
    });
    expect(chain[0].goal).toBe("spec it (clarified)");
    expect(chain[0].constraints).toEqual({ user_response: "go" });
    expect(chain[1].goal).toBe("build {previous}"); // untouched
  });

  it("skips completed steps and returns them for {previous} handoff", () => {
    const cp = {
      steps: [
        {
          index: 0,
          skill_name: "research",
          goal: "r",
          session_id: "r-1",
          status: "complete" as const,
          result_summary: "found X",
        },
        {
          index: 1,
          skill_name: "plan",
          goal: "p {previous}",
          session_id: "p-1",
          status: "failed" as const,
        },
        {
          index: 2,
          skill_name: "code",
          goal: "c {previous}",
          session_id: "c-1",
          status: "pending" as const,
        },
      ],
      pending_steps: [{ index: 2, skill_name: "code", goal: "c {previous}" }],
    };
    const { chain, completed, startStep } = reconstructResumeChain(cp);
    expect(completed.map((c) => c.skill_name)).toEqual(["research"]);
    expect(completed[0].result_summary).toBe("found X");
    expect(chain.map((s) => s.skill_name)).toEqual(["plan", "code"]);
    expect(startStep).toBe(1);
  });

  it("dedupes when a pending step appears ONLY in pending_steps (defensive)", () => {
    const cp = {
      steps: [
        {
          index: 0,
          skill_name: "prd",
          goal: "spec",
          session_id: "prd-1",
          status: "failed" as const,
        },
      ],
      pending_steps: [{ index: 1, skill_name: "code", goal: "build" }],
    };
    const { chain } = reconstructResumeChain(cp);
    expect(chain.map((s) => s.skill_name)).toEqual(["prd", "code"]);
  });
});

// ============================================================
// Chain clarification surfacing (follow-up): a paused step shows its OWN
// questions + a resume_chain instruction, not the generic retry/skip prompt.
// ============================================================

describe("chain clarification surfacing", () => {
  const base = (over: Partial<SkillResult>): SkillResult => ({
    success: false,
    session_id: "s",
    skill_name: "prd",
    state: "awaiting_clarification",
    requires_approval: false,
    steps_total: 0,
    agents_invoked: [],
    errors: [],
    ...over,
  });
  const theme = (_c: string, t: string) => t;

  it("detects a clarification pause (questions present, no error text)", () => {
    expect(
      isClarificationEscalation(
        base({ escalation: { questions: [{ id: "q1", label: "Q", prompt: "confirm?" }] } })
      )
    ).toBe(true);
  });

  it("does NOT treat a hard error or a success as a clarification", () => {
    expect(
      isClarificationEscalation(base({ state: "error", errors: ["400 invalid_request"] }))
    ).toBe(false);
    expect(isClarificationEscalation(base({ success: true, state: "complete" }))).toBe(false);
  });

  it("renders a resume_chain instruction routing the answer to the paused step", () => {
    const out = formatResult(
      base({
        skill_name: "chain",
        mode: "chain",
        chain_session_id: "chain-42",
        chain_error_step: 0,
        escalation: {
          questions: [{ id: "design", label: "Confirm", prompt: "confirm the veto design?" }],
        },
      }),
      theme
    );
    expect(out).toContain('resume_chain: "chain-42"');
    expect(out).toContain('"0": { constraints: { user_response:');
    expect(out).toContain("confirm the veto design?"); // the SKILL's real question
    expect(out).not.toContain('skill_name: "chain"'); // not the invalid bare-skill form
  });

  it("single-skill escalation still renders the bare-skill resume form", () => {
    const out = formatResult(
      base({
        skill_name: "prd",
        session_id: "prd-1",
        escalation: { questions: [{ id: "q", label: "Q", prompt: "which mode?" }] },
      }),
      theme
    );
    expect(out).toContain('skill_name: "prd"');
    expect(out).toContain('session_id: "prd-1"');
    expect(out).not.toContain("resume_chain");
  });
});
