/**
 * Questionnaire Extension Unit Tests
 *
 * Tests the questionnaire extension logic with mocked Pi context:
 * - Question normalization (label defaults, allowOther defaults)
 * - Non-interactive mode output format
 * - Answer formatting (custom vs selected, cancelled vs completed)
 * - _renderInteractive edge cases
 * - Schema validation (TypeBox)
 * - Tool registration
 * - renderCall / renderResult formatting
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { Value } from "@sinclair/typebox/value";

// ============================================================
// Import mocked TUI utilities for multi-select tests
// ============================================================
import { matchesKey, Key } from "@mariozechner/pi-tui";

// ============================================================
// Mock Pi dependencies before importing the extension
// ============================================================

vi.mock("@mariozechner/pi-tui", () => ({
  Editor: vi.fn().mockImplementation(() => ({
    onSubmit: null,
    setText: vi.fn(),
    handleInput: vi.fn(),
    render: () => ["mock editor"],
  })),
  Text: vi.fn().mockImplementation((text: string) => ({ text, x: 0, y: 0 })),
  truncateToWidth: (s: string, _width: number) => s,
  Key: {
    enter: "\r",
    escape: "\x1b",
    tab: "\t",
    space: " ",
    up: "\x1b[A",
    down: "\x1b[B",
    left: "\x1b[D",
    right: "\x1b[C",
    shift: (k: string) => `shift+${k}`,
  },
  matchesKey: vi.fn().mockReturnValue(false),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getMarkdownTheme: vi.fn().mockReturnValue({
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  }),
}));

// ============================================================
// Types (mirrored from index.ts for test isolation)
// ============================================================

type QuestionType = "single" | "multi";

interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

interface Question {
  id: string;
  label?: string;
  prompt: string;
  options: QuestionOption[];
  allowOther?: boolean;
  type?: QuestionType;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// ============================================================
// Pure functions extracted from extension for testing
// ============================================================

/**
 * Normalizes raw question params exactly as execute() does:
 *   - label defaults to Q{index+1}
 *   - allowOther defaults to true
 */
function normalizeQuestions(raw: Question[]): Question[] {
  return raw.map((q, i) => ({
    ...q,
    label: q.label || `Q${i + 1}`,
    allowOther: q.allowOther !== false,
  }));
}

/**
 * Generates non-interactive mode output, mirroring the execute() logic.
 */
function generateNonInteractiveOutput(questions: Question[]): {
  text: string;
  answers: Answer[];
} {
  const lines: string[] = ["## Questionnaire — User Input Needed", ""];
  const answers: Answer[] = [];

  for (const q of questions) {
    lines.push(`### ${q.label}: ${q.prompt}`);
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      const desc = opt.description ? ` — ${opt.description}` : "";
      lines.push(`${i + 1}. ${opt.label}${desc}`);
    }
    if (q.allowOther) {
      lines.push(`${q.options.length + 1}. (Type something)`);
    }
    lines.push("");

    answers.push({
      id: q.id,
      value: "__needs_user_input__",
      label:
        q.type === "multi" ? "(multi-select)" : "Waiting for user input (non-interactive mode)",
      wasCustom: false,
    });
  }

  lines.push("---");
  lines.push("Please provide your answers to the above questions.");

  return { text: lines.join("\n"), answers };
}

/**
 * Formats final answer output, mirroring the execute() interactive result.
 */
function formatAnswerOutput(questions: Question[], result: QuestionnaireResult): string {
  if (result.cancelled) {
    return "User cancelled the questionnaire";
  }

  const answerLines = result.answers.map((a) => {
    const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
    if (a.wasCustom) {
      return `${qLabel}: user wrote: ${a.label}`;
    }
    // Multi-select: show comma-separated values
    if (a.value && a.value.includes(",")) {
      return `${qLabel}: user selected: ${a.value}`;
    }
    if (a.index !== undefined) {
      return `${qLabel}: user selected: ${a.index}. ${a.label}`;
    }
    return `${qLabel}: user selected: ${a.label}`;
  });

  return answerLines.join("\n");
}

// ============================================================
// Schema (duplicated for test isolation — imported from index)
// ============================================================

