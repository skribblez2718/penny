/**
 * Structural types + narrowing helpers for the two untyped JSON boundaries
 * this extension reads from:
 *
 *   1. Pi session entries handed to compaction. These interfaces capture
 *      exactly the host-owned fields this code reads. Every field is optional
 *      because the plugin boundary makes no guarantees; call sites narrow
 *      before use.
 *   2. TypeScript engine checkpoint rows and tool results, which are
 *      arbitrary parsed JSON at this extension boundary. The `as*` helpers narrow `unknown` to a
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
  /** Tool-owned metadata persisted by Pi but not sent to the model. */
  details?: unknown;
}

/** Test whether arbitrary JSON is a string-keyed record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow arbitrary JSON to a string-keyed record (arrays/primitives → {}). */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Narrow arbitrary JSON to a string ("" when not a string). */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Narrow arbitrary JSON to an array (non-arrays → []). */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
