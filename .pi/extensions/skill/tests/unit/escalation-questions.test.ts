/**
 * Skill Extension Unit Tests — Escalation question normalization
 *
 * Regression coverage for the sca charter-gate crash:
 *   "Cannot read properties of undefined (reading 'map')"
 * caused by the escalate_to_user handler calling `q.options.map(...)` on a
 * free-text gate question that legitimately omits `options`.
 *
 * normalizeEscalationQuestions() is a pure function — no mocking needed.
 */

import { describe, it, expect } from "vitest";
import { normalizeEscalationQuestions, EscalationQuestion } from "../../skill-utils.js";

describe("normalizeEscalationQuestions", () => {
  it("defaults a MISSING options key to [] (the charter-gate crash case)", () => {
    // Mirrors orchestrate.py _charter_questions(): free-text questions have
    // no `options` key at all.
    const questions = [
      { id: "out_of_scope", label: "Out-of-scope", prompt: "List paths." },
      { id: "scope", label: "Scope", prompt: "Narrow the scope." },
    ] as unknown as EscalationQuestion[];

    expect(() => normalizeEscalationQuestions(questions)).not.toThrow();
    const out = normalizeEscalationQuestions(questions);
    expect(out).toHaveLength(2);
    expect(out[0].options).toEqual([]);
    expect(out[1].options).toEqual([]);
    // allowOther defaults to true so the free-text affordance is available.
    expect(out[0].allowOther).toBe(true);
  });

  it("preserves options and strips empty descriptions", () => {
    const questions: EscalationQuestion[] = [
      {
        id: "p0_charter_gate",
        label: "Approve",
        prompt: "Approve?",
        options: [
          { value: "approve", label: "Approve and continue" },
          { value: "revise", label: "Request revisions", description: "Explain" },
        ],
        allowOther: false,
      },
    ];

    const out = normalizeEscalationQuestions(questions);
    expect(out[0].options).toEqual([
      { value: "approve", label: "Approve and continue" },
      { value: "revise", label: "Request revisions", description: "Explain" },
    ]);
    // approve has no description key at all
    expect("description" in out[0].options[0]).toBe(false);
    // explicit allowOther:false is respected
    expect(out[0].allowOther).toBe(false);
  });

  it("handles a MIXED list (options + optionless) — the real charter gate shape", () => {
    const questions = [
      {
        id: "p0_charter_gate",
        label: "Approve",
        prompt: "Approve?",
        options: [{ value: "approve", label: "Approve" }],
        allowOther: true,
      },
      { id: "out_of_scope", label: "Out-of-scope", prompt: "Paths?", allowOther: true },
      { id: "scope", label: "Scope", prompt: "Scope?", allowOther: true },
    ] as unknown as EscalationQuestion[];

    const out = normalizeEscalationQuestions(questions);
    expect(out).toHaveLength(3);
    expect(out[0].options).toHaveLength(1);
    expect(out[1].options).toEqual([]);
    expect(out[2].options).toEqual([]);
  });

  it("returns [] for undefined / null / empty input", () => {
    expect(normalizeEscalationQuestions(undefined)).toEqual([]);
    expect(normalizeEscalationQuestions(null)).toEqual([]);
    expect(normalizeEscalationQuestions([])).toEqual([]);
  });

  it("treats an explicitly-empty options array like no options", () => {
    const questions: EscalationQuestion[] = [{ id: "q", label: "Q", prompt: "P", options: [] }];
    const out = normalizeEscalationQuestions(questions);
    expect(out[0].options).toEqual([]);
    expect(out[0].allowOther).toBe(true);
  });
});