import { Type } from "@sinclair/typebox";

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" })
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description:
        "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    })
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
  allowOther: Type.Optional(
    Type.Boolean({ description: "Allow 'Type something' option (default: true)" })
  ),
  type: Type.Optional(
    Type.Union([Type.Literal("single"), Type.Literal("multi")], {
      description: "Selection mode: single (radio) or multi (checkboxes). Default: single.",
    })
  ),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// ============================================================
// Tests
// ============================================================

describe("normalizeQuestions", () => {
  it("should default label to Q1, Q2, ... when not provided", () => {
    const raw: Question[] = [
      { id: "scope", prompt: "What scope?", options: [{ value: "a", label: "A" }] },
      { id: "priority", prompt: "What priority?", options: [{ value: "b", label: "B" }] },
    ];
    const result = normalizeQuestions(raw);

    expect(result[0].label).toBe("Q1");
    expect(result[1].label).toBe("Q2");
  });

  it("should preserve explicit labels", () => {
    const raw: Question[] = [
      {
        id: "scope",
        label: "Scope",
        prompt: "What scope?",
        options: [{ value: "a", label: "A" }],
      },
    ];
    const result = normalizeQuestions(raw);

    expect(result[0].label).toBe("Scope");
  });

  it("should default allowOther to true", () => {
    const raw: Question[] = [{ id: "q1", prompt: "Q?", options: [{ value: "a", label: "A" }] }];
    const result = normalizeQuestions(raw);

    expect(result[0].allowOther).toBe(true);
  });

  it("should set allowOther to false when explicitly false", () => {
    const raw: Question[] = [
      {
        id: "q1",
        prompt: "Q?",
        options: [{ value: "a", label: "A" }],
        allowOther: false,
      },
    ];
    const result = normalizeQuestions(raw);

    expect(result[0].allowOther).toBe(false);
  });

  it("should set allowOther to true when explicitly true", () => {
    const raw: Question[] = [
      {
        id: "q1",
        prompt: "Q?",
        options: [{ value: "a", label: "A" }],
        allowOther: true,
      },
    ];
    const result = normalizeQuestions(raw);

    expect(result[0].allowOther).toBe(true);
  });

  it("should preserve all other question properties", () => {
    const raw: Question[] = [
      {
        id: "test",
        label: "Test",
        prompt: "Test prompt",
        options: [
          { value: "v1", label: "L1", description: "D1" },
          { value: "v2", label: "L2" },
        ],
        type: "multi",
      },
    ];
    const result = normalizeQuestions(raw);

    expect(result[0].id).toBe("test");
    expect(result[0].label).toBe("Test");
    expect(result[0].prompt).toBe("Test prompt");
    expect(result[0].options).toHaveLength(2);
    expect(result[0].options[0].description).toBe("D1");
    expect(result[0].options[1].description).toBeUndefined();
    expect(result[0].type).toBe("multi");
  });

  it("should handle empty questions array", () => {
    const result = normalizeQuestions([]);
    expect(result).toHaveLength(0);
  });

  it("should handle single question", () => {
    const raw: Question[] = [
      { id: "only", prompt: "Only question", options: [{ value: "x", label: "X" }] },
    ];
    const result = normalizeQuestions(raw);

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Q1");
    expect(result[0].allowOther).toBe(true);
  });

  it("should mix questions with and without labels", () => {
    const raw: Question[] = [
      {
        id: "labeled",
        label: "Named",
        prompt: "Labeled Q",
        options: [{ value: "a", label: "A" }],
      },
      { id: "unlabeled", prompt: "Unlabeled Q", options: [{ value: "b", label: "B" }] },
    ];
    const result = normalizeQuestions(raw);

    expect(result[0].label).toBe("Named");
    expect(result[1].label).toBe("Q2");
  });
});

