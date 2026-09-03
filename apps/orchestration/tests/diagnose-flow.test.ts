import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DIAGNOSE_FLOW } from "../src/playbooks/diagnose.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const html = readFileSync(
  path.join(PROJECT_ROOT, ".pi", "skills", "diagnose", "resources", "flow.html"),
  "utf8"
);

function jsonConstant(name: "N" | "E"): unknown {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`diagnose flow is missing ${name}`);
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
  throw new Error(`diagnose flow ${name} literal is unbalanced`);
}

function nodeIds(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("diagnose flow nodes are malformed");
  }
  return Object.keys(value);
}

function edgeIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("diagnose flow edges are malformed");
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
      throw new Error("diagnose flow edge is malformed");
    }
    return `${entry.from}→${entry.to}`;
  });
}

const STATES = [
  "intake",
  "decomposing_causes",
  "generating_hypotheses",
  "adjudicating_diagnosis",
  "sealing_diagnosis",
  "verifying_diagnosis",
  "admitting_diagnosis",
  "complete",
  "incomplete",
  "cancelled",
] as const;

const EDGES = [
  "intake→decomposing_causes",
  "decomposing_causes→generating_hypotheses",
  "generating_hypotheses→adjudicating_diagnosis",
  "adjudicating_diagnosis→sealing_diagnosis",
  "sealing_diagnosis→adjudicating_diagnosis",
  "sealing_diagnosis→verifying_diagnosis",
  "verifying_diagnosis→decomposing_causes",
  "verifying_diagnosis→adjudicating_diagnosis",
  "verifying_diagnosis→admitting_diagnosis",
  "admitting_diagnosis→complete",
] as const;

describe("diagnose candidate flow descriptor", () => {
  it("matches the normative machine and strict-JSON diagram topology", () => {
    expect([...DIAGNOSE_FLOW.states]).toEqual(STATES);
    expect(DIAGNOSE_FLOW.edges.map(([from, to]) => `${from}→${to}`)).toEqual(EDGES);
    expect([...nodeIds(jsonConstant("N"))].sort()).toEqual([...STATES].sort());
    expect([...edgeIds(jsonConstant("E"))].sort()).toEqual([...EDGES].sort());
  });

  it("has no Carren, test execution, remediation, approval, or user-response phase", () => {
    expect(DIAGNOSE_FLOW.states.join(" ")).not.toMatch(
      /carren|critiqu|test_execution|remediat|approv|await_user|awaiting_user|respond/iu
    );
    expect(html).toMatch(/No test execution, remediation, or Carren phase/iu);
    expect(html).not.toMatch(/<script[^>]+src\s*=|<link[^>]+href\s*=|fetch\(|XMLHttpRequest/iu);
  });
});
