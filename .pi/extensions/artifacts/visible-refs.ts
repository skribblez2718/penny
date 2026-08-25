/**
 * Model-visible artifact reference lines.
 *
 * Pi transmits ONLY a tool result's `content` to the provider. Every provider
 * conversion path in `@earendil-works/pi-ai` reads `msg.content` and never
 * `msg.details` (anthropic-messages, openai-responses-shared, openai-completions,
 * google-shared). A ref surfaced solely in `details` is therefore invisible to
 * the model that must call `artifact_read`, and `artifact_read` deliberately
 * exposes no list/search/discovery surface — so an unseen ref is an unreadable
 * artifact.
 *
 * This module is the single place that renders an exact artifact ID into
 * model-visible text. Both the subagent and skill extensions use it so the two
 * cannot drift into different vocabularies for the same capability.
 *
 * Only the opaque `artifact_id` is emitted. The full schema-v2 ref stays in
 * `details` for renderers; `artifact_read` intentionally accepts a bare ID.
 */

import type { ArtifactRef } from "./types.js";

/** Rendered length is bounded and predictable: ~80 bytes per ref. */
export const EXACT_OUTPUT_LABEL = "exact output artifact";

/** One inline marker, for appending to a line that already carries a preview. */
export function inlineArtifactMarker(ref: Pick<ArtifactRef, "artifact_id">): string {
  return ` [${EXACT_OUTPUT_LABEL}: ${ref.artifact_id}]`;
}

/**
 * A standalone block naming one exact output and how to read it.
 *
 * The call form is spelled out because the orchestrator's protocol doc is not
 * always in context when a delegation returns.
 */
export function exactOutputBlock(ref: Pick<ArtifactRef, "artifact_id">): string {
  return [
    `[${EXACT_OUTPUT_LABEL}: ${ref.artifact_id}]`,
    `Re-read exact bytes with artifact_read({"artifact":"${ref.artifact_id}"}).`,
  ].join("\n");
}

export interface LabelledRef {
  /** Human-facing origin, e.g. `step 2 (piper)` or `annie`. */
  label: string;
  ref: Pick<ArtifactRef, "artifact_id">;
}

/**
 * A block naming several exact outputs in caller-supplied order.
 *
 * Used by chain and parallel modes, where the inline text is a final step or a
 * bounded preview and the per-producer artifacts are the only complete copies.
 */
export function exactOutputListBlock(entries: readonly LabelledRef[]): string {
  if (entries.length === 0) return "";
  const lines = [`[${EXACT_OUTPUT_LABEL}s]`];
  for (const entry of entries) {
    lines.push(`- ${entry.label}: ${entry.ref.artifact_id}`);
  }
  lines.push('Read any of them with artifact_read({"artifact":"art_<id>"}).');
  return lines.join("\n");
}

/** Append a block to existing model-visible text, preserving a blank-line gap. */
export function appendBlock(text: string, block: string): string {
  if (!block) return text;
  return text ? `${text}\n\n${block}` : block;
}
