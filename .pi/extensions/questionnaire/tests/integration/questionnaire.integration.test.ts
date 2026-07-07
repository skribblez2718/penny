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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
  renderCall?: (args: unknown, theme: unknown) => unknown;
  renderResult?: (result: unknown, options: unknown, theme: unknown) => unknown;
}

interface RegisteredCommand {
  name: string;
  config: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> };
}

describe("Questionnaire Integration — Tool Registration", () => {
  let registeredTool: RegisteredTool;
  let registeredCommands: RegisteredCommand[];

  beforeAll(async () => {
    const tools: RegisteredTool[] = [];
    registeredCommands = [];

    const mockPi = {
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.push(tool);
      }),
      registerCommand: vi.fn(
        (
          name: string,
          config: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }
        ) => {
          registeredCommands.push({ name, config });
        }
      ),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    const mod = await import("../../index.js");
    mod.default(mockPi);

    registeredTool = tools[0];
  });

  it("should register exactly one tool", () => {
    expect(registeredTool).toBeDefined();
    expect(registeredTool.name).toBe("questionnaire");
  });

  it("should have a TypeBox parameter schema", () => {
    expect(registeredTool.parameters).toBeDefined();
    expect(registeredTool.parameters).toHaveProperty("type", "object");
    expect(registeredTool.parameters).toHaveProperty("properties");
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
    expect(registeredCommands[0].name).toBe("ask");
  });
});

describe("Questionnaire Integration — Non-Interactive Execute", () => {
  let execute: (...args: unknown[]) => Promise<unknown>;

  beforeAll(async () => {
    const tools: RegisteredTool[] = [];

    const mockPi = {
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.push(tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    const mod = await import("../../index.js");
    mod.default(mockPi);

    execute = tools[0].execute;
  });

  it("should return structured text with proper Markdown headers", async () => {
    const result = (await execute(
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
    )) as {
      content: { type: string; text: string }[];
      details: Record<string, unknown>;
    };

    const text = result.content[0].text;
    expect(text).toContain("## Questionnaire");
    expect(text).toContain("### Q1: What is the scope?");
    expect(text).toContain("1. Local");
    expect(text).toContain("2. Global");
    expect(text).toContain("---");
  });

  it("should include needsUserInput marker in details", async () => {
    const result = (await execute(
      "call-int-2",
      {
        questions: [{ id: "q1", prompt: "Q?", options: [{ value: "a", label: "A" }] }],
      },
      undefined,
      undefined,
      { hasUI: false }
    )) as {
      details: Record<string, unknown>;
    };

    expect(result.details.needsUserInput).toBe(true);
    expect(result.details.cancelled).toBe(false);
  });

  it("should auto-number options correctly across multiple questions", async () => {
    const result = (await execute(
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
    )) as {
      content: { type: string; text: string }[];
      details: Record<string, unknown>;
    };

    const text = result.content[0].text;
    // Q1 options: 1-3, Type something=4
    expect(text).toContain("1. A1");
    expect(text).toContain("3. C1");
    expect(text).toContain("4. (Type something)");
    // Q2 options: 1-2, Type something=3
    expect(text).toContain("1. X2");
    expect(text).toContain("2. Y2");
    // Second "(Type something)" for Q2
    const typeSomethingCount = (text.match(/\(Type something\)/g) || []).length;
    expect(typeSomethingCount).toBe(2);
  });

  it("should include option descriptions when provided", async () => {
    const result = (await execute(
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
    )) as {
      content: { type: string; text: string }[];
    };

    const text = result.content[0].text;
    expect(text).toContain("1. Safe — Conservative approach");
    expect(text).toContain("2. Risky — High risk, high reward");
  });

  it("should handle multiple questions with different allowOther settings", async () => {
    const result = (await execute(
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
    )) as {
      content: { type: string; text: string }[];
      details: Record<string, unknown>;
    };

    const text = result.content[0].text;
    // Fixed question: only 1 option, no "Type something"
    // We need to verify the fixed question section doesn't have (Type something)
    // and the open question section does.
    // The text has both questions — we split on "###" to isolate
    const sections = text.split("### ");
    const fixedSection = sections.find((s) => s.startsWith("Q1"));
    const openSection = sections.find((s) => s.startsWith("Q2"));

    expect(fixedSection).toBeDefined();
    expect(openSection).toBeDefined();
    expect(fixedSection!).not.toContain("(Type something)");
    expect(openSection!).toContain("(Type something)");
  });
});

describe("Questionnaire Integration — renderCall", () => {
  let renderCall: (args: unknown, theme: unknown) => unknown;

  beforeAll(async () => {
    const tools: RegisteredTool[] = [];

    const mockPi = {
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.push(tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    const mod = await import("../../index.js");
    mod.default(mockPi);

    renderCall = tools[0].renderCall!;
  });

  it("should render single question display", () => {
    const mockTheme = (color: string, text: string) => `[${color}]${text}]`;

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
    const mockTheme = (color: string, text: string) => `[${color}]${text}]`;

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
    const tools: RegisteredTool[] = [];

    const mockPi = {
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.push(tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    const mod = await import("../../index.js");
    mod.default(mockPi);

    renderResult = tools[0].renderResult!;
  });

  it("should render cancelled result", () => {
    const mockTheme = (color: string, text: string) => `[${color}]${text}]`;

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
    const mockTheme = (color: string, text: string) => `[${color}]${text}]`;

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
    const mockTheme = (color: string, text: string) => `[${color}]${text}]`;

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
    const mockTheme = (color: string, text: string) => `[${color}]${text}]`;

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
    const mockTheme = (color: string, text: string) => `[${color}]${text}]`;

    const result = renderResult(
      {
        content: [{ type: "text", text: "Simple result" }],
      },
      {},
      mockTheme
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("text");
    expect((result as { text: string }).text).toBe("Simple result");
  });
});

describe("Questionnaire Integration — 'ask' Command", () => {
  let askCommand: RegisteredCommand;

  beforeAll(async () => {
    const commands: RegisteredCommand[] = [];

    const mockPi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(
        (
          name: string,
          config: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }
        ) => {
          commands.push({ name, config });
        }
      ),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    const mod = await import("../../index.js");
    mod.default(mockPi);

    askCommand = commands[0];
  });

  it("should have the 'ask' command registered", () => {
    expect(askCommand).toBeDefined();
    expect(askCommand.name).toBe("ask");
    expect(askCommand.config.description).toContain("interactive");
  });

  it("should notify user when no UI available", async () => {
    const notifyMock = vi.fn();
    const ctx = { hasUI: false, ui: { notify: notifyMock } };

    await askCommand.config.handler({}, ctx);

    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("interactive mode"), "error");
  });

  it("should redirect to questionnaire tool when UI available", async () => {
    const notifyMock = vi.fn();
    const ctx = { hasUI: true, ui: { notify: notifyMock } };

    await askCommand.config.handler({}, ctx);

    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("questionnaire tool"), "info");
  });
});
