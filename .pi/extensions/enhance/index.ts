/**
 * Enhance Extension — on-demand prompt enhancement via the `-i` suffix.
 *
 * When a user ends a typed prompt with a trailing ` -i`, the raw prompt is
 * rewritten into a world-class, goal-oriented prompt (methodology.md) BEFORE
 * the model sees it, via the `input` event (`{action: "transform"}`). The `-i`
 * flag is always consumed: the literal "-i" never reaches the model.
 *
 * This replaces the former `/enhance` prompt template + copy/paste workflow:
 * the enhancement happens in place, and the enhanced prompt executes
 * immediately (no confirm step).
 *
 * Trigger: a trailing ` -i` on interactive (human-typed) input only. Prompts
 * without the flag pass through unchanged.
 *
 * Failure honesty: every failure path (model missing, auth missing, timeout,
 * empty or runaway rewrite) degrades to the *flag-stripped* raw prompt so the
 * user's request still runs — just un-enhanced. Enhancement is one LLM call on
 * PENNY_ENHANCE_MODEL (default: the session model at low reasoning effort),
 * which can take tens of seconds on cloud models — hence the explicit opt-in.
 *
 * The original prompt (with flag) is persisted via appendEntry for audit; pi
 * itself only stores the transformed text.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger/logger.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const logger = createLogger("enhance");

const DEFAULT_TIMEOUT_MS = 25_000;
export const MAX_ENHANCED_CHARS = 16_000; // reject empty or runaway rewrites

/** Trailing ` -i` flag: requires a whitespace boundary before `-i` at end. */
export const FLAG_RE = /\s-i$/;

/** Detect and strip the trailing ` -i` enhancement flag. */
export function stripFlag(text: string): { flagged: boolean; prompt: string } {
  const trimmedEnd = text.replace(/\s+$/, "");
  if (!FLAG_RE.test(trimmedEnd)) {
    return { flagged: false, prompt: text };
  }
  return { flagged: true, prompt: trimmedEnd.replace(FLAG_RE, "").trim() };
}

function timeoutMs(): number {
  const raw = Number(process.env.PENNY_ENHANCE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

let methodologyCache: string | null = null;

export function methodology(): string {
  if (methodologyCache === null) {
    const loaded = readFileSync(join(__dir, "methodology.md"), "utf-8");
    methodologyCache = loaded;
    return loaded;
  }
  return methodologyCache;
}

export function buildEnhancerInput(raw: string): string {
  return `${methodology()}\n\n<raw_prompt>\n${raw}\n</raw_prompt>`;
}

/** Accept a rewrite only when it is plausibly an enhanced prompt, not garbage.
 * Enhancement legitimately expands a short request many-fold, so the guard is
 * an absolute ceiling (catches runaway/looping output) rather than a multiple
 * of the raw length. */
export function acceptableRewrite(enhanced: string): boolean {
  const out = enhanced.trim();
  if (!out) return false;
  if (out.length > MAX_ENHANCED_CHARS) return false;
  return true;
}

/** Structural type for pi-ai's complete(); avoids a static import that only
 * resolves inside pi's extension loader (tests inject their own).
 * NOTE: complete() RESOLVES (never rejects) on abort/provider error, returning
 * the partial message with stopReason "aborted"/"error" — so enhanceText must
 * inspect stopReason, not rely on a thrown exception. */
export type CompleteFn = (
  model: unknown,
  request: { messages: unknown[] },
  options: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  stopReason?: string;
}>;

export interface EnhanceDeps {
  completeFn?: CompleteFn;
}

async function resolveComplete(deps: EnhanceDeps): Promise<CompleteFn> {
  if (deps.completeFn) {
    return deps.completeFn;
  }
  // The @earendil-works scope is what pi's loader bundles (the shipped
  // summarize.ts example imports it); lazy so test environments never resolve it.
  const mod = await import("@earendil-works/pi-ai/compat");
  return mod.complete as CompleteFn;
}

async function enhanceText(
  raw: string,
  ctx: ExtensionContext,
  deps: EnhanceDeps,
): Promise<{ enhanced: string; modelId: string } | null> {
  let model = ctx.model;
  const spec = (process.env.PENNY_ENHANCE_MODEL || "").trim();
  if (spec) {
    const [provider, ...rest] = spec.includes("/") ? spec.split("/") : ["ollama", spec];
    const found = ctx.modelRegistry.find(provider, rest.join("/"));
    if (found) {
      model = found;
    } else {
      logger.warn(`PENNY_ENHANCE_MODEL not found: ${spec}; using session model`);
    }
  }
  if (!model) {
    logger.warn("no model available for enhancement");
    return null;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  // ok=false means auth resolution failed; a missing apiKey is legitimate for
  // keyless providers (e.g. a local endpoint), so don't hard-require it.
  if (!auth.ok) {
    logger.warn(`no auth for enhance model ${model.provider}/${model.id}`);
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
            content: [{ type: "text" as const, text: buildEnhancerInput(raw) }],
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
    // a TRUNCATED message — never accept that as an enhanced prompt.
    if (response.stopReason === "aborted" || response.stopReason === "error") {
      logger.warn(`enhancement incomplete (stopReason=${response.stopReason}); using raw prompt`);
      return null;
    }
    const enhanced = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!acceptableRewrite(enhanced)) {
      logger.warn("rewrite rejected (empty or runaway); using raw prompt");
      return null;
    }
    return { enhanced, modelId: `${model.provider}/${model.id}` };
  } catch (err) {
    logger.warn(`enhancement failed, using raw prompt: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default function enhance(pi: ExtensionAPI, deps: EnhanceDeps = {}): void {
  pi.on("input", async (event, ctx) => {
    // The `-i` suffix is a human-typing convention: only interactive input.
    if (event.source !== "interactive") {
      return { action: "continue" as const };
    }
    // Don't rewrite mid-stream steering interrupts.
    if (event.streamingBehavior === "steer") {
      return { action: "continue" as const };
    }
    const { flagged, prompt } = stripFlag(event.text);
    if (!flagged || !prompt) {
      return { action: "continue" as const };
    }
    // The flag is present: from here it must always be consumed so the literal
    // "-i" never reaches the model.
    // Headless contexts (print/json mode, subagents) never pay enhancement
    // latency — strip the flag and run the raw prompt.
    if (!ctx.hasUI) {
      return { action: "transform" as const, text: prompt };
    }

    ctx.ui.notify("Enhancing prompt…", "info");
    const started = Date.now();
    const result = await enhanceText(prompt, ctx, deps);
    if (!result) {
      // Enhancement failed — run the un-enhanced request (flag stripped).
      return { action: "transform" as const, text: prompt };
    }

    pi.appendEntry("enhance", {
      original: event.text,
      enhanced: result.enhanced,
      model: result.modelId,
      latencyMs: Date.now() - started,
    });
    logger.info(
      `enhanced prompt (${prompt.length} → ${result.enhanced.length} chars, ` +
        `${Date.now() - started}ms, ${result.modelId})`,
    );
    return { action: "transform" as const, text: result.enhanced };
  });
}
