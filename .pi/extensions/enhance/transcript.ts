/**
 * Session transcript serialization for prompt enhancement.
 *
 * The enhancer is a standalone LLM call with no conversation of its own, so a
 * mid-session prompt ("fix that bug", "do the same for the other file") is
 * unresolvable unless the session is handed to it explicitly. Without it the
 * enhancer still has to satisfy the methodology's demand for concreteness, so
 * it invents plausible-but-wrong specifics. This module flattens pi's
 * compaction-aware entry list into plain text so references resolve.
 *
 * FULL session by design (no turn windowing): PENNY_ENHANCE_MODEL is a ~1M
 * token model, and buildContextEntries() already returns the post-compaction
 * ACTIVE set — the same entries pi sends the main model. The char ceiling below
 * is a safety valve against a provider hard-error (which degrades to the raw
 * prompt and reintroduces the very bug this fixes), not a trimming policy.
 *
 * Deliberately omitted: assistant `thinking` blocks (model scratchpad, not
 * conversation content, and the single largest volume contributor) and image
 * bytes (the enhance model is text-only). Both are replaced by markers so the
 * enhancer knows something was there.
 */

/** Entry kinds that participate in LLM context — mirrors pi's own
 *  sessionEntryToContextMessages(). Anything else is session bookkeeping
 *  (labels, model changes, `custom` entries such as our own audit rows). */
const CONTEXT_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary", "compaction"]);

/** Absolute ceiling on serialized transcript size. ~3.2M chars ≈ 800K tokens,
 *  which clears the 999,424-token enhance model with room for the methodology
 *  and the reply. Only trips if the session model's window exceeds the enhance
 *  model's. Override with PENNY_ENHANCE_CONTEXT_MAX_CHARS. */
export const DEFAULT_CONTEXT_MAX_CHARS = 3_200_000;

/** Per-tool-result cap. A single result (a large file read, a scan dump) can
 *  dwarf the rest of the session; keeping the head preserves what the result
 *  was about without letting one entry crowd out the conversation. */
export const TOOL_RESULT_MAX_CHARS = 20_000;

export function contextMaxChars(): number {
  const raw = Number(process.env.PENNY_ENHANCE_CONTEXT_MAX_CHARS || DEFAULT_CONTEXT_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTEXT_MAX_CHARS;
}

/** Structural shapes. pi's real types only resolve inside its extension loader
 *  and session files are parsed without validation, so every field is treated
 *  as optional and narrowed at use. */
interface ContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
  /** Real parts carry more fields than are named here (an image part's `data`
   *  and `mimeType`, a toolCall's `id`); this view is partial by design. */
  [key: string]: unknown;
}

interface MessageLike {
  role?: string;
  content?: string | ContentPart[] | null;
  toolName?: string;
  isError?: boolean;
  customType?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  excludeFromContext?: boolean;
  summary?: string;
}

export interface EntryLike {
  type?: string;
  message?: MessageLike;
  content?: string | ContentPart[] | null;
  customType?: string;
  summary?: string;
  display?: boolean;
}

