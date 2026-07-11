/**
 * Unit tests for the enhance extension.
 *
 * Style: mock the pi API object, capture the registered `input` handler, and
 * invoke it directly. The LLM call is injected through the deps parameter —
 * no network, no pi subprocess.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import enhance, {
  FLAG_RE,
  MAX_ENHANCED_CHARS,
  acceptableRewrite,
  buildEnhancerInput,
  stripFlag,
} from "../../index.js";

// A plain request WITH the trailing enhancement flag.
const FLAGGED = "refactor the auth module so sessions expire after inactivity -i";
const RAW = "refactor the auth module so sessions expire after inactivity";

type Handler = (event: any, ctx: any) => Promise<any>;

interface CapturedPi {
  pi: any;
  inputHandler: () => Handler;
  entries: Array<{ customType: string; data: any }>;
}

function capturePi(): CapturedPi {
  const handlers = new Map<string, any>();
  const entries: Array<{ customType: string; data: any }> = [];
  const pi = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (name: string, def: any) => void [name, def],
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
  };
  return {
    pi,
    inputHandler: () => {
      const handler = handlers.get("input");
      if (!handler) throw new Error("input handler not registered");
      return handler;
    },
    entries,
  };
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    ui: { notify: vi.fn() },
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
  delete process.env.PENNY_ENHANCE_MODEL;
  delete process.env.PENNY_ENHANCE_TIMEOUT_MS;
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("stripFlag", () => {
  it("detects and strips a trailing ` -i`", () => {
    expect(stripFlag(FLAGGED)).toEqual({ flagged: true, prompt: RAW });
  });

  it("tolerates trailing whitespace after the flag", () => {
    expect(stripFlag("do the thing -i   ")).toEqual({ flagged: true, prompt: "do the thing" });
  });

  it("requires a whitespace boundary — `-i` glued to a word is not the flag", () => {
    expect(stripFlag("run the cli-i")).toEqual({ flagged: false, prompt: "run the cli-i" });
  });

  it("passes plain prompts through unflagged", () => {
    expect(stripFlag(RAW)).toEqual({ flagged: false, prompt: RAW });
  });

  it("treats a bare `-i` as unflagged (no preceding token)", () => {
    expect(stripFlag("-i")).toEqual({ flagged: false, prompt: "-i" });
  });

  it("yields an empty prompt when only whitespace precedes the flag", () => {
    expect(stripFlag("   -i")).toEqual({ flagged: true, prompt: "" });
    expect(FLAG_RE.test("   -i")).toBe(true);
  });
});

describe("acceptableRewrite / buildEnhancerInput", () => {
  it("rejects empty and runaway rewrites, accepts a normal one", () => {
    expect(acceptableRewrite("")).toBe(false);
    expect(acceptableRewrite("   ")).toBe(false);
    expect(acceptableRewrite("x".repeat(MAX_ENHANCED_CHARS + 1))).toBe(false);
    expect(acceptableRewrite("Goal: refactor the auth module …")).toBe(true);
  });

  it("wraps the raw prompt in a tagged block after the methodology", () => {
    const input = buildEnhancerInput("do the thing");
    expect(input).toContain("<raw_prompt>\ndo the thing\n</raw_prompt>");
    expect(input).toContain("world-class"); // methodology.md marker
  });
});

// ── Input handler ───────────────────────────────────────────────────────────

describe("input handler", () => {
  it("enhances a flagged prompt and persists the original (with flag)", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("Goal: refactor the auth module.\nContext: sessions…");
    enhance(cap.pi, { completeFn });
    const ctx = fakeCtx();
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      ctx,
    );
    expect(result).toEqual({
      action: "transform",
      text: "Goal: refactor the auth module.\nContext: sessions…",
    });
    expect(completeFn).toHaveBeenCalledOnce();
    expect(cap.entries).toHaveLength(1);
    expect(cap.entries[0].customType).toBe("enhance");
    expect(cap.entries[0].data.original).toBe(FLAGGED);
    expect(cap.entries[0].data.enhanced).toContain("Goal: refactor");
    // The raw prompt the model saw must NOT contain the flag.
    expect((completeFn.mock.calls[0][1] as any).messages[0].content[0].text).toContain(RAW);
    expect((completeFn.mock.calls[0][1] as any).messages[0].content[0].text).not.toMatch(/-i\s*<\/raw_prompt>/);
  });

  it("passes an unflagged prompt through untouched", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("should never be called");
    enhance(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: RAW, source: "interactive" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("only acts on interactive input — a flagged rpc message passes through", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("nope");
    enhance(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "rpc" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("skips mid-stream steering interrupts", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("nope");
    enhance(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive", streamingBehavior: "steer" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("consumes the flag but skips enhancement in headless contexts", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("nope");
    enhance(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx({ hasUI: false }),
    );
    // Flag stripped, raw prompt runs un-enhanced.
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("runs the flag-stripped prompt when the LLM call fails", async () => {
    const cap = capturePi();
    const completeFn = vi.fn(async () => {
      throw new Error("provider down");
    });
    enhance(cap.pi, { completeFn: completeFn as any });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(cap.entries).toHaveLength(0);
  });

  it("rejects a truncated rewrite (abort/error stopReason) and runs the raw prompt", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("Goal: refactor the auth mod", "aborted");
    enhance(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(cap.entries).toHaveLength(0);
  });

  it("rejects a runaway rewrite and runs the raw prompt", async () => {
    const cap = capturePi();
    enhance(cap.pi, { completeFn: fakeComplete("x".repeat(MAX_ENHANCED_CHARS + 1)) });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx(),
    );
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(cap.entries).toHaveLength(0);
  });

  it("proceeds with keyless auth (ok=true, no apiKey)", async () => {
    const cap = capturePi();
    enhance(cap.pi, { completeFn: fakeComplete("Goal: enhanced") });
    const ctx = fakeCtx();
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, headers: {}, env: {} }));
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      ctx,
    );
    expect(result).toEqual({ action: "transform", text: "Goal: enhanced" });
  });

  it("runs the raw prompt when auth resolution fails (ok=false)", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("never");
    enhance(cap.pi, { completeFn });
    const ctx = fakeCtx();
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: false, error: "nope" }));
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      ctx,
    );
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("honors PENNY_ENHANCE_MODEL when the registry resolves it", async () => {
    process.env.PENNY_ENHANCE_MODEL = "ollama/deepseek-v4-flash:cloud";
    const cap = capturePi();
    enhance(cap.pi, { completeFn: fakeComplete("Goal: enhanced") });
    const ctx = fakeCtx();
    const flash = { provider: "ollama", id: "deepseek-v4-flash:cloud" };
    ctx.modelRegistry.find = vi.fn(() => flash);
    await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      ctx,
    );
    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("ollama", "deepseek-v4-flash:cloud");
    expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(flash);
  });
});
