/**
 * W5 — typed feedback seam (Foundation stage, workstream 1 of 3).
 *
 * The point of W5 is that repair is routed by *cause*. The critical property is that the
 * typed classification and the transition research actually performs are the same value:
 * research's `validating` branch calls `classifyGap` directly, so the seam cannot drift
 * from the behaviour. These tests pin the classification rule and that single source of
 * truth.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EvaluationResultSchema,
  validateContract,
  type JsonValue,
  type RunIdentity,
} from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { hasGapClassification, type PlaybookV1 } from "../src/playbooks/playbook.js";
import { ResearchPlaybook } from "../src/playbooks/research.js";

function contextWith(options: {
  iteration?: number;
  maxIterations?: number;
  researchRound?: number;
  maxResearchRounds?: number;
}): RunContext {
  const identity: RunIdentity = {
    schema_version: 2,
    run_id: "run-feedback-001",
    session_id: "session-feedback",
    playbook: "research",
    engine_owner: "typescript",
  } as RunIdentity;
  const context = RunContext.create({
    identity,
    goal: "feedback routing fixture",
    constraints: { max_iterations: options.maxIterations ?? 3 },
    projectRoot: "/tmp",
    trustProfile: "trusted-interactive",
    maxSteps: 32,
  });
  context.iteration = options.iteration ?? 0;
  context.research.research_round = options.researchRound ?? 0;
  context.research.max_research_rounds = options.maxResearchRounds ?? 2;
  context.research.max_sub_queries = 4;
  return context;
}

const playbook = new ResearchPlaybook() as PlaybookV1;

describe("W5 gap classification", () => {
  it("is exposed as a capability by the reference playbook", () => {
    expect(hasGapClassification(playbook)).toBe(true);
  });

  it("returns null when validation passed", () => {
    const context = contextWith({});
    expect(playbook.classifyGap?.(context, "validating", { verdict: "PASS" })).toBeNull();
  });

  it("returns null for a state that has no repair decision", () => {
    const context = contextWith({});
    expect(playbook.classifyGap?.(context, "planning", { verdict: "FAIL" })).toBeNull();
  });

  it("classifies missing evidence with rounds remaining as evidence_gap -> researching", () => {
    const context = contextWith({ researchRound: 0, maxResearchRounds: 2 });
    const details: Record<string, JsonValue> = {
      verdict: "FAIL",
      evidence_needed: ["a source for claim 2"],
    };
    const evaluation = playbook.classifyGap?.(context, "validating", details);
    expect(evaluation?.kind).toBe("evidence_gap");
    expect(evaluation?.target_state).toBe("researching");
    expect(() => validateContract(EvaluationResultSchema, evaluation, "evaluation")).not.toThrow();
  });

  it("classifies exhausted evidence rounds as synthesis_gap -> synthesizing", () => {
    const context = contextWith({ researchRound: 2, maxResearchRounds: 2 });
    const evaluation = playbook.classifyGap?.(context, "validating", {
      verdict: "FAIL",
      evidence_needed: ["still short"],
    });
    expect(evaluation?.kind).toBe("synthesis_gap");
    expect(evaluation?.target_state).toBe("synthesizing");
  });

  it("classifies a failure with no evidence request as synthesis_gap", () => {
    const context = contextWith({});
    const evaluation = playbook.classifyGap?.(context, "validating", {
      verdict: "FAIL",
      evidence_needed: [],
    });
    expect(evaluation?.kind).toBe("synthesis_gap");
  });

  it("reports exhaustion when no iteration budget remains", () => {
    const context = contextWith({ iteration: 2, maxIterations: 3 });
    const evaluation = playbook.classifyGap?.(context, "validating", { verdict: "FAIL" });
    expect(evaluation?.exhausted).toBe(true);
  });
});

describe("W5 single source of truth", () => {
  const source = readFileSync(new URL("../src/playbooks/research.ts", import.meta.url), "utf8");

  it("routes the validating repair on the classification, not a duplicate condition", () => {
    // If the transition were re-derived from a second copy of the rule, the seam could
    // drift from the behaviour. It must read classifyGap's result.
    expect(source).toContain('this.classifyGap(context, "validating", summary)');
    expect(source).toContain('evaluation?.kind === "evidence_gap"');
  });
});

describe("W5 engine routes malformed results by kind", () => {
  const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");

  it("constructs a typed malformed_result evaluation and routes on it", () => {
    expect(source).toContain('kind: "malformed_result"');
    expect(source).toContain('evaluation.kind === "malformed_result"');
  });

  it("records the feedback kind on the checkpoint event", () => {
    expect(source).toContain("feedback_kind: evaluation.kind");
  });
});