export interface TranscriptResult {
  /** Serialized transcript, empty string when the session has no usable history. */
  text: string;
  /** Number of entries actually rendered. */
  entryCount: number;
  /** True when the char ceiling forced oldest-first dropping. */
  truncated: boolean;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [truncated, ${value.length - max} more chars]`;
}

/** Flatten a message/entry content field to text. */
export function serializeContent(content: string | ContentPart[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    switch (part.type) {
      case "text":
        if (typeof part.text === "string" && part.text) parts.push(part.text);
        break;
      case "image":
        parts.push("[image omitted]");
        break;
      case "thinking":
        // Scratchpad, not conversation content — see file header.
        break;
      case "toolCall": {
        const name = typeof part.name === "string" ? part.name : "unknown";
        let args = "";
        try {
          args = JSON.stringify(part.arguments ?? {});
        } catch {
          args = "[unserializable arguments]";
        }
        parts.push(`[tool call: ${name}] ${truncate(args, 2_000)}`);
        break;
      }
      default:
        break;
    }
  }
  return parts.join("\n");
}

/** Render one AgentMessage as a labeled block, or null when it carries nothing. */
export function serializeMessage(message: MessageLike | undefined): string | null {
  if (!message || typeof message !== "object") return null;
  switch (message.role) {
    case "user": {
      const body = serializeContent(message.content);
      return body ? `### User\n${body}` : null;
    }
    case "assistant": {
      const body = serializeContent(message.content);
      return body ? `### Penny\n${body}` : null;
    }
    case "toolResult": {
      const body = truncate(serializeContent(message.content), TOOL_RESULT_MAX_CHARS);
      const tool = message.toolName || "tool";
      const status = message.isError ? " (error)" : "";
      return `### Tool result: ${tool}${status}\n${body || "[no output]"}`;
    }
    case "bashExecution": {
      if (message.excludeFromContext) return null;
      const cmd = message.command || "";
      const out = truncate(message.output || "", TOOL_RESULT_MAX_CHARS);
      return `### Bash: ${cmd} (exit ${message.exitCode ?? "?"})\n${out}`;
    }
    case "custom": {
      const body = serializeContent(message.content);
      return body ? `### ${message.customType || "custom"}\n${body}` : null;
    }
    case "compactionSummary": {
      return message.summary ? `### Earlier conversation (compacted)\n${message.summary}` : null;
    }
    case "branchSummary": {
      return message.summary ? `### Branch summary\n${message.summary}` : null;
    }
    default:
      return null;
  }
}

/** Render one session entry, mirroring pi's context-participation rules. */
export function serializeEntry(entry: EntryLike | undefined): string | null {
  if (!entry || typeof entry !== "object" || !entry.type) return null;
  if (!CONTEXT_ENTRY_TYPES.has(entry.type)) return null;
  switch (entry.type) {
    case "message":
      return serializeMessage(entry.message);
    case "custom_message": {
      const body = serializeContent(entry.content);
      return body ? `### ${entry.customType || "custom"}\n${body}` : null;
    }
    case "compaction":
      return entry.summary ? `### Earlier conversation (compacted)\n${entry.summary}` : null;
    case "branch_summary":
      return entry.summary ? `### Branch summary\n${entry.summary}` : null;
    default:
      return null;
  }
}

/**
 * Serialize the active session into a transcript.
 *
 * Entries arrive oldest-first. When the ceiling trips, the OLDEST blocks are
 * dropped: recent turns are what referential prompts point at.
 */
export function buildTranscript(entries: readonly EntryLike[] | undefined): TranscriptResult {
  if (!entries || entries.length === 0) {
    return { text: "", entryCount: 0, truncated: false };
  }
  const blocks: string[] = [];
  for (const entry of entries) {
    const block = serializeEntry(entry);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) {
    return { text: "", entryCount: 0, truncated: false };
  }

  const max = contextMaxChars();
  let truncated = false;
  let total = blocks.reduce((sum, b) => sum + b.length + 2, 0);
  while (blocks.length > 1 && total > max) {
    const dropped = blocks.shift();
    total -= (dropped?.length ?? 0) + 2;
    truncated = true;
  }
  const body = blocks.join("\n\n");
  const text = truncated
    ? `[older history omitted — transcript exceeded the size ceiling]\n\n${body}`
    : body;
  return { text, entryCount: blocks.length, truncated };
}

/** Structural view of the slice of ReadonlySessionManager this module needs. */
export interface SessionLike {
  buildContextEntries?: () => EntryLike[];
}

/** Pull the active entry list from the session manager, tolerating absence.
 *  Never throws: enhancement must degrade, never break the user's input path. */
export function transcriptFromSession(session: SessionLike | undefined): TranscriptResult {
  if (!session || typeof session.buildContextEntries !== "function") {
    return { text: "", entryCount: 0, truncated: false };
  }
  try {
    return buildTranscript(session.buildContextEntries());
  } catch {
    return { text: "", entryCount: 0, truncated: false };
  }
}
