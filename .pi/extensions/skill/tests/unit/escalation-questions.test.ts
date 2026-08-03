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
import {
  normalizeEscalationQuestions,
  prepareQuestionnairePayload,
  EscalationQuestion,
} from "../../skill-utils.js";
import {
  renderedQuestionsDigest,
  resolveTrustedQuestionnaireTransport,
} from "../../execution-receipts.js";

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

  it("replaces private gate metadata with an opaque canonical transport capability", () => {
    const artifactRef = {
      artifact_id: "ideal-1",
      kind: "ideal_state_revision",
      version: 3,
      digest: "a".repeat(64),
    };
    const transportRef = {
      artifact_id: "transport-1",
      kind: "questionnaire_transport",
      version: 1,
      digest: "b".repeat(64),
    };
    const question: EscalationQuestion = {
      id: "criteria",
      label: "Criteria",
      prompt: "Approve the exact selected artifact?",
      options: [{ value: "accept", label: "Accept" }],
      approval_run_id: "run-1",
      approval_gate_id: "criteria_gate",
      approval_challenge: "challenge-1",
      artifact_ref: artifactRef,
      questionnaire_transport_ref: transportRef,
    };
    const normalized = normalizeEscalationQuestions([question]);
    question.rendered_questions_digest = renderedQuestionsDigest(normalized);

    const payload = prepareQuestionnairePayload([question]);
    expect(payload).toHaveProperty("trustedTransportCapability");
    expect(JSON.stringify(payload)).not.toContain("challenge-1");
    const capability = (payload as { trustedTransportCapability: string })
      .trustedTransportCapability;
    expect(resolveTrustedQuestionnaireTransport(capability)).toEqual({
      questions: normalized,
      binding: {
        runId: "run-1",
        gateId: "criteria_gate",
        challenge: "challenge-1",
        artifactRef,
        transportRef,
        renderedQuestionsDigest: question.rendered_questions_digest,
      },
    });
  });

  it("NORMALIZING BEFORE PREPARING destroys the approval binding (regression guard)", () => {
    // The bug this guards against: the escalate_to_user handler normalized the
    // questions first and stored only the normalized copy on
    // SkillResult.escalation.questions. normalizeEscalationQuestions() keeps just
    // id/label/prompt/options/allowOther/type, so the six approval-binding fields
    // were gone by the time prepareQuestionnairePayload() ran. No capability was
    // minted -> the questionnaire tool could not emit a signed trusted_human_event
    // -> route_user rejected every answer -> the P0 gate re-asked forever and was
    // literally unsatisfiable. escalation.questions must carry RAW questions.
    const artifactRef = {
      artifact_id: "ideal-1",
      kind: "ideal_state_revision",
      version: 1,
      digest: "c".repeat(64),
    };
    const transportRef = {
      artifact_id: "transport-2",
      kind: "questionnaire_transport",
      version: 1,
      digest: "d".repeat(64),
    };
    const raw: EscalationQuestion = {
      id: "criteria_refinement",
      label: "Criteria Fix",
      prompt: "Approve the exact selected artifact?",
      options: [{ value: "accept", label: "Accept as-is" }],
      approval_run_id: "run-2",
      approval_gate_id: "criteria_gate",
      approval_challenge: "challenge-2",
      artifact_ref: artifactRef,
      questionnaire_transport_ref: transportRef,
    };
    raw.rendered_questions_digest = renderedQuestionsDigest(
      normalizeEscalationQuestions([raw])
    );

    // RAW questions -> capability is minted (the fixed path).
    expect(prepareQuestionnairePayload([raw])).toHaveProperty("trustedTransportCapability");

    // Pre-normalized questions -> binding is gone, so NO capability (the bug).
    const prenormalized = normalizeEscalationQuestions([raw]) as EscalationQuestion[];
    expect(prenormalized[0].approval_challenge).toBeUndefined();
    expect(prenormalized[0].questionnaire_transport_ref).toBeUndefined();
    const brokenPayload = prepareQuestionnairePayload(prenormalized);
    expect(brokenPayload).not.toHaveProperty("trustedTransportCapability");
    expect(brokenPayload).toHaveProperty("questions");
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
