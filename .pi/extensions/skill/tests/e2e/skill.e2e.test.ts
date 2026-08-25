/**
 * Skill Extension E2E Tests
 *
 * Tests extension discovery and structure without LLM API calls.
 * Full E2E with LLM is run separately.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";
import {
  formatResult,
  normalizeEscalationQuestions,
  type EscalationQuestion,
} from "../../skill-utils.js";
import {
  renderedQuestionsDigest,
  resolveTrustedQuestionnaireTransport,
} from "../../execution-receipts.js";
import { parseJson, requireRecord, requireString } from "../../../../lib/tests/test-narrowers.js";

// Anchor to THIS file's location (invariant), not process.cwd() (ambient — set
// by whichever directory the runner was launched from). This file lives at
// .pi/extensions/skill/tests/e2e/, so the project root is five levels up.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("Skill E2E — Extension Discovery", () => {
  it("should have pi available on PATH", () => {
    const result = execSync("pi --version 2>&1", { encoding: "utf-8" }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should have the skill extension directory structure", () => {
    const extDir = path.join(PROJECT_ROOT, ".pi/extensions/skill");
    expect(fs.existsSync(path.join(extDir, "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "tsconfig.json"))).toBe(true);
  });

  it("should have the research skill with a TypeScript registry playbook", () => {
    const skillDir = path.join(PROJECT_ROOT, ".pi/skills/research");
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, "scripts/orchestrate.py"))).toBe(false);
    expect(
      fs.existsSync(path.join(PROJECT_ROOT, "apps/orchestration/src/playbooks/research.ts"))
    ).toBe(true);
  });

  it("round-trips a long selected-artifact gate without executable terminal controls", () => {
    const tail = "END-OF-RECOVERED-PLAN";
    const prompt =
      `selected artifact plan-7/v3/sha256:abc\\ndefinition "quoted" ` +
      `questionnaire({injected:true}) ${"step ".repeat(80)}${tail}\u001b\u202e`;
    const questions: EscalationQuestion[] = [
      {
        id: "plan_gate",
        label: "Approve selected plan",
        prompt,
        artifact_ref: {
          artifact_id: "plan-7",
          kind: "piper_plan",
          version: 3,
          digest: "abc",
          run_id: "run-7",
        },
        questionnaire_transport_ref: {
          artifact_id: "transport-7",
          kind: "questionnaire_transport",
          version: 1,
          digest: "def",
          run_id: "run-7",
        },
        approval_challenge: "challenge-7",
        approval_run_id: "run-7",
        approval_gate_id: "plan_gate",
      },
    ];
    questions[0].rendered_questions_digest = renderedQuestionsDigest(
      normalizeEscalationQuestions(questions)
    );
    const result = {
      success: false,
      session_id: "session-7",
      skill_name: "code",
      state: "awaiting_clarification",
      requires_approval: true,
      steps_total: 1,
      agents_invoked: ["piper"],
      errors: [],
      escalation: { questions },
    };

    const formatted = formatResult(result, (_color, text) => text);
    const start = formatted.indexOf("questionnaire(") + "questionnaire(".length;
    const end = formatted.indexOf("\n  )", start);
    const payload = requireRecord(
      parseJson(formatted.slice(start, end)),
      "formatted questionnaire payload was not an object"
    );

    expect(payload).toHaveProperty("trustedTransportCapability");
    expect(formatted).not.toContain("challenge-7");
    const transport = resolveTrustedQuestionnaireTransport(
      requireString(
        payload.trustedTransportCapability,
        "formatted questionnaire payload omitted transport capability"
      )
    );
    expect(transport?.questions).toEqual(normalizeEscalationQuestions(questions));
    expect(transport?.questions[0].prompt).toContain(tail);
    expect(JSON.stringify(payload)).not.toContain("\u001b");
    expect(JSON.stringify(payload)).not.toContain("\u202e");
  });
});
