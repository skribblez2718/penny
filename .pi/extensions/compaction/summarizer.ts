/**
 * Model-owned summarization (the leverage path).
 *
 * The session model reads the ACTUAL evicted conversation and writes the prose
 * resumption brief — the same mechanism Pi's default compaction uses, so it
 * improves automatically as models improve (bitter-lesson LEVERAGE). We augment
 * it with two things Pi can't provide: the previous brief as iterative context,
 * and a session-scoped GROUNDED STATE digest (real run/room/decision ids). The
 * deterministic pointer appendix and the LOAN fallback live in index.ts.
 *
 * The `complete` / `serializeConversation` calls sit behind `_summaryInternals`
 * (dynamic imports) so importing this module never resolves the pi runtime —
 * unit tests mock the seam and never touch a model or the pi package.
 */

import type {
  DecisionRef,
  EngineRunRef,
  KGEntityRef,
  MempalaceRoomRef,
  PendingState,
} from "./schema.js";
import type { SessionMessage } from "./pi-messages.js";

// ============================================================
// Minimal structural view of the pieces of ExtensionContext we use, so this
// module does not depend on the pi type surface at compile time.
// ============================================================

export interface SummarizerModel {
  provider: string;
  id: string;
}

export interface ResolvedAuth {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  error?: string;
}

export interface SummarizerCtx {
  /** The current session model (may be undefined). */
  model?: SummarizerModel;
  modelRegistry: {
    find(provider: string, modelId: string): SummarizerModel | undefined;
    getApiKeyAndHeaders(model: SummarizerModel): Promise<ResolvedAuth>;
  };
}

// ============================================================
// Grounded-state digest (pure, testable)
// ============================================================

export interface GroundedDigestInput {
  scopedRuns: EngineRunRef[];
  otherSessionRuns: EngineRunRef[];
  rooms: MempalaceRoomRef[];
  decisions: DecisionRef[];
  kgEntities: KGEntityRef[];
  pending: PendingState | null;
  readFiles: string[];
  modifiedFiles: string[];
}

/**
 * Render the session-scoped grounded state the model may cite (never invent).
 * Cross-session pending runs are listed under an explicit "other sessions"
 * label so the model never treats them as the current goal/work.
 */
export function renderGroundedDigest(input: GroundedDigestInput): string {
  const lines: string[] = [];

  if (input.scopedRuns.length > 0) {
    lines.push("in-flight runs (this session):");
    for (const r of input.scopedRuns) {
      lines.push(
        `  - ${r.playbook} run ${r.run_id} ${r.status} @${r.current_state_id}` +
          (r.goal ? ` — ${r.goal.slice(0, 120)}` : "") +
          (r.clarification_text ? ` [awaiting: ${r.clarification_text.slice(0, 120)}]` : "")
      );
    }
  }
  if (input.otherSessionRuns.length > 0) {
    lines.push("other pending runs (OTHER sessions — do not treat as current goal/work):");
    for (const r of input.otherSessionRuns) {
      lines.push(`  - ${r.playbook} run ${r.run_id} ${r.status} (session ${r.session_id})`);
    }
  }
  if (input.pending) {
    lines.push(
      `pending: ${input.pending.state}` +
        (input.pending.question_summary ? ` — ${input.pending.question_summary}` : "")
    );
  }
  if (input.rooms.length > 0) {
    lines.push("mempalace rooms:");
    for (const room of input.rooms.slice(0, 10)) {
      const drawers = (room.drawer_ids || []).slice(0, 5).join(",");
      lines.push(`  - ${room.wing}/${room.room}${drawers ? ` [${drawers}]` : ""}`);
    }
  }
  if (input.decisions.length > 0) {
    lines.push("recent decisions (this session):");
    for (const d of input.decisions.slice(0, 10)) {
      lines.push(`  - ${d.decision_id}: ${d.summary.slice(0, 120)}`);
    }
  }
  if (input.kgEntities.length > 0) {
    const names = input.kgEntities.slice(0, 12).map((e) => e.entity_id);
    lines.push(`kg entities: ${names.join(", ")}`);
  }
  if (input.modifiedFiles.length > 0) {
    lines.push(`modified files: ${input.modifiedFiles.slice(0, 20).join(", ")}`);
  }
  if (input.readFiles.length > 0) {
    lines.push(`read files: ${input.readFiles.slice(0, 20).join(", ")}`);
  }

  return lines.join("\n");
}

// ============================================================
// Prompt assembly (pure, testable)
// ============================================================

const OUTPUT_CONTRACT_SECTIONS = [
  "## Goal",
  "## Active Skill",
  "## Current Work",
  "## In-Flight Orchestration Runs",
  "## Pending",
  "## Next Steps",
  "## Key Decisions",
  "## Unresolved Errors",
  "## Critical Context",
];

export interface SummarizerMessage {
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
}

export interface BuildPromptInput {
  conversationText: string;
  previousSummary?: string;
  digest: string;
  customInstructions?: string;
  proseTokenTarget: number;
}

/**
 * Build the single-message summarization prompt. States the output contract
 * (section headings the consumer + carry-forward parse depend on) and the
 * constraints — no step-by-step ceremony (bitter prompting rule).
 */
