import { describe, expect, it } from "vitest";

import { SkillContractSchema, validateContract, type SkillContract } from "../src/contracts.js";
import {
  resolvePlaybook,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
} from "../src/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";

type UnknownRecord = Record<string, unknown>;
type Disposition =
  | { readonly kind: "enforced"; readonly probe: string }
  | { readonly kind: "equality_projection"; readonly projection: string }
  | { readonly kind: "surface"; readonly surface: string };

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function schemaLeafPaths(schema: unknown, prefix = ""): string[] {
  if (!isUnknownRecord(schema)) return prefix.length === 0 ? [] : [prefix];
  if (isUnknownRecord(schema.properties)) {
    return Object.entries(schema.properties).flatMap(([name, child]) =>
      schemaLeafPaths(child, prefix.length === 0 ? name : `${prefix}.${name}`)
    );
  }
  if (Array.isArray(schema.anyOf)) {
    return [...new Set(schema.anyOf.flatMap((child) => schemaLeafPaths(child, prefix)))];
  }
  if (schema.type === "array") {
    const items = schema.items;
    if (
      isUnknownRecord(items) &&
      (isUnknownRecord(items.properties) || Array.isArray(items.anyOf))
    ) {
      return schemaLeafPaths(items, `${prefix}[]`);
    }
    return [prefix];
  }
  if (isUnknownRecord(schema.patternProperties)) return [prefix];
  return prefix.length === 0 ? [] : [prefix];
}

function disposition(path: string): Disposition {
  if (path.startsWith("io.")) {
    return { kind: "equality_projection", projection: "registration.contract.io" };
  }
  if (path.startsWith("behavior.")) {
    return { kind: "equality_projection", projection: "registration.contract.behavior" };
  }
  if (path.startsWith("budget_policy.")) {
    return {
      kind: "equality_projection",
      projection: "registration.contract.budget_policy+liveness",
    };
  }
  if (path === "objective") {
    return { kind: "surface", surface: "PlaybookRegistrationV1.contract.objective" };
  }
  if (path === "release_status") {
    return { kind: "equality_projection", projection: "registry namespace+contract digest" };
  }
  if (path === "schema_version" || path === "name" || path.startsWith("guidance.")) {
    return { kind: "enforced", probe: "schema+validateRegistrationContract" };
  }
  if (path.startsWith("repair_routing.")) {
    return { kind: "enforced", probe: "engine-owned state-aware repair" };
  }
  if (path.startsWith("completion_gate.")) {
    return { kind: "enforced", probe: "engine-owned completion admission" };
  }
  throw new Error(`unclassified SkillContractV2 leaf '${path}'`);
}

function contractWithEveryCompletionLeaf(): SkillContract {
  return {
    ...structuredClone(RESEARCH_SKILL_CONTRACT),
    completion_gate: {
      ...structuredClone(RESEARCH_SKILL_CONTRACT.completion_gate),
      unresolved_policy: { mode: "max_count", max_count: 1 },
    },
  };
}

function deletePath(document: UnknownRecord, path: string): void {
  const segments = path.split(".");
  let cursor = document;
  for (const segment of segments.slice(0, -1)) {
    if (segment.endsWith("[]")) {
      const key = segment.slice(0, -2);
      const value = cursor[key];
      const first = isUnknownArray(value) ? value[0] : undefined;
      if (!isUnknownRecord(first)) throw new Error(`probe path '${path}' has no object item`);
      cursor = first;
      continue;
    }
    const value = cursor[segment];
    if (!isUnknownRecord(value)) throw new Error(`probe path '${path}' is not an object path`);
    cursor = value;
  }
  const leaf = segments.at(-1);
  if (leaf === undefined) throw new Error("empty probe path");
  delete cursor[leaf];
}

function shippedResearchRegistration(): PlaybookRegistrationV1 {
  const registration = resolvePlaybook("research");
  if (registration === undefined) throw new Error("research registration unavailable");
  return registration;
}

describe("P2 recursive contract-consumption oracle", () => {
  const leaves = schemaLeafPaths(SkillContractSchema).sort();
  const dispositions = Object.fromEntries(leaves.map((path) => [path, disposition(path)]));

  it("has exact bidirectional equality and no debt disposition", () => {
    expect(Object.keys(dispositions).sort()).toEqual(leaves);
    expect(
      Object.values(dispositions).filter(
        (entry) => !["enforced", "equality_projection", "surface"].includes(entry.kind)
      )
    ).toEqual([]);
    expect(leaves).not.toEqual(
      expect.arrayContaining(["accepts", "produces", "invariants", "budgets"])
    );
  });

  it("makes every leaf required in a maximal valid contract", () => {
    for (const path of leaves) {
      const candidate = contractWithEveryCompletionLeaf();
      deletePath(candidate, path);
      expect(
        () => validateContract(SkillContractSchema, candidate, `removed V2 leaf ${path}`),
        path
      ).toThrow();
    }
  });

  it("names whole-object equality projections for every I/O, behavior, and budget leaf", () => {
    for (const [path, entry] of Object.entries(dispositions)) {
      if (
        path.startsWith("io.") ||
        path.startsWith("behavior.") ||
        path.startsWith("budget_policy.")
      ) {
        expect(entry.kind, path).toBe("equality_projection");
      }
    }
    const shipped = shippedResearchRegistration();
    const drifted = structuredClone(shipped.contract);
    drifted.budget_policy.snapshot_id = "differentSnapshot";
    expect(() => validateRegistrationContract({ ...shipped, contract: drifted })).toThrow(
      /projection drifted/
    );
  });

  it("projects objective and enforces semantic name/guidance equality", () => {
    const shipped = shippedResearchRegistration();
    expect(shipped.contract.objective).toBe(RESEARCH_SKILL_CONTRACT.objective);
    expect(() =>
      validateRegistrationContract({
        ...shipped,
        contract: { ...shipped.contract, name: "not-research" },
      })
    ).toThrow(/does not match registration/);
    expect(() =>
      validateRegistrationContract({
        ...shipped,
        contract: {
          ...shipped.contract,
          guidance: { ...shipped.contract.guidance, skill_root: ".pi/skills/other" },
        },
      })
    ).toThrow(/worker guidance does not match|projection drifted/);
  });
});
