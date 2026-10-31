import type { FoundationLimitsV1 } from "./bounds.js";
/** Private manifest parser: duplicate-free JSON with explicit larger closed-runtime bounds. */
export function parseRuntimeWireJson(bytes: Uint8Array, limits: FoundationLimitsV1): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.max_json_bytes)
    throw new Error("runtime JSON byte limit");
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
          Buffer.byteLength(value) > limits.max_text_bytes
        )
          throw new Error("runtime JSON text limit");
        return value;
      }
    }
    throw new Error("unterminated runtime JSON string");
  };
  const value = (depth: number): void => {
    if (depth > limits.max_depth || ++nodes > limits.max_nodes)
      throw new Error("runtime JSON structural limit");
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
        if (++items > limits.max_collection_items) throw new Error("runtime JSON collection limit");
        if (char === "{") {
          ws();
          if (text[at] !== '"') throw new Error("runtime JSON key");
          const key = string();
          if (keys.has(key)) throw new Error("duplicate runtime JSON key");
          keys.add(key);
          ws();
          if (text[at++] !== ":") throw new Error("runtime JSON colon");
        }
        value(depth + 1);
        ws();
        const next = text[at++];
        if (next === end) return;
        if (next !== ",") throw new Error("runtime JSON separator");
        ws();
      }
      throw new Error("unterminated runtime JSON collection");
    }
    const start = at;
    while (at < text.length && !/[\s,\]}]/u.test(text[at] ?? "")) at++;
    if (at === start) throw new Error("invalid runtime JSON scalar");
    const scalar: unknown = JSON.parse(text.slice(start, at));
    if (
      typeof scalar === "number" &&
      (!Number.isFinite(scalar) ||
        Math.abs(scalar) > limits.max_integer ||
        (Number.isInteger(scalar) && !Number.isSafeInteger(scalar)))
    )
      throw new Error("nonfinite runtime JSON number");
  };
  value(0);
  ws();
  if (at !== text.length) throw new Error("runtime JSON trailing bytes");
  const result: unknown = JSON.parse(text);
  return result;
}
