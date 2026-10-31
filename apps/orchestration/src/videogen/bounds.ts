import { TextDecoder } from "node:util";
import { Type, type Static, type TSchema } from "typebox";
import { canonicalJson } from "../canonical-json.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import type { ArtifactStore } from "../artifact-store.js";
import { validateSkillSchema } from "../skill-contracts/common.js";

const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** Host-internal finite representation policy. No deployment defaults. */
export const FoundationLimitsV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-foundation-limits.v1"),
    schema_version: Type.Literal(1),
    max_json_bytes: positive,
    max_text_bytes: positive,
    max_collection_items: positive,
    max_depth: positive,
    max_nodes: positive,
    max_integer: positive,
  },
  { additionalProperties: false }
);
export type FoundationLimitsV1 = Static<typeof FoundationLimitsV1Schema>;

export function validateFoundationLimits(value: unknown): FoundationLimitsV1 {
  return validateSkillSchema(FoundationLimitsV1Schema, value, "foundation limits");
}

/** Preflight complexity before the schema walker; reject cycles, exotic objects and lossy JSON. */
export function assertBoundedJson(value: unknown, policy: FoundationLimitsV1): void {
  const limits = validateFoundationLimits(policy);
  const seen = new Set<object>();
  let nodes = 0;
  function walk(item: unknown, depth: number): void {
    if (++nodes > limits.max_nodes || depth > limits.max_depth)
      throw new Error("JSON complexity limit");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Math.abs(item) > limits.max_integer)
        throw new Error("unsafe or excessive integer");
      return;
    }
    if (typeof item === "string") {
      if (
        Buffer.from(item, "utf8").toString("utf8") !== item ||
        Buffer.byteLength(item, "utf8") > limits.max_text_bytes
      )
        throw new Error("UTF-8 text limit");
      return;
    }
    if (typeof item !== "object" || seen.has(item)) throw new Error("non-JSON or cyclic input");
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > limits.max_collection_items) throw new Error("collection limit");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        Object.getOwnPropertySymbols(item).length > 0 ||
        Object.entries(descriptors).some(
          ([key, descriptor]) =>
            key !== "length" &&
            (descriptor.get !== undefined ||
              descriptor.set !== undefined ||
              String(Number(key)) !== key ||
              Number(key) < 0 ||
              Number(key) >= item.length)
        )
      )
        throw new Error("non-JSON array properties");
      for (const child of item) walk(child, depth + 1);
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new Error("non-JSON object");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (
        Object.values(descriptors).some((x) => x.get !== undefined || x.set !== undefined) ||
        Object.getOwnPropertySymbols(item).length > 0
      )
        throw new Error("non-JSON properties");
      const entries = Object.entries(item);
      if (entries.length > limits.max_collection_items) throw new Error("collection limit");
      for (const [key, child] of entries) {
        walk(key, depth + 1);
        walk(child, depth + 1);
      }
      if ("artifact_id" in item && "store_ref" in item) exactRef(item);
    }
    seen.delete(item);
  }
  walk(value, 0);
  if (Buffer.byteLength(canonicalJson(value), "utf8") > limits.max_json_bytes)
    throw new Error("JSON byte limit");
}

export function validateFoundation<T extends TSchema>(
  schema: T,
  value: unknown,
  limits: FoundationLimitsV1
): Static<T> {
  assertBoundedJson(value, limits);
  return validateSkillSchema(schema, value, "videogen semantic product");
}

export function exactRef(value: unknown): ArtifactRef {
  const ref = validateSkillSchema(ArtifactRefSchema, value, "platform artifact ref");
  if (
    !Number.isSafeInteger(ref.byte_length) ||
    !Number.isSafeInteger(ref.version) ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  )
    throw new Error("invalid exact ref");
  return ref;
}
export function sameRef(a: ArtifactRef, b: ArtifactRef): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Read only, through the existing project-bound store. Never discover or synthesize refs. */
export function readExact(
  store: ArtifactStore,
  projectId: string,
  value: ArtifactRef,
  maxBytes: number
): Buffer {
  store.assertBoundProject(projectId);
  const ref = exactRef(value);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || ref.byte_length > maxBytes)
    throw new Error("artifact byte limit");
  return store.read(ref);
}
export function readSemantic<T extends TSchema>(input: {
  store: ArtifactStore;
  project_id: string;
  ref: ArtifactRef;
  schema: T;
  schema_id: string;
  limits: FoundationLimitsV1;
}): Static<T> {
  if (
    input.ref.media_type !== "application/json" ||
    input.ref.content_schema?.schema_id !== input.schema_id ||
    input.ref.content_schema.schema_version !== 1
  )
    throw new Error("semantic ref identity mismatch");
  const bytes = readExact(input.store, input.project_id, input.ref, input.limits.max_json_bytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  const parsed = validateFoundation(input.schema, value, input.limits);
  if (!Buffer.from(canonicalJson(parsed), "utf8").equals(bytes))
    throw new Error("noncanonical or duplicate-key semantic JSON");
  return parsed;
}