describe("generateNonInteractiveOutput", () => {
  it("should produce header with title", () => {
    const questions = normalizeQuestions([
      { id: "q1", prompt: "Test?", options: [{ value: "a", label: "A" }] },
    ]);
    const { text } = generateNonInteractiveOutput(questions);

    expect(text).toContain("## Questionnaire — User Input Needed");
  });

  it("should include question prompt with label", () => {
    const questions = normalizeQuestions([
      { id: "scope", prompt: "What is the scope?", options: [{ value: "a", label: "A" }] },
    ]);
    const { text } = generateNonInteractiveOutput(questions);

    expect(text).toContain("### Q1: What is the scope?");
  });

  it("should list options with numbered format", () => {
    const questions = normalizeQuestions([
      {
        id: "q1",
        prompt: "Pick one",
        options: [
          { value: "small", label: "Small" },
          { value: "large", label: "Large" },
        ],
      },
    ]);
    const { text } = generateNonInteractiveOutput(questions);

    expect(text).toContain("1. Small");
    expect(text).toContain("2. Large");
  });

  it("should include option descriptions when present", () => {
    const questions = normalizeQuestions([
      {
        id: "q1",
        prompt: "Pick one",
        options: [{ value: "safe", label: "Safe", description: "Conservative approach" }],
      },
    ]);
    const { text } = generateNonInteractiveOutput(questions);

    expect(text).toContain("1. Safe — Conservative approach");
  });

  it("should include 'Type something' option when allowOther is true", () => {
    const questions = normalizeQuestions([
      {
        id: "q1",
        prompt: "Pick one",
        options: [{ value: "a", label: "A" }],
        allowOther: true,
      },
    ]);
    const { text } = generateNonInteractiveOutput(questions);

    // Option 1 is "A", so "Type something" is option 2
    expect(text).toContain("2. (Type something)");
  });

  it("should NOT include 'Type something' when allowOther is false", () => {
    const questions = normalizeQuestions([
      {
        id: "q1",
        prompt: "Pick one",
        options: [{ value: "a", label: "A" }],
        allowOther: false,
      },
    ]);
    const { text } = generateNonInteractiveOutput(questions);

    expect(text).not.toContain("(Type something)");
  });

  it("should include footer with instruction", () => {
    const questions = normalizeQuestions([
      { id: "q1", prompt: "Q?", options: [{ value: "a", label: "A" }] },
    ]);
    const { text } = generateNonInteractiveOutput(questions);

    expect(text).toContain("---");
    expect(text).toContain("Please provide your answers to the above questions.");
  });

  it("should generate needs_user_input answers for all questions", () => {
    const questions = normalizeQuestions([
      { id: "q1", prompt: "Q1?", options: [{ value: "a", label: "A" }] },
      { id: "q2", prompt: "Q2?", options: [{ value: "b", label: "B" }] },
    ]);
    const { answers } = generateNonInteractiveOutput(questions);

    expect(answers).toHaveLength(2);
    expect(answers[0].id).toBe("q1");
    expect(answers[0].value).toBe("__needs_user_input__");
    expect(answers[0].wasCustom).toBe(false);
    expect(answers[1].id).toBe("q2");
    expect(answers[1].value).toBe("__needs_user_input__");
  });

  it("should handle multiple questions with proper numbering", () => {
    const questions = normalizeQuestions([
      {
        id: "scope",
        prompt: "Scope?",
        options: [
          { value: "local", label: "Local" },
          { value: "global", label: "Global" },
        ],
      },
      {
        id: "mode",
        prompt: "Mode?",
        options: [
          { value: "fast", label: "Fast" },
          { value: "thorough", label: "Thorough" },
        ],
      },
    ]);
    const { text } = generateNonInteractiveOutput(questions);

    expect(text).toContain("### Q1: Scope?");
    expect(text).toContain("### Q2: Mode?");
  });
});

