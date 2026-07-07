/**
 * Structural types + narrowing helpers for the two untyped JSON boundaries
 * this extension reads from:
 *
 *   1. Pi session entries handed to compaction. Pi's SDK types the
 *      extension boundary as `any` (see @mariozechner/pi-coding-agent's
 *      ExtensionAPI), so these interfaces capture exactly the fields this
 *      code reads. Every field is optional because the boundary makes no
 *      guarantees; call sites narrow before use.
 *   2. The Python memory bridge / engine checkpointer responses, which are
 *      arbitrary parsed JSON. The `as*` helpers narrow `unknown` to a
 *      concrete shape at each use site instead of trusting a blanket cast.
 */

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}

export interface SessionMessage {
  role: string;
  content?: string | ContentBlock[];
  id?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

/** Narrow arbitrary JSON to a string-keyed record (arrays/primitives → {}). */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Narrow arbitrary JSON to a string ("" when not a string). */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Narrow arbitrary JSON to an array (non-arrays → []). */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
