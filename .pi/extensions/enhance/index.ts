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
 * Session context: the enhancer receives the FULL active conversation (see
 * transcript.ts) so mid-session referential prompts ("fix that bug", "same for
 * the other file") resolve instead of being enhanced into invented specifics.
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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../lib/logger/logger.js";
import { type SessionLike, type TranscriptResult, transcriptFromSession } from "./transcript.js";

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

/**
 * Assemble the enhancer input: methodology, then the session transcript, then
 * the raw prompt LAST so the text being rewritten sits closest to the
 * generation point rather than behind a large history block.
 */
export function buildEnhancerInput(raw: string, transcript = ""): string {
  const context = transcript.trim()
    ? `\n\n<session_context>\n${transcript}\n</session_context>`
    : "\n\n<session_context>\n(No prior conversation — this is the first prompt of the session.)\n</session_context>";
  return `${methodology()}${context}\n\n<raw_prompt>\n${raw}\n</raw_prompt>`;
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
interface CompleteContentPart {
  type: string;
  text?: string;
}

interface CompleteResponse {
  content: CompleteContentPart[];
  stopReason?: string;
}

export type CompleteFn = (
  model: unknown,
  request: { messages: unknown[] },
  options: Record<string, unknown>
) => Promise<CompleteResponse>;

interface CompatRuntimeModule {
  complete: CompleteFn;
}

interface UnknownModuleRecord {
  readonly [key: string]: unknown;
}

function isUnknownModuleRecord(value: unknown): value is UnknownModuleRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function isSessionLike(value: unknown): value is SessionLike {
  return (
    isUnknownModuleRecord(value) &&
    (value.buildContextEntries === undefined || typeof value.buildContextEntries === "function")
  );
}

function isCompatRuntimeModule(value: unknown): value is CompatRuntimeModule {
  return isUnknownModuleRecord(value) && typeof value.complete === "function";
}

function isCompleteContentPart(value: unknown): value is CompleteContentPart {
  return (
    isUnknownModuleRecord(value) &&
    typeof value.type === "string" &&
    (value.text === undefined || typeof value.text === "string")
  );
}

function isCompleteResponse(value: unknown): value is CompleteResponse {
  return (
    isUnknownModuleRecord(value) &&
    Array.isArray(value.content) &&
    value.content.every(isCompleteContentPart) &&
    (value.stopReason === undefined || typeof value.stopReason === "string")
  );
}

export interface EnhanceDeps {
  completeFn?: CompleteFn;
}

async function resolveComplete(deps: EnhanceDeps): Promise<CompleteFn> {
  if (deps.completeFn) {
    return deps.completeFn;
  }
  // The @earendil-works scope is what pi's loader bundles (the shipped
  // summarize.ts example imports it); lazy so test environments never resolve it.
  // A variable specifier keeps tsc from statically resolving a package that only
  // exists inside pi's loader — same pattern as compaction/summarizer.ts.
  const spec = "@earendil-works/pi-ai/compat";
  const imported: unknown = await import(spec);
  if (!isCompatRuntimeModule(imported)) {
    throw new TypeError("pi-ai compat module has no callable complete export");
  }
  return async (model, request, options) => {
    const response: unknown = await imported.complete(model, request, options);
    if (!isCompleteResponse(response)) {
      throw new TypeError("pi-ai compat complete returned an invalid response");
    }
    return response;
  };
}

type ModelAuthResolution =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
    }
  | { ok: false };

function optionalStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isUnknownModuleRecord(value)) {
    throw new TypeError(`model registry auth response has invalid ${field}`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new TypeError(`model registry auth response has invalid ${field}.${key}`);
    }
    result[key] = item;
  }
  return result;
}

/**
 * Pi currently exposes the session model as Model<any> while its registry auth
 * resolver accepts Model<Api>. Keep the exact runtime object, isolate that
 * upstream generic mismatch behind an unknown callable, and validate the only
 * response field enhancement consumes.
 */
async function resolveModelAuth(
  ctx: ExtensionContext,
  model: unknown
): Promise<ModelAuthResolution> {
  const resolver: unknown = ctx.modelRegistry.getApiKeyAndHeaders.bind(ctx.modelRegistry);
  if (!isUnknownCallable(resolver)) {
    throw new TypeError("model registry auth resolver is not callable");
  }
  const response: unknown = await resolver(model);
  if (!isUnknownModuleRecord(response) || typeof response.ok !== "boolean") {
    throw new TypeError("model registry auth resolver returned an invalid response");
  }
  if (!response.ok) return { ok: false };
  if (response.apiKey !== undefined && typeof response.apiKey !== "string") {
    throw new TypeError("model registry auth response has invalid apiKey");
  }
  return {
    ok: true,
    apiKey: response.apiKey,
    headers: optionalStringRecord(response.headers, "headers"),
    env: optionalStringRecord(response.env, "env"),
  };
}

async function enhanceText(
  raw: string,
  ctx: ExtensionContext,
  deps: EnhanceDeps,
  transcript: TranscriptResult
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
  const auth = await resolveModelAuth(ctx, model);
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
            content: [{ type: "text" as const, text: buildEnhancerInput(raw, transcript.text) }],
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
      }
    );
    // complete() resolves (not rejects) on timeout/provider error, handing back
    // a TRUNCATED message — never accept that as an enhanced prompt.
    if (response.stopReason === "aborted" || response.stopReason === "error") {
      logger.warn(`enhancement incomplete (stopReason=${response.stopReason}); using raw prompt`);
      return null;
    }
    const enhanced = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
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

/** The slice of pi's InputEvent this extension reads. */
interface InputEventLike {
  text: string;
  source: string;
  streamingBehavior?: "steer" | "followUp";
}

export default function enhance(pi: ExtensionAPI, deps: EnhanceDeps = {}): void {
  pi.on("input", async (event: InputEventLike, ctx: ExtensionContext) => {
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

    // Full active conversation so referential prompts resolve. Failure to read
    // the session yields an empty transcript — never blocks the input path.
    const transcript = transcriptFromSession(
      isSessionLike(ctx.sessionManager) ? ctx.sessionManager : undefined
    );
    ctx.ui.notify(
      transcript.entryCount > 0
        ? `Enhancing prompt (${transcript.entryCount} session entries)…`
        : "Enhancing prompt…",
      "info"
    );
    const started = Date.now();
    const result = await enhanceText(prompt, ctx, deps, transcript);
    if (!result) {
      // Enhancement failed — run the un-enhanced request (flag stripped).
      return { action: "transform" as const, text: prompt };
    }

    pi.appendEntry("enhance", {
      original: event.text,
      enhanced: result.enhanced,
      model: result.modelId,
      latencyMs: Date.now() - started,
      contextEntries: transcript.entryCount,
      contextChars: transcript.text.length,
      contextTruncated: transcript.truncated,
    });
    logger.info(
      `enhanced prompt (${prompt.length} → ${result.enhanced.length} chars, ` +
        `${Date.now() - started}ms, ${result.modelId}, ` +
        `context: ${transcript.entryCount} entries / ${transcript.text.length} chars` +
        `${transcript.truncated ? " (truncated)" : ""})`
    );
    return { action: "transform" as const, text: result.enhanced };
  });
}
