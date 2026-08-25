/**
 * Questionnaire Extension Integration Tests
 *
 * Tests the questionnaire tool with real Pi ExtensionAPI:
 * - Tool registration and schema validity
 * - Non-interactive execute with realistic context
 * - renderCall / renderResult with real theme functions
 * - Command registration
 *
 * These tests use mock ExtensionAPI but real TypeBox schemas
 * and test the full execute() flow without TUI dependencies.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock TUI dependencies (integration tests don't need actual TUI)
vi.mock("@earendil-works/pi-tui", () => ({
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
    up: "\x1b[A",
    down: "\x1b[B",
    left: "\x1b[D",
    right: "\x1b[C",
    shift: (k: string) => `shift+${k}`,
  },
  matchesKey: vi.fn().mockReturnValue(false),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getMarkdownTheme: vi.fn().mockReturnValue({
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  }),
}));

import {
  registerTrustedQuestionnaireTransport,
  renderedQuestionsDigest,
  verifyOwnerReceiptForTest,
} from "../../../skill/execution-receipts.js";
import {
  createExtensionApiHarness,
  requireBoolean,
  requireDefined,
  requireQuestionnaireCommand,
  requireQuestionnaireTool,
  requireQuestionnaireToolResult,
  requireRecord,
  requireTextComponent,
  type QuestionnaireToolResult,
  type RegisteredQuestionnaireCommand,
  type RegisteredQuestionnaireTool,
} from "../helpers.js";

async function registerQuestionnaire(): Promise<{
  tool: RegisteredQuestionnaireTool;
  commands: RegisteredQuestionnaireCommand[];
}> {
  const harness = createExtensionApiHarness();
  const mod = await import("../../index.js");
  mod.default(harness.api);
  return {
    tool: requireQuestionnaireTool(harness.registeredTools[0]),
    commands: harness.registeredCommands.map((command) => requireQuestionnaireCommand(command)),
  };
}

async function executeQuestionnaire(
  execute: (...args: unknown[]) => Promise<unknown>,
  ...args: unknown[]
): Promise<QuestionnaireToolResult> {
  return requireQuestionnaireToolResult(await execute(...args));
}

describe("Questionnaire Integration — Tool Registration", () => {
  let registeredTool: RegisteredQuestionnaireTool;
  let registeredCommands: RegisteredQuestionnaireCommand[];

  beforeAll(async () => {
    const registration = await registerQuestionnaire();
    registeredTool = registration.tool;
    registeredCommands = registration.commands;
  });

  it("should register exactly one tool", () => {
    expect(registeredTool).toBeDefined();
    expect(registeredTool.name).toBe("questionnaire");
  });

  it("should expose a FLAT object schema with both mutually-exclusive params", () => {
    // Regression guard: a top-level anyOf/union cannot cross the pi
    // tool-schema bridge — it degrades to an empty properties schema and the
    // harness stringifies structured args, breaking every call. The schema
    // must stay a flat object; exactly-one-of is enforced at runtime in
    // execute().
    expect(registeredTool.parameters).toBeDefined();
    const parameters = requireRecord(
      registeredTool.parameters,
      "questionnaire parameters were not an object"
    );
    const properties = requireRecord(
      parameters.properties,
      "questionnaire parameter properties were not registered"
    );
    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.type).toBe("object");
    expect(properties).toHaveProperty("questions");
    expect(properties).toHaveProperty("trustedTransportCapability");
    expect(parameters.additionalProperties).toBe(false);
  });

  it("should have renderCall method", () => {
    expect(registeredTool.renderCall).toBeDefined();
    expect(typeof registeredTool.renderCall).toBe("function");
  });

  it("should have renderResult method", () => {
    expect(registeredTool.renderResult).toBeDefined();
    expect(typeof registeredTool.renderResult).toBe("function");
  });

  it("should register the 'ask' command", () => {
    expect(registeredCommands).toHaveLength(1);
    expect(requireDefined(registeredCommands[0], "ask command was not registered").name).toBe(
      "ask"
    );
  });
});

describe("Questionnaire Integration — Non-Interactive Execute", () => {
  let execute: (...args: unknown[]) => Promise<unknown>;

  beforeAll(async () => {
    execute = (await registerQuestionnaire()).tool.execute;
  });

  it("should return structured text with proper Markdown headers", async () => {
    const result = await executeQuestionnaire(
      execute,
      "call-int-1",
      {
        questions: [
          {
            id: "scope",
            prompt: "What is the scope?",
            options: [
              { value: "local", label: "Local" },
              { value: "global", label: "Global" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      { hasUI: false }
    );

    const text = requireDefined(result.content[0], "questionnaire result content is missing").text;
    expect(text).toContain("## Questionnaire");
    expect(text).toContain("### Q1: What is the scope?");
    expect(text).toContain("1. Local");
    expect(text).toContain("2. Global");
    expect(text).toContain("---");
  });

  it("should include needsUserInput marker in details", async () => {
    const result = await executeQuestionnaire(
      execute,
      "call-int-2",
      {
        questions: [{ id: "q1", prompt: "Q?", options: [{ value: "a", label: "A" }] }],
      },
      undefined,
      undefined,
      { hasUI: false }
    );
    const details = requireDefined(result.details, "questionnaire result details are missing");

    expect(requireBoolean(details.needsUserInput, "needsUserInput marker is missing")).toBe(true);
    expect(requireBoolean(details.cancelled, "cancelled marker is missing")).toBe(false);
  });

  it("signs a gate event only for owner-registered content shown to an interactive human", async () => {
    const questions = [
      {
        id: "criteria",
        label: "Criteria",
        prompt: "Approve exact artifact?",
        options: [{ value: "approve", label: "Approve" }],
        allowOther: true,
      },
    ];
    const capability = registerTrustedQuestionnaireTransport(questions, {
      runId: "run-1",
      gateId: "criteria_gate",
      challenge: "challenge-1",
      artifactRef: {
        artifact_id: "artifact-1",
        kind: "ideal_state_revision",
        version: 1,
        digest: "a".repeat(64),
      },
      transportRef: {
        artifact_id: "transport-1",
        kind: "questionnaire_transport",
        version: 1,
        digest: "b".repeat(64),
      },
      renderedQuestionsDigest: renderedQuestionsDigest(questions),
    });
    expect(capability).toBeTruthy();
    const result = await executeQuestionnaire(
      execute,
      "call-gate",
      { trustedTransportCapability: capability },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          custom: vi.fn().mockResolvedValue({
            questions: [],
            answers: [
              {
                id: "criteria",
                value: "approve",
                label: "Approve",
                wasCustom: false,
                index: 1,
              },
            ],
            cancelled: false,
          }),
          notify: vi.fn(),
        },
      }
    );
    const details = requireDefined(result.details, "trusted questionnaire details are missing");
    const trustedEvents = details.trustedHumanEvents;
    if (!Array.isArray(trustedEvents)) {
      throw new Error("trusted questionnaire events are missing");
    }
    const event = requireRecord(trustedEvents[0], "trusted questionnaire event is missing");
    expect(event).toMatchObject({
      schema_version: 2,
      origin: "trusted-human-ui",
      run_id: "run-1",
      gate_id: "criteria_gate",
      decision: "approve",
      response: "approve",
      actor: "human:interactive-questionnaire",
      rendered_questions_digest: renderedQuestionsDigest(questions),
      questionnaire_transport_ref: {
        artifact_id: "transport-1",
        kind: "questionnaire_transport",
      },
    });
    expect(verifyOwnerReceiptForTest(event)).toBe(true);
    expect(requireDefined(result.content[0], "trusted result content is missing").text).toContain(
      "TRUSTED_HUMAN_EVENT:"
    );
  });

  it("rejects caller-substituted questions instead of signing altered gate content", async () => {
    const questions = [
      {
        id: "plan",
        label: "Plan",
        prompt: "Canonical plan content",
        options: [{ value: "approve", label: "Approve" }],
        allowOther: false,
      },
    ];
    const capability = registerTrustedQuestionnaireTransport(questions, {
      runId: "run-adversarial",
      gateId: "plan_gate",
      challenge: "challenge-adversarial",
      artifactRef: { artifact_id: "plan-1" },
      transportRef: { artifact_id: "transport-adversarial" },
      renderedQuestionsDigest: renderedQuestionsDigest(questions),
    });
    const result = await executeQuestionnaire(
      execute,
      "call-altered-gate",
      {
        trustedTransportCapability: capability,
        questions: [
          {
            id: "plan",
            prompt: "Altered content",
            options: [{ value: "approve", label: "Approve" }],
          },
        ],
      },
      undefined,
      undefined,
      { hasUI: true, ui: { custom: vi.fn(), notify: vi.fn() } }
    );
    const content = requireDefined(result.content[0], "altered-gate result content is missing");
    const details = requireDefined(result.details, "altered-gate result details are missing");

    expect(content.text).toContain("exactly one");
    expect(content.text).not.toContain("TRUSTED_HUMAN_EVENT:");
    expect(details.trustedHumanEvents).toBeUndefined();
  });

  it("should auto-number options correctly across multiple questions", async () => {
    const result = await executeQuestionnaire(
      execute,
      "call-int-3",
      {
        questions: [
          {
            id: "q1",
            prompt: "First?",
            options: [
              { value: "a", label: "A1" },
              { value: "b", label: "B1" },
              { value: "c", label: "C1" },
            ],
          },
          {
            id: "q2",
            prompt: "Second?",
            options: [
              { value: "x", label: "X2" },
              { value: "y", label: "Y2" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      { hasUI: false }
    );

    const text = requireDefined(result.content[0], "auto-numbered result content is missing").text;
    // Q1 options: 1-3, Type something=4
    expect(text).toContain("1. A1");
    expect(text).toContain("3. C1");
    expect(text).toContain("4. (Type something)");
    // Q2 options: 1-2, Type something=3
    expect(text).toContain("1. X2");
    expect(text).toContain("2. Y2");
    // Second "(Type something)" for Q2
    const typeSomethingCount = [...text.matchAll(/\(Type something\)/g)].length;
    expect(typeSomethingCount).toBe(2);
  });

  it("should include option descriptions when provided", async () => {
    const result = await executeQuestionnaire(
      execute,
      "call-int-4",
      {
        questions: [
          {
            id: "q1",
            prompt: "Pick one",
            options: [
              { value: "safe", label: "Safe", description: "Conservative approach" },
              { value: "risky", label: "Risky", description: "High risk, high reward" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      { hasUI: false }
    );

    const text = requireDefined(
      result.content[0],
      "described-option result content is missing"
    ).text;
    expect(text).toContain("1. Safe — Conservative approach");
    expect(text).toContain("2. Risky — High risk, high reward");
  });

  it("should handle multiple questions with different allowOther settings", async () => {
    const result = await executeQuestionnaire(
      execute,
      "call-int-5",
      {
        questions: [
          {
            id: "fixed",
            prompt: "Fixed choice",
            options: [{ value: "a", label: "A" }],
            allowOther: false,
          },
          {
            id: "open",
            prompt: "Open choice",
            options: [{ value: "b", label: "B" }],
            allowOther: true,
          },
        ],
      },
      undefined,
      undefined,
      { hasUI: false }
    );

    const text = requireDefined(result.content[0], "allowOther result content is missing").text;
    // Fixed question: only 1 option, no "Type something"
    // We need to verify the fixed question section doesn't have (Type something)
    // and the open question section does.
    // The text has both questions — we split on "###" to isolate
    const sections = text.split("### ");
    const fixedSection = sections.find((s) => s.startsWith("Q1"));
    const openSection = sections.find((s) => s.startsWith("Q2"));

    expect(fixedSection).toBeDefined();
    expect(openSection).toBeDefined();
    const fixedQuestion = requireDefined(fixedSection, "fixed question section was not rendered");
    const openQuestion = requireDefined(openSection, "open question section was not rendered");
    expect(fixedQuestion).not.toContain("(Type something)");
    expect(openQuestion).toContain("(Type something)");
  });
});

describe("Questionnaire Integration — renderCall", () => {
  let renderCall: (args: unknown, theme: unknown) => unknown;

  beforeAll(async () => {
    const tool = (await registerQuestionnaire()).tool;
    renderCall = requireDefined(tool.renderCall, "questionnaire renderCall was not registered");
  });

  it("should render single question display", () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}]`,
      bold: (text: string) => `**${text}**`,
    };

    const result = renderCall(
      {
        questions: [{ id: "q1", prompt: "What?", options: [{ value: "a", label: "A" }] }],
      },
      mockTheme
    );

    // Result should be a TUI Text element
    expect(result).toBeDefined();
    expect(result).toHaveProperty("text");
  });

  it("should render multi-question display with count", () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}]`,
      bold: (text: string) => `**${text}**`,
    };

    const result = renderCall(
      {
        questions: [
          { id: "q1", prompt: "First?", options: [{ value: "a", label: "A" }] },
          { id: "q2", prompt: "Second?", options: [{ value: "b", label: "B" }] },
        ],
      },
      mockTheme
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("text");
  });
});

describe("Questionnaire Integration — renderResult", () => {
  let renderResult: (result: unknown, options: unknown, theme: unknown) => unknown;

  beforeAll(async () => {
    const tool = (await registerQuestionnaire()).tool;
    renderResult = requireDefined(
      tool.renderResult,
      "questionnaire renderResult was not registered"
    );
  });

  it("should render cancelled result", () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}]`,
      bold: (text: string) => `**${text}**`,
    };

    const result = renderResult(
      {
        content: [{ type: "text", text: "User cancelled" }],
        details: {
          questions: [],
          answers: [],
          cancelled: true,
        },
      },
      {},
      mockTheme
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("text");
  });

  it("should render non-interactive (needsUserInput) result", () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}]`,
      bold: (text: string) => `**${text}**`,
    };

    const result = renderResult(
      {
        content: [{ type: "text", text: "Questions relayed" }],
        details: {
          questions: [{ id: "q1" }],
          answers: [{ id: "q1", value: "__needs_user_input__" }],
          cancelled: false,
          needsUserInput: true,
        },
      },
      {},
      mockTheme
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("text");
  });

  it("should render answered result with custom answer", () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}]`,
      bold: (text: string) => `**${text}**`,
    };

    const result = renderResult(
      {
        content: [{ type: "text", text: "Done" }],
        details: {
          questions: [{ id: "q1", label: "Q1" }],
          answers: [{ id: "q1", value: "custom", label: "custom", wasCustom: true }],
          cancelled: false,
        },
      },
      {},
      mockTheme
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("text");
  });

  it("should render answered result with selected answer", () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}]`,
      bold: (text: string) => `**${text}**`,
    };

    const result = renderResult(
      {
        content: [{ type: "text", text: "Done" }],
        details: {
          questions: [{ id: "q1", label: "Q1" }],
          answers: [{ id: "q1", value: "a", label: "Option A", wasCustom: false, index: 1 }],
          cancelled: false,
        },
      },
      {},
      mockTheme
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("text");
  });

  it("should render result without details (fallback)", () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}]`,
      bold: (text: string) => `**${text}**`,
    };

    const result = renderResult(
      {
        content: [{ type: "text", text: "Simple result" }],
      },
      {},
      mockTheme
    );

    expect(requireTextComponent(result, "fallback result component is missing").text).toBe(
      "Simple result"
    );
  });
});

describe("Questionnaire Integration — 'ask' Command", () => {
  let askCommand: RegisteredQuestionnaireCommand;

  beforeAll(async () => {
    askCommand = requireDefined(
      (await registerQuestionnaire()).commands[0],
      "ask command was not registered"
    );
  });

  it("should have the 'ask' command registered", () => {
    expect(askCommand).toBeDefined();
    expect(askCommand.name).toBe("ask");
    expect(requireDefined(askCommand.description, "ask command description is missing")).toContain(
      "interactive"
    );
  });

  it("should notify user when no UI available", async () => {
    const notifyMock = vi.fn();
    const ctx = { hasUI: false, ui: { notify: notifyMock } };

    await askCommand.handler({}, ctx);

    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("interactive mode"), "error");
  });

  it("should redirect to questionnaire tool when UI available", async () => {
    const notifyMock = vi.fn();
    const ctx = { hasUI: true, ui: { notify: notifyMock } };

    await askCommand.handler({}, ctx);

    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("questionnaire tool"), "info");
  });
});