export function buildSummarizerMessages(input: BuildPromptInput): SummarizerMessage[] {
  const parts: string[] = [];
  parts.push(
    "You are producing a RESUMPTION BRIEF that replaces older conversation " +
      "history after a context compaction. Read the conversation and write a " +
      "concise markdown brief that lets the assistant resume with no work lost."
  );
  parts.push(
    "Output contract — use these section headings; omit a section only when it " +
      `has no content:\n${OUTPUT_CONTRACT_SECTIONS.join("\n")}`
  );
  parts.push(
    "Constraints:\n" +
      "- ## Goal is the user's LATEST substantive intent in the conversation. A " +
      "goal named in an older skill call or an in-flight run must NOT override a " +
      "newer user pivot.\n" +
      "- Carry unresolved errors and blockers forward with enough detail to act on.\n" +
      "- You may cite facts from GROUNDED STATE (run ids, rooms, decisions) but " +
      "NEVER invent identifiers or addresses — exact pointers are appended " +
      "separately, so do not emit a [RESUME-REFS] block yourself.\n" +
      `- Be concise; target about ${input.proseTokenTarget} tokens. No preamble.`
  );
  if (input.previousSummary && input.previousSummary.trim()) {
    parts.push(
      "PREVIOUS BRIEF (integrate what is still true; do not repeat verbatim):\n" +
        input.previousSummary.slice(0, 6000)
    );
  }
  if (input.digest.trim()) {
    parts.push("GROUNDED STATE (real identifiers — cite, never invent):\n" + input.digest);
  }
  if (input.customInstructions && input.customInstructions.trim()) {
    parts.push(
      "FOCUS (from /compact — prioritize this):\n" + input.customInstructions.slice(0, 800)
    );
  }
  parts.push("<conversation>\n" + input.conversationText + "\n</conversation>");

  return [
    { role: "user", content: [{ type: "text", text: parts.join("\n\n") }], timestamp: Date.now() },
  ];
}

/**
 * Strip any [RESUME-REFS ...] block the model may have emitted — addresses are
 * code-owned and appended separately, so a model-emitted refs block would be
 * unverified duplication.
 */
export function stripResumeRefs(text: string): string {
  return text
    .replace(/\[RESUME-REFS[\s\S]*?\[\/RESUME-REFS\]/g, "")
    .replace(/\[RESUME-REFS[\s\S]*$/g, "")
    .trim();
}

// ============================================================
// The mockable model seam (dynamic import → module load never resolves pi)
// ============================================================

export interface CompleteResult {
  content: Array<{ type: string; text?: string }>;
}

export const _summaryInternals: {
  serialize: (messages: SessionMessage[]) => Promise<string>;
  complete: (
    model: SummarizerModel,
    context: { messages: SummarizerMessage[] },
    options: Record<string, unknown>
  ) => Promise<CompleteResult>;
} = {
  serialize: async (messages) => {
    // Resolved lazily via a non-literal specifier: Pi's extension loader
    // resolves these packages at runtime, but tsc cannot (the same tolerated
    // condition as index.ts's `import type` from the aliased package). Using a
    // variable specifier keeps tsc from statically resolving it — no new
    // module-not-found errors, no @ts-ignore.
    const spec = "@mariozechner/pi-coding-agent";
    const mod = (await import(spec)) as unknown as {
      serializeConversation: (m: unknown) => string;
      convertToLlm: (m: unknown) => unknown;
    };
    return mod.serializeConversation(mod.convertToLlm(messages));
  },
  complete: async (model, context, options) => {
    const spec = "@earendil-works/pi-ai/compat";
    const mod = (await import(spec)) as unknown as {
      complete: (m: unknown, c: unknown, o: unknown) => Promise<CompleteResult>;
    };
    return mod.complete(model, context, options);
  },
};

// ============================================================
// Orchestrator
// ============================================================

export interface GenerateModelSummaryInput {
  messages: SessionMessage[];
  previousSummary?: string;
  digest: string;
  customInstructions?: string;
  proseTokenTarget: number;
  signal?: AbortSignal;
}

function resolveSummaryModel(ctx: SummarizerCtx): SummarizerModel | undefined {
  const override = (process.env.PI_COMPACTION_SUMMARY_MODEL || "").trim();
  if (override) {
    const slash = override.indexOf("/");
    if (slash > 0) {
      const found = ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1));
      if (found) return found;
    }
  }
  return ctx.model;
}

function summaryTimeoutMs(): number {
  const raw = parseInt(process.env.PI_COMPACTION_SUMMARY_TIMEOUT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/**
 * Run the model summarization. Returns `{ prose, model }`, or `null` on ANY
 * failure (no model/auth, timeout, abort, empty output, error) so the caller
 * falls back to the deterministic LOAN path. Never throws.
 */
export async function generateModelSummary(
  input: GenerateModelSummaryInput,
  ctx: SummarizerCtx
): Promise<{ prose: string; model: string } | null> {
  try {
    const model = resolveSummaryModel(ctx);
    if (!model) return null;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return null;

    const conversationText = await _summaryInternals.serialize(input.messages);
    const messages = buildSummarizerMessages({
      conversationText,
      previousSummary: input.previousSummary,
      digest: input.digest,
      customInstructions: input.customInstructions,
      proseTokenTarget: input.proseTokenTarget,
    });

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (input.signal) input.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), summaryTimeoutMs());
    try {
      const resp = await _summaryInternals.complete(
        model,
        { messages },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: 4096,
          signal: controller.signal,
        }
      );
      const text = (resp.content || [])
        .filter((c): c is { type: "text"; text: string } => c.type === "text" && !!c.text)
        .map((c) => c.text)
        .join("\n");
      const prose = stripResumeRefs(text);
      if (!prose) return null;
      return { prose, model: `${model.provider}/${model.id}` };
    } finally {
      clearTimeout(timer);
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
    }
  } catch {
    return null;
  }
}
