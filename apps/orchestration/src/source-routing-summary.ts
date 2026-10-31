import type { TSchema } from "typebox";
import { canonicalJson } from "./canonical-json.js";
import {
  ConfidenceSchema,
  JsonValueSchema,
  validateContract,
  type Confidence,
  type JsonValue,
} from "./contracts.js";

export interface SourceRoutingSummaryV1 {
  readonly confidence: Confidence;
  readonly details: Record<string, JsonValue>;
}

/** JSON.parse validates grammar; this linear token pass rejects duplicate decoded keys
 * before they can silently acquire last-value-wins meaning. It is iterative, including
 * nested arrays/objects. String contents are skipped, never interpreted as framing. */
function uniqueJsonKeys(text: string): boolean {
  const containers: Array<Set<string> | null> = [];
  for (let offset = 0; offset < text.length; offset += 1) {
    const character = text[offset];
    if (character === "{") containers.push(new Set());
    else if (character === "[") containers.push(null);
    else if (character === "}" || character === "]") containers.pop();
    else if (character === '"') {
      const start = offset;
      for (offset += 1; offset < text.length; offset += 1) {
        if (text[offset] === "\\") offset += 1;
        else if (text[offset] === '"') break;
      }
      let next = offset + 1;
      while (/[ \t\r\n]/u.test(text[next] ?? "")) next += 1;
      if (text[next] === ":") {
        const key: unknown = JSON.parse(text.slice(start, offset + 1));
        const keys = containers.at(-1);
        if (typeof key !== "string" || keys == null || keys.has(key)) return false;
        keys.add(key);
      }
    }
  }
  return true;
}

/** Pure preservation boundary for preserve_source_summary_v1.
 * Accepts exactly one unindented final SUMMARY line (optional final LF), strict UTF-8,
 * explicit confidence and independently schema-valid complete details. JSON key order
 * and horizontal separator whitespace are immaterial; ordered arrays are not.
 * No prose verdict inference, defaults, coercion or salvage. When proposed is supplied,
 * ALL details and confidence must equal the source. Undefined means unpreservable.
 * This does not authenticate prose claims or replace a stronger domain core validator.
 */
export function validateSourceRoutingSummary(
  bytes: Uint8Array,
  schema: TSchema,
  proposed?: SourceRoutingSummaryV1
): SourceRoutingSummaryV1 | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0") || text.includes("\ufeff")) return undefined;
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    const lines = body.split("\n");
    if (lines.filter((line) => line.startsWith("SUMMARY:")).length !== 1) return undefined;
    const json = lines.at(-1)?.match(/^SUMMARY:[ \t]*(\{[^\n]*\})$/u)?.[1];
    if (json === undefined) return undefined;
    const value: unknown = JSON.parse(json);
    if (!uniqueJsonKeys(json)) return undefined;
    const parsed = validateContract(JsonValueSchema, value, "source SUMMARY");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const confidence = validateContract(ConfidenceSchema, parsed.confidence, "source confidence");
    const { confidence: _confidence, ...details } = parsed;
    validateContract(schema, details, "source phase details");
    const source = { confidence, details };
    return proposed === undefined ||
      canonicalJson(source) ===
        canonicalJson({ confidence: proposed.confidence, details: proposed.details })
      ? source
      : undefined;
  } catch {
    return undefined;
  }
}
