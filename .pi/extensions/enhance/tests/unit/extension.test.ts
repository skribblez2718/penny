/**
 * Unit tests for the enhance extension.
 *
 * Style: mock the pi API object, capture the registered `input` handler, and
 * invoke it directly. The LLM call is injected through the deps parameter —
 * no network, no pi subprocess.
 */

import type { InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enhance, {
  FLAG_RE,
  MAX_ENHANCED_CHARS,
  acceptableRewrite,
  buildEnhancerInput,
  stripFlag,
  type CompleteFn,
} from "../../index.js";
import {
  createTestExtensionApi,
  isRecord,
  requireFunction,
} from "../../../../lib/tests/test-narrowers.js";

const compatBoundary = vi.hoisted(() => ({
  complete: vi.fn(),
  failImport: false,
  malformed: false,
}));

vi.mock("@earendil-works/pi-ai/compat", () => {
  if (compatBoundary.failImport) throw new Error("compat unavailable");
  return {
    get complete() {
      return compatBoundary.malformed ? null : compatBoundary.complete;
    },
  };
});

// A plain request WITH the trailing enhancement flag.
const FLAGGED = "refactor the auth module so sessions expire after inactivity -i";
const RAW = "refactor the auth module so sessions expire after inactivity";

type Handler = (event: InputEvent, ctx: FakeExtensionContext) => Promise<InputEventResult>;

interface EnhanceEntryData {
  original: string;
  enhanced: string;
  model: string;
  latencyMs: number;
  contextEntries: number;
  contextChars: number;
  contextTruncated: boolean;
}

interface CapturedPi {
  pi: ReturnType<typeof createTestExtensionApi>;
  inputHandler: () => Handler;
  entries: Array<{ customType: string; data: EnhanceEntryData }>;
}

function isEnhanceEntryData(value: unknown): value is EnhanceEntryData {
  return (
    isRecord(value) &&
    typeof value.original === "string" &&
    typeof value.enhanced === "string" &&
    typeof value.model === "string" &&
    typeof value.latencyMs === "number" &&
    typeof value.contextEntries === "number" &&
    typeof value.contextChars === "number" &&
    typeof value.contextTruncated === "boolean"
  );
}

function isInputEventResult(value: unknown): value is InputEventResult {
  if (!isRecord(value)) return false;
  if (value.action === "continue") return true;
  return value.action === "transform" && typeof value.text === "string";
}

function capturePi(): CapturedPi {
  const handlers = new Map<string, unknown>();
  const entries: Array<{ customType: string; data: EnhanceEntryData }> = [];
  const pi = createTestExtensionApi({
    onEvent: (event, handler) => handlers.set(event, handler),
    onAppendEntry: (customType, data) => {
      if (!isEnhanceEntryData(data)) throw new Error("enhance appended an invalid audit entry");
      entries.push({ customType, data });
    },
  });
  return {
    pi,
    inputHandler: () => {
      const handler = requireFunction(handlers.get("input"), "input handler not registered");
      return async (event, ctx) => {
        const result = await handler(event, ctx);
        if (!isInputEventResult(result))
          throw new Error("input handler returned an invalid result");
        return result;
      };
    },
    entries,
  };
}

/** A session manager exposing the compaction-aware active entry list. */
interface FakeSessionManager {
  buildContextEntries(): unknown[];
}

function fakeSession(texts: string[]): FakeSessionManager {
  return {
    buildContextEntries: () =>
      texts.map((text) => ({
        type: "message",
        message: { role: "user", content: [{ type: "text", text }] },
      })),
  };
}

/** Auth resolution result shape; fields are optional so keyless-provider and
 *  failure overrides stay assignable to the same mock type (Mock<T> is invariant). */
interface FakeAuth {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  error?: string;
}

interface FakeModel {
  provider: string;
  id: string;
}

interface FakeExtensionContext {
  hasUI: boolean;
  ui: { notify(message: string, level: string): void };
  sessionManager: FakeSessionManager;
  model: FakeModel;
  modelRegistry: {
    find(provider: string, modelId: string): FakeModel | undefined;
    getApiKeyAndHeaders(model: FakeModel): Promise<FakeAuth>;
  };
}

function fakeCtx(overrides: Partial<FakeExtensionContext> = {}): FakeExtensionContext {
  const base: FakeExtensionContext = {
    hasUI: true,
    ui: { notify: vi.fn() },
    sessionManager: fakeSession([]),
    model: { provider: "ollama", id: "glm-5.2:cloud" },
    modelRegistry: {
      find: vi.fn((_provider: string, _modelId: string): FakeModel | undefined => undefined),
      getApiKeyAndHeaders: vi.fn(
        async (_model: FakeModel): Promise<FakeAuth> => ({
          ok: true,
          apiKey: "ollama",
          headers: {},
          env: {},
        })
      ),
    },
  };
  return { ...base, ...overrides };
}

// Three declared params so `.mock.calls[n][1]` (the request) is typed.
function fakeComplete(text: string, stopReason = "stop") {
  const complete: CompleteFn = async (_model, _request, _options) => ({
    content: [{ type: "text", text }],
    stopReason,
  });
  return vi.fn(complete);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function enhancerPrompt(request: { messages: unknown[] }): string {
  const message = request.messages[0];
  if (!isRecord(message) || !isUnknownArray(message.content)) {
    throw new Error("enhancer request is missing message content");
  }
  const content = message.content[0];
  if (!isRecord(content) || typeof content.text !== "string") {
    throw new Error("enhancer request is missing prompt text");
  }
  return content.text;
}

beforeEach(() => {
  delete process.env.PENNY_ENHANCE_MODEL;
  delete process.env.PENNY_ENHANCE_TIMEOUT_MS;
  compatBoundary.complete.mockReset();
  compatBoundary.failImport = false;
  compatBoundary.malformed = false;
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

  it("embeds the transcript and places the raw prompt LAST", () => {
    const input = buildEnhancerInput("fix that bug", "### User\nlook at auth.ts");
    expect(input).toContain("<session_context>\n### User\nlook at auth.ts\n</session_context>");
    // methodology.md mentions both tags in prose, so match the real delimited
    // blocks (tag followed by a newline), not the first textual occurrence.
    expect(input.indexOf("<session_context>\n")).toBeLessThan(input.indexOf("<raw_prompt>\n"));
    expect(input.trimEnd().endsWith("</raw_prompt>")).toBe(true);
  });

  it("states explicitly when there is no prior conversation", () => {
    const input = buildEnhancerInput("do the thing");
    expect(input).toContain("No prior conversation");
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
      ctx
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
    const sent = enhancerPrompt(completeFn.mock.calls[0][1]);
    expect(sent).toContain(RAW);
    expect(sent).not.toMatch(/-i\s*<\/raw_prompt>/);
  });

  it("passes an unflagged prompt through untouched", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("should never be called");
    enhance(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: RAW, source: "interactive" },
      fakeCtx()
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
      fakeCtx()
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
      fakeCtx()
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
      fakeCtx({ hasUI: false })
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
    enhance(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx()
    );
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(cap.entries).toHaveLength(0);
  });

  it("falls back to the flag-stripped prompt when the compat dynamic import fails", async () => {
    compatBoundary.failImport = true;
    const cap = capturePi();
    enhance(cap.pi);

    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx()
    );

    expect(result).toEqual({ action: "transform", text: RAW });
    expect(cap.entries).toHaveLength(0);
  });

  it("uses the lazily imported compat complete export when no test dependency is injected", async () => {
    compatBoundary.complete.mockResolvedValue({
      content: [{ type: "text", text: "Goal: imported enhancement" }],
      stopReason: "stop",
    });
    const cap = capturePi();
    enhance(cap.pi);

    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx()
    );

    expect(result).toEqual({ action: "transform", text: "Goal: imported enhancement" });
    expect(compatBoundary.complete).toHaveBeenCalledOnce();
  });

  it("falls back to the flag-stripped prompt when the compat import is malformed", async () => {
    compatBoundary.malformed = true;
    const cap = capturePi();
    enhance(cap.pi);

    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx()
    );

    expect(result).toEqual({ action: "transform", text: RAW });
    expect(cap.entries).toHaveLength(0);
  });

  it("falls back when imported compat returns a malformed response", async () => {
    compatBoundary.complete.mockResolvedValue({
      content: [{ type: "text", text: 42 }],
      stopReason: "stop",
    });
    const cap = capturePi();
    enhance(cap.pi);

    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx()
    );

    expect(result).toEqual({ action: "transform", text: RAW });
    expect(cap.entries).toHaveLength(0);
  });

  it("preserves imported compat cancellation as a raw-prompt fallback", async () => {
    const cancellation = new DOMException("cancelled", "AbortError");
    compatBoundary.complete.mockRejectedValue(cancellation);
    const cap = capturePi();
    enhance(cap.pi);

    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx()
    );

    expect(result).toEqual({ action: "transform", text: RAW });
    expect(compatBoundary.complete).toHaveBeenCalledOnce();
    expect(cap.entries).toHaveLength(0);
  });

  it("rejects a truncated rewrite (abort/error stopReason) and runs the raw prompt", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("Goal: refactor the auth mod", "aborted");
    enhance(cap.pi, { completeFn });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx()
    );
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(cap.entries).toHaveLength(0);
  });

  it("rejects a runaway rewrite and runs the raw prompt", async () => {
    const cap = capturePi();
    enhance(cap.pi, { completeFn: fakeComplete("x".repeat(MAX_ENHANCED_CHARS + 1)) });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      fakeCtx()
    );
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(cap.entries).toHaveLength(0);
  });

  it("proceeds with keyless auth (ok=true, no apiKey)", async () => {
    const cap = capturePi();
    enhance(cap.pi, { completeFn: fakeComplete("Goal: enhanced") });
    const ctx = fakeCtx();
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(
      async (): Promise<FakeAuth> => ({ ok: true, headers: {}, env: {} })
    );
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      ctx
    );
    expect(result).toEqual({ action: "transform", text: "Goal: enhanced" });
  });

  it("runs the raw prompt when auth resolution fails (ok=false)", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("never");
    enhance(cap.pi, { completeFn });
    const ctx = fakeCtx();
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(
      async (): Promise<FakeAuth> => ({ ok: false, error: "nope" })
    );
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      ctx
    );
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("injects the full session transcript into the enhancer call", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("Goal: fix the null deref in auth.ts");
    enhance(cap.pi, { completeFn });
    const ctx = fakeCtx({
      sessionManager: fakeSession(["look at auth.ts", "there is a null deref on line 40"]),
    });
    await cap.inputHandler()(
      { type: "input", text: "fix that bug -i", source: "interactive" },
      ctx
    );
    const sent = enhancerPrompt(completeFn.mock.calls[0][1]);
    expect(sent).toContain("look at auth.ts");
    expect(sent).toContain("there is a null deref on line 40");
    expect(sent).toContain("<raw_prompt>\nfix that bug\n</raw_prompt>");
  });

  it("records context stats on the audit entry", async () => {
    const cap = capturePi();
    enhance(cap.pi, { completeFn: fakeComplete("Goal: enhanced") });
    const ctx = fakeCtx({ sessionManager: fakeSession(["turn one", "turn two"]) });
    await cap.inputHandler()({ type: "input", text: FLAGGED, source: "interactive" }, ctx);
    expect(cap.entries[0].data.contextEntries).toBe(2);
    expect(cap.entries[0].data.contextChars).toBeGreaterThan(0);
    expect(cap.entries[0].data.contextTruncated).toBe(false);
  });

  it("still enhances when the session manager is missing or throws", async () => {
    const cap = capturePi();
    const completeFn = fakeComplete("Goal: enhanced");
    enhance(cap.pi, { completeFn });
    const ctx = fakeCtx({
      sessionManager: {
        buildContextEntries: () => {
          throw new Error("corrupt session");
        },
      },
    });
    const result = await cap.inputHandler()(
      { type: "input", text: FLAGGED, source: "interactive" },
      ctx
    );
    expect(result).toEqual({ action: "transform", text: "Goal: enhanced" });
    expect(cap.entries[0].data.contextEntries).toBe(0);
  });

  it("never reads the session in headless mode", async () => {
    const cap = capturePi();
    const buildContextEntries = vi.fn(() => []);
    const result = await (() => {
      enhance(cap.pi, { completeFn: fakeComplete("nope") });
      return cap.inputHandler()(
        { type: "input", text: FLAGGED, source: "interactive" },
        fakeCtx({ hasUI: false, sessionManager: { buildContextEntries } })
      );
    })();
    expect(result).toEqual({ action: "transform", text: RAW });
    expect(buildContextEntries).not.toHaveBeenCalled();
  });

  it("honors PENNY_ENHANCE_MODEL when the registry resolves it", async () => {
    process.env.PENNY_ENHANCE_MODEL = "ollama/deepseek-v4-flash:cloud";
    const cap = capturePi();
    enhance(cap.pi, { completeFn: fakeComplete("Goal: enhanced") });
    const ctx = fakeCtx();
    const flash = { provider: "ollama", id: "deepseek-v4-flash:cloud" };
    ctx.modelRegistry.find = vi.fn((): { provider: string; id: string } | undefined => flash);
    await cap.inputHandler()({ type: "input", text: FLAGGED, source: "interactive" }, ctx);
    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("ollama", "deepseek-v4-flash:cloud");
    expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(flash);
  });
});
