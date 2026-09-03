import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ASSESS_FLOW } from "../src/playbooks/assess.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const html = readFileSync(
  path.join(PROJECT_ROOT, ".pi", "skills", "assess", "resources", "flow.html"),
  "utf8"
);

function jsonConstant(name: "N" | "E"): unknown {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`assess flow is missing ${name}`);
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
  throw new Error(`assess flow ${name} literal is unbalanced`);
}

function nodeIds(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("assess flow nodes are malformed");
  }
  return Object.keys(value);
}

function edgeIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("assess flow edges are malformed");
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
      throw new Error("assess flow edge is malformed");
    }
    return `${entry.from}→${entry.to}`;
  });
}

const STATES = [
  "intake",
  "analyzing_assessment",
  "authoring_assessment",
  "sealing_assessment",
  "verifying_assessment",
  "admitting_assessment",
  "complete",
  "incomplete",
  "cancelled",
] as const;

const EDGES = [
  "intake→analyzing_assessment",
  "analyzing_assessment→authoring_assessment",
  "authoring_assessment→sealing_assessment",
  "sealing_assessment→authoring_assessment",
  "sealing_assessment→verifying_assessment",
  "verifying_assessment→analyzing_assessment",
  "verifying_assessment→authoring_assessment",
  "verifying_assessment→admitting_assessment",
  "admitting_assessment→complete",
] as const;

describe("assess candidate flow descriptor", () => {
  it("matches the normative machine and strict-JSON diagram topology", () => {
    expect([...ASSESS_FLOW.states]).toEqual(STATES);
    expect(ASSESS_FLOW.edges.map(([from, to]) => `${from}→${to}`)).toEqual(EDGES);
    expect([...nodeIds(jsonConstant("N"))].sort()).toEqual([...STATES].sort());
    expect([...edgeIds(jsonConstant("E"))].sort()).toEqual([...EDGES].sort());
  });

  it("contains only Annie, Carren, Vera, and deterministic host phases", () => {
    expect(html).toMatch(/Analyze — Annie/iu);
    expect(html).toMatch(/Author assessment — Carren/iu);
    expect(html).toMatch(/Verify — Vera/iu);
    expect(ASSESS_FLOW.states.join(" ")).not.toMatch(
      /score|test_execution|executing|implement|approv|await_user|awaiting_user|respond/iu
    );
    expect(html).not.toMatch(/<script[^>]+src\s*=|<link[^>]+href\s*=|fetch\(|XMLHttpRequest/iu);
  });
});