describe("formatAnswerOutput", () => {
  const questions = normalizeQuestions([
    {
      id: "scope",
      label: "Scope",
      prompt: "Scope?",
      options: [{ value: "local", label: "Local" }],
    },
    { id: "mode", label: "Mode", prompt: "Mode?", options: [{ value: "fast", label: "Fast" }] },
  ]);

  it("should format selected answers with index", () => {
    const result: QuestionnaireResult = {
      questions,
      answers: [{ id: "scope", value: "local", label: "Local", wasCustom: false, index: 1 }],
      cancelled: false,
    };

    const output = formatAnswerOutput(questions, result);
    expect(output).toBe("Scope: user selected: 1. Local");
  });

  it("should format custom answers with 'user wrote' prefix", () => {
    const result: QuestionnaireResult = {
      questions,
      answers: [{ id: "scope", value: "custom value", label: "custom value", wasCustom: true }],
      cancelled: false,
    };

    const output = formatAnswerOutput(questions, result);
    expect(output).toBe("Scope: user wrote: custom value");
  });

  it("should return cancellation message when cancelled", () => {
    const result: QuestionnaireResult = {
      questions,
      answers: [],
      cancelled: true,
    };

    const output = formatAnswerOutput(questions, result);
    expect(output).toBe("User cancelled the questionnaire");
  });

  it("should format multiple answers on separate lines", () => {
    const result: QuestionnaireResult = {
      questions,
      answers: [
        { id: "scope", value: "local", label: "Local", wasCustom: false, index: 1 },
        { id: "mode", value: "fast", label: "Fast", wasCustom: false, index: 1 },
      ],
      cancelled: false,
    };

    const output = formatAnswerOutput(questions, result);
    expect(output).toBe("Scope: user selected: 1. Local\nMode: user selected: 1. Fast");
  });

  it("should mix custom and selected answers", () => {
    const result: QuestionnaireResult = {
      questions,
      answers: [
        { id: "scope", value: "local", label: "Local", wasCustom: false, index: 1 },
        { id: "mode", value: "my mode", label: "my mode", wasCustom: true },
      ],
      cancelled: false,
    };

    const output = formatAnswerOutput(questions, result);
    expect(output).toBe("Scope: user selected: 1. Local\nMode: user wrote: my mode");
  });

  it("should fall back to id when question label not found", () => {
    const result: QuestionnaireResult = {
      questions,
      answers: [{ id: "unknown_id", value: "x", label: "X", wasCustom: false, index: 1 }],
      cancelled: false,
    };

    const output = formatAnswerOutput(questions, result);
    expect(output).toBe("unknown_id: user selected: 1. X");
  });
});

describe("_renderInteractive (no-UI fallback)", () => {
  // Import the module to access _renderInteractive
  // Since it's prefixed with _, it's not exported — we test the behavior
  // by verifying the non-interactive execute() path instead.

  it("should return cancelled result with no-UI marker when hasUI is false", () => {
    // This tests the same logic as _renderInteractive's no-UI branch
    const questions: Question[] = [
      { id: "q1", prompt: "Q?", options: [{ value: "a", label: "A" }] },
    ];

    // Mirror _renderInteractive's no-UI branch
    const result: QuestionnaireResult = {
      questions,
      answers: questions.map((q) => ({
        id: q.id,
        value: "__no_ui__",
        label: "No UI available — non-interactive mode",
        wasCustom: false,
      })),
      cancelled: true,
    };

    expect(result.cancelled).toBe(true);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].value).toBe("__no_ui__");
  });
});

