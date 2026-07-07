/**
 * Questionnaire Extension - Ask users questions with options + custom input
 *
 * Provides the `questionnaire` tool that agents can use to ask questions.
 * In interactive mode (hasUI): presents a full TUI with selectable options
 *   and an inline editor for custom responses.
 * In non-interactive mode (print/json): returns questions as structured text
 *   so the agent can relay them and receive answers in subsequent turns.
 *
 * Architecture:
 *   - Agent calls questionnaire tool with questions + options
 *   - Interactive: ctx.ui.custom() shows a TUI, user picks/types, returns answer
 *   - Non-interactive: tool returns structured text describing the questions,
 *     which the agent includes in its response for the caller to handle
 */

import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ============================================================
// Types
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

type DisplayOption = QuestionOption & { isOther?: boolean; isSelected?: boolean };

export interface QuestionnaireUIHandlers {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  invalidate: () => void;
}

/** Minimal TUI handle passed to the questionnaire UI (requests a re-render). */
interface TuiHandle {
  requestRender: () => void;
}

/**
 * Theme accessor used by the TUI: `fg`/`bg` colorize text with a named color,
 * `bold` emboldens. Superset of the Pi SDK `Theme` type (which only declares `fg`).
 */
interface TuiTheme {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

/** Theme callable used by `renderCall`/`renderResult`: `theme(color, text)`. */
type ThemeFn = (color: string, text: string) => string;

/** UI notification severity accepted by `ctx.ui.notify`. */
type NotifyLevel = "error" | "info" | "warning";

/** Subset of the tool `execute` context this extension relies on. */
interface QuestionnaireExecuteContext {
  hasUI: boolean;
  ui: {
    custom: <T>(
      factory: (
        tui: TuiHandle,
        theme: TuiTheme,
        kb: unknown,
        done: (result: T) => void
      ) => QuestionnaireUIHandlers
    ) => Promise<T>;
    notify: (message: string, level: NotifyLevel) => void;
  };
}

/** Subset of the command context used by the `ask` command. */
interface QuestionnaireCommandContext {
  hasUI: boolean;
  ui: {
    notify: (message: string, level: NotifyLevel) => void;
  };
}

/** Details payload attached to the tool result. */
type QuestionnaireDetails = QuestionnaireResult & { needsUserInput?: boolean };

// ============================================================
// Local text wrapping (ANSI-aware word-wrap for TUI content)
// ============================================================

// ANSI escape sequence regex for stripping visible-length calculations
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Calculate visible width of a string (excluding ANSI escape codes).
 */
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * Word-wrap a string that may contain ANSI escape codes into multiple lines.
 * Preserves ANSI codes so styling carries over. Each returned line has
 * visible width ≤ maxWidth.
 *
 * @param text - Styled text (may contain ANSI codes)
 * @param maxWidth - Maximum visible width per line
 * @param indent - Leading spaces for continuation lines
 * @returns Array of wrapped lines
 */
function wrapStyledText(text: string, maxWidth: number, indent = 0): string[] {
  if (maxWidth <= 0) return [text];
  if (visibleLen(text) <= maxWidth) return [text];

  // Split into words (preserving ANSI codes within each word)
  const words: string[] = [];
  let current = "";
  let inAnsi = false;
  for (const ch of text) {
    if (ch === "\x1b") inAnsi = true;
    if (inAnsi) {
      current += ch;
      if (/[a-zA-Z]/.test(ch)) inAnsi = false;
      continue;
    }
    if (ch === " " || ch === "\n") {
      if (current) words.push(current);
      current = ch === "\n" ? "" : "";
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);

  const lines: string[] = [];
  let line = "";
  let lineLen = 0;

  for (const word of words) {
    const wordLen = visibleLen(word);
    const spaceLen = lineLen > 0 ? 1 : 0;
    const totalLen = lineLen + spaceLen + wordLen;

    if (totalLen <= maxWidth) {
      line += (lineLen > 0 ? " " : "") + word;
      lineLen += spaceLen + wordLen;
    } else {
      if (line) lines.push(line);
      line = " ".repeat(indent) + word;
      lineLen = indent + wordLen;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [text];
}

// ============================================================
// Schema
// ============================================================

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
// Interactive mode rendering
// ============================================================

function _renderInteractive(
  params: { questions: Question[] },
  ctx: { hasUI: boolean }
): Promise<QuestionnaireResult> | QuestionnaireResult {
  // Non-interactive: return questions as structured text
  if (!ctx.hasUI) {
    // This shouldn't be reached (handled in execute), but as safety:
    const result: QuestionnaireResult = {
      questions: params.questions,
      answers: params.questions.map((q) => ({
        id: q.id,
        value: "__no_ui__",
        label: q.type === "multi" ? "(multi-select)" : "No UI available — non-interactive mode",
        wasCustom: false,
      })),
      cancelled: true,
    };
    return result;
  }

  // This branch is unreachable from execute() but satisfies type checker
  const result: QuestionnaireResult = {
    questions: params.questions,
    answers: [],
    cancelled: true,
  };
  return result;
}

// ============================================================
// TUI State Machine (extracted for testability)
// ============================================================

export function createQuestionnaireUI(
  questions: Question[],
  tui: TuiHandle,
  theme: TuiTheme,
  done: (result: QuestionnaireResult) => void
): QuestionnaireUIHandlers {
  const isMulti = questions.length > 1;
  const totalTabs = questions.length + 1; // questions + Submit

  let currentTab = 0;
  let optionIndex = 0;
  let inputMode = false;
  let inputQuestionId: string | null = null;
  let cachedLines: string[] | undefined;
  const answers = new Map<string, Answer>();
  const multiSelections = new Map<string, Set<number>>();

  // Editor for "Type something" option
  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
  const editor = new Editor(tui, editorTheme);

  // Helpers
  function refresh() {
    cachedLines = undefined;
    tui.requestRender();
  }

  function submit(cancelled: boolean) {
    done({ questions, answers: Array.from(answers.values()), cancelled });
  }

  function currentQuestion(): Question | undefined {
    return questions[currentTab];
  }

  function currentOptions(): DisplayOption[] {
    const q = currentQuestion();
    if (!q) return [];
    const selection = multiSelections.get(q.id);
    const opts: DisplayOption[] = [
      ...q.options.map((opt, i) => ({
        ...opt,
        isSelected: selection?.has(i) ?? false,
      })),
    ];
    if (q.allowOther) {
      opts.push({ value: "__other__", label: "Type something.", isOther: true });
    }
    return opts;
  }

  function allAnswered(): boolean {
    return questions.every((q) => answers.has(q.id));
  }

  function advanceAfterAnswer() {
    if (!isMulti) {
      submit(false);
      return;
    }
    if (currentTab < questions.length - 1) {
      currentTab++;
    } else {
      currentTab = questions.length; // Submit tab
    }
    optionIndex = 0;
    refresh();
  }

  function saveAnswer(
    questionId: string,
    value: string,
    label: string,
    wasCustom: boolean,
    index?: number
  ) {
    answers.set(questionId, { id: questionId, value, label, wasCustom, index });
  }

  function confirmMultiSelect(q: Question, opts: DisplayOption[]) {
    const selection = multiSelections.get(q.id) || new Set<number>();
    const selectedOpts = Array.from(selection)
      .sort((a, b) => a - b)
      .map((idx) => opts[idx]);
    const selectedValues = selectedOpts.map((o) => o.value);
    const selectedLabels = selectedOpts.map((o) => o.label);
    saveAnswer(q.id, selectedValues.join(","), selectedLabels.join("; "), false);
    advanceAfterAnswer();
  }

  // Editor submit callback
  editor.onSubmit = (value: string) => {
    if (!inputQuestionId) return;
    const trimmed = value.trim() || "(no response)";
    const q = questions.find((q) => q.id === inputQuestionId);
    const selection = multiSelections.get(inputQuestionId);
    if (q && q.type === "multi" && selection) {
      const selectedOpts = Array.from(selection)
        .sort((a, b) => a - b)
        .map((idx) => q.options[idx]);
      const values = [...selectedOpts.map((o) => o.value), trimmed];
      const labels = [...selectedOpts.map((o) => o.label), trimmed];
      saveAnswer(inputQuestionId, values.join(","), labels.join("; "), false);
      multiSelections.delete(inputQuestionId);
    } else {
      saveAnswer(inputQuestionId, trimmed, trimmed, true);
    }
    inputMode = false;
    inputQuestionId = null;
    editor.setText("");
    advanceAfterAnswer();
  };

  function handleInput(data: string) {
    // Input mode: route to editor
    if (inputMode) {
      if (matchesKey(data, Key.escape)) {
        inputMode = false;
        inputQuestionId = null;
        editor.setText("");
        refresh();
        return;
      }
      editor.handleInput(data);
      refresh();
      return;
    }

    const q = currentQuestion();
    const opts = currentOptions();

    // Tab navigation (multi-question only)
    if (isMulti) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
        currentTab = (currentTab + 1) % totalTabs;
        optionIndex = 0;
        refresh();
        return;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
        currentTab = (currentTab - 1 + totalTabs) % totalTabs;
        optionIndex = 0;
        refresh();
        return;
      }
    }

    // Submit tab
    if (currentTab === questions.length) {
      if (matchesKey(data, Key.enter) && allAnswered()) {
        submit(false);
      } else if (matchesKey(data, Key.escape)) {
        submit(true);
      }
      return;
    }

    // Option navigation
    if (matchesKey(data, Key.up)) {
      optionIndex = Math.max(0, optionIndex - 1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      optionIndex = Math.min(opts.length - 1, optionIndex + 1);
      refresh();
      return;
    }

    // Select / toggle option
    // Multi-select toggle (Space to check/uncheck)
    if (q && q.type === "multi" && matchesKey(data, Key.space)) {
      const selection = multiSelections.get(q.id) || new Set<number>();
      if (selection.has(optionIndex)) {
        selection.delete(optionIndex);
      } else {
        selection.add(optionIndex);
      }
      multiSelections.set(q.id, selection);
      refresh();
      return;
    }

    // Select / confirm option
    if (matchesKey(data, Key.enter) && q) {
      if (q.type === "multi") {
        confirmMultiSelect(q, opts);
        return;
      }
      const opt = opts[optionIndex];
      if (opt.isOther) {
        inputMode = true;
        inputQuestionId = q.id;
        editor.setText("");
        refresh();
        return;
      }
      saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
      advanceAfterAnswer();
      return;
    }

    // Cancel
    if (matchesKey(data, Key.escape)) {
      submit(true);
    }
  }

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;

    const lines: string[] = [];
    const q = currentQuestion();
    const opts = currentOptions();

    // Helper to add truncated line (for UI chrome that should not wrap)
    const add = (s: string) => lines.push(truncateToWidth(s, width));

    // Helper to wrap styled text across multiple lines (for content that must not be cut off)
    const wrap = (s: string, indent = 2) => {
      const wrapped = wrapStyledText(s, width - indent, indent);
      for (const line of wrapped) {
        lines.push(line);
      }
    };

    add(theme.fg("accent", "─".repeat(width)));

    // Tab bar (multi-question only)
    if (isMulti) {
      const tabs: string[] = ["← "];
      for (let i = 0; i < questions.length; i++) {
        const isActive = i === currentTab;
        const isAnswered = answers.has(questions[i].id);
        const lbl = questions[i].label ?? questions[i].id;
        const box = isAnswered ? "■" : "□";
        const color = isAnswered ? "success" : "muted";
        const text = ` ${box} ${lbl} `;
        const styled = isActive
          ? theme.bg("selectedBg", theme.fg("text", text))
          : theme.fg(color, text);
        tabs.push(`${styled} `);
      }
      const canSubmit = allAnswered();
      const isSubmitTab = currentTab === questions.length;
      const submitText = " ✓ Submit ";
      const submitStyled = isSubmitTab
        ? theme.bg("selectedBg", theme.fg("text", submitText))
        : theme.fg(canSubmit ? "success" : "dim", submitText);
      tabs.push(`${submitStyled} →`);
      add(` ${tabs.join("")}`);
      lines.push("");
    }

    // Helper to render options list
    function renderOptions() {
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        const isFocused = i === optionIndex;
        const isOther = opt.isOther === true;
        const isMultiQ = q?.type === "multi";
        let prefix: string;
        if (isMultiQ && !isOther) {
          const isSelected = opt.isSelected ?? false;
          prefix = isSelected ? "[x] " : "[ ] ";
        } else {
          prefix = isFocused ? theme.fg("accent", "> ") : "  ";
        }
        const color = isFocused ? "accent" : "text";
        if (isOther && inputMode) {
          add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
        } else {
          add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
        }
        if (opt.description) {
          wrap(theme.fg("muted", opt.description), 5);
        }
      }
    }

    // Content
    if (inputMode && q) {
      wrap(theme.fg("text", q.prompt));
      lines.push("");
      renderOptions();
      lines.push("");
      add(theme.fg("muted", " Your answer:"));
      for (const line of editor.render(width - 2)) {
        add(` ${line}`);
      }
      lines.push("");
      add(theme.fg("dim", " Enter to submit • Esc to cancel"));
    } else if (currentTab === questions.length) {
      // Submit tab
      add(theme.fg("accent", theme.bold(" Ready to submit")));
      lines.push("");
      for (const question of questions) {
        const answer = answers.get(question.id);
        if (answer) {
          const prefix = answer.wasCustom ? "(wrote) " : "";
          add(
            `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`
          );
        }
      }
      lines.push("");
      if (allAnswered()) {
        add(theme.fg("success", " Press Enter to submit"));
      } else {
        const missing = questions
          .filter((q) => !answers.has(q.id))
          .map((q) => q.label)
          .join(", ");
        add(theme.fg("warning", ` Unanswered: ${missing}`));
      }
    } else if (q) {
      wrap(theme.fg("text", q.prompt));
      lines.push("");
      renderOptions();
    }

    lines.push("");
    if (!inputMode) {
      let help: string;
      if (q?.type === "multi") {
        help = " Space toggle • Enter confirm • ↑↓ choose • Esc cancel";
      } else {
        help = isMulti
          ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
          : " ↑↓ navigate • Enter select • Esc cancel";
      }
      add(theme.fg("dim", help));
    }
    add(theme.fg("accent", "─".repeat(width)));

    cachedLines = lines;
    return lines;
  }

  return {
    render,
    invalidate: () => {
      cachedLines = undefined;
    },
    handleInput,
  };
}

// ============================================================
// Extension Registration
// ============================================================

export default function questionnaire(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description: [
      "Ask the user one or more questions with predefined options and optional custom input.",
      "Use for clarifying requirements, getting preferences, confirming decisions, or resolving ambiguity.",
      "When you lack critical information and asking the user would improve your output, USE THIS TOOL.",
      "Do NOT guess when you can ask. Do NOT assume when clarification is available.",
      "",
      "For single questions, provides a simple option list.",
      "For multiple questions, shows a tab-based interface.",
      "The 'Type something' option always appears, allowing custom answers.",
      "",
      "IMPORTANT: This tool REQUIRES interactive mode. If running in non-interactive mode (subagent/print mode),",
      "the tool returns the questions as structured text for the caller to relay to the user.",
    ].join("\n"),
    parameters: QuestionnaireParams,

    async execute(
      _toolCallId: string,
      params: { questions: Question[] },
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<QuestionnaireDetails>,
      ctx: QuestionnaireExecuteContext
    ) {
      const questions: Question[] = params.questions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
        allowOther: q.allowOther !== false,
      }));

      // ── Non-interactive mode (print/json/subagent) ──
      if (!ctx.hasUI) {
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
              q.type === "multi"
                ? "(multi-select)"
                : "Waiting for user input (non-interactive mode)",
            wasCustom: false,
          });
        }

        lines.push("---");
        lines.push("Please provide your answers to the above questions.");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            questions,
            answers,
            cancelled: false,
            needsUserInput: true,
          } as QuestionnaireResult & { needsUserInput: boolean },
        };
      }

      // ── Interactive mode (TUI) ──
      const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
        return createQuestionnaireUI(questions, tui, theme, done);
      });

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a: Answer) => {
        const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
        if (a.wasCustom) {
          return `${qLabel}: user wrote: ${a.label}`;
        }
        // Multi-select: show comma-separated values (no single index)
        if (a.value && a.value.includes(",")) {
          return `${qLabel}: user selected: ${a.value}`;
        }
        if (a.index !== undefined) {
          return `${qLabel}: user selected: ${a.index}. ${a.label}`;
        }
        return `${qLabel}: user selected: ${a.label}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args: { questions?: Question[] }, theme: ThemeFn) {
      const qs = args.questions ?? [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme("toolTitle", theme("bold", "questionnaire "));
      text += theme("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(
      result: {
        content: Array<{ type: string; text: string }>;
        details?: QuestionnaireDetails;
      },
      _options: ToolRenderResultOptions,
      theme: ThemeFn
    ) {
      const details = result.details;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      // Non-interactive mode marker
      if (details.needsUserInput) {
        return new Text(
          theme("warning", "⚠ ") +
            theme("muted", "Questions relayed for user input (non-interactive mode)"),
          0,
          0
        );
      }

      if (details.cancelled) {
        return new Text(theme("warning", "Cancelled"), 0, 0);
      }

      const lines = details.answers.map((a) => {
        if (a.wasCustom) {
          return `${theme("success", "✓ ")}${theme("accent", a.id)}: ${theme("muted", "(wrote) ")}${a.label}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${theme("success", "✓ ")}${theme("accent", a.id)}: ${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // Also register a convenience command for manual questionnaire invocation
  pi.registerCommand("ask", {
    description: "Ask a question interactively (for testing questionnaire tool)",
    handler: async (_args: string, ctx: QuestionnaireCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("ask command requires interactive mode", "error");
        return;
      }
      ctx.ui.notify("Use the questionnaire tool from an agent instead", "info");
    },
  });
}
