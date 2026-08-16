import { MemoryError } from "./types.js";

export const KG_PREDICATE_SCHEMA_VERSION = 1 as const;

/** Canonical vocabulary from docs/agents/memory/kg-patterns.md, schema v1. */
export const CANONICAL_KG_PREDICATES = Object.freeze([
  "completed",
  "decided",
  "evaluated",
  "produced",
  "works_on",
  "uses",
  "prefers",
  "explored_by",
  "planned_by",
  "critiqued_by",
  "generated_by",
  "verified_by",
  "broken_into",
  "based_on",
  "generated_from",
  "tested_by",
  "fixes",
  "follows",
] as const);

const predicateSet = new Set<string>(CANONICAL_KG_PREDICATES);

export function assertCanonicalKgPredicate(value: unknown): asserts value is string {
  if (typeof value !== "string" || !predicateSet.has(value)) {
    throw new MemoryError(
      "MEMPALACE_INVALID",
      `Unknown KG predicate under canonical schema v${KG_PREDICATE_SCHEMA_VERSION}`
    );
  }
}
