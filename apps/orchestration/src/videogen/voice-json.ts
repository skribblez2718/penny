import type { TSchema, Static } from "typebox";
import { canonicalJson } from "../canonical-json.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { readExact, type readSemantic, type FoundationLimitsV1 } from "./bounds.js";

/** Provider JSON is untrusted: reject lossy UTF-8, duplicate object keys, excessive nesting,
 * collection size, invalid/nonfinite numbers and trailing tokens before schema validation. */
export function parseVoiceWireJson(bytes: Uint8Array, limits?: FoundationLimitsV1): unknown {
  if (limits && (bytes.byteLength === 0 || bytes.byteLength > limits.max_json_bytes))
    throw new Error("voice JSON byte limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0,
    nodes = 0;
  const ws = (): void => {
    while (/\s/u.test(text[at] ?? "") && at < text.length) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") at++;
      else if (char === '"') {
        const value: unknown = JSON.parse(text.slice(start, at));
        if (typeof value !== "string") throw new Error("invalid JSON string");
        if (
          Buffer.from(value, "utf8").toString("utf8") !== value ||
          (limits && Buffer.byteLength(value) > limits.max_text_bytes)
        )
          throw new Error("voice JSON text limit");
        return value;
      }
    }
    throw new Error("unterminated provider JSON string");
  };
  const value = (depth: number): void => {
    if (
      depth > Math.min(32, limits?.max_depth ?? 32) ||
      ++nodes > Math.min(32768, limits?.max_nodes ?? 32768)
    )
      throw new Error("provider JSON structural limit");
    ws();
    const char = text[at];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{" || char === "[") {
      at++;
      ws();
      const end = char === "{" ? "}" : "]",
        keys = new Set<string>();
      let items = 0;
      if (text[at] === end) {
        at++;
        return;
      }
      while (at < text.length) {
        if (++items > Math.min(4096, limits?.max_collection_items ?? 4096))
          throw new Error("provider JSON collection limit");
        if (char === "{") {
          ws();
          if (text[at] !== '"') throw new Error("provider JSON key");
          const key = string();
          if (keys.has(key)) throw new Error("duplicate provider JSON key");
          keys.add(key);
          ws();
          if (text[at++] !== ":") throw new Error("provider JSON colon");
        }
        value(depth + 1);
        ws();
        const next = text[at++];
        if (next === end) return;
        if (next !== ",") throw new Error("provider JSON separator");
        ws();
      }
      throw new Error("unterminated provider JSON collection");
    }
    const start = at;
    while (at < text.length && !/[\s,\]}]/u.test(text[at] ?? "")) at++;
    if (at === start) throw new Error("invalid provider JSON scalar");
    const scalar: unknown = JSON.parse(text.slice(start, at));
    if (
      typeof scalar === "number" &&
      (!Number.isFinite(scalar) ||
        (limits && Math.abs(scalar) > limits.max_integer) ||
        (Number.isInteger(scalar) && !Number.isSafeInteger(scalar)))
    )
      throw new Error("nonfinite provider JSON number");
  };
  value(0);
  ws();
  if (at !== text.length) throw new Error("provider JSON trailing bytes");
  const result: unknown = JSON.parse(text);
  return result;
}

/** Voice records contain fractional epoch seconds and metadata measurements. Keep them exact;
 * integer-only foundation JSON is intentionally not widened for unrelated semantic products. */
export function parseVoiceStoredJson<T extends TSchema>(
  schema: T,
  bytes: Uint8Array,
  limits: FoundationLimitsV1
): Static<T> {
  const value = parseVoiceWireJson(bytes, limits);
  const parsed = validateSkillSchema(schema, value, "voice stored JSON");
  if (canonicalJson(parsed) !== new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    throw new Error("noncanonical voice stored JSON");
  return parsed;
}
export function readVoiceSemantic<T extends TSchema>(
  input: Parameters<typeof readSemantic<T>>[0]
): Static<T> {
  if (
    input.ref.media_type !== "application/json" ||
    input.ref.content_schema?.schema_id !== input.schema_id ||
    input.ref.content_schema.schema_version !== 1
  )
    throw new Error("voice semantic ref identity mismatch");
  return parseVoiceStoredJson(
    input.schema,
    readExact(input.store, input.project_id, input.ref, input.limits.max_json_bytes),
    input.limits
  );
}