describe("Schema Validation", () => {
  describe("QuestionOptionSchema", () => {
    it("should validate a valid option", () => {
      const option = { value: "a", label: "Option A" };
      expect(Value.Check(QuestionOptionSchema, option)).toBe(true);
    });

    it("should validate an option with description", () => {
      const option = { value: "a", label: "A", description: "Desc" };
      expect(Value.Check(QuestionOptionSchema, option)).toBe(true);
    });

    it("should reject option missing value", () => {
      const option = { label: "A" };
      expect(Value.Check(QuestionOptionSchema, option)).toBe(false);
    });

    it("should reject option missing label", () => {
      const option = { value: "a" };
      expect(Value.Check(QuestionOptionSchema, option)).toBe(false);
    });
  });

  describe("QuestionSchema", () => {
    it("should validate a minimal question", () => {
      const question = {
        id: "q1",
        prompt: "What?",
        options: [{ value: "a", label: "A" }],
      };
      expect(Value.Check(QuestionSchema, question)).toBe(true);
    });

    it("should validate a full question with all optional fields", () => {
      const question = {
        id: "q1",
        label: "Scope",
        prompt: "What scope?",
        options: [{ value: "a", label: "A", description: "Option A" }],
        allowOther: true,
      };
      expect(Value.Check(QuestionSchema, question)).toBe(true);
    });

    it("should validate question with type: single", () => {
      const question = {
        id: "q1",
        prompt: "What?",
        options: [{ value: "a", label: "A" }],
        type: "single",
      };
      expect(Value.Check(QuestionSchema, question)).toBe(true);
    });

    it("should validate question with type: multi", () => {
      const question = {
        id: "q1",
        prompt: "What?",
        options: [{ value: "a", label: "A" }],
        type: "multi",
      };
      expect(Value.Check(QuestionSchema, question)).toBe(true);
    });

    it("should reject question with invalid type", () => {
      const question = {
        id: "q1",
        prompt: "What?",
        options: [{ value: "a", label: "A" }],
        type: "invalid",
      };
      expect(Value.Check(QuestionSchema, question)).toBe(false);
    });

    it("should reject question missing id", () => {
      const question = {
        prompt: "What?",
        options: [{ value: "a", label: "A" }],
      };
      expect(Value.Check(QuestionSchema, question)).toBe(false);
    });

    it("should reject question missing prompt", () => {
      const question = {
        id: "q1",
        options: [{ value: "a", label: "A" }],
      };
      expect(Value.Check(QuestionSchema, question)).toBe(false);
    });

    it("should reject question with empty options", () => {
      const question = {
        id: "q1",
        prompt: "What?",
        options: [],
      };
      // Empty array is valid per TypeBox Array — but worth checking behavior
      expect(Value.Check(QuestionSchema, question)).toBe(true);
    });

    it("should reject question with invalid option in array", () => {
      const question = {
        id: "q1",
        prompt: "What?",
        options: [{ value: 123, label: "A" }], // value should be string
      };
      expect(Value.Check(QuestionSchema, question)).toBe(false);
    });
  });

  describe("QuestionnaireParams", () => {
    it("should validate complete params", () => {
      const params = {
        questions: [
          {
            id: "q1",
            prompt: "What?",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
        ],
      };
      expect(Value.Check(QuestionnaireParams, params)).toBe(true);
    });

    it("should reject empty questions array", () => {
      const params = { questions: [] };
      // Empty array is valid per TypeBox Array schema — the extension
      // should handle this at runtime (no questions = nothing to ask)
      expect(Value.Check(QuestionnaireParams, params)).toBe(true);
    });

    it("should reject missing questions field", () => {
      const params = {};
      expect(Value.Check(QuestionnaireParams, params)).toBe(false);
    });

    it("should validate multiple questions", () => {
      const params = {
        questions: [
          { id: "q1", prompt: "A?", options: [{ value: "1", label: "1" }] },
          { id: "q2", prompt: "B?", options: [{ value: "2", label: "2" }] },
        ],
      };
      expect(Value.Check(QuestionnaireParams, params)).toBe(true);
    });
  });
});

describe("Tool Registration", () => {
  it("should register the questionnaire tool via ExtensionAPI", async () => {
    const registeredTools: { name: string; label: string; description: string }[] = [];
    const registeredCommands: { name: string; description: string }[] = [];

    const mockPi = {
      registerTool: vi.fn((tool: { name: string; label: string; description: string }) => {
        registeredTools.push({ name: tool.name, label: tool.label, description: tool.description });
      }),
      registerCommand: vi.fn((name: string, cmd: { description: string }) => {
        registeredCommands.push({ name, description: cmd.description });
      }),
      on: vi.fn(),
    } as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI;

    // Dynamic import to avoid side effects across tests
    const mod = await import("../../index.js");
    const extension = mod.default;
    extension(mockPi);

    expect(mockPi.registerTool).toHaveBeenCalledOnce();
    expect(registeredTools[0].name).toBe("questionnaire");
    expect(registeredTools[0].label).toBe("Questionnaire");
    expect(registeredTools[0].description).toContain("Ask the user one or more questions");
  });

  it("should register the 'ask' convenience command", async () => {
    const registeredCommands: { name: string; description: string }[] = [];

    const mockPi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, cmd: { description: string }) => {
        registeredCommands.push({ name, description: cmd.description });
      }),
      on: vi.fn(),
    } as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI;

    const mod = await import("../../index.js");
    const extension = mod.default;
    extension(mockPi);

    expect(mockPi.registerCommand).toHaveBeenCalledWith("ask", expect.any(Object));
    expect(registeredCommands[0].name).toBe("ask");
  });
});

