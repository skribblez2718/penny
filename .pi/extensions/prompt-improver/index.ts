/**
 * Prompt Improver Extension — Circumstances 3/4 of the prompt layer architecture.
 *
 * Rewrites the user's raw message into better-structured Invocation Context
 * BEFORE the model sees it, via the `input` event (`{action: "transform"}`).
 * Note: the architecture docs historically called this a "before_agent_start
 * flow" — that hook cannot rewrite the prompt (its result carries only
 * {message?, systemPrompt?}); `input` is the rewrite hook.
 *
 * The improver is a transformation on Invocation Context, not a new prompt
 * layer: the improved text replaces the raw prompt as the user-role message,
 * and the original is persisted to the session via appendEntry for audit.
 *
 * Modes (PENNY_PROMPT_IMPROVER, read lazily so the environment extension's
 * .env loading wins regardless of factory order):
 *   off     (default) never improve automatically
 *   auto    improve plain, underspecified prompts (skips short replies,
 *           slash/shell input, and already-structured or long prompts)
 *   always  improve every eligible prompt
 *
 * Commands:
 *   /improve <text>   improve <text> and submit it (works in any mode)
 *   /improver [mode]  show or set the mode for this session
 *
 * Latency honesty: improvement blocks prompt submission for one LLM call on
 * the improver model (PENNY_IMPROVER_MODEL, default: the session model at low
 * reasoning effort). With the current Ollama-cloud models that can be tens of
 * seconds — which is why the default mode is off, the confirm editor is on by
 * default, and every failure path degrades silently to the raw prompt.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger/logger.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const logger = createLogger("prompt-improver");

export type ImproverMode = "off" | "auto" | "always";

export const MIN_LENGTH = 40; // short conversational replies are never improved
export const AUTO_MAX_LENGTH = 1200; // in auto mode, long prompts are assumed deliberate
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_GROWTH = 4; // reject rewrites longer than 4x the raw prompt + 2000 chars

/** Session-scoped override set via /improver; null = defer to env. */
let sessionMode: ImproverMode | null = null;

export function setSessionMode(mode: ImproverMode | null): void {
  sessionMode = mode;
}

export function resolveMode(): ImproverMode {
  if (sessionMode !== null) {
    return sessionMode;
  }
  const raw = (process.env.PENNY_PROMPT_IMPROVER || "off").trim().toLowerCase();
  if (raw === "always") return "always";
  if (raw === "auto" || raw === "on" || raw === "1" || raw === "true") return "auto";
  return "off";
}

function confirmEnabled(): boolean {
  const raw = (process.env.PENNY_IMPROVER_CONFIRM || "1").trim().toLowerCase();
  return !(raw === "0" || raw === "off" || raw === "false");
}

