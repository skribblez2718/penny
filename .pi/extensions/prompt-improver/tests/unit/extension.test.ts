/**
 * Unit tests for the prompt-improver extension.
 *
 * Style follows semgrep's tests: mock the pi API object, capture the
 * registered input handler and commands, and invoke them directly. The LLM
 * call is injected through the deps parameter — no network, no pi subprocess.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import promptImprover, {
  AUTO_MAX_LENGTH,
  MIN_LENGTH,
  acceptableRewrite,
  buildImproverInput,
  looksStructured,
  resolveMode,
  setSessionMode,
  shouldImprove,
} from "../../index.js";

const PLAIN_PROMPT =
  "refactor the auth module so sessions expire after thirty minutes of inactivity";

type Handler = (event: any, ctx: any) => Promise<any>;

interface CapturedPi {
  pi: any;
  inputHandler: () => Handler;
  sessionStart: () => () => void;
  commands: Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>;
  entries: Array<{ customType: string; data: any }>;
  sentUserMessages: Array<{ content: string; options?: any }>;
}

function capturePi(): CapturedPi {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: Array<{ customType: string; data: any }> = [];
  const sentUserMessages: Array<{ content: string; options?: any }> = [];
  const pi = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    sendUserMessage: (content: string, options?: any) =>
      sentUserMessages.push({ content, options }),
  };
  return {
    pi,
    inputHandler: () => {
      const handler = handlers.get("input");
      if (!handler) throw new Error("input handler not registered");
      return handler;
    },
    sessionStart: () => {
      const handler = handlers.get("session_start");
      if (!handler) throw new Error("session_start handler not registered");
      return handler;
    },
    commands,
    entries,
    sentUserMessages,
  };
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn(),
      editor: vi.fn(async (_title: string, prefill: string) => prefill),
    },
    model: { provider: "ollama", id: "glm-5.2:cloud" },
    modelRegistry: {
      find: vi.fn(() => undefined),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "ollama",
        headers: {},
        env: {},
      })),
    },
    ...overrides,
  };
}

function fakeComplete(text: string, stopReason = "stop") {
  return vi.fn(async () => ({ content: [{ type: "text", text }], stopReason }));
}

beforeEach(() => {
  setSessionMode(null);
  delete process.env.PENNY_PROMPT_IMPROVER;
  delete process.env.PENNY_IMPROVER_MODEL;
  delete process.env.PENNY_IMPROVER_CONFIRM;
  delete process.env.PENNY_IMPROVER_TIMEOUT_MS;
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("resolveMode", () => {
  it("defaults to off and maps legacy truthy values to auto", () => {
    expect(resolveMode()).toBe("off");
    process.env.PENNY_PROMPT_IMPROVER = "1";
    expect(resolveMode()).toBe("auto");
    process.env.PENNY_PROMPT_IMPROVER = "always";
    expect(resolveMode()).toBe("always");
    process.env.PENNY_PROMPT_IMPROVER = "garbage";
    expect(resolveMode()).toBe("off");
  });

  it("session override beats the environment", () => {
    process.env.PENNY_PROMPT_IMPROVER = "always";
    setSessionMode("off");
    expect(resolveMode()).toBe("off");
  });
});

describe("shouldImprove", () => {
  it("never improves when mode is off", () => {
    expect(shouldImprove(PLAIN_PROMPT, "interactive", undefined, "off").improve).toBe(false);
  });

  it("skips extension-injected, mid-stream, empty, and prefixed input", () => {
    expect(shouldImprove(PLAIN_PROMPT, "extension", undefined, "always").improve).toBe(false);
    expect(shouldImprove(PLAIN_PROMPT, "interactive", "steer", "always").improve).toBe(false);
    expect(shouldImprove("   ", "interactive", undefined, "always").improve).toBe(false);
    expect(shouldImprove("/skill:plan do it", "interactive", undefined, "always").improve).toBe(false);
    expect(shouldImprove("!ls -la", "interactive", undefined, "always").improve).toBe(false);
  });

  it("skips short conversational replies in every mode", () => {
    expect("yes please".length).toBeLessThan(MIN_LENGTH);
    expect(shouldImprove("yes please", "interactive", undefined, "always").improve).toBe(false);
  });

  it("auto mode skips long or already-structured prompts; always does not", () => {
    const long = "x".repeat(AUTO_MAX_LENGTH + 1);
    expect(shouldImprove(long, "interactive", undefined, "auto").improve).toBe(false);
    expect(shouldImprove(long, "interactive", undefined, "always").improve).toBe(true);
    const structured = "Goal: ship it\n- a\n- b\n- c\nplus enough length here to pass";
    expect(shouldImprove(structured, "interactive", undefined, "auto").improve).toBe(false);
    expect(shouldImprove(structured, "interactive", undefined, "always").improve).toBe(true);
  });

  it("improves a plain eligible prompt in auto mode", () => {
    expect(shouldImprove(PLAIN_PROMPT, "interactive", undefined, "auto").improve).toBe(true);
  });
});

describe("looksStructured", () => {
  it("detects headings, fences, bullet lists, and labeled sections", () => {
    expect(looksStructured("# Title\nbody")).toBe(true);
    expect(looksStructured("```js\ncode\n```")).toBe(true);
    expect(looksStructured("- a\n- b\n- c")).toBe(true);
    expect(looksStructured("Constraints: none")).toBe(true);
    expect(looksStructured(PLAIN_PROMPT)).toBe(false);
  });
});

describe("acceptableRewrite / buildImproverInput", () => {
  it("rejects empty and disproportionate rewrites", () => {
    expect(acceptableRewrite("short", "")).toBe(false);
    expect(acceptableRewrite("ab", "x".repeat(3000))).toBe(false);
    expect(acceptableRewrite(PLAIN_PROMPT, "Goal: refactor auth module …")).toBe(true);
  });

  it("wraps the raw prompt in a tagged block after the methodology", () => {
    const input = buildImproverInput("do the thing");
    expect(input).toContain("<raw_prompt>\ndo the thing\n</raw_prompt>");
    expect(input).toContain("NEVER answer the request");
  });
});

// ── Input handler ───────────────────────────────────────────────────────────

describe("input handler", () => {
  it("transforms an eligible prompt and persists the original", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    const cap = capturePi();
    const completeFn = fakeComplete("Goal: refactor the auth module.\nContext: sessions…");
    promptImprover(cap.pi, { completeFn });
    const ctx = fakeCtx();
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      ctx,
    );
    expect(result).toEqual({
      action: "transform",
      text: "Goal: refactor the auth module.\nContext: sessions…",
    });
    expect(completeFn).toHaveBeenCalledOnce();
    expect(cap.entries).toHaveLength(1);
    expect(cap.entries[0].customType).toBe("prompt-improver");
    expect(cap.entries[0].data.original).toBe(PLAIN_PROMPT);
  });

  it("continues untouched when mode is off (default)", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("should never be called");
    promptImprover(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("stays out of headless contexts even in always mode", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "always";
    const cap = capturePi();
    const completeFn = fakeComplete("improved");
    promptImprover(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "rpc" },
      fakeCtx({ hasUI: false }),
    );
    expect(result).toEqual({ action: "continue" });
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("falls back to the raw prompt when the LLM call fails", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    const cap = capturePi();
    const completeFn = vi.fn(async () => {
      throw new Error("provider down");
    });
    promptImprover(cap.pi, { completeFn: completeFn as any });
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
    expect(cap.entries).toHaveLength(0);
  });

  it("rejects a truncated rewrite when complete() resolves with an abort/error stopReason", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    process.env.PENNY_IMPROVER_CONFIRM = "0";
    const cap = capturePi();
    // complete() RESOLVES (does not throw) on timeout — returns partial text.
    const completeFn = fakeComplete("Goal: refactor the auth mod", "aborted");
    promptImprover(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
    expect(cap.entries).toHaveLength(0);
  });

  it("proceeds with keyless auth (ok=true, no apiKey)", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    process.env.PENNY_IMPROVER_CONFIRM = "0";
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("Goal: improved") });
    const ctx = fakeCtx();
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true,
      headers: {},
      env: {},
    }));
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      ctx,
    );
    expect(result).toEqual({ action: "transform", text: "Goal: improved" });
  });

  it("bails when auth resolution fails (ok=false)", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    const cap = capturePi();
    const completeFn = fakeComplete("never");
    promptImprover(cap.pi, { completeFn });
    const ctx = fakeCtx();
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: false, error: "nope" }));
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      ctx,
    );
    expect(result).toEqual({ action: "continue" });
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("resets the session mode override on session_start", async () => {
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("unused") });
    setSessionMode("always");
    expect(resolveMode()).toBe("always");
    cap.sessionStart()();
    expect(resolveMode()).toBe("off");
  });

  it("respects the confirm editor: cancel sends the original", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("improved text") });
    const ctx = fakeCtx();
    ctx.ui.editor = vi.fn(async () => undefined); // user cancels
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      ctx,
    );
    expect(result).toEqual({ action: "continue" });
  });

  it("uses the user's edit from the confirm editor", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("improved text") });
    const ctx = fakeCtx();
    ctx.ui.editor = vi.fn(async () => "user-edited version of the prompt");
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      ctx,
    );
    expect(result).toEqual({ action: "transform", text: "user-edited version of the prompt" });
  });

  it("transforms without confirmation when PENNY_IMPROVER_CONFIRM=0", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    process.env.PENNY_IMPROVER_CONFIRM = "0";
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("improved text") });
    const ctx = fakeCtx();
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      ctx,
    );
    expect(result).toEqual({ action: "transform", text: "improved text" });
    expect(ctx.ui.editor).not.toHaveBeenCalled();
  });

  it("rejects disproportionate rewrites and keeps the raw prompt", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("x".repeat(20_000)) });
    const result = await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
  });

  it("honors PENNY_IMPROVER_MODEL when the registry resolves it", async () => {
    process.env.PENNY_PROMPT_IMPROVER = "auto";
    process.env.PENNY_IMPROVER_MODEL = "ollama/deepseek-v4-flash:cloud";
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("improved text") });
    const ctx = fakeCtx();
    const flash = { provider: "ollama", id: "deepseek-v4-flash:cloud" };
    ctx.modelRegistry.find = vi.fn(() => flash);
    await cap.inputHandler()(
      { type: "input", text: PLAIN_PROMPT, source: "interactive" },
      ctx,
    );
    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("ollama", "deepseek-v4-flash:cloud");
    expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(flash);
  });
});

// ── Commands ────────────────────────────────────────────────────────────────

describe("/improve command", () => {
  it("improves the given text and submits it as a queued user message", async () => {
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("Goal: do X properly") });
    await cap.commands.get("improve")!.handler("do X", fakeCtx());
    expect(cap.sentUserMessages).toEqual([
      { content: "Goal: do X properly", options: { deliverAs: "followUp" } },
    ]);
    expect(cap.entries[0].data.command).toBe(true);
  });

  it("submits the original text when improvement fails", async () => {
    const cap = capturePi();
    const completeFn = vi.fn(async () => {
      throw new Error("down");
    });
    promptImprover(cap.pi, { completeFn: completeFn as any });
    await cap.commands.get("improve")!.handler("do X", fakeCtx());
    expect(cap.sentUserMessages[0].content).toBe("do X");
  });

  it("shows usage for empty args", async () => {
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("unused") });
    const ctx = fakeCtx();
    await cap.commands.get("improve")!.handler("  ", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /improve <prompt text>", "warning");
    expect(cap.sentUserMessages).toHaveLength(0);
  });
});

describe("/improver command", () => {
  it("sets and reports the session mode", async () => {
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("unused") });
    const ctx = fakeCtx();
    await cap.commands.get("improver")!.handler("always", ctx);
    expect(resolveMode()).toBe("always");
    await cap.commands.get("improver")!.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      "prompt-improver mode: always",
      "info",
    );
  });

  it("rejects unknown modes", async () => {
    const cap = capturePi();
    promptImprover(cap.pi, { completeFn: fakeComplete("unused") });
    const ctx = fakeCtx();
    await cap.commands.get("improver")!.handler("sometimes", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /improver [off|auto|always]", "warning");
    expect(resolveMode()).toBe("off");
  });
});