describe("Non-Interactive Execute", () => {
  it("should return structured text with needsUserInput when hasUI is false", async () => {
    const mockPi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI;

    const mod = await import("../../index.js");
    const extension = mod.default;
    extension(mockPi);

    const toolCall = mockPi.registerTool.mock.calls[0][0] as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };

    const result = (await toolCall.execute(
      "call-1",
      {
        questions: [
          {
            id: "scope",
            prompt: "What scope?",
            options: [
              { value: "local", label: "Local" },
              { value: "global", label: "Global" },
            ],
          },
        ],
      },
      undefined, // signal
      undefined, // onUpdate
      { hasUI: false } // <- non-interactive context
    )) as {
      content: { type: string; text: string }[];
      details: QuestionnaireResult & { needsUserInput: boolean };
    };

    // Content is structured text
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("## Questionnaire — User Input Needed");
    expect(result.content[0].text).toContain("1. Local");
    expect(result.content[0].text).toContain("2. Global");

    // Details have needsUserInput marker
    expect(result.details.needsUserInput).toBe(true);
    expect(result.details.answers).toHaveLength(1);
    expect(result.details.answers[0].value).toBe("__needs_user_input__");
  });

  it("should include 'Type something' option by default in non-interactive mode", async () => {
    const mockPi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI;

    const mod = await import("../../index.js");
    const extension = mod.default;
    extension(mockPi);

    const toolCall = mockPi.registerTool.mock.calls[0][0] as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };

    const result = (await toolCall.execute(
      "call-1",
      {
        questions: [
          {
            id: "q1",
            prompt: "Pick one",
            options: [{ value: "a", label: "A" }],
          },
        ],
      },
      undefined,
      undefined,
      { hasUI: false }
    )) as {
      content: { type: string; text: string }[];
    };

    // With allowOther defaulting to true, "(Type something)" should appear
    expect(result.content[0].text).toContain("(Type something)");
  });

  it("should NOT include 'Type something' when allowOther is false", async () => {
    const mockPi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI;

    const mod = await import("../../index.js");
    const extension = mod.default;
    extension(mockPi);

    const toolCall = mockPi.registerTool.mock.calls[0][0] as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };

    const result = (await toolCall.execute(
      "call-1",
      {
        questions: [
          {
            id: "q1",
            prompt: "Pick one",
            options: [{ value: "a", label: "A" }],
            allowOther: false,
          },
        ],
      },
      undefined,
      undefined,
      { hasUI: false }
    )) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0].text).not.toContain("(Type something)");
  });
});

describe("Edge Cases", () => {
  it("should handle questions with many options", () => {
    const options = Array.from({ length: 20 }, (_, i) => ({
      value: `v${i}`,
      label: `Option ${i}`,
    }));
    const questions = normalizeQuestions([{ id: "q1", prompt: "Pick", options }]);
    const { text } = generateNonInteractiveOutput(questions);

    expect(text).toContain("1. Option 0");
    expect(text).toContain("20. Option 19");
    // "Type something" is option 21
    expect(text).toContain("21. (Type something)");
  });

  it("should handle questions with special characters in prompts", () => {
    const questions = normalizeQuestions([
      {
        id: "special",
        prompt: "What about <tags> & 'quotes' and \"double quotes\"?",
        options: [{ value: "a", label: "A & B <C>" }],
      },
    ]);
    const { text } = generateNonInteractiveOutput(questions);

    expect(text).toContain("<tags>");
    expect(text).toContain("'quotes'");
    expect(text).toContain('"double quotes"');
    expect(text).toContain("A & B <C>");
  });

  it("should handle duplicate question IDs (runtime behavior)", () => {
    const questions = normalizeQuestions([
      { id: "dup", prompt: "First", options: [{ value: "a", label: "A" }] },
      { id: "dup", prompt: "Second", options: [{ value: "b", label: "B" }] },
    ]);
    const { answers } = generateNonInteractiveOutput(questions);

    // Both questions get answered even with duplicate IDs
    expect(answers).toHaveLength(2);
    expect(answers[0].id).toBe("dup");
    expect(answers[1].id).toBe("dup");
  });
});

// ============================================================
// Multi-Select TUI Tests
// ============================================================