function timeoutMs(): number {
  const raw = Number(process.env.PENNY_IMPROVER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Heuristic: the user already structured this prompt deliberately. */
export function looksStructured(text: string): boolean {
  if (/^#{1,3} /m.test(text)) return true; // markdown headings
  if (/```/.test(text)) return true; // fenced code
  if ((text.match(/^\s*[-*] /gm) || []).length >= 3) return true; // bullet list
  if (/^(goal|constraints?|context|success criteria|task)\s*:/im.test(text)) return true;
  return false;
}

export interface ImproveVerdict {
  improve: boolean;
  reason: string;
}

export function shouldImprove(
  text: string,
  source: string,
  streamingBehavior: string | undefined,
  mode: ImproverMode,
): ImproveVerdict {
  if (mode === "off") return { improve: false, reason: "mode off" };
  if (source === "extension") return { improve: false, reason: "extension-injected" };
  if (streamingBehavior !== undefined) return { improve: false, reason: "mid-stream steer" };
  const trimmed = text.trim();
  if (!trimmed) return { improve: false, reason: "empty" };
  if (trimmed.startsWith("/") || trimmed.startsWith("!") || trimmed.startsWith("?")) {
    return { improve: false, reason: "command/shell prefix" };
  }
  if (trimmed.length < MIN_LENGTH) return { improve: false, reason: "too short" };
  if (mode === "auto") {
    if (trimmed.length > AUTO_MAX_LENGTH) return { improve: false, reason: "long prompt" };
    if (looksStructured(trimmed)) return { improve: false, reason: "already structured" };
  }
  return { improve: true, reason: mode };
}

let methodologyCache: string | null = null;

export function methodology(): string {
  if (methodologyCache === null) {
    const loaded = readFileSync(join(__dir, "prompt.md"), "utf-8");
    methodologyCache = loaded;
    return loaded;
  }
  return methodologyCache;
}

export function buildImproverInput(raw: string): string {
  return `${methodology()}\n\n<raw_prompt>\n${raw}\n</raw_prompt>`;
}

/** Accept a rewrite only when it is plausibly an improved prompt, not an answer. */
export function acceptableRewrite(raw: string, improved: string): boolean {
  const out = improved.trim();
  if (!out) return false;
  if (out.length > raw.length * MAX_GROWTH + 2000) return false;
  return true;
}

/** Structural type for pi-ai's complete(); avoids a static import that only
 * resolves inside pi's extension loader (tests inject their own).
 * NOTE: complete() RESOLVES (never rejects) on abort/provider error, returning
 * the partial message with stopReason "aborted"/"error" — so improveText must
 * inspect stopReason, not rely on a thrown exception. */
export type CompleteFn = (
  model: unknown,
  request: { messages: unknown[] },
  options: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  stopReason?: string;
}>;

export interface ImproverDeps {
  completeFn?: CompleteFn;
}

async function resolveComplete(deps: ImproverDeps): Promise<CompleteFn> {
  if (deps.completeFn) {
    return deps.completeFn;
  }
  // The @earendil-works scope is what pi's loader bundles (the shipped
  // summarize.ts example imports it); lazy so test environments never resolve it.
  const mod = await import("@earendil-works/pi-ai/compat");
  return mod.complete as CompleteFn;
}

async function improveText(
  raw: string,
  ctx: ExtensionContext,
  deps: ImproverDeps,
): Promise<{ improved: string; modelId: string } | null> {
  let model = ctx.model;
  const spec = (process.env.PENNY_IMPROVER_MODEL || "").trim();
  if (spec) {
    const [provider, ...rest] = spec.includes("/")
      ? spec.split("/")
      : ["ollama", spec];
    const found = ctx.modelRegistry.find(provider, rest.join("/"));
    if (found) {
      model = found;
    } else {
      logger.warn(`PENNY_IMPROVER_MODEL not found: ${spec}; using session model`);
    }
  }
  if (!model) {
    logger.warn("no model available for improvement");
    return null;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  // ok=false means auth resolution failed; a missing apiKey is legitimate for
  // keyless providers (e.g. a local endpoint), so don't hard-require it.
  if (!auth.ok) {
    logger.warn(`no auth for improver model ${model.provider}/${model.id}`);
    return null;
  }
  let completeFn: CompleteFn;
  try {
    completeFn = await resolveComplete(deps);
  } catch (err) {
    logger.warn(`pi-ai compat unavailable: ${String(err)}`);
    return null;
  }
  // ctx.signal is undefined during the input hook — bring our own timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await completeFn(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: buildImproverInput(raw) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        reasoningEffort: "low",
        signal: controller.signal,
      },
    );
    // complete() resolves (not rejects) on timeout/provider error, handing back
    // a TRUNCATED message — never accept that as an improved prompt.
    if (response.stopReason === "aborted" || response.stopReason === "error") {
      logger.warn(`improvement incomplete (stopReason=${response.stopReason}); using raw prompt`);
      return null;
    }
    const improved = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!acceptableRewrite(raw, improved)) {
      logger.warn("rewrite rejected (empty or disproportionate); using raw prompt");
      return null;
    }
    return { improved, modelId: `${model.provider}/${model.id}` };
  } catch (err) {
    logger.warn(`improvement failed, using raw prompt: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default function promptImprover(
  pi: ExtensionAPI,
  deps: ImproverDeps = {},
): void {
  // The extension module is cached across sessions in one process; reset the
  // /improver override at each session start so it never leaks between sessions.
  pi.on("session_start", () => {
    setSessionMode(null);
  });

  pi.on("input", async (event, ctx) => {
    const mode = resolveMode();
    const verdict = shouldImprove(event.text, event.source, event.streamingBehavior, mode);
    if (!verdict.improve) {
      return { action: "continue" as const };
    }
    // Headless contexts (print/json mode, subagents) never wait on improvement.
    if (!ctx.hasUI) {
      return { action: "continue" as const };
    }

    ctx.ui.notify("Improving prompt…", "info");
    const started = Date.now();
    const result = await improveText(event.text, ctx, deps);
    if (!result) {
      return { action: "continue" as const };
    }

    let finalText = result.improved;
    if (confirmEnabled()) {
      const edited = await ctx.ui.editor(
        "Improved prompt — accept, edit, or cancel to send your original",
        result.improved,
      );
      if (edited === undefined || !edited.trim()) {
        return { action: "continue" as const };
      }
      finalText = edited;
    }

    pi.appendEntry("prompt-improver", {
      original: event.text,
      improved: finalText,
      model: result.modelId,
      latencyMs: Date.now() - started,
      mode,
    });
    logger.info(
      `improved prompt (${event.text.length} → ${finalText.length} chars, ` +
        `${Date.now() - started}ms, ${result.modelId})`,
    );
    return { action: "transform" as const, text: finalText };
  });

  pi.registerCommand("improve", {
    description: "Improve the given prompt text and submit it",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (!raw) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /improve <prompt text>", "warning");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Improving prompt…", "info");
      const result = await improveText(raw, ctx, deps);
      const finalText = result ? result.improved : raw;
      if (result) {
        pi.appendEntry("prompt-improver", {
          original: raw,
          improved: finalText,
          model: result.modelId,
          command: true,
        });
      } else if (ctx.hasUI) {
        ctx.ui.notify("Improvement failed — sending your original text", "warning");
      }
      // sendUserMessage without deliverAs throws if the agent is mid-turn;
      // queue as a follow-up so /improve is safe while streaming.
      pi.sendUserMessage(finalText, { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("improver", {
    description: "Show or set the prompt-improver mode for this session (off|auto|always)",
    handler: async (args, ctx) => {
      const wanted = (args || "").trim().toLowerCase();
      if (wanted === "off" || wanted === "auto" || wanted === "always") {
        setSessionMode(wanted);
        if (ctx.hasUI) ctx.ui.notify(`prompt-improver mode: ${wanted} (this session)`, "info");
        return;
      }
      if (wanted) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /improver [off|auto|always]", "warning");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(`prompt-improver mode: ${resolveMode()}`, "info");
    },
  });
}
