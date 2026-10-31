import { Type } from "typebox";

/** A Comfy input is one literal JSON key, never a path or property traversal.
 * At most eight identifier segments and 64 ASCII characters; poison segments
 * are excluded even when embedded in a dotted name. */
export const ComfyInputNameSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern:
    "^(?!(?:[^.]+\\.)*(?:__proto__|prototype|constructor)(?:\\.|$))[A-Za-z_][A-Za-z0-9_]{0,63}(?:\\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$",
});

/** Check representation before schema recursion/canonicalization. No accessors,
 * custom prototypes, symbols, nonfinite numbers or unbounded nested JSON. */
export function assertComfyJson(value: unknown): void {
  let nodes = 0,
    bytes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 48) throw new Error("Comfy JSON complexity limit");
    if (typeof v === "string") bytes += Buffer.byteLength(v);
    else if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("Comfy JSON finite number required");
    } else if (v !== null && typeof v === "object") {
      if (Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype))
        throw new Error("Comfy plain JSON required");
      if (Array.isArray(v) && (v.length > 100000 || Object.keys(v).length !== v.length))
        throw new Error("Comfy dense bounded arrays required");
      for (const key of Reflect.ownKeys(v)) {
        if (Array.isArray(v) && key === "length") continue;
        if (
          typeof key !== "string" ||
          key.split(".").some((s) => ["__proto__", "prototype", "constructor"].includes(s))
        )
          throw new Error("Comfy unsafe JSON key");
        bytes += Buffer.byteLength(key);
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d || !d.enumerable || !("value" in d)) throw new Error("Comfy plain JSON required");
        const child: unknown = d.value;
        visit(child, depth + 1);
      }
    } else if (v !== null && typeof v !== "boolean") throw new Error("Comfy JSON value required");
    if (bytes > 16777216) throw new Error("Comfy JSON byte limit");
  };
  visit(value, 0);
}
