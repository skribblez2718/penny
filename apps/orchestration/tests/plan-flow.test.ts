import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PLAN_FLOW } from "../src/playbooks/plan.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const html = readFileSync(
  path.join(PROJECT_ROOT, ".pi", "skills", "plan", "resources", "flow.html"),
  "utf8"
);

function jsonConstant(name: "N" | "E"): unknown {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Plan flow is missing ${name}`);
  const valueStart = start + marker.length;
  const opening = html[valueStart];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = valueStart; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(valueStart, index + 1));
    }
  }
  throw new Error(`Plan flow ${name} literal is unbalanced`);
}

function nodeIds(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plan flow nodes are malformed");
  }
  return Object.keys(value);
}

function edgeIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Plan flow edges are malformed");
  return value.map((entry: unknown) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !("from" in entry) ||
      !("to" in entry) ||
      typeof entry.from !== "string" ||
      typeof entry.to !== "string"
    ) {
      throw new Error("Plan flow edge is malformed");
    }
    return `${entry.from}→${entry.to}`;
  });
}

const NORMATIVE_STATES = [
  "intake",
  "orienting_strategy",
  "strategy_evidence_gate",
  "gathering_strategy_evidence",
  "strategizing",
  "sealing_strategy",
  "verifying_strategy",
  "critiquing_strategy",
  "admitting_strategy",
  "complete",
  "incomplete",
  "cancelled",
] as const;

const NORMATIVE_EDGES = [
  "intake→orienting_strategy",
  "orienting_strategy→strategy_evidence_gate",
  "strategy_evidence_gate→gathering_strategy_evidence",
  "strategy_evidence_gate→strategizing",
  "gathering_strategy_evidence→strategizing",
  "strategizing→sealing_strategy",
  "sealing_strategy→strategizing",
  "sealing_strategy→verifying_strategy",
  "verifying_strategy→orienting_strategy",
  "verifying_strategy→strategizing",
  "verifying_strategy→critiquing_strategy",
  "critiquing_strategy→orienting_strategy",
  "critiquing_strategy→strategizing",
  "critiquing_strategy→admitting_strategy",
  "admitting_strategy→complete",
] as const;

describe("Plan candidate flow descriptor", () => {
  it("matches the frozen normative topology in both machine and documentation", () => {
    expect([...PLAN_FLOW.states]).toEqual(NORMATIVE_STATES);
    expect(PLAN_FLOW.edges.map(([from, to]) => `${from}→${to}`)).toEqual(NORMATIVE_EDGES);
    expect([...nodeIds(jsonConstant("N"))].sort()).toEqual([...NORMATIVE_STATES].sort());
    expect([...edgeIds(jsonConstant("E"))].sort()).toEqual([...NORMATIVE_EDGES].sort());
  });

  it("has no clarification or engine-fault playbook state/edge/action", () => {
    expect(PLAN_FLOW.states).not.toContain("awaiting_user");
    expect(PLAN_FLOW.states).not.toContain("await_user");
    expect(PLAN_FLOW.states).not.toContain("error");
    expect(html).not.toMatch(/awaiting_user|await_user|clarification gate|respond edge/iu);
    expect(html).not.toMatch(/"error"\s*:/u);
    expect(html).toMatch(/engine faults remain\s+out-of-band `error` results/iu);
  });

  it("is self-contained and documents the exact no-execution boundary", () => {
    expect(html).not.toMatch(/<script[^>]+src\s*=/iu);
    expect(html).not.toMatch(/<link[^>]+href\s*=/iu);
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest/iu);
    expect(html).toMatch(/disabled evaluation candidate/iu);
    expect(html).toMatch(
      /no Decide dependency, task graph,\s+approval, taskification, execution, or internal clarification/iu
    );
  });
});
