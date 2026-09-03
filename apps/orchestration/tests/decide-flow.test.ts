import { readFileSync } from "node:fs";
import path from "node:path";

import { DECIDE_FLOW } from "../src/playbooks/decide.js";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const html = readFileSync(
  path.join(PROJECT_ROOT, ".pi", "skills", "decide", "resources", "flow.html"),
  "utf8"
);

function jsonConstant(name: "N" | "E"): unknown {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`decide flow is missing ${name}`);
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
  throw new Error(`decide flow ${name} literal is unbalanced`);
}

function nodeIds(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("decide flow nodes are malformed");
  }
  return Object.keys(value);
}

function edgeIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("decide flow edges are malformed");
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
      throw new Error("decide flow edge is malformed");
    }
    return `${entry.from}→${entry.to}`;
  });
}

const NORMATIVE_STATES = [
  "intake",
  "analyzing_decision",
  "decision_evidence_gate",
  "gathering_decision_evidence",
  "deciding",
  "sealing_decision",
  "verifying_decision",
  "critiquing_decision",
  "admitting_decision",
  "complete",
  "incomplete",
  "cancelled",
] as const;

const NORMATIVE_EDGES = [
  "intake→analyzing_decision",
  "analyzing_decision→decision_evidence_gate",
  "decision_evidence_gate→gathering_decision_evidence",
  "decision_evidence_gate→deciding",
  "gathering_decision_evidence→deciding",
  "deciding→sealing_decision",
  "sealing_decision→deciding",
  "sealing_decision→verifying_decision",
  "verifying_decision→analyzing_decision",
  "verifying_decision→deciding",
  "verifying_decision→critiquing_decision",
  "critiquing_decision→analyzing_decision",
  "critiquing_decision→deciding",
  "critiquing_decision→admitting_decision",
  "admitting_decision→complete",
] as const;

describe("decide candidate flow descriptor", () => {
  it("matches the frozen normative topology in both machine and documentation", () => {
    expect([...DECIDE_FLOW.states]).toEqual(NORMATIVE_STATES);
    expect(DECIDE_FLOW.edges.map(([from, to]) => `${from}→${to}`)).toEqual(NORMATIVE_EDGES);
    expect([...nodeIds(jsonConstant("N"))].sort()).toEqual([...NORMATIVE_STATES].sort());
    expect([...edgeIds(jsonConstant("E"))].sort()).toEqual([...NORMATIVE_EDGES].sort());
  });

  it("has no clarification gate or respond edge for valid unresolved products", () => {
    expect(DECIDE_FLOW.states).not.toContain("awaiting_clarification");
    expect(DECIDE_FLOW.states).not.toContain("awaiting_user");
    expect(DECIDE_FLOW.states).not.toContain("await_user");
    expect(DECIDE_FLOW.states).not.toContain("error");
    expect(html).not.toMatch(
      /awaiting_clarification|awaiting_user|await_user|clarification gate|respond edge/iu
    );
    expect(html).not.toMatch(/"error"\s*:/u);
    expect(html).toMatch(/engine faults remain out-of-band `error` results/iu);
    expect(html).toMatch(/including valid unresolved assessments/iu);
  });

  it("is self-contained and documents the no-execution candidate boundary", () => {
    expect(html).not.toMatch(/<script[^>]+src\s*=/iu);
    expect(html).not.toMatch(/<link[^>]+href\s*=/iu);
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest/iu);
    expect(html).toMatch(/disabled evaluation candidate/iu);
    expect(html).toMatch(/no execution, taskification, or internal clarification/iu);
  });
});
