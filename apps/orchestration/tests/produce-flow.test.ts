import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PRODUCE_FLOW } from "../src/playbooks/produce.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const html = readFileSync(
  path.join(PROJECT_ROOT, ".pi", "skills", "produce", "resources", "flow.html"),
  "utf8"
);

function jsonConstant(name: "N" | "E"): unknown {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`produce flow is missing ${name}`);
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
  throw new Error(`produce flow ${name} literal is unbalanced`);
}

function nodeIds(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("produce flow nodes are malformed");
  }
  return Object.keys(value);
}

function edgeIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("produce flow edges are malformed");
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
      throw new Error("produce flow edge is malformed");
    }
    return `${entry.from}→${entry.to}`;
  });
}

const STATES = [
  "intake",
  "exploring_artifact_approaches",
  "materializing_artifact",
  "sealing_artifact",
  "critiquing_artifact",
  "verifying_artifact",
  "admitting_artifact",
  "complete",
  "incomplete",
  "cancelled",
] as const;

const EDGES = [
  "intake→exploring_artifact_approaches",
  "exploring_artifact_approaches→materializing_artifact",
  "materializing_artifact→sealing_artifact",
  "sealing_artifact→materializing_artifact",
  "sealing_artifact→critiquing_artifact",
  "critiquing_artifact→materializing_artifact",
  "critiquing_artifact→verifying_artifact",
  "verifying_artifact→exploring_artifact_approaches",
  "verifying_artifact→materializing_artifact",
  "verifying_artifact→admitting_artifact",
  "admitting_artifact→complete",
] as const;

describe("produce candidate flow descriptor", () => {
  it("matches the normative machine and strict-JSON diagram topology", () => {
    expect([...PRODUCE_FLOW.states]).toEqual(STATES);
    expect(PRODUCE_FLOW.edges.map(([from, to]) => `${from}→${to}`)).toEqual(EDGES);
    expect([...nodeIds(jsonConstant("N"))].sort()).toEqual([...STATES].sort());
    expect([...edgeIds(jsonConstant("E"))].sort()).toEqual([...EDGES].sort());
  });

  it("pins Carren-before-Vera, both repair routes, and the no-action/no-approval boundary", () => {
    expect(STATES.indexOf("critiquing_artifact")).toBeLessThan(
      STATES.indexOf("verifying_artifact")
    );
    expect(EDGES).toContain("critiquing_artifact→materializing_artifact");
    expect(EDGES).toContain("verifying_artifact→exploring_artifact_approaches");
    expect(EDGES).toContain("verifying_artifact→materializing_artifact");
    expect(html).not.toMatch(/await_user|awaiting_user|direct approval/iu);
    expect(html).not.toMatch(/<script[^>]+src\s*=|<link[^>]+href\s*=|fetch\(|XMLHttpRequest/iu);
  });
});