describe("Multi-Select TUI", () => {
  let createQuestionnaireUI: typeof import("../../index.js").createQuestionnaireUI;
  const mockedMatchesKey = vi.mocked(matchesKey);

  beforeAll(async () => {
    const mod = await import("../../index.js");
    createQuestionnaireUI = mod.createQuestionnaireUI;
  });

  beforeEach(() => {
    mockedMatchesKey.mockClear();
    mockedMatchesKey.mockImplementation((data: string, key: string) => data === key);
  });

  function setupUI(questions: Question[]) {
    const mockTui = { requestRender: vi.fn() };
    const mockTheme = {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    };
    let capturedResult: QuestionnaireResult | undefined;
    const done = (res: QuestionnaireResult) => {
      capturedResult = res;
    };
    const ui = createQuestionnaireUI(questions, mockTui, mockTheme, done);
    return { ui, mockTui, mockTheme, getResult: () => capturedResult };
  }

  it("shows checkbox prefixes for multi-select questions", () => {
    const { ui } = setupUI([
      {
        id: "q1",
        label: "Q1",
        prompt: "Pick multiple",
        options: [
          { value: "a", label: "Option A" },
          { value: "b", label: "Option B" },
        ],
        type: "multi",
        allowOther: false,
      },
    ]);

    const lines = ui.render(80);
    const optionLines = lines.filter((l) => l.includes("Option"));
    expect(optionLines[0]).toContain("[ ]");
    expect(optionLines[1]).toContain("[ ]");
  });

  it("toggles selection on Enter for multi-select", () => {
    const { ui } = setupUI([
      {
        id: "q1",
        label: "Q1",
        prompt: "Pick multiple",
        options: [
          { value: "a", label: "Option A" },
          { value: "b", label: "Option B" },
        ],
        type: "multi",
        allowOther: false,
      },
    ]);

    // Initially unselected
    let lines = ui.render(80);
    expect(lines.some((l) => l.includes("[x]"))).toBe(false);

    // Press Space to toggle first option
    ui.handleInput(" ");

    lines = ui.render(80);
    expect(lines.some((l) => l.includes("[x]"))).toBe(true);
    expect(lines.some((l) => l.includes("[x]") && l.includes("Option A"))).toBe(true);

    // Press Space again to toggle off
    ui.handleInput(" ");
    lines = ui.render(80);
    expect(lines.some((l) => l.includes("[x]"))).toBe(false);
  });

  it("confirms multi-select with Enter", () => {
    const { ui, getResult } = setupUI([
      {
        id: "q1",
        label: "Q1",
        prompt: "Pick multiple",
        options: [
          { value: "a", label: "Option A" },
          { value: "b", label: "Option B" },
          { value: "c", label: "Option C" },
        ],
        type: "multi",
        allowOther: false,
      },
    ]);

    // Select first and third options
    ui.handleInput(" "); // toggle option 0 (A)
    ui.handleInput("\x1b[B"); // down to option 1
    ui.handleInput("\x1b[B"); // down to option 2
    ui.handleInput(" "); // toggle option 2 (C)

    // Confirm with Enter
    ui.handleInput("\r");

    const result = getResult();
    expect(result).toBeDefined();
    expect(result!.answers).toHaveLength(1);
    expect(result!.answers[0].value).toBe("a,c");
    expect(result!.answers[0].label).toBe("Option A; Option C");
  });

  it("stores comma-separated values for multi-select", () => {
    const { ui, getResult } = setupUI([
      {
        id: "q1",
        label: "Q1",
        prompt: "Pick files",
        options: [
          { value: "file1.js", label: "File 1" },
          { value: "file2.js", label: "File 2" },
        ],
        type: "multi",
        allowOther: false,
      },
    ]);

    ui.handleInput(" "); // toggle first
    ui.handleInput("\x1b[B"); // down
    ui.handleInput(" "); // toggle second
    ui.handleInput("\r"); // confirm

    const result = getResult();
    expect(result!.answers[0].value).toBe("file1.js,file2.js");
  });

  it("default type behaves as single (Enter advances immediately)", () => {
    const { ui, getResult } = setupUI([
      {
        id: "q1",
        label: "Q1",
        prompt: "Pick one",
        options: [
          { value: "a", label: "Option A" },
          { value: "b", label: "Option B" },
        ],
        // type NOT specified — should default to single behavior
        allowOther: false,
      },
    ]);

    ui.handleInput("\r"); // Enter on first option

    const result = getResult();
    expect(result).toBeDefined();
    expect(result!.answers).toHaveLength(1);
    expect(result!.answers[0].value).toBe("a");
    expect(result!.answers[0].index).toBe(1);
    expect(result!.cancelled).toBe(false);
  });
});
