import { canonicalJson } from "../canonical-json.js";
import type { ImagegenGraphV1 } from "../skill-contracts/imagegen.js";
import { assertComfyJson, ComfyInputNameSchema } from "./input-contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";

function record(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new Error("Comfy inventory object required");
  return Object.fromEntries(Object.entries(v));
}
/** Validate the entire selected graph against actual object_info, including dynamic
 * combo branches. Defaults are checked, NEVER inserted; required inputs stay required. */
export function requireComfyGraphInventory(graph: ImagegenGraphV1, inventory: unknown): void {
  assertComfyJson(inventory);
  const info = record(inventory);
  for (const node of Object.values(graph)) {
    const contract = record(info[node.class_type]);
    const allowed = new Set<string>();
    const fields = (v: unknown, prefix: string, depth: number): void => {
      if (depth > 8) throw new Error("Comfy dynamic input depth limit");
      const input = record(v);
      for (const group of ["required", "optional"] as const) {
        const entries = input[group] === undefined ? {} : record(input[group]);
        for (const [key, spec] of Object.entries(entries)) {
          const name = prefix + key;
          validateSkillSchema(ComfyInputNameSchema, name, "actual Comfy input name");
          allowed.add(name);
          if (!Array.isArray(spec) || spec.length < 1 || spec.length > 2)
            throw new Error("Comfy input contract malformed");
          const type: unknown = spec[0];
          const options = spec[1] === undefined ? {} : record(spec[1]);
          const present = Object.hasOwn(node.inputs, name);
          if (!present && group === "required")
            throw new Error(`Comfy required input missing: ${name}`);
          const value = node.inputs[name];
          if (type === "COMFY_DYNAMICCOMBO_V3") {
            const branches = options["options"];
            if (!Array.isArray(branches) || branches.length > 128)
              throw new Error("Comfy dynamic enum invalid");
            const parsed = branches.map(record);
            if (
              Object.hasOwn(options, "default") &&
              !parsed.some((b) => b["key"] === options["default"])
            )
              throw new Error("Comfy enum default invalid");
            if (!present) continue;
            const branch = parsed.find((b) => b["key"] === value);
            if (!branch) throw new Error(`Comfy dynamic enum mismatch: ${name}`);
            fields(branch["inputs"], name + ".", depth + 1);
          } else {
            const choices = Array.isArray(type)
              ? type
              : type === "COMBO"
                ? options["options"]
                : undefined;
            if (choices !== undefined) {
              if (!Array.isArray(choices) || choices.length > 10000)
                throw new Error("Comfy enum invalid");
              if (Object.hasOwn(options, "default") && !choices.includes(options["default"]))
                throw new Error("Comfy enum default invalid");
              if (present && !choices.includes(value))
                throw new Error(`Comfy enum mismatch: ${name}`);
            } else if (present) {
              const primitive =
                type === "INT" || type === "FLOAT" || type === "STRING" || type === "BOOLEAN";
              if (primitive) {
                if (
                  (type === "INT" && !Number.isSafeInteger(value)) ||
                  (type === "FLOAT" && (typeof value !== "number" || !Number.isFinite(value))) ||
                  (type === "STRING" && typeof value !== "string") ||
                  (type === "BOOLEAN" && typeof value !== "boolean")
                )
                  throw new Error(`Comfy primitive mismatch: ${name}`);
                if (
                  typeof value === "number" &&
                  ((typeof options["min"] === "number" && value < options["min"]) ||
                    (typeof options["max"] === "number" && value > options["max"]))
                )
                  throw new Error(`Comfy numeric bounds: ${name}`);
              } else {
                if (
                  !Array.isArray(value) ||
                  value.length !== 2 ||
                  typeof value[0] !== "string" ||
                  !Number.isSafeInteger(value[1]) ||
                  typeof value[1] !== "number" ||
                  value[1] < 0
                )
                  throw new Error(`Comfy typed link required: ${name}`);
                const source = graph[value[0]];
                const outputs =
                  source === undefined ? undefined : record(info[source.class_type])["output"];
                if (!Array.isArray(outputs) || outputs[value[1]] !== type)
                  throw new Error(`Comfy link type mismatch: ${name}`);
              }
            }
          }
        }
      }
    };
    fields(contract["input"], "", 0);
    if (Object.keys(node.inputs).some((k) => !allowed.has(k)))
      throw new Error("Comfy unknown or unselected input");
  }
}

export function requirePinnedComfyInventory(
  graph: ImagegenGraphV1,
  approved: unknown,
  current: unknown
): void {
  requireComfyGraphInventory(graph, approved);
  requireComfyGraphInventory(graph, current);
  const a = record(approved),
    b = record(current);
  for (const name of new Set(Object.values(graph).map((n) => n.class_type)))
    if (canonicalJson(a[name]) !== canonicalJson(b[name]))
      throw new Error("Comfy selected inventory drift");
}
