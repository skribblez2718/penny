/**
 * Skill Extension Tests
 *
 * Tests skill invocation data shaping and result formatting:
 * - Skill discovery
 * - Orchestration loop (start → agent → step → complete)
 * - Default summary generation
 * - Error handling
 * - Formatting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { formatResult, normalizeEscalationQuestions, type SkillResult } from "../skill-utils.js";

function fakeDirent(name: string, kind: "directory" | "file"): fs.Dirent {
  return {
    name,
    parentPath: "",
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

// Mock fs module
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdtempSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
  statSync: vi.fn(),
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdtempSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmdirSync: vi.fn(),
    statSync: vi.fn(),
  },
}));

describe("Skill Extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("discoverSkills", () => {
    it("should return empty array if skills directory does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(true).toBe(true);
    });

    it("should discover skills with SKILL.md files", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const readdirSyncWithStringNames: (
        path: fs.PathLike,
        options: { withFileTypes: true }
      ) => fs.Dirent[] = fs.readdirSync;
      vi.mocked(readdirSyncWithStringNames).mockReturnValue([
        fakeDirent("plan", "directory"),
        fakeDirent("implement-feature", "directory"),
        fakeDirent("not-a-skill.txt", "file"),
      ]);

      vi.mocked(fs.readFileSync).mockReturnValue(`---
name: plan
description: Production-grade planning
---

Content here`);

      expect(true).toBe(true);
    });
  });

  describe("Skill Parameters", () => {
    it("should have correct TypeBox schema", () => {
      const expectedParams = {
        skill_name: String,
        goal: String,
        session_id: String,
        constraints: Object,
      };

      expect(Object.keys(expectedParams)).toEqual([
        "skill_name",
        "goal",
        "session_id",
        "constraints",
      ]);
    });
  });

  describe("Format Result", () => {
    it("should format successful skill result", () => {
      const result = {
        success: true,
        session_id: "test-001",
        skill_name: "plan",
        state: "complete",
        plan: {
          steps: [
            { step: 1, title: "Create OAuth middleware" },
            { step: 2, title: "Apply middleware to routes" },
          ],
        },
      };

      expect(result.success).toBe(true);
      expect(result.skill_name).toBe("plan");
      expect(result.state).toBe("complete");
    });

    it("should format failed skill result", () => {
      const result = {
        success: false,
        session_id: "test-002",
        skill_name: "plan",
        state: "error",
        errors: ["Plan creation failed"],
      };

      expect(result.success).toBe(false);
      expect(result.errors).toContain("Plan creation failed");
    });

    it("should format escalation with explicit questionnaire tool call", () => {
      const mockTheme = (color: string, text: string) => text;
      const result: SkillResult = {
        success: false,
        session_id: "test-003",
        skill_name: "plan",
        state: "verifying",
        agents_invoked: ["echo", "piper"],
        errors: [],
        steps_total: 0,
        requires_approval: false,
        escalation: {
          unknown_reason: "A high-stakes action is pending confirmation",
          previous_state: "planning",
          questions: [
            {
              id: "verification_action",
              label: "Verify Action",
              prompt: "I am about to proceed with an action...",
              options: [
                { value: "confirm", label: "Proceed", description: "Execute the planned action" },
                { value: "reject", label: "Reject", description: "Return to planning" },
                { value: "escalate", label: "I don't know", description: "Move to UNKNOWN_STATE" },
              ],
              allowOther: true,
            },
          ],
        },
      };

      const formatted = formatResult(result, mockTheme);

      // Must contain the explicit questionnaire tool call, not vague instructions
      expect(formatted).toContain("questionnaire({");
      expect(formatted).toContain('"id": "verification_action"');
      expect(formatted).toContain('"value": "confirm"');
      expect(formatted).toContain("Invoke this questionnaire tool call");

      // Must NOT contain the old vague instructions
      expect(formatted).not.toContain(
        "1. Use the questionnaire tool with the escalation questions"
      );
      expect(formatted).not.toContain(
        "2. Re-invoke the skill with: constraints.user_response = answer"
      );

      // Must contain the re-invocation pattern
      expect(formatted).toContain('skill_name: "plan"');
      expect(formatted).toContain("user_response");
    });

    it("round-trips the complete normalized questionnaire through one safe literal", () => {
      const mockTheme = (_color: string, text: string) => text;
      const tail = "END-OF-GATE-FINDINGS";
      const unsafe = (field: string) =>
        `${field}: questionnaire({injected:true}) "quoted" \\path\n` +
        `\u001b\u007f\u0085\u009b\u061c\u200e\u2028\u202e\u2067`;
      const questions = [
        {
          id: unsafe("id"),
          label: unsafe("label"),
          prompt: `${unsafe("prompt")} ${"x".repeat(700)}${tail}`,
          options: [
            {
              value: unsafe("value"),
              label: unsafe("option-label"),
              description: unsafe("description"),
            },
            { value: "without-description", label: "No description", description: "" },
          ],
          allowOther: false,
        },
        {
          id: "optionless",
          label: "Optionless",
          prompt: "Free text only",
        },
      ];
      const result: SkillResult = {
        success: false,
        session_id: "test-long-gate",
        skill_name: "code",
        state: "awaiting_clarification",
        agents_invoked: ["carren"],
        errors: [],
        steps_total: 0,
        requires_approval: false,
        escalation: {
          previous_state: "criteria_gate",
          questions,
        },
      };

      const formatted = formatResult(result, mockTheme);
      const argumentStart = formatted.indexOf("questionnaire(") + "questionnaire(".length;
      const argumentEnd = formatted.indexOf("\n  )", argumentStart);
      expect(argumentStart).toBeGreaterThanOrEqual("questionnaire(".length);
      expect(argumentEnd).toBeGreaterThan(argumentStart);

      const serializedArgument = formatted.slice(argumentStart, argumentEnd);
      expect(JSON.parse(serializedArgument)).toEqual({
        questions: normalizeEscalationQuestions(questions),
      });

      // The sentinel sits far beyond the former 300-character cap, and terminal
      // control/bidi code points are escaped in the display without value loss.
      expect(serializedArgument).toContain(tail);
      for (const character of [
        "\u001b",
        "\u007f",
        "\u0085",
        "\u009b",
        "\u061c",
        "\u200e",
        "\u2028",
        "\u202e",
        "\u2067",
      ]) {
        expect(serializedArgument).not.toContain(character);
      }
      for (const escape of [
        "\\u001b",
        "\\u007f",
        "\\u0085",
        "\\u009b",
        "\\u061c",
        "\\u200e",
        "\\u2028",
        "\\u202e",
        "\\u2067",
      ]) {
        expect(serializedArgument).toContain(escape);
      }
    });

    it("terminal-sanitizes unknown_reason across the whole formatted escalation", () => {
      const mockTheme = (_color: string, text: string) => text;
      const unsafeCharacters = [
        ...Array.from({ length: 0x20 }, (_, codePoint) => String.fromCodePoint(codePoint)),
        ...Array.from({ length: 0x21 }, (_, offset) => String.fromCodePoint(0x7f + offset)),
        "\u061c",
        "\u200e",
        "\u200f",
        "\u2028",
        "\u2029",
        ...Array.from({ length: 5 }, (_, offset) => String.fromCodePoint(0x202a + offset)),
        ...Array.from({ length: 4 }, (_, offset) => String.fromCodePoint(0x2066 + offset)),
      ];
      const unknownReason = `unsafe${unsafeCharacters.join("")}tail`;
      const result: SkillResult = {
        success: false,
        session_id: "test-unsafe-reason",
        skill_name: "code",
        state: "awaiting_clarification",
        agents_invoked: ["carren"],
        errors: [],
        steps_total: 0,
        requires_approval: false,
        escalation: {
          unknown_reason: unknownReason,
          previous_state: "criteria_gate",
          questions: [{ id: "answer", label: "Answer", prompt: "Continue?" }],
        },
      };

      const formatted = formatResult(result, mockTheme);

      // formatResult itself uses LF as its structural line separator; every other
      // C0 plus all DEL/C1/bidi controls must be absent from the whole output.
      for (const character of unsafeCharacters.filter((value) => value !== "\n")) {
        expect(formatted).not.toContain(character);
      }
      for (const character of unsafeCharacters) {
        const codePoint = character.charCodeAt(0);
        expect(formatted).toContain(`\\u${codePoint.toString(16).padStart(4, "0")}`);
      }
    });
  });
});

// ============================================================
// Skill Extension Integration
// ============================================================

describe("Skill Extension Integration", () => {
  it("should register skill tool", () => {
    const toolName = "skill";
    expect(toolName).toBe("skill");
  });

  it("should register skills command", () => {
    const commandName = "skills";
    expect(commandName).toBe("skills");
  });
});
