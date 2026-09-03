/**
 * Every skill flow is a strict-JSON, self-contained visual mirror. Playbook
 * descriptors own topology; this suite owns all-skill static template checks.
 * Browser geometry is deliberately kept in the Playwright validator because it
 * needs a real rendering engine.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ASSESS_FLOW } from "../src/playbooks/assess.js";
import { DECIDE_FLOW } from "../src/playbooks/decide.js";
import { DIAGNOSE_FLOW } from "../src/playbooks/diagnose.js";
import {
  KB_AGENT_PHASES,
  KB_FLOW,
  KNOWLEDGE_BASE_SKILL_CONTRACT,
} from "../src/playbooks/knowledge-base.js";
import { PLAN_FLOW } from "../src/playbooks/plan.js";
import { PRODUCE_FLOW } from "../src/playbooks/produce.js";
import { RESEARCH_FLOW } from "../src/playbooks/research.js";

type EdgeKind = "fwd" | "gate" | "loop" | "exit" | "abort" | "esc";

interface DiagramNode {
  title: string;
  desc: string;
  cls: string;
  lane: string;
  y: number;
  who?: string;
  badge?: string;
  decisions?: string[];
  host_only?: boolean;
}

interface DiagramEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
}

interface ExpectedFlow {
  states: readonly string[];
  edges: readonly string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const SKILLS_ROOT = path.join(REPO_ROOT, ".pi", "skills");
const EDGE_KINDS: ReadonlySet<string> = new Set(["fwd", "gate", "loop", "exit", "abort", "esc"]);
const NON_COGNITIVE_CLASSES = new Set(["start", "host", "gate", "done", "error", "esc"]);

function edgeKey(edge: { from: string; to: string }): string {
  return `${edge.from}→${edge.to}`;
}

function tupleFlow(flow: {
  states: readonly string[];
  edges: readonly (readonly [string, string])[];
}): ExpectedFlow {
  return { states: flow.states, edges: flow.edges.map(([from, to]) => `${from}→${to}`) };
}

const EXPECTED: Readonly<Record<string, ExpectedFlow>> = {
  research: tupleFlow(RESEARCH_FLOW),
  "knowledge-base": {
    // start is the documented virtual engine initialize point, not a KB_FLOW state.
    states: ["start", ...KB_FLOW.states.map((state) => state.id)],
    edges: KB_FLOW.edges.map(edgeKey),
  },
  decide: tupleFlow(DECIDE_FLOW),
  plan: tupleFlow(PLAN_FLOW),
  diagnose: tupleFlow(DIAGNOSE_FLOW),
  produce: tupleFlow(PRODUCE_FLOW),
  assess: tupleFlow(ASSESS_FLOW),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requireOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be a string array`);

  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${label} must be a string array`);
    strings.push(item);
  }
  return strings;
}

function extractJsonConstant(source: string, name: "N" | "E"): unknown {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`flow.html is missing '${marker}'`);
  const valueStart = start + marker.length;
  const opening = source[valueStart];
  if (opening !== "{" && opening !== "[") throw new Error(`const ${name} is not strict JSON`);
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = valueStart; index < source.length; index += 1) {
    const character = source[index];
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
      if (depth === 0) {
        const raw = source.slice(valueStart, index + 1);
        const parsed: unknown = JSON.parse(raw);
        return parsed;
      }
    }
  }
  throw new Error(`const ${name} is unbalanced`);
}

function parseNode(value: unknown, id: string): DiagramNode {
  if (!isRecord(value)) throw new Error(`N.${id} must be an object`);
  const y = value["y"];
  if (typeof y !== "number" || !Number.isFinite(y)) throw new Error(`N.${id}.y must be finite`);
  const hostOnly = value["host_only"];
  if (hostOnly !== undefined && typeof hostOnly !== "boolean")
    throw new Error(`N.${id}.host_only must be boolean`);
  const who = requireOptionalString(value["who"], `N.${id}.who`);
  const badge = requireOptionalString(value["badge"], `N.${id}.badge`);
  const decisions = requireOptionalStringArray(value["decisions"], `N.${id}.decisions`);
  return {
    title: requireString(value["title"], `N.${id}.title`),
    desc: requireString(value["desc"], `N.${id}.desc`),
    cls: requireString(value["cls"], `N.${id}.cls`),
    lane: requireString(value["lane"], `N.${id}.lane`),
    y,
    ...(who === undefined ? {} : { who }),
    ...(badge === undefined ? {} : { badge }),
    ...(decisions === undefined ? {} : { decisions }),
    ...(hostOnly === true ? { host_only: true } : {}),
  };
}

function isEdgeKind(value: string): value is EdgeKind {
  return EDGE_KINDS.has(value);
}

function parseEdge(value: unknown, index: number): DiagramEdge {
  if (!isRecord(value)) throw new Error(`E[${index}] must be an object`);
  const kind = requireString(value["kind"], `E[${index}].kind`);
  if (!isEdgeKind(kind)) throw new Error(`E[${index}].kind is not allowed`);
  return {
    from: requireString(value["from"], `E[${index}].from`),
    to: requireString(value["to"], `E[${index}].to`),
    kind,
    label: requireString(value["label"], `E[${index}].label`),
  };
}

function parseDiagram(source: string): {
  nodes: Record<string, DiagramNode>;
  edges: DiagramEdge[];
} {
  const rawNodes = extractJsonConstant(source, "N");
  const rawEdges = extractJsonConstant(source, "E");
  if (!isRecord(rawNodes)) throw new Error("N must be a JSON object");
  if (!Array.isArray(rawEdges)) throw new Error("E must be a JSON array");
  return {
    nodes: Object.fromEntries(
      Object.entries(rawNodes).map(([id, node]) => [id, parseNode(node, id)])
    ),
    edges: rawEdges.map((edge, index) => parseEdge(edge, index)),
  };
}

function allSkillFlows(): readonly { skill: string; source: string }[] {
  return readdirSync(SKILLS_ROOT)
    .filter((skill) => existsSync(path.join(SKILLS_ROOT, skill, "SKILL.md")))
    .map((skill) => ({
      skill,
      source: readFileSync(path.join(SKILLS_ROOT, skill, "resources", "flow.html"), "utf8"),
    }))
    .sort((left, right) => left.skill.localeCompare(right.skill));
}

describe("flow-diagrams", () => {
  it("discovers every registered skill flow", () => {
    expect(
      allSkillFlows()
        .map((entry) => entry.skill)
        .sort()
    ).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const { skill, source } of allSkillFlows()) {
    const expected = EXPECTED[skill];
    if (expected === undefined) throw new Error(`missing expected descriptor for ${skill}`);
    const diagram = parseDiagram(source);

    it(`${skill}: is strict-JSON, self-contained, and uses the canonical semantic frame`, () => {
      expect(source).toMatch(/^<!doctype html>/imu);
      expect(source).toMatch(/<html\s+lang=["']en["']/iu);
      expect(source).toContain('name="penny-flow-template" content="1"');
      expect(source).toMatch(
        /<header>|class="callout"|class="legend"|class="flow-viewport"|id="wrap"|id="edges"|id="edge-list"|<footer>/u
      );
      expect(source).toContain('id="arrowhead"');
      expect(source).not.toMatch(
        /<script[^>]+src\s*=|<link[^>]+href\s*=|\bfetch\(|XMLHttpRequest|\bWebSocket\b/iu
      );
      expect(source).not.toMatch(/innerHTML\s*=/u);
      expect(source).not.toMatch(/__FLOW_|__N_JSON__|__E_JSON__/u);
      expect(Object.keys(diagram.nodes)).toHaveLength(new Set(Object.keys(diagram.nodes)).size);
      for (const [id, node] of Object.entries(diagram.nodes)) {
        expect(["left", "center", "right"], `${skill}:${id} lane`).toContain(node.lane);
        expect(node.y, `${skill}:${id} y`).toBeGreaterThanOrEqual(0);
        if (!NON_COGNITIVE_CLASSES.has(node.cls))
          expect(node.who, `${skill}:${id} owner`).toBeTruthy();
        if (node.cls === "gate" || node.cls === "host")
          expect(node.badge, `${skill}:${id} control badge`).toBeTruthy();
        if (node.cls === "done" || node.cls === "error")
          expect(node.badge, `${skill}:${id} terminal badge`).toBe("TERM");
      }
      for (const edge of diagram.edges) {
        expect(Object.hasOwn(diagram.nodes, edge.from), `${skill}:${edge.from} endpoint`).toBe(
          true
        );
        expect(Object.hasOwn(diagram.nodes, edge.to), `${skill}:${edge.to} endpoint`).toBe(true);
        expect(EDGE_KINDS.has(edge.kind), `${skill}:${edgeKey(edge)} kind`).toBe(true);
      }
    });

    it(`${skill}: exactly mirrors the exported TypeScript topology`, () => {
      expect(Object.keys(diagram.nodes).sort()).toEqual([...expected.states].sort());
      expect(diagram.edges.map(edgeKey).sort()).toEqual([...expected.edges].sort());
    });
  }

  it("knowledge-base: preserves host-only gate data, repair feedback, and honest cancellation", () => {
    const source = readFileSync(
      path.join(SKILLS_ROOT, "knowledge-base", "resources", "flow.html"),
      "utf8"
    );
    const diagram = parseDiagram(source);
    for (const gate of KB_FLOW.gates) {
      const node = diagram.nodes[gate.state];
      if (node === undefined) throw new Error(`missing knowledge-base gate '${gate.state}'`);
      expect(node.badge).toBe("HITL");
      expect(node.host_only).toBe(true);
      expect([...(node.decisions ?? [])].sort()).toEqual([...gate.decisions].sort());
    }
    for (const phase of KB_AGENT_PHASES) {
      expect(
        diagram.edges.some(
          (edge) => edge.from === phase && edge.to === phase && edge.kind === "loop"
        )
      ).toBe(true);
    }
    for (const route of KNOWLEDGE_BASE_SKILL_CONTRACT.repair_routing.routes) {
      expect(source).toContain(route.feedback_kind);
    }
    expect(source).toMatch(/omitted for legibility|uniform cancellation seam/iu);
    expect(source).toMatch(/budget spent|unresolved|fake pass/iu);
  });
});
